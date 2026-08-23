import { describe, it, expect } from "vitest";
import {
  poisPMF,
  pitchSuppress,
  poissonModelCore,
  STARTER_INNINGS_SHARE,
} from "../js/poisson.js";

describe("poisPMF", () => {
  it("matches the textbook Poisson PMF for small k", () => {
    // P(k;lambda) = e^-lambda * lambda^k / k!
    const lam = 4.4;
    expect(poisPMF(0, lam)).toBeCloseTo(Math.exp(-lam), 10);
    expect(poisPMF(1, lam)).toBeCloseTo(Math.exp(-lam) * lam, 10);
    expect(poisPMF(2, lam)).toBeCloseTo(Math.exp(-lam) * Math.pow(lam, 2) / 2, 10);
  });
  it("sums to ~1 across a wide enough range of k", () => {
    const lam = 4.4;
    let total = 0;
    for (let k = 0; k <= 40; k++) total += poisPMF(k, lam);
    expect(total).toBeCloseTo(1, 6);
  });
  it("degenerates to a point mass at 0 for lambda <= 0", () => {
    expect(poisPMF(0, 0)).toBe(1);
    expect(poisPMF(1, 0)).toBe(0);
    expect(poisPMF(0, -1)).toBe(1);
  });
});

describe("pitchSuppress", () => {
  it("is neutral (1) when there is no pitcher", () => {
    expect(pitchSuppress(null)).toBe(1);
    expect(pitchSuppress(undefined)).toBe(1);
  });
  it("is neutral for a non-real or synthesized pitcher line (avoids circularity with PWR)", () => {
    expect(pitchSuppress({ xfip: "2.50", realQ: false })).toBe(1);
    expect(pitchSuppress({ xfip: "2.50", realQ: true, synth: true })).toBe(1);
  });
  it("suppresses scoring for a real ace, blended with a league-average bullpen", () => {
    const s = pitchSuppress({ xfip: "3.50", realQ: true }, 4.10);
    expect(s).toBeLessThan(1);
    // The starter does not throw all nine innings. His ratio applies to his
    // share; the bullpen's share is league average.
    const expected = (3.5 / 4.1) * STARTER_INNINGS_SHARE + (1 - STARTER_INNINGS_SHARE);
    expect(s).toBeCloseTo(expected, 5);
  });
  it("never credits the starter for the whole game", () => {
    // The regression this guards: an ace at 3.00 came out at 0.73, as though he
    // pitched every inning, when a staff fronting him allows about 0.83. The
    // Poisson lambda is directly proportional to this, so the error went
    // straight into the win probability.
    const ace = pitchSuppress({ xfip: "3.00", realQ: true }, 4.10);
    expect(ace).toBeCloseTo(0.826, 3);
    expect(ace).toBeGreaterThan(3.0 / 4.1);
  });
  it("inflates scoring for a real bad pitcher (xfip above league average)", () => {
    const s = pitchSuppress({ xfip: "6.00", realQ: true }, 4.10);
    expect(s).toBeGreaterThan(1);
  });
  it("clamps the starter component to [0.62, 1.45] before blending", () => {
    // The clamp bounds the starter's own ratio, which is where a tiny-sample or
    // malformed xfip enters. The blended staff figure is correspondingly tighter.
    const floor = 0.62 * STARTER_INNINGS_SHARE + (1 - STARTER_INNINGS_SHARE);
    const ceil = 1.45 * STARTER_INNINGS_SHARE + (1 - STARTER_INNINGS_SHARE);
    expect(pitchSuppress({ xfip: "0.50", realQ: true }, 4.10)).toBeCloseTo(floor, 5);
    expect(pitchSuppress({ xfip: "20.0", realQ: true }, 4.10)).toBeCloseTo(ceil, 5);
  });
  it("stays neutral at exactly league average, blend or no blend", () => {
    expect(pitchSuppress({ xfip: "4.10", realQ: true }, 4.10)).toBeCloseTo(1, 10);
  });
});

describe("poissonModelCore", () => {
  const neutral = { parkFactor: 1, homeOff: 1, awayOff: 1, hPitcher: null, aPitcher: null, lgRuns: 4.4, lgXfip: 4.10 };

  it("gives the home team a built-in edge when every other input is neutral", () => {
    const r = poissonModelCore(neutral);
    expect(r.pHome).toBeGreaterThan(0.5);
  });
  it("reports an expected total close to 2x league-average runs when neutral", () => {
    const r = poissonModelCore(neutral);
    expect(r.total).toBeCloseTo(4.4 * 1.03 + 4.4 * 0.99, 1);
  });
  it("favors the home team more as their offense improves", () => {
    const base = poissonModelCore(neutral).pHome;
    const better = poissonModelCore(Object.assign({}, neutral, { homeOff: 1.3 })).pHome;
    expect(better).toBeGreaterThan(base);
  });
  it("favors the home team more when the away pitcher is worse (suppresses the home team less)", () => {
    const withAcePitching = poissonModelCore(Object.assign({}, neutral, { aPitcher: { xfip: "2.0", realQ: true } })).pHome;
    const withBadPitching = poissonModelCore(Object.assign({}, neutral, { aPitcher: { xfip: "6.0", realQ: true } })).pHome;
    expect(withBadPitching).toBeGreaterThan(withAcePitching);
  });
  it("always stays within the [0.05, 0.95] clamp even for lopsided inputs", () => {
    const lopsided = poissonModelCore(Object.assign({}, neutral, { homeOff: 2, awayOff: 0.2, aPitcher: { xfip: "6.0", realQ: true }, hPitcher: { xfip: "2.0", realQ: true } }));
    expect(lopsided.pHome).toBeLessThanOrEqual(0.95);
    expect(lopsided.pHome).toBeGreaterThanOrEqual(0.05);
  });
});
