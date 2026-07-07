import { describe, it, expect } from "vitest";
import { eloSeedFromPower, eloProbFromRatings, eloRatingChange } from "../js/elo.js";

describe("eloSeedFromPower", () => {
  it("maps the league-average power rating (64) to 1500", () => {
    expect(eloSeedFromPower(64)).toBe(1500);
  });
  it("scales linearly around the 1500 baseline", () => {
    expect(eloSeedFromPower(78)).toBeCloseTo(1500 + 14 * 6.5, 6); // e.g. NYY-tier preseason power
    expect(eloSeedFromPower(50)).toBeCloseTo(1500 - 14 * 6.5, 6); // e.g. a rebuilding team
  });
});

describe("eloProbFromRatings", () => {
  it("is exactly 0.5 for equal ratings with no home-field bump", () => {
    expect(eloProbFromRatings(1500, 1500, 0)).toBe(0.5);
  });
  it("gives the home team an edge from the HFA bump alone", () => {
    expect(eloProbFromRatings(1500, 1500, 24)).toBeGreaterThan(0.5);
  });
  it("increases monotonically as the home rating rises", () => {
    const lo = eloProbFromRatings(1450, 1500, 24);
    const hi = eloProbFromRatings(1550, 1500, 24);
    expect(hi).toBeGreaterThan(lo);
  });
  it("matches the standard Elo logistic formula", () => {
    const d = (1550 + 24) - 1500;
    expect(eloProbFromRatings(1550, 1500, 24)).toBeCloseTo(1 / (1 + Math.pow(10, -d / 400)), 10);
  });
});

describe("eloRatingChange", () => {
  it("is zero when the result exactly matches expectation", () => {
    expect(eloRatingChange(6, 3, 100, 1, 1)).toBe(0);
    expect(eloRatingChange(6, 3, 100, 0, 0)).toBe(0);
  });
  it("moves ratings up when the home team beats a favorable expectation", () => {
    const delta = eloRatingChange(6, 3, 0, 1, 0.5);
    expect(delta).toBeGreaterThan(0);
  });
  it("moves ratings down when the home team loses despite being favored", () => {
    const delta = eloRatingChange(6, 3, 200, 0, 0.7);
    expect(delta).toBeLessThan(0);
  });
  it("scales up (diminishing) with a bigger margin of victory, holding surprise constant", () => {
    const small = Math.abs(eloRatingChange(6, 1, 0, 1, 0.5));
    const big = Math.abs(eloRatingChange(6, 10, 0, 1, 0.5));
    expect(big).toBeGreaterThan(small);
  });
  it("damps the rating change for an expected blowout by a big favorite more than an equivalent upset", () => {
    const favoriteWinsBig = Math.abs(eloRatingChange(6, 8, 400, 1, 0.9));
    const underdogWinsBig = Math.abs(eloRatingChange(6, 8, -400, 1, 0.1));
    expect(underdogWinsBig).toBeGreaterThan(favoriteWinsBig);
  });
  it("falls back to a mov multiplier of 1 (not NaN/Infinity/negative) in the degenerate zone", () => {
    // ratingDiff extreme enough to push the mov denominator to/through zero.
    const delta = eloRatingChange(6, 5, -3000, 1, 0.01);
    expect(Number.isFinite(delta)).toBe(true);
    // mov falls back to 1, so delta should equal k*(homeWon-expected) exactly.
    expect(delta).toBeCloseTo(6 * 1 * (1 - 0.01), 10);
  });
});
