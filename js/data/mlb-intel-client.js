(function(root) {
  "use strict";
  var cache = { standings: null, games: {}, players: {}, teams: {} };

  function season() { return new Date().getFullYear(); }
  function fetchJson(url) {
    if (typeof root.mlbRelayFetch === "function") return root.mlbRelayFetch(url);
    return fetch(url).then(function(response) {
      if (!response.ok) throw new Error("MLB request failed: " + response.status);
      return response.json();
    });
  }

  function idToAbbreviation() {
    var map = {};
    Object.keys(root.MLB_TEAM_ID || {}).forEach(function(abbreviation) { map[root.MLB_TEAM_ID[abbreviation]] = abbreviation; });
    return map;
  }

  function loadStandings(force) {
    if (cache.standings && !force) return Promise.resolve(cache.standings);
    var url = "https://statsapi.mlb.com/api/v1/standings?leagueId=103,104&season=" + season() + "&standingsTypes=regularSeason&hydrate=division,conference,league";
    return fetchJson(url).then(function(payload) {
      cache.standings = { rows: root.normalizeStandings(payload, idToAbbreviation()), fetchedAt: Date.now(), source: url };
      return cache.standings;
    });
  }

  function loadGame(game, force) {
    if (!game) return Promise.reject(new Error("No game selected"));
    if (cache.games[game.id] && !force) return Promise.resolve(cache.games[game.id]);
    return root.mlbGamePkFor(game).then(function(gamePk) {
      var url = "https://statsapi.mlb.com/api/v1.1/game/" + gamePk + "/feed/live";
      return fetchJson(url).then(function(payload) {
        var normalized = root.normalizeGameFeed(payload, { home: game.home, away: game.away, homeProbability: game.homeP });
        normalized.endpoint = url;
        cache.games[game.id] = normalized;
        [normalized.lineups.away, normalized.lineups.home].forEach(function(lineup) {
          lineup.starters.concat(lineup.startingPitcher ? [lineup.startingPitcher] : [], lineup.bullpen, lineup.bench).forEach(function(player) {
            if (player && player.id) cache.players[player.id] = Object.assign({}, cache.players[player.id] || {}, player);
          });
        });
        return normalized;
      });
    });
  }

  function statPayload(payload) {
    var groups = payload && payload.stats || [];
    var seasonRow = groups.filter(function(group) { return group.type && group.type.displayName === "season"; })[0] || groups[0];
    var gameLog = groups.filter(function(group) { return group.type && /gameLog/i.test(group.type.displayName || ""); })[0];
    return { season: seasonRow && seasonRow.splits && seasonRow.splits[0] && seasonRow.splits[0].stat || null, gameLog: gameLog && gameLog.splits || [] };
  }

  function loadPlayer(playerId, role, force) {
    playerId = String(playerId);
    var existing = cache.players[playerId] || { id: playerId };
    if (existing.detailsLoaded && !force) return Promise.resolve(existing);
    var group = role === "pitcher" ? "pitching" : "hitting";
    var bioUrl = "https://statsapi.mlb.com/api/v1/people/" + playerId + "?hydrate=currentTeam";
    var statsUrl = "https://statsapi.mlb.com/api/v1/people/" + playerId + "/stats?stats=season,gameLog&group=" + group + "&season=" + season();
    return Promise.all([fetchJson(bioUrl), fetchJson(statsUrl)]).then(function(results) {
      var person = results[0] && results[0].people && results[0].people[0] || {};
      var parsed = statPayload(results[1]);
      var normalized = root.normalizeBaseballPlayer(person, existing.team);
      var player = Object.assign({}, existing, normalized, {
        role: role || normalized.role, detailsLoaded: true,
        batting: group === "hitting" ? root.normalizeBattingStats(parsed.season) : existing.batting,
        pitching: group === "pitching" ? root.normalizePitchingStats(parsed.season) : existing.pitching,
        recent: group === "hitting" ? {
          five: root.aggregateRecentHitting(parsed.gameLog, 5), ten: root.aggregateRecentHitting(parsed.gameLog, 10), fifteen: root.aggregateRecentHitting(parsed.gameLog, 15)
        } : null,
        bio: { position: person.primaryPosition && person.primaryPosition.abbreviation, bats: person.batSide && person.batSide.code, throws: person.pitchHand && person.pitchHand.code },
        endpoint: statsUrl
      });
      cache.players[playerId] = player;
      return player;
    });
  }

  function loadTeam(teamAbbreviation, force) {
    var teamId = root.MLB_TEAM_ID && root.MLB_TEAM_ID[teamAbbreviation];
    if (!teamId) return Promise.reject(new Error("Unknown MLB team"));
    if (cache.teams[teamAbbreviation] && !force) return Promise.resolve(cache.teams[teamAbbreviation]);
    var base = "https://statsapi.mlb.com/api/v1/teams/" + teamId + "/stats?stats=season&season=" + season() + "&group=";
    return Promise.all([fetchJson(base + "hitting"), fetchJson(base + "pitching"), loadStandings(false)]).then(function(results) {
      var hitting = statPayload(results[0]).season, pitching = statPayload(results[1]).season;
      var standing = results[2].rows.filter(function(row) { return row.team === teamAbbreviation; })[0] || null;
      cache.teams[teamAbbreviation] = {
        team: teamAbbreviation, teamId: String(teamId), standing: standing,
        batting: root.normalizeBattingStats(hitting), pitching: root.normalizePitchingStats(pitching),
        injuries: root.INJURIES && root.INJURIES[teamAbbreviation] || [], fetchedAt: Date.now(), source: base
      };
      return cache.teams[teamAbbreviation];
    });
  }

  root.BaseballIntelClient = {
    cache: cache, loadStandings: loadStandings, loadGame: loadGame, loadPlayer: loadPlayer, loadTeam: loadTeam,
    refreshGame: function(game) { return loadGame(game, true); }
  };
})(typeof window !== "undefined" ? window : globalThis);
