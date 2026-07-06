import { describe, it, expect } from "vitest";
import { mlToDecimal, decimalToML, kellyStake, pickBetSide, EDGE_THRESHOLD, simWhatIf } from "../js/betting.js";

describe("mlToDecimal / decimalToML", () => {
  it("converts favorite American odds to decimal", () => {
    expect(mlToDecimal(-150)).toBeCloseTo(1.6667, 3);
    expect(mlToDecimal(-200)).toBeCloseTo(1.5, 5);
  });
  it("converts underdog American odds to decimal", () => {
    expect(mlToDecimal(150)).toBeCloseTo(2.5, 5);
    expect(mlToDecimal(100)).toBeCloseTo(2.0, 5);
  });
  it("round-trips through decimalToML for representative odds", () => {
    [-500, -200, -150, -110, 100, 110, 150, 200, 500].forEach((ml) => {
      const dec = mlToDecimal(ml);
      expect(decimalToML(dec)).toBe(ml);
    });
  });
  it("decimalToML(2.0) resolves the even-money boundary to +100", () => {
    // b === 1 exactly: convention is to report even money as +100, not -100.
    expect(decimalToML(2.0)).toBe(100);
  });
});

describe("kellyStake", () => {
  it("returns 0 when there is no edge (fair-odds break-even)", () => {
    // p exactly equal to the market implied probability -> f* == 0
    const decOdds = 2.0; // implied p = 0.5
    expect(kellyStake(0.5, decOdds, 1000, 0.25)).toBe(0);
  });
  it("returns 0 when the model's probability is below the market's implied probability", () => {
    expect(kellyStake(0.4, 2.0, 1000, 0.25)).toBe(0);
  });
  it("stakes a positive amount proportional to edge and bankroll", () => {
    // decOdds 2.0 (implied 50%), true p 0.60 -> b=1, f* = (1*.6-.4)/1 = 0.2
    const full = kellyStake(0.6, 2.0, 1000, 1);
    expect(full).toBeCloseTo(200, 5);
    const quarter = kellyStake(0.6, 2.0, 1000, 0.25);
    expect(quarter).toBeCloseTo(50, 5);
  });
  it("scales linearly with bankroll", () => {
    const a = kellyStake(0.6, 2.0, 1000, 0.25);
    const b = kellyStake(0.6, 2.0, 2000, 0.25);
    expect(b).toBeCloseTo(a * 2, 5);
  });
  it("returns 0 for degenerate decimal odds <= 1 instead of dividing by zero or going negative", () => {
    expect(kellyStake(0.9, 1, 1000, 0.25)).toBe(0);
    expect(kellyStake(0.9, 0.5, 1000, 0.25)).toBe(0);
  });
});

describe("pickBetSide (shared edge-threshold rule)", () => {
  it("picks home when home edge clears the threshold and beats away edge", () => {
    expect(pickBetSide(0.06, 0.01)).toEqual({ pick: "home", edge: 0.06 });
  });
  it("picks away when away edge clears the threshold and beats home edge", () => {
    expect(pickBetSide(0.01, 0.06)).toEqual({ pick: "away", edge: 0.06 });
  });
  it("passes when neither side clears the threshold", () => {
    expect(pickBetSide(0.03, 0.02)).toEqual({ pick: "", edge: 0 });
  });
  it("passes at exactly the threshold (strict > required, not >=)", () => {
    expect(pickBetSide(EDGE_THRESHOLD, 0)).toEqual({ pick: "", edge: 0 });
  });
  it("breaks a tie above threshold in favor of home", () => {
    expect(pickBetSide(0.05, 0.05)).toEqual({ pick: "home", edge: 0.05 });
  });
});

describe("simWhatIf", () => {
  it("compounds wins and losses proportional to the current bankroll", () => {
    const bets = [
      { kStake: 250, ml: 100, won: true },  // f=0.25, dec=2.0 -> profit = stake*1
      { kStake: 250, ml: 100, won: false },
    ];
    const r = simWhatIf(bets, 1000);
    // bet 1: stake=250, win -> bank=1250; bet 2: stake=1250*0.25=312.5, lose -> bank=937.5
    expect(r.final).toBeCloseTo(937.5, 5);
    expect(r.played).toBe(2);
  });
  it("skips bets with no recoverable stake fraction", () => {
    const r = simWhatIf([{ kStake: 0, ml: 100, won: true }], 1000);
    expect(r.final).toBe(1000);
    expect(r.played).toBe(0);
  });
  it("tracks max drawdown across a losing streak", () => {
    const bets = [
      { kStake: 250, ml: 100, won: false },
      { kStake: 250, ml: 100, won: false },
    ];
    const r = simWhatIf(bets, 1000);
    expect(r.maxDD).toBeGreaterThan(0);
    expect(r.profit).toBeLessThan(0);
  });
});
