import { describe, it, expect } from "vitest";
import {
  eloProb, eloChange, regressToMean, davidson, nuFromDrawRate, poissonPmf,
  lambdasFromRatings, dixonColesTau, poissonMatrix, gameWinProb, tiebreakWinProb,
  setWinProb, matchWinProb, tennisFromRatings, plackettLuceWin, fieldTopK,
  americanToProb, probToAmerican, devig, marketProbs, blendLogits, shrink, normalize3,
  logistic, logit
} from "../js/ms-ratings.js";

describe("Elo core", () => {
  it("is a coin flip between equal ratings with no home edge", () => {
    expect(eloProb(1500, 1500, 0)).toBeCloseTo(0.5, 12);
  });
  it("gives the home side the edge from hfa alone", () => {
    expect(eloProb(1500, 1500, 60)).toBeGreaterThan(0.5);
  });
  it("matches the textbook 400-point gap", () => {
    // A 400-point edge is 10:1 odds by construction.
    expect(eloProb(1900, 1500, 0)).toBeCloseTo(10 / 11, 10);
  });
  it("is symmetric under swapping the sides", () => {
    expect(eloProb(1650, 1450, 0)).toBeCloseTo(1 - eloProb(1450, 1650, 0), 12);
  });

  it("moves the winner's rating up and the loser's down", () => {
    const d = eloChange(20, 10, 0, 1, 0.5);
    expect(d).toBeGreaterThan(0);
    expect(eloChange(20, 10, 0, 0, 0.5)).toBeLessThan(0);
  });
  it("moves ratings more for a bigger margin", () => {
    expect(eloChange(20, 30, 0, 1, 0.5)).toBeGreaterThan(eloChange(20, 3, 0, 1, 0.5));
  });
  it("damps a favourite's blowout relative to an underdog's", () => {
    const favourite = eloChange(20, 25, 300, 1, 0.85);
    const underdog = eloChange(20, 25, -300, 1, 0.15);
    expect(underdog).toBeGreaterThan(favourite);
  });
  it("produces no change when the result exactly matches expectation", () => {
    expect(eloChange(20, 5, 0, 0.5, 0.5)).toBeCloseTo(0, 12);
  });

  it("regresses toward the mean between seasons", () => {
    expect(regressToMean(1700, 1500, 0.25)).toBeCloseTo(1650, 10);
    expect(regressToMean(1700, 1500, 0)).toBe(1700);
    expect(regressToMean(1700, 1500, 1)).toBe(1500);
  });
});

describe("Davidson three-way model", () => {
  it("always sums to one", () => {
    [[1500, 1500, 0], [1800, 1400, 60], [1200, 1900, -30]].forEach(([h, a, f]) => {
      const d = davidson(h, a, f, 0.7);
      expect(d.home + d.draw + d.away).toBeCloseTo(1, 12);
    });
  });
  it("reproduces the target draw rate for level sides", () => {
    [0.1, 0.25, 0.35].forEach(rate => {
      const d = davidson(1500, 1500, 0, nuFromDrawRate(rate));
      expect(d.draw).toBeCloseTo(rate, 10);
      expect(d.home).toBeCloseTo(d.away, 12);
    });
  });
  it("lowers the draw probability as the mismatch grows", () => {
    const nu = nuFromDrawRate(0.26);
    expect(davidson(1900, 1400, 0, nu).draw).toBeLessThan(davidson(1500, 1500, 0, nu).draw);
  });
  it("gives no draws at all when nu is zero", () => {
    const d = davidson(1600, 1500, 0, 0);
    expect(d.draw).toBe(0);
    expect(d.home + d.away).toBeCloseTo(1, 12);
  });
  it("clamps a nonsensical draw rate rather than exploding", () => {
    expect(Number.isFinite(nuFromDrawRate(0))).toBe(true);
    expect(Number.isFinite(nuFromDrawRate(1))).toBe(true);
    expect(Number.isFinite(nuFromDrawRate(null))).toBe(true);
  });
});

describe("Poisson goals model", () => {
  it("has a valid pmf", () => {
    let sum = 0;
    for (let k = 0; k <= 30; k++) sum += poissonPmf(1.4, k);
    expect(sum).toBeCloseTo(1, 8);
    expect(poissonPmf(0, 0)).toBe(1);
    expect(poissonPmf(0, 1)).toBe(0);
  });

  it("produces outcome probabilities that sum to one", () => {
    const m = poissonMatrix(1.6, 1.2, { rho: -0.05 });
    expect(m.home + m.draw + m.away).toBeCloseTo(1, 9);
  });

  it("is symmetric for equal scoring rates", () => {
    const m = poissonMatrix(1.35, 1.35, { rho: 0 });
    expect(m.home).toBeCloseTo(m.away, 12);
  });

  it("favours the higher-lambda side", () => {
    const m = poissonMatrix(2.2, 0.9, { rho: -0.05 });
    expect(m.home).toBeGreaterThan(m.away);
  });

  it("derives consistent totals markets", () => {
    const m = poissonMatrix(1.5, 1.3);
    Object.keys(m.totals).forEach(line => {
      expect(m.totals[line].over + m.totals[line].under).toBeCloseTo(1, 9);
    });
    // Higher lines are harder to clear.
    expect(m.totals[3.5].over).toBeLessThan(m.totals[1.5].over);
  });

  it("ranks correct scores by probability", () => {
    const m = poissonMatrix(1.5, 1.1);
    for (let i = 1; i < m.topScores.length; i++) {
      expect(m.topScores[i - 1].p).toBeGreaterThanOrEqual(m.topScores[i].p);
    }
  });

  it("applies the Dixon-Coles low-score correction in the right direction", () => {
    // The correction lifts 0-0 and 1-1 and suppresses 1-0 and 0-1.
    expect(dixonColesTau(0, 0, 1.4, 1.2, -0.05)).toBeGreaterThan(1);
    expect(dixonColesTau(1, 1, 1.4, 1.2, -0.05)).toBeGreaterThan(1);
    expect(dixonColesTau(1, 0, 1.4, 1.2, -0.05)).toBeLessThan(1);
    expect(dixonColesTau(3, 2, 1.4, 1.2, -0.05)).toBe(1);
  });

  it("splits a league total into lambdas that add back up", () => {
    const l = lambdasFromRatings(0, 2.8);
    expect(l.home + l.away).toBeCloseTo(2.8, 9);
    expect(l.home).toBeCloseTo(l.away, 12);
    const skewed = lambdasFromRatings(400, 2.8);
    expect(skewed.home).toBeGreaterThan(skewed.away);
  });

  it("never produces a non-positive lambda even for an absurd gap", () => {
    const l = lambdasFromRatings(-5000, 2.5);
    expect(l.home).toBeGreaterThan(0);
    expect(l.away).toBeGreaterThan(0);
  });
});

describe("tennis hierarchy", () => {
  it("returns an even game from even points", () => {
    expect(gameWinProb(0.5)).toBeCloseTo(0.5, 12);
  });
  it("amplifies a serve edge into a hold", () => {
    // A 64% point win rate is roughly an 81% hold, which is tour-typical.
    const hold = gameWinProb(0.64);
    expect(hold).toBeGreaterThan(0.78);
    expect(hold).toBeLessThan(0.86);
  });
  it("is monotonic in the point probability", () => {
    for (let p = 0.4; p < 0.85; p += 0.05) {
      expect(gameWinProb(p + 0.02)).toBeGreaterThan(gameWinProb(p));
    }
  });

  it("gives an even tiebreak to even players", () => {
    expect(tiebreakWinProb(0.5, 0.5)).toBeCloseTo(0.5, 9);
  });
  it("favours the better player in a tiebreak and stays a probability", () => {
    const p = tiebreakWinProb(0.7, 0.45);
    expect(p).toBeGreaterThan(0.5);
    expect(p).toBeLessThanOrEqual(1);
    expect(tiebreakWinProb(0.3, 0.2)).toBeGreaterThanOrEqual(0);
  });

  it("gives an even set when holds and breaks are mirrored", () => {
    // Holding 80% while breaking 20% is exactly symmetric.
    expect(setWinProb(0.8, 0.2, { tiebreak: 0.5 })).toBeCloseTo(0.5, 9);
    expect(setWinProb(0.5, 0.5, { tiebreak: 0.5 })).toBeCloseTo(0.5, 9);
  });
  it("rewards a better break rate", () => {
    expect(setWinProb(0.8, 0.3, { tiebreak: 0.5 })).toBeGreaterThan(0.5);
  });
  it("supports an advantage (no-tiebreak) final set", () => {
    const p = setWinProb(0.8, 0.25, { advantageSet: true });
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1);
  });

  it("amplifies a set edge over more sets", () => {
    expect(matchWinProb(0.5, 3)).toBeCloseTo(0.5, 12);
    expect(matchWinProb(0.6, 3)).toBeGreaterThan(0.6);
    expect(matchWinProb(0.6, 5)).toBeGreaterThan(matchWinProb(0.6, 3));
    // A worse player is hurt more by a longer match.
    expect(matchWinProb(0.4, 5)).toBeLessThan(matchWinProb(0.4, 3));
  });

  it("drives the whole hierarchy from a rating gap", () => {
    const even = tennisFromRatings(1500, 1500, { bestOf: 3 });
    expect(even.match).toBeCloseTo(0.5, 9);
    const favoured = tennisFromRatings(1800, 1500, { bestOf: 3 });
    expect(favoured.match).toBeGreaterThan(0.75);
    expect(favoured.hold.a).toBeGreaterThan(favoured.hold.b);
    // Every level of the hierarchy stays a probability.
    [favoured.set, favoured.tiebreak, favoured.hold.a, favoured.hold.b].forEach(p => {
      expect(p).toBeGreaterThan(0);
      expect(p).toBeLessThan(1);
    });
  });

  it("keeps a five-setter more decisive than a three-setter for the same gap", () => {
    const bo3 = tennisFromRatings(1700, 1500, { bestOf: 3 }).match;
    const bo5 = tennisFromRatings(1700, 1500, { bestOf: 5 }).match;
    expect(bo5).toBeGreaterThan(bo3);
  });
});

describe("field events", () => {
  it("produces win probabilities that sum to one", () => {
    const p = plackettLuceWin([1700, 1600, 1500, 1450, 1400]);
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
  });
  it("ranks the strongest entrant highest", () => {
    const p = plackettLuceWin([1700, 1600, 1500]);
    expect(p[0]).toBeGreaterThan(p[1]);
    expect(p[1]).toBeGreaterThan(p[2]);
  });
  it("returns a uniform field when everyone is equal", () => {
    const p = plackettLuceWin([1500, 1500, 1500, 1500]);
    p.forEach(v => expect(v).toBeCloseTo(0.25, 12));
  });
  it("handles an empty field", () => {
    expect(plackettLuceWin([])).toEqual([]);
  });

  it("gives top-k probabilities that sum to k", () => {
    const t = fieldTopK([1700, 1600, 1550, 1500, 1450, 1400], 3, { iters: 3000, seed: 1 });
    expect(t.reduce((a, b) => a + b, 0)).toBeCloseTo(3, 6);
    expect(t[0]).toBeGreaterThan(t[5]);
  });
  it("is deterministic for a given seed", () => {
    const a = fieldTopK([1700, 1500, 1400], 2, { iters: 500, seed: 42 });
    const b = fieldTopK([1700, 1500, 1400], 2, { iters: 500, seed: 42 });
    expect(a).toEqual(b);
  });
  it("caps k at the field size", () => {
    const t = fieldTopK([1500, 1500], 5, { iters: 200, seed: 3 });
    t.forEach(v => expect(v).toBeCloseTo(1, 6));
  });
});

describe("odds conversion", () => {
  it("converts american odds to implied probability", () => {
    expect(americanToProb(-150)).toBeCloseTo(0.6, 12);
    expect(americanToProb(150)).toBeCloseTo(0.4, 12);
    expect(americanToProb(100)).toBeCloseTo(0.5, 12);
    expect(americanToProb(null)).toBeNull();
  });
  it("round-trips back to american odds", () => {
    expect(probToAmerican(0.6)).toBe(-150);
    expect(probToAmerican(0.4)).toBe(150);
  });
  it("removes the margin proportionally", () => {
    const out = devig([0.55, 0.5]);
    expect(out[0] + out[1]).toBeCloseTo(1, 12);
    expect(out[0] / out[1]).toBeCloseTo(0.55 / 0.5, 10);
  });
  it("devigs a three-way market and preserves nulls", () => {
    const out = devig([0.45, 0.28, 0.35]);
    expect(out.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(devig([0.5, null])[1]).toBeNull();
  });

  it("builds fair market probabilities and reports the overround", () => {
    const m = marketProbs({ homeML: -150, awayML: 130 });
    expect(m.home + m.away).toBeCloseTo(1, 12);
    expect(m.overround).toBeGreaterThan(1);
    expect(m.draw).toBeNull();
  });
  it("handles a three-way market", () => {
    const m = marketProbs({ homeML: 120, drawML: 240, awayML: 260 });
    expect(m.home + m.draw + m.away).toBeCloseTo(1, 12);
  });
  it("returns null when fewer than two prices are present", () => {
    expect(marketProbs({ homeML: -150 })).toBeNull();
    expect(marketProbs(null)).toBeNull();
  });
});

describe("blending and shrinking", () => {
  it("returns the single estimate when only one has weight", () => {
    expect(blendLogits([{ p: 0.7, w: 1 }, { p: 0.3, w: 0 }])).toBeCloseTo(0.7, 10);
  });
  it("lands between two estimates", () => {
    const b = blendLogits([{ p: 0.6, w: 1 }, { p: 0.8, w: 1 }]);
    expect(b).toBeGreaterThan(0.6);
    expect(b).toBeLessThan(0.8);
  });
  it("ignores null estimates", () => {
    expect(blendLogits([{ p: 0.65, w: 1 }, { p: null, w: 1 }])).toBeCloseTo(0.65, 10);
  });
  it("returns null when nothing has weight", () => {
    expect(blendLogits([{ p: 0.5, w: 0 }])).toBeNull();
    expect(blendLogits([])).toBeNull();
  });

  it("shrinks toward the coin flip", () => {
    expect(shrink(0.8, 0.5)).toBeCloseTo(0.65, 10);
    expect(shrink(0.8, 1)).toBeCloseTo(0.8, 10);
    expect(shrink(0.8, 0)).toBeCloseTo(0.5, 10);
  });

  it("normalises a three-way triple", () => {
    const n = normalize3(2, 1, 1);
    expect(n.home + n.draw + n.away).toBeCloseTo(1, 12);
    expect(n.home).toBeCloseTo(0.5, 12);
    expect(normalize3(0, 0, 0).draw).toBeCloseTo(1 / 3, 12);
  });

  it("round-trips logit and logistic", () => {
    [0.05, 0.5, 0.93].forEach(p => expect(logistic(logit(p))).toBeCloseTo(p, 9));
  });
});
