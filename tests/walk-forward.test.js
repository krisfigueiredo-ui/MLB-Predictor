import { describe, it, expect } from "vitest";
import {
  chronologicalGames,
  rollingOriginSplits,
  fitPriorShrinkage,
  applyPriorOnlyCalibration,
  walkForwardLogistic
} from "../js/model/walk-forward.js";

function rows(n) {
  return Array.from({ length: n }, (_, i) => ({
    firstPitch: Date.UTC(2026, 3, 1) + i * 86400000,
    feat: { signal: i % 2 ? 1 : -1, noise: (i % 5) - 2 },
    y: i % 2,
    rawProb: i % 2 ? 0.75 : 0.25
  }));
}

describe("rolling-origin validation", () => {
  it("orders records chronologically without mutating the input", () => {
    const input = rows(3).reverse();
    const ordered = chronologicalGames(input);
    expect(ordered[0].firstPitch).toBeLessThan(ordered[2].firstPitch);
    expect(input[0].firstPitch).toBeGreaterThan(input[2].firstPitch);
  });

  it("never includes a test record in its own training period", () => {
    const splits = rollingOriginSplits(rows(12), { minTrain: 5, testSize: 3, step: 3 });
    expect(splits.length).toBe(3);
    splits.forEach(split => {
      expect(split.trainingCutoff).toBeLessThan(split.testStart);
      expect(split.train.every(g => g.firstPitch <= split.trainingCutoff)).toBe(true);
      expect(split.test.every(g => g.firstPitch > split.trainingCutoff)).toBe(true);
    });
  });

  it("fits calibration on prior rows only", () => {
    const calibrated = applyPriorOnlyCalibration(rows(6), "rawProb", { minGames: 3 });
    expect(calibrated[0].calibrationTrainingN).toBe(0);
    expect(calibrated[3].calibrationTrainingN).toBe(3);
    expect(calibrated[5].calibrationTrainingN).toBe(5);
  });

  it("does not fit shrinkage below its minimum sample", () => {
    expect(fitPriorShrinkage(rows(5), "rawProb", { minGames: 10 })).toEqual({
      alpha: 1,
      n: 5,
      fitted: false,
      objective: null
    });
  });

  it("evaluates only unseen, later observations", () => {
    const result = walkForwardLogistic(rows(30), ["signal", "noise"], {
      minTrain: 10,
      testSize: 5,
      step: 5,
      fit: { epochs: 80, lr: 0.1, lambda: 0.02 }
    });
    expect(result.method).toBe("rolling-origin");
    expect(result.n).toBe(20);
    expect(result.folds.every(f => f.trainingCutoff < f.testStart)).toBe(true);
    expect(result.metrics.logLoss).toBeLessThan(0.5);
  });
});
