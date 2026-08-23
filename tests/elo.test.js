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

describe("eloRatingChange — half-credit results", () => {
  it("does not treat a tie as a home win when choosing the damping direction", () => {
    // 0.5 is truthy in JavaScript, so `homeWon ? 1 : -1` silently took the
    // home-win branch. A tie has no winner, so the damping term is neutral.
    const home = eloRatingChange(4, 2, 300, 1, 0.6);
    const away = eloRatingChange(4, 2, 300, 0, 0.6);
    const tie = eloRatingChange(4, 2, 300, 0.5, 0.6);

    expect(Math.sign(home)).toBe(1);
    expect(Math.sign(away)).toBe(-1);
    // A tie against a 0.6 expectation is a small negative for the home side,
    // and must sit strictly between the two decisive outcomes.
    expect(tie).toBeLessThan(home);
    expect(tie).toBeGreaterThan(away);
  });

  it("damps a favourite's win more than an underdog's", () => {
    // Same margin, same K: the heavy favourite gains less for the expected result.
    const favourite = eloRatingChange(4, 5, 300, 1, 0.5);
    const underdog = eloRatingChange(4, 5, -300, 1, 0.5);
    expect(favourite).toBeLessThan(underdog);
  });

  it("is symmetric between the two decisive outcomes at an even expectation", () => {
    const home = eloRatingChange(4, 3, 0, 1, 0.5);
    const away = eloRatingChange(4, 3, 0, 0, 0.5);
    expect(home).toBeCloseTo(-away, 10);
  });

  it("falls back to a neutral multiplier for a zero margin", () => {
    // log(0+1) is 0, which would zero out every rating change.
    expect(eloRatingChange(4, 0, 100, 1, 0.5)).toBeCloseTo(4 * 0.5, 10);
  });
});
