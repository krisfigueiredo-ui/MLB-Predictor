// Rating and probability models for every competition kind in the catalog.
//
// One Elo core feeds four different outcome models, because "who wins" means
// something different per sport:
//   team  -> two-way logistic on the rating gap
//   draw  -> Davidson three-way (soccer), plus a bivariate Poisson goals model
//            for 1X2 / BTTS / totals / correct score
//   duel  -> hierarchical tennis model (point -> game -> set -> match)
//   field -> Plackett-Luce over the whole entrant list (golf, motorsport)
//
// Everything here is pure maths on plain numbers so it can be unit tested
// without a network or a DOM.
// Exposed as MS.ratings in the browser and via module.exports under Node, so the
// nine modules never collide on the global scope.
(function(root, factory) {
  var mod = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = mod;
  }
  root.MS = root.MS || {};
  root.MS.ratings = mod;
})(typeof globalThis !== "undefined" ? globalThis : this, function() {

var EPS = 1e-12;

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function clampProb(p) { return clamp(p, 1e-6, 1 - 1e-6); }
function logistic(z) { return 1 / (1 + Math.exp(-z)); }
function logit(p) { var q = clampProb(p); return Math.log(q / (1 - q)); }

// ---- Elo core -------------------------------------------------------------
// Two-way win probability from ratings plus a home bump (in rating points).
function eloProb(homeRating, awayRating, hfa) {
  var d = (homeRating + (hfa || 0)) - awayRating;
  return 1 / (1 + Math.pow(10, -d / 400));
}

// Margin-of-victory rating change (538-style): larger margins move ratings
// more with diminishing returns, damped when a heavy favourite wins so
// blowouts by strong sides don't run away with the rating.
// result: 1 home win, 0 away win, 0.5 draw.
function eloChange(k, margin, ratingDiff, result, expected) {
  var m = Math.abs(margin || 0);
  var sign = result >= 0.5 ? 1 : -1;
  var mov = Math.log(m + 1) * (2.2 / ((sign * (ratingDiff || 0)) * 0.001 + 2.2));
  if (!isFinite(mov) || mov <= 0) mov = 1;
  return k * mov * (result - expected);
}

// Regress every rating toward the mean between seasons: last year's table is
// informative about this year, but not as informative as it looks.
function regressToMean(rating, mean, weight) {
  var w = weight == null ? 0.25 : clamp(weight, 0, 1);
  return rating * (1 - w) + (mean == null ? 1500 : mean) * w;
}

// ---- Draw-capable two-team model (Davidson) --------------------------------
// Davidson (1970) extends Bradley-Terry with a draw term:
//   P(H) = g / (g + 1 + nu*sqrt(g)),  P(D) = nu*sqrt(g) / (...),  P(A) = 1 / (...)
// where g is the two-way odds ratio from Elo. nu controls how often draws
// happen and is calibrated from a league's observed draw rate.
function davidson(homeRating, awayRating, hfa, nu) {
  var g = Math.pow(10, ((homeRating + (hfa || 0)) - awayRating) / 400);
  var v = Math.max(0, nu == null ? 0.75 : nu);
  var den = g + 1 + v * Math.sqrt(g);
  if (!isFinite(den) || den <= 0) return { home: 1 / 3, draw: 1 / 3, away: 1 / 3 };
  return { home: g / den, draw: (v * Math.sqrt(g)) / den, away: 1 / den };
}

// Invert the even-teams case to get nu from a league's draw rate:
// at g=1, P(D) = nu/(2+nu)  =>  nu = 2d/(1-d).
function nuFromDrawRate(drawRate) {
  var d = clamp(drawRate == null ? 0.25 : drawRate, 0.001, 0.6);
  return (2 * d) / (1 - d);
}

// ---- Poisson goals model ---------------------------------------------------
function poissonPmf(lambda, k) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  var logp = -lambda + k * Math.log(lambda);
  for (var i = 2; i <= k; i++) logp -= Math.log(i);
  return Math.exp(logp);
}

// Split an expected match total into per-side scoring rates using the rating
// gap. `total` is the league's expected combined goals; `ratingDiff` includes
// home advantage. The gap is mapped to a goal-difference via a soft scale so
// extreme mismatches don't produce absurd lambdas.
function lambdasFromRatings(ratingDiff, expectedTotal, opts) {
  opts = opts || {};
  var total = expectedTotal > 0 ? expectedTotal : 2.7;
  var perPoint = opts.goalsPer400 == null ? 0.9 : opts.goalsPer400;
  var diff = clamp((ratingDiff || 0) / 400, -2.5, 2.5) * perPoint;
  var lh = clamp(total / 2 + diff / 2, 0.05, total * 1.6);
  var la = clamp(total / 2 - diff / 2, 0.05, total * 1.6);
  return { home: lh, away: la };
}

// Dixon-Coles low-score dependency correction: independent Poisson understates
// 0-0/1-1 and overstates 1-0/0-1.
function dixonColesTau(x, y, lh, la, rho) {
  var r = rho == null ? -0.05 : rho;
  if (x === 0 && y === 0) return 1 - lh * la * r;
  if (x === 0 && y === 1) return 1 + lh * r;
  if (x === 1 && y === 0) return 1 + la * r;
  if (x === 1 && y === 1) return 1 - r;
  return 1;
}

// Full score matrix -> every derived market in one pass.
function poissonMatrix(lh, la, opts) {
  opts = opts || {};
  var maxGoals = opts.maxGoals == null ? 10 : opts.maxGoals;
  var rho = opts.rho;
  var lines = opts.totalLines || [0.5, 1.5, 2.5, 3.5, 4.5];

  var ph = [], pa = [];
  for (var i = 0; i <= maxGoals; i++) { ph.push(poissonPmf(lh, i)); pa.push(poissonPmf(la, i)); }

  var home = 0, draw = 0, away = 0, btts = 0, sum = 0;
  var overs = {}; lines.forEach(function(L) { overs[L] = 0; });
  var scores = [];
  for (var x = 0; x <= maxGoals; x++) {
    for (var y = 0; y <= maxGoals; y++) {
      var p = ph[x] * pa[y] * dixonColesTau(x, y, lh, la, rho);
      if (p <= 0) continue;
      sum += p;
      if (x > y) home += p; else if (x === y) draw += p; else away += p;
      if (x > 0 && y > 0) btts += p;
      lines.forEach(function(L) { if (x + y > L) overs[L] += p; });
      scores.push({ home: x, away: y, p: p });
    }
  }
  // Renormalise: truncation at maxGoals and the tau correction both leak mass.
  var z = sum > 0 ? sum : 1;
  home /= z; draw /= z; away /= z; btts /= z;
  var totals = {};
  lines.forEach(function(L) { totals[L] = { over: overs[L] / z, under: 1 - overs[L] / z }; });
  scores.forEach(function(s) { s.p /= z; });
  scores.sort(function(a, b) { return b.p - a.p; });

  return {
    home: home, draw: draw, away: away,
    btts: btts,
    totals: totals,
    topScores: scores.slice(0, opts.topScores == null ? 8 : opts.topScores),
    lambdas: { home: lh, away: la },
    expectedTotal: lh + la
  };
}

// ---- Tennis: hierarchical point -> game -> set -> match ---------------------
// Probability of holding a service game given per-point serve win prob p.
function gameWinProb(p) {
  var q = 1 - clampProb(p);
  p = clampProb(p);
  var p4 = p * p * p * p;
  var straight = p4 * (1 + 4 * q + 10 * q * q);
  var deuceReach = 20 * p * p * p * q * q * q;
  var fromDeuce = (p * p) / (p * p + q * q);
  return clampProb(straight + deuceReach * fromDeuce);
}

// Tiebreak to 7 (win by 2) with the standard 1-2-2 serve rotation.
// DP over (our points, their points, whose serve) with a win-by-2 tail.
function tiebreakWinProb(pServe, pReturn, target) {
  var T = target == null ? 7 : target;
  var ps = clampProb(pServe), pr = clampProb(pReturn);
  // Serve order in a tiebreak: player A serves point 1, then pairs alternate.
  // Point index n (0-based): A serves when floor((n+1)/2) is even.
  function aServes(n) { return Math.floor((n + 1) / 2) % 2 === 0; }
  var memo = {};
  function f(a, b) {
    if (a >= T && a - b >= 2) return 1;
    if (b >= T && b - a >= 2) return 0;
    // Only a *tied* score at 6-6 or beyond is the repeating two-point cycle;
    // solve that in closed form. An advantage score (7-6) still recurses --
    // it resolves in one point to either a win or back to a tie, so the
    // recursion terminates.
    if (a === b && a >= T - 1) {
      // Over the next two points each player serves once (the rotation stays
      // symmetric from deuce onward), so the cycle is: win both, lose both,
      // or return to deuce.
      var winBoth = ps * pr;
      var loseBoth = (1 - ps) * (1 - pr);
      if (winBoth + loseBoth <= EPS) return 0.5;
      return winBoth / (winBoth + loseBoth);
    }
    var key = a + "," + b;
    if (memo[key] != null) return memo[key];
    var n = a + b;
    var pWin = aServes(n) ? ps : pr;
    var v = pWin * f(a + 1, b) + (1 - pWin) * f(a, b + 1);
    memo[key] = v;
    return v;
  }
  return clampProb(f(0, 0));
}

// Set to 6 (win by 2), tiebreak at 6-6. holdProb = win own service game,
// breakProb = win opponent's service game. Player A serves the first game.
function setWinProb(holdProb, breakProb, opts) {
  opts = opts || {};
  var h = clampProb(holdProb), b = clampProb(breakProb);
  var tb = opts.tiebreak == null ? 0.5 : clampProb(opts.tiebreak);
  var finalSetNoTiebreak = !!opts.advantageSet;
  var memo = {};
  function f(a, o) {
    if (a >= 6 && a - o >= 2) return 1;
    if (o >= 6 && o - a >= 2) return 0;
    if (a === 6 && o === 6) return finalSetNoTiebreak ? advantageTail(h, b) : tb;
    if (a === 7 && o === 5) return 1;
    if (o === 7 && a === 5) return 0;
    var key = a + "," + o;
    if (memo[key] != null) return memo[key];
    // A serves games 0, 2, 4, ... of the set.
    var pWin = ((a + o) % 2 === 0) ? h : b;
    var v = pWin * f(a + 1, o) + (1 - pWin) * f(a, o + 1);
    memo[key] = v;
    return v;
  }
  // Endless-deuce set (e.g. old-style final sets): two-game cycle, one hold
  // and one break chance each, first to go +2 wins.
  function advantageTail(hh, bb) {
    var winBoth = hh * bb;
    var loseBoth = (1 - hh) * (1 - bb);
    if (winBoth + loseBoth <= EPS) return 0.5;
    return winBoth / (winBoth + loseBoth);
  }
  return clampProb(f(0, 0));
}

// Best-of-N sets from a per-set probability.
function matchWinProb(setProb, bestOf) {
  var s = clampProb(setProb);
  var need = bestOf === 5 ? 3 : 2;
  var memo = {};
  function f(a, b) {
    if (a >= need) return 1;
    if (b >= need) return 0;
    var key = a + "," + b;
    if (memo[key] != null) return memo[key];
    var v = s * f(a + 1, b) + (1 - s) * f(a, b + 1);
    memo[key] = v;
    return v;
  }
  return clampProb(f(0, 0));
}

// Drive the whole hierarchy from a rating gap. baseServe is the tour-average
// serve-point win rate (≈0.64 men, ≈0.56 women); the gap shifts both players'
// serve rates in opposite directions.
function tennisFromRatings(ratingA, ratingB, opts) {
  opts = opts || {};
  var base = opts.baseServe == null ? 0.63 : opts.baseServe;
  var bestOf = opts.bestOf || 3;
  var perPoint = opts.pointsPer400 == null ? 0.055 : opts.pointsPer400;
  var d = clamp(((ratingA || 1500) - (ratingB || 1500)) / 400, -3, 3);
  var pA = clamp(base + d * perPoint, 0.4, 0.85);
  var pB = clamp(base - d * perPoint, 0.4, 0.85);
  var holdA = gameWinProb(pA);
  var holdB = gameWinProb(pB);
  var breakA = 1 - holdB;             // A wins B's service game
  var tb = tiebreakWinProb(pA, 1 - pB);
  var set = setWinProb(holdA, breakA, { tiebreak: tb });
  return {
    servePoint: { a: pA, b: pB },
    hold: { a: holdA, b: holdB },
    tiebreak: tb,
    set: set,
    match: matchWinProb(set, bestOf),
    bestOf: bestOf
  };
}

// ---- Field events: Plackett-Luce ------------------------------------------
// Win probability for each entrant is its strength share. `scale` converts
// rating points to log-strength; a larger scale flattens the field.
function plackettLuceWin(ratings, opts) {
  opts = opts || {};
  var scale = opts.scale == null ? 200 : opts.scale;
  var vals = (ratings || []).map(function(r) { return (r == null ? 1500 : r) / scale; });
  if (!vals.length) return [];
  var mx = Math.max.apply(null, vals);
  var exps = vals.map(function(v) { return Math.exp(v - mx); });
  var sum = exps.reduce(function(a, b) { return a + b; }, 0) || 1;
  return exps.map(function(e) { return e / sum; });
}

// Deterministic LCG so top-k estimates are reproducible run to run.
function makeRng(seed) {
  var s = (seed == null ? 987654321 : seed) >>> 0;
  return function() { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}

// Top-k finish probabilities by repeated Plackett-Luce sampling without
// replacement. Exact top-k is combinatorial for a 150-player field, so this is
// a seeded Monte Carlo -- same seed, same numbers.
function fieldTopK(ratings, k, opts) {
  opts = opts || {};
  var iters = opts.iters == null ? 2000 : opts.iters;
  var scale = opts.scale == null ? 200 : opts.scale;
  var n = (ratings || []).length;
  if (!n) return [];
  var K = Math.min(k == null ? 5 : k, n);
  var w = ratings.map(function(r) { return Math.exp(((r == null ? 1500 : r) - 1500) / scale); });
  var counts = new Array(n).fill(0);
  var rng = makeRng(opts.seed);
  for (var it = 0; it < iters; it++) {
    var pool = w.slice();
    var total = pool.reduce(function(a, b) { return a + b; }, 0);
    for (var pick = 0; pick < K; pick++) {
      if (total <= 0) break;
      var t = rng() * total, acc = 0, chosen = -1;
      for (var i = 0; i < n; i++) {
        if (pool[i] <= 0) continue;
        acc += pool[i];
        if (t <= acc) { chosen = i; break; }
      }
      if (chosen < 0) break;
      counts[chosen] += 1;
      total -= pool[chosen];
      pool[chosen] = 0;
    }
  }
  return counts.map(function(c) { return c / iters; });
}

// ---- Odds helpers ----------------------------------------------------------
function americanToProb(ml) {
  if (ml == null || !isFinite(ml)) return null;
  return ml > 0 ? 100 / (ml + 100) : (-ml) / ((-ml) + 100);
}

function probToAmerican(p) {
  var q = clampProb(p);
  return q >= 0.5 ? -Math.round((q / (1 - q)) * 100) : Math.round(((1 - q) / q) * 100);
}

// Strip the bookmaker's margin proportionally across any number of outcomes.
function devig(probs) {
  var vals = (probs || []).filter(function(p) { return p != null && isFinite(p) && p > 0; });
  var sum = vals.reduce(function(a, b) { return a + b; }, 0);
  if (sum <= 0) return (probs || []).map(function() { return null; });
  return (probs || []).map(function(p) { return (p == null || !isFinite(p) || p <= 0) ? null : p / sum; });
}

// Fair no-vig probabilities from a market. Handles 2-way and 3-way.
function marketProbs(odds) {
  if (!odds) return null;
  var raw = [americanToProb(odds.homeML), americanToProb(odds.drawML), americanToProb(odds.awayML)];
  var present = raw.filter(function(p) { return p != null; });
  if (present.length < 2) return null;
  var fair = devig(raw);
  return { home: fair[0], draw: fair[1], away: fair[2], overround: present.reduce(function(a, b) { return a + b; }, 0) };
}

// Blend independent probability estimates in logit space with weights.
function blendLogits(estimates) {
  var num = 0, den = 0;
  (estimates || []).forEach(function(e) {
    if (!e || e.p == null || !isFinite(e.p)) return;
    var w = e.w == null ? 1 : e.w;
    if (w <= 0) return;
    num += w * logit(e.p);
    den += w;
  });
  if (den <= 0) return null;
  return logistic(num / den);
}

// Shrink a probability toward 0.5 -- the honest response to a model that is
// over-confident on held-out data.
function shrink(p, factor) {
  var f = factor == null ? 1 : clamp(factor, 0, 1);
  return clampProb(0.5 + (clampProb(p) - 0.5) * f);
}

// Normalise any 3-way triple so it sums to 1.
function normalize3(h, d, a) {
  var s = (h || 0) + (d || 0) + (a || 0);
  if (s <= 0) return { home: 1 / 3, draw: 1 / 3, away: 1 / 3 };
  return { home: h / s, draw: d / s, away: a / s };
}

return {
  clamp: clamp, clampProb: clampProb, logistic: logistic, logit: logit,
  eloProb: eloProb, eloChange: eloChange, regressToMean: regressToMean,
  davidson: davidson, nuFromDrawRate: nuFromDrawRate,
  poissonPmf: poissonPmf, lambdasFromRatings: lambdasFromRatings,
  dixonColesTau: dixonColesTau, poissonMatrix: poissonMatrix,
  gameWinProb: gameWinProb, tiebreakWinProb: tiebreakWinProb,
  setWinProb: setWinProb, matchWinProb: matchWinProb, tennisFromRatings: tennisFromRatings,
  plackettLuceWin: plackettLuceWin, fieldTopK: fieldTopK, makeRng: makeRng,
  americanToProb: americanToProb, probToAmerican: probToAmerican,
  devig: devig, marketProbs: marketProbs,
  blendLogits: blendLogits, shrink: shrink, normalize3: normalize3
};

});
