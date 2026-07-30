// Per-league model registry: train, predict, persist.
//
// Each league gets its own logistic model, because the same feature means
// different things in different sports -- a 0.2 Elo-diff edge is decisive in
// baseball and marginal in college basketball. Models are trained on the
// leak-free samples produced by ms-backtest.replay() and stored per league.
//
// The prediction path is a deliberate two-stage blend:
//   Elo prior  ->  logistic model on features  ->  logit-space blend
// with the model's weight scaled by how much held-out data actually backs it.
// An untrained or badly-performing model contributes nothing rather than
// quietly overriding the Elo prior.
// Exposed as MS.model in the browser and via module.exports under Node, so the
// nine modules never collide on the global scope.
(function(root, factory) {
  var mod = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = mod;
  }
  root.MS = root.MS || {};
  root.MS.model = mod;
})(typeof globalThis !== "undefined" ? globalThis : this, function() {

var STORE_KEY = "ms.models.v1";
var MIN_TRAIN = 60;      // below this, a fitted model is noise

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

// Train one league's model. `deps` carries the shared modules so this file has
// no import-time dependencies and stays unit-testable.
//   deps: { ml, backtest, ratings, calibration }
function trainLeagueModel(samples, league, deps, opts) {
  opts = opts || {};
  var ml = deps.ml, bt = deps.backtest;
  var feats = opts.features || deps.features.FEATURE_KEYS;
  var split = bt.splitDraws(samples);
  var usable = split.binary;

  if (usable.length < (opts.minTrain == null ? MIN_TRAIN : opts.minTrain)) {
    return {
      leagueId: league.id,
      trained: false,
      reason: "not enough graded games (" + usable.length + ")",
      n: usable.length,
      drawRate: split.drawRate
    };
  }

  var parts = bt.chronoSplit(usable, opts.trainFrac == null ? 0.75 : opts.trainFrac);
  // Standardization stats come from the training slice only. Fitting them on
  // everything leaks test-set information into training.
  var stats = ml.standardize(parts.train, feats);
  var fit = ml.fitLogisticRegression(parts.train, feats, stats.mean, stats.std, {
    lr: opts.lr == null ? 0.15 : opts.lr,
    lambda: opts.lambda == null ? 0.03 : opts.lambda,
    epochs: opts.epochs == null ? 500 : opts.epochs
  });

  var trainEval = ml.evaluateLogisticRegression(parts.train, feats, fit, stats.mean, stats.std);
  var testEval = parts.test.length
    ? ml.evaluateLogisticRegression(parts.test, feats, fit, stats.mean, stats.std)
    : null;

  // Walk-forward folds: the time-series analogue of cross-validation.
  var folds = bt.walkForwardFolds(usable, opts.folds == null ? 4 : opts.folds);
  var foldMetrics = folds.map(function(f) {
    var s = ml.standardize(f.train, feats);
    var m = ml.fitLogisticRegression(f.train, feats, s.mean, s.std, { epochs: 300, lr: 0.15, lambda: 0.03 });
    var e = ml.evaluateLogisticRegression(f.test, feats, m, s.mean, s.std);
    return { n: e.n, acc: e.acc, logloss: e.logloss, brier: e.brier };
  }).filter(function(m) { return m.n > 0; });

  var baseline = bt.baselineHome(parts.test.length ? parts.test : usable);
  var eloEval = bt.grade(parts.test.length ? parts.test : usable, function(s) { return s.eloPrior; });

  var auc = testEval ? ml.rocAUC(testEval.pairs) : null;
  // calibrationReport bins the range [0.5, 1], i.e. it expects the *picked
  // side's* confidence rather than a raw home-win probability. Feeding it raw
  // probabilities would dump every away-favoured game into the bottom bin, so
  // fold each pair onto the picked side first.
  var calib = (deps.calibration && testEval && testEval.pairs.length)
    ? deps.calibration.calibrationReport(toConfidencePairs(testEval.pairs), 1) : null;

  return {
    leagueId: league.id,
    trained: true,
    features: feats,
    w: fit.w,
    b: fit.b,
    mean: stats.mean,
    std: stats.std,
    lossCurve: fit.lossCurve,
    n: usable.length,
    nTrain: parts.train.length,
    nTest: parts.test.length,
    drawRate: split.drawRate,
    trainedAt: opts.now || new Date().toISOString(),
    metrics: {
      train: trainEval ? { n: trainEval.n, acc: trainEval.acc, logloss: trainEval.logloss, brier: trainEval.brier } : null,
      test: testEval ? { n: testEval.n, acc: testEval.acc, logloss: testEval.logloss, brier: testEval.brier } : null,
      auc: auc,
      folds: foldMetrics,
      foldMeanLogloss: foldMetrics.length
        ? foldMetrics.reduce(function(a, m) { return a + m.logloss; }, 0) / foldMetrics.length : null,
      baselineHomeRate: baseline.homeWinRate,
      eloOnly: eloEval ? { n: eloEval.n, acc: eloEval.acc, logloss: eloEval.logloss, brier: eloEval.brier } : null,
      calibration: calib ? { ece: calib.ece, brier: calib.brier, bss: calib.bss, sharpness: calib.sharpness,
                             optShrink: calib.optShrink, bins: calib.bins } : null
    },
    // Shrink factor suggested by held-out calibration; 1 = no shrink.
    shrink: calib && calib.optShrink ? clamp(calib.optShrink, 0.3, 1) : 1
  };
}

// Fold {p: home-win prob, y: home won} onto the picked side, so p is always a
// confidence in [0.5, 1] and y is whether that pick was right. Calibration is
// symmetric under this transform, and it is the form the shared calibration
// module bins for.
function toConfidencePairs(pairs) {
  return (pairs || []).map(function(d) {
    return d.p >= 0.5 ? { p: d.p, y: d.y } : { p: 1 - d.p, y: 1 - d.y };
  });
}

// Raw logistic score for a feature object.
function modelProb(feat, model, deps) {
  if (!model || !model.trained || !feat) return null;
  var feats = model.features;
  var z = model.b;
  for (var i = 0; i < feats.length; i++) {
    var f = feats[i];
    var mu = model.mean[f] == null ? 0 : model.mean[f];
    var sd = model.std[f] || 1;
    z += model.w[i] * (((feat[f] || 0) - mu) / sd);
  }
  return deps.ratings.logistic(z);
}

// How much to trust the trained model against the Elo prior. Weight grows with
// sample size and is zeroed out entirely if the model lost to Elo alone on
// held-out data -- an honest model has to earn its vote.
function modelWeight(model) {
  if (!model || !model.trained) return 0;
  var m = model.metrics || {};
  var test = m.test, elo = m.eloOnly;
  if (test && elo && test.logloss != null && elo.logloss != null && test.logloss > elo.logloss + 0.005) {
    return 0;
  }
  var n = model.nTrain || 0;
  return clamp(n / (n + 300), 0, 0.75);
}

// Full prediction for one upcoming (or live) game.
// Returns two-way probabilities always, plus three-way and goal markets for
// draw-capable sports, plus a market comparison when odds are present.
function predictGame(game, state, league, model, deps, opts) {
  opts = opts || {};
  var R = deps.ratings, F = deps.features;
  var home = game.home, away = game.away;
  if (!home || !away) return null;

  var neutral = !!(game.neutralSite || (game.venue && game.venue.neutral));
  var hfa = neutral ? 0 : (league.hfa || 0);
  var rh = F.rating(state, home.id), ra = F.rating(state, away.id);
  var eloProb = R.eloProb(rh, ra, hfa);

  var feat = F.buildFeatures(game, state, league);
  var mProb = modelProb(feat, model, deps);
  var mw = modelWeight(model);

  var blended = R.blendLogits([
    { p: eloProb, w: 1 - mw },
    { p: mProb, w: mw }
  ]);
  if (blended == null) blended = eloProb;
  if (model && model.shrink && model.shrink < 1) blended = R.shrink(blended, model.shrink);

  var out = {
    gameId: game.id,
    leagueId: league.id,
    kind: league.kind,
    ratings: { home: rh, away: ra, diff: (rh + hfa) - ra },
    eloProb: eloProb,
    modelProb: mProb,
    modelWeight: mw,
    homeWinProb: blended,
    awayWinProb: 1 - blended,
    features: feat,
    neutral: neutral,
    confidence: confidenceLabel(state, home.id, away.id, model)
  };

  // Draw-capable sports: convert the two-way probability into a three-way
  // outcome via Davidson, using an effective rating gap so the draw rate rises
  // for evenly-matched sides (which is what actually happens).
  if (league.kind === "draw") {
    var drawRate = (model && model.drawRate != null) ? model.drawRate
      : (opts.drawRate == null ? 0.26 : opts.drawRate);
    var nu = R.nuFromDrawRate(drawRate);
    var effDiff = 400 * Math.log10(Math.max(1e-9, blended) / Math.max(1e-9, 1 - blended));
    var three = R.davidson(1500 + effDiff, 1500, 0, nu);
    out.threeWay = three;
    out.drawProb = three.draw;
    // Goals model for totals / BTTS / correct score.
    var total = (opts.avgTotal != null && opts.avgTotal > 0) ? opts.avgTotal : league.expectedTotal;
    var lam = R.lambdasFromRatings(effDiff, total);
    out.goals = R.poissonMatrix(lam.home, lam.away, { rho: -0.05 });
  }

  // Market comparison, when ESPN carried a line.
  var market = game.odds ? R.marketProbs(game.odds) : null;
  if (market) {
    out.market = market;
    var modelHome = out.threeWay ? out.threeWay.home : blended;
    var modelAway = out.threeWay ? out.threeWay.away : (1 - blended);
    out.edges = [
      { side: "home", model: modelHome, fair: market.home, edge: market.home == null ? null : modelHome - market.home, ml: game.odds.homeML },
      { side: "away", model: modelAway, fair: market.away, edge: market.away == null ? null : modelAway - market.away, ml: game.odds.awayML }
    ];
    if (out.threeWay && market.draw != null) {
      out.edges.push({ side: "draw", model: out.threeWay.draw, fair: market.draw, edge: out.threeWay.draw - market.draw, ml: game.odds.drawML });
    }
    out.bestEdge = out.edges.reduce(function(best, e) {
      if (e.edge == null) return best;
      return (!best || e.edge > best.edge) ? e : best;
    }, null);
  }

  return out;
}

// Individual-sport prediction: tennis / MMA / boxing.
function predictDuel(game, state, league, deps, opts) {
  opts = opts || {};
  var R = deps.ratings, F = deps.features;
  var a = game.home, b = game.away;
  if (!a || !b) return null;
  var ra = F.rating(state, a.id), rb = F.rating(state, b.id);
  if (league.sport === "tennis") {
    var t = R.tennisFromRatings(ra, rb, {
      bestOf: opts.bestOf || (opts.grandSlam && league.slug === "atp" ? 5 : 3),
      baseServe: league.slug === "wta" ? 0.56 : 0.63
    });
    return {
      gameId: game.id, leagueId: league.id, kind: "duel",
      ratings: { home: ra, away: rb, diff: ra - rb },
      homeWinProb: t.match, awayWinProb: 1 - t.match,
      tennis: t,
      confidence: confidenceLabel(state, a.id, b.id, null)
    };
  }
  // MMA / boxing: no serve structure, so a plain Elo read is the honest model.
  var p = R.eloProb(ra, rb, 0);
  return {
    gameId: game.id, leagueId: league.id, kind: "duel",
    ratings: { home: ra, away: rb, diff: ra - rb },
    homeWinProb: p, awayWinProb: 1 - p,
    confidence: confidenceLabel(state, a.id, b.id, null)
  };
}

// Field events: golf and motorsport. Every entrant gets a win probability and
// a top-5/top-10 probability.
function predictField(game, state, league, deps, opts) {
  opts = opts || {};
  var R = deps.ratings, F = deps.features;
  var entrants = game.field || game.competitors || [];
  if (!entrants.length) return null;
  var ratings = entrants.map(function(e) { return F.rating(state, e.id); });
  var win = R.plackettLuceWin(ratings, { scale: opts.scale == null ? 120 : opts.scale });
  var top5 = R.fieldTopK(ratings, 5, { iters: opts.iters == null ? 1500 : opts.iters, seed: 42, scale: opts.scale == null ? 120 : opts.scale });
  var top10 = R.fieldTopK(ratings, 10, { iters: opts.iters == null ? 1500 : opts.iters, seed: 43, scale: opts.scale == null ? 120 : opts.scale });
  var rows = entrants.map(function(e, i) {
    return {
      id: e.id, name: e.name, shortName: e.shortName, logo: e.logo, flag: e.flag,
      rating: ratings[i], winProb: win[i], top5: top5[i], top10: top10[i],
      score: e.score, order: e.order
    };
  });
  rows.sort(function(x, y) { return y.winProb - x.winProb; });
  return {
    gameId: game.id, leagueId: league.id, kind: "field",
    entrants: rows,
    fieldSize: entrants.length
  };
}

// One entry point the UI calls regardless of sport.
function predict(game, state, league, model, deps, opts) {
  if (league.kind === "field" || game.isField) return predictField(game, state, league, deps, opts);
  if (league.kind === "duel") return predictDuel(game, state, league, deps, opts);
  return predictGame(game, state, league, model, deps, opts);
}

// How much history backs this particular matchup? Shown next to every pick so
// a prediction built on two games doesn't look like one built on two hundred.
function confidenceLabel(state, homeId, awayId, model) {
  var hn = (state.log[homeId] || []).length;
  var an = (state.log[awayId] || []).length;
  var min = Math.min(hn, an);
  var backed = model && model.trained;
  if (min === 0) return { level: "none", games: min, text: "No prior games in the loaded window" };
  if (min < 5) return { level: "low", games: min, text: min + " prior game" + (min === 1 ? "" : "s") + " loaded" };
  if (min < 15) return { level: "medium", games: min, text: min + " prior games loaded" + (backed ? ", model trained" : "") };
  return { level: "high", games: min, text: min + "+ prior games" + (backed ? ", model trained" : "") };
}

// ---- Persistence -----------------------------------------------------------
// Models are plain JSON; strip the bulky diagnostic arrays before saving so a
// hundred leagues don't blow the localStorage quota.
function serializeModel(model) {
  if (!model) return null;
  var out = {};
  Object.keys(model).forEach(function(k) {
    if (k === "lossCurve") return;
    out[k] = model[k];
  });
  if (out.metrics && out.metrics.calibration) {
    out.metrics = JSON.parse(JSON.stringify(out.metrics));
    delete out.metrics.calibration.bins;
  }
  return out;
}

function loadStore(storage) {
  try {
    var raw = storage.getItem(STORE_KEY);
    if (!raw) return {};
    var parsed = JSON.parse(raw);
    return (parsed && typeof parsed === "object") ? parsed : {};
  } catch (e) {
    return {};
  }
}

function saveModel(storage, model) {
  if (!model || !model.leagueId) return false;
  try {
    var store = loadStore(storage);
    store[model.leagueId] = serializeModel(model);
    storage.setItem(STORE_KEY, JSON.stringify(store));
    return true;
  } catch (e) {
    return false;
  }
}

function getModel(storage, leagueId) {
  var store = loadStore(storage);
  return store[leagueId] || null;
}

function clearModels(storage) {
  try { storage.removeItem(STORE_KEY); return true; } catch (e) { return false; }
}

return {
  STORE_KEY: STORE_KEY,
  MIN_TRAIN: MIN_TRAIN,
  trainLeagueModel: trainLeagueModel,
  toConfidencePairs: toConfidencePairs,
  modelProb: modelProb,
  modelWeight: modelWeight,
  predictGame: predictGame,
  predictDuel: predictDuel,
  predictField: predictField,
  predict: predict,
  confidenceLabel: confidenceLabel,
  serializeModel: serializeModel,
  loadStore: loadStore,
  saveModel: saveModel,
  getModel: getModel,
  clearModels: clearModels
};

});
