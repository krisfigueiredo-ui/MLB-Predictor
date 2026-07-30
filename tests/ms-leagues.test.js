import { describe, it, expect } from "vitest";
import {
  buildCatalog, makeLeague, leagueId, espnDate, espnDateRange, scoreboardUrl, newsUrl,
  teamsUrl, standingsUrl, summaryUrl, parseDirectory, mergeDiscovered, findLeague,
  groupBySport, sportLabel, sportDefaults, KINDS
} from "../js/ms-leagues.js";

describe("catalog", () => {
  it("covers every major sport ESPN carries", () => {
    const cat = buildCatalog();
    const sports = new Set(cat.map(l => l.sport));
    ["football", "basketball", "baseball", "hockey", "soccer", "tennis", "golf", "racing", "mma"]
      .forEach(s => expect(sports.has(s)).toBe(true));
  });

  it("has no duplicate league ids", () => {
    const ids = buildCatalog().map(l => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every league the metadata the models need", () => {
    buildCatalog().forEach(l => {
      expect(typeof l.kind).toBe("string");
      expect(Number.isFinite(l.hfa)).toBe(true);
      expect(Number.isFinite(l.k)).toBe(true);
      expect(l.k).toBeGreaterThan(0);
    });
  });

  it("classifies competition kinds by sport", () => {
    const cat = buildCatalog();
    expect(findLeague(cat, "soccer/eng.1").kind).toBe(KINDS.DRAW);
    expect(findLeague(cat, "basketball/nba").kind).toBe(KINDS.TEAM);
    expect(findLeague(cat, "tennis/atp").kind).toBe(KINDS.DUEL);
    expect(findLeague(cat, "golf/pga").kind).toBe(KINDS.FIELD);
    expect(findLeague(cat, "racing/f1").kind).toBe(KINDS.FIELD);
  });

  it("applies per-league overrides over the sport default", () => {
    const cat = buildCatalog();
    // College basketball has a much larger home edge than the NBA.
    expect(findLeague(cat, "basketball/mens-college-basketball").hfa)
      .toBeGreaterThan(findLeague(cat, "basketball/nba").hfa);
    // Baseball moves ratings slowly.
    expect(findLeague(cat, "baseball/mlb").k).toBeLessThan(findLeague(cat, "basketball/nba").k);
  });

  it("zeroes home advantage for neutral-site international competitions", () => {
    const cat = buildCatalog();
    expect(findLeague(cat, "soccer/uefa.super_cup").hfa).toBe(0);
    expect(findLeague(cat, "soccer/fifa.world").hfa)
      .toBeLessThan(findLeague(cat, "soccer/eng.1").hfa);
  });

  it("falls back to generic defaults for an unknown sport", () => {
    const d = sportDefaults("underwater-basket-weaving");
    expect(d.kind).toBe(KINDS.TEAM);
    expect(d.k).toBeGreaterThan(0);
  });
});

describe("espnDate", () => {
  it("packs a Date into YYYYMMDD", () => {
    expect(espnDate(new Date(2025, 0, 5))).toBe("20250105");
    expect(espnDate(new Date(2025, 11, 31))).toBe("20251231");
  });
  it("accepts an ISO date string", () => {
    expect(espnDate("2025-03-09")).toBe("20250309");
    expect(espnDate("20250309")).toBe("20250309");
  });
  it("returns null for junk", () => {
    expect(espnDate(null)).toBeNull();
    expect(espnDate("not-a-date")).toBeNull();
    expect(espnDate(new Date("nope"))).toBeNull();
  });
  it("builds an inclusive range", () => {
    expect(espnDateRange("2025-01-01", "2025-01-31")).toBe("20250101-20250131");
    expect(espnDateRange("bad", "2025-01-31")).toBeNull();
  });
});

describe("endpoint builders", () => {
  const nba = makeLeague("basketball", "nba", "NBA", "NBA", "us");

  it("builds a scoreboard URL with a packed date", () => {
    const u = scoreboardUrl(nba, "2025-02-01");
    expect(u).toContain("/basketball/nba/scoreboard");
    expect(u).toContain("dates=20250201");
  });

  it("passes a packed date range straight through", () => {
    const u = scoreboardUrl(nba, "20250101-20250131");
    expect(u).toContain("dates=20250101-20250131");
  });

  it("always raises the event limit past ESPN's default page size", () => {
    // College slates run to hundreds of games; the default 25 would truncate.
    expect(scoreboardUrl(nba, "2025-02-01")).toContain("limit=900");
  });

  it("omits the dates parameter when no date is given", () => {
    expect(scoreboardUrl(nba, null)).not.toContain("dates=");
  });

  it("builds the other endpoints off the same sport/slug pair", () => {
    expect(newsUrl(nba, 10)).toContain("/basketball/nba/news?limit=10");
    expect(teamsUrl(nba)).toContain("/basketball/nba/teams");
    expect(standingsUrl(nba)).toContain("/basketball/nba/standings");
    expect(standingsUrl(nba, 2024)).toContain("season=2024");
    expect(summaryUrl(nba, "401585")).toContain("summary?event=401585");
  });

  it("handles soccer's dotted slugs without mangling them", () => {
    const epl = makeLeague("soccer", "eng.1", "Premier League", "EPL", "gb-eng");
    expect(scoreboardUrl(epl, "2025-02-01")).toContain("/soccer/eng.1/scoreboard");
  });
});

describe("parseDirectory", () => {
  it("flattens ESPN's sports/leagues directory", () => {
    const payload = {
      sports: [
        { slug: "basketball", leagues: [{ slug: "nba", name: "NBA", abbreviation: "NBA" },
                                        { slug: "wnba", name: "WNBA" }] },
        { slug: "cricket", leagues: [{ slug: "8039", name: "The Ashes" }] }
      ]
    };
    const out = parseDirectory(payload);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ sport: "basketball", slug: "nba", name: "NBA" });
    expect(out[2]).toMatchObject({ sport: "cricket", slug: "8039" });
  });

  it("survives a missing or malformed payload", () => {
    expect(parseDirectory(null)).toEqual([]);
    expect(parseDirectory({})).toEqual([]);
    expect(parseDirectory({ sports: [{ slug: "x" }] })).toEqual([]);
    expect(parseDirectory({ sports: [{ slug: "x", leagues: [{}] }] })).toEqual([]);
  });
});

describe("mergeDiscovered", () => {
  it("adds leagues we never hand-wrote, flagged as discovered", () => {
    const cat = [makeLeague("basketball", "nba", "NBA", "NBA", "us")];
    const merged = mergeDiscovered(cat, [
      { sport: "basketball", slug: "nba", name: "NBA" },
      { sport: "cricket", slug: "8039", name: "The Ashes" }
    ]);
    expect(merged).toHaveLength(2);
    const ashes = findLeague(merged, "cricket/8039");
    expect(ashes.curated).toBe(false);
    expect(ashes.name).toBe("The Ashes");
    // Sport defaults still apply so the models have something to work with.
    expect(ashes.k).toBeGreaterThan(0);
  });

  it("never duplicates a league already in the catalog", () => {
    const cat = buildCatalog();
    const merged = mergeDiscovered(cat, cat.map(l => ({ sport: l.sport, slug: l.slug, name: l.name })));
    expect(merged).toHaveLength(cat.length);
  });

  it("keeps curated metadata rather than letting discovery overwrite it", () => {
    const cat = [makeLeague("baseball", "mlb", "MLB", "MLB", "us")];
    const merged = mergeDiscovered(cat, [{ sport: "baseball", slug: "mlb", name: "Major League Baseball" }]);
    expect(findLeague(merged, "baseball/mlb").k).toBe(6);
    expect(findLeague(merged, "baseball/mlb").curated).toBe(true);
  });

  it("upgrades a placeholder name from the slug to ESPN's real one", () => {
    const cat = [makeLeague("rugby", "270559", null, null, "world")];
    expect(findLeague(cat, "rugby/270559").name).toBe("270559");
    const merged = mergeDiscovered(cat, [{ sport: "rugby", slug: "270559", name: "Six Nations" }]);
    expect(findLeague(merged, "rugby/270559").name).toBe("Six Nations");
  });

  it("ignores malformed discovery rows", () => {
    const cat = [makeLeague("basketball", "nba", "NBA", "NBA", "us")];
    expect(mergeDiscovered(cat, [null, {}, { sport: "x" }, { slug: "y" }])).toHaveLength(1);
  });
});

describe("grouping and labels", () => {
  it("groups leagues by sport preserving first-seen order", () => {
    const groups = groupBySport([
      makeLeague("soccer", "eng.1", "EPL", "EPL", "gb-eng"),
      makeLeague("basketball", "nba", "NBA", "NBA", "us"),
      makeLeague("soccer", "esp.1", "LaLiga", "LAL", "es")
    ]);
    expect(groups.map(g => g.sport)).toEqual(["soccer", "basketball"]);
    expect(groups[0].leagues).toHaveLength(2);
  });

  it("humanises sport slugs", () => {
    expect(sportLabel("mens-college-basketball")).toBe("Mens College Basketball");
    expect(sportLabel("mma")).toBe("MMA");
    expect(sportLabel("soccer")).toBe("Soccer");
  });

  it("builds a stable league id", () => {
    expect(leagueId("soccer", "eng.1")).toBe("soccer/eng.1");
  });
});
