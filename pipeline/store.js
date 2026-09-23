// JSON file store for the pipeline's data directory (the `pipeline-data` branch).
"use strict";
const fs = require("fs");
const path = require("path");

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return fallback; }
}
function writeJson(file, value, pretty) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, pretty === false ? 0 : 1) + "\n");
  fs.renameSync(tmp, file);
}

function paths(dataDir) {
  const p = rel => path.join(dataDir, rel);
  return {
    games: year => p(`season/games-${year}.json`),
    box: year => p(`season/box-${year}.json`),
    lines: p("season/lines-2026.json"),
    backfill: p("backfill/predictions.json"),
    picks: p("live/picks.json"),
    today: p("live/today.json"),
    state: p("state/model_state.json"),
    experiments: p("experiments/experiments.json"),
    coverage: p("coverage/coverage.json"),
    metrics: p("metrics/metrics.json"),
    report: p("REPORT.md"),
    reportJson: p("report.json"),
    runLog: p("run-log.json")
  };
}

// ET calendar date for a timestamp (ESPN's scoreboard dates are ET days).
function etDate(ms) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
  const get = t => parts.find(x => x.type === t).value;
  return get("year") + get("month") + get("day");
}
function addDays(ymd, n) {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)) + n * 86400000);
  return d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, "0") + String(d.getUTCDate()).padStart(2, "0");
}
function dateRange(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

module.exports = { readJson, writeJson, paths, etDate, addDays, dateRange };
