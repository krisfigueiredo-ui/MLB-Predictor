#!/usr/bin/env node
// Usage:
//   node pipeline/cli.js backfill --data <dir> [--max-configs 200] [--skip-fetch]
//   node pipeline/cli.js live     --data <dir> [--skip-fetch] [--force-refit]
//   node pipeline/cli.js reconcile --data <dir> --log <pick-results.json|csv>
"use strict";
const fs = require("fs");
const path = require("path");
const AC = require("../js/engine/autocal");
const WF = require("./walkforward");
const S = require("./search");
const M = require("./metrics");
const COV = require("../js/engine/coverage");
const season = require("./season");
const live = require("./live");
const report = require("./report");
const { readJson, writeJson, paths, etDate } = require("./store");

function args() {
  const a = process.argv.slice(2), out = { _: [] };
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith("--")) { const k = a[i].slice(2); out[k] = a[i + 1] && !a[i + 1].startsWith("--") ? a[++i] : true; }
    else out._.push(a[i]);
  }
  return out;
}

const logLine = (...m) => console.log(new Date().toISOString(), ...m);

async function backfill(dataDir, opts) {
  const Pth = paths(dataDir);
  const today = opts.today || etDate(Date.now());
  const log = opts.log || logLine;
  if (!opts["skip-fetch"]) {
    await season.collect(dataDir, { year: 2025, from: "20250301", to: "20251005", boxes: false, coreOdds: false, refreshDays: 0, log });
    await season.collect(dataDir, { year: 2026, today, refreshDays: 2, log });
  }
  const s26 = readJson(Pth.games(2026)), s25 = readJson(Pth.games(2025), { games: {} }), box = readJson(Pth.box(2026), { games: {} });
  const ctx = WF.buildContext(s26, s25, box, S.SPACE.hl);
  log(`context: ${ctx.games.length} games, ${ctx.dates.length} dates, prior-season teams ${ctx.prior.teams}`);

  // Task 4: optimization loop (tuning set only; holdout locked)
  const search = S.runSearch(ctx, { maxConfigs: Number(opts["max-configs"] || 200), log });
  writeJson(Pth.experiments, { generatedAt: new Date().toISOString(), range: search.range, rounds: search.rounds,
    stopReason: search.stopReason, selection: search.selection && { version: search.selection.chosen.version, bestLogLoss: search.selection.bestLogLoss, nearCount: search.selection.nearCount },
    experiments: search.experiments }, false);
  let chosen = search.selection ? search.selection.chosen : null;
  let fallback = null;
  if (!chosen) {
    fallback = "no config met the 0.8–1.2 slope rule; using the lowest-log-loss config and w=1.0";
    chosen = search.experiments.slice().sort((a, b) => a.metrics.logLoss - b.metrics.logLoss)[0];
  }
  log(`chosen ${chosen.version} ${JSON.stringify(chosen.config)} after ${search.experiments.length} configs (${search.stopReason})`);

  // Final check: the chosen config, once, on the locked holdout
  const hold = S.holdoutEvaluation(ctx, chosen.config, search.range);
  const hOdds = hold.holdout.odds;
  const worseThanMarket = hOdds.n > 0 && hOdds.final.logLoss != null && hOdds.market.logLoss != null && hOdds.final.logLoss > hOdds.market.logLoss;
  const noMarket = hOdds.n === 0;
  let state = hold.wf.state;
  if (worseThanMarket || fallback) {
    state = JSON.parse(JSON.stringify(state));
    state.current.w = 1.0;
    state.log.push({ at: new Date().toISOString(), event: "holdout-market-default", detail: worseThanMarket ? "holdout log loss worse than the market-only baseline: w defaulted to 1.0" : fallback });
    state.current.version++; state.versions.push(JSON.parse(JSON.stringify(state.current)));
  }
  const model = {
    schema: 1, config: chosen.config, configVersion: chosen.version, autocal: state,
    holdout: { range: search.range, metrics: hold.holdout, worseThanMarket, noMarket, evaluatedAt: new Date().toISOString() },
    tuning: hold.tuning, search: { configsTried: search.experiments.length, stopReason: search.stopReason, rounds: search.rounds.length },
    lightSearch: { at: new Date().toISOString(), evaluated: 0, promoted: false, note: "initial full search" },
    updatedAt: new Date().toISOString()
  };
  const rows = hold.wf.rows.filter(r => r.y != null);
  writeJson(Pth.backfill, { schema: 1, source: "backfill_walkforward", configVersion: chosen.version, generatedAt: new Date().toISOString(), rows }, false);
  writeJson(Pth.state, model);

  // coverage
  const ids = {}; rows.forEach(r => { ids[r.gameId] = true; });
  const cov = readJson(Pth.coverage, { alerts: [], runs: [] });
  cov.season = COV.seasonCoverage(ctx.games, ids);
  cov.notPredicted = ctx.games.filter(g => g.status !== "final" || !ids[g.id]).filter(g => g.date < today)
    .map(g => ({ gameId: g.id, date: g.date, matchup: `${g.away} @ ${g.home}`, status: g.status, reason: reasonFor(g, ids) }));
  cov.fetchFailures = Object.entries(s26.fetchedDates || {}).filter(([, f]) => !f.ok).map(([d, f]) => ({ date: d, error: f.error }));
  writeJson(Pth.coverage, cov);
  live.writeMetrics(Pth, rows, readJson(Pth.picks, { picks: {} }), state, model, cov, Date.now());

  const rep = report.build({ ctx, search, chosen, hold, model, cov, s26, box, fallback });
  writeJson(path.join(dataDir, "coverage/odds.json"), { generatedAt: new Date().toISOString(), byMonth: rep.odds.byMonth, games: rep.odds.list }, false);
  fs.writeFileSync(Pth.report, rep.markdown);
  writeJson(Pth.reportJson, rep.json);
  log("report written:\n" + rep.markdown);
  return { model, rows, cov, report: rep };
}

function reasonFor(g, ids) {
  if (g.status === "postponed") return "postponed (not played on this date)";
  if (g.status === "canceled") return "canceled";
  if (g.status === "suspended") return "suspended, not yet completed";
  if (g.status === "final" && g.hs === g.as) return "final with tied/void score in ESPN feed";
  if (g.status !== "final") return "ESPN status '" + g.status + "' (" + (g.statusDetail || "no detail") + ")";
  if (!ids[g.id]) return "no walk-forward prediction produced";
  return null;
}

async function main() {
  const a = args();
  const cmd = a._[0];
  const dataDir = path.resolve(a.data || "pipeline-data/data");
  if (cmd === "backfill") return backfill(dataDir, a);
  if (cmd === "live") return live.runLive(dataDir, { skipFetch: !!a["skip-fetch"], forceRefit: !!a["force-refit"], log: logLine });
  if (cmd === "reconcile") return report.reconcile(dataDir, a.log, logLine);
  console.error("usage: cli.js backfill|live|reconcile --data <dir>");
  process.exit(2);
}

if (require.main === module) main().catch(err => { console.error(err && err.stack || err); process.exit(1); });

module.exports = { backfill };
