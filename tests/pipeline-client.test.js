import { describe, it, expect } from "vitest";
import fs from "fs";
import vm from "vm";
import path from "path";
import AC from "../js/engine/autocal.js";

const root = path.resolve(__dirname, "..");
const scripts = ["js/engine/probability.js", "js/engine/autocal.js", "js/engine/ev.js", "js/engine/coverage.js", "js/data/pipeline-client.js"]
  .map(f => fs.readFileSync(path.join(root, f), "utf8"));

const DAY = 86400000;
const ymd = ms => new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");

// Published pipeline files whose calibrator state is two days old.
function publishedFiles(now) {
  const rows = [];
  for (let i = 0; i < 400; i++) {
    const fp = now - 40 * DAY + i * (38 * DAY / 400);
    const raw = 0.3 + 0.4 * ((i * 37) % 100) / 100;
    rows.push({ gameId: "g" + i, date: ymd(fp), firstPitch: fp, rawP: raw, calP: raw, finalP: raw, marketP: raw, y: (i * 7919) % 3 === 0 ? 0 : 1 });
  }
  const stale = AC.refit(null, rows.slice(0, 200), { now: now - 2 * DAY, asOfDate: ymd(now - 2 * DAY) });
  return {
    "live/today.json": { games: [{ gameId: "t1", rawP: 0.62, frozen: false }, { gameId: "t2", frozen: true, frozenFinalP: 0.55, frozenBet: { flag: false } }], alerts: [{ gameId: "t3", matchup: "BOS @ NYY", reason: "no pipeline run froze a pick before first pitch" }] },
    "metrics/metrics.json": { coverage: {}, status: {} },
    "state/model_state.json": { configVersion: "cfg-test", config: { calWindow: 60, calMethod: "platt" }, autocal: stale },
    "backfill/predictions.json": { rows },
    "live/picks.json": { picks: {} }
  };
}

function pageContext(storageMap, files) {
  const localStorage = { getItem: k => (k in storageMap ? storageMap[k] : null), setItem: (k, v) => { storageMap[k] = String(v); } };
  let fetches = 0;
  const fetch = url => {
    fetches++;
    const key = Object.keys(files).find(k => url.indexOf("/" + k + "?") > 0);
    return Promise.resolve(key ? { ok: true, json: () => Promise.resolve(JSON.parse(JSON.stringify(files[key]))) } : { ok: false, status: 404 });
  };
  const ctx = { localStorage, fetch, Intl, Date, Math, JSON, Promise, console, DS_PIPELINE_BASE: "https://example.test/data" };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  scripts.forEach(src => vm.runInContext(src, ctx));
  return { ctx, fetches: () => fetches };
}

describe("dashboard pipeline client", () => {
  it("refits a stale calibrator on load and the refit survives a page reload", async () => {
    const now = Date.now(), files = publishedFiles(now), storage = {};
    const first = pageContext(storage, files);
    await first.ctx.DSPipeline.load();
    const d1 = first.ctx.DSPipeline.data;
    expect(d1.error).toBeNull();
    expect(d1.localRefit).toBe(true); // last published fit was 2 days old
    expect(Date.parse(d1.state.current.lastRefit)).toBeGreaterThan(now - 60000);
    const persisted = JSON.parse(storage[AC.STORAGE_KEY]);
    expect(persisted.versions.length).toBeGreaterThan(1);

    // reload: a fresh JS realm with the same localStorage and the same (stale) repo files
    const second = pageContext(storage, files);
    await second.ctx.DSPipeline.load();
    const d2 = second.ctx.DSPipeline.data;
    expect(d2.localRefit).toBe(false); // restored from storage, no refit needed
    expect(JSON.stringify(d2.state)).toBe(JSON.stringify(d1.state));
    expect(d2.state.versions.map(v => v.version)).toEqual(d1.state.versions.map(v => v.version));
    expect(second.ctx.DSPipeline.finalFor("t1", { real: true, homeImpl: 0.5 }).finalP).toBe(first.ctx.DSPipeline.finalFor("t1", { real: true, homeImpl: 0.5 }).finalP);
  });

  it("keeps frozen picks immutable and surfaces coverage alerts", async () => {
    const page = pageContext({}, publishedFiles(Date.now()));
    await page.ctx.DSPipeline.load();
    const frozen = page.ctx.DSPipeline.finalFor("t2", { real: true, homeImpl: 0.4 });
    expect(frozen.finalP).toBe(0.55);
    expect(frozen.frozen).toBe(true);
    expect(page.ctx.DSPipeline.status().alerts.length).toBe(1);
    expect(page.ctx.DSPipeline.finalFor("unknown", null)).toBeNull();
  });
});
