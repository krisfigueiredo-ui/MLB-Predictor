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

  return {
    SNAPSHOT_SCHEMA: SNAPSHOT_SCHEMA,
    normalizePredictionSnapshot: normalizeSnapshot,
    createPredictionSnapshot: createPredictionSnapshot,
    parseSnapshotStore: parseSnapshotStore,
    appendImmutableSnapshot: appendImmutableSnapshot,
    gradePredictionSnapshot: gradeSnapshot,
    markLegacyRows: markLegacyRows
  };
});
