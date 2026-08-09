import { describe, it, expect } from "vitest";
import { MLB_STADIUMS, stadiumForTeam, assemblyFingerprint, validateStadiumConfig } from "../js/three/stadium-configs.js";

describe("stadium-specific configuration", () => {
  it("ships a complete 30-park assembly registry", () => {
    expect(Object.keys(MLB_STADIUMS)).toHaveLength(30);
    expect(new Set(Object.values(MLB_STADIUMS).map(assemblyFingerprint)).size).toBe(30);
  });

  it("validates every park assembly", () => {
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

  it("preserves signature architecture for the required visual QA parks", () => {
    expect(stadiumForTeam("NYY").architecture).toBe("monument");
    expect(stadiumForTeam("CHC").architecture).toBe("ivy");
    expect(stadiumForTeam("PHI").architecture).toBe("liberty-bell");
    expect(stadiumForTeam("PHI").wallPoints.some(point => point.distance === 409 && point.height === 19)).toBe(true);
    expect(stadiumForTeam("SF").architecture).toBe("cove");
    expect(stadiumForTeam("SF").wallPoints.some(point => point.distance === 415)).toBe(true);
  });

  it("configures the remaining clubs as named home-park profiles", () => {
    const park = stadiumForTeam("SEA", 92);
    expect(park.schematic).toBe(false);
    expect(park.name).toBe("T-Mobile Park");
    expect(park.city).toBe("Seattle, Washington");
    expect(park.distinctive).toMatch(/roof/i);
    expect(park.sourceUrl).toMatch(/^https:\/\/www\.mlb\.com\//);
    expect(validateStadiumConfig(park)).toEqual({ valid: true, issues: [] });
  });

  it("resolves every MLB club to a non-generic named home park", () => {
    const clubs = ["AZ","ATL","BAL","BOS","CHC","CIN","CLE","COL","CWS","DET","HOU","KC","LAA","LAD","MIA","MIL","MIN","NYM","NYY","ATH","PHI","PIT","SD","SEA","SF","STL","TB","TEX","TOR","WSH"];
    clubs.forEach(team => {
      const park = stadiumForTeam(team);
      expect(park.name).not.toBe("MLB Ballpark");
      expect(park.schematic).not.toBe(true);
      expect(validateStadiumConfig(park).valid).toBe(true);
    });
  });
});
