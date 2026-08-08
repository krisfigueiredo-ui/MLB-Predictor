// Rolling-origin evaluation and prior-only calibration. Randomized CV remains
// available in the legacy teaching view, but this module is the primary QA path.
(function(root, factory) {
  var deps = {};
  if (typeof module !== "undefined" && module.exports) {
    deps.ml = require("../ml-train");
    deps.calibration = require("../calibration");
    deps.pipeline = require("./pipeline");
    module.exports = factory(deps);
  } else {
    deps.ml = root;
    deps.calibration = root;
    deps.pipeline = root;
    var mod = factory(deps);
    for (var key in mod) root[key] = mod[key];
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function(deps) {
  function gameTime(game) {
    var value = game && (game.firstPitch || game.timestamp || game.ts || game.d || game.date);
    if (typeof value === "number") return value;
    if (/^\d{8}$/.test(value || "")) {
      return Date.UTC(+value.slice(0, 4), +value.slice(4, 6) - 1, +value.slice(6, 8));
    }
    var parsed = Date.parse(value || "");
    return isFinite(parsed) ? parsed : 0;
  }

  function chronological(games) {
    return (games || []).map(function(game, index) {
      return { game: game, index: index, time: gameTime(game) };
    }).sort(function(a, b) {
      return a.time - b.time || a.index - b.index;
    }).map(function(item) { return item.game; });
  }

  function rollingOriginSplits(games, options) {
    options = options || {};
    var ordered = chronological(games);
    var minTrain = Math.max(2, options.minTrain == null ? 60 : options.minTrain);
    var testSize = Math.max(1, options.testSize == null ? 20 : options.testSize);
    var step = Math.max(1, options.step == null ? testSize : options.step);
    var splits = [];
    for (var cutoff = minTrain; cutoff < ordered.length; cutoff += step) {
      var testEnd = Math.min(ordered.length, cutoff + testSize);
      if (testEnd <= cutoff) break;
      var train = ordered.slice(0, cutoff);
      var test = ordered.slice(cutoff, testEnd);
      splits.push({
        train: train,
        test: test,
        trainingCutoff: gameTime(train[train.length - 1]),
        testStart: gameTime(test[0]),
        testEnd: gameTime(test[test.length - 1])
      });
      if (testEnd === ordered.length) break;
    }
    return splits;
  }

  function binaryPairs(rows, probabilityKey) {
    return (rows || []).map(function(row) {
      var p = Number(row[probabilityKey]);
      var y = row.y != null ? Number(row.y) : row.actualHome === true ? 1 : row.actual === "home" ? 1 : 0;
      return { p: Math.max(0.001, Math.min(0.999, p)), y: y };
    }).filter(function(pair) { return isFinite(pair.p) && (pair.y === 0 || pair.y === 1); });
  }

  function metricsForPairs(pairs) {
    if (!pairs.length) return { n: 0, accuracy: null, brier: null, logLoss: null, auc: null, ece: null };
    var correct = 0, brier = 0, logLoss = 0;
    pairs.forEach(function(pair) {
      if ((pair.p >= 0.5 ? 1 : 0) === pair.y) correct++;
      brier += Math.pow(pair.p - pair.y, 2);
      logLoss += -(pair.y * Math.log(pair.p) + (1 - pair.y) * Math.log(1 - pair.p));
    });
    var report = deps.calibration.calibrationReport(pairs, 1);
    return {
      n: pairs.length,
      accuracy: correct / pairs.length,
      brier: brier / pairs.length,
      logLoss: logLoss / pairs.length,
      auc: deps.ml.rocAUC(pairs),
      ece: report ? report.ece : null
    };
  }

  function fitPriorShrinkage(priorRows, probabilityKey, options) {
    options = options || {};
    var minGames = options.minGames == null ? 30 : options.minGames;
    var pairs = binaryPairs(priorRows, probabilityKey);
    if (pairs.length < minGames) return { alpha: 1, n: pairs.length, fitted: false, objective: null };
    var best = { alpha: 1, objective: Infinity };
    for (var alpha = 0.3; alpha <= 1.3001; alpha += 0.02) {
      var loss = 0;
      pairs.forEach(function(pair) {
        var p = deps.pipeline.calibrateProbability(pair.p, alpha);
        loss += -(pair.y * Math.log(p) + (1 - pair.y) * Math.log(1 - p));
      });
      loss /= pairs.length;
      if (loss < best.objective) best = { alpha: Math.round(alpha * 100) / 100, objective: loss };
    }
    return { alpha: best.alpha, n: pairs.length, fitted: true, objective: best.objective };
  }

  function applyPriorOnlyCalibration(rows, probabilityKey, options) {
    options = options || {};
    var ordered = chronological(rows);
    return ordered.map(function(row, index) {
      var prior = ordered.slice(0, index);
      var fit = fitPriorShrinkage(prior, probabilityKey, options);
      var copy = Object.assign({}, row);
      copy.calibrationAlpha = fit.alpha;
      copy.calibrationTrainingN = fit.n;
      copy.calibratedProbability = deps.pipeline.calibrateProbability(row[probabilityKey], fit.alpha);
      return copy;
    });
  }

  function walkForwardLogistic(games, features, options) {
    options = options || {};
    var usable = chronological(games).filter(function(game) {
      return game && game.feat && (game.y === 0 || game.y === 1);
    });
    var splits = rollingOriginSplits(usable, options);
    var predictions = [], foldSummaries = [];
    splits.forEach(function(split, foldIndex) {
      var stats = deps.ml.standardize(split.train, features);
      var model = deps.ml.fitLogisticRegression(split.train, features, stats.mean, stats.std, options.fit);
      var evaluated = deps.ml.evaluateLogisticRegression(split.test, features, model, stats.mean, stats.std);
      evaluated.pairs.forEach(function(pair, index) {
        predictions.push({
          p: pair.p,
          y: pair.y,
          fold: foldIndex,
          firstPitch: gameTime(split.test[index]),
          trainingCutoff: split.trainingCutoff
        });
      });
      foldSummaries.push(Object.assign({
        fold: foldIndex,
        trainN: split.train.length,
        testN: split.test.length,
        trainingCutoff: split.trainingCutoff,
        testStart: split.testStart,
        testEnd: split.testEnd
      }, metricsForPairs(evaluated.pairs)));
    });
    return {
      method: "rolling-origin",
      n: predictions.length,
      folds: foldSummaries,
      predictions: predictions,
      metrics: metricsForPairs(predictions)
    };
  }

  function featureAblation(games, features, options) {
    var baseline = walkForwardLogistic(games, features, options);
    return features.map(function(feature) {
      var reduced = features.filter(function(item) { return item !== feature; });
      var result = walkForwardLogistic(games, reduced, options);
      return {
        feature: feature,
        n: result.metrics.n,
        deltaLogLoss: result.metrics.logLoss == null || baseline.metrics.logLoss == null ? null : result.metrics.logLoss - baseline.metrics.logLoss,
        deltaBrier: result.metrics.brier == null || baseline.metrics.brier == null ? null : result.metrics.brier - baseline.metrics.brier,
        deltaAccuracy: result.metrics.accuracy == null || baseline.metrics.accuracy == null ? null : result.metrics.accuracy - baseline.metrics.accuracy
      };
    });
  }

  return {
    walkForwardGameTime: gameTime,
    chronologicalGames: chronological,
    rollingOriginSplits: rollingOriginSplits,
    binaryPairs: binaryPairs,
    metricsForPairs: metricsForPairs,
    fitPriorShrinkage: fitPriorShrinkage,
    applyPriorOnlyCalibration: applyPriorOnlyCalibration,
    walkForwardLogistic: walkForwardLogistic,
    featureAblationWalkForward: featureAblation
  };
});
