// Point-in-time team state and feature extraction.
//
// The critical property here is that features for a game are computed from
// state that contains only games played *before* it. The MLB app's known
// limitation was grading backtests against present-day team tables; this
// module exists so the multi-sport backtest never does that. replay() in
// ms-backtest.js enforces the ordering: build features, emit the sample, and
// only then fold the result into state.
// Exposed as MS.features in the browser and via module.exports under Node, so the
// nine modules never collide on the global scope.
(function(root, factory) {
  var mod = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = mod;
  }
  root.MS = root.MS || {};
  root.MS.features = mod;
})(typeof globalThis !== "undefined" ? globalThis : this, function() {

// Pythagorean exponents differ a lot by sport -- a run in baseball is worth
// far more than a point in basketball.
var PYTHAG_EXP = {
  baseball: 1.83, basketball: 13.9, football: 2.37, hockey: 2.05,
  soccer: 1.35, lacrosse: 2.0, "water-polo": 2.0, softball: 1.83,
  rugby: 2.2, volleyball: 2.5, cricket: 2.0
};

// The feature vector the logistic model trains on. `hfa` is a constant 1 for
// every game: it carries the model's intercept, i.e. the pure home edge.
var FEATURE_KEYS = [
  "hfa",
  "eloDiff",
  "formDiff",
  "marginDiff",
  "offDiff",
  "defDiff",
  "pythagDiff",
  "venueSplitDiff",
  "restDiff",
  "h2hDiff",
  "rankDiff",
  "experience"
];

function pythagExp(sport) { return PYTHAG_EXP[sport] || 2.0; }

function createState(league) {
  return {
    leagueId: league ? league.id : null,
    sport: league ? league.sport : null,
    elo: {},          // teamId -> rating
    log: {},          // teamId -> [{date, won, drew, scored, allowed, home}]
    lastPlayed: {},   // teamId -> ms timestamp
    h2h: {},          // "a|b" -> {aWins, bWins, draws}
    counts: { games: 0, homeWins: 0, draws: 0, awayWins: 0, scored: 0 }
  };
}

function rating(state, id) {
  if (id == null) return 1500;
  var r = state.elo[id];
  return r == null ? 1500 : r;
}

function ensure(state, id) {
  if (id == null) return;
  if (state.elo[id] == null) state.elo[id] = 1500;
  if (!state.log[id]) state.log[id] = [];
}

function toMs(dateStr) {
  var t = Date.parse(dateStr);
  return isFinite(t) ? t : null;
}

// Mean of a numeric list, or null when empty (never 0 -- "no data" and "zero"
// must stay distinguishable so features can fall back to a neutral value).
function mean(list) {
  if (!list || !list.length) return null;
  var s = 0;
  for (var i = 0; i < list.length; i++) s += list[i];
  return s / list.length;
}

// Recent record over the last `n` entries, optionally filtered to home/away.
function form(state, id, n, venue) {
  var log = state.log[id] || [];
  var rows = venue ? log.filter(function(g) { return venue === "home" ? g.home : !g.home; }) : log;
  var slice = rows.slice(-Math.max(1, n || 10));
  if (!slice.length) return null;
  var pts = slice.map(function(g) { return g.won ? 1 : (g.drew ? 0.5 : 0); });
  return mean(pts);
}

function seasonAgg(state, id) {
  var log = state.log[id] || [];
  if (!log.length) return null;
  var scored = 0, allowed = 0, w = 0, d = 0;
  log.forEach(function(g) {
    scored += (g.scored || 0);
    allowed += (g.allowed || 0);
    if (g.won) w++; else if (g.drew) d++;
  });
  return {
    n: log.length,
    scoredAvg: scored / log.length,
    allowedAvg: allowed / log.length,
    marginAvg: (scored - allowed) / log.length,
    winPct: (w + 0.5 * d) / log.length,
    scored: scored, allowed: allowed
  };
}

function pythag(scored, allowed, exponent) {
  var e = exponent || 2;
  var a = Math.pow(Math.max(scored, 0.001), e), b = Math.pow(Math.max(allowed, 0.001), e);
  var den = a + b;
  return den > 0 ? a / den : 0.5;
}

function h2hKey(a, b) { return String(a) + "|" + String(b); }

function h2hEdge(state, homeId, awayId) {
  var f = state.h2h[h2hKey(homeId, awayId)];
  var r = state.h2h[h2hKey(awayId, homeId)];
  var hw = (f ? f.aWins : 0) + (r ? r.bWins : 0);
  var aw = (f ? f.bWins : 0) + (r ? r.aWins : 0);
  var dr = (f ? f.draws : 0) + (r ? r.draws : 0);
  var n = hw + aw + dr;
  if (!n) return null;
  return ((hw + 0.5 * dr) / n) - 0.5;
}

function restDays(state, id, gameMs) {
  var last = state.lastPlayed[id];
  if (last == null || gameMs == null) return null;
  var d = (gameMs - last) / 86400000;
  return d >= 0 ? Math.min(d, 21) : null;
}

// Build the feature object for one game from current (pre-game) state.
// Every feature is a home-minus-away difference so the sign convention is
// uniform: positive favours the home side.
function buildFeatures(game, state, league) {
  var home = game.home, away = game.away;
  if (!home || !away) return null;
  var hid = home.id, aid = away.id;
  var exp = pythagExp(league && league.sport);
  var gameMs = toMs(game.date);

  var hAgg = seasonAgg(state, hid), aAgg = seasonAgg(state, aid);
  var hForm = form(state, hid, 10), aForm = form(state, aid, 10);
  var hHome = form(state, hid, 10, "home"), aAway = form(state, aid, 10, "away");
  var hRest = restDays(state, hid, gameMs), aRest = restDays(state, aid, gameMs);

  var eloDiff = (rating(state, hid) - rating(state, aid)) / 400;
  // A neutral-site game gets no home edge; the hfa slot is what carries it.
  var neutral = !!(game.neutralSite || (game.venue && game.venue.neutral));

  var f = {
    hfa: neutral ? 0 : 1,
    eloDiff: eloDiff,
    formDiff: (hForm == null || aForm == null) ? 0 : (hForm - aForm),
    marginDiff: (hAgg && aAgg) ? clampScale(hAgg.marginAvg - aAgg.marginAvg, league) : 0,
    offDiff: (hAgg && aAgg) ? clampScale(hAgg.scoredAvg - aAgg.scoredAvg, league) : 0,
    defDiff: (hAgg && aAgg) ? clampScale(aAgg.allowedAvg - hAgg.allowedAvg, league) : 0,
    pythagDiff: (hAgg && aAgg)
      ? pythag(hAgg.scored, hAgg.allowed, exp) - pythag(aAgg.scored, aAgg.allowed, exp) : 0,
    venueSplitDiff: (hHome == null || aAway == null) ? 0 : (hHome - aAway),
    restDiff: (hRest == null || aRest == null) ? 0 : clamp((hRest - aRest) / 7, -2, 2),
    h2hDiff: h2hEdge(state, hid, aid) || 0,
    // rankFeature already inverts ESPN's 1-is-best scale into higher-is-better,
    // so this stays home-minus-away like every other feature.
    rankDiff: rankFeature(home.rank) - rankFeature(away.rank),
    // How much history the state actually has: lets the model discount early
    // season features rather than trusting a 1-game sample.
    experience: Math.min(((hAgg ? hAgg.n : 0) + (aAgg ? aAgg.n : 0)) / 40, 1)
  };
  return f;
}

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

// Scale a raw scoring difference into a roughly unit-variance feature using
// the league's expected total, so basketball points and soccer goals land in
// the same range before standardization.
function clampScale(v, league) {
  var t = (league && league.expectedTotal) > 0 ? league.expectedTotal : 10;
  return clamp((v || 0) / (t / 2), -3, 3);
}

function rankFeature(rank) {
  if (rank == null || rank >= 99 || rank <= 0) return 0;
  // Compress: the gap between #1 and #5 matters more than #20 to #24.
  return (26 - Math.min(rank, 25)) / 25;
}

// Fold a completed game into state. Call this only *after* emitting the
// sample for that game.
function updateState(state, game, league, ratings) {
  var home = game.home, away = game.away;
  if (!home || !away) return;
  var hs = home.score, as = away.score;
  if (hs == null || as == null) return;
  var hid = home.id, aid = away.id;
  ensure(state, hid); ensure(state, aid);

  var drew = hs === as;
  var homeWon = hs > as;
  var result = drew ? 0.5 : (homeWon ? 1 : 0);
  var neutral = !!(game.neutralSite || (game.venue && game.venue.neutral));
  var hfa = neutral ? 0 : ((league && league.hfa) || 0);

  // Elo update
  var rh = rating(state, hid), ra = rating(state, aid);
  var expected = ratings.eloProb(rh, ra, hfa);
  var delta = ratings.eloChange((league && league.k) || 20, Math.abs(hs - as), (rh + hfa) - ra, result, expected);
  state.elo[hid] = rh + delta;
  state.elo[aid] = ra - delta;

  var ms = toMs(game.date);
  state.log[hid].push({ date: game.date, won: homeWon, drew: drew, scored: hs, allowed: as, home: !neutral });
  state.log[aid].push({ date: game.date, won: !homeWon && !drew, drew: drew, scored: as, allowed: hs, home: false });
  if (ms != null) { state.lastPlayed[hid] = ms; state.lastPlayed[aid] = ms; }

  var key = h2hKey(hid, aid);
  if (!state.h2h[key]) state.h2h[key] = { aWins: 0, bWins: 0, draws: 0 };
  if (drew) state.h2h[key].draws++;
  else if (homeWon) state.h2h[key].aWins++;
  else state.h2h[key].bWins++;

  state.counts.games++;
  if (drew) state.counts.draws++;
  else if (homeWon) state.counts.homeWins++;
  else state.counts.awayWins++;
  state.counts.scored += hs + as;
}

// League-level empirics learned from the replay: the draw rate calibrates the
// Davidson nu, the home-win rate sanity-checks the hfa prior, and the average
// total drives the Poisson lambdas.
function stateSummary(state) {
  var c = state.counts;
  if (!c.games) return { games: 0, drawRate: null, homeWinRate: null, avgTotal: null };
  return {
    games: c.games,
    drawRate: c.draws / c.games,
    homeWinRate: c.homeWins / c.games,
    awayWinRate: c.awayWins / c.games,
    avgTotal: c.scored / c.games
  };
}

// Top-N teams by rating, for the power-rankings view (and for the offseason
// preview when a league has no games today).
function powerRankings(state, limit) {
  var rows = Object.keys(state.elo).map(function(id) {
    var agg = seasonAgg(state, id);
    return {
      id: id,
      elo: state.elo[id],
      games: agg ? agg.n : 0,
      winPct: agg ? agg.winPct : null,
      marginAvg: agg ? agg.marginAvg : null
    };
  });
  rows.sort(function(a, b) { return b.elo - a.elo; });
  return limit ? rows.slice(0, limit) : rows;
}

return {
  PYTHAG_EXP: PYTHAG_EXP,
  FEATURE_KEYS: FEATURE_KEYS,
  pythagExp: pythagExp,
  createState: createState,
  rating: rating,
  form: form,
  seasonAgg: seasonAgg,
  pythag: pythag,
  h2hEdge: h2hEdge,
  restDays: restDays,
  rankFeature: rankFeature,
  clampScale: clampScale,
  buildFeatures: buildFeatures,
  updateState: updateState,
  stateSummary: stateSummary,
  powerRankings: powerRankings
};

});
