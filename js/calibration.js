// Calibration / forecast-verification statistics: Wilson score interval,
// log loss, and the full Brier-decomposition report used by the "Model
// Health" tab. Pulled out of the inline script so the math can be unit
// tested independently of the DOM/localStorage/game-state it's normally
// wired up to.
(function(root, factory) {
  var mod = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = mod;
  }
  for (var k in mod) root[k] = mod[k];
})(typeof globalThis !== "undefined" ? globalThis : this, function() {

// 95% Wilson score confidence interval for a binomial proportion k/n.
function wilsonCI(k, n) {
  if (n === 0) return [0, 1];
  var z = 1.96, p = k / n, d = 1 + z * z / n;
  var c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

// Mean log loss for {p,y} pairs after shrinking each p toward 0.5 by `shrink`
// (shrink=1 leaves predictions untouched; <1 pulls them toward a coin flip).
function logLossAt(pairs, shrink) {
  var s = 0;
  for (var i = 0; i < pairs.length; i++) {
    var p = 0.5 + (pairs[i].p - 0.5) * shrink;
    p = Math.min(0.995, Math.max(0.005, p));
    s += -(pairs[i].y * Math.log(p) + (1 - pairs[i].y) * Math.log(1 - p));
  }
  return s / pairs.length;
}

// Full calibration report for a set of {p,y} pairs, where p is the model's
// confidence in its pick (always in [0.5, 1]) and y is 1/0 for whether the
// pick won. curShrink is the shrink factor currently applied live (only
// used to report where "now" sits on the log-loss-vs-shrink curve).
function calibrationReport(pairs, curShrink) {
  var n = pairs.length; if (n < 1) return null;
  var base = 0; for (var i = 0; i < n; i++) base += pairs[i].y; base /= n; // overall pick win rate
  var bs = 0; for (i = 0; i < n; i++) bs += Math.pow(pairs[i].p - pairs[i].y, 2); bs /= n;
  var bsRef = base * (1 - base), bss = bsRef > 0 ? 1 - bs / bsRef : 0;
  var ll = logLossAt(pairs, 1), llBase = -((base > 0 ? base * Math.log(base) : 0) + ((1 - base) > 0 ? (1 - base) * Math.log(1 - base) : 0));
  var B = 10, bins = []; for (i = 0; i < B; i++) bins.push({ lo: 0.5 + i * 0.05, hi: 0.5 + (i + 1) * 0.05, sp: 0, sy: 0, n: 0 });
  for (i = 0; i < n; i++) { var bi = Math.min(B - 1, Math.max(0, Math.floor((pairs[i].p - 0.5) / 0.05))); bins[bi].sp += pairs[i].p; bins[bi].sy += pairs[i].y; bins[bi].n++; }
  var rel = 0, res = 0, ece = 0;
  bins.forEach(function(b) { if (b.n > 0) { b.pbar = b.sp / b.n; b.obar = b.sy / b.n; b.ci = wilsonCI(b.sy, b.n); rel += b.n * Math.pow(b.pbar - b.obar, 2); res += b.n * Math.pow(b.obar - base, 2); ece += b.n * Math.abs(b.pbar - b.obar); } });
  rel /= n; res /= n; ece /= n; var unc = base * (1 - base);
  var bestS = 1, bestLL = Infinity; for (var s = 0.30; s <= 1.5001; s += 0.02) { var l = logLossAt(pairs, s); if (l < bestLL) { bestLL = l; bestS = s; } }
  // Sharpness: RMS distance of predictions from 50/50 (bold-but-calibrated is the
  // goal). NOTE: this must be measured from 0.5, not from the sample's own mean —
  // a model that is always confidently at, say, 90% should score as maximally
  // sharp, not as "no spread" just because it's consistent.
  var sh = 0; for (i = 0; i < n; i++) sh += Math.pow(pairs[i].p - 0.5, 2); sh = Math.sqrt(sh / n);
  // recent-window ECE (last 30 graded) vs full period — drift check
  var rEce = null;
  if (n >= 40) {
    var rp = pairs.slice(-30), rb = []; for (i = 0; i < 10; i++) rb.push({ sp: 0, sy: 0, n: 0 });
    rp.forEach(function(q) { var bi = Math.min(9, Math.max(0, Math.floor((q.p - 0.5) / 0.05))); rb[bi].sp += q.p; rb[bi].sy += q.y; rb[bi].n++; });
    rEce = 0; rb.forEach(function(b) { if (b.n > 0) rEce += b.n * Math.abs(b.sp / b.n - b.sy / b.n); }); rEce /= rp.length;
  }
  return { n: n, base: base, brier: bs, bss: bss, logloss: ll, llBase: llBase, reliability: rel, resolution: res, uncertainty: unc, ece: ece, sharpness: sh, recentEce: rEce, bins: bins, optShrink: Math.round(bestS * 100) / 100, optLL: bestLL, curLL: logLossAt(pairs, curShrink == null ? 1 : curShrink) };
}

return {
  wilsonCI: wilsonCI,
  logLossAt: logLossAt,
  calibrationReport: calibrationReport
};

});
