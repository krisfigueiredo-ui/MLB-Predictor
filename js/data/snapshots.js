// Immutable, point-in-time prediction records. IO stays outside this module;
// callers can safely test parsing, migration, and freeze rules without a DOM.
(function(root, factory) {
  var mod = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = mod;
  for (var key in mod) root[key] = mod[key];
})(typeof globalThis !== "undefined" ? globalThis : this, function() {
  var SNAPSHOT_SCHEMA = 2;

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function deepFreeze(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    Object.keys(value).forEach(function(key) { deepFreeze(value[key]); });
    return Object.freeze(value);
  }

  function finiteOrNull(value) {
    if (value == null || value === "") return null;
    var number = Number(value);
    return isFinite(number) ? number : null;
  }

  function normalizeSnapshot(input) {
    input = input || {};
    var firstPitch = finiteOrNull(input.firstPitch);
    var timestamp = finiteOrNull(input.timestamp);
    if (!input.gameId || firstPitch == null || timestamp == null) return null;
    return {
      schema: SNAPSHOT_SCHEMA,
      gameId: String(input.gameId),
      timestamp: timestamp,
      firstPitch: firstPitch,
      modelVersion: String(input.modelVersion || "unknown"),
      weightVersion: String(input.weightVersion || "unknown"),
      calibrationVersion: String(input.calibrationVersion || "unfitted"),
      trainingCutoff: finiteOrNull(input.trainingCutoff),
      rawProb: finiteOrNull(input.rawProb),
      calibratedProb: finiteOrNull(input.calibratedProb),
      publishedProb: finiteOrNull(input.publishedProb),
      eloProb: finiteOrNull(input.eloProb),
      poissonProb: finiteOrNull(input.poissonProb),
      featureProb: finiteOrNull(input.featureProb),
      features: clone(input.features || {}),
      contributions: clone(input.contributions || {}),
      dataQuality: clone(input.dataQuality || {}),
      market: clone(input.market || null),
      home: input.home || null,
      away: input.away || null,
      selection: clone(input.selection || null),
      projectedScore: clone(input.projectedScore || null),
      signal: clone(input.signal || null),
      starters: clone(input.starters || null),
      lineups: clone(input.lineups || null),
      status: "FROZEN",
      result: clone(input.result || null)
    };
  }

  function createPredictionSnapshot(input, now) {
    var record = normalizeSnapshot(input);
    if (!record) return null;
    var clock = now == null ? Date.now() : Number(now);
    if (!isFinite(clock) || record.timestamp > record.firstPitch || clock > record.firstPitch) return null;
    return deepFreeze(record);
  }

  function parseSnapshotStore(raw) {
    try {
      var parsed = raw ? JSON.parse(raw) : null;
      if (!parsed || typeof parsed !== "object") return { schema: SNAPSHOT_SCHEMA, snapshots: {}, legacy: [] };
      var snapshots = {};
      Object.keys(parsed.snapshots || {}).forEach(function(gameId) {
        var normalized = normalizeSnapshot(parsed.snapshots[gameId]);
        if (normalized) snapshots[gameId] = normalized;
      });
      return {
        schema: SNAPSHOT_SCHEMA,
        snapshots: snapshots,
        legacy: Array.isArray(parsed.legacy) ? clone(parsed.legacy) : []
      };
    } catch (error) {
      return { schema: SNAPSHOT_SCHEMA, snapshots: {}, legacy: [] };
    }
  }

  function appendImmutableSnapshot(store, snapshot) {
    var base = parseSnapshotStore(JSON.stringify(store || {}));
    if (!snapshot || !snapshot.gameId) return base;
    if (base.snapshots[snapshot.gameId]) return base;
    base.snapshots[snapshot.gameId] = clone(snapshot);
    return base;
  }

  function gradeSnapshot(store, gameId, result) {
    var base = parseSnapshotStore(JSON.stringify(store || {}));
    var existing = base.snapshots[gameId];
    if (!existing || existing.result) return base;
    var homeScore = finiteOrNull(result && result.homeScore);
    var awayScore = finiteOrNull(result && result.awayScore);
    if (homeScore == null || awayScore == null) return base;
    var graded = clone(existing);
    var selectedTeam = graded.selection && graded.selection.team;
    var selectedHome = selectedTeam ? selectedTeam === graded.home : graded.publishedProb >= 0.5;
    var won = homeScore === awayScore ? null : selectedHome ? homeScore > awayScore : awayScore > homeScore;
    graded.result = {
      homeScore: homeScore,
      awayScore: awayScore,
      actualHome: homeScore === awayScore ? null : homeScore > awayScore,
      selectedTeam: selectedTeam || (selectedHome ? graded.home : graded.away),
      outcome: homeScore === awayScore ? "PUSH" : won ? "WON" : "LOST",
      gradedAt: finiteOrNull(result.gradedAt) || Date.now()
    };
    base.snapshots[gameId] = graded;
    return base;
  }

  function markLegacyRows(rows) {
    return (rows || []).map(function(row) {
      var copy = clone(row) || {};
      copy.snapshotStatus = "LEGACY";
      return copy;
    });
  }

  function normalizeLegacyPredictionResult(input) {
    input = input || {};
    var homeScore = finiteOrNull(input.hs);
    var awayScore = finiteOrNull(input.as);
    var homeProb = finiteOrNull(input.homeP);
    var awayProb = finiteOrNull(input.awayP);
    if (input.real !== true || !input.home || !input.away || !input.pick ||
        homeScore == null || awayScore == null || homeScore === awayScore) return null;
    if (awayProb == null && homeProb != null) awayProb = 1 - homeProb;
    var selectedHome = input.pick === input.home;
    if (!selectedHome && input.pick !== input.away) return null;
    var probability = finiteOrNull(input.conf);
    if (probability == null) probability = selectedHome ? homeProb : awayProb;
    var firstPitch = finiteOrNull(input.ts);
    if (firstPitch == null && input.date) {
      var parsedDate = Date.parse(input.date);
      firstPitch = isFinite(parsedDate) ? parsedDate : 0;
    }
    var actualHome = homeScore > awayScore;
    var won = selectedHome === actualHome;
    return {
      schema: 1,
      gameId: String(input.gid || [firstPitch, input.away, input.home].join("-")),
      timestamp: firstPitch || 0,
      firstPitch: firstPitch || 0,
      modelVersion: "legacy-log",
      home: String(input.home),
      away: String(input.away),
      publishedProb: homeProb,
      selection: {
        team: String(input.pick),
        probability: probability,
        marketOdds: selectedHome ? finiteOrNull(input.homeML) : finiteOrNull(input.awayML),
        edge: finiteOrNull(input.betEdge)
      },
      projectedScore: null,
      signal: null,
      status: "VERIFIED_LEGACY",
      snapshotStatus: "VERIFIED LEGACY",
      result: {
        homeScore: homeScore,
        awayScore: awayScore,
        actualHome: actualHome,
        selectedTeam: String(input.pick),
        outcome: won ? "WON" : "LOST",
        gradedAt: firstPitch || 0
      }
    };
  }

  function resultKey(row) {
    if (row && row.gameId) return "game:" + String(row.gameId);
    return "match:" + [row && row.firstPitch || 0, row && row.away || "", row && row.home || ""].join("|");
  }

  function mergePredictionResults(frozenRows, legacyRows) {
    var map = {};
    (legacyRows || []).forEach(function(row) {
      var normalized = normalizeLegacyPredictionResult(row);
      if (normalized) map[resultKey(normalized)] = normalized;
    });
    (frozenRows || []).forEach(function(row) {
      var normalized = normalizeSnapshot(row);
      if (normalized && normalized.result) map[resultKey(normalized)] = normalized;
    });
    return Object.keys(map).map(function(key) { return map[key]; }).sort(function(a, b) {
      return (b.firstPitch || 0) - (a.firstPitch || 0);
    });
  }

  function emptySplit(label) {
    return { label: label, picks: 0, wins: 0, losses: 0, accuracy: null };
  }

  function addResult(split, won) {
    split.picks += 1;
    split.wins += won ? 1 : 0;
    split.losses += won ? 0 : 1;
    split.accuracy = split.picks ? split.wins / split.picks : null;
  }

  function summarizePredictionResults(rows) {
    var summary = {
      picks: 0, wins: 0, losses: 0, pushes: 0, accuracy: null, averageConfidence: null,
      home: emptySplit("Home picks"), away: emptySplit("Away picks"),
      highConfidence: emptySplit("60%+ picks"), teams: [], confidence: []
    };
    var teamMap = {}, confidenceTotal = 0, confidenceCount = 0;
    var buckets = [
      { label: "50–54.9%", min: 0.5, max: 0.55 },
      { label: "55–59.9%", min: 0.55, max: 0.6 },
      { label: "60–64.9%", min: 0.6, max: 0.65 },
      { label: "65%+", min: 0.65, max: Infinity }
    ].map(function(bucket) { return Object.assign(bucket, emptySplit(bucket.label)); });

    (rows || []).forEach(function(row) {
      if (!row || !row.result || !row.selection || !row.selection.team) return;
      var outcome = row.result.outcome;
      if (outcome === "PUSH") { summary.pushes += 1; return; }
      if (outcome !== "WON" && outcome !== "LOST") return;
      var won = outcome === "WON", selectedHome = row.selection.team === row.home;
      var probability = finiteOrNull(row.selection.probability);
      summary.picks += 1;
      summary.wins += won ? 1 : 0;
      summary.losses += won ? 0 : 1;
      addResult(selectedHome ? summary.home : summary.away, won);
      if (probability != null) {
        confidenceTotal += probability;
        confidenceCount += 1;
        if (probability >= 0.6) addResult(summary.highConfidence, won);
        for (var i = 0; i < buckets.length; i++) {
          if (probability >= buckets[i].min && probability < buckets[i].max) { addResult(buckets[i], won); break; }
        }
      }
      var team = row.selection.team;
      if (!teamMap[team]) teamMap[team] = {
        team: team, picks: 0, wins: 0, losses: 0, accuracy: null,
        home: emptySplit("Home"), away: emptySplit("Away"), confidenceTotal: 0, confidenceCount: 0
      };
      var teamRow = teamMap[team];
      addResult(teamRow, won);
      addResult(selectedHome ? teamRow.home : teamRow.away, won);
      if (probability != null) { teamRow.confidenceTotal += probability; teamRow.confidenceCount += 1; }
    });
    summary.accuracy = summary.picks ? summary.wins / summary.picks : null;
    summary.averageConfidence = confidenceCount ? confidenceTotal / confidenceCount : null;
    summary.teams = Object.keys(teamMap).map(function(team) {
      var row = teamMap[team];
      row.averageConfidence = row.confidenceCount ? row.confidenceTotal / row.confidenceCount : null;
      delete row.confidenceTotal;
      delete row.confidenceCount;
      return row;
    }).sort(function(a, b) { return b.picks - a.picks || b.accuracy - a.accuracy || a.team.localeCompare(b.team); });
    summary.confidence = buckets;
    return summary;
  }

  return {
    SNAPSHOT_SCHEMA: SNAPSHOT_SCHEMA,
    normalizePredictionSnapshot: normalizeSnapshot,
    createPredictionSnapshot: createPredictionSnapshot,
    parseSnapshotStore: parseSnapshotStore,
    appendImmutableSnapshot: appendImmutableSnapshot,
    gradePredictionSnapshot: gradeSnapshot,
    markLegacyRows: markLegacyRows,
    normalizeLegacyPredictionResult: normalizeLegacyPredictionResult,
    mergePredictionResults: mergePredictionResults,
    summarizePredictionResults: summarizePredictionResults
  };
});
