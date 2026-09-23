import { describe, it, expect } from "vitest";
import P from "../js/engine/probability.js";
import AC from "../js/engine/autocal.js";
import EV from "../js/engine/ev.js";
import COV from "../js/engine/coverage.js";

function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
const DAY = 86400000, DAY0 = Date.UTC(2026, 3, 1);
const ymd = ms => new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");

// Run the live refit loop: `perDay` games a day, refit before each day, predict,
// grade. gen(r, i) -> {rawP, trueP, marketP}.
function simulate(seed, days, perDay, gen, opts) {
  const r = rng(seed);
  let state = AC.initialState({ w0: 0.7 });
  const rows = [], timeline = [];
  let i = 0;
  for (let d = 0; d < days; d++) {
    const now = DAY0 + d * DAY + 12 * 3600000;
    state = AC.refit(state, rows, Object.assign({ now, asOfDate: ymd(now), bestMethod: "isotonic" }, opts || {}));
    timeline.push({ day: d, paused: state.current.paused, w: state.current.w, method: state.current.calibrator.method });
    for (let k = 0; k < perDay; k++, i++) {
      const g = gen(r, i);
      const pr = AC.predict(state, g.rawP, g.marketP);
      rows.push({ firstPitch: now + 3600000, date: ymd(now), rawP: g.rawP, calP: pr.calP, finalP: pr.finalP, marketP: pr.marketP, y: r() < g.trueP ? 1 : 0 });
    }
  }
  return { state, rows, timeline };
}

describe("probability layer", () => {
  it("de-vigs a two-way moneyline to fair probabilities", () => {
    const f = P.devig(-150, 130);
    expect(f.home + f.away).toBeCloseTo(1, 10);
    expect(f.home).toBeGreaterThan(0.56);
    expect(f.overround).toBeGreaterThan(0);
    expect(P.devig(null, 120)).toBeNull();
  });

  it("measures a calibration slope near 1 for calibrated forecasts and near 0 for noise", () => {
    const r = rng(3), good = [], noise = [];
    for (let i = 0; i < 20000; i++) {
      const p = 0.2 + 0.6 * r();
      good.push({ p, y: r() < p ? 1 : 0 });
      noise.push({ p, y: r() < 0.5 ? 1 : 0 });
    }
    expect(P.calibrationFit(good).slope).toBeGreaterThan(0.9);
    expect(P.calibrationFit(good).slope).toBeLessThan(1.1);
    expect(Math.abs(P.calibrationFit(noise).slope)).toBeLessThan(0.1);
  });

  it("smooths isotonic calibration so adjacent knots never jump more than 5 points", () => {
    const r = rng(9), pairs = [];
    for (let i = 0; i < 400; i++) { const p = r(); pairs.push({ p, y: r() < (p > 0.5 ? 0.9 : 0.1) ? 1 : 0 }); }
    const { knots } = P.fitIsotonic(pairs);
    for (let i = 1; i < knots.length; i++) {
      expect(knots[i][1]).toBeGreaterThanOrEqual(knots[i - 1][1] - 1e-9);
      expect(knots[i][1] - knots[i - 1][1]).toBeLessThanOrEqual(0.05 + 1e-6);
    }
  });

  it("chooses the calibration method by sample size", () => {
    expect(P.ladderMethod(99, "isotonic")).toBe("shrink-fixed");
    expect(P.ladderMethod(100, "isotonic")).toBe("platt");
    expect(P.ladderMethod(299, "beta")).toBe("platt");
    expect(P.ladderMethod(300, "beta")).toBe("beta");
  });

  it("applies the fixed shrink with the hard cap below n=100", () => {
    const cal = { method: "shrink-fixed", params: { alpha: 0.5 } };
    expect(P.applyCalibrator(cal, 0.7, P.capFor("shrink-fixed"))).toBeCloseTo(0.6, 10);
    expect(P.applyCalibrator(cal, 0.95, P.capFor("shrink-fixed"))).toBeCloseTo(0.62, 10);
    expect(P.applyCalibrator(cal, 0.05, P.capFor("shrink-fixed"))).toBeCloseTo(0.40, 10);
  });

  it("blends final_p = w·market + (1−w)·model and optimizes w within [0.5, 1]", () => {
    expect(P.blend(0.6, 0.5, 0.7)).toBeCloseTo(0.57, 10);
    const r = rng(5), rows = [];
    for (let i = 0; i < 600; i++) { const t = 0.3 + 0.4 * r(); rows.push({ marketP: t, calP: 0.5, y: r() < t ? 1 : 0 }); }
    const opt = P.optimizeW(rows);
    expect(opt.w).toBe(1);
  });
});

describe("+EV engine", () => {
  it("measures edge from final_p against the fair market, never raw p", () => {
    const bet = EV.evaluateBet({ finalP: 0.60, homeML: -110, awayML: -110, paused: false, bankroll: 1000 });
    expect(bet.homeEdge).toBeCloseTo(0.10, 6);
    expect(bet.flag).toBe(true);
    expect(bet.side).toBe("home");
  });

  it("flags only edges of at least 3 points", () => {
    expect(EV.evaluateBet({ finalP: 0.52, homeML: -110, awayML: -110 }).flag).toBe(false);
    expect(EV.evaluateBet({ finalP: 0.531, homeML: -110, awayML: -110 }).flag).toBe(true);
  });

  it("stakes 0.25× Kelly, capped at 2% of bankroll", () => {
    const small = EV.evaluateBet({ finalP: 0.535, homeML: -110, awayML: -110, bankroll: 1000 });
    const dec = P.americanToDecimal(-110);
    expect(small.stakeFraction).toBeCloseTo(0.25 * EV.kellyFull(0.535, dec), 10);
    const big = EV.evaluateBet({ finalP: 0.75, homeML: 120, awayML: -140, bankroll: 1000 });
    expect(big.stakeFraction).toBe(0.02);
    expect(big.stake).toBe(20);
  });

  it("never flags without real odds or while the model is paused", () => {
    expect(EV.evaluateBet({ finalP: 0.7, homeML: null, awayML: null }).flag).toBe(false);
    const paused = EV.evaluateBet({ finalP: 0.7, homeML: -110, awayML: -110, paused: true });
    expect(paused.flag).toBe(false);
    expect(paused.reason).toMatch(/PAUSED/);
  });

  it("computes closing-line value toward the pick", () => {
    expect(EV.clv("home", 110, -130, -120, 100)).toBeGreaterThan(0);
    expect(EV.clv("away", 110, -130, -120, 100)).toBeLessThan(0);
  });
});

describe("auto-calibration", () => {
  it("brings an overconfident model's calibration slope back into 0.8–1.2 within 150 games", () => {
    // true p = 0.5 + 0.3·(raw − 0.5): raw is ~3x overconfident (slope ≈ 0.3).
    const slopes = [], improved = [];
    for (let seed = 1; seed <= 20; seed++) {
      const sim = simulate(seed, 10, 15, r => { const raw = 0.1 + 0.8 * r(); return { rawP: raw, trueP: 0.5 + 0.3 * (raw - 0.5), marketP: null }; });
      expect(sim.rows.length).toBe(150);
      // the refit after the 150th graded game
      const state = AC.refit(sim.state, sim.rows, { now: DAY0 + 10 * DAY + 12 * 3600000, asOfDate: "20260411", bestMethod: "isotonic" });
      const ev = [], evRaw = [], r2 = rng(seed + 1000);
      for (let i = 0; i < 20000; i++) {
        const raw = 0.1 + 0.8 * r2(), t = 0.5 + 0.3 * (raw - 0.5);
        ev.push({ p: AC.predict(state, raw, null).calP, y: t });
        evRaw.push({ p: raw, y: t });
      }
      slopes.push(P.calibrationFit(ev).slope);
      improved.push(P.logLoss(ev) < P.logLoss(evRaw));
    }
    const raw = P.calibrationFit(Array.from({ length: 5000 }, (_, i) => { const p = 0.1 + 0.8 * (i / 5000); return { p, y: 0.5 + 0.3 * (p - 0.5) }; })).slope;
    expect(raw).toBeLessThan(0.4);
    const sorted = slopes.slice().sort((a, b) => a - b);
    const median = (sorted[9] + sorted[10]) / 2;
    expect(median).toBeGreaterThanOrEqual(0.8);
    expect(median).toBeLessThanOrEqual(1.2);
    expect(improved.every(Boolean)).toBe(true); // every seed ends better calibrated than raw
  });

  it("pauses a no-edge model and stops the +EV engine from flagging bets", () => {
    const { state, timeline } = simulate(42, 45, 15, r => {
      const t = 1 / (1 + Math.exp(-(0.15 + 0.8 * (r() - 0.5) * 2)));
      return { rawP: 0.3 + 0.4 * r(), trueP: t, marketP: t };
    });
    expect(state.current.paused).toBe(true);
    expect(state.current.w).toBe(1);
    expect(state.current.driftStatus).toBe("red");
    expect(state.log.some(l => l.event === "model-paused")).toBe(true);
    const pausedDay = timeline.findIndex(t => t.paused);
    expect(pausedDay).toBeGreaterThanOrEqual(14);
    const pred = AC.predict(state, 0.8, 0.5);
    expect(pred.finalP).toBeCloseTo(0.5, 10);
    const bet = EV.evaluateBet({ finalP: 0.8, homeML: -110, awayML: -110, paused: pred.paused });
    expect(bet.flag).toBe(false);
  });

  it("keeps the incumbent calibrator when the candidate loses on recent held-out games", () => {
    const { state } = simulate(7, 30, 15, r => { const raw = 0.2 + 0.6 * r(); return { rawP: raw, trueP: raw, marketP: null }; });
    const kept = state.log.filter(l => l.event === "calibrator-kept");
    const promoted = state.log.filter(l => l.event === "calibrator-promoted");
    expect(promoted.length).toBeGreaterThan(0);
    kept.forEach(l => expect(l.detail).toMatch(/held-out LL .* > incumbent/));
    expect(state.current.calibrator.gate).toBeTruthy();
  });

  it("limits market-weight moves to ±0.1 per refit within [0.5, 1]", () => {
    const { timeline } = simulate(11, 30, 15, r => { const t = 0.3 + 0.4 * r(); return { rawP: t, trueP: t, marketP: 0.5 }; });
    for (let i = 1; i < timeline.length; i++) {
      expect(Math.abs(timeline[i].w - timeline[i - 1].w)).toBeLessThanOrEqual(0.1 + 1e-9);
      expect(timeline[i].w).toBeGreaterThanOrEqual(0.5);
      expect(timeline[i].w).toBeLessThanOrEqual(1);
    }
  });

  it("survives a reload: state, versions and history round-trip through storage", () => {
    const { state } = simulate(3, 40, 15, r => { const raw = 0.2 + 0.6 * r(); return { rawP: raw, trueP: raw, marketP: raw }; });
    const store = {};
    const storage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
    expect(AC.save(storage, state)).toBe(true);
    const reloaded = AC.load(storage); // a fresh page reads the same storage
    expect(reloaded).toEqual(JSON.parse(JSON.stringify(state)));
    expect(reloaded.versions.length).toBeGreaterThan(1);
    expect(reloaded.versions.length).toBeLessThanOrEqual(AC.MAX_VERSIONS);
    expect(AC.predict(reloaded, 0.61, null)).toEqual(AC.predict(state, 0.61, null));
    const target = reloaded.versions[0].version;
    const rolled = AC.rollback(reloaded, target, "2026-05-20T00:00:00Z");
    expect(rolled.current.rolledBackFrom).toBe(target);
    expect(rolled.current.calibrator).toEqual(reloaded.versions[0].calibrator);
    storage.setItem(AC.STORAGE_KEY, "{corrupt");
    expect(AC.load(storage)).toBeNull();
  });

  it("refits on dashboard load only when the last fit is more than 24h old", () => {
    const s = AC.refit(null, [], { now: DAY0, asOfDate: "20260401" });
    expect(AC.needsRefit(s, DAY0 + 23 * 3600000)).toBe(false);
    expect(AC.needsRefit(s, DAY0 + 25 * 3600000)).toBe(true);
    expect(AC.needsRefit(null, DAY0)).toBe(true);
  });

  it("keeps at most 30 versions", () => {
    let s = null;
    for (let d = 0; d < 45; d++) s = AC.refit(s, [], { now: DAY0 + d * DAY, asOfDate: ymd(DAY0 + d * DAY), w0: 0.7, modelConfig: { version: "cfg-" + d } });
    expect(s.versions.length).toBe(30);
    expect(s.current.version).toBe(45);
  });
});

describe("coverage check", () => {
  const now = Date.UTC(2026, 6, 1, 23, 0);
  const games = [
    { id: "1", date: "20260701", firstPitch: now + 60 * 60000, status: "scheduled", home: "NYY", away: "BOS" },
    { id: "2", date: "20260701", firstPitch: now + 10 * 60000, status: "scheduled", home: "NYM", away: "PHI" },
    { id: "3", date: "20260701", firstPitch: now - 30 * 60000, status: "in", home: "LAD", away: "SF" },
    { id: "4", date: "20260701", firstPitch: now - 30 * 60000, status: "postponed", home: "CHC", away: "STL" },
    { id: "5", date: "20260701", firstPitch: now - 30 * 60000, status: "in", home: "SEA", away: "TEX" }
  ];
  it("alerts when a scheduled game has no pregame pick 15 minutes before first pitch", () => {
    const alerts = COV.coverageCheck(games, { 5: { gameId: "5" } }, now, { lastRunAt: "2026-07-01T20:00:00Z" });
    const ids = alerts.map(a => a.gameId).sort();
    expect(ids).toEqual(["2", "3"]); // 1 is not yet due, 4 postponed, 5 picked
    expect(alerts.find(a => a.gameId === "3").severity).toBe("missed");
    expect(alerts.find(a => a.gameId === "2").severity).toBe("late");
    expect(alerts.every(a => a.reason)).toBe(true);
  });
  it("uses the API failure as the reason when the day's fetch failed", () => {
    const alerts = COV.coverageCheck([games[2]], {}, now, { apiErrors: { 20260701: "HTTP 503" } });
    expect(alerts[0].reason).toMatch(/HTTP 503/);
  });
});
