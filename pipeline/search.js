// Optimization loop over walk-forward log loss with a locked final holdout.
//   split:   the last 21 days of completed games are the holdout; the loop
//            never evaluates on, reports, or tunes against them.
//   search:  a grid round, then TPE-style rounds (sample each dimension from
//            the best quartile's values), 10 configs per round, logging every
//            config and its metrics to the experiments table.
//   stop:    3 consecutive rounds improving best log loss by < 0.001, or 200 configs.
//   select:  reject calibration slope outside 0.8–1.2; among configs within
//            0.002 log loss of the best, take the simplest.
//   final:   evaluate the one chosen config on the holdout, once.
"use strict";
const WF = require("./walkforward");
const M = require("./metrics");
const { addDays } = require("./store");

const SPACE = {
  featureSet: ["elo", "strength", "noElo", "full"],
  hl: [14, 21, 30, 45, 60],
  members: ["lr", "elo", "blend50", "blend75"],
  lambda: [1, 3, 10, 30, 100],
  trainHl: [0, 30, 60, 120],
  calMethod: ["shrink", "platt", "isotonic", "beta"],
  calWindow: [30, 45, 60, 90],
  w0: [0.5, 0.6, 0.7, 0.8, 0.9, 1.0]
};
const DEFAULT_CONFIG = { featureSet: "full", hl: 30, members: "blend75", lambda: 10, trainHl: 60, calMethod: "isotonic", calWindow: 60, w0: 0.7 };

function gridConfigs() {
  const out = [];
  for (const featureSet of ["strength", "full"]) for (const hl of [14, 30, 60]) for (const calMethod of ["platt", "isotonic"]) {
    out.push(Object.assign({}, DEFAULT_CONFIG, { featureSet, hl, calMethod }));
  }
  out.push(Object.assign({}, DEFAULT_CONFIG, { members: "elo", featureSet: "elo", calMethod: "platt" }));
  out.push(Object.assign({}, DEFAULT_CONFIG, { members: "lr", featureSet: "noElo" }));
  out.push(Object.assign({}, DEFAULT_CONFIG, { calMethod: "beta" }));
  out.push(Object.assign({}, DEFAULT_CONFIG, { calMethod: "shrink" }));
  out.push(Object.assign({}, DEFAULT_CONFIG, { calWindow: 30 }));
  out.push(Object.assign({}, DEFAULT_CONFIG, { calWindow: 90 }));
  out.push(Object.assign({}, DEFAULT_CONFIG, { w0: 1.0 }));
  out.push(Object.assign({}, DEFAULT_CONFIG, { w0: 0.5 }));
  return out;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

function splitDates(ctx) {
  const completed = ctx.games.filter(WF.isGraded).map(g => g.date);
  const last = completed.sort()[completed.length - 1];
  const holdoutStart = addDays(last, -20);
  return { lastCompleted: last, holdoutStart, tuningEnd: addDays(holdoutStart, -1) };
}

function objective(ev) {
  return { logLoss: ev.final.logLoss, brier: ev.final.brier, slope: ev.final.slope };
}

function evaluateConfig(ctx, config, range) {
  const wf = WF.runWalkForward(ctx, config, { toDate: range.tuningEnd, light: true });
  const tuningRows = wf.rows.filter(r => r.date <= range.tuningEnd);
  const ev = M.evaluateRows(tuningRows);
  const slope = ev.final.slope;
  const valid = slope != null && slope >= 0.8 && slope <= 1.2;
  return {
    version: wf.version, config, complexity: WF.complexity(config),
    metrics: { n: ev.n, logLoss: ev.final.logLoss, brier: ev.final.brier, slope, maxBucketError: ev.final.maxBucketError, accuracy: ev.final.accuracy,
      modelLogLoss: ev.model.logLoss, modelSlope: ev.model.slope, rawLogLoss: ev.raw.logLoss, rawSlope: ev.raw.slope,
      oddsN: ev.odds.n, finalLogLossOdds: ev.odds.final.logLoss, marketLogLossOdds: ev.odds.market.logLoss,
      modelLogLossOdds: ev.odds.model.logLoss },
    valid, rejectReason: valid ? null : "calibration slope " + slope + " outside 0.8–1.2"
  };
}

function select(experiments) {
  const valid = experiments.filter(e => e.valid && e.metrics.logLoss != null);
  if (!valid.length) return null;
  const best = Math.min(...valid.map(e => e.metrics.logLoss));
  const near = valid.filter(e => e.metrics.logLoss <= best + 0.002);
  near.sort((a, b) => a.complexity - b.complexity || a.metrics.logLoss - b.metrics.logLoss || a.metrics.brier - b.metrics.brier ||
    Math.abs(a.metrics.slope - 1) - Math.abs(b.metrics.slope - 1));
  return { chosen: near[0], bestLogLoss: best, nearCount: near.length };
}

function tpeSample(experiments, rand, seen) {
  const valid = experiments.filter(e => e.metrics.logLoss != null).sort((a, b) => a.metrics.logLoss - b.metrics.logLoss);
  const good = valid.slice(0, Math.max(3, Math.ceil(valid.length / 4)));
  for (let tries = 0; tries < 200; tries++) {
    const c = {};
    for (const dim of Object.keys(SPACE)) {
      const values = SPACE[dim];
      if (rand() < 0.8 && good.length) {
        const weights = values.map(v => 1 + 3 * good.filter(e => e.config[dim] === v).length);
        let t = rand() * weights.reduce((a, b) => a + b, 0), i = 0;
        while (t > weights[i]) { t -= weights[i]; i++; }
        c[dim] = values[Math.min(i, values.length - 1)];
      } else c[dim] = values[Math.floor(rand() * values.length)];
    }
    if (c.members === "elo") c.featureSet = "elo";
    const v = WF.configVersion(c);
    if (!seen[v]) { seen[v] = true; return c; }
  }
  return null;
}

function runSearch(ctx, opts) {
  opts = opts || {};
  const log = opts.log || (() => {});
  const range = splitDates(ctx);
  const maxConfigs = opts.maxConfigs || 200, roundSize = opts.roundSize || 10;
  const experiments = [], seen = {}, rounds = [];
  const rand = rng(opts.seed || 20260923);
  let best = Infinity, flat = 0, round = 0;

  const runRound = (configs, phase) => {
    for (const c of configs) {
      if (experiments.length >= maxConfigs) break;
      const v = WF.configVersion(c);
      seen[v] = true;
      const t0 = Date.now();
      const e = evaluateConfig(ctx, c, range);
      e.round = round; e.phase = phase; e.seconds = (Date.now() - t0) / 1000; e.evaluatedAt = new Date().toISOString();
      experiments.push(e);
      log(`[${phase} r${round}] ${e.version} LL=${e.metrics.logLoss} brier=${e.metrics.brier} slope=${e.metrics.slope} ${e.valid ? "" : "REJECTED"} ${JSON.stringify(c)}`);
    }
    const valid = experiments.filter(e => e.valid);
    const roundBest = valid.length ? Math.min(...valid.map(e => e.metrics.logLoss)) : Infinity;
    const improvement = best === Infinity ? null : best - roundBest;
    rounds.push({ round, phase, configs: experiments.length, bestLogLoss: roundBest === Infinity ? null : roundBest, improvement });
    if (phase !== "grid") flat = improvement != null && improvement < 0.001 ? flat + 1 : 0;
    best = Math.min(best, roundBest);
    round++;
  };

  const grid = gridConfigs().filter(c => { const v = WF.configVersion(c); if (seen[v]) return false; seen[v] = true; return true; });
  for (let i = 0; i < grid.length; i += roundSize) runRound(grid.slice(i, i + roundSize), "grid");
  let stopReason = null;
  while (experiments.length < maxConfigs) {
    if (flat >= 3) { stopReason = "3 consecutive rounds improved log loss by < 0.001"; break; }
    const batch = [];
    for (let i = 0; i < roundSize && experiments.length + batch.length < maxConfigs; i++) {
      const c = tpeSample(experiments, rand, seen);
      if (c) batch.push(c);
    }
    if (!batch.length) { stopReason = "search space exhausted"; break; }
    runRound(batch, "bayes");
  }
  if (!stopReason) stopReason = "reached " + maxConfigs + " configs";
  const sel = select(experiments);
  return { range, experiments, rounds, stopReason, selection: sel };
}

// The single holdout evaluation of the chosen config (walk-forward through the
// whole season; metrics restricted to holdout dates).
function holdoutEvaluation(ctx, config, range) {
  const wf = WF.runWalkForward(ctx, config, {});
  const tuning = wf.rows.filter(r => r.date < range.holdoutStart);
  const holdout = wf.rows.filter(r => r.date >= range.holdoutStart && r.date <= range.lastCompleted);
  return { wf, tuning: M.evaluateRows(tuning), holdout: M.evaluateRows(holdout) };
}

module.exports = { SPACE, DEFAULT_CONFIG, gridConfigs, splitDates, evaluateConfig, select, runSearch, holdoutEvaluation, objective };
