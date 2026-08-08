import { describe, it, expect } from "vitest";
import {
  logitToProbability,
  calibrateProbability,
  ensembleProbability,
  modelDispersion,
  agreementLabel,
  probabilityPipeline
} from "../js/model/pipeline.js";

describe("probability pipeline", () => {
  it("converts a zero logit to 50%", () => {
    expect(logitToProbability(0)).toBeCloseTo(0.5, 10);
  });

  it("shrinks confidence without a hard probability ceiling", () => {
    expect(calibrateProbability(0.9, 0.5)).toBeCloseTo(0.7, 10);
    expect(calibrateProbability(0.9, 1)).toBeCloseTo(0.9, 10);
  });

  it("renormalizes weights when a base model is unavailable", () => {
    const p = ensembleProbability(
      { elo: 0.6, poisson: null, feature: 0.7 },
      { elo: 0.2, poisson: 0.3, feature: 0.5 }
    );
    expect(p).toBeCloseTo((0.6 * 0.2 + 0.7 * 0.5) / 0.7, 10);
  });

  it("returns neutral instead of NaN when all inputs are invalid", () => {
    expect(ensembleProbability({ elo: NaN }, { elo: 1 })).toBe(0.5);
  });

  it("classifies agreement from base-model dispersion", () => {
    expect(agreementLabel(modelDispersion({ elo: 0.58, poisson: 0.57, feature: 0.59 }))).toBe("Strong");
    expect(agreementLabel(modelDispersion({ elo: 0.68, poisson: 0.49, feature: 0.61 }))).toBe("Low");
  });

  it("returns raw and calibrated outputs separately", () => {
    const result = probabilityPipeline(
      { elo: 0.62, poisson: 0.56, feature: 0.6 },
      { alpha: 0.8, weights: { elo: 0.2, poisson: 0.3, feature: 0.5 } }
    );
    expect(result.rawProbability).toBeGreaterThan(0.5);
    expect(result.calibratedProbability).toBeLessThan(result.rawProbability);
    expect(result.parts.poisson).toBe(0.56);
  });
});
