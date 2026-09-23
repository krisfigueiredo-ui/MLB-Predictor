import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import Syn from "./helpers/synthetic-season.js";
import F from "../pipeline/features.js";
import WF from "../pipeline/walkforward.js";
import S from "../pipeline/search.js";
import espn from "../pipeline/espn.js";
import store from "../pipeline/store.js";
import live from "../pipeline/live.js";
import cli from "../pipeline/cli.js";

const NOW = Date.UTC(2026, 5, 20, 12);
const s25 = Syn.season(2025, { seed: 7, end: Date.UTC(2025, 8, 28) });
const s26 = Syn.season(2026, { seed: 11, end: Date.UTC(2026, 5, 22), now: NOW });
const CONFIG = Object.assign({}, S.DEFAULT_CONFIG, { calMethod: "platt" });

describe("leakage: no feature is timestamped after first pitch", () => {
  const ctx = WF.buildContext(s26.season, s25.season, s26.box, S.SPACE.hl);

  it("every feature of every game has asOf strictly before first pitch", () => {
    let checked = 0;
    ctx.games.forEach(g => {
      S.SPACE.hl.forEach(hl => {
        const rec = F.featureRecord(ctx.frames, g.id, hl);
        Object.keys(rec).forEach(k => {
          if (rec[k].asOf != null) { expect(rec[k].asOf).toBeLessThan(g.firstPitch); checked++; }
          expect(rec[k].src).toBeTruthy(); // every feature is labeled with its data source
        });
      });
    });
    expect(checked).toBeGreaterThan(10000);
  });

  it("backfilled walk-forward rows carry only pre-first-pitch features and null live-only inputs", () => {
    const wf = WF.runWalkForward(ctx, CONFIG, {});
    const rows = wf.rows.filter(r => r.y != null);
    expect(rows.length).toBeGreaterThan(500);
    rows.forEach(r => {
      expect(r.source).toBe("backfill_walkforward");
      Object.keys(r.features).forEach(k => { const asOf = r.features[k][1]; if (asOf != null) expect(asOf).toBeLessThan(r.firstPitch); });
      F.LIVE_ONLY.forEach(k => expect(r.features[k][0]).toBeNull());
      expect(r.trainN).toBe(ctx.games.filter(g => WF.isGraded(g) && g.date < r.date).length); // trained only on earlier dates
    });
  });

  it("rewriting every result after a date cannot change any earlier feature or prediction", () => {
    const cut = "20260515";
    const poisoned = JSON.parse(JSON.stringify(s26.season));
    Object.values(poisoned.games).forEach(g => { if (g.date >= cut && g.status === "final") { const t = g.hs; g.hs = g.as + 7; g.as = t; } });
    const a = WF.runWalkForward(WF.buildContext(s26.season, s25.season, s26.box, [30]), CONFIG, { light: true });
    const b = WF.runWalkForward(WF.buildContext(poisoned, s25.season, s26.box, [30]), CONFIG, { light: true });
    const before = r => r.date < cut;
    const pa = a.rows.filter(before), pb = b.rows.filter(before);
    expect(pa.length).toBeGreaterThan(300);
    expect(pb.map(r => [r.gameId, r.rawP, r.calP, r.finalP])).toEqual(pa.map(r => [r.gameId, r.rawP, r.calP, r.finalP]));
    const onCut = r => r.date === cut;
    expect(b.rows.filter(onCut).map(r => r.rawP)).toEqual(a.rows.filter(onCut).map(r => r.rawP)); // same-day results unseen too
  });

  it("drops probables that were only captured after first pitch", () => {
    const ev = { id: "9", date: "2026-07-01T23:05Z", season: { type: 2 }, competitions: [{ date: "2026-07-01T23:05Z", status: { type: { name: "STATUS_FINAL", state: "post", completed: true } },
      competitors: [{ homeAway: "home", team: { abbreviation: "NYY", id: "10" }, score: "5", probables: [{ athlete: { id: "1", fullName: "A" } }] },
        { homeAway: "away", team: { abbreviation: "BOS", id: "2" }, score: "3", probables: [{ athlete: { id: "2", fullName: "B" } }] }] }] };
    expect(espn.parseEvent(ev, "20260701", Date.parse("2026-07-02T03:00Z")).probables).toBeNull();
    const pre = JSON.parse(JSON.stringify(ev)); pre.competitions[0].status.type = { name: "STATUS_SCHEDULED", state: "pre" };
    expect(espn.parseEvent(pre, "20260701", Date.parse("2026-07-01T20:00Z")).probables.home.name).toBe("A");
  });
});

describe("ESPN parsing", () => {
  it("reads open/close moneylines from the nested scoreboard and core-API shapes", () => {
    const nested = espn.parseOddsEntry({ provider: { name: "ESPN BET" }, moneyline: { home: { open: { odds: "-135" }, close: { odds: "-150" } }, away: { open: { odds: "+115" }, close: { odds: "+130" } } } });
    expect(nested.open).toEqual({ home: -135, away: 115 });
    expect(nested.close).toEqual({ home: -150, away: 130 });
    const core = espn.parseOddsEntry({ provider: { name: "DraftKings" }, homeTeamOdds: { moneyLine: -120, open: { moneyLine: { american: "-110" } }, close: { moneyLine: { american: "-125" } } }, awayTeamOdds: { moneyLine: 100, open: { moneyLine: { american: "-110" } }, close: { moneyLine: { american: "+105" } } } });
    expect(core.open).toEqual({ home: -110, away: -110 });
    expect(core.close).toEqual({ home: -125, away: 105 });
    expect(core.listed).toEqual({ home: -120, away: 100 });
    expect(espn.parseOddsEntry({ details: "NYY -1.5" })).toBeNull();
  });

  it("parses box-score pitching lines (IP thirds, pitch counts, starter first)", () => {
    const box = espn.parseBox({ boxscore: { players: [{ team: { abbreviation: "NYY" }, statistics: [
      { type: "pitching", labels: ["IP", "H", "R", "ER", "BB", "K", "HR", "PC-ST", "ERA"], athletes: [
        { athlete: { id: "11" }, starter: true, stats: ["6.1", "5", "2", "2", "1", "7", "1", "98-64", "3.10"] },
        { athlete: { id: "12" }, stats: ["2.2", "1", "0", "0", "0", "3", "0", "35-22", "2.00"] }] },
      { type: "batting", labels: ["AB"], athletes: [{ athlete: { id: "21" }, starter: true }, { athlete: { id: "22" }, starter: false }] }] }] } });
    expect(box.NYY.pitchers[0]).toMatchObject({ id: "11", starter: true, pc: 98, er: 2 });
    expect(box.NYY.pitchers[0].ip).toBeCloseTo(6 + 1 / 3, 10);
    expect(box.NYY.pitchers[1].starter).toBe(false);
    expect(box.NYY.batters).toEqual(["21"]);
  });

  it("maps ESPN statuses", () => {
    expect(espn.statusOf({ status: { type: { name: "STATUS_POSTPONED" } } })).toBe("postponed");
    expect(espn.statusOf({ status: { type: { name: "STATUS_FINAL", state: "post", completed: true } } })).toBe("final");
    expect(espn.statusOf({ status: { type: { name: "STATUS_SCHEDULED", state: "pre" } } })).toBe("scheduled");
  });
});

describe("live pipeline: freezing, grading, coverage", () => {
  let dir, P;
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ds-pipeline-"));
    P = store.paths(dir);
    store.writeJson(P.games(2025), s25.season);
    const season = JSON.parse(JSON.stringify(s26.season));
    // today's games carry a live pregame line captured before first pitch
    Object.values(season.games).forEach(g => {
      if (g.status === "scheduled" && g.odds) { g.odds.listed = g.odds.close; g.odds.close = null; g.odds.open = null; g.oddsCapturedAt = NOW - 3600000; }
    });
    store.writeJson(P.games(2026), season);
    store.writeJson(P.box(2026), s26.box);
    await cli.backfill(dir, { "skip-fetch": true, "max-configs": 3, today: store.etDate(NOW), log: () => {} });
  }, 240000);

  it("backfill writes versioned state, experiments, and backfill_walkforward rows only", () => {
    const model = store.readJson(P.state);
    expect(model.configVersion).toMatch(/^cfg-/);
    expect(model.autocal.versions.length).toBeGreaterThan(0);
    expect(model.holdout.metrics.n).toBeGreaterThan(0);
    const bf = store.readJson(P.backfill);
    expect(bf.rows.every(r => r.source === "backfill_walkforward")).toBe(true);
    expect(store.readJson(P.experiments).experiments.length).toBe(3);
    expect(fs.readFileSync(P.report, "utf8")).toMatch(/Locked holdout/);
  });

  it("freezes frozen_pregame picks inside the window with the full audit trail, and never rewrites them", async () => {
    const games = store.readJson(P.games(2026)).games;
    const target = Object.values(games).filter(g => g.status === "scheduled" && g.date === store.etDate(NOW)).sort((a, b) => a.firstPitch - b.firstPitch)[0];
    const at = target.firstPitch - 60 * 60000;
    await live.runLive(dir, { skipFetch: true, now: at, log: () => {} });
    const picks = store.readJson(P.picks).picks;
    const p = picks[target.id];
    expect(p).toBeTruthy();
    expect(p.source).toBe("frozen_pregame");
    expect(p.frozenAt).toBeLessThan(p.firstPitch);
    ["rawP", "calP", "finalP", "w", "modelConfigVersion", "calibratorVersion"].forEach(k => expect(p[k]).not.toBeUndefined());
    expect(p.pickOdds && p.pickOdds.homeML).toBeTruthy();
    expect(p.marketP).toBeGreaterThan(0);
    Object.values(p.features).forEach(f => { if (f.asOf != null) expect(f.asOf).toBeLessThan(p.firstPitch); });
    const snapshot = JSON.stringify(p);
    await live.runLive(dir, { skipFetch: true, now: at + 20 * 60000, forceRefit: true, log: () => {} });
    expect(JSON.stringify(store.readJson(P.picks).picks[target.id])).toBe(snapshot);
    expect(store.readJson(P.today).games.length).toBeGreaterThan(0);
  }, 120000);

  it("grades a frozen pick with result, closing line, CLV and P&L after the final", () => {
    const picks = { a: { gameId: "g1", finalP: 0.6, marketP: 0.52, pickOdds: { homeML: -110, awayML: -110 }, bet: { flag: true, side: "home", price: -110, stakeFraction: 0.01 } } };
    const games = { g1: { id: "g1", status: "final", hs: 4, as: 2, firstPitch: 1, odds: { close: { home: -125, away: 105 } } } };
    expect(live.gradePicks(picks, games)).toBe(1);
    expect(picks.a.y).toBe(1);
    expect(picks.a.close.source).toBe("espn-close");
    expect(picks.a.clv).toBeGreaterThan(0);
    expect(picks.a.pnl.units).toBeCloseTo(100 / 110, 6);
  });

  it("raises a coverage alert when a game reaches first pitch without a pick", async () => {
    const games = store.readJson(P.games(2026)).games;
    const picks = store.readJson(P.picks).picks;
    const missed = Object.values(games).filter(g => g.status === "scheduled" && g.date === store.etDate(NOW) && !picks[g.id])
      .sort((a, b) => a.firstPitch - b.firstPitch)[0];
    // jump past its first pitch without any run inside its freeze window
    const mutated = store.readJson(P.games(2026));
    Object.values(mutated.games).forEach(g => { if (g.firstPitch <= missed.firstPitch && g.status === "scheduled" && !picks[g.id] && g.id !== missed.id) g.status = "postponed"; });
    store.writeJson(P.games(2026), mutated);
    await live.runLive(dir, { skipFetch: true, now: missed.firstPitch + 5 * 60000, log: () => {} });
    const cov = store.readJson(P.coverage);
    const alert = cov.alerts.find(a => a.gameId === missed.id);
    expect(alert).toBeTruthy();
    expect(alert.severity).toBe("missed");
    expect(alert.reason).toMatch(/no pipeline run froze a pick/);
    expect(store.readJson(P.today).alerts.some(a => a.gameId === missed.id)).toBe(true);
    expect(store.readJson(P.picks).picks[missed.id]).toBeUndefined(); // never frozen after first pitch
  }, 120000);
});
