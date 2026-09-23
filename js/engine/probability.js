// Probability layer shared by the Node pipeline and the browser: market
// de-vigging, forecast metrics (log loss, Brier, calibration slope, reliability),
// weighted logistic regression, and the four calibrators the auto-calibration
// ladder can choose from (fixed shrink, Platt, beta, smoothed isotonic).
// Everything here is pure; IO and scheduling live in pipeline/ and autocal.js.
(function(root, factory) {
  var mod = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = mod;
  root.DSProb = mod;
})(typeof globalThis !== "undefined" ? globalThis : this, function() {
  var EPS = 1e-6;

  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
  function clampP(p) { return clamp(p, EPS, 1 - EPS); }
  function sigmoid(z) { return 1 / (1 + Math.exp(-clamp(z, -35, 35))); }
  function logit(p) { p = clampP(p); return Math.log(p / (1 - p)); }
  function finite(x) { return typeof x === "number" && isFinite(x); }

  // ── market ──
  function americanToImplied(ml) {
    ml = Number(ml);
    if (!finite(ml) || ml === 0 || Math.abs(ml) < 100) return null;
    return ml < 0 ? (-ml) / (-ml + 100) : 100 / (ml + 100);
  }
  function americanToDecimal(ml) { ml = Number(ml); return ml > 0 ? ml / 100 + 1 : 100 / (-ml) + 1; }

  // Proportional de-vig of a two-way moneyline into fair probabilities.
  function devig(homeML, awayML) {
    var h = americanToImplied(homeML), a = americanToImplied(awayML);
    if (h == null || a == null) return null;
    var total = h + a;
    if (!(total > 0.9 && total < 1.25)) return null; // not a coherent two-way market
    return { home: h / total, away: a / total, overround: total - 1 };
  }

  // ── linear algebra / weighted logistic regression ──
  function solve(A, b) {
    var n = b.length, M = A.map(function(row, i) { return row.slice().concat([b[i]]); });
    for (var c = 0; c < n; c++) {
      var piv = c;
      for (var r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      if (Math.abs(M[piv][c]) < 1e-14) return null;
      var t = M[c]; M[c] = M[piv]; M[piv] = t;
      for (var r2 = c + 1; r2 < n; r2++) {
        var f = M[r2][c] / M[c][c];
        if (f === 0) continue;
        for (var k = c; k <= n; k++) M[r2][k] -= f * M[c][k];
      }
    }
    var x = new Array(n);
    for (var i = n - 1; i >= 0; i--) {
      var s = M[i][n];
      for (var j = i + 1; j < n; j++) s -= M[i][j] * x[j];
      x[i] = s / M[i][i];
    }
    return x;
  }

  // Newton-Raphson logistic regression. X rows carry a leading 1 (intercept);
  // y may be fractional (expected outcomes); w are per-row weights; the L2
  // penalty `lambda` applies to every coefficient except the intercept (unless
  // opts.penalizeIntercept); opts.offset adds a fixed term to each row's logit.
  function fitLogistic(X, y, w, opts) {
    opts = opts || {};
    var n = X.length; if (!n) return null;
    var d = X[0].length, lambda = opts.lambda || 0, offset = opts.offset || null;
    var beta = opts.init && opts.init.length === d ? opts.init.slice() : new Array(d).fill(0);
    for (var iter = 0; iter < (opts.iters || 60); iter++) {
      var g = new Array(d).fill(0), H = [];
      for (var a = 0; a < d; a++) H.push(new Array(d).fill(0));
      for (var i = 0; i < n; i++) {
        var xi = X[i], z = offset ? offset[i] : 0;
        for (var j = 0; j < d; j++) z += beta[j] * xi[j];
        var p = sigmoid(z), wi = w ? w[i] : 1, r = wi * (p - y[i]), s = wi * p * (1 - p);
        for (var j2 = 0; j2 < d; j2++) {
          g[j2] += r * xi[j2];
          var sx = s * xi[j2];
          for (var k = 0; k <= j2; k++) H[j2][k] += sx * xi[k];
        }
      }
      for (var j3 = 0; j3 < d; j3++) for (var k2 = j3 + 1; k2 < d; k2++) H[j3][k2] = H[k2][j3];
      for (var j4 = 0; j4 < d; j4++) {
        var pen = j4 === 0 && !opts.penalizeIntercept ? 1e-9 : lambda;
        g[j4] += pen * beta[j4]; H[j4][j4] += pen + 1e-9;
      }
      var delta = solve(H, g);
      if (!delta) break;
      var maxStep = 0;
      for (var j5 = 0; j5 < d; j5++) {
        var st = clamp(delta[j5], -5, 5);
        beta[j5] -= st; maxStep = Math.max(maxStep, Math.abs(st));
      }
      if (maxStep < 1e-9) break;
    }
    return beta;
  }

  // ── metrics ──
  function pairsOf(rows, key) {
    key = key || "p";
    return (rows || []).filter(function(r) { return r && finite(r[key]) && (r.y === 0 || r.y === 1); })
      .map(function(r) { return { p: r[key], y: r.y, w: finite(r.w) ? r.w : 1 }; });
  }
  function logLoss(pairs) {
    var s = 0, W = 0;
    pairs.forEach(function(q) { var p = clampP(q.p), w = q.w == null ? 1 : q.w; s += -w * (q.y * Math.log(p) + (1 - q.y) * Math.log(1 - p)); W += w; });
    return W ? s / W : null;
  }
  function brier(pairs) {
    var s = 0, W = 0;
    pairs.forEach(function(q) { var w = q.w == null ? 1 : q.w; s += w * (q.p - q.y) * (q.p - q.y); W += w; });
    return W ? s / W : null;
  }
  // Calibration slope/intercept: logistic regression of the outcome on logit(p).
  // Slope 1 = calibrated; < 1 = overconfident; ~0 = confidence carries no signal.
  function calibrationFit(pairs) {
    if (pairs.length < 10) return { slope: null, intercept: null, slopeSE: null };
    var X = pairs.map(function(q) { return [1, logit(q.p)]; });
    var sd = 0, m = 0; X.forEach(function(x) { m += x[1]; }); m /= X.length;
    X.forEach(function(x) { sd += (x[1] - m) * (x[1] - m); });
    if (Math.sqrt(sd / X.length) < 1e-6) return { slope: null, intercept: null, slopeSE: null };
    var w = pairs.map(function(q) { return q.w == null ? 1 : q.w; });
    var b = fitLogistic(X, pairs.map(function(q) { return q.y; }), w, { iters: 50 });
    if (!b) return { slope: null, intercept: null, slopeSE: null };
    // standard error of the slope from the observed Fisher information
    var h00 = 0, h01 = 0, h11 = 0;
    X.forEach(function(x, i) { var p = sigmoid(b[0] + b[1] * x[1]), s = w[i] * p * (1 - p); h00 += s; h01 += s * x[1]; h11 += s * x[1] * x[1]; });
    var det = h00 * h11 - h01 * h01;
    return { slope: b[1], intercept: b[0], slopeSE: det > 0 ? Math.sqrt(h00 / det) : null };
  }
  var BUCKETS = [[0.5, 0.55], [0.55, 0.6], [0.6, 0.65], [0.65, 0.7], [0.7, 1.0001]];
  // Reliability in picked-side space (confidence >= 0.5), five buckets, matching
  // how the pick log reports confidence.
  function reliability(pairs) {
    var b = BUCKETS.map(function(r) { return { lo: r[0], hi: Math.min(1, r[1]), n: 0, sp: 0, sy: 0 }; });
    pairs.forEach(function(q) {
      var conf = Math.max(q.p, 1 - q.p), won = q.p >= 0.5 ? q.y : 1 - q.y;
      for (var i = 0; i < b.length; i++) if (conf >= BUCKETS[i][0] && conf < BUCKETS[i][1]) { b[i].n++; b[i].sp += conf; b[i].sy += won; break; }
    });
    return b.map(function(x) {
      return { lo: x.lo, hi: x.hi, n: x.n, predicted: x.n ? x.sp / x.n : null, actual: x.n ? x.sy / x.n : null,
        error: x.n ? x.sy / x.n - x.sp / x.n : null };
    });
  }
  function maxBucketError(buckets, minN) {
    minN = minN == null ? 30 : minN;
    var m = null;
    buckets.forEach(function(b) { if (b.n >= minN && b.error != null) m = Math.max(m == null ? 0 : m, Math.abs(b.error)); });
    return m;
  }
  function summarize(rows, key) {
    var pairs = pairsOf(rows, key);
    if (!pairs.length) return { n: 0, logLoss: null, brier: null, slope: null, intercept: null, slopeSE: null, accuracy: null, buckets: reliability([]), maxBucketError: null };
    var cf = calibrationFit(pairs), rel = reliability(pairs), correct = 0;
    pairs.forEach(function(q) { if ((q.p >= 0.5 ? 1 : 0) === q.y) correct++; });
    return { n: pairs.length, logLoss: logLoss(pairs), brier: brier(pairs), slope: cf.slope, intercept: cf.intercept, slopeSE: cf.slopeSE,
      accuracy: correct / pairs.length, buckets: rel, maxBucketError: maxBucketError(rel, 30) };
  }

  // ── calibrators ──
  // Hard caps (home-perspective p): the n<100 shrink regime and the drift
  // monitor's tightened state use the spec's caps; fitted calibrators get only
  // a sanity bound so they are not prevented from expressing real favorites.
  var DEFAULT_CAPS = { "shrink-fixed": [0.40, 0.62], fitted: [0.25, 0.75], tightened: [0.42, 0.60] };
  var FIXED_SHRINK = 0.5;
  // Platt/beta prior: CAL_PRIOR pseudo-observations centered on the ladder's
  // fixed 0.5 shrink (slope 0.5 on logit p) — without evidence, assume the raw
  // model is overconfident, as the audit showed; data overrides it quickly.
  var CAL_PRIOR = 10;
  var CAL_PRIOR_SLOPE = 0.5;

  function ladderMethod(n, bestMethod) {
    if (n < 100) return "shrink-fixed";
    if (n < 300) return "platt";
    return bestMethod || "isotonic";
  }
  function capFor(method, tightened) {
    if (tightened) return DEFAULT_CAPS.tightened.slice();
    return (method === "shrink-fixed" ? DEFAULT_CAPS["shrink-fixed"] : DEFAULT_CAPS.fitted).slice();
  }

  function fitIsotonic(pairs) {
    var sorted = pairs.slice().sort(function(a, b) { return a.p - b.p; });
    var blocks = [];
    sorted.forEach(function(q) {
      var w = q.w == null ? 1 : q.w;
      blocks.push({ sw: w, swy: w * q.y, swx: w * q.p });
      while (blocks.length > 1) {
        var b = blocks[blocks.length - 1], a = blocks[blocks.length - 2];
        if (a.swy / a.sw <= b.swy / b.sw) break;
        a.sw += b.sw; a.swy += b.swy; a.swx += b.swx; blocks.pop();
      }
    });
    // Pull small blocks toward the identity (pseudo-weight K), re-impose
    // monotonicity, then limit adjacent jumps to 5 points.
    var K = 5, knots = blocks.map(function(b) { var x = b.swx / b.sw; return { x: x, y: (b.swy + K * x) / (b.sw + K), w: b.sw + K }; });
    var pooled = [];
    knots.forEach(function(k) {
      pooled.push({ x: k.x * k.w, y: k.y * k.w, w: k.w });
      while (pooled.length > 1) {
        var b = pooled[pooled.length - 1], a = pooled[pooled.length - 2];
        if (a.y / a.w <= b.y / b.w) break;
        a.x += b.x; a.y += b.y; a.w += b.w; pooled.pop();
      }
    });
    knots = pooled.map(function(k) { return { x: k.x / k.w, y: k.y / k.w }; });
    for (var it = 0; it < 500; it++) {
      var moved = false;
      for (var i = 0; i + 1 < knots.length; i++) {
        var gap = knots[i + 1].y - knots[i].y;
        if (gap > 0.05 + 1e-12) { var ex = (gap - 0.05) / 2; knots[i].y += ex; knots[i + 1].y -= ex; moved = true; }
      }
      if (!moved) break;
    }
    return { knots: knots.map(function(k) { return [Number(k.x.toFixed(6)), Number(k.y.toFixed(6))]; }) };
  }
  function applyIsotonic(params, p) {
    var k = params.knots || [];
    if (!k.length) return p;
    if (p <= k[0][0]) return k[0][1];
    if (p >= k[k.length - 1][0]) return k[k.length - 1][1];
    for (var i = 0; i + 1 < k.length; i++) {
      if (p >= k[i][0] && p <= k[i + 1][0]) {
        var span = k[i + 1][0] - k[i][0];
        return span > 0 ? k[i][1] + (k[i + 1][1] - k[i][1]) * (p - k[i][0]) / span : k[i][1];
      }
    }
    return p;
  }

  function fitCalibrator(method, pairs) {
    if (method === "shrink-fixed" || !pairs.length) return { method: "shrink-fixed", params: { alpha: FIXED_SHRINK } };
    var y = pairs.map(function(q) { return q.y; }), w = pairs.map(function(q) { return q.w == null ? 1 : q.w; });
    if (method === "shrink") {
      var best = { alpha: 1, loss: Infinity };
      for (var a = 0.1; a <= 1.3001; a += 0.02) {
        var loss = logLoss(pairs.map(function(q) { return { p: 0.5 + a * (q.p - 0.5), y: q.y, w: q.w }; }));
        if (loss < best.loss) best = { alpha: Number(a.toFixed(2)), loss: loss };
      }
      return { method: "shrink", params: { alpha: best.alpha } };
    }
    // Platt and beta are fit as deviations from the prior map (offset =
    // CAL_PRIOR_SLOPE·logit p) with an L2 penalty, so a small or noisy window
    // cannot stretch the signal into an overconfident one.
    var offset = pairs.map(function(q) { return CAL_PRIOR_SLOPE * logit(q.p); });
    if (method === "platt") {
      var b = fitLogistic(pairs.map(function(q) { return [1, logit(q.p)]; }), y, w, { lambda: CAL_PRIOR, penalizeIntercept: true, offset: offset });
      return { method: "platt", params: { a: b ? b[0] : 0, b: b ? CAL_PRIOR_SLOPE + b[1] : CAL_PRIOR_SLOPE } };
    }
    if (method === "beta") {
      var bb = fitLogistic(pairs.map(function(q) { var p = clampP(q.p); return [1, Math.log(p), -Math.log(1 - p)]; }), y, w, { lambda: CAL_PRIOR, penalizeIntercept: true, offset: offset });
      if (!bb || CAL_PRIOR_SLOPE + bb[1] < 0 || CAL_PRIOR_SLOPE + bb[2] < 0) { var pl = fitCalibrator("platt", pairs); pl.fallbackFrom = "beta"; return pl; }
      return { method: "beta", params: { c: bb[0], a: CAL_PRIOR_SLOPE + bb[1], b: CAL_PRIOR_SLOPE + bb[2] } };
    }
    if (method === "isotonic") return { method: "isotonic", params: fitIsotonic(pairs) };
    throw new Error("unknown calibration method " + method);
  }

  function applyCalibrator(cal, p, cap) {
    if (!finite(p)) return null;
    var out;
    var m = cal && cal.method, pr = (cal && cal.params) || {};
    if (!cal || m === "shrink-fixed" || m === "shrink") out = 0.5 + (pr.alpha == null ? FIXED_SHRINK : pr.alpha) * (p - 0.5);
    else if (m === "platt") out = sigmoid(pr.a + pr.b * logit(p));
    else if (m === "beta") { var q = clampP(p); out = sigmoid(pr.c + pr.a * Math.log(q) - pr.b * Math.log(1 - q)); }
    else if (m === "isotonic") out = applyIsotonic(pr, p);
    else out = p;
    if (cap) out = clamp(out, cap[0], cap[1]);
    return clampP(out);
  }

  function blend(marketP, calP, w) {
    if (!finite(marketP)) return calP;
    return w * marketP + (1 - w) * calP;
  }

  // Market weight minimizing (weighted) log loss over rows that carry a market
  // probability and an out-of-sample calibrated model probability.
  function optimizeW(rows, lo, hi, step) {
    lo = lo == null ? 0.5 : lo; hi = hi == null ? 1 : hi; step = step || 0.05;
    var usable = rows.filter(function(r) { return finite(r.marketP) && finite(r.calP) && (r.y === 0 || r.y === 1); });
    if (usable.length < 30) return null;
    var best = { w: hi, loss: Infinity };
    for (var w = lo; w <= hi + 1e-9; w += step) {
      var loss = logLoss(usable.map(function(r) { return { p: blend(r.marketP, r.calP, w), y: r.y, w: finite(r.w) ? r.w : 1 }; }));
      if (loss < best.loss - 1e-12) best = { w: Number(w.toFixed(2)), loss: loss };
    }
    return best;
  }

  return {
    EPS: EPS, clamp: clamp, clampP: clampP, sigmoid: sigmoid, logit: logit, finite: finite,
    americanToImplied: americanToImplied, americanToDecimal: americanToDecimal, devig: devig,
    solve: solve, fitLogistic: fitLogistic,
    pairsOf: pairsOf, logLoss: logLoss, brier: brier, calibrationFit: calibrationFit,
    reliability: reliability, maxBucketError: maxBucketError, summarize: summarize, BUCKETS: BUCKETS,
    DEFAULT_CAPS: DEFAULT_CAPS, FIXED_SHRINK: FIXED_SHRINK, CAL_PRIOR: CAL_PRIOR, ladderMethod: ladderMethod, capFor: capFor,
    fitIsotonic: fitIsotonic, applyIsotonic: applyIsotonic, fitCalibrator: fitCalibrator, applyCalibrator: applyCalibrator,
    blend: blend, optimizeW: optimizeW
  };
});
