(function(root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  for (var key in api) root[key] = api[key];
})(typeof globalThis !== "undefined" ? globalThis : this, function() {
  "use strict";

  function number(value) {
    if (value == null || value === "") return null;
    var parsed = Number(value);
    return isFinite(parsed) ? parsed : null;
  }

  function positiveNumber(value) {
    var parsed = number(value);
    return parsed != null && parsed > 0 ? parsed : null;
  }

  function text(value) { return value == null || value === "" ? null : String(value); }
  function clamp(value, low, high) { return Math.max(low, Math.min(high, value)); }
  function logistic(value) { return 1 / (1 + Math.exp(-clamp(value, -20, 20))); }
  function logit(probability) {
    var probabilitySafe = clamp(number(probability) == null ? 0.5 : number(probability), 0.01, 0.99);
    return Math.log(probabilitySafe / (1 - probabilitySafe));
  }

  function normalizeBattingStats(stats) {
    stats = stats || {};
    return {
      avg: number(stats.avg), obp: number(stats.obp), slg: number(stats.slg), ops: number(stats.ops),
      homeRuns: number(stats.homeRuns), rbi: number(stats.rbi), runs: number(stats.runs), hits: number(stats.hits),
      doubles: number(stats.doubles), triples: number(stats.triples), walks: number(stats.baseOnBalls),
      strikeouts: number(stats.strikeOuts), stolenBases: number(stats.stolenBases),
      plateAppearances: number(stats.plateAppearances), atBats: number(stats.atBats),
      woba: positiveNumber(stats.woba), wrcPlus: positiveNumber(stats.wrcPlus), iso: positiveNumber(stats.iso), babip: positiveNumber(stats.babip),
      strikeoutRate: positiveNumber(stats.strikeoutRate || stats.strikeOutPercentage),
      walkRate: positiveNumber(stats.walkRate || stats.baseOnBallsPercentage), hardHitRate: positiveNumber(stats.hardHitRate),
      barrelRate: positiveNumber(stats.barrelRate), exitVelocity: positiveNumber(stats.avgExitVelocity), launchAngle: number(stats.avgLaunchAngle) === 0 ? null : number(stats.avgLaunchAngle)
    };
  }

  function normalizePitchingStats(stats) {
    stats = stats || {};
    return {
      era: number(stats.era), whip: number(stats.whip), wins: number(stats.wins), losses: number(stats.losses),
      inningsPitched: text(stats.inningsPitched), strikeouts: number(stats.strikeOuts), walks: number(stats.baseOnBalls),
      homeRuns: number(stats.homeRuns), hits: number(stats.hits), earnedRuns: number(stats.earnedRuns),
      games: number(stats.gamesPlayed || stats.gamesPitched), starts: number(stats.gamesStarted),
      fip: number(stats.fip), xfip: number(stats.xfip), strikeoutsPerNine: number(stats.strikeoutsPer9Inn),
      walksPerNine: number(stats.walksPer9Inn), homeRunsPerNine: number(stats.homeRunsPer9),
      strikeoutRate: number(stats.strikeoutPercentage), walkRate: number(stats.walkPercentage), eraPlus: number(stats.eraPlus)
    };
  }

  function normalizePlayer(raw, teamAbbr) {
    raw = raw || {};
    var person = raw.person || raw;
    var position = raw.position || person.primaryPosition || {};
    var season = raw.seasonStats || {};
    var isPitcher = (position.abbreviation || "").toUpperCase() === "P" || !!(season.pitching && !season.batting);
    return {
      id: person.id != null ? String(person.id) : null,
      name: text(person.fullName || person.displayName),
      team: text(teamAbbr), position: text(position.abbreviation || position.code),
      bats: text(person.batSide && (person.batSide.code || person.batSide.description)),
      throws: text(person.pitchHand && (person.pitchHand.code || person.pitchHand.description)),
      role: isPitcher ? "pitcher" : "batter",
      batting: normalizeBattingStats(season.batting), pitching: normalizePitchingStats(season.pitching),
      source: "MLB Stats API"
    };
  }

  function normalizeLineup(teamBox, teamAbbr) {
    teamBox = teamBox || {};
    var players = teamBox.players || {};
    var order = Array.isArray(teamBox.battingOrder) ? teamBox.battingOrder : [];
    var starters = order.map(function(playerId, index) {
      var raw = players["ID" + playerId] || {};
      var player = normalizePlayer(raw, teamAbbr);
      player.order = index + 1;
      return player;
    }).filter(function(player) { return player.id && player.name; });
    var pitcherIds = (teamBox.pitchers || []).map(String);
    var allPlayers = Object.keys(players).map(function(key) { return normalizePlayer(players[key], teamAbbr); })
      .filter(function(player) { return player.id && player.name; });
    var pitchers = pitcherIds.map(function(playerId) {
      return normalizePlayer(players["ID" + playerId] || {}, teamAbbr);
    }).filter(function(player) { return player.id && player.name; });
    allPlayers.filter(function(player) { return player.role === "pitcher"; }).forEach(function(player) {
      if (!pitchers.some(function(existing) { return existing.id === player.id; })) pitchers.push(player);
    });
    var bench = allPlayers
      .filter(function(player) {
        return player.role !== "pitcher" && starters.every(function(starter) { return starter.id !== player.id; });
      });
    return {
      team: teamAbbr, status: starters.length >= 9 ? "CONFIRMED" : "AWAITING",
      starters: starters, startingPitcher: pitchers[0] || null, bullpen: pitchers.slice(1), bench: bench,
      source: "MLB live boxscore"
    };
  }

  function inningProgress(play) {
    var about = play && play.about || {};
    var inning = Math.max(1, number(about.inning) || 1);
    return clamp((inning - 1 + (String(about.halfInning).toLowerCase() === "bottom" ? 0.5 : 0)) / 9, 0, 1.35);
  }

  function derivedHomeWinProbability(baseHomeProbability, homeScore, awayScore, play) {
    var scoreDifference = (number(homeScore) || 0) - (number(awayScore) || 0);
    var progress = inningProgress(play);
    var remaining = Math.max(0.12, 1 - Math.min(progress, 1));
    var scoreWeight = 0.66 / Math.sqrt(remaining + 0.18);
    return clamp(logistic(logit(baseHomeProbability) + scoreDifference * scoreWeight), 0.01, 0.99);
  }

  function classifyMoment(play, swing) {
    var result = play && play.result || {};
    var event = String(result.event || "").toLowerCase();
    var description = String(result.description || "").toLowerCase();
    if (event.indexOf("home run") >= 0) return "HOME RUN";
    if (event.indexOf("pitching substitution") >= 0 || description.indexOf("pitching change") >= 0) return "PITCHING CHANGE";
    if (event.indexOf("double play") >= 0) return "DOUBLE PLAY";
    if (event.indexOf("error") >= 0) return "ERROR";
    if ((number(result.rbi) || 0) > 0) return "RUN SCORING";
    if (event.indexOf("strikeout") >= 0 && Math.abs(swing) >= 0.035) return "HIGH-LEVERAGE K";
    if (Math.abs(swing) >= 0.05) return "WIN PROBABILITY SWING";
    return null;
  }

  function normalizePlays(plays, baseHomeProbability) {
    var previousHomeScore = 0, previousAwayScore = 0;
    return (plays || []).map(function(play, index) {
      var result = play.result || {}, about = play.about || {}, matchup = play.matchup || {};
      var homeScore = number(result.homeScore); if (homeScore == null) homeScore = previousHomeScore;
      var awayScore = number(result.awayScore); if (awayScore == null) awayScore = previousAwayScore;
      var before = derivedHomeWinProbability(baseHomeProbability, previousHomeScore, previousAwayScore, play);
      var after = derivedHomeWinProbability(baseHomeProbability, homeScore, awayScore, play);
      var swing = after - before;
      previousHomeScore = homeScore; previousAwayScore = awayScore;
      var item = {
        id: text(play.atBatIndex != null ? play.atBatIndex : index), inning: number(about.inning),
        half: text(about.halfInning), label: ((about.isTopInning ? "TOP" : "BOT") + " " + (about.inning || "—")),
        event: text(result.event), description: text(result.description), rbi: number(result.rbi), outs: number(play.count && play.count.outs),
        batter: normalizePlayer(matchup.batter || {}, null), pitcher: normalizePlayer(matchup.pitcher || {}, null),
        homeScore: homeScore, awayScore: awayScore, beforeHomeProbability: before, afterHomeProbability: after,
        swing: swing, momentType: classifyMoment(play, swing), source: "MLB live play-by-play"
      };
      return item;
    });
  }

  function normalizeGameFeed(feed, context) {
    context = context || {};
    var liveData = feed && feed.liveData || {}, boxscore = liveData.boxscore || {}, linescore = liveData.linescore || {};
    var home = context.home || null, away = context.away || null;
    var plays = normalizePlays(liveData.plays && liveData.plays.allPlays, context.homeProbability);
    return {
      gamePk: text(feed && feed.gamePk), status: text(feed && feed.gameData && feed.gameData.status && feed.gameData.status.detailedState),
      venue: text(feed && feed.gameData && feed.gameData.venue && feed.gameData.venue.name),
      linescore: {
        inning: number(linescore.currentInning), inningOrdinal: text(linescore.currentInningOrdinal), half: text(linescore.inningHalf),
        balls: number(linescore.balls), strikes: number(linescore.strikes), outs: number(linescore.outs),
        homeScore: number(linescore.teams && linescore.teams.home && linescore.teams.home.runs),
        awayScore: number(linescore.teams && linescore.teams.away && linescore.teams.away.runs),
        onFirst: !!(linescore.offense && linescore.offense.first), onSecond: !!(linescore.offense && linescore.offense.second),
        onThird: !!(linescore.offense && linescore.offense.third)
      },
      lineups: { away: normalizeLineup(boxscore.teams && boxscore.teams.away, away), home: normalizeLineup(boxscore.teams && boxscore.teams.home, home) },
      teamStats: {
        away: { batting: normalizeBattingStats(boxscore.teams && boxscore.teams.away && boxscore.teams.away.teamStats && boxscore.teams.away.teamStats.batting), pitching: normalizePitchingStats(boxscore.teams && boxscore.teams.away && boxscore.teams.away.teamStats && boxscore.teams.away.teamStats.pitching) },
        home: { batting: normalizeBattingStats(boxscore.teams && boxscore.teams.home && boxscore.teams.home.teamStats && boxscore.teams.home.teamStats.batting), pitching: normalizePitchingStats(boxscore.teams && boxscore.teams.home && boxscore.teams.home.teamStats && boxscore.teams.home.teamStats.pitching) }
      },
      plays: plays, moments: plays.filter(function(play) { return !!play.momentType; }),
      winProbability: plays.map(function(play) { return { id: play.id, inning: play.label, homeProbability: play.afterHomeProbability, event: play.momentType || play.event }; }),
      source: "MLB Stats API live feed", fetchedAt: Date.now()
    };
  }

  function splitRecord(records, type) {
    var row = (records || []).filter(function(record) { return record.type === type; })[0];
    return row && row.wins != null ? row.wins + "-" + row.losses : null;
  }

  function normalizeStandings(payload, idToAbbr) {
    var rows = [];
    (payload && payload.records || []).forEach(function(record) {
      (record.teamRecords || []).forEach(function(teamRecord) {
        var id = teamRecord.team && teamRecord.team.id;
        var abbreviation = idToAbbr && idToAbbr[id] || null;
        rows.push({
          teamId: id != null ? String(id) : null, team: abbreviation, name: text(teamRecord.team && teamRecord.team.name),
          league: text(record.league && record.league.name), leagueId: number(record.league && record.league.id),
          division: text(record.division && record.division.name), divisionId: number(record.division && record.division.id),
          wins: number(teamRecord.wins), losses: number(teamRecord.losses), pct: number(teamRecord.winningPercentage),
          gamesBack: text(teamRecord.gamesBack), wildCardGamesBack: text(teamRecord.wildCardGamesBack),
          divisionRank: number(teamRecord.divisionRank), wildCardRank: number(teamRecord.wildCardRank),
          home: splitRecord(teamRecord.records && teamRecord.records.splitRecords, "home"),
          away: splitRecord(teamRecord.records && teamRecord.records.splitRecords, "away"),
          lastTen: splitRecord(teamRecord.records && teamRecord.records.splitRecords, "lastTen"),
          streak: text(teamRecord.streak && teamRecord.streak.streakCode), runDifferential: number(teamRecord.runDifferential),
          source: "MLB Stats API standings"
        });
      });
    });
    return rows;
  }

  function aggregateRecentHitting(splits, limit) {
    var rows = (splits || []).slice().sort(function(a, b) { return String(b.date || "").localeCompare(String(a.date || "")); }).slice(0, limit);
    var total = { atBats: 0, hits: 0, doubles: 0, triples: 0, homeRuns: 0, walks: 0, strikeouts: 0, runs: 0, rbi: 0 };
    rows.forEach(function(row) {
      var stats = normalizeBattingStats(row.stat || {});
      Object.keys(total).forEach(function(key) { total[key] += number(stats[key]) || 0; });
    });
    var bases = total.hits + total.doubles + 2 * total.triples + 3 * total.homeRuns;
    return { games: rows.length, avg: total.atBats ? total.hits / total.atBats : null, obp: total.atBats + total.walks ? (total.hits + total.walks) / (total.atBats + total.walks) : null, slg: total.atBats ? bases / total.atBats : null, ops: total.atBats ? ((total.hits + total.walks) / (total.atBats + total.walks)) + bases / total.atBats : null, totals: total };
  }

  function signalScore(input) {
    input = input || {};
    var quality = clamp((number(input.dataQuality) || 0) / 100, 0, 1);
    var confidence = clamp((Math.abs((number(input.modelProbability) || 0.5) - 0.5) * 2), 0, 1);
    var agreement = clamp(1 - ((number(input.dispersion) == null ? 0.08 : number(input.dispersion)) / 0.12), 0, 1);
    var starter = clamp(Math.abs(number(input.starterContribution) || 0) / 0.35, 0, 1);
    var edge = number(input.marketEdge);
    var components = edge == null ? [
      { name: "model confidence", weight: 0.36, value: confidence },
      { name: "model agreement", weight: 0.28, value: agreement },
      { name: "data quality", weight: 0.24, value: quality },
      { name: "starting pitching signal", weight: 0.12, value: starter }
    ] : [
      { name: "market edge", weight: 0.32, value: clamp(Math.max(0, edge) / 0.12, 0, 1) },
      { name: "model confidence", weight: 0.20, value: confidence },
      { name: "model agreement", weight: 0.20, value: agreement },
      { name: "data quality", weight: 0.18, value: quality },
      { name: "starting pitching signal", weight: 0.10, value: starter }
    ];
    var raw = components.reduce(function(sum, component) { return sum + component.weight * component.value; }, 0);
    return { score: Math.round(raw * 100) / 10, components: components, marketQualified: edge != null };
  }

  return {
    baseballNumber: number,
    normalizeBattingStats: normalizeBattingStats,
    normalizePitchingStats: normalizePitchingStats,
    normalizeBaseballPlayer: normalizePlayer,
    normalizeLineup: normalizeLineup,
    normalizeGameFeed: normalizeGameFeed,
    normalizeStandings: normalizeStandings,
    aggregateRecentHitting: aggregateRecentHitting,
    derivedHomeWinProbability: derivedHomeWinProbability,
    diamondSignalScore: signalScore
  };
});
