import { describe, it, expect } from "vitest";
import { regressAndClampDiff, recordWinPct, l10Pct, teamWinPctCore, pythagExpCore, combineLogitTerms, applyShrinkAndClamp, learningRawFeatures } from "../js/predict-core.js";

describe("regressAndClampDiff", () => {
  it("is mathematically equivalent to regressionFactor*(away-home), pre-clamp (the league average cancels)", () => {
    const lg = 4.10, rg = 0.55;
    const home = 3.20, away = 4.80;
    const expected = rg * (away - home);
    expect(regressAndClampDiff(home, away, lg, rg, 10)).toBeCloseTo(expected, 10);
  });
  it("clamps an extreme regressed difference to the given bound", () => {
    expect(regressAndClampDiff(1.0, 10.0, 4.10, 0.55, 2.2)).toBe(2.2);
    expect(regressAndClampDiff(10.0, 1.0, 4.10, 0.55, 2.2)).toBe(-2.2);
  });
  it("is zero when both sides have the same value", () => {
    expect(regressAndClampDiff(3.5, 3.5, 4.10, 0.55, 2.2)).toBe(0);
  });
});

describe("recordWinPct", () => {
  it("computes win percentage from a normal record", () => {
    expect(recordWinPct("7-3", 0.5)).toBeCloseTo(0.7, 10);
  });
  it("falls back for a scoreless 0-0 record", () => {
    expect(recordWinPct("0-0", 0.5)).toBe(0.5);
  });
  it("falls back for a missing record", () => {
    expect(recordWinPct(undefined, 0.42)).toBe(0.42);
    expect(recordWinPct(null, 0.42)).toBe(0.42);
  });
});

describe("l10Pct", () => {
  it("converts a last-10 record to a fraction", () => {
    expect(l10Pct("6-4")).toBeCloseTo(0.6, 10);
  });
  it("defaults to 0.5 with no last-10 data", () => {
    expect(l10Pct(null)).toBe(0.5);
    expect(l10Pct("")).toBe(0.5);
  });
});

describe("teamWinPctCore", () => {
  it("uses the real record when available", () => {
    expect(teamWinPctCore("30-20", 60)).toBeCloseTo(0.6, 10);
  });
  it("falls back to a PWR-derived estimate for a team with no games played yet", () => {
    const r = teamWinPctCore("0-0", 60);
    expect(r).toBeCloseTo(0.35 + (60 - 50) * 0.0094, 10);
  });
  it("falls back for a missing record entirely", () => {
    expect(teamWinPctCore(null, 60)).toBeCloseTo(0.35 + (60 - 50) * 0.0094, 10);
  });
  it("clamps the PWR-derived fallback to [0.30, 0.70] for extreme power ratings", () => {
    expect(teamWinPctCore(null, 5)).toBe(0.30);
    expect(teamWinPctCore(null, 500)).toBe(0.70);
  });
});

describe("pythagExpCore", () => {
  it("returns 0.5 for a team with a real record but zero games played", () => {
    expect(pythagExpCore("0-0", "+0", 60)).toBe(0.5);
  });
  it("favors a team with a positive run differential over one at .500 win pct", () => {
    // 20-20 record (falls back to win-pct-based path only if rd is missing);
    // with a real, positive run diff, pythag should read above teamWinPctCore's neutral estimate.
    const withGoodRunDiff = pythagExpCore("20-20", "+80", 60);
    expect(withGoodRunDiff).toBeGreaterThan(0.5);
  });
  it("reads below 0.5 for a team allowing more runs than it scores", () => {
    expect(pythagExpCore("20-20", "-80", 60)).toBeLessThan(0.5);
  });
  it("falls back to teamWinPctCore when run differential is missing", () => {
    const fallback = teamWinPctCore("20-15", 60);
    expect(pythagExpCore("20-15", null, 60)).toBeCloseTo(fallback, 10);
  });
  it("falls back to teamWinPctCore when run differential is unparseable", () => {
    const fallback = teamWinPctCore("20-15", 60);
    expect(pythagExpCore("20-15", "garbage", 60)).toBeCloseTo(fallback, 10);
  });
  it("never lets a runs-allowed estimate reach zero (division-by-zero guard)", () => {
    // An enormous positive run differential over few games pushes runs-allowed
    // toward 0; the implementation floors it at 0.1 rather than blowing up.
    expect(() => pythagExpCore("1-0", "+500", 60)).not.toThrow();
    expect(Number.isFinite(pythagExpCore("1-0", "+500", 60))).toBe(true);
  });
});

describe("combineLogitTerms", () => {
  it("sums valid numeric terms", () => {
    expect(combineLogitTerms([0.1, 0.2, 0.3])).toBeCloseTo(0.6, 10);
  });
  it("treats NaN/undefined/null entries as 0 instead of poisoning the sum", () => {
    expect(combineLogitTerms([0.5, NaN, undefined, null, 0.25])).toBeCloseTo(0.75, 10);
  });
  it("returns 0 for an all-invalid input", () => {
    expect(combineLogitTerms([NaN, undefined, null])).toBe(0);
  });
});

describe("learningRawFeatures", () => {
  const base = { hPwr: 70, aPwr: 60, eloEdge: 0.05, lineupDiff: 2, parkFactor: 103 };

  it("computes real pitcher-stat diffs when both sides have realQ/realX data", () => {
    const r = learningRawFeatures(Object.assign({}, base, {
      hPitcher: { xfip: "3.20", whip: "1.05", xwoba: ".290", barrel: "6.5", realQ: true, realX: true },
      aPitcher: { xfip: "4.10", whip: "1.25", xwoba: ".320", barrel: "8.0", realQ: true, realX: true },
    }));
    expect(r.xfip).toBeCloseTo(4.10 - 3.20, 10);
    expect(r.whip).toBeCloseTo(1.25 - 1.05, 10);
    expect(r.xwoba).toBeCloseTo(0.320 - 0.290, 10);
    expect(r.barrel).toBeCloseTo(8.0 - 6.5, 10);
  });

  it("zeroes xfip/whip when realQ is false, even if the underlying numbers differ a lot", () => {
    const r = learningRawFeatures(Object.assign({}, base, {
      hPitcher: { xfip: "2.00", whip: "0.80", xwoba: ".290", barrel: "6.5", realQ: false, realX: true },
      aPitcher: { xfip: "6.00", whip: "1.60", xwoba: ".320", barrel: "8.0", realQ: false, realX: true },
    }));
    expect(r.xfip).toBe(0);
    expect(r.whip).toBe(0);
    // realX still true, so xwoba/barrel should still carry their real diff
    expect(r.xwoba).toBeCloseTo(0.320 - 0.290, 10);
  });

  it("zeroes xwoba/barrel when realX is false (e.g. an ESPN-built game with synthesized stats)", () => {
    const r = learningRawFeatures(Object.assign({}, base, {
      hPitcher: { xfip: "3.20", whip: "1.05", xwoba: ".250", barrel: "4.0", realQ: true, realX: false },
      aPitcher: { xfip: "4.10", whip: "1.25", xwoba: ".400", barrel: "12.0", realQ: true, realX: false },
    }));
    expect(r.xwoba).toBe(0);
    expect(r.barrel).toBe(0);
    // realQ still true, so xfip/whip should still carry their real diff
    expect(r.xfip).toBeCloseTo(4.10 - 3.20, 10);
  });

  it("regression: does not train on synthesized stats for a fully-synthetic (genPitcher) game", () => {
    // genPitcher's default output is {realQ:false, realX:false} -- a typical
    // ESPN daily game with no real overlay applied yet. Every pitcher-stat
    // feature must come back as 0, matching predictFull's own gates, so the
    // gradient step doesn't train on noise the prediction itself ignored.
    const synthPitcher = (xfip) => ({
      xfip: String(xfip), whip: "1.10", xwoba: ".300", barrel: "7.0", synth: true, realQ: false, realX: false,
    });
    const r = learningRawFeatures(Object.assign({}, base, {
      hPitcher: synthPitcher(3.0), aPitcher: synthPitcher(4.5),
    }));
    expect(r.xfip).toBe(0);
    expect(r.whip).toBe(0);
    expect(r.xwoba).toBe(0);
    expect(r.barrel).toBe(0);
  });

  it("never includes a bullpen key -- that feature is pseudo-random and must never be trained on", () => {
    const r = learningRawFeatures(Object.assign({}, base, {
      hPitcher: { xfip: "3.20", whip: "1.05", xwoba: ".290", barrel: "6.5", realQ: true, realX: true },
      aPitcher: { xfip: "4.10", whip: "1.25", xwoba: ".320", barrel: "8.0", realQ: true, realX: true },
    }));
    expect(Object.prototype.hasOwnProperty.call(r, "bullpen")).toBe(false);
  });

  it("always passes through power/elo/lineup/park, which have no honesty gate", () => {
    const r = learningRawFeatures(Object.assign({}, base, { hPitcher: null, aPitcher: null }));
    expect(r.power).toBe(10);
    expect(r.elo).toBe(0.05);
    expect(r.lineup).toBe(2);
    expect(r.park).toBe(3);
  });
});

describe("applyShrinkAndClamp", () => {
  it("returns 0.5 for a logit of 0 regardless of shrink", () => {
    expect(applyShrinkAndClamp(0, 1)).toBe(0.5);
    expect(applyShrinkAndClamp(0, 0.5)).toBe(0.5);
  });
  it("shrink=1 leaves the logistic transform untouched", () => {
    const logit = 0.8;
    const expected = 1 / (1 + Math.exp(-logit));
    expect(applyShrinkAndClamp(logit, 1)).toBeCloseTo(expected, 10);
  });
  it("shrink < 1 pulls the probability toward 0.5", () => {
    const full = applyShrinkAndClamp(2, 1);
    const shrunk = applyShrinkAndClamp(2, 0.5);
    expect(shrunk).toBeLessThan(full);
    expect(shrunk).toBeGreaterThan(0.5);
  });
  it("clamps to the default [0.20, 0.80] honesty ceiling/floor for an extreme logit", () => {
    expect(applyShrinkAndClamp(50, 1)).toBe(0.80);
    expect(applyShrinkAndClamp(-50, 1)).toBe(0.20);
  });
  it("never returns NaN even for a NaN logit", () => {
    expect(applyShrinkAndClamp(NaN, 1)).toBe(0.5);
  });
});
