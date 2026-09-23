// Season collection: schedule, results, odds, and box scores from ESPN,
// fetched incrementally and cached in the data directory. Failures are
// recorded per date/game so coverage gaps always have a logged reason.
"use strict";
const espn = require("./espn");
const { readJson, writeJson, paths, dateRange, etDate, addDays } = require("./store");

function emptySeason(year) { return { schema: 1, season: year, updatedAt: null, fetchedDates: {}, games: {} }; }

// Merge a freshly parsed record into the stored one without losing pregame-only
// captures (probables, pregame odds) that a later post-game fetch cannot see.
function mergeGame(prev, next) {
  if (!prev) return next;
  const out = Object.assign({}, prev, next);
  out.probables = prev.probables || next.probables;
  if (prev.odds && next.odds) {
    out.odds = Object.assign({}, prev.odds);
    for (const k of ["open", "close", "current", "listed"]) if (next.odds[k]) out.odds[k] = next.odds[k];
    out.odds.provider = next.odds.provider || prev.odds.provider;
    if (prev.pregameOdds) out.pregameOdds = prev.pregameOdds;
  } else out.odds = next.odds || prev.odds;
  if (next.status === "scheduled" && next.odds && next.capturedWhile === "pregame") {
    out.pregameOdds = { odds: next.odds, capturedAt: next.oddsCapturedAt };
  }
  if (prev.date && prev.date < next.date && next.status === "final") out.resumedDate = next.date; // suspended/resumed
  if (prev.date && prev.date < next.date) out.date = prev.date;
  return out;
}

async function fetchDates(season, dates, opts) {
  const log = opts.log || (() => {});
  for (const ds of dates) {
    const at = Date.now();
    try {
      const data = await espn.scoreboard(ds);
      const events = (data && data.events) || [];
      let kept = 0;
      for (const ev of events) {
        const g = espn.parseEvent(ev, ds, at);
        if (!g || (g.seasonType != null && g.seasonType !== 2)) continue; // regular season only
        season.games[g.id] = mergeGame(season.games[g.id], g);
        kept++;
      }
      season.fetchedDates[ds] = { at: new Date(at).toISOString(), ok: true, events: events.length, regular: kept };
    } catch (err) {
      season.fetchedDates[ds] = { at: new Date(at).toISOString(), ok: false, error: String(err.message || err) };
      log(`scoreboard ${ds} failed: ${err.message}`);
    }
    await espn.sleep(opts.pace == null ? 150 : opts.pace);
  }
}

// Dates that need (re)fetching: never fetched, failed, or holding any
// non-terminal game, plus the most recent `refreshDays`.
function datesToFetch(season, from, to, refreshDays) {
  const stale = {};
  Object.values(season.games).forEach(g => {
    if (g.status === "scheduled" || g.status === "in" || g.status === "suspended") stale[g.date] = true;
  });
  const recentStart = addDays(to, -(refreshDays || 0));
  return dateRange(from, to).filter(d => {
    const f = season.fetchedDates[d];
    return !f || !f.ok || stale[d] || d >= recentStart;
  });
}

async function pool(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const item = items[i++]; await fn(item); }
  });
  await Promise.all(workers);
}

async function fetchBoxes(season, box, opts) {
  const log = opts.log || (() => {});
  const todo = Object.values(season.games).filter(g => g.status === "final" && !(box.games[g.id] && box.games[g.id].teams));
  log(`box scores to fetch: ${todo.length}`);
  await pool(todo, opts.concurrency || 4, async g => {
    try {
      const s = await espn.summary(g.id);
      const parsed = espn.parseBox(s);
      box.games[g.id] = parsed ? { teams: parsed, fetchedAt: new Date().toISOString() } : { teams: null, error: "no boxscore in summary", fetchedAt: new Date().toISOString() };
    } catch (err) {
      box.games[g.id] = { teams: null, error: String(err.message || err), fetchedAt: new Date().toISOString() };
    }
    await espn.sleep(100);
  });
}

async function fetchMissingOdds(season, opts) {
  const log = opts.log || (() => {});
  const todo = Object.values(season.games).filter(g => g.status === "final" && !g.coreOddsTried &&
    !(g.odds && (g.odds.open || g.odds.close)));
  log(`core-API odds lookups: ${todo.length}`);
  await pool(todo, opts.concurrency || 4, async g => {
    try {
      const o = await espn.coreOdds(g.id);
      if (o) { g.odds = Object.assign({}, g.odds || {}, Object.fromEntries(Object.entries(o).filter(([, v]) => v))); g.oddsSource = "core"; }
      g.coreOddsTried = new Date().toISOString();
    } catch (err) {
      g.coreOddsError = String(err.message || err);
    }
    await espn.sleep(100);
  });
}

async function collect(dataDir, opts) {
  opts = opts || {};
  const P = paths(dataDir);
  const year = opts.year || 2026;
  const season = readJson(P.games(year), null) || emptySeason(year);
  const box = readJson(P.box(year), null) || { schema: 1, games: {} };
  const today = opts.today || etDate(Date.now());
  const from = opts.from || `${year}0301`;
  const to = opts.to || (year < Number(today.slice(0, 4)) ? `${year}1005` : addDays(today, 1));
  const dates = opts.dates || datesToFetch(season, from, to, opts.refreshDays == null ? 2 : opts.refreshDays);
  (opts.log || console.log)(`season ${year}: fetching ${dates.length} scoreboard dates`);
  await fetchDates(season, dates, opts);
  if (opts.boxes !== false) await fetchBoxes(season, box, opts);
  if (opts.coreOdds !== false) await fetchMissingOdds(season, opts);
  season.updatedAt = new Date().toISOString();
  writeJson(P.games(year), season, false);
  if (opts.boxes !== false) writeJson(P.box(year), box, false);
  return { season, box };
}

module.exports = { collect, mergeGame, datesToFetch, fetchDates, emptySeason };
