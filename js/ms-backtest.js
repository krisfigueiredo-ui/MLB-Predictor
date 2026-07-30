// Backtesting: turn a pile of historical ESPN events into leak-free training
// samples, split them chronologically, and grade a model against them.
//
// Two rules make this a real backtest rather than a flattering one:
//   1. Features for a game are built from state that contains only earlier
//      games (enforced here, in replay()).
//   2. The train/test split is chronological, never random. A random split
//      lets a model see the future of the same season it is tested on.
// Exposed as MS.backtest in the browser and via module.exports under Node, so the
// nine modules never collide on the global scope.
(function(root, factory) {
  var mod = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = mod;
  }
  root.MS = root.MS || {};
  root.MS.backtest = mod;
})(typeof globalThis !== "undefined" ? globalThis : this, function() {

function pad(n) { return n < 10 ? "0" + n : "" + n; }

function isoDate(d) {
  return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate());
}

// Inclusive list of YYYY-MM-DD strings between two dates.
function dateRange(startISO, endISO) {
  var a = new Date(startISO + "T00:00:00Z"), b = new Date(endISO + "T00:00:00Z");
  if (isNaN(a.getTime()) || isNaN(b.getTime()) || a > b) return [];
  var out = [], cur = new Date(a.getTime());
  var guard = 0;
  while (cur <= b && guard++ < 4000) {
    out.push(isoDate(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

// ESPN accepts YYYYMMDD-YYYYMMDD ranges on the scoreboard endpoint, so a
// season can be pulled in a few dozen requests instead of a few hundred.
// Chunk a date list into [{from, to}] windows.
function chunkRanges(dates, windowDays) {
  var w = Math.max(1, windowDays || 30);
  var out = [];
  for (var i = 0; i < dates.length; i += w) {
    var slice = dates.slice(i, i + w);
    out.push({ from: slice[0], to: slice[slice.length - 1] });
  }
  return out;
}

// Walk back `days` from a reference date.
function lookbackRange(days, refISO) {
  var ref = refISO ? new Date(refISO + "T00:00:00Z") : new Date();
  if (isNaN(ref.getTime())) ref = new Date();
  var end = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate()));
  var start = new Date(end.getTime() - Math.max(1, days) * 86400000);
  return { start: isoDate(start), end: isoDate(end) };
}

function gameTime(g) {
  var t = Date.parse(g && g.date);
  return isFinite(t) ? t : 0;
}

function sortByDate(games) {
  return (games || []).slice().sort(function(a, b) { return gameTime(a) - gameTime(b); });
}

// A game is usable as a training sample only if it finished cleanly with two
// identified sides and real scores.
function isGradable(g) {
  if (!g || !g.status || !g.status.final || g.status.cancelled) return false;
  if (!g.home || !g.away) return false;
  if (g.home.id == null || g.away.id == null) return false;
  return g.home.score != null && g.away.score != null;
}

function dedupeById(games) {
  var seen = {}, out = [];
  (games || []).forEach(function(g) {
    var k = (g && g.id) || null;
    if (k == null) { out.push(g); return; }
    if (seen[k]) return;
    seen[k] = 1;
    out.push(g);
  });
  return out;
}

// Chronological replay. `deps` supplies the features + ratings modules so this
// file stays dependency-free and testable in isolation.
//
// Returns samples in date order. Each sample's `feat` was computed before its
// own result touched state -- that is the whole point.
function replay(games, league, deps, opts) {
  opts = opts || {};
  var F = deps.features, R = deps.ratings;
  var state = opts.state || F.createState(league);
  var ordered = sortByDate(dedupeById(games).filter(isGradable));
  var samples = [];

  ordered.forEach(function(g) {
    var feat = F.buildFeatures(g, state, league);
    if (feat) {
      var hs = g.home.score, as = g.away.score;
      var drew = hs === as;
      var eloPrior = R.eloProb(F.rating(state, g.home.id), F.rating(state, g.away.id),
        (g.neutralSite ? 0 : (league.hfa || 0)));
      samples.push({
        id: g.id,
        date: g.date,
        t: gameTime(g),
        leagueId: league.id,
        homeId: g.home.id, awayId: g.away.id,
        homeName: g.home.shortName || g.home.name,
        awayName: g.away.shortName || g.away.name,
        feat: feat,
        // y is the binary target: did the home side win? Draws are excluded
        // from binary training (see splitDraws) and modelled separately.
        y: drew ? null : (hs > as ? 1 : 0),
        drew: drew,
        outcome: drew ? "draw" : (hs > as ? "home" : "away"),
        homeScore: hs, awayScore: as,
        margin: hs - as,
        total: hs + as,
        eloPrior: eloPrior,
        // Market at the time, when ESPN carried it.
        market: g.odds ? R.marketProbs(g.odds) : null,
        odds: g.odds || null
      });
    }
    F.updateState(state, g, league, R);
  });

  return { samples: samples, state: state, summary: F.stateSummary(state) };
}

// Binary-trainable subset (draws removed) plus the draw rate needed to
// calibrate the three-way model.
function splitDraws(samples) {
  var binary = [], draws = 0;
  (samples || []).forEach(function(s) {
    if (s.drew) { draws++; return; }
    binary.push(s);
  });
  var n = (samples || []).length;
  return { binary: binary, draws: draws, drawRate: n ? draws / n : null };
}

// Chronological split -- earliest `frac` trains, the rest is held out.
function chronoSplit(samples, frac) {
  var ordered = (samples || []).slice().sort(function(a, b) { return a.t - b.t; });
  var f = frac == null ? 0.7 : Math.min(0.95, Math.max(0.05, frac));
  var cut = Math.floor(ordered.length * f);
  if (cut < 1) cut = Math.min(1, ordered.length);
  if (ordered.length - cut < 1 && ordered.length > 1) cut = ordered.length - 1;
  return { train: ordered.slice(0, cut), test: ordered.slice(cut) };
}

// Expanding-window walk-forward: train on everything before each fold, test on
// the fold. This is the honest analogue of k-fold CV for time series.
function walkForwardFolds(samples, folds) {
  var ordered = (samples || []).slice().sort(function(a, b) { return a.t - b.t; });
  var k = Math.max(2, folds || 5);
  var out = [];
  var foldSize = Math.floor(ordered.length / (k + 1));
  if (foldSize < 1) return out;
  for (var i = 1; i <= k; i++) {
    var trainEnd = foldSize * i;
    var testEnd = Math.min(ordered.length, foldSize * (i + 1));
    if (testEnd <= trainEnd) break;
    out.push({ train: ordered.slice(0, trainEnd), test: ordered.slice(trainEnd, testEnd) });
  }
  return out;
}

// Grade a set of probability predictions against realised outcomes.
// `predict(sample) -> probability the home side wins`.
function grade(samples, predict) {
  var n = 0, correct = 0, brier = 0, logloss = 0, pairs = [];
  (samples || []).forEach(function(s) {
    if (s.y == null) return;
    var p = predict(s);
    if (p == null || !isFinite(p)) return;
    p = Math.min(1 - 1e-9, Math.max(1e-9, p));
    n++;
    if ((p >= 0.5 ? 1 : 0) === s.y) correct++;
    brier += (p - s.y) * (p - s.y);
    logloss += -(s.y * Math.log(p) + (1 - s.y) * Math.log(1 - p));
    pairs.push({ p: p, y: s.y });
  });
  if (!n) return { n: 0, acc: null, brier: null, logloss: null, pairs: [] };
  return { n: n, acc: correct / n, brier: brier / n, logloss: logloss / n, pairs: pairs };
}

// Baseline to beat: always pick the home side. A model that can't clear this
// isn't adding anything.
function baselineHome(samples) {
  var n = 0, wins = 0;
  (samples || []).forEach(function(s) { if (s.y == null) return; n++; if (s.y === 1) wins++; });
  return { n: n, homeWinRate: n ? wins / n : null };
}

// Paper-betting backtest against the recorded market. Flat or Kelly staking,
// bet only when the model's edge clears `minEdge`.
function betBacktest(samples, predict, opts) {
  opts = opts || {};
  var minEdge = opts.minEdge == null ? 0.04 : opts.minEdge;
  var mode = opts.mode || "flat";        // flat | kelly
  var kellyFraction = opts.kellyFraction == null ? 0.25 : opts.kellyFraction;
  var stakeUnit = opts.stake == null ? 1 : opts.stake;
  var bankroll = opts.bankroll == null ? 100 : opts.bankroll;

  var curve = [], bets = 0, wins = 0, staked = 0, pnl = 0;
  var ordered = (samples || []).slice().sort(function(a, b) { return a.t - b.t; });

  ordered.forEach(function(s) {
    if (s.y == null || !s.market) return;
    var p = predict(s);
    if (p == null || !isFinite(p)) return;
    var sides = [
      { side: "home", model: p, fair: s.market.home, ml: s.odds && s.odds.homeML, win: s.y === 1 },
      { side: "away", model: 1 - p, fair: s.market.away, ml: s.odds && s.odds.awayML, win: s.y === 0 }
    ];
    sides.forEach(function(b) {
      if (b.fair == null || b.ml == null || !isFinite(b.ml)) return;
      var edge = b.model - b.fair;
      if (edge < minEdge) return;
      var dec = b.ml > 0 ? (b.ml / 100) : (100 / -b.ml);   // net decimal payout
      var stake;
      if (mode === "kelly") {
        var k = ((dec * b.model) - (1 - b.model)) / dec;
        if (!(k > 0)) return;
        stake = Math.max(0, k * kellyFraction) * bankroll;
      } else {
        stake = stakeUnit;
      }
      if (!(stake > 0)) return;
      bets++; staked += stake;
      var ret = b.win ? stake * dec : -stake;
      pnl += ret;
      bankroll += ret;
      if (b.win) wins++;
      curve.push({ t: s.t, date: s.date, pnl: pnl, bankroll: bankroll, stake: stake, side: b.side, edge: edge });
    });
  });

  return {
    bets: bets,
    wins: wins,
    hitRate: bets ? wins / bets : null,
    staked: staked,
    pnl: pnl,
    roi: staked > 0 ? pnl / staked : null,
    bankroll: bankroll,
    curve: curve
  };
}

// Closing-line value: did we beat the price the market settled on? Positive
// CLV is the strongest single signal that an edge is real.
function closingLineValue(records) {
  var vals = [];
  (records || []).forEach(function(r) {
    if (!r || r.takenProb == null || r.closeProb == null) return;
    vals.push(r.closeProb - r.takenProb);
  });
  if (!vals.length) return { n: 0, avg: null, positiveRate: null };
  var sum = vals.reduce(function(a, b) { return a + b; }, 0);
  var pos = vals.filter(function(v) { return v > 0; }).length;
  return { n: vals.length, avg: sum / vals.length, positiveRate: pos / vals.length };
}

return {
  isoDate: isoDate,
  dateRange: dateRange,
  chunkRanges: chunkRanges,
  lookbackRange: lookbackRange,
  sortByDate: sortByDate,
  isGradable: isGradable,
  dedupeById: dedupeById,
  replay: replay,
  splitDraws: splitDraws,
  chronoSplit: chronoSplit,
  walkForwardFolds: walkForwardFolds,
  grade: grade,
  baselineHome: baselineHome,
  betBacktest: betBacktest,
  closingLineValue: closingLineValue
};

});
