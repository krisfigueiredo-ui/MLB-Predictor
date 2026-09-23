// Deterministic synthetic MLB season in the pipeline's stored format, used by
// tests and local smoke runs (the sandbox cannot reach ESPN). Team strength
// drifts over the season; the market sees the true probability plus noise and
// vig; box scores carry starter/relief innings.
"use strict";

const TEAMS = ["ATH", "ATL", "AZ", "BAL", "BOS", "CHC", "CIN", "CLE", "COL", "CWS", "DET", "HOU", "KC", "LAA", "LAD",
  "MIA", "MIL", "MIN", "NYM", "NYY", "PHI", "PIT", "SD", "SEA", "SF", "STL", "TB", "TEX", "TOR", "WSH"];

function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
function gauss(r) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); }
function ymd(ms) { const d = new Date(ms); return d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, "0") + String(d.getUTCDate()).padStart(2, "0"); }
function toML(p) { return p >= 0.5 ? -Math.round(100 * p / (1 - p)) : Math.round(100 * (1 - p) / p); }
function poisson(r, lam) { let L = Math.exp(-lam), k = 0, p = 1; do { k++; p *= r(); } while (p > L); return k - 1; }

function season(year, opts) {
  opts = opts || {};
  const r = rng(opts.seed || year);
  const start = Date.UTC(year, 2, 26), end = opts.end || Date.UTC(year, 8, 22);
  const strength = {};
  TEAMS.forEach(t => { strength[t] = (opts.prior && opts.prior[t] != null ? opts.prior[t] : 0) * 0.6 + gauss(r) * 0.25; });
  const games = {}, box = {};
  let id = year * 100000;
  for (let day = start; day <= end; day += 86400000) {
    TEAMS.forEach(t => { strength[t] += gauss(r) * 0.012; });
    if (r() < 0.06) continue; // league-wide off day
    const order = TEAMS.slice().sort(() => r() - 0.5);
    for (let i = 0; i + 1 < order.length; i += 2) {
      if (r() < 0.05) continue;
      const home = order[i], away = order[i + 1];
      const fp = day + (17 + Math.floor(r() * 6)) * 3600000;
      const pTrue = 1 / (1 + Math.exp(-(0.16 + strength[home] - strength[away])));
      let hs = poisson(r, 4.4 * Math.exp((pTrue - 0.5))), as = poisson(r, 4.4 * Math.exp(-(pTrue - 0.5)));
      if (hs === as) { if (r() < pTrue) hs++; else as++; }
      const gid = String(++id);
      const status = r() < 0.01 ? "postponed" : fp < (opts.now || Infinity) ? "final" : "scheduled";
      const mNoise = Math.max(0.2, Math.min(0.8, pTrue + gauss(r) * (opts.marketNoise == null ? 0.02 : opts.marketNoise)));
      const vig = 0.022;
      const hasOdds = r() < (opts.oddsRate == null ? 0.9 : opts.oddsRate);
      const openP = Math.max(0.2, Math.min(0.8, mNoise + gauss(r) * 0.015));
      games[gid] = {
        id: gid, date: ymd(day), firstPitch: fp, seasonType: 2, status, home, away, homeId: home, awayId: away,
        hs: status === "final" ? hs : null, as: status === "final" ? as : null, probables: null, trueP: pTrue,
        odds: hasOdds ? { provider: "Synthetic", open: { home: toML(openP + vig / 2), away: toML(1 - openP + vig / 2) },
          close: { home: toML(mNoise + vig / 2), away: toML(1 - mNoise + vig / 2) }, current: null, listed: null } : null,
        oddsCapturedAt: fp + 4 * 3600000
      };
      if (status === "final") {
        const sp = (team) => ({ pitchers: [{ id: team + "-sp" + Math.floor(r() * 5), starter: true, ip: 4 + Math.floor(r() * 4), er: poisson(r, 2.5), pc: 80 + Math.floor(r() * 25) },
          { id: team + "-rp", starter: false, ip: 1 + Math.floor(r() * 4), er: 0, pc: 30 }], batters: [] });
        box[gid] = { teams: { [home]: sp(home), [away]: sp(away) } };
      }
    }
  }
  return { season: { schema: 1, season: year, fetchedDates: {}, games }, box: { schema: 1, games: box }, strength };
}

module.exports = { season, TEAMS, toML };
