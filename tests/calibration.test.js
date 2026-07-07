import { describe, it, expect } from "vitest";
import { wilsonCI, logLossAt, calibrationReport } from "../js/calibration.js";

describe("wilsonCI", () => {
  it("returns the widest possible interval for n=0", () => {
    expect(wilsonCI(0, 0)).toEqual([0, 1]);
  });
  it("centers near k/n and narrows as n grows", () => {
    const [lo10, hi10] = wilsonCI(5, 10);
    const [lo1000, hi1000] = wilsonCI(500, 1000);
    expect((lo10 + hi10) / 2).toBeCloseTo(0.5, 1);
    expect(hi1000 - lo1000).toBeLessThan(hi10 - lo10);
  });
  it("never goes outside [0,1]", () => {
    const [lo, hi] = wilsonCI(0, 5);
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(1);
  });
});

describe("logLossAt", () => {
  it("is 0 for perfect, fully-confident correct predictions (after clamping)", () => {
    const pairs = [{ p: 0.995, y: 1 }, { p: 0.995, y: 1 }];
    expect(logLossAt(pairs, 1)).toBeCloseTo(-Math.log(0.995), 6);
  });
  it("penalizes confident wrong predictions heavily", () => {
    const right = logLossAt([{ p: 0.9, y: 1 }], 1);
    const wrong = logLossAt([{ p: 0.9, y: 0 }], 1);
    expect(wrong).toBeGreaterThan(right);
  });
  it("shrinking toward 0.5 reduces loss on a wrong confident prediction", () => {
    const full = logLossAt([{ p: 0.9, y: 0 }], 1);
    const shrunk = logLossAt([{ p: 0.9, y: 0 }], 0.5);
    expect(shrunk).toBeLessThan(full);
  });
});

describe("calibrationReport", () => {
  it("returns null with no data", () => {
    expect(calibrationReport([])).toBeNull();
  });

  it("reports a well-calibrated, confident model as sharp and low-ECE", () => {
    // 100 pairs at p=0.9, 90 wins / 10 losses -> perfectly calibrated at that bin.
    const pairs = [];
    for (let i = 0; i < 90; i++) pairs.push({ p: 0.9, y: 1 });
    for (let i = 0; i < 10; i++) pairs.push({ p: 0.9, y: 0 });
    const r = calibrationReport(pairs);
    expect(r.n).toBe(100);
    expect(r.base).toBeCloseTo(0.9, 5);
    expect(r.ece).toBeCloseTo(0, 5);
    // Sharpness must reflect distance from 50/50, not spread around the mean:
    // every prediction is 0.9, so RMS distance from 0.5 is exactly 0.4.
    expect(r.sharpness).toBeCloseTo(0.4, 5);
  });

  it("regression: sharpness is 0 only for predictions AT 50/50, not merely consistent ones", () => {
    // A model that is always confidently at 0.9 has zero spread around its own
    // mean, but is maximally bold -- sharpness must NOT collapse to 0 here.
    const confidentButConsistent = [
      { p: 0.9, y: 1 }, { p: 0.9, y: 1 }, { p: 0.9, y: 0 }, { p: 0.9, y: 1 },
    ];
    const coinFlip = [
      { p: 0.5, y: 1 }, { p: 0.5, y: 0 }, { p: 0.5, y: 1 }, { p: 0.5, y: 0 },
    ];
    expect(calibrationReport(confidentButConsistent).sharpness).toBeCloseTo(0.4, 5);
    expect(calibrationReport(coinFlip).sharpness).toBeCloseTo(0, 10);
  });

  it("flags a badly miscalibrated (overconfident) model with high ECE and negative BSS", () => {
    // Predicts 0.9 every time but only wins half -> badly overconfident.
    const pairs = [];
    for (let i = 0; i < 50; i++) pairs.push({ p: 0.9, y: 1 });
    for (let i = 0; i < 50; i++) pairs.push({ p: 0.9, y: 0 });
    const r = calibrationReport(pairs);
    expect(r.ece).toBeGreaterThan(0.3);
    expect(r.bss).toBeLessThan(0); // worse than just predicting the base rate
  });

  it("computes curLL using the provided current shrink, defaulting to 1", () => {
    const pairs = [{ p: 0.9, y: 0 }, { p: 0.9, y: 1 }];
    const withDefault = calibrationReport(pairs);
    const explicit1 = calibrationReport(pairs, 1);
    const shrunk = calibrationReport(pairs, 0.5);
    expect(withDefault.curLL).toBeCloseTo(explicit1.curLL, 10);
    expect(shrunk.curLL).not.toBeCloseTo(explicit1.curLL, 5);
  });

  it("satisfies the Brier decomposition identity: brier ≈ reliability - resolution + uncertainty", () => {
    // The identity holds exactly only when every prediction sharing a 0.05-wide
    // bin has the same value (so the bin mean equals each raw forecast) -- use
    // two distinct constant-p groups, each alone in its own bin, to test that
    // cleanly rather than approximately.
    const pairs = [
      { p: 0.6, y: 1 }, { p: 0.6, y: 0 }, { p: 0.6, y: 1 }, { p: 0.6, y: 0 },
      { p: 0.85, y: 1 }, { p: 0.85, y: 1 }, { p: 0.85, y: 0 }, { p: 0.85, y: 1 },
    ];
    const r = calibrationReport(pairs);
    expect(r.reliability - r.resolution + r.uncertainty).toBeCloseTo(r.brier, 10);
  });
});
