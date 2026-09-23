// ESPN public API client + parsers for the pipeline (Node 20+, global fetch).
// Only fields that exist in the provider payload are recorded; anything
// missing stays null. Every record carries the time it was captured so the
// feature builder can prove what was known before first pitch.
"use strict";
const { ourAbbrFromEspn, parseAmericanML } = require("../js/espn-parse");

const SITE = "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb";
const CORE = "https://sports.core.api.espn.com/v2/sports/baseball/leagues/mlb";

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchJson(url, opts = {}) {
  const retries = opts.retries == null ? 4 : opts.retries;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "mlb-predictor-pipeline/1.0", Accept: "application/json" } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(2000 * Math.pow(2, attempt));
    }
  }
  throw new Error(url + ": " + (lastErr && lastErr.message));
}

function statusOf(comp) {
  const t = (comp && comp.status && comp.status.type) || {};
  const name = String(t.name || "");
  if (/POSTPONED/.test(name)) return "postponed";
  if (/CANCELED|CANCELLED/.test(name)) return "canceled";
  if (/SUSPENDED/.test(name)) return "suspended";
  if (t.completed || t.state === "post" || /FINAL/.test(name)) return "final";
  if (t.state === "in") return "in";
  return "scheduled";
}

// Moneyline value from any of ESPN's shapes: number, "+130", {american}, {value}, {odds}.
function mlValue(v) {
  if (v == null) return null;
  if (typeof v === "object") {
    for (const k of ["american", "odds", "value", "alternateDisplayValue", "displayValue"]) {
      if (v[k] != null) { const n = mlValue(v[k]); if (n != null) return n; }
    }
    if (v.moneyLine != null) return mlValue(v.moneyLine);
    return null;
  }
  const n = parseAmericanML(v);
  return n != null && Math.abs(n) >= 100 ? n : null;
}

function pair(h, a) { return h != null && a != null ? { home: h, away: a } : null; }

// Normalize one odds entry (scoreboard or core API) into open/close/current lines.
// A flat moneyLine with no timing is recorded as `listed` — the scoreboard's
// last listed pregame price — never promoted to "open".
function parseOddsEntry(o) {
  if (!o) return null;
  const out = { provider: (o.provider && (o.provider.name || o.provider.displayName)) || null, open: null, close: null, current: null, listed: null };
  if (o.moneyline && (o.moneyline.home || o.moneyline.away)) {
    const h = o.moneyline.home || {}, a = o.moneyline.away || {};
    out.open = pair(mlValue(h.open), mlValue(a.open));
    out.close = pair(mlValue(h.close), mlValue(a.close));
    out.current = pair(mlValue(h.current), mlValue(a.current));
  }
  const ht = o.homeTeamOdds, at = o.awayTeamOdds;
  if (ht && at) {
    out.open = out.open || pair(mlValue(ht.open && ht.open.moneyLine), mlValue(at.open && at.open.moneyLine));
    out.close = out.close || pair(mlValue(ht.close && ht.close.moneyLine), mlValue(at.close && at.close.moneyLine));
    out.current = out.current || pair(mlValue(ht.current && ht.current.moneyLine), mlValue(at.current && at.current.moneyLine));
    out.listed = pair(mlValue(ht.moneyLine), mlValue(at.moneyLine));
  }
  return out.open || out.close || out.current || out.listed ? out : null;
}

function parseOddsList(list) {
  for (const o of list || []) {
    const parsed = parseOddsEntry(o);
    if (parsed) return parsed;
  }
  return null;
}

function probableOf(competitor) {
  const pr = competitor && competitor.probables && competitor.probables[0];
  const a = pr && pr.athlete;
  return a ? { id: String(a.id || ""), name: a.fullName || a.displayName || a.shortName || null } : null;
}

// One scoreboard event -> compact game record. `capturedAt` is when we saw it.
function parseEvent(ev, dateStr, capturedAt) {
  const comp = ev && ev.competitions && ev.competitions[0];
  if (!comp) return null;
  const cs = comp.competitors || [];
  const hC = cs.find(c => c.homeAway === "home"), aC = cs.find(c => c.homeAway === "away");
  if (!hC || !aC || !hC.team || !aC.team) return null;
  const status = statusOf(comp);
  const seasonType = ev.season && ev.season.type != null ? Number(ev.season.type) : (comp.season && comp.season.type != null ? Number(comp.season.type) : null);
  const firstPitch = Date.parse(comp.date || ev.date);
  const hs = hC.score != null && hC.score !== "" ? Number(typeof hC.score === "object" ? hC.score.value : hC.score) : null;
  const as = aC.score != null && aC.score !== "" ? Number(typeof aC.score === "object" ? aC.score.value : aC.score) : null;
  const pre = status === "scheduled" && capturedAt < firstPitch;
  return {
    id: String(ev.id), date: dateStr, firstPitch, seasonType, status,
    statusDetail: (comp.status && comp.status.type && (comp.status.type.detail || comp.status.type.name)) || null,
    home: ourAbbrFromEspn(hC.team.abbreviation), away: ourAbbrFromEspn(aC.team.abbreviation),
    homeId: String(hC.team.id || ""), awayId: String(aC.team.id || ""),
    hs: status === "final" ? hs : null, as: status === "final" ? as : null,
    // Probables are only kept when captured before first pitch; a completed
    // game's listed "probable" is whoever actually started, which was not
    // necessarily known when a pick would have been made.
    probables: pre ? { home: probableOf(hC), away: probableOf(aC), capturedAt } : null,
    odds: parseOddsList(comp.odds),
    oddsCapturedAt: capturedAt,
    capturedWhile: status === "scheduled" ? "pregame" : status
  };
}

async function scoreboard(dateStr) {
  return fetchJson(`${SITE}/scoreboard?dates=${dateStr}&limit=100`);
}

function parseIP(v) {
  if (v == null) return null;
  const s = String(v);
  const m = s.match(/^(\d+)(?:\.(\d))?$/);
  if (!m) return null;
  return Number(m[1]) + (m[2] ? Number(m[2]) / 3 : 0);
}

// Box score -> per-team pitchers (appearance order, starter first) and the
// starting nine. Used only as history for LATER games' features.
function parseBox(summary) {
  const players = summary && summary.boxscore && summary.boxscore.players;
  if (!players || !players.length) return null;
  const out = {};
  for (const team of players) {
    const abbr = team.team && ourAbbrFromEspn(team.team.abbreviation);
    if (!abbr) continue;
    const rec = { pitchers: [], batters: [] };
    for (const group of team.statistics || []) {
      const type = String(group.type || group.name || "").toLowerCase();
      const labels = (group.labels || []).map(l => String(l).toUpperCase());
      const keys = (group.keys || []).map(k => String(k).toLowerCase());
      if (type === "pitching" || labels.includes("IP")) {
        const ipI = labels.indexOf("IP"), erI = labels.indexOf("ER"), rI = labels.indexOf("R");
        let pcI = labels.indexOf("PC");
        if (pcI < 0) pcI = labels.indexOf("PC-ST");
        if (pcI < 0) pcI = keys.findIndex(k => k.indexOf("pitch") === 0);
        (group.athletes || []).forEach((a, i) => {
          const st = a.stats || [];
          const pcRaw = pcI >= 0 ? String(st[pcI] || "") : "";
          rec.pitchers.push({
            id: String((a.athlete && a.athlete.id) || ""), order: i, starter: a.starter === true || i === 0,
            ip: ipI >= 0 ? parseIP(st[ipI]) : null,
            er: erI >= 0 && st[erI] !== "" ? Number(st[erI]) : null,
            r: rI >= 0 && st[rI] !== "" ? Number(st[rI]) : null,
            pc: pcRaw ? Number(pcRaw.split("-")[0]) || null : null
          });
        });
      } else if (type === "batting" || labels.includes("AB")) {
        (group.athletes || []).forEach(a => { if (a.starter) rec.batters.push(String((a.athlete && a.athlete.id) || "")); });
      }
    }
    out[abbr] = rec;
  }
  return Object.keys(out).length ? out : null;
}

// Pregame lineup, when ESPN has posted one (summary.rosters[].roster[] with starter/batOrder).
function parsePregameLineups(summary) {
  const rosters = summary && summary.rosters;
  if (!rosters || !rosters.length) return null;
  const out = {};
  for (const r of rosters) {
    const abbr = r.team && ourAbbrFromEspn(r.team.abbreviation);
    const starters = (r.roster || []).filter(p => p.starter && p.batOrder && Number(p.batOrder) >= 1)
      .map(p => String((p.athlete && p.athlete.id) || ""));
    if (abbr && starters.length >= 9) out[abbr] = starters.slice(0, 9);
  }
  return Object.keys(out).length === 2 ? out : null;
}

async function summary(eventId) {
  return fetchJson(`${SITE}/summary?event=${eventId}`);
}

async function coreOdds(eventId) {
  const j = await fetchJson(`${CORE}/events/${eventId}/competitions/${eventId}/odds?limit=20`);
  if (!j) return null;
  const items = j.items || [];
  const resolved = [];
  for (const item of items) {
    if (item && item.$ref && !item.homeTeamOdds && !item.moneyline) {
      try { resolved.push(await fetchJson(item.$ref.replace(/^http:/, "https:"), { retries: 2 })); } catch (e) { /* skip provider */ }
    } else resolved.push(item);
  }
  return parseOddsList(resolved);
}

module.exports = { fetchJson, scoreboard, summary, coreOdds, parseEvent, parseBox, parsePregameLineups, parseOddsEntry, parseOddsList, statusOf, mlValue, parseIP, sleep };
