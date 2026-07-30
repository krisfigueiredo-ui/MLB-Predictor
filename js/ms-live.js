// Live, in-game analysis: the ESPN-app-style layer.
//
// Three jobs:
//   1. Normalise ESPN's live blocks (situation, plays, drives, winprobability)
//      into one shape per sport.
//   2. Compute our *own* in-game win probability, so the chart still works for
//      the many leagues where ESPN ships no winprobability array at all.
//   3. Turn that into the things people actually want to look at: the swing
//      chart, the biggest-swing plays, leverage, and momentum.
//
// The in-game models are deliberately different per sport because the physics
// are different: a clock sport is a Brownian bridge on the margin, soccer is a
// Poisson race over the minutes that remain, baseball is discrete outs.
// Exposed as MS.live in the browser and via module.exports under Node, so the
// nine modules never collide on the global scope.
(function(root, factory) {
  var mod = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = mod;
  }
  root.MS = root.MS || {};
  root.MS.live = mod;
})(typeof globalThis !== "undefined" ? globalThis : this, function() {

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function clampProb(p) { return clamp(p, 1e-6, 1 - 1e-6); }

// Abramowitz & Stegun 7.1.26 error function -> normal CDF. Accurate to ~1e-7,
// which is far tighter than anything downstream needs.
function erf(x) {
  var s = x < 0 ? -1 : 1;
  var a = Math.abs(x);
  var t = 1 / (1 + 0.3275911 * a);
  var poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return s * (1 - poly * Math.exp(-a * a));
}

function normalCdf(z) { return 0.5 * (1 + erf(z / Math.SQRT2)); }

function normalInv(p) {
  // Acklam's inverse-normal approximation; used to turn a pregame win
  // probability back into an expected margin.
  var q = clamp(p, 1e-9, 1 - 1e-9);
  var a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
           1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  var b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
           6.680131188771972e+01, -1.328068155288572e+01];
  var c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
           -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  var d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  var pl = 0.02425, x;
  if (q < pl) {
    var u = Math.sqrt(-2 * Math.log(q));
    x = (((((c[0] * u + c[1]) * u + c[2]) * u + c[3]) * u + c[4]) * u + c[5]) /
        ((((d[0] * u + d[1]) * u + d[2]) * u + d[3]) * u + 1);
  } else if (q <= 1 - pl) {
    var v = q - 0.5, r = v * v;
    x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * v /
        (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    var w = Math.sqrt(-2 * Math.log(1 - q));
    x = -(((((c[0] * w + c[1]) * w + c[2]) * w + c[3]) * w + c[4]) * w + c[5]) /
        ((((d[0] * w + d[1]) * w + d[2]) * w + d[3]) * w + 1);
  }
  return x;
}

// Regulation shape + final-margin volatility per sport. `sigma` is the
// standard deviation of the final margin, which is what sets how fast a lead
// becomes safe.
var SPORT_CLOCK = {
  "basketball/nba":                        { periods: 4, minutes: 12, sigma: 12.0 },
  "basketball/wnba":                       { periods: 4, minutes: 10, sigma: 11.0 },
  "basketball/mens-college-basketball":    { periods: 2, minutes: 20, sigma: 11.0 },
  "basketball/womens-college-basketball":  { periods: 4, minutes: 10, sigma: 11.5 },
  "basketball/nba-development":            { periods: 4, minutes: 12, sigma: 13.0 },
  "basketball/nbl":                        { periods: 4, minutes: 10, sigma: 12.0 },
  "football/nfl":                          { periods: 4, minutes: 15, sigma: 13.5 },
  "football/nfl-preseason":                { periods: 4, minutes: 15, sigma: 13.5 },
  "football/college-football":             { periods: 4, minutes: 15, sigma: 16.5 },
  "football/cfl":                          { periods: 4, minutes: 15, sigma: 14.5 },
  "football/ufl":                          { periods: 4, minutes: 15, sigma: 14.0 },
  "hockey/nhl":                            { periods: 3, minutes: 20, sigma: 2.3 },
  "hockey/mens-college-hockey":            { periods: 3, minutes: 20, sigma: 2.4 }
};

var SPORT_CLOCK_DEFAULT = {
  basketball: { periods: 4, minutes: 12, sigma: 12 },
  football:   { periods: 4, minutes: 15, sigma: 14 },
  hockey:     { periods: 3, minutes: 20, sigma: 2.3 },
  lacrosse:   { periods: 4, minutes: 15, sigma: 4.5 },
  rugby:      { periods: 2, minutes: 40, sigma: 14 },
  "water-polo": { periods: 4, minutes: 8, sigma: 4.0 }
};

function clockConfig(league) {
  if (!league) return null;
  return SPORT_CLOCK[league.id] || SPORT_CLOCK_DEFAULT[league.sport] || null;
}

// Fraction of regulation still to play, in [0, 1]. Overtime returns a small
// positive floor -- the game isn't over, but almost no time remains.
function fractionRemaining(status, league) {
  var cfg = clockConfig(league);
  if (!cfg || !status) return null;
  if (status.state === "pre") return 1;
  if (status.final) return 0;
  var period = status.period || 1;
  var secsLeftInPeriod = status.clockSeconds;
  if (secsLeftInPeriod == null) secsLeftInPeriod = parseClockSeconds(status.clock);
  if (secsLeftInPeriod == null) return null;
  if (period > cfg.periods) return 0.02;              // overtime
  var periodsLeftAfter = cfg.periods - period;
  var totalSecs = cfg.periods * cfg.minutes * 60;
  var remain = periodsLeftAfter * cfg.minutes * 60 + secsLeftInPeriod;
  return clamp(remain / totalSecs, 0, 1);
}

// "8:42" / "12:03" / "0:31.4" -> seconds. Soccer's "67'" is handled by the
// soccer path, not here.
function parseClockSeconds(display) {
  if (display == null) return null;
  var s = String(display).trim();
  var m = s.match(/^(\d+):(\d+(?:\.\d+)?)$/);
  if (m) return parseInt(m[1], 10) * 60 + parseFloat(m[2]);
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  return null;
}

// Soccer minute from ESPN's displayClock ("67'", "45'+2'", "90+4").
function soccerMinute(display, period) {
  if (display == null) return period === 2 ? 45 : 0;
  var s = String(display);
  var m = s.match(/(\d+)\s*'?\s*(?:\+\s*(\d+))?/);
  if (!m) return null;
  var base = parseInt(m[1], 10);
  var extra = m[2] ? parseInt(m[2], 10) : 0;
  return base + extra;
}

// ---- In-game models --------------------------------------------------------

// Clock sports: model the remaining margin change as Brownian motion. With f
// the fraction of regulation left and mu the pregame expected margin,
//   P(home wins) = Phi( (margin + mu*f) / (sigma*sqrt(f)) )
// At f=1 this returns the pregame probability exactly; as f->0 it collapses to
// "whoever is ahead".
function liveWinProbClock(margin, fracRemaining, pregameHomeProb, sigma, opts) {
  opts = opts || {};
  var f = clamp(fracRemaining == null ? 1 : fracRemaining, 0, 1);
  var sg = sigma > 0 ? sigma : 12;
  var mu = normalInv(clampProb(pregameHomeProb == null ? 0.5 : pregameHomeProb)) * sg;
  if (f <= 0) {
    if (margin > 0) return 1 - 1e-6;
    if (margin < 0) return 1e-6;
    return 0.5;                                       // tied at the horn -> OT
  }
  var z = (margin + mu * f) / (sg * Math.sqrt(f));
  var p = normalCdf(z);
  // Ties go to overtime rather than resolving, so a dead-level game late is a
  // coin flip, not a certainty either way.
  if (opts.tiesGoToOvertime !== false && margin === 0 && f < 0.02) p = 0.5;
  return clampProb(p);
}

// Soccer: the goals still to come are Poisson with rate scaled by the minutes
// remaining. Convolve the current margin with the remaining-goal distributions
// to get exact live 1X2 probabilities.
function liveWinProbSoccer(margin, minutesRemaining, lambdaHomeFull, lambdaAwayFull, opts) {
  opts = opts || {};
  var maxGoals = opts.maxGoals == null ? 8 : opts.maxGoals;
  var f = clamp((minutesRemaining == null ? 90 : minutesRemaining) / 90, 0, 1);
  var lh = Math.max(1e-6, (lambdaHomeFull == null ? 1.35 : lambdaHomeFull) * f);
  var la = Math.max(1e-6, (lambdaAwayFull == null ? 1.35 : lambdaAwayFull) * f);
  function pmf(l, k) {
    var lp = -l + k * Math.log(l);
    for (var i = 2; i <= k; i++) lp -= Math.log(i);
    return Math.exp(lp);
  }
  var home = 0, draw = 0, away = 0, sum = 0;
  for (var x = 0; x <= maxGoals; x++) {
    for (var y = 0; y <= maxGoals; y++) {
      var p = pmf(lh, x) * pmf(la, y);
      if (p <= 0) continue;
      sum += p;
      var finalMargin = (margin || 0) + x - y;
      if (finalMargin > 0) home += p; else if (finalMargin === 0) draw += p; else away += p;
    }
  }
  var z = sum > 0 ? sum : 1;
  return { home: home / z, draw: draw / z, away: away / z };
}

// Baseball: discrete outs, so scale the remaining scoring by half-innings left
// and add the current base-out run expectancy for the batting side.
// A normal approximation to the run difference is plenty at this resolution.
var RUN_EXPECTANCY = {
  // outs -> [bases empty, 1st, 2nd, 3rd, 1st+2nd, 1st+3rd, 2nd+3rd, loaded]
  0: [0.48, 0.85, 1.10, 1.35, 1.44, 1.75, 1.95, 2.29],
  1: [0.25, 0.50, 0.68, 0.94, 0.89, 1.15, 1.35, 1.54],
  2: [0.10, 0.22, 0.32, 0.36, 0.43, 0.49, 0.58, 0.75]
};

function baseOutIndex(onFirst, onSecond, onThird) {
  var b = (onFirst ? 1 : 0) + (onSecond ? 2 : 0) + (onThird ? 4 : 0);
  var map = [0, 1, 2, 4, 3, 5, 6, 7];   // bitmask -> RE24 column order
  return map[b];
}

function runExpectancy(outs, onFirst, onSecond, onThird) {
  var o = clamp(outs == null ? 0 : outs, 0, 2);
  var row = RUN_EXPECTANCY[o] || RUN_EXPECTANCY[0];
  return row[baseOutIndex(onFirst, onSecond, onThird)];
}

// Probability of scoring *at least one* run from a base-out state. This is a
// different question from run expectancy, and it is the one that matters in a
// walk-off: bases loaded with nobody out has an expectancy of 2.29 runs but
// only about an 87% chance of scoring even one. A mean-based normal
// approximation gets that state badly wrong, so the walk-off path uses this
// table instead.
var SCORE_ANY = {
  0: [0.27, 0.43, 0.62, 0.84, 0.63, 0.85, 0.86, 0.87],
  1: [0.16, 0.27, 0.41, 0.66, 0.42, 0.66, 0.68, 0.66],
  2: [0.07, 0.13, 0.22, 0.27, 0.23, 0.28, 0.28, 0.32]
};

function scoreAnyProb(outs, onFirst, onSecond, onThird) {
  var o = clamp(outs == null ? 0 : outs, 0, 2);
  var row = SCORE_ANY[o] || SCORE_ANY[0];
  return row[baseOutIndex(onFirst, onSecond, onThird)];
}

function liveWinProbBaseball(margin, inning, isTopInning, situation, opts) {
  opts = opts || {};
  var regulation = opts.innings == null ? 9 : opts.innings;
  var runsPerInning = opts.runsPerInning == null ? 0.48 : opts.runsPerInning;
  var varPerInning = opts.varPerInning == null ? 1.05 : opts.varPerInning;
  var inn = inning == null ? 1 : inning;
  var m = margin || 0;

  // Count *whole* innings each side still gets to bat after the current
  // half-inning; the current half is handled by run expectancy instead.
  var fullLeft = Math.max(0, regulation - inn);
  var homeFull, awayFull;
  if (isTopInning) {
    awayFull = fullLeft;          // away is batting now, then fullLeft more
    homeFull = fullLeft + 1;      // home still bats the bottom of this inning
  } else {
    homeFull = fullLeft;          // home is batting now
    awayFull = fullLeft;
  }
  // A leading home side doesn't bat in the bottom of the last inning.
  if (isTopInning && inn >= regulation && m > 0) homeFull = 0;

  var sit = situation || {};

  // Walk-off: home batting in the bottom of the last (or an extra) inning with
  // the scores level needs exactly one run, so use P(score at least one)
  // directly rather than the normal approximation, which badly overstates it.
  if (!isTopInning && inn >= regulation && m === 0) {
    var pScore = scoreAnyProb(sit.outs, sit.onFirst, sit.onSecond, sit.onThird);
    var extras = opts.extraInningsHomeProb == null ? 0.54 : opts.extraInningsHomeProb;
    return clampProb(pScore + (1 - pScore) * extras);
  }

  var re = runExpectancy(sit.outs, sit.onFirst, sit.onSecond, sit.onThird);
  var meanHome = homeFull * runsPerInning + (isTopInning ? 0 : re);
  var meanAway = awayFull * runsPerInning + (isTopInning ? re : 0);

  // Nothing left to play: the scoreboard is the answer.
  var currentHalfLive = !(isTopInning ? awayFull === 0 && re === 0 : homeFull === 0 && re === 0);
  if (homeFull === 0 && awayFull === 0 && !currentHalfLive) {
    if (m > 0) return 1 - 1e-6;
    if (m < 0) return 1e-6;
    return 0.5;
  }

  // Model each side's remaining runs as negative binomial rather than normal.
  // Two things about run scoring break a normal approximation: the
  // distribution is skewed (most innings are scoreless) and it is
  // over-dispersed (variance runs about twice the mean, because big innings
  // happen). A negative binomial captures both, and the run *difference*
  // follows from convolving the two distributions directly.
  var dist = runDiffDistribution(meanHome, meanAway, varPerInning);
  var win = 0, tie = 0;
  for (var d = -dist.max; d <= dist.max; d++) {
    var p = dist.pmf(d);
    if (m + d > 0) win += p;
    else if (m + d === 0) tie += p;
  }
  // A tie sends the game to extra innings, which is near enough a coin flip.
  return clampProb(win + 0.5 * tie);
}

// Log-gamma (Lanczos), needed because the negative binomial's shape parameter
// is not an integer once it is scaled by a fractional number of innings.
function lgamma(z) {
  var g = [676.5203681218851, -1259.1392167224028, 771.32342877765313,
           -176.61502916214059, 12.507343278686905, -0.13857109526572012,
           9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  z -= 1;
  var x = 0.99999999999980993;
  for (var i = 0; i < g.length; i++) x += g[i] / (z + i + 1);
  var t = z + g.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

// Negative binomial pmf parameterised by mean and variance-to-mean ratio.
function negBinomPmf(mean, ratio, k) {
  if (mean <= 0) return k === 0 ? 1 : 0;
  var vmr = Math.max(1.0001, ratio);
  var r = mean / (vmr - 1);            // shape
  var p = 1 / vmr;                     // success probability
  var logp = lgamma(k + r) - lgamma(r) - lgamma(k + 1) + r * Math.log(p) + k * Math.log(1 - p);
  return Math.exp(logp);
}

// Distribution of (home runs - away runs) over the innings that remain.
function runDiffDistribution(meanHome, meanAway, varPerInning) {
  var maxRuns = 24;
  // Variance-to-mean ratio implied by the per-inning variance and mean.
  var vmr = Math.max(1.05, varPerInning / 0.48);
  var ph = [], pa = [];
  for (var k = 0; k <= maxRuns; k++) {
    ph.push(negBinomPmf(meanHome, vmr, k));
    pa.push(negBinomPmf(meanAway, vmr, k));
  }
  var diff = {};
  var total = 0;
  for (var x = 0; x <= maxRuns; x++) {
    if (ph[x] < 1e-12) continue;
    for (var y = 0; y <= maxRuns; y++) {
      if (pa[y] < 1e-12) continue;
      var d = x - y;
      var v = ph[x] * pa[y];
      diff[d] = (diff[d] || 0) + v;
      total += v;
    }
  }
  var z = total > 0 ? total : 1;
  return {
    max: maxRuns,
    pmf: function(d) { return (diff[d] || 0) / z; }
  };
}

// Tennis: sets already banked plus the state of the current set.
function liveWinProbTennis(setsA, setsB, currentSetProb, bestOf, ratingsMod) {
  var need = bestOf === 5 ? 3 : 2;
  var a = setsA || 0, b = setsB || 0;
  if (a >= need) return 1 - 1e-6;
  if (b >= need) return 1e-6;
  var setP = currentSetProb == null ? 0.5 : clampProb(currentSetProb);
  // The current set uses its live probability; later sets revert to the
  // players' baseline set probability.
  var baseline = setP;
  var memo = {};
  function f(x, y, useLive) {
    if (x >= need) return 1;
    if (y >= need) return 0;
    var key = x + "," + y + "," + (useLive ? 1 : 0);
    if (memo[key] != null) return memo[key];
    var p = useLive ? setP : baseline;
    var v = p * f(x + 1, y, false) + (1 - p) * f(x, y + 1, false);
    memo[key] = v;
    return v;
  }
  return clampProb(f(a, b, true));
}

// ---- ESPN live block parsing ----------------------------------------------

// Normalise the scoreboard `situation` block across sports.
function parseSituation(game) {
  var s = game && game.situation;
  if (!s) return null;
  var lastPlay = s.lastPlay || null;
  var out = {
    lastPlayText: lastPlay ? (lastPlay.text || (lastPlay.type && lastPlay.type.text) || null) : null,
    lastPlayTeamId: lastPlay && lastPlay.team ? String(lastPlay.team.id) : null,
    scoreValue: lastPlay && lastPlay.scoreValue != null ? Number(lastPlay.scoreValue) : null,
    possessionTeamId: s.possession != null ? String(s.possession) : null,
    possessionText: s.possessionText || null,
    // Football
    down: s.down != null ? Number(s.down) : null,
    distance: s.distance != null ? Number(s.distance) : null,
    yardLine: s.yardLine != null ? Number(s.yardLine) : null,
    downDistanceText: s.downDistanceText || s.shortDownDistanceText || null,
    isRedZone: !!s.isRedZone,
    homeTimeouts: s.homeTimeouts != null ? Number(s.homeTimeouts) : null,
    awayTimeouts: s.awayTimeouts != null ? Number(s.awayTimeouts) : null,
    // Baseball
    balls: s.balls != null ? Number(s.balls) : null,
    strikes: s.strikes != null ? Number(s.strikes) : null,
    outs: s.outs != null ? Number(s.outs) : null,
    onFirst: !!s.onFirst, onSecond: !!s.onSecond, onThird: !!s.onThird,
    pitcher: s.pitcher && s.pitcher.athlete ? (s.pitcher.athlete.shortName || s.pitcher.athlete.displayName) : null,
    batter: s.batter && s.batter.athlete ? (s.batter.athlete.shortName || s.batter.athlete.displayName) : null
  };
  return out;
}

// A short human summary of the live state, per sport -- the line the ESPN app
// puts under the score.
function situationSummary(game, league, status) {
  var s = parseSituation(game);
  var sport = league && league.sport;
  if (!s) return status && status.detail ? status.detail : null;
  if (sport === "football") {
    var bits = [];
    if (s.downDistanceText) bits.push(s.downDistanceText);
    if (s.possessionText) bits.push(s.possessionText);
    if (s.isRedZone) bits.push("Red zone");
    return bits.join(" · ") || s.lastPlayText;
  }
  if (sport === "baseball") {
    // Only describe the count and bases if ESPN actually sent a count. Without
    // that, "Bases empty" would be an assertion we can't support.
    if (s.balls == null && s.strikes == null && s.outs == null) {
      return s.lastPlayText || (status && status.detail) || null;
    }
    var b = [];
    if (s.balls != null && s.strikes != null) b.push(s.balls + "-" + s.strikes);
    if (s.outs != null) b.push(s.outs + " out" + (s.outs === 1 ? "" : "s"));
    var bases = [s.onFirst ? "1st" : null, s.onSecond ? "2nd" : null, s.onThird ? "3rd" : null].filter(Boolean);
    b.push(bases.length ? bases.join("/") : "Bases empty");
    if (s.pitcher) b.push("P: " + s.pitcher);
    return b.join(" · ");
  }
  return s.lastPlayText || (status && status.detail) || null;
}

// Summary-endpoint plays -> normalised, oldest first.
function parsePlays(summary) {
  var plays = (summary && Array.isArray(summary.plays)) ? summary.plays : [];
  return plays.map(function(p) {
    if (!p) return null;
    return {
      id: p.id != null ? String(p.id) : null,
      sequence: p.sequenceNumber != null ? Number(p.sequenceNumber) : null,
      text: p.text || (p.type && p.type.text) || null,
      shortText: p.shortText || null,
      typeText: (p.type && p.type.text) || null,
      period: p.period && p.period.number != null ? Number(p.period.number) : null,
      // Baseball needs to know which half of the inning it is; ESPN puts that
      // in the period block as "Top"/"Bottom" rather than on a clock.
      periodDisplay: p.period ? (p.period.displayValue || p.period.type || null) : null,
      clock: p.clock ? (p.clock.displayValue || null) : null,
      homeScore: p.homeScore != null ? Number(p.homeScore) : null,
      awayScore: p.awayScore != null ? Number(p.awayScore) : null,
      scoringPlay: !!p.scoringPlay,
      scoreValue: p.scoreValue != null ? Number(p.scoreValue) : null,
      teamId: p.team && p.team.id != null ? String(p.team.id) : null,
      wallclock: p.wallclock || null
    };
  }).filter(Boolean);
}

// ESPN's own win-probability series, when the league has one.
function parseWinProbability(summary) {
  var wp = (summary && Array.isArray(summary.winprobability)) ? summary.winprobability : [];
  return wp.map(function(w) {
    if (!w) return null;
    var hp = w.homeWinPercentage;
    if (hp == null) return null;
    return {
      playId: w.playId != null ? String(w.playId) : null,
      homeWinProb: Number(hp) > 1 ? Number(hp) / 100 : Number(hp),
      tieProb: w.tiePercentage != null ? Number(w.tiePercentage) : null,
      secondsLeft: w.secondsLeft != null ? Number(w.secondsLeft) : null
    };
  }).filter(Boolean);
}

// Football drive list, flattened for the drive chart.
function parseDrives(summary) {
  var d = summary && summary.drives;
  if (!d) return [];
  var list = [];
  if (Array.isArray(d.previous)) list = list.concat(d.previous);
  if (d.current) list = list.concat([d.current]);
  return list.map(function(dr) {
    if (!dr) return null;
    return {
      id: dr.id != null ? String(dr.id) : null,
      teamId: dr.team && dr.team.id != null ? String(dr.team.id) : null,
      description: dr.description || null,
      result: dr.displayResult || dr.result || null,
      yards: dr.yards != null ? Number(dr.yards) : null,
      plays: dr.offensivePlays != null ? Number(dr.offensivePlays) : null,
      timeElapsed: dr.timeElapsed ? dr.timeElapsed.displayValue : null,
      isScore: !!dr.isScore
    };
  }).filter(Boolean);
}

// ---- Derived, interactive layers -------------------------------------------

// Build a win-probability series from plays using our own model, so every
// sport gets a swing chart whether or not ESPN supplies one.
function buildWinProbSeries(plays, ctx) {
  var out = [];
  var cfg = clockConfig(ctx.league);
  (plays || []).forEach(function(p) {
    if (p.homeScore == null || p.awayScore == null) return;
    var margin = p.homeScore - p.awayScore;
    var sport = ctx.league && ctx.league.sport;
    var f;
    if (sport === "baseball") {
      // Baseball has no clock: the innings are the axis. Base-out state isn't
      // carried on individual plays, so each point is evaluated at the start of
      // its half-inning (bases empty, nobody out).
      if (p.period == null) return;
      var isTop = /top/i.test(p.periodDisplay || "");
      out.push({
        playId: p.id, sequence: p.sequence, period: p.period,
        clock: p.periodDisplay || (isTop ? "Top " : "Bot ") + p.period,
        fracRemaining: clamp((9 - p.period) / 9, 0, 1),
        homeScore: p.homeScore, awayScore: p.awayScore,
        homeWinProb: liveWinProbBaseball(margin, p.period, isTop, {}),
        text: p.text, scoringPlay: p.scoringPlay
      });
      return;
    }
    if (sport === "soccer") {
      var minute = soccerMinute(p.clock, p.period);
      f = minute == null ? null : clamp((90 - minute) / 90, 0, 1);
    } else if (cfg && p.period != null) {
      var secs = parseClockSeconds(p.clock);
      if (secs == null) return;
      var periodsLeftAfter = cfg.periods - p.period;
      f = clamp((periodsLeftAfter * cfg.minutes * 60 + secs) / (cfg.periods * cfg.minutes * 60), 0, 1);
    } else {
      return;
    }
    var prob;
    if (ctx.league && ctx.league.sport === "soccer") {
      var lam = ctx.lambdas || { home: 1.35, away: 1.35 };
      prob = liveWinProbSoccer(margin, f * 90, lam.home, lam.away).home;
    } else {
      prob = liveWinProbClock(margin, f, ctx.pregameHomeProb, cfg ? cfg.sigma : 12);
    }
    out.push({
      playId: p.id,
      sequence: p.sequence,
      period: p.period,
      clock: p.clock,
      fracRemaining: f,
      homeScore: p.homeScore,
      awayScore: p.awayScore,
      homeWinProb: prob,
      text: p.text,
      scoringPlay: p.scoringPlay
    });
  });
  return out;
}

// Attach the win-probability change each play caused, then surface the ones
// that mattered. This is the "biggest plays of the game" list.
function winProbSwings(series, limit) {
  var withDelta = [];
  for (var i = 0; i < (series || []).length; i++) {
    var prev = i > 0 ? series[i - 1].homeWinProb : (series[i].homeWinProb);
    var delta = series[i].homeWinProb - prev;
    withDelta.push({
      playId: series[i].playId,
      text: series[i].text,
      period: series[i].period,
      clock: series[i].clock,
      homeScore: series[i].homeScore,
      awayScore: series[i].awayScore,
      homeWinProb: series[i].homeWinProb,
      delta: delta,
      absDelta: Math.abs(delta),
      scoringPlay: series[i].scoringPlay
    });
  }
  var ranked = withDelta.slice().sort(function(a, b) { return b.absDelta - a.absDelta; });
  return { series: withDelta, top: ranked.slice(0, limit == null ? 6 : limit) };
}

// Leverage: how much the *next* score would move the win probability. High
// leverage is what makes a moment tense, and it's the number the broadcast
// graphics are really showing.
function leverageIndex(ctx) {
  var league = ctx.league, cfg = clockConfig(league);
  var margin = ctx.margin || 0;
  var f = ctx.fracRemaining;
  if (f == null) return null;
  var step = ctx.scoreStep || defaultScoreStep(league);
  var up, down;
  if (league && league.sport === "soccer") {
    var lam = ctx.lambdas || { home: 1.35, away: 1.35 };
    var mins = f * 90;
    up = liveWinProbSoccer(margin + step, mins, lam.home, lam.away).home;
    down = liveWinProbSoccer(margin - step, mins, lam.home, lam.away).home;
  } else if (league && league.sport === "baseball") {
    up = liveWinProbBaseball(margin + step, ctx.inning, ctx.isTopInning, ctx.situation);
    down = liveWinProbBaseball(margin - step, ctx.inning, ctx.isTopInning, ctx.situation);
  } else {
    var sg = cfg ? cfg.sigma : 12;
    up = liveWinProbClock(margin + step, f, ctx.pregameHomeProb, sg);
    down = liveWinProbClock(margin - step, f, ctx.pregameHomeProb, sg);
  }
  var swing = Math.abs(up - down);
  // Index it against a typical mid-game swing so 1.0 means "average tension".
  var baseline = ctx.baselineSwing == null ? 0.16 : ctx.baselineSwing;
  return { swing: swing, index: baseline > 0 ? swing / baseline : null, up: up, down: down };
}

function defaultScoreStep(league) {
  if (!league) return 1;
  if (league.sport === "basketball") return 3;
  if (league.sport === "football") return 7;
  return 1;
}

// Momentum: net win-probability moved over the last `window` plays. Positive
// favours the home side.
function momentum(series, windowSize) {
  var w = windowSize == null ? 8 : windowSize;
  var s = series || [];
  if (s.length < 2) return null;
  var end = s[s.length - 1].homeWinProb;
  var startIdx = Math.max(0, s.length - 1 - w);
  var start = s[startIdx].homeWinProb;
  return { delta: end - start, from: start, to: end, plays: s.length - 1 - startIdx };
}

// One call the UI can make per live game to get everything at once.
function analyzeLive(game, league, opts) {
  opts = opts || {};
  var status = game.status || {};
  var margin = (game.home && game.home.score != null && game.away && game.away.score != null)
    ? game.home.score - game.away.score : 0;
  var sport = league && league.sport;
  var result = {
    margin: margin,
    situation: parseSituation(game),
    summary: situationSummary(game, league, status),
    fracRemaining: null,
    homeWinProb: null,
    threeWay: null,
    leverage: null,
    model: null
  };

  if (sport === "soccer") {
    var minute = soccerMinute(status.clock, status.period);
    var minsLeft = minute == null ? null : Math.max(0, 90 - minute);
    result.fracRemaining = minsLeft == null ? null : minsLeft / 90;
    var lam = opts.lambdas || { home: 1.35, away: 1.35 };
    if (minsLeft != null) {
      var tw = liveWinProbSoccer(margin, minsLeft, lam.home, lam.away);
      result.threeWay = tw;
      result.homeWinProb = tw.home;
      result.model = "poisson-remaining";
      result.minute = minute;
    }
  } else if (sport === "baseball") {
    var inning = status.period;
    var isTop = /top/i.test(status.detail || "");
    result.homeWinProb = liveWinProbBaseball(margin, inning, isTop, result.situation);
    result.model = "base-out";
    result.inning = inning;
    result.isTopInning = isTop;
    result.fracRemaining = inning == null ? null : clamp((9 - inning) / 9, 0, 1);
  } else {
    var f = fractionRemaining(status, league);
    result.fracRemaining = f;
    var cfg = clockConfig(league);
    if (f != null && cfg) {
      result.homeWinProb = liveWinProbClock(margin, f, opts.pregameHomeProb, cfg.sigma);
      result.model = "brownian";
    }
  }

  if (result.fracRemaining != null) {
    result.leverage = leverageIndex({
      league: league, margin: margin, fracRemaining: result.fracRemaining,
      pregameHomeProb: opts.pregameHomeProb, lambdas: opts.lambdas,
      inning: result.inning, isTopInning: result.isTopInning, situation: result.situation
    });
  }
  return result;
}

return {
  erf: erf, normalCdf: normalCdf, normalInv: normalInv,
  SPORT_CLOCK: SPORT_CLOCK,
  clockConfig: clockConfig,
  parseClockSeconds: parseClockSeconds,
  soccerMinute: soccerMinute,
  fractionRemaining: fractionRemaining,
  liveWinProbClock: liveWinProbClock,
  liveWinProbSoccer: liveWinProbSoccer,
  liveWinProbBaseball: liveWinProbBaseball,
  liveWinProbTennis: liveWinProbTennis,
  runExpectancy: runExpectancy,
  parseSituation: parseSituation,
  situationSummary: situationSummary,
  parsePlays: parsePlays,
  parseWinProbability: parseWinProbability,
  parseDrives: parseDrives,
  buildWinProbSeries: buildWinProbSeries,
  winProbSwings: winProbSwings,
  leverageIndex: leverageIndex,
  momentum: momentum,
  analyzeLive: analyzeLive
};

});
