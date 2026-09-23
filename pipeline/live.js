// Live runner (GitHub Actions, every ~10 minutes). Idempotent:
//   1. refresh ESPN schedule/scores/odds (+ box scores for new finals);
//   2. grade frozen picks (result, closing line, CLV, P&L);
//   3. once per day after the previous day is graded (or when the last fit is
//      >24h old): rerun the season walk-forward, refit the calibrator through
//      the promotion gate + drift monitor, and weekly run the light search;
//   4. freeze a `frozen_pregame` pick for every game inside the freeze window;
//   5. coverage check: alert on any game without a pick 15 min before first pitch;
//   6. write today.json / picks.json / metrics.json / model_state.json.
"use strict";
const P = require("../js/engine/probability");
const AC = require("../js/engine/autocal");
const EV = require("../js/engine/ev");
const COV = require("../js/engine/coverage");
const F = require("./features");
const WF = require("./walkforward");
const M = require("./metrics");
const S = require("./search");
const season = require("./season");
const espn = require("./espn");
const { readJson, writeJson, paths, etDate, addDays } = require("./store");

const FREEZE_LEAD_MS = 90 * 60000;
const DAY = 86400000;

function isTerminal(g) { return g.status === "final" || g.status === "postponed" || g.status === "canceled"; }

function currentLine(g, now) {
  const o = g.odds || {};
  const line = o.current || o.listed;
  if (!line || !(g.oddsCapturedAt < g.firstPitch) || !(now < g.firstPitch)) return null;
  return { homeML: line.home, awayML: line.away, provider: o.provider || null, capturedAt: new Date(g.oddsCapturedAt).toISOString() };
}

function closingLine(g) {
  const o = g.odds || {};
  if (o.close) return { homeML: o.close.home, awayML: o.close.away, source: "espn-close" };
  const pre = g.pregameOdds && g.pregameOdds.capturedAt < g.firstPitch ? g.pregameOdds : null;
  const l = pre && (pre.odds.current || pre.odds.listed);
  if (l) return { homeML: l.home, awayML: l.away, source: "last-pregame-capture", capturedAt: new Date(pre.capturedAt).toISOString() };
  if (o.listed && g.status === "final") return { homeML: o.listed.home, awayML: o.listed.away, source: "espn-last-listed" };
  return null;
}

function gradePicks(picks, games) {
  let graded = 0;
  Object.values(picks).forEach(p => {
    if (p.result) return;
    const g = games[p.gameId];
    if (!g || !WF.isGraded(g)) {
      if (g && (g.status === "postponed" || g.status === "canceled")) p.voided = g.status;
      return;
    }
    const y = g.hs > g.as ? 1 : 0;
    p.result = { hs: g.hs, as: g.as, y, gradedAt: new Date().toISOString() };
    p.y = y;
    p.close = closingLine(g);
    if (p.pickOdds && p.close) {
      const lean = p.marketP == null ? null : p.finalP >= p.marketP ? "home" : "away";
      p.clv = lean ? EV.clv(lean, p.pickOdds.homeML, p.pickOdds.awayML, p.close.homeML, p.close.awayML) : null;
      if (p.bet && p.bet.flag) p.betClv = EV.clv(p.bet.side, p.pickOdds.homeML, p.pickOdds.awayML, p.close.homeML, p.close.awayML);
    }
    if (p.bet && p.bet.flag) {
      const won = (p.bet.side === "home") === (y === 1);
      p.pnl = { units: EV.profitPerUnit(won, p.bet.price), stakeFraction: p.bet.stakeFraction };
    }
    graded++;
  });
  return graded;
}

// Rows the calibrator learns from: live frozen picks take precedence over the
// backfilled walk-forward row for the same game; never both.
function calibrationRows(backfillRows, picks) {
  const byId = {};
  backfillRows.forEach(r => { if (r.y != null) byId[r.gameId] = r; });
  Object.values(picks).forEach(p => { if (p.y != null) byId[p.gameId] = p; });
  return Object.values(byId);
}

function lightSearch(ctx, model, experiments, state, now, log) {
  const valid = experiments.filter(e => e.valid && e.phase !== "weekly").sort((a, b) => a.metrics.logLoss - b.metrics.logLoss);
  const seen = {}, top = [];
  for (const e of valid) { if (!seen[e.version]) { seen[e.version] = 1; top.push(e.config); } if (top.length >= 10) break; }
  if (!seen[model.configVersion]) top.push(model.config);
  const cutoff = now - 14 * DAY;
  const results = top.map(config => {
    const wf = WF.runWalkForward(ctx, config, { light: true });
    const recent = wf.rows.filter(r => r.y != null && r.firstPitch >= cutoff && r.firstPitch < now);
    const ll = P.logLoss(recent.map(r => ({ p: r.finalP, y: r.y })));
    const all = M.evaluateRows(wf.rows);
    return { version: wf.version, config, recentLogLoss: ll, recentN: recent.length, seasonLogLoss: all.final.logLoss, slope: all.final.slope };
  });
  const incumbent = results.find(r => r.version === model.configVersion);
  const candidates = results.filter(r => r.version !== model.configVersion && r.slope != null && r.slope >= 0.8 && r.slope <= 1.2)
    .sort((a, b) => a.recentLogLoss - b.recentLogLoss);
  const best = candidates[0];
  const promote = best && incumbent && best.recentLogLoss < incumbent.recentLogLoss;
  results.forEach(r => experiments.push({ version: r.version, config: r.config, complexity: WF.complexity(r.config), phase: "weekly",
    evaluatedAt: new Date(now).toISOString(), valid: r.slope != null && r.slope >= 0.8 && r.slope <= 1.2,
    metrics: { logLoss: r.seasonLogLoss, slope: r.slope, recentLogLoss14: r.recentLogLoss, recentN: r.recentN } }));
  const summary = { at: new Date(now).toISOString(), evaluated: results.length, incumbent: incumbent && incumbent.version,
    incumbentRecentLogLoss: incumbent && incumbent.recentLogLoss, best: best && best.version, bestRecentLogLoss: best && best.recentLogLoss, promoted: !!promote };
  if (promote) {
    model.config = best.config; model.configVersion = best.version;
    state.log.push({ at: summary.at, event: "config-promoted", detail: `${best.version} beat ${incumbent.version} on last-14-day log loss (${best.recentLogLoss.toFixed(4)} vs ${incumbent.recentLogLoss.toFixed(4)})` });
  } else {
    state.log.push({ at: summary.at, event: "config-kept", detail: `weekly light search: incumbent ${model.configVersion} kept` });
  }
  log(`light search: ${JSON.stringify(summary)}`);
  return summary;
}

async function runLive(dataDir, opts) {
  opts = opts || {};
  const log = opts.log || console.log;
  const now = opts.now || Date.now();
  const today = etDate(now);
  const Pth = paths(dataDir);

  // 1. refresh
  let collected;
  if (opts.skipFetch) collected = { season: readJson(Pth.games(2026)), box: readJson(Pth.box(2026), { games: {} }) };
  else collected = await season.collect(dataDir, { year: 2026, today, refreshDays: 1, log });
  const s26 = collected.season, box = collected.box;
  const s25 = readJson(Pth.games(2025), { games: {} });
  const games = s26.games;

  // pregame lineups for games inside the freeze window, captured before first pitch
  if (!opts.skipFetch) {
    for (const g of Object.values(games)) {
      if (g.status !== "scheduled" || g.pregameLineups || now >= g.firstPitch || now < g.firstPitch - 3 * 3600000) continue;
      try {
        const lu = espn.parsePregameLineups(await espn.summary(g.id));
        if (lu) g.pregameLineups = { lineups: lu, capturedAt: Date.now() };
      } catch (e) { /* lineup not posted / unavailable: stays null */ }
    }
    writeJson(Pth.games(2026), s26, false);
  }

  const model = readJson(Pth.state, null);
  if (!model) throw new Error("no model_state.json — run `node pipeline/cli.js backfill` first");
  let state = model.autocal;
  const picks = readJson(Pth.picks, { schema: 1, picks: {} });
  const experiments = readJson(Pth.experiments, { experiments: [] });
  const coverage = readJson(Pth.coverage, { alerts: [], runs: [] });

  // 2. grade
  const newlyGraded = gradePicks(picks.picks, games);

  // 3. daily refit (+ weekly light search)
  const ctx = WF.buildContext(s26, s25, box, [model.config.hl]);
  const yesterdayDone = Object.values(games).filter(g => g.date === addDays(today, -1)).every(isTerminal);
  const due = state.current.lastRefitDate !== today && (yesterdayDone || AC.needsRefit(state, now));
  let wf = WF.runWalkForward(ctx, model.config, {});
  if (due || opts.forceRefit) {
    if (!model.lightSearch || now - Date.parse(model.lightSearch.at) >= 7 * DAY) {
      model.lightSearch = lightSearch(WF.buildContext(s26, s25, box, S.SPACE.hl), model, experiments.experiments, state, now, log);
      writeJson(Pth.experiments, experiments, false);
      if (model.lightSearch.promoted) {
        const ctx2 = WF.buildContext(s26, s25, box, [model.config.hl]);
        wf = WF.runWalkForward(ctx2, model.config, {});
      }
    }
    const backfill = wf.rows.filter(r => r.y != null);
    writeJson(Pth.backfill, { schema: 1, source: "backfill_walkforward", configVersion: wf.version, generatedAt: new Date(now).toISOString(), rows: backfill }, false);
    const cfg = Object.assign({ version: model.configVersion }, model.config);
    state = AC.refit(state, calibrationRows(backfill, picks.picks), { now, asOfDate: today, window: model.config.calWindow, halfLife: 21, bestMethod: model.config.calMethod, modelConfig: cfg });
    log(`refit: ${state.current.calibrator.method} n=${state.current.calibrator.n} w=${state.current.w} drift=${state.current.driftStatus}`);
  }

  // 4. today's predictions + freezing
  const rowsById = {};
  wf.rows.forEach(r => { rowsById[r.gameId] = r; });
  const upcoming = Object.values(games).filter(g => g.date >= today && g.date <= addDays(today, 1)).sort((a, b) => a.firstPitch - b.firstPitch);
  const board = [];
  let frozen = 0;
  for (const g of upcoming) {
    const wfRow = rowsById[g.id];
    const line = currentLine(g, now);
    const fair = line && P.devig(line.homeML, line.awayML);
    const pred = wfRow ? AC.predict(state, wfRow.rawP, fair ? fair.home : null) : null;
    const bet = pred ? EV.evaluateBet({ finalP: pred.finalP, homeML: line && line.homeML, awayML: line && line.awayML, paused: pred.paused, bankroll: 1 }) : null;
    const pick = picks.picks[g.id];
    board.push({ gameId: g.id, date: g.date, firstPitch: g.firstPitch, home: g.home, away: g.away, status: g.status,
      rawP: pred && pred.rawP, calP: pred && pred.calP, marketP: pred && pred.marketP, finalP: pred && pred.finalP, w: pred && pred.w,
      paused: pred && pred.paused, bet: bet && { flag: bet.flag, side: bet.side, edge: bet.edge, stakeFraction: bet.stakeFraction, reason: bet.reason },
      frozen: !!pick, frozenFinalP: pick ? pick.finalP : null, frozenRawP: pick ? pick.rawP : null, frozenMarketP: pick ? pick.marketP : null,
      frozenPaused: pick ? pick.paused : null, frozenBet: pick ? pick.bet : null, odds: line });
    if (!pick && pred && g.status === "scheduled" && now < g.firstPitch && now >= g.firstPitch - FREEZE_LEAD_MS) {
      const rec = F.featureRecord(ctx.frames, g.id, model.config.hl);
      const feats = {};
      Object.keys(rec).forEach(k => { feats[k] = { v: rec[k].v, asOf: rec[k].asOf, src: rec[k].src }; });
      picks.picks[g.id] = {
        gameId: g.id, date: g.date, firstPitch: g.firstPitch, home: g.home, away: g.away, source: "frozen_pregame",
        frozenAt: now, rawP: +pred.rawP.toFixed(5), calP: +pred.calP.toFixed(5), marketP: pred.marketP == null ? null : +pred.marketP.toFixed(5),
        finalP: +pred.finalP.toFixed(5), w: pred.w, paused: pred.paused,
        pickOdds: line, modelConfigVersion: model.configVersion, calibratorVersion: pred.calibratorVersion,
        bet: bet && { flag: bet.flag, side: bet.side, edge: bet.edge, stakeFraction: bet.stakeFraction, price: bet.price || null, reason: bet.reason },
        starters: g.probables ? { home: g.probables.home, away: g.probables.away, capturedAt: g.probables.capturedAt } : null,
        lineupsPosted: !!g.pregameLineups, features: feats, y: null, result: null
      };
      frozen++;
    }
  }

  // 5. coverage
  const fetchErrors = {};
  Object.entries(s26.fetchedDates || {}).forEach(([d, f]) => { if (!f.ok) fetchErrors[d] = f.error; });
  const lastRun = coverage.runs.length ? coverage.runs[coverage.runs.length - 1].at : null;
  const todays = Object.values(games).filter(g => g.date === today || g.date === addDays(today, -1));
  const alerts = COV.coverageCheck(todays, picks.picks, now, { lastRunAt: lastRun, apiErrors: fetchErrors });
  const known = {};
  coverage.alerts.forEach(a => { known[a.gameId + a.severity] = true; });
  alerts.forEach(a => { if (!known[a.gameId + a.severity]) coverage.alerts.push(a); });
  coverage.alerts = coverage.alerts.slice(-500);
  coverage.runs.push({ at: new Date(now).toISOString(), frozen, graded: newlyGraded, alerts: alerts.length });
  coverage.runs = coverage.runs.slice(-300);
  const bfIds = {};
  wf.rows.forEach(r => { if (r.y != null) bfIds[r.gameId] = true; });
  coverage.season = COV.seasonCoverage(Object.values(games), bfIds);
  coverage.season.frozenPregame = Object.values(picks.picks).length;

  // 6. write
  model.autocal = state;
  model.updatedAt = new Date(now).toISOString();
  writeJson(Pth.picks, picks, false);
  writeJson(Pth.coverage, coverage);
  writeJson(Pth.state, model);
  const liveAlerts = alerts.filter(a => a.date === today || now - a.firstPitch < DAY);
  writeJson(Pth.today, { generatedAt: new Date(now).toISOString(), date: today, paused: state.current.paused,
    banner: state.current.paused ? "MODEL PAUSED — no edge" : null, driftStatus: state.current.driftStatus,
    configVersion: model.configVersion, calibratorVersion: AC.calibratorVersion(state), w: state.current.w,
    games: board, alerts: liveAlerts });
  writeMetrics(Pth, wf.rows.filter(r => r.y != null), picks, state, model, coverage, now);
  log(`live: froze ${frozen}, graded ${newlyGraded}, alerts ${alerts.length}`);
  return { frozen, graded: newlyGraded, alerts, state };
}

function writeMetrics(Pth, backfillRows, picks, state, model, coverage, now) {
  const frozenRows = Object.values(picks.picks).filter(p => p.y != null);
  const cur = state.current;
  writeJson(Pth.metrics, {
    generatedAt: new Date(now).toISOString(),
    baseline: "market favorite at the de-vigged market probability (games with real odds only)",
    frozen_pregame: { overall: M.evaluateRows(frozenRows), rolling14: M.rollingSeries(frozenRows, 14).slice(-60) },
    backfill_walkforward: { overall: M.evaluateRows(backfillRows), rolling14: M.rollingSeries(backfillRows, 14) },
    coverage: coverage.season,
    status: {
      configVersion: model.configVersion, config: model.config, calibratorVersion: AC.calibratorVersion(state),
      method: cur.calibrator.method, n: cur.calibrator.n, lastFit: cur.calibrator.fitDate, lastRefit: cur.lastRefit,
      w: cur.w, wOpt: cur.wOpt, cap: cur.cap, paused: cur.paused, driftStatus: cur.driftStatus, driftReasons: cur.driftReasons,
      drift: cur.metrics, versions: state.versions.map(v => ({ version: v.version, method: v.calibrator.method, n: v.calibrator.n, w: v.w, fitDate: v.calibrator.fitDate, paused: v.paused })),
      log: state.log.slice(-25), holdout: model.holdout || null, lightSearch: model.lightSearch || null
    }
  });
}

module.exports = { runLive, gradePicks, calibrationRows, closingLine, currentLine, writeMetrics, FREEZE_LEAD_MS };
