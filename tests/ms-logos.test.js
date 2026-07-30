import { describe, it, expect } from "vitest";
import {
  initials, hashHue, monogram, teamLogoCandidates, leagueLogoCandidates,
  flagCandidates, isGlobalRegion, competitorBadge, leagueBadge, ISO2_TO_ESPN
} from "../js/ms-logos.js";
import { makeLeague } from "../js/ms-leagues.js";

const MLB = makeLeague("baseball", "mlb", "MLB", "MLB", "us");
const EPL = makeLeague("soccer", "eng.1", "Premier League", "EPL", "gb-eng");
const NCAAM = makeLeague("basketball", "mens-college-basketball", "NCAAM", "NCAAM", "us");
const ATP = makeLeague("tennis", "atp", "ATP Tour", "ATP", "world");

describe("initials", () => {
  it("takes one letter from each significant word", () => {
    expect(initials("Manchester United")).toBe("MU");
    expect(initials("Real Madrid")).toBe("RM");
    expect(initials("Novak Djokovic")).toBe("ND");
  });
  it("strips club-name noise words, leaving the distinctive word", () => {
    expect(initials("FC Barcelona")).toBe("BAR");
    expect(initials("AC Milan")).toBe("MIL");
    expect(initials("Real Sociedad")).toBe("RS");
  });
  it("passes short all-caps abbreviations through", () => {
    expect(initials("PSG")).toBe("PSG");
    expect(initials("LAL")).toBe("LAL");
  });
  it("handles a single word and empty input", () => {
    expect(initials("Arsenal")).toBe("ARS");
    expect(initials("")).toBe("?");
    expect(initials(null)).toBe("?");
  });
});

describe("monogram", () => {
  it("is a self-contained data URI that fetches nothing", () => {
    const m = monogram("Arsenal");
    expect(m.startsWith("data:image/svg+xml")).toBe(true);
    const decoded = decodeURIComponent(m.split(",")[1]);
    // The only http reference allowed is the SVG XML namespace, which is an
    // identifier and never dereferenced.
    expect(decoded.replace("http://www.w3.org/2000/svg", "")).not.toContain("http");
    expect(decoded).not.toContain("espncdn");
  });
  it("is stable for the same name and differs across names", () => {
    expect(monogram("Arsenal")).toBe(monogram("Arsenal"));
    expect(monogram("Arsenal")).not.toBe(monogram("Chelsea"));
    expect(hashHue("Arsenal")).toBe(hashHue("Arsenal"));
  });
  it("escapes characters that would break the SVG", () => {
    const m = monogram('A&B<C>D"E');
    const decoded = decodeURIComponent(m.split(",")[1]);
    // The label is sanitised, so no raw markup characters survive in the text.
    expect(decoded).not.toContain("&B");
    expect(decoded).not.toContain("<C");
  });
  it("produces a light and a dark variant", () => {
    expect(monogram("Arsenal", { dark: true })).not.toBe(monogram("Arsenal", { dark: false }));
  });
});

describe("teamLogoCandidates", () => {
  it("puts the URL ESPN gave us first", () => {
    const c = teamLogoCandidates({ id: "10", abbrev: "NYY", logo: "https://cdn/from-payload.png" }, MLB);
    expect(c[0]).toBe("https://cdn/from-payload.png");
  });

  it("falls back to the abbreviation folder for US majors", () => {
    const c = teamLogoCandidates({ id: "10", abbrev: "NYY" }, MLB);
    expect(c.some(u => u.includes("/teamlogos/mlb/500/nyy.png"))).toBe(true);
  });

  it("uses the numeric team id for soccer, which has no abbreviation folder", () => {
    const c = teamLogoCandidates({ id: "359", abbrev: "ARS" }, EPL);
    expect(c.some(u => u.includes("/teamlogos/soccer/500/359.png"))).toBe(true);
  });

  it("tries the NCAA folder for college leagues", () => {
    const c = teamLogoCandidates({ id: "150", abbrev: "DUKE" }, NCAAM);
    expect(c.some(u => u.includes("/teamlogos/ncaa/500/150.png"))).toBe(true);
  });

  it("adds a headshot path for individual athletes", () => {
    const c = teamLogoCandidates({ id: "1234", isAthlete: true }, ATP);
    expect(c.some(u => u.includes("/headshots/tennis/players/full/1234.png"))).toBe(true);
  });

  it("never repeats a candidate", () => {
    const c = teamLogoCandidates({ id: "10", abbrev: "NYY", logo: "https://x.png" }, MLB);
    expect(new Set(c).size).toBe(c.length);
  });

  it("returns something usable even for an empty competitor", () => {
    expect(Array.isArray(teamLogoCandidates({}, MLB))).toBe(true);
    expect(Array.isArray(teamLogoCandidates(null, null))).toBe(true);
  });

  it("skips id-based paths when the id is not numeric", () => {
    const c = teamLogoCandidates({ id: "not-a-number", abbrev: "XYZ" }, EPL);
    expect(c.every(u => !u.includes("not-a-number"))).toBe(true);
  });
});

describe("leagueLogoCandidates", () => {
  it("prefers the runtime logo from the scoreboard payload", () => {
    const c = leagueLogoCandidates(EPL, "https://cdn/epl-runtime.png");
    expect(c[0]).toBe("https://cdn/epl-runtime.png");
  });
  it("offers CDN guesses when there is no runtime logo", () => {
    const c = leagueLogoCandidates(MLB, null);
    expect(c.length).toBeGreaterThan(0);
    expect(c.some(u => u.includes("mlb"))).toBe(true);
  });
  it("handles a null league", () => {
    expect(leagueLogoCandidates(null, null)).toEqual([]);
    expect(leagueLogoCandidates(null, "https://x.png")).toEqual(["https://x.png"]);
  });
});

describe("flagCandidates", () => {
  it("maps ISO-2 to ESPN's 3-letter country codes", () => {
    expect(flagCandidates("es").some(u => u.includes("/countries/500/esp.png"))).toBe(true);
    expect(flagCandidates("de").some(u => u.includes("/countries/500/ger.png"))).toBe(true);
    expect(flagCandidates("sa").some(u => u.includes("/countries/500/ksa.png"))).toBe(true);
  });
  it("handles the UK home nations", () => {
    expect(flagCandidates("gb-eng").some(u => u.includes("eng.png"))).toBe(true);
    expect(flagCandidates("gb-sct").some(u => u.includes("sco.png"))).toBe(true);
  });
  it("returns nothing for an international competition", () => {
    expect(flagCandidates("world")).toEqual([]);
    expect(flagCandidates(null)).toEqual([]);
  });
  it("still offers a candidate for a country not in the map", () => {
    expect(flagCandidates("zz").length).toBeGreaterThan(0);
  });
  it("recognises global regions", () => {
    expect(isGlobalRegion("world")).toBe(true);
    expect(isGlobalRegion("")).toBe(true);
    expect(isGlobalRegion("us")).toBe(false);
  });
  it("maps every region used by the catalog or leaves a usable fallback", () => {
    Object.keys(ISO2_TO_ESPN).forEach(k => {
      expect(typeof ISO2_TO_ESPN[k]).toBe("string");
      expect(ISO2_TO_ESPN[k].length).toBe(3);
    });
  });
});

describe("badges", () => {
  it("always ends the chain with a monogram that cannot fail", () => {
    const b = competitorBadge({ id: "1", shortName: "Arsenal" }, EPL);
    expect(b.fallback.startsWith("data:image/svg+xml")).toBe(true);
    expect(b.label).toBe("Arsenal");
  });
  it("labels an unknown competitor rather than rendering blank", () => {
    expect(competitorBadge({}, EPL).label).toBe("TBD");
  });
  it("bundles league crest, flag and fallback together", () => {
    const b = leagueBadge(EPL, null);
    expect(b.candidates.length).toBeGreaterThan(0);
    expect(b.flags.length).toBeGreaterThan(0);
    expect(b.global).toBe(false);
    expect(b.label).toBe("Premier League");
  });
  it("marks an international competition as global", () => {
    const ucl = makeLeague("soccer", "uefa.champions", "UCL", "UCL", "world");
    expect(leagueBadge(ucl, null).global).toBe(true);
    expect(leagueBadge(ucl, null).flags).toEqual([]);
  });
});
