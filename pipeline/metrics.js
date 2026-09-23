// Out-of-sample metrics for walk-forward/frozen rows, always reported next to
// the "take the market favorite at the market probability" baseline.
"use strict";
const P = require("../js/engine/probability");

function r(x, d) { return x == null || !isFinite(x) ? null : Number(x.toFixed(d == null ? 4 : d)); }
function compact(s) {
  return { n: s.n, logLoss: r(s.logLoss), brier: r(s.brier), slope: r(s.slope, 3), intercept: r(s.intercept, 3), accuracy: r(s.accuracy),
    maxBucketError: r(s.maxBucketError), buckets: s.buckets.map(b => ({ range: [b.lo, +b.hi.toFixed(2)], n: b.n, predicted: r(b.predicted), actual: r(b.actual), error: r(b.error) })) };
}

function evaluateRows(rows) {
  const graded = rows.filter(x => x.y === 0 || x.y === 1);
  const odds = graded.filter(x => x.marketP != null);
  const sum = (arr, key) => compact(P.summarize(arr.map(x => ({ p: x[key], y: x.y }))));
  const bets = graded.filter(x => x.bet && x.bet.flag && x.pnl);
  const units = bets.reduce((s, x) => s + x.pnl.units, 0);
  const kellyStake = bets.reduce((s, x) => s + x.pnl.stakeFraction, 0);
  const kellyPnl = bets.reduce((s, x) => s + x.pnl.units * x.pnl.stakeFraction, 0);
  const clvRows = graded.filter(x => x.clv != null), betClv = graded.filter(x => x.betClv != null);
  const mean = (arr, k) => (arr.length ? arr.reduce((s, x) => s + x[k], 0) / arr.length : null);
  return {
    n: graded.length,
    final: sum(graded, "finalP"), model: sum(graded, "calP"), raw: sum(graded, "rawP"),
    odds: { n: odds.length, final: sum(odds, "finalP"), model: sum(odds, "calP"), raw: sum(odds, "rawP"), market: sum(odds, "marketP") },
    bets: { n: bets.length, units: r(units, 3), roiFlat: bets.length ? r(units / bets.length) : null,
      roiKelly: kellyStake > 0 ? r(kellyPnl / kellyStake) : null, bankrollReturn: r(kellyPnl),
      avgClv: r(mean(betClv, "betClv"), 5), clvN: betClv.length },
    leans: { clvN: clvRows.length, avgClv: r(mean(clvRows, "clv"), 5) }
  };
}

// Daily rolling (trailing `days`) Brier/log loss for model and market baselines.
function rollingSeries(rows, days) {
  const graded = rows.filter(x => x.y === 0 || x.y === 1).sort((a, b) => a.firstPitch - b.firstPitch);
  const dates = Array.from(new Set(graded.map(x => x.date))).sort();
  const DAY = 86400000;
  return dates.map(d => {
    const end = Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)) + DAY;
    const win = graded.filter(x => x.firstPitch < end + 6 * 3600000 && x.firstPitch >= end - days * DAY);
    const odds = win.filter(x => x.marketP != null);
    const pp = k => win.map(x => ({ p: x[k], y: x.y })), po = k => odds.map(x => ({ p: x[k], y: x.y }));
    return { date: d, n: win.length, brier: r(P.brier(pp("finalP"))), logLoss: r(P.logLoss(pp("finalP"))),
      oddsN: odds.length, brierOdds: odds.length ? r(P.brier(po("finalP"))) : null, marketBrier: odds.length ? r(P.brier(po("marketP"))) : null,
      logLossOdds: odds.length ? r(P.logLoss(po("finalP"))) : null, marketLogLoss: odds.length ? r(P.logLoss(po("marketP"))) : null };
  });
}

module.exports = { evaluateRows, rollingSeries, compact };
