import { describe, it, expect } from "vitest";
import {
  sigmoid, seededShuffle, standardize, featureVector, fitLogisticRegression,
  evaluateLogisticRegression, toRawWeights, rocAUC, rocCurve, confusionMatrixStats,
} from "../js/ml-train.js";

describe("sigmoid", () => {
  it("is 0.5 at z=0 and bounded in (0,1)", () => {
    expect(sigmoid(0)).toBe(0.5);
    expect(sigmoid(20)).toBeGreaterThan(0.999);
    expect(sigmoid(-20)).toBeLessThan(0.001);
  });
});

describe("seededShuffle", () => {
  it("is a permutation of the input (same elements, same length)", () => {
    const arr = [1, 2, 3, 4, 5, 6, 7, 8];
    const shuffled = seededShuffle(arr, 42);
    expect(shuffled.length).toBe(arr.length);
    expect(shuffled.slice().sort()).toEqual(arr.slice().sort());
  });
  it("does not mutate the input array", () => {
    const arr = [1, 2, 3, 4, 5];
    const copy = arr.slice();
    seededShuffle(arr, 1);
    expect(arr).toEqual(copy);
  });
  it("is deterministic for a given seed", () => {
    const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(seededShuffle(arr, 777)).toEqual(seededShuffle(arr, 777));
  });
  it("produces a different order for a different seed (overwhelmingly likely)", () => {
    const arr = Array.from({ length: 20 }, (_, i) => i);
    expect(seededShuffle(arr, 1)).not.toEqual(seededShuffle(arr, 2));
  });
});

describe("standardize", () => {
  it("computes mean and (population) std per feature", () => {
    const games = [{ feat: { x: 2 } }, { feat: { x: 4 } }, { feat: { x: 6 } }];
    const { mean, std } = standardize(games, ["x"]);
    expect(mean.x).toBeCloseTo(4, 10);
    expect(std.x).toBeCloseTo(Math.sqrt(((2 - 4) ** 2 + 0 + (6 - 4) ** 2) / 3), 10);
  });
  it("treats a missing feature key as 0", () => {
    const games = [{ feat: {} }, { feat: { x: 2 } }];
    const { mean } = standardize(games, ["x"]);
    expect(mean.x).toBeCloseTo(1, 10);
  });
  it("uses std=1 (not 0) for a constant feature, so downstream division never blows up", () => {
    const games = [{ feat: { x: 5 } }, { feat: { x: 5 } }, { feat: { x: 5 } }];
    const { std } = standardize(games, ["x"]);
    expect(std.x).toBe(1);
  });
});

describe("featureVector", () => {
  it("standardizes each feature to (value-mean)/std", () => {
    const mean = { a: 10, b: 0 }, std = { a: 2, b: 1 };
    const v = featureVector({ feat: { a: 14, b: 3 } }, ["a", "b"], mean, std);
    expect(v).toEqual([2, 3]);
  });
});

describe("fitLogisticRegression + evaluateLogisticRegression", () => {
  it("learns a strong positive weight for a feature perfectly correlated with the label", () => {
    // y=1 whenever x is positive, y=0 whenever x is negative -- linearly separable.
    const games = [];
    for (let i = 1; i <= 20; i++) {
      games.push({ feat: { x: i }, y: 1 });
      games.push({ feat: { x: -i }, y: 0 });
    }
    const { mean, std } = standardize(games, ["x"]);
    const model = fitLogisticRegression(games, ["x"], mean, std, { epochs: 300 });
    expect(model.w[0]).toBeGreaterThan(0);
    const evalResult = evaluateLogisticRegression(games, ["x"], model, mean, std);
    expect(evalResult.acc).toBeGreaterThan(0.95);
  });

  it("the loss curve is non-increasing overall (later loss <= initial loss)", () => {
    const games = [];
    for (let i = 1; i <= 15; i++) {
      games.push({ feat: { x: i }, y: 1 });
      games.push({ feat: { x: -i }, y: 0 });
    }
    const { mean, std } = standardize(games, ["x"]);
    const model = fitLogisticRegression(games, ["x"], mean, std, { epochs: 200 });
    expect(model.lossCurve[model.lossCurve.length - 1]).toBeLessThan(model.lossCurve[0]);
  });

  it("a model fit on one distribution and evaluated on a shifted one degrades honestly (no leakage help)", () => {
    // Regression guard for the standardization-leakage bug: standardization
    // MUST be fit on the training set only. Demonstrate that mean/std computed
    // from train-only data differs from mean/std computed from train+test
    // combined when the two sets have different distributions -- which is
    // exactly the channel through which test-set information used to leak
    // into trainModel()'s reported "honest" held-out accuracy.
    const train = [];
    for (let i = 1; i <= 10; i++) { train.push({ feat: { x: i }, y: 1 }); train.push({ feat: { x: -i }, y: 0 }); }
    const test = [];
    for (let i = 1; i <= 10; i++) { test.push({ feat: { x: i + 100 }, y: 1 }); test.push({ feat: { x: i + 80 }, y: 0 }); }

    const trainOnly = standardize(train, ["x"]);
    const combined = standardize(train.concat(test), ["x"]);
    // The test set's much larger magnitude shifts the combined mean/std far
    // from the train-only mean/std -- proof that fitting on the full set
    // would leak test-set distribution info into how training features are scaled.
    expect(Math.abs(trainOnly.mean.x - combined.mean.x)).toBeGreaterThan(1);
    expect(Math.abs(trainOnly.std.x - combined.std.x)).toBeGreaterThan(1);
  });
});

describe("toRawWeights", () => {
  it("converts a standardized weight back to a raw-feature weight (w/std)", () => {
    const learned = toRawWeights([0.6], 0, ["x"], { x: 10 }, { x: 2 }, "hfa");
    expect(learned.x).toBeCloseTo(0.3, 10);
  });
  it("folds the model intercept entirely into the hfa key", () => {
    // hfa's raw feature is a constant (mean=1, std=1 per predictFull's r.hfa=1),
    // so its own gradient weight is 0 and the global intercept becomes its value.
    const learned = toRawWeights([0, 0.5], 2.5, ["hfa", "x"], { hfa: 1, x: 0 }, { hfa: 1, x: 1 }, "hfa");
    expect(learned.hfa).toBeCloseTo(2.5, 10); // 0 (its own w/std) + intercept(2.5, untouched by x since x's mean=0)
    expect(learned.x).toBeCloseTo(0.5, 10);
  });
});

describe("rocAUC", () => {
  it("is 1.0 for perfect separation (every positive scores above every negative)", () => {
    const pairs = [{ p: 0.9, y: 1 }, { p: 0.8, y: 1 }, { p: 0.3, y: 0 }, { p: 0.1, y: 0 }];
    expect(rocAUC(pairs)).toBe(1);
  });
  it("is 0.0 when every negative outscores every positive", () => {
    const pairs = [{ p: 0.1, y: 1 }, { p: 0.2, y: 1 }, { p: 0.8, y: 0 }, { p: 0.9, y: 0 }];
    expect(rocAUC(pairs)).toBe(0);
  });
  it("is 0.5 for ties across the board (no discriminative power)", () => {
    const pairs = [{ p: 0.5, y: 1 }, { p: 0.5, y: 0 }, { p: 0.5, y: 1 }, { p: 0.5, y: 0 }];
    expect(rocAUC(pairs)).toBe(0.5);
  });
  it("returns null when there's only one class present", () => {
    expect(rocAUC([{ p: 0.8, y: 1 }, { p: 0.6, y: 1 }])).toBeNull();
  });
});

describe("rocCurve", () => {
  it("always starts at (0,0) and ends at (1,1)", () => {
    const pairs = [{ p: 0.9, y: 1 }, { p: 0.7, y: 0 }, { p: 0.4, y: 1 }, { p: 0.2, y: 0 }];
    const pts = rocCurve(pairs);
    expect(pts[0]).toEqual({ fpr: 0, tpr: 0 });
    expect(pts[pts.length - 1]).toEqual({ fpr: 1, tpr: 1 });
  });
  it("fpr and tpr are both non-decreasing along the curve", () => {
    const pairs = [{ p: 0.9, y: 1 }, { p: 0.8, y: 0 }, { p: 0.6, y: 1 }, { p: 0.5, y: 1 }, { p: 0.3, y: 0 }, { p: 0.1, y: 0 }];
    const pts = rocCurve(pairs);
    for (let i = 1; i < pts.length; i++) {
      expect(pts[i].fpr).toBeGreaterThanOrEqual(pts[i - 1].fpr);
      expect(pts[i].tpr).toBeGreaterThanOrEqual(pts[i - 1].tpr);
    }
  });
  it("returns an empty curve when one class is entirely absent", () => {
    expect(rocCurve([{ p: 0.5, y: 1 }, { p: 0.6, y: 1 }])).toEqual([]);
  });
});

describe("confusionMatrixStats", () => {
  it("computes TP/FP/TN/FN at the 0.5 threshold", () => {
    const pairs = [
      { p: 0.9, y: 1 }, // TP
      { p: 0.6, y: 0 }, // FP
      { p: 0.2, y: 0 }, // TN
      { p: 0.4, y: 1 }, // FN
    ];
    const s = confusionMatrixStats(pairs);
    expect(s).toMatchObject({ TP: 1, FP: 1, TN: 1, FN: 1 });
    expect(s.precision).toBeCloseTo(0.5, 10);
    expect(s.recall).toBeCloseTo(0.5, 10);
    expect(s.f1).toBeCloseTo(0.5, 10);
  });
  it("precision is 0 (not NaN) when nothing is predicted positive", () => {
    const pairs = [{ p: 0.1, y: 0 }, { p: 0.2, y: 1 }];
    const s = confusionMatrixStats(pairs);
    expect(s.precision).toBe(0);
  });
  it("perfect predictions give precision=recall=f1=1", () => {
    const pairs = [{ p: 0.9, y: 1 }, { p: 0.8, y: 1 }, { p: 0.1, y: 0 }, { p: 0.2, y: 0 }];
    const s = confusionMatrixStats(pairs);
    expect(s.precision).toBe(1);
    expect(s.recall).toBe(1);
    expect(s.f1).toBe(1);
  });
});
