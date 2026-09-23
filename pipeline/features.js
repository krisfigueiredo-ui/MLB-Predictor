// Point-in-time feature builder. Games are processed in first-pitch order and
// every feature for a game is computed from team/pitcher state that only
// contains games that STARTED EARLIER (a team's previous game necessarily
// finished before its next began). Each value carries `asOf` — the latest
// source timestamp it depends on — so the leakage test can assert
// asOf < firstPitch for every feature of every row, backfilled or live.
"use strict";

const DAY = 86400000;
const HFA_ELO = 24, ELO_K = 4;

const FEATURE_SOURCES = {
  elo: "derived: Elo ratings from ESPN final scores (2025 season + 2026 games before first pitch)",
  rd: "derived: recency-weighted run differential per game from ESPN final scores before first pitch (half-life tuned)",
  wp: "derived: recency-weighted win% from ESPN final scores before first pitch (half-life tuned)",
  rest: "ESPN schedule: days since each team's previous game (capped at 3)",
  bp3: "ESPN box scores of earlier games: bullpen innings pitched over the previous 3 days",
  sept: "calendar: September roster-expansion flag",
  septRd: "interaction: September flag × recency-weighted run differential",
  spRa9: "live only: ESPN pregame probable starter × his earned runs per 9 in earlier ESPN box scores (regressed)",
  spPc: "live only: ESPN pregame probable starter × his mean pitch count over his last 3 starts",
  rested: "live only: regulars (most starts in the prior 14 days) missing from ESPN's posted pregame lineup"
};
// Features that cannot be reconstructed for past games (no pregame snapshot of
// probables/lineups exists): always null in backfilled rows, never approximated.
const LIVE_ONLY = ["spRa9", "spPc", "rested"];

const FEATURE_SETS = {
  elo: ["elo"],
  strength: ["elo", "rd", "wp"],
  noElo: ["rd", "wp", "rest", "bp3"],
  full: ["elo", "rd", "wp", "rest", "bp3", "sept", "septRd"]
};

function daysBetween(a, b) {
  const ms = s => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  return Math.round((ms(b) - ms(a)) / DAY);
}

function priorSeason(games2025) {
  const teams = {}, elo = {};
  const sorted = Object.values(games2025 || {}).filter(g => g.status === "final" && g.hs !== g.as)
    .sort((a, b) => a.firstPitch - b.firstPitch);
  for (const g of sorted) {
    for (const [t, rs, ra] of [[g.home, g.hs, g.as], [g.away, g.as, g.hs]]) {
      const s = teams[t] || (teams[t] = { g: 0, rd: 0, w: 0 });
      s.g++; s.rd += rs - ra; s.w += rs > ra ? 1 : 0;
    }
    eloUpdate(elo, g);
  }
  const out = {};
  Object.keys(teams).forEach(t => {
    const s = teams[t];
    out[t] = { rd: 0.5 * s.rd / s.g, wp: 0.5 + 0.5 * (s.w / s.g - 0.5), elo: 1500 + (2 / 3) * ((elo[t] || 1500) - 1500), games: s.g };
  });
  return { teams: out, n: sorted.length };
}

function eloUpdate(elo, g) {
  const rh = elo[g.home] || 1500, ra = elo[g.away] || 1500;
  const exp = 1 / (1 + Math.pow(10, -((rh + HFA_ELO) - ra) / 400));
  const y = g.hs > g.as ? 1 : 0;
  const delta = ELO_K * Math.log(Math.abs(g.hs - g.as) + 1) * (y - exp);
  elo[g.home] = rh + delta; elo[g.away] = ra - delta;
}

function reliefIP(box, team) {
  const t = box && box.teams && box.teams[team];
  if (!t || !t.pitchers || !t.pitchers.length) return null;
  let ip = 0;
  t.pitchers.forEach(p => { if (!p.starter && p.ip != null) ip += p.ip; });
  return ip;
}

// games2026: map/array of season game records; boxes: {id: {teams}}; hls: half-lives (days)
function buildFeatures(games2026, games2025, boxes, hls, opts) {
  opts = opts || {};
  const K_PRIOR = opts.kPrior == null ? 15 : opts.kPrior;
  const prior = priorSeason(games2025);
  const games = (Array.isArray(games2026) ? games2026 : Object.values(games2026))
    .filter(g => g && g.home && g.away && isFinite(g.firstPitch))
    .sort((a, b) => a.firstPitch - b.firstPitch || String(a.id).localeCompare(String(b.id)));
  const elo = {};
  Object.keys(prior.teams).forEach(t => { elo[t] = prior.teams[t].elo; });
  const hist = {}, eloAsOf = {}, pitchers = {}, lineupsHist = {};
  const T = t => hist[t] || (hist[t] = []);
  const out = {};

  for (const g of games) {
    const f = {}, t0 = g.firstPitch;
    const hH = T(g.home), aH = T(g.away);
    const lastT = h => (h.length ? h[h.length - 1].t : null);
    const maxAsOf = (...xs) => { const v = xs.filter(x => x != null); return v.length ? Math.max(...v) : null; };

    // Elo (logit scale, no home-field term: the model's intercept carries it)
    const eh = elo[g.home] || 1500, ea = elo[g.away] || 1500;
    f.elo = { v: (eh - ea) * Math.LN10 / 400, asOf: maxAsOf(eloAsOf[g.home], eloAsOf[g.away]) };

    // recency-weighted strength per half-life
    const strength = {};
    for (const hl of hls) {
      const calc = (h, team, key) => {
        const pr = prior.teams[team];
        let sw = K_PRIOR, s = K_PRIOR * (pr ? (key === "rd" ? pr.rd : pr.wp) : (key === "rd" ? 0 : 0.5));
        for (const x of h) { const w = Math.pow(0.5, (t0 - x.t) / DAY / hl); sw += w; s += w * (key === "rd" ? x.rd : x.won); }
        return s / sw;
      };
      strength[hl] = {
        rd: { v: calc(hH, g.home, "rd") - calc(aH, g.away, "rd"), asOf: maxAsOf(lastT(hH), lastT(aH)) },
        wp: { v: calc(hH, g.home, "wp") - calc(aH, g.away, "wp"), asOf: maxAsOf(lastT(hH), lastT(aH)) }
      };
    }

    // rest
    const restOf = h => (h.length ? Math.min(3, Math.max(0, daysBetween(h[h.length - 1].date, g.date))) : 3);
    f.rest = { v: restOf(hH) - restOf(aH), asOf: maxAsOf(lastT(hH), lastT(aH)) };

    // bullpen usage over the previous 3 days (null if any needed box score is missing)
    const bp = h => {
      // the three previous calendar days plus an earlier game today (doubleheader)
      const used = h.filter(x => { const d = daysBetween(x.date, g.date); return x.t < t0 && d >= 0 && d <= 3; });
      let ip = 0, asOf = null;
      for (const x of used) { if (x.relief == null) return { v: null, asOf: null }; ip += x.relief; asOf = maxAsOf(asOf, x.t); }
      return { v: ip, asOf };
    };
    const bh = bp(hH), ba = bp(aH);
    f.bp3 = bh.v == null || ba.v == null ? { v: null, asOf: null } : { v: bh.v - ba.v, asOf: maxAsOf(bh.asOf, ba.asOf) };

    const sept = Number(g.date.slice(4, 6)) >= 9 ? 1 : 0;
    f.sept = { v: sept, asOf: null };

    // live-only: probable starters captured before first pitch
    const pr = g.probables && g.probables.capturedAt < t0 ? g.probables : null;
    const spStat = (p) => {
      if (!p || !p.id) return null;
      const starts = (pitchers[p.id] || []).filter(s => s.t < t0);
      let ip = 0, er = 0;
      starts.forEach(s => { ip += s.ip || 0; er += s.er || 0; });
      const ra9 = (er + 4.3 / 9 * 30) / (ip + 30) * 9; // regress toward league ERA with 30 IP
      const last3 = starts.slice(-3).filter(s => s.pc != null);
      return { ra9, pc: last3.length ? last3.reduce((a, s) => a + s.pc, 0) / last3.length : null, asOf: starts.length ? starts[starts.length - 1].t : null };
    };
    const sh = pr && spStat(pr.home), sa = pr && spStat(pr.away);
    f.spRa9 = sh && sa ? { v: sa.ra9 - sh.ra9, asOf: maxAsOf(sh.asOf, sa.asOf, pr.capturedAt) } : { v: null, asOf: null };
    f.spPc = sh && sa && sh.pc != null && sa.pc != null ? { v: sh.pc - sa.pc, asOf: maxAsOf(sh.asOf, sa.asOf, pr.capturedAt) } : { v: null, asOf: null };

    // live-only: rested regulars vs a lineup posted before first pitch
    const lu = g.pregameLineups && g.pregameLineups.capturedAt < t0 ? g.pregameLineups : null;
    const rested = team => {
      const recent = (lineupsHist[team] || []).filter(x => x.t < t0 && daysBetween(x.date, g.date) <= 14);
      const counts = {};
      recent.forEach(x => x.ids.forEach(id => { counts[id] = (counts[id] || 0) + 1; }));
      const regulars = Object.keys(counts).filter(id => counts[id] >= 5).sort((a, b) => counts[b] - counts[a]).slice(0, 8);
      if (!regulars.length) return null;
      return { v: regulars.filter(id => lu.lineups[team].indexOf(id) < 0).length, asOf: recent[recent.length - 1].t };
    };
    const rh = lu && lu.lineups[g.home] && rested(g.home), ra = lu && lu.lineups[g.away] && rested(g.away);
    f.rested = rh && ra ? { v: rh.v - ra.v, asOf: maxAsOf(rh.asOf, ra.asOf, lu.capturedAt) } : { v: null, asOf: null };

    out[g.id] = { shared: f, byHl: strength };

    // ── update state with this game's result (visible only to LATER games) ──
    if (g.status === "final" && g.hs != null && g.as != null && g.hs !== g.as) {
      const bx = boxes && boxes[g.id];
      hH.push({ t: t0, date: g.date, rd: g.hs - g.as, won: g.hs > g.as ? 1 : 0, relief: reliefIP(bx, g.home) });
      aH.push({ t: t0, date: g.date, rd: g.as - g.hs, won: g.as > g.hs ? 1 : 0, relief: reliefIP(bx, g.away) });
      elo[g.home] = elo[g.home] || 1500; elo[g.away] = elo[g.away] || 1500;
      eloUpdate(elo, g);
      eloAsOf[g.home] = t0; eloAsOf[g.away] = t0;
      if (bx && bx.teams) {
        for (const team of [g.home, g.away]) {
          const tb = bx.teams[team];
          if (!tb) continue;
          const st = (tb.pitchers || []).find(p => p.starter);
          if (st && st.id) (pitchers[st.id] || (pitchers[st.id] = [])).push({ t: t0, ip: st.ip, er: st.er, pc: st.pc });
          if (tb.batters && tb.batters.length) (lineupsHist[team] || (lineupsHist[team] = [])).push({ t: t0, date: g.date, ids: tb.batters });
        }
      }
    }
  }
  return { features: out, prior: { teams: Object.keys(prior.teams).length, games: prior.n } };
}

// Flat feature map {name: {v, asOf, src}} for one game at one half-life.
function featureRecord(frame, gameId, hl) {
  const fr = frame[gameId];
  if (!fr) return null;
  const s = fr.shared, h = fr.byHl[hl];
  const rec = Object.assign({}, s, { rd: h.rd, wp: h.wp });
  rec.septRd = { v: s.sept.v * h.rd.v, asOf: h.rd.asOf };
  Object.keys(rec).forEach(k => { rec[k] = Object.assign({ src: FEATURE_SOURCES[k] }, rec[k]); });
  return rec;
}

function vector(rec, names) {
  return names.map(n => (rec[n] && rec[n].v != null && isFinite(rec[n].v) ? rec[n].v : 0));
}

module.exports = { buildFeatures, featureRecord, vector, FEATURE_SOURCES, FEATURE_SETS, LIVE_ONLY, priorSeason, daysBetween, HFA_ELO };
