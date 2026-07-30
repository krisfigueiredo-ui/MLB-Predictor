import { describe, it, expect } from "vitest";
import {
  parseAmerican, teamMoneyLine, parseOdds, parseStatus, parseCompetitor, parseVenue,
  parseBroadcast, parsePredictor, parseEvent, parseScoreboard, parseNews, parseTeams,
  parseStandings, nextCalendarDate, seasonState
} from "../js/ms-espn.js";
import { makeLeague } from "../js/ms-leagues.js";

const NBA = makeLeague("basketball", "nba", "NBA", "NBA", "us");
const EPL = makeLeague("soccer", "eng.1", "Premier League", "EPL", "gb-eng");
const ATP = makeLeague("tennis", "atp", "ATP Tour", "ATP", "world");
const PGA = makeLeague("golf", "pga", "PGA Tour", "PGA", "us");

describe("parseAmerican", () => {
  it("accepts numbers, signed strings and EVEN", () => {
    expect(parseAmerican(-150)).toBe(-150);
    expect(parseAmerican("+130")).toBe(130);
    expect(parseAmerican("-110")).toBe(-110);
    expect(parseAmerican("EVEN")).toBe(100);
    expect(parseAmerican("pk")).toBe(100);
  });
  it("returns null for absent or unparseable values", () => {
    expect(parseAmerican(null)).toBeNull();
    expect(parseAmerican("")).toBeNull();
    expect(parseAmerican("n/a")).toBeNull();
    expect(parseAmerican(Infinity)).toBeNull();
  });
});

describe("teamMoneyLine", () => {
  it("reads the flat legacy shape", () => {
    expect(teamMoneyLine({ moneyLine: -145 })).toBe(-145);
  });
  it("reads the nested current/open shapes", () => {
    expect(teamMoneyLine({ current: { moneyLine: { american: "+120" } } })).toBe(120);
    expect(teamMoneyLine({ current: { moneyLine: { value: -180 } } })).toBe(-180);
    expect(teamMoneyLine({ open: { moneyLine: "-200" } })).toBe(-200);
  });
  it("prefers current over open", () => {
    expect(teamMoneyLine({ current: { moneyLine: { american: "-110" } }, open: { moneyLine: -150 } })).toBe(-110);
  });
  it("returns null when nothing usable is present", () => {
    expect(teamMoneyLine(null)).toBeNull();
    expect(teamMoneyLine({})).toBeNull();
    expect(teamMoneyLine({ current: {} })).toBeNull();
  });
});

describe("parseOdds", () => {
  it("picks the first provider that actually carries prices", () => {
    const comp = { odds: [
      { provider: { name: "Empty" } },
      { provider: { name: "Real" }, details: "LAL -4.5", overUnder: 224.5, spread: -4.5,
        homeTeamOdds: { moneyLine: -190 }, awayTeamOdds: { moneyLine: 160 } }
    ] };
    const o = parseOdds(comp);
    expect(o.provider).toBe("Real");
    expect(o.homeML).toBe(-190);
    expect(o.awayML).toBe(160);
    expect(o.overUnder).toBe(224.5);
  });
  it("reads a three-way soccer block including the draw", () => {
    const comp = { odds: [{ provider: { name: "X" },
      homeTeamOdds: { moneyLine: 130 }, awayTeamOdds: { moneyLine: 220 }, drawOdds: { moneyLine: 250 } }] };
    const o = parseOdds(comp);
    expect(o.drawML).toBe(250);
  });
  it("returns null when there is no odds array at all", () => {
    expect(parseOdds({})).toBeNull();
    expect(parseOdds({ odds: [] })).toBeNull();
  });
});

describe("parseStatus", () => {
  it("normalises the three states", () => {
    expect(parseStatus({ status: { type: { state: "pre" } } }).state).toBe("pre");
    expect(parseStatus({ status: { type: { state: "in" } } }).live).toBe(true);
    expect(parseStatus({ status: { type: { state: "post", completed: true } } }).final).toBe(true);
  });
  it("carries the clock through for live games", () => {
    const s = parseStatus({ status: { type: { state: "in" }, displayClock: "5:32", clock: 332, period: 3 } });
    expect(s.clock).toBe("5:32");
    expect(s.clockSeconds).toBe(332);
    expect(s.period).toBe(3);
  });
  it("flags postponed games so they are never graded", () => {
    const s = parseStatus({ status: { type: { state: "post", completed: false, description: "Postponed" } } });
    expect(s.cancelled).toBe(true);
  });
  it("defaults to pre when ESPN omits the block entirely", () => {
    expect(parseStatus({}).state).toBe("pre");
    expect(parseStatus(null).state).toBe("pre");
  });
});

describe("parseCompetitor", () => {
  it("flattens a team competitor", () => {
    const c = parseCompetitor({
      id: "13", homeAway: "home", score: "104", winner: true,
      team: { id: "13", displayName: "Los Angeles Lakers", shortDisplayName: "Lakers",
              abbreviation: "LAL", logo: "https://x/lal.png", color: "552583" },
      records: [{ type: "total", summary: "30-20" }, { type: "home", summary: "18-6" }],
      curatedRank: { current: 4 }
    }, {});
    expect(c.name).toBe("Los Angeles Lakers");
    expect(c.abbrev).toBe("LAL");
    expect(c.score).toBe(104);
    expect(c.record).toBe("30-20");
    expect(c.homeRecord).toBe("18-6");
    expect(c.rank).toBe(4);
    expect(c.isAthlete).toBe(false);
  });

  it("flattens an individual athlete (tennis / MMA)", () => {
    const c = parseCompetitor({
      id: "999", score: "2",
      athlete: { id: "999", displayName: "Carlos Alcaraz", shortName: "C. Alcaraz",
                 headshot: { href: "https://x/ca.png" }, flag: { href: "https://x/esp.png" } }
    }, {});
    expect(c.name).toBe("Carlos Alcaraz");
    expect(c.isAthlete).toBe(true);
    expect(c.logo).toBe("https://x/ca.png");
    expect(c.flag).toBe("https://x/esp.png");
  });

  it("joins a doubles pairing into one name", () => {
    const c = parseCompetitor({
      id: "5", athletes: [{ shortName: "R. Ram" }, { shortName: "J. Salisbury" }]
    }, {});
    expect(c.name).toBe("R. Ram / J. Salisbury");
  });

  it("returns null for a missing competitor", () => {
    expect(parseCompetitor(null, {})).toBeNull();
  });
});

describe("parseEvent", () => {
  const baseEvent = {
    id: "401585", date: "2025-02-01T00:30Z", name: "Boston Celtics at Los Angeles Lakers",
    shortName: "BOS @ LAL",
    competitions: [{
      status: { type: { state: "pre" } },
      venue: { fullName: "Crypto.com Arena", address: { city: "Los Angeles" }, indoor: true },
      broadcasts: [{ names: ["ESPN"] }],
      competitors: [
        { id: "13", homeAway: "home", team: { id: "13", displayName: "Lakers", abbreviation: "LAL" } },
        { id: "2", homeAway: "away", team: { id: "2", displayName: "Celtics", abbreviation: "BOS" } }
      ],
      odds: [{ provider: { name: "P" }, homeTeamOdds: { moneyLine: -120 }, awayTeamOdds: { moneyLine: 100 } }]
    }]
  };

  it("splits home and away", () => {
    const g = parseEvent(baseEvent, NBA);
    expect(g.home.abbrev).toBe("LAL");
    expect(g.away.abbrev).toBe("BOS");
    expect(g.venue.name).toBe("Crypto.com Arena");
    expect(g.broadcast).toBe("ESPN");
    expect(g.odds.homeML).toBe(-120);
  });

  it("falls back to slot order when homeAway is absent (neutral/duel events)", () => {
    const ev = JSON.parse(JSON.stringify(baseEvent));
    delete ev.competitions[0].competitors[0].homeAway;
    delete ev.competitions[0].competitors[1].homeAway;
    const g = parseEvent(ev, ATP);
    expect(g.away).not.toBeNull();
    expect(g.home).not.toBeNull();
    expect(g.away.id).toBe("13");   // first slot becomes "away"
    expect(g.home.id).toBe("2");
  });

  it("treats a many-entrant competition as a field event", () => {
    const ev = {
      id: "1", date: "2025-04-10T12:00Z", name: "The Masters",
      competitions: [{ status: { type: { state: "in" } }, competitors: [
        { id: "a", order: 1, score: "-8", athlete: { id: "a", displayName: "Player A" } },
        { id: "b", order: 2, score: "-6", athlete: { id: "b", displayName: "Player B" } },
        { id: "c", order: 3, score: "-5", athlete: { id: "c", displayName: "Player C" } }
      ] }]
    };
    const g = parseEvent(ev, PGA);
    expect(g.isField).toBe(true);
    expect(g.field).toHaveLength(3);
    expect(g.field[0].name).toBe("Player A");
  });

  it("survives an event with no competitions block", () => {
    const g = parseEvent({ id: "9" }, NBA);
    expect(g.id).toBe("9");
    expect(g.competitors).toEqual([]);
  });

  it("returns null for a null event", () => {
    expect(parseEvent(null, NBA)).toBeNull();
  });
});

describe("parseScoreboard", () => {
  it("extracts events, season and calendar", () => {
    const payload = {
      leagues: [{
        name: "Premier League", logos: [{ href: "https://x/epl.png" }],
        season: { year: 2025, type: { type: 2, name: "Regular Season" },
                  startDate: "2024-08-01T00:00Z", endDate: "2025-05-30T00:00Z", displayName: "2024-25" },
        calendar: [{ startDate: "2025-02-01T00:00Z", label: "Matchweek 24" },
                   { startDate: "2025-02-08T00:00Z", label: "Matchweek 25" }]
      }],
      events: [{ id: "1", date: "2025-02-01T15:00Z", competitions: [{ status: { type: { state: "pre" } },
        competitors: [{ id: "a", homeAway: "home", team: { id: "a", displayName: "Arsenal" } },
                      { id: "b", homeAway: "away", team: { id: "b", displayName: "Chelsea" } }] }] }]
    };
    const p = parseScoreboard(payload, EPL);
    expect(p.events).toHaveLength(1);
    expect(p.leagueLogo).toBe("https://x/epl.png");
    expect(p.season.year).toBe(2025);
    expect(p.calendar).toHaveLength(2);
    expect(p.calendar[0].label).toBe("Matchweek 24");
  });

  it("returns an empty shape for a null or empty payload", () => {
    expect(parseScoreboard(null, EPL).events).toEqual([]);
    expect(parseScoreboard({}, EPL).events).toEqual([]);
  });

  it("handles a league that is out of season (no events, calendar present)", () => {
    const p = parseScoreboard({ leagues: [{ calendar: [{ startDate: "2025-09-01T00:00Z" }] }], events: [] }, EPL);
    expect(p.events).toEqual([]);
    expect(p.calendar).toHaveLength(1);
  });
});

describe("nextCalendarDate", () => {
  const parsed = { calendar: [
    { date: "2025-01-01T00:00Z" }, { date: "2025-03-01T00:00Z" }, { date: "2025-02-01T00:00Z" }
  ] };
  it("finds the earliest calendar entry at or after now", () => {
    expect(nextCalendarDate(parsed, "2025-01-15T00:00Z").date).toBe("2025-02-01T00:00Z");
  });
  it("returns null once the calendar is exhausted", () => {
    expect(nextCalendarDate(parsed, "2026-01-01T00:00Z")).toBeNull();
  });
  it("returns null when there is no calendar", () => {
    expect(nextCalendarDate({ calendar: [] }, "2025-01-01T00:00Z")).toBeNull();
  });
});

describe("seasonState", () => {
  const season = { startDate: "2025-09-01T00:00Z", endDate: "2026-05-30T00:00Z", displayName: "2025-26" };
  it("reports preseason with a countdown before the start date", () => {
    const s = seasonState({ season }, "2025-08-01T00:00Z");
    expect(s.state).toBe("preseason");
    expect(s.startsInDays).toBe(31);
  });
  it("reports active inside the window", () => {
    expect(seasonState({ season }, "2025-12-01T00:00Z").state).toBe("active");
  });
  it("reports offseason after the end date", () => {
    expect(seasonState({ season }, "2026-07-01T00:00Z").state).toBe("offseason");
  });
  it("falls back to unknown when ESPN gives no season block and no events", () => {
    expect(seasonState({ events: [] }, "2025-01-01T00:00Z").state).toBe("unknown");
    expect(seasonState({ events: [{}] }, "2025-01-01T00:00Z").state).toBe("active");
  });
});

describe("parseNews", () => {
  it("normalises articles and tags them with the league", () => {
    const out = parseNews({ articles: [{
      id: 44, headline: "Trade deadline live", description: "Latest",
      published: "2025-02-01T10:00Z", images: [{ url: "https://x/i.jpg" }],
      links: { web: { href: "https://espn.com/a" } }, byline: "ESPN staff"
    }] }, NBA);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ headline: "Trade deadline live", image: "https://x/i.jpg",
      link: "https://espn.com/a", leagueId: "basketball/nba", sport: "basketball" });
  });
  it("drops entries with no headline and survives a missing array", () => {
    expect(parseNews({ articles: [{ description: "orphan" }] }, NBA)).toEqual([]);
    expect(parseNews(null, NBA)).toEqual([]);
  });
});

describe("parseTeams", () => {
  it("reads the nested sports/leagues/teams envelope", () => {
    const out = parseTeams({ sports: [{ leagues: [{ teams: [
      { team: { id: "1", displayName: "Arsenal", abbreviation: "ARS", logo: "https://x/a.png",
                record: { items: [{ summary: "20-5-3" }] } } }
    ] }] }] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "1", name: "Arsenal", abbrev: "ARS", record: "20-5-3" });
  });
  it("returns an empty list for junk", () => {
    expect(parseTeams(null)).toEqual([]);
    expect(parseTeams({})).toEqual([]);
  });
});

describe("parseStandings", () => {
  it("walks arbitrarily nested conference/division trees", () => {
    const payload = { children: [
      { name: "Eastern Conference", children: [
        { name: "Atlantic", standings: { entries: [
          { team: { id: "2", displayName: "Celtics", abbreviation: "BOS" },
            stats: [{ name: "wins", value: 40 }, { name: "losses", value: 12 }] }
        ] } }
      ] }
    ] };
    const rows = parseStandings(payload);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ group: "Atlantic", name: "Celtics", wins: 40, losses: 12 });
  });

  it("reads draws for sports that have them", () => {
    const rows = parseStandings({ standings: { entries: [
      { team: { id: "1", displayName: "Arsenal" },
        stats: [{ name: "wins", value: 20 }, { name: "ties", value: 6 }, { name: "points", value: 66 }] }
    ] } });
    expect(rows[0].ties).toBe(6);
    expect(rows[0].points).toBe(66);
  });

  it("returns an empty list when there are no standings", () => {
    expect(parseStandings(null)).toEqual([]);
    expect(parseStandings({})).toEqual([]);
  });
});

describe("parsePredictor", () => {
  it("converts ESPN's percentage projection to a probability", () => {
    const p = parsePredictor({ predictor: { homeTeam: { gameProjection: "62.4" }, awayTeam: { gameProjection: "37.6" } } });
    expect(p.homeWinProb).toBeCloseTo(0.624, 3);
  });
  it("derives the home side from the away projection when only that is present", () => {
    const p = parsePredictor({ predictor: { homeTeam: {}, awayTeam: { gameProjection: 30 } } });
    expect(p.homeWinProb).toBeCloseTo(0.7, 6);
  });
  it("returns null when there is no predictor block", () => {
    expect(parsePredictor({})).toBeNull();
    expect(parsePredictor(null)).toBeNull();
  });
});

describe("parseVenue / parseBroadcast", () => {
  it("reads venue address and flags", () => {
    const v = parseVenue({ venue: { fullName: "Anfield", address: { city: "Liverpool", country: "England" }, indoor: false },
                           neutralSite: true });
    expect(v).toMatchObject({ name: "Anfield", city: "Liverpool", indoor: false, neutral: true });
  });
  it("joins broadcast names and handles the media shape", () => {
    expect(parseBroadcast({ broadcasts: [{ names: ["ESPN", "ESPN2"] }] })).toBe("ESPN, ESPN2");
    expect(parseBroadcast({ broadcasts: [{ media: { shortName: "TNT" } }] })).toBe("TNT");
    expect(parseBroadcast({})).toBeNull();
  });
});
