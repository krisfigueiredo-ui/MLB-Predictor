// Diamond Signal probability pipeline helpers. These functions are intentionally
// pure so the published model, shadow models, and tests use identical math.
(function(root, factory) {
  var mod = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = mod;
  for (var key in mod) root[key] = mod[key];
})(typeof globalThis !== "undefined" ? globalThis : this, function() {
  function clamp(value, lo, hi) {
    var n = Number(value);
    if (!isFinite(n)) return (lo + hi) / 2;
    return Math.max(lo, Math.min(hi, n));
  }

  function logitToProbability(logit) {
    var z = clamp(logit, -30, 30);
    return 1 / (1 + Math.exp(-z));
  }

  function calibrateProbability(rawProbability, alpha) {
    var raw = clamp(rawProbability, 0.001, 0.999);
    var a = isFinite(Number(alpha)) ? Number(alpha) : 1;
    return clamp(0.5 + a * (raw - 0.5), 0.001, 0.999);
  }

  function ensembleProbability(parts, weights) {
    parts = parts || {};
    weights = weights || {};
    var available = [];
    ["elo", "poisson", "feature"].forEach(function(name) {
      var p = Number(parts[name]);
      var w = Number(weights[name]);
      if (isFinite(p) && p > 0 && p < 1 && isFinite(w) && w > 0) {
        available.push({ name: name, p: p, w: w });
      }
    });
    if (!available.length) return 0.5;
    var totalWeight = available.reduce(function(sum, item) { return sum + item.w; }, 0);
    return clamp(available.reduce(function(sum, item) {
      return sum + item.p * item.w / totalWeight;
    }, 0), 0.001, 0.999);
  }

  function modelDispersion(parts) {
    var values = Object.keys(parts || {}).map(function(key) { return Number(parts[key]); })
      .filter(function(value) { return isFinite(value) && value > 0 && value < 1; });
    if (values.length < 2) return null;
    var mean = values.reduce(function(sum, value) { return sum + value; }, 0) / values.length;
    var variance = values.reduce(function(sum, value) {
      return sum + Math.pow(value - mean, 2);
    }, 0) / values.length;
    return Math.sqrt(variance);
  }

  function agreementLabel(dispersion) {
    if (dispersion == null || !isFinite(dispersion)) return "Unavailable";
    if (dispersion < 0.025) return "Strong";
    if (dispersion < 0.055) return "Moderate";
    return "Low";
  }

  function probabilityPipeline(parts, options) {
    options = options || {};
    var weights = options.weights || { elo: 0.2, poisson: 0.33, feature: 0.47 };
    var raw = ensembleProbability(parts, weights);
    var alpha = options.alpha == null ? 1 : options.alpha;
    var calibrated = calibrateProbability(raw, alpha);
    var dispersion = modelDispersion(parts);
    return {
      parts: Object.assign({}, parts),
      weights: Object.assign({}, weights),
      rawProbability: raw,
      calibratedProbability: calibrated,
      alpha: alpha,
      dispersion: dispersion,
      agreement: agreementLabel(dispersion)
    };
  }

  return {
    probabilityClamp: clamp,
    logitToProbability: logitToProbability,
    calibrateProbability: calibrateProbability,
    ensembleProbability: ensembleProbability,
    modelDispersion: modelDispersion,
    agreementLabel: agreementLabel,
    probabilityPipeline: probabilityPipeline
  };
});
