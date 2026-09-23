// Backfill report (markdown + json) and pick-log reconciliation.
"use strict";
const fs = require("fs");
const F = require("./features");
const { readJson, writeJson, paths, etDate } = require("./store");

const f4 = x => (x == null ? "—" : Number(x).toFixed(4));
const f3 = x => (x == null ? "—" : Number(x).toFixed(3));
const pct = x => (x == null ? "—" : (x * 100).toFixed(1) + "%");

function metricsRow(label, s, n) {
  return `| ${label} | ${n != null ? n : s.n} | ${f4(s.logLoss)} | ${f4(s.brier)} | ${f3(s.slope)} | ${s.maxBucketError == null ? "—" : pct(s.maxBucketError)} |`;
}

function oddsCoverage(ctx) {
  const byMonth = {};
  const list = [];
  ctx.games.filter(g => g.status === "final").forEach(g => {
    const m = ctx.market[g.id], month = g.date.slice(0, 6);
    const b = byMonth[month] || (byMonth[month] = { games: 0, open: 0, close: 0, anyPrice: 0, none: 0 });
    b.games++;
    const o = g.odds || {};
    if (o.open) b.open++;
    if (o.close) b.close++;
    if (m.marketP != null) b.anyPrice++; else b.none++;
    list.push({ gameId: g.id, date: g.date, matchup: `${g.away} @ ${g.home}`, open: !!o.open, close: !!o.close,
      listedOnly: !o.open && !o.close && !!o.listed, provider: m.provider, pickTiming: m.pick && m.pick.timing, closeTiming: m.close && m.close.timing });
  });
  return { byMonth, list };
}

function build({ ctx, search, chosen, hold, model, cov, s26, box, fallback }) {
  const t = hold.tuning, h = hold.holdout, st = model.autocal.current;
  const odds = oddsCoverage(ctx);
  const completed = ctx.games.filter(g => g.status === "final").length;
  const boxes = Object.values((box && box.games) || {}).filter(b => b.teams).length;
  const valid = search.experiments.filter(e => e.valid);
  const top = valid.slice().sort((a, b) => a.metrics.logLoss - b.metrics.logLoss).slice(0, 10);
  const nullFeatures = F.LIVE_ONLY.map(k => `\`${k}\``).join(", ");
  const oddsTotals = Object.values(odds.byMonth).reduce((a, b) => ({ games: a.games + b.games, open: a.open + b.open, close: a.close + b.close, anyPrice: a.anyPrice + b.anyPrice }), { games: 0, open: 0, close: 0, anyPrice: 0 });
  const edgeLL = h.odds.n ? h.odds.final.logLoss - h.odds.market.logLoss : null;
  const md = [];
  md.push(`# Backfill + optimization report`, ``, `Generated ${new Date().toISOString()} from ESPN's public API. Every metric below is walk-forward (trained only on games before each date).`, ``);
  md.push(`## Season coverage`, ``,
    `- Regular-season games in ESPN's schedule (to date, incl. upcoming): **${cov.season.scheduled}**`,
    `- Completed: **${completed}**; with a walk-forward prediction: **${cov.season.predicted}** (${pct(cov.season.predicted / Math.max(1, cov.season.completed))})`,
    `- Past games without a prediction (all with logged reasons): **${(cov.notPredicted || []).length}** — see \`coverage/coverage.json\``,
    `- Scoreboard dates that failed to fetch: **${(cov.fetchFailures || []).length}**`,
    `- Box scores parsed (for bullpen history): **${boxes}** of ${completed}`, ``);
  md.push(`## Historical odds`, ``, `| Month | Final games | With opening line | With closing line | Any real price |`, `|---|---|---|---|---|`);
  Object.keys(odds.byMonth).sort().forEach(m => { const b = odds.byMonth[m]; md.push(`| ${m} | ${b.games} | ${b.open} | ${b.close} | ${b.anyPrice} |`); });
  md.push(`| **Total** | ${oddsTotals.games} | ${oddsTotals.open} | ${oddsTotals.close} | ${oddsTotals.anyPrice} |`, ``,
    `Per-game availability is in \`coverage/odds.json\`. CLV needs both a pick-time (opening) and a closing price; ROI and the market blend use only games with a real price.`, ``);
  md.push(`## Features`, ``, ...Object.keys(F.FEATURE_SOURCES).map(k => `- \`${k}\`: ${F.FEATURE_SOURCES[k]}`), ``,
    `Null in every backfilled row (cannot be reconstructed as of pregame; not approximated): ${nullFeatures}. They are recorded on live \`frozen_pregame\` rows only and are not in the fitted model until enough live rows exist.`, ``);
  md.push(`## Optimization loop`, ``,
    `- Tuning set: season start → ${search.range.tuningEnd}; locked holdout: ${search.range.holdoutStart} → ${search.range.lastCompleted} (last 21 days)`,
    `- Configs tried: **${search.experiments.length}** in ${search.rounds.length} rounds; stop: ${search.stopReason}`,
    `- Rejected for calibration slope outside 0.8–1.2: ${search.experiments.length - valid.length}`,
    `- Winner: \`${chosen.version}\` \`${JSON.stringify(chosen.config)}\``,
    `- Why: ${fallback || `simplest config (complexity ${chosen.complexity}) within 0.002 of the best tuning log loss (${f4(search.selection.bestLogLoss)}); ${search.selection.nearCount} configs were in that band`}`, ``,
    `| Rank | Version | Tuning LL | Brier | Slope | Complexity | Config |`, `|---|---|---|---|---|---|---|`,
    ...top.map((e, i) => `| ${i + 1} | ${e.version} | ${f4(e.metrics.logLoss)} | ${f4(e.metrics.brier)} | ${f3(e.metrics.slope)} | ${e.complexity} | ${e.config.featureSet}/${e.config.members} hl=${e.config.hl} λ=${e.config.lambda} trainHl=${e.config.trainHl} ${e.config.calMethod} win=${e.config.calWindow} w0=${e.config.w0} |`), ``);
  md.push(`## Before / after (walk-forward, out of sample)`, ``,
    `"Before" = the raw ensemble probability with no calibration layer; "calibrated" = model after the auto-calibrator; "final" = market-anchored final_p. Market rows are restricted to games with a real price.`, ``);
  for (const [name, ev] of [["Tuning set", t], ["Locked holdout", h]]) {
    md.push(`### ${name}`, ``, `| Probability | n | Log loss | Brier | Slope | Max bucket err (n≥30) |`, `|---|---|---|---|---|---|`,
      metricsRow("raw (before)", ev.raw), metricsRow("calibrated model", ev.model), metricsRow("final_p", ev.final),
      metricsRow("final_p — games with odds", ev.odds.final), metricsRow("calibrated model — games with odds", ev.odds.model),
      metricsRow("**market baseline** — games with odds", ev.odds.market), ``,
      `CLV (all leans): ${ev.leans.avgClv == null ? "n/a" : (ev.leans.avgClv * 100).toFixed(2) + " pts"} over ${ev.leans.clvN} games · flagged bets: ${ev.bets.n}, ROI ${pct(ev.bets.roiFlat)} flat / ${pct(ev.bets.roiKelly)} Kelly-weighted, bet CLV ${ev.bets.avgClv == null ? "n/a" : (ev.bets.avgClv * 100).toFixed(2) + " pts"} (${ev.bets.clvN})`, ``);
  }
  md.push(`## Calibrator status`, ``,
    `- Method **${st.calibrator.method}**, n=${st.calibrator.n}, window ${st.calibrator.window}d, half-life ${st.calibrator.halfLife}d, fit ${st.calibrator.fitDate}`,
    `- Version cal-v${st.version} (${model.autocal.versions.length} versions kept), cap [${st.cap.join(", ")}], w=${st.w} (w* ${st.wOpt}), paused=${st.paused}, drift **${st.driftStatus}** ${st.driftReasons.length ? "(" + st.driftReasons.join("; ") + ")" : ""}`, ``);
  md.push(`## Edge vs the market`, ``);
  if (!h.odds.n) md.push(`No holdout game has a real ESPN price, so edge cannot be measured. Market-dependent metrics are not reported.`);
  else {
    const modelGap = h.odds.model.logLoss - h.odds.market.logLoss;
    const verdict = Math.abs(edgeLL) < 1e-4 ? "identical to the market: w was 1.0, so final_p is the market price" : edgeLL > 0 ? "worse than the market — w defaulted to 1.0" : "better than the market";
    md.push(`Holdout final_p log loss minus market log loss on ${h.odds.n} priced games: **${edgeLL > 0 ? "+" : ""}${edgeLL.toFixed(4)}** (${verdict}).`,
      ``, `The model on its own (calibrated, no market): ${f4(h.odds.model.logLoss)} vs market ${f4(h.odds.market.logLoss)} (${modelGap > 0 ? "+" : ""}${modelGap.toFixed(4)}; ${modelGap > 0 ? "the model alone is less accurate than the market" : "the model alone beats the market"}).`,
      ``, `Average CLV on holdout leans: ${h.leans.avgClv == null ? "n/a (no opening+closing pairs)" : (h.leans.avgClv * 100).toFixed(2) + " pts over " + h.leans.clvN + " games"}.`);
  }
  md.push(``);
  return { markdown: md.join("\n"), json: { range: search.range, configsTried: search.experiments.length, stopReason: search.stopReason, chosen: { version: chosen.version, config: chosen.config },
    tuning: t, holdout: h, oddsTotals, oddsByMonth: odds.byMonth, coverage: cov.season, calibrator: st }, odds };
}

function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const head = rows.shift() || [];
  return rows.filter(r => r.length > 1).map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

// Compare an exported pick log with ESPN's schedule: every missing completed
// game, counted by date, with the most specific reason we can infer.
function reconcile(dataDir, logFile, log) {
  const P = paths(dataDir);
  const s26 = readJson(P.games(2026));
  const text = fs.readFileSync(logFile, "utf8");
  let entries;
  if (/^\s*[{[]/.test(text)) {
    const j = JSON.parse(text);
    entries = (j.results || j).map(r => ({ gameId: String(r.gameId || r.gid || ""), firstPitch: r.firstPitch || Date.parse(r.date), away: r.away, home: r.home, recordType: r.status === "FROZEN" ? "frozen_pregame" : "verified_legacy" }));
  } else {
    entries = parseCsv(text).map(r => ({ gameId: String(r.game_id || ""), firstPitch: Date.parse(r.date), away: r.away, home: r.home, recordType: r.record_type }));
  }
  const games = Object.values(s26.games).filter(g => g.seasonType == null || g.seasonType === 2);
  const byId = {}, byKey = {};
  games.forEach(g => { byId[g.id] = g; const k = etDate(g.firstPitch) + g.away + g.home; (byKey[k] = byKey[k] || []).push(g); });
  const matched = {}, unmatched = [];
  entries.forEach(e => {
    let g = byId[e.gameId];
    if (!g && isFinite(e.firstPitch)) {
      const c = byKey[etDate(e.firstPitch) + e.away + e.home] || [];
      g = c.length === 1 ? c[0] : c.find(x => Math.abs(x.firstPitch - e.firstPitch) < 3 * 3600000);
    }
    if (g) matched[g.id] = e; else unmatched.push(e);
  });
  const pickedDates = {};
  Object.keys(matched).forEach(id => { pickedDates[byId[id].date] = (pickedDates[byId[id].date] || 0) + 1; });
  const missing = [], byDate = {};
  games.filter(g => g.status === "final" && !matched[g.id]).forEach(g => {
    const sameDay = games.filter(x => x.date === g.date);
    const dh = sameDay.filter(x => x.home === g.home && x.away === g.away).length > 1;
    const firstPickTs = Object.keys(matched).filter(id => byId[id].date === g.date).map(id => byId[id].firstPitch);
    let reason;
    const fetch = s26.fetchedDates && s26.fetchedDates[g.date];
    if (!pickedDates[g.date]) reason = "no picks logged that day: dashboard not open (no scheduler existed) or ESPN request failed in the browser";
    else if (dh) reason = "doubleheader: this game not matched (legacy logs keyed by date+teams can collapse both games into one)";
    else if (firstPickTs.length && g.firstPitch < Math.min(...firstPickTs)) reason = "started before the first pick of the day was logged (dashboard opened after first pitch)";
    else reason = "dashboard open that day but no final logged (tab closed before the game went final)";
    if (fetch && !fetch.ok) reason += "; pipeline fetch also failed: " + fetch.error;
    missing.push({ gameId: g.id, date: g.date, matchup: `${g.away} @ ${g.home}`, reason });
    const b = byDate[g.date] || (byDate[g.date] = { completed: 0, logged: 0, missing: 0 });
    b.missing++;
  });
  games.filter(g => g.status === "final").forEach(g => { const b = byDate[g.date] || (byDate[g.date] = { completed: 0, logged: 0, missing: 0 }); b.completed++; if (matched[g.id]) b.logged++; });
  const out = { generatedAt: new Date().toISOString(), logEntries: entries.length, matched: Object.keys(matched).length, unmatchedEntries: unmatched,
    completedGames: games.filter(g => g.status === "final").length, missingCount: missing.length, byDate, missing,
    postponedOrCanceled: games.filter(g => g.status === "postponed" || g.status === "canceled").map(g => ({ gameId: g.id, date: g.date, matchup: `${g.away} @ ${g.home}`, status: g.status })) };
  writeJson(require("path").join(dataDir, "coverage/reconcile.json"), out);
  log(`reconcile: ${out.matched}/${out.completedGames} completed games in the log; ${out.missingCount} missing; ${unmatched.length} log rows unmatched`);
  return out;
}

module.exports = { build, reconcile, parseCsv, oddsCoverage };
