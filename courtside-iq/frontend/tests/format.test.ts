import { describe, expect, it } from "vitest";

import { american, num, pct, periodLabel, signed, spreadLine } from "@/lib/format";

describe("format helpers", () => {
  it("formats probabilities and numbers", () => {
    expect(pct(0.5234)).toBe("52.3%");
    expect(pct(null)).toBe("—");
    expect(num(3.14159, 2)).toBe("3.14");
    expect(signed(2.5)).toBe("+2.5");
    expect(signed(-1.25, 2)).toBe("−1.25");
  });
  it("formats betting lines", () => {
    expect(american(150)).toBe("+150");
    expect(american(-110)).toBe("-110");
    expect(spreadLine(-5.5)).toBe("-5.5");
    expect(spreadLine(3)).toBe("+3.0");
    expect(spreadLine(0)).toBe("PK");
  });
  it("labels game periods per league", () => {
    expect(periodLabel("NBA", 3, "5:12", "live")).toBe("Q3 5:12");
    expect(periodLabel("NBA", 5, "1:00", "live")).toBe("OT 1:00");
    expect(periodLabel("CBB", 2, "10:00", "live")).toBe("2nd H 10:00");
    expect(periodLabel("CBB", 1, null, "final")).toBe("FINAL");
    expect(periodLabel("NBA", null, null, "scheduled")).toBeNull();
  });
});
