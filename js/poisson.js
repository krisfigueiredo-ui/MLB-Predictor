// Poisson run-model: an independent second opinion on win probability, derived
// from each team's expected runs (Poisson-distributed) rather than an additive
// logit. Pulled out of the inline script so the scoring math is unit testable
// without needing PARK/SP/game-state globals.
(function(root, factory) {
  var mod = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = mod;
  }
  for (var k in mod) root[k] = mod[k];
})(typeof globalThis !== "undefined" ? globalThis : this, function() {

// Poisson probability mass function P(k; lambda), computed in log-space for stability.
function poisPMF(k, lam) {
  if (lam <= 0) return k === 0 ? 1 : 0;
  var lp = -lam + k * Math.log(lam);
  for (var i = 2; i <= k; i++) lp -= Math.log(i);
  return Math.exp(lp);
}

// How much a pitcher (starter ~65% of innings + bullpen ~35%) suppresses the
// opponent's scoring. 1.0 = league average; <1 = run-suppressing. Only a real,
// non-synthesized pitcher line counts -- a synthesized one is PWR-derived noise
// and would make the Poisson model circular with itself.
function pitchSuppress(pitcher, lgXfip) {
  if (lgXfip == null) lgXfip = 4.10;
  if (!pitcher) return 1;
  if (!pitcher.realQ || pitcher.synth) return 1;
  var xf = parseFloat(pitcher.xfip) || lgXfip, starter = xf / lgXfip;
  return Math.max(0.62, Math.min(1.45, starter));
}

// Pure win-probability core: given each side's scoring rate inputs, computes the
// full joint Poisson (Skellam) distribution and folds ties into extra innings.
// params: { parkFactor, homeOff, awayOff, hPitcher, aPitcher, lgRuns, lgXfip }
function poissonModelCore(params) {
  var parkF = params.parkFactor, homeOff = params.homeOff, awayOff = params.awayOff;
  var lgRuns = params.lgRuns == null ? 4.4 : params.lgRuns;
  var lgXfip = params.lgXfip == null ? 4.10 : params.lgXfip;
  var lamH = lgRuns * homeOff * pitchSuppress(params.aPitcher, lgXfip) * parkF * 1.03; // home runs vs AWAY pitching, +HFA
  var lamA = lgRuns * awayOff * pitchSuppress(params.hPitcher, lgXfip) * parkF * 0.99; // away runs vs HOME pitching
  lamH = Math.max(1.5, Math.min(8, lamH)); lamA = Math.max(1.5, Math.min(8, lamA));
  var pH = 0, pTie = 0, MAX = 18;
  for (var i = 0; i <= MAX; i++) {
    var ph = poisPMF(i, lamH);
    for (var j = 0; j <= MAX; j++) {
      var pa = poisPMF(j, lamA);
      if (i > j) pH += ph * pa; else if (i === j) pTie += ph * pa;
    }
  }
  pH += pTie * (lamH / (lamH + lamA)); // ties -> extra innings; better offense slightly favored
  return { pHome: Math.max(0.05, Math.min(0.95, pH)), lambdaH: lamH, lambdaA: lamA, total: Math.round((lamH + lamA) * 10) / 10 };
}

return {
  poisPMF: poisPMF,
  pitchSuppress: pitchSuppress,
  poissonModelCore: poissonModelCore
};

});
