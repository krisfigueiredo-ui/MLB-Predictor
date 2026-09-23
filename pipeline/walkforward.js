// Walk-forward engine: for each date D, train only on games completed before
// D, refit the calibrator (same autocal state machine the live system runs)
// on walk-forward predictions graded before D, then predict D. Every number
// this produces is out of sample by construction.
"use strict";
const P = require("../js/engine/probability");
const AC = require("../js/engine/autocal");
const EV = require("../js/engine/ev");
const F = require("./features");
const crypto = require("crypto");

const DAY = 86400000;

function configVersion(config) {
  const keys = ["featureSet", "hl", "members", "lambda", "trainHl", "calMethod", "calWindow", "w0"];
  const canon = JSON.stringify(keys.map(k => config[k]));
  return "cfg-" + crypto.createHash("sha1").update(canon).digest("hex").slice(0, 8);
}

function complexity(config) {
  const cal = { shrink: 1, platt: 2, beta: 3, isotonic: 5 }[config.calMethod] || 3;
  const nFeat = config.members === "elo" ? 1 : F.FEATURE_SETS[config.featureSet].length;
  return nFeat + cal + (/^blend/.test(config.members) ? 1 : 0) + (config.trainHl ? 0.5 : 0);
}

// Market lines for a game, labeled by timing. The pick-time line is the
// earliest real pregame price we have; the close is ESPN's closing line (or
// the last price it listed before first pitch). Null when ESPN has none.
function marketFor(g) {
  const o = g.odds || {};
  const pre = g.pregameOdds && g.pregameOdds.capturedAt < g.firstPitch ? g.pregameOdds : null;
  const preLine = pre && (pre.odds.current || pre.odds.listed);
  let pick = null, close = null;
  if (o.open) pick = { homeML: o.open.home, awayML: o.open.away, timing: "open" };
  else if (preLine) pick = { homeML: preLine.home, awayML: preLine.away, timing: "pregame-capture", capturedAt: pre.capturedAt };
  if (o.close) close = { homeML: o.close.home, awayML: o.close.away, timing: "close" };
  else if (o.listed && g.status === "final") close = { homeML: o.listed.home, awayML: o.listed.away, timing: "last-listed" };
  else if (preLine) close = { homeML: preLine.home, awayML: preLine.away, timing: "last-pregame-capture" };
  if (!pick && close) pick = Object.assign({}, close, { timing: close.timing + " (no earlier price)" });
  const fair = pick && P.devig(pick.homeML, pick.awayML);
  return { pick, close, marketP: fair ? fair.home : null, provider: o.provider || null };
}

function buildContext(season2026, season2025, box, hls) {
  const games = Object.values(season2026.games || {}).filter(g => g.seasonType == null || g.seasonType === 2)
    .sort((a, b) => a.firstPitch - b.firstPitch || String(a.id).localeCompare(String(b.id)));
  const built = F.buildFeatures(games, season2025 ? season2025.games : {}, (box && box.games) || {}, hls);
  const market = {};
  games.forEach(g => { market[g.id] = marketFor(g); });
  const dates = Array.from(new Set(games.map(g => g.date))).sort();
  return { games, frames: built.features, prior: built.prior, market, dates, hls };
}

function isGraded(g) { return g.status === "final" && g.hs != null && g.as != null && g.hs !== g.as; }

function weightedStandardize(X, w) {
  const d = X[0].length, mean = new Array(d).fill(0), sd = new Array(d).fill(0);
  let W = 0;
  X.forEach((x, i) => { W += w[i]; x.forEach((v, j) => { mean[j] += w[i] * v; }); });
  for (let j = 0; j < d; j++) mean[j] /= W;
  X.forEach((x, i) => x.forEach((v, j) => { sd[j] += w[i] * (v - mean[j]) * (v - mean[j]); }));
  for (let j = 0; j < d; j++) sd[j] = Math.sqrt(sd[j] / W) || 1;
  return { mean, sd };
}

function runWalkForward(ctx, config, opts) {
  opts = opts || {};
  const minTrain = opts.minTrain || 150;
  const names = F.FEATURE_SETS[config.featureSet];
  const version = configVersion(config);
  const modelConfig = Object.assign({ version }, config);
  let state = opts.initialState || AC.initialState({ w0: config.w0, window: config.calWindow, modelConfig });
  const rows = [], graded = [];
  let beta = null, trainPtr = 0;
  const train = [];
  const toDate = opts.toDate || ctx.dates[ctx.dates.length - 1];
  const vec = g => F.vector(F.featureRecord(ctx.frames, g.id, config.hl), names);
  const eloOf = g => ctx.frames[g.id].shared.elo.v;
  const gradedGames = ctx.games.filter(isGraded);

  for (const D of ctx.dates) {
    if (D > toDate) break;
    const dayGames = ctx.games.filter(g => g.date === D && (g.status === "final" || g.status === "scheduled" || g.status === "in"));
    while (trainPtr < gradedGames.length && gradedGames[trainPtr].date < D) train.push(gradedGames[trainPtr++]);
    if (!dayGames.length) continue;
    const now = Math.min(...dayGames.map(g => g.firstPitch)) - 60000;
    const dayMs = AC.ymdToMs(D);

    // home-field prior: home win rate in training games, shrunk toward 0.54
    const homeWins = train.reduce((s, g) => s + (g.hs > g.as ? 1 : 0), 0);
    const hfa = P.logit((homeWins + 0.54 * 200) / (train.length + 200));

    let lr = null;
    if (config.members !== "elo" && train.length >= minTrain) {
      const X = train.map(vec);
      const w = train.map(g => (config.trainHl ? Math.pow(0.5, (dayMs - AC.ymdToMs(g.date)) / DAY / config.trainHl) : 1));
      const st = weightedStandardize(X, w);
      const Z = X.map(x => [1].concat(x.map((v, j) => (v - st.mean[j]) / st.sd[j])));
      const y = train.map(g => (g.hs > g.as ? 1 : 0));
      beta = P.fitLogistic(Z, y, w, { lambda: config.lambda, init: beta && beta.length === names.length + 1 ? beta : null, iters: 30 });
      lr = { beta, st };
    }

    state = AC.refit(state, graded, { now, asOfDate: D, window: config.calWindow, halfLife: 21, bestMethod: config.calMethod, modelConfig });

    for (const g of dayGames) {
      const eloLogit = eloOf(g) + hfa;
      let logit;
      if (!lr) logit = eloLogit;
      else {
        const x = vec(g), z = lr.beta[0] + x.reduce((s, v, j) => s + lr.beta[j + 1] * (v - lr.st.mean[j]) / lr.st.sd[j], 0);
        const a = config.members === "lr" ? 1 : config.members === "blend50" ? 0.5 : config.members === "blend75" ? 0.75 : 0;
        logit = a * z + (1 - a) * eloLogit;
      }
      const rawP = P.sigmoid(logit);
      const m = ctx.market[g.id];
      const pred = AC.predict(state, rawP, m.marketP);
      const row = {
        gameId: g.id, date: g.date, firstPitch: g.firstPitch, home: g.home, away: g.away,
        source: "backfill_walkforward", rawP: +rawP.toFixed(5), calP: +pred.calP.toFixed(5),
        marketP: m.marketP == null ? null : +m.marketP.toFixed(5), finalP: +pred.finalP.toFixed(5),
        w: pred.w, paused: pred.paused, calibratorVersion: pred.calibratorVersion, modelConfigVersion: version,
        burnIn: !lr, trainN: train.length,
        y: isGraded(g) ? (g.hs > g.as ? 1 : 0) : null
      };
      if (!opts.light) {
        const rec = F.featureRecord(ctx.frames, g.id, config.hl);
        row.features = {};
        Object.keys(rec).forEach(k => { row.features[k] = [rec[k].v == null ? null : +Number(rec[k].v).toFixed(5), rec[k].asOf]; });
        row.nullFeatures = Object.keys(rec).filter(k => rec[k].v == null);
        row.hs = g.hs; row.as = g.as; row.market = m;
        const bet = EV.evaluateBet({ finalP: pred.finalP, homeML: m.pick && m.pick.homeML, awayML: m.pick && m.pick.awayML, paused: pred.paused, bankroll: 1 });
        row.bet = { flag: bet.flag, side: bet.side, edge: bet.edge == null ? null : +bet.edge.toFixed(4), stakeFraction: +bet.stakeFraction.toFixed(4), reason: bet.reason };
        const leanSide = m.marketP == null ? null : pred.finalP >= m.marketP ? "home" : "away";
        const clvOk = m.pick && m.close && !/no earlier price/.test(m.pick.timing);
        row.clv = clvOk && leanSide ? EV.clv(leanSide, m.pick.homeML, m.pick.awayML, m.close.homeML, m.close.awayML) : null;
        row.betClv = clvOk && bet.flag ? EV.clv(bet.side, m.pick.homeML, m.pick.awayML, m.close.homeML, m.close.awayML) : null;
        if (bet.flag && row.y != null) {
          const won = (bet.side === "home") === (row.y === 1);
          row.pnl = { units: EV.profitPerUnit(won, bet.side === "home" ? m.pick.homeML : m.pick.awayML), stakeFraction: bet.stakeFraction };
        }
      }
      rows.push(row);
    }
    dayGames.forEach((g, i) => { const r = rows[rows.length - dayGames.length + i]; if (r.y != null) graded.push(r); });
  }
  return { rows, state, version };
}

module.exports = { runWalkForward, buildContext, configVersion, complexity, marketFor, isGraded };
