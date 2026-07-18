// Core machine-learning primitives behind the "Model Training" tab: feature
// standardization, batch logistic regression via gradient descent, held-out
// evaluation, and the classifier-quality metrics (ROC-AUC, ROC curve,
// confusion matrix / precision / recall / F1). Pulled out of the inline
// script so this numerical code -- previously 100% untested -- is unit
// tested independent of the localStorage-backed backtest store.
(function(root, factory) {
  var mod = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = mod;
  }
  for (var k in mod) root[k] = mod[k];
})(typeof globalThis !== "undefined" ? globalThis : this, function() {

function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }

// Deterministic LCG (glibc-constants) PRNG + in-place Fisher-Yates shuffle.
// Same seed always produces the same shuffle -- reproducible CV folds/splits.
function seededShuffle(arr, seed) {
  var s = seed == null ? 12345 : seed;
  function rnd() { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }
  var out = arr.slice();
  for (var i = out.length - 1; i > 0; i--) {
    var q = Math.floor(rnd() * (i + 1));
    var t = out[i]; out[i] = out[q]; out[q] = t;
  }
  return out;
}

// Per-feature mean/std over a set of graded games' feature vectors (games[i].feat[f]).
// A feature that's constant across every game gets std=1 (not 0) so downstream
// division never blows up -- it just standardizes to a constant 0.
function standardize(games, feats) {
  var mean = {}, std = {};
  feats.forEach(function(f) {
    var vals = games.map(function(g) { return g.feat[f] || 0; });
    var m = vals.reduce(function(s, v) { return s + v; }, 0) / vals.length;
    var vr = vals.reduce(function(s, v) { return s + (v - m) * (v - m); }, 0) / vals.length;
    mean[f] = m; std[f] = Math.sqrt(vr) || 1;
  });
  return { mean: mean, std: std };
}

function featureVector(g, feats, mean, std) {
  return feats.map(function(f) { return ((g.feat[f] || 0) - mean[f]) / std[f]; });
}

// Batch logistic regression via full-batch gradient descent with L2 (ridge)
// regularization. `mean`/`std` MUST be fit on the training set only -- passing
// standardization stats derived from data outside `games` leaks test-set
// information into training.
function fitLogisticRegression(games, feats, mean, std, opts) {
  opts = opts || {};
  var lr = opts.lr == null ? 0.1 : opts.lr;
  var lambda = opts.lambda == null ? 0.02 : opts.lambda;
  var epochs = opts.epochs == null ? 400 : opts.epochs;
  var nF = feats.length;
  var w = new Array(nF).fill(0), b = 0;
  var lossCurve = [];
  for (var ep = 0; ep < epochs; ep++) {
    var gw = new Array(nF).fill(0), gb = 0, loss = 0;
    games.forEach(function(g) {
      var x = featureVector(g, feats, mean, std), z = b;
      for (var j = 0; j < nF; j++) z += w[j] * x[j];
      var p = sigmoid(z), y = g.y;
      var err = p - y;
      for (var j2 = 0; j2 < nF; j2++) gw[j2] += err * x[j2];
      gb += err;
      var pc = Math.min(1 - 1e-9, Math.max(1e-9, p));
      loss += -(y * Math.log(pc) + (1 - y) * Math.log(1 - pc));
    });
    for (var j3 = 0; j3 < nF; j3++) { w[j3] -= lr * (gw[j3] / games.length + lambda * w[j3]); }
    b -= lr * (gb / games.length);
    if (ep % 20 === 0 || ep === epochs - 1) lossCurve.push(loss / games.length);
  }
  return { w: w, b: b, lossCurve: lossCurve };
}

function evaluateLogisticRegression(games, feats, model, mean, std) {
  var correct = 0, brier = 0, logloss = 0, pairs = [];
  games.forEach(function(g) {
    var x = featureVector(g, feats, mean, std), z = model.b;
    for (var j = 0; j < feats.length; j++) z += model.w[j] * x[j];
    var p = sigmoid(z), y = g.y;
    if ((p >= 0.5 ? 1 : 0) === y) correct++;
    brier += (p - y) * (p - y);
    var pc = Math.min(1 - 1e-9, Math.max(1e-9, p));
    logloss += -(y * Math.log(pc) + (1 - y) * Math.log(1 - pc));
    pairs.push({ p: p, y: y });
  });
  return { n: games.length, acc: correct / games.length, brier: brier / games.length, logloss: logloss / games.length, pairs: pairs };
}

// Convert standardized weights back to raw-feature weights so predictFull can
// use them directly: z = b + sum(w_j*(x_j-mean_j)/std_j)
// => rawWeight_j = w_j/std_j, with the residual (-w_j*mean_j/std_j) folded
// into a global intercept. `hfaKey`'s raw feature is a constant 1 for every
// game (predictFull's r.hfa=1), so it standardizes to a constant 0 and never
// receives direct gradient signal -- the model's intercept is folded into it
// instead, which is exactly how a bias term for "this team is home" should work.
function toRawWeights(w, b, feats, mean, std, hfaKey) {
  var learned = {}, intercept = b;
  feats.forEach(function(f, j) {
    if (f === hfaKey) { learned[hfaKey] = w[j] / std[f]; }
    else { learned[f] = w[j] / std[f]; intercept -= w[j] * mean[f] / std[f]; }
  });
  learned[hfaKey] = (learned[hfaKey] || 0) + intercept;
  return learned;
}

// ROC-AUC: probability the model ranks a random actual-win above a random loss
// (equivalent to the Mann-Whitney U statistic).
function rocAUC(pairs) {
  var pos = [], neg = [];
  pairs.forEach(function(d) { (d.y === 1 ? pos : neg).push(d.p); });
  if (!pos.length || !neg.length) return null;
  var c = 0;
  for (var i = 0; i < pos.length; i++) {
    for (var j = 0; j < neg.length; j++) {
      if (pos[i] > neg[j]) c += 1; else if (pos[i] === neg[j]) c += 0.5;
    }
  }
  return c / (pos.length * neg.length);
}

// ROC curve points: sweep the decision threshold high->low over pooled predictions.
function rocCurve(pairs) {
  var pos = 0, neg = 0; pairs.forEach(function(d) { if (d.y === 1) pos++; else neg++; });
  if (!pos || !neg) return [];
  var sorted = pairs.slice().sort(function(a, b) { return b.p - a.p; });
  var tp = 0, fp = 0, pts = [{ fpr: 0, tpr: 0 }];
  sorted.forEach(function(d) { if (d.y === 1) tp++; else fp++; pts.push({ fpr: fp / neg, tpr: tp / pos }); });
  return pts;
}

// Confusion matrix + precision/recall/F1 at a 0.5 decision threshold.
function confusionMatrixStats(pairs) {
  var TP = 0, FP = 0, TN = 0, FN = 0;
  pairs.forEach(function(d) {
    var pred = d.p >= 0.5 ? 1 : 0;
    if (pred === 1 && d.y === 1) TP++;
    else if (pred === 1 && d.y === 0) FP++;
    else if (pred === 0 && d.y === 0) TN++;
    else FN++;
  });
  var precision = TP + FP > 0 ? TP / (TP + FP) : 0;
  var recall = TP + FN > 0 ? TP / (TP + FN) : 0;
  var f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
  return { TP: TP, FP: FP, TN: TN, FN: FN, precision: precision, recall: recall, f1: f1 };
}

return {
  sigmoid: sigmoid,
  seededShuffle: seededShuffle,
  standardize: standardize,
  featureVector: featureVector,
  fitLogisticRegression: fitLogisticRegression,
  evaluateLogisticRegression: evaluateLogisticRegression,
  toRawWeights: toRawWeights,
  rocAUC: rocAUC,
  rocCurve: rocCurve,
  confusionMatrixStats: confusionMatrixStats
};

});
