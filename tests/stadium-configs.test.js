import { describe, it, expect } from "vitest";
import { MLB_STADIUMS, stadiumForTeam, validateStadiumConfig } from "../js/three/stadium-configs.js";

describe("procedural stadium configuration", () => {
  it("ships the six representative parks required for the reusable architecture", () => {
    expect(Object.keys(MLB_STADIUMS).sort()).toEqual(["BOS", "CHC", "CIN", "LAD", "NYY", "TOR"]);
  });

  it("validates every measured configuration", () => {
    Object.values(MLB_STADIUMS).forEach(config => {
      expect(validateStadiumConfig(config)).toEqual({ valid: true, issues: [] });
      expect(config.sourceUrl).toMatch(/^https:\/\/www\.mlb\.com\//);
    });
  });

  it("preserves Fenway's distinctive wall profile", () => {
    const fenway = stadiumForTeam("BOS");
    expect(fenway.wallPoints[0].height).toBe(37);
    expect(fenway.wallPoints.some(point => point.distance === 420)).toBe(true);
  });

  it("falls back to clearly schematic geometry", () => {
    const park = stadiumForTeam("SEA", 92);
    expect(park.schematic).toBe(true);
    expect(park.name).toBe("T-Mobile Park");
    expect(park.wallPoints.every(point => point.measured === false)).toBe(true);
  });
});
