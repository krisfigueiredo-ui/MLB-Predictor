import { describe, it, expect } from "vitest";
import {
  normalCdf, normalInv, clockConfig, parseClockSeconds, soccerMinute, fractionRemaining,
  liveWinProbClock, liveWinProbSoccer, liveWinProbBaseball, liveWinProbTennis,
  runExpectancy, parseSituation, situationSummary, parsePlays, parseWinProbability,
  parseDrives, buildWinProbSeries, winProbSwings, leverageIndex, momentum, analyzeLive
} from "../js/ms-live.js";
import { makeLeague } from "../js/ms-leagues.js";

const NBA = makeLeague("basketball", "nba", "NBA", "NBA", "us");
const NFL = makeLeague("football", "nfl", "NFL", "NFL", "us");
const EPL = makeLeague("soccer", "eng.1", "Premier League", "EPL", "gb-eng");
const MLB = makeLeague("baseball", "mlb", "MLB", "MLB", "us");

describe("normal distribution helpers", () => {
  it("has the right centre and tails", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 8);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 4);
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 4);
  });
  it("inverts itself", () => {
    [0.05, 0.25, 0.5, 0.73, 0.99].forEach(p => {
      expect(normalCdf(normalInv(p))).toBeCloseTo(p, 5);
    });
  });
});

describe("clock parsing", () => {
  it("reads mm:ss", () => {
    expect(parseClockSeconds("8:42")).toBe(522);
    expect(parseClockSeconds("0:31.4")).toBeCloseTo(31.4, 6);
    expect(parseClockSeconds("45")).toBe(45);
    expect(parseClockSeconds("nonsense")).toBeNull();
    expect(parseClockSeconds(null)).toBeNull();
  });
  it("reads soccer's counting-up minute including stoppage", () => {
    expect(soccerMinute("67'", 2)).toBe(67);
    expect(soccerMinute("45'+2'", 1)).toBe(47);
    expect(soccerMinute("90+4", 2)).toBe(94);
  });
  it("knows each league's regulation shape", () => {
    expect(clockConfig(NBA).periods).toBe(4);
    expect(clockConfig(NBA).minutes).toBe(12);
    expect(clockConfig(makeLeague("basketball", "mens-college-basketball", "NCAAM", "NCAAM", "us")).periods).toBe(2);
    expect(clockConfig(makeLeague("hockey", "nhl", "NHL", "NHL", "us")).periods).toBe(3);
    expect(clockConfig(EPL)).toBeNull();      // soccer uses the minute path
  });
});

describe("fractionRemaining", () => {
  it("is 1 before tip and 0 at the final horn", () => {
    expect(fractionRemaining({ state: "pre" }, NBA)).toBe(1);
    expect(fractionRemaining({ state: "in", period: 1, clockSeconds: 720 }, NBA)).toBeCloseTo(1, 9);
    expect(fractionRemaining({ state: "in", period: 4, clockSeconds: 0 }, NBA)).toBe(0);
    expect(fractionRemaining({ state: "post", final: true }, NBA)).toBe(0);
  });
  it("is half way at the start of the third quarter", () => {
    expect(fractionRemaining({ state: "in", period: 3, clockSeconds: 720 }, NBA)).toBeCloseTo(0.5, 9);
  });
  it("returns a small positive floor in overtime", () => {
    const f = fractionRemaining({ state: "in", period: 5, clockSeconds: 200 }, NBA);
    expect(f).toBeGreaterThan(0);
    expect(f).toBeLessThan(0.05);
  });
  it("returns null when the league has no clock config", () => {
    expect(fractionRemaining({ state: "in", period: 1, clockSeconds: 100 }, EPL)).toBeNull();
  });
});

describe("clock-sport in-game win probability", () => {
  it("reproduces the pregame probability exactly at tip-off", () => {
    [0.35, 0.5, 0.62, 0.81].forEach(pre => {
      expect(liveWinProbClock(0, 1, pre, 12)).toBeCloseTo(pre, 5);
    });
  });
  it("collapses to the scoreboard as time runs out", () => {
    expect(liveWinProbClock(20, 0.01, 0.5, 12)).toBeGreaterThan(0.99);
    expect(liveWinProbClock(-20, 0.01, 0.5, 12)).toBeLessThan(0.01);
  });
  it("treats a tie at the horn as a coin flip (overtime)", () => {
    expect(liveWinProbClock(0, 0, 0.75, 12)).toBe(0.5);
  });
  it("is monotonic in the margin", () => {
    for (let m = -15; m < 15; m += 3) {
      expect(liveWinProbClock(m + 3, 0.3, 0.5, 12)).toBeGreaterThan(liveWinProbClock(m, 0.3, 0.5, 12));
    }
  });
  it("makes the same lead safer later in the game", () => {
    expect(liveWinProbClock(8, 0.1, 0.5, 12)).toBeGreaterThan(liveWinProbClock(8, 0.6, 0.5, 12));
  });
  it("makes a lead less safe in a higher-variance sport", () => {
    // College football swings more than the NFL, so the same lead is worth less.
    expect(liveWinProbClock(10, 0.3, 0.5, 16.5)).toBeLessThan(liveWinProbClock(10, 0.3, 0.5, 13.5));
  });
  it("stays a probability at extremes", () => {
    expect(liveWinProbClock(60, 0.5, 0.99, 12)).toBeLessThanOrEqual(1);
    expect(liveWinProbClock(-60, 0.5, 0.01, 12)).toBeGreaterThanOrEqual(0);
  });
});

describe("soccer remaining-goals model", () => {
  it("returns a proper distribution", () => {
    const p = liveWinProbSoccer(0, 90, 1.5, 1.2);
    expect(p.home + p.draw + p.away).toBeCloseTo(1, 9);
  });
  it("is symmetric for equal rates and a level score", () => {
    const p = liveWinProbSoccer(0, 90, 1.35, 1.35);
    expect(p.home).toBeCloseTo(p.away, 12);
  });
  it("resolves to the current score at full time", () => {
    expect(liveWinProbSoccer(0, 0, 1.5, 1.2).draw).toBeCloseTo(1, 5);
    expect(liveWinProbSoccer(1, 0, 1.5, 1.2).home).toBeCloseTo(1, 5);
    expect(liveWinProbSoccer(-2, 0, 1.5, 1.2).away).toBeCloseTo(1, 5);
  });
  it("makes a one-goal lead safer as the clock runs down", () => {
    expect(liveWinProbSoccer(1, 5, 1.4, 1.3).home).toBeGreaterThan(liveWinProbSoccer(1, 60, 1.4, 1.3).home);
  });
  it("keeps the draw alive when level late", () => {
    const p = liveWinProbSoccer(0, 3, 1.4, 1.3);
    expect(p.draw).toBeGreaterThan(0.8);
  });
});

describe("baseball base-out model", () => {
  it("orders run expectancy sensibly", () => {
    expect(runExpectancy(0, 1, 1, 1)).toBeGreaterThan(runExpectancy(0, 0, 0, 0));
    expect(runExpectancy(2, 0, 0, 0)).toBeLessThan(runExpectancy(0, 0, 0, 0));
    expect(runExpectancy(1, 0, 0, 1)).toBeGreaterThan(runExpectancy(1, 1, 0, 0));
  });

  it("gives the home side the walk-off edge when tied in the bottom of the ninth", () => {
    const p = liveWinProbBaseball(0, 9, false, { outs: 0 });
    expect(p).toBeGreaterThan(0.6);
    expect(p).toBeLessThan(0.72);
  });

  it("raises the walk-off probability with runners on", () => {
    const empty = liveWinProbBaseball(0, 9, false, { outs: 0 });
    const loaded = liveWinProbBaseball(0, 9, false, { outs: 0, onFirst: true, onSecond: true, onThird: true });
    expect(loaded).toBeGreaterThan(empty);
    expect(loaded).toBeLessThan(1);
  });

  it("lowers the walk-off probability as outs accumulate", () => {
    expect(liveWinProbBaseball(0, 9, false, { outs: 2 }))
      .toBeLessThan(liveWinProbBaseball(0, 9, false, { outs: 0 }));
  });

  it("treats a lead in the top of the ninth as close to decided", () => {
    expect(liveWinProbBaseball(3, 9, true, { outs: 2 })).toBeGreaterThan(0.95);
  });

  it("is roughly even at the very start of a game", () => {
    const p = liveWinProbBaseball(0, 1, true, { outs: 0 });
    expect(p).toBeGreaterThan(0.44);
    expect(p).toBeLessThan(0.56);
  });

  it("is monotonic in the run margin", () => {
    for (let m = -4; m < 4; m++) {
      expect(liveWinProbBaseball(m + 1, 5, true, { outs: 1 }))
        .toBeGreaterThan(liveWinProbBaseball(m, 5, true, { outs: 1 }));
    }
  });

  it("handles extra innings", () => {
    const p = liveWinProbBaseball(0, 11, false, { outs: 0 });
    expect(p).toBeGreaterThan(0.5);
    expect(p).toBeLessThan(1);
  });
});

describe("tennis live model", () => {
  it("resolves once someone has the sets", () => {
    expect(liveWinProbTennis(2, 0, 0.5, 3)).toBeGreaterThan(0.99);
    expect(liveWinProbTennis(0, 2, 0.5, 3)).toBeLessThan(0.01);
    expect(liveWinProbTennis(3, 1, 0.5, 5)).toBeGreaterThan(0.99);
  });
  it("credits a set lead", () => {
    expect(liveWinProbTennis(1, 0, 0.5, 3)).toBeGreaterThan(0.5);
    expect(liveWinProbTennis(0, 1, 0.5, 3)).toBeLessThan(0.5);
  });
  it("credits progress in the current set", () => {
    expect(liveWinProbTennis(1, 1, 0.85, 3)).toBeGreaterThan(liveWinProbTennis(1, 1, 0.3, 3));
  });
});

describe("ESPN live block parsing", () => {
  it("normalises a football situation", () => {
    const s = parseSituation({ situation: {
      down: 3, distance: 7, yardLine: 42, downDistanceText: "3rd & 7 at LAR 42",
      isRedZone: false, possession: "14", homeTimeouts: 2, awayTimeouts: 3,
      lastPlay: { text: "Pass short right", team: { id: "14" }, scoreValue: 0 }
    } });
    expect(s.down).toBe(3);
    expect(s.possessionTeamId).toBe("14");
    expect(s.lastPlayText).toBe("Pass short right");
    expect(s.homeTimeouts).toBe(2);
  });

  it("normalises a baseball situation including the bases", () => {
    const s = parseSituation({ situation: {
      balls: 2, strikes: 1, outs: 1, onFirst: true, onThird: true,
      pitcher: { athlete: { shortName: "G. Cole" } }, batter: { athlete: { shortName: "A. Judge" } }
    } });
    expect(s.outs).toBe(1);
    expect(s.onFirst).toBe(true);
    expect(s.onSecond).toBe(false);
    expect(s.pitcher).toBe("G. Cole");
  });

  it("returns null when there is no situation block", () => {
    expect(parseSituation({})).toBeNull();
    expect(parseSituation(null)).toBeNull();
  });

  it("writes a readable summary line per sport", () => {
    const fb = situationSummary({ situation: { downDistanceText: "2nd & 4", possessionText: "KC" } }, NFL, {});
    expect(fb).toContain("2nd & 4");
    const bb = situationSummary({ situation: { balls: 3, strikes: 2, outs: 2, onSecond: true } }, MLB, {});
    expect(bb).toContain("3-2");
    expect(bb).toContain("2 outs");
    expect(bb).toContain("2nd");
    const empty = situationSummary({ situation: { balls: 0, strikes: 0, outs: 0 } }, MLB, {});
    expect(empty).toContain("Bases empty");
  });

  it("falls back to the status detail when there is no situation", () => {
    expect(situationSummary({}, NBA, { detail: "End of 3rd" })).toBe("End of 3rd");
  });

  it("normalises plays", () => {
    const plays = parsePlays({ plays: [
      { id: 1, sequenceNumber: "1", text: "Jump ball", period: { number: 1 }, clock: { displayValue: "12:00" },
        homeScore: 0, awayScore: 0, scoringPlay: false },
      { id: 2, text: "3PT made", period: { number: 1 }, clock: { displayValue: "11:42" },
        homeScore: 3, awayScore: 0, scoringPlay: true, scoreValue: 3, team: { id: "13" } }
    ] });
    expect(plays).toHaveLength(2);
    expect(plays[1]).toMatchObject({ scoringPlay: true, homeScore: 3, teamId: "13", period: 1 });
  });

  it("normalises ESPN's own win-probability array, accepting percent or fraction", () => {
    const wp = parseWinProbability({ winprobability: [
      { playId: "1", homeWinPercentage: 0.55 },
      { playId: "2", homeWinPercentage: 61.2 }
    ] });
    expect(wp[0].homeWinProb).toBeCloseTo(0.55, 6);
    expect(wp[1].homeWinProb).toBeCloseTo(0.612, 6);
  });

  it("flattens football drives", () => {
    const d = parseDrives({ drives: {
      previous: [{ id: "1", displayResult: "Touchdown", yards: 75, offensivePlays: 8, isScore: true,
                   timeElapsed: { displayValue: "4:12" }, team: { id: "12" } }],
      current: { id: "2", displayResult: "Punt", yards: 12, offensivePlays: 3 }
    } });
    expect(d).toHaveLength(2);
    expect(d[0]).toMatchObject({ result: "Touchdown", yards: 75, isScore: true });
  });

  it("returns empty lists rather than throwing on missing blocks", () => {
    expect(parsePlays(null)).toEqual([]);
    expect(parseWinProbability({})).toEqual([]);
    expect(parseDrives(null)).toEqual([]);
  });
});

describe("win-probability series and swings", () => {
  const plays = [
    { id: "1", text: "Tip", period: 1, clock: "12:00", homeScore: 0, awayScore: 0, scoringPlay: false },
    { id: "2", text: "3PT", period: 4, clock: "1:00", homeScore: 100, awayScore: 98, scoringPlay: true },
    { id: "3", text: "Turnover", period: 4, clock: "0:20", homeScore: 100, awayScore: 101, scoringPlay: true }
  ];

  it("builds one point per play with a probability", () => {
    const s = buildWinProbSeries(plays, { league: NBA, pregameHomeProb: 0.5 });
    expect(s).toHaveLength(3);
    s.forEach(p => {
      expect(p.homeWinProb).toBeGreaterThan(0);
      expect(p.homeWinProb).toBeLessThan(1);
    });
    // Late lead is worth far more than the same edge at tip-off.
    expect(s[1].homeWinProb).toBeGreaterThan(0.7);
    expect(s[2].homeWinProb).toBeLessThan(0.5);
  });

  it("skips plays with no usable clock or score", () => {
    const s = buildWinProbSeries([{ id: "x", period: 1 }, { id: "y", homeScore: 1, awayScore: 0 }],
      { league: NBA, pregameHomeProb: 0.5 });
    expect(s).toHaveLength(0);
  });

  it("uses the soccer minute path for soccer", () => {
    const s = buildWinProbSeries([
      { id: "1", text: "KO", period: 1, clock: "1'", homeScore: 0, awayScore: 0 },
      { id: "2", text: "Goal", period: 2, clock: "88'", homeScore: 1, awayScore: 0, scoringPlay: true }
    ], { league: EPL, lambdas: { home: 1.5, away: 1.2 } });
    expect(s).toHaveLength(2);
    expect(s[1].homeWinProb).toBeGreaterThan(s[0].homeWinProb);
  });

  it("ranks the biggest swings and signs them correctly", () => {
    const s = buildWinProbSeries(plays, { league: NBA, pregameHomeProb: 0.5 });
    const { series, top } = winProbSwings(s, 3);
    expect(series[0].delta).toBe(0);           // first play has no predecessor
    expect(top[0].absDelta).toBeGreaterThanOrEqual(top[top.length - 1].absDelta);
    // The go-ahead turnover moved probability toward the away side.
    expect(series[2].delta).toBeLessThan(0);
  });

  it("reports momentum over a trailing window", () => {
    const s = buildWinProbSeries(plays, { league: NBA, pregameHomeProb: 0.5 });
    const m = momentum(winProbSwings(s).series, 2);
    expect(m).not.toBeNull();
    expect(m.to).toBeCloseTo(s[2].homeWinProb, 9);
  });

  it("returns null momentum for a series that is too short", () => {
    expect(momentum([], 5)).toBeNull();
    expect(momentum([{ homeWinProb: 0.5 }], 5)).toBeNull();
  });
});

describe("leverage", () => {
  it("is highest in a close game late", () => {
    const tight = leverageIndex({ league: NBA, margin: 0, fracRemaining: 0.03, pregameHomeProb: 0.5 });
    const blowout = leverageIndex({ league: NBA, margin: 28, fracRemaining: 0.03, pregameHomeProb: 0.5 });
    const early = leverageIndex({ league: NBA, margin: 0, fracRemaining: 0.9, pregameHomeProb: 0.5 });
    expect(tight.swing).toBeGreaterThan(blowout.swing);
    expect(tight.swing).toBeGreaterThan(early.swing);
  });
  it("works for soccer and baseball too", () => {
    const soccer = leverageIndex({ league: EPL, margin: 0, fracRemaining: 0.05, lambdas: { home: 1.4, away: 1.3 } });
    expect(soccer.swing).toBeGreaterThan(0);
    const bb = leverageIndex({ league: MLB, margin: 0, fracRemaining: 0.05, inning: 9, isTopInning: false, situation: { outs: 1 } });
    expect(bb.swing).toBeGreaterThan(0);
  });
  it("returns null without a time reference", () => {
    expect(leverageIndex({ league: NBA, margin: 0, fracRemaining: null })).toBeNull();
  });
});

describe("analyzeLive", () => {
  it("produces a clock-model read for basketball", () => {
    const g = {
      status: { state: "in", period: 4, clock: "2:00", clockSeconds: 120, detail: "2:00 - 4th" },
      home: { score: 100 }, away: { score: 96 }
    };
    const a = analyzeLive(g, NBA, { pregameHomeProb: 0.5 });
    expect(a.model).toBe("brownian");
    expect(a.homeWinProb).toBeGreaterThan(0.8);
    expect(a.leverage).not.toBeNull();
  });

  it("produces a three-way read for soccer", () => {
    const g = {
      status: { state: "in", period: 2, clock: "80'", detail: "80'" },
      home: { score: 1 }, away: { score: 1 }
    };
    const a = analyzeLive(g, EPL, { lambdas: { home: 1.5, away: 1.2 } });
    expect(a.model).toBe("poisson-remaining");
    expect(a.threeWay.home + a.threeWay.draw + a.threeWay.away).toBeCloseTo(1, 9);
    expect(a.minute).toBe(80);
  });

  it("produces a base-out read for baseball", () => {
    const g = {
      status: { state: "in", period: 9, detail: "Bottom 9th" },
      home: { score: 4 }, away: { score: 4 },
      situation: { outs: 1, onSecond: true }
    };
    const a = analyzeLive(g, MLB, {});
    expect(a.model).toBe("base-out");
    expect(a.homeWinProb).toBeGreaterThan(0.6);
  });

  it("degrades gracefully when the clock is unreadable", () => {
    const a = analyzeLive({ status: { state: "in", period: 1 }, home: { score: 0 }, away: { score: 0 } }, NBA, {});
    expect(a.homeWinProb).toBeNull();
    expect(a.margin).toBe(0);
  });
});

describe("baseball win-probability series", () => {
  const plays = [
    { id: "1", text: "Groundout", period: 1, periodDisplay: "Top 1st", homeScore: 0, awayScore: 0 },
    { id: "2", text: "Two-run homer", period: 3, periodDisplay: "Bottom 3rd", homeScore: 2, awayScore: 0, scoringPlay: true },
    { id: "3", text: "Solo shot", period: 8, periodDisplay: "Top 8th", homeScore: 2, awayScore: 1, scoringPlay: true }
  ];

  it("charts baseball by inning even though there is no clock", () => {
    const s = buildWinProbSeries(plays, { league: MLB });
    expect(s).toHaveLength(3);
    s.forEach(p => {
      expect(p.homeWinProb).toBeGreaterThan(0);
      expect(p.homeWinProb).toBeLessThan(1);
    });
  });

  it("moves the probability with the score and counts down the innings", () => {
    const s = buildWinProbSeries(plays, { league: MLB });
    expect(s[0].homeWinProb).toBeCloseTo(0.5, 1);                 // 0-0 in the 1st
    expect(s[1].homeWinProb).toBeGreaterThan(s[0].homeWinProb);   // went 2-0 up
    expect(s[2].homeWinProb).toBeGreaterThan(0.5);                // still ahead
    expect(s[0].fracRemaining).toBeGreaterThan(s[2].fracRemaining);
  });

  it("makes the same lead worth more the later it is held", () => {
    const early = buildWinProbSeries(
      [{ id: "a", period: 2, periodDisplay: "Top 2nd", homeScore: 1, awayScore: 0 }], { league: MLB });
    const late = buildWinProbSeries(
      [{ id: "b", period: 8, periodDisplay: "Top 8th", homeScore: 1, awayScore: 0 }], { league: MLB });
    expect(late[0].homeWinProb).toBeGreaterThan(early[0].homeWinProb);
  });

  it("reads the half-inning from the period display", () => {
    const s = buildWinProbSeries(plays, { league: MLB });
    expect(s[1].clock).toBe("Bottom 3rd");
  });

  it("skips plays with no inning", () => {
    expect(buildWinProbSeries([{ id: "x", homeScore: 1, awayScore: 0 }], { league: MLB })).toHaveLength(0);
  });
});

describe("situationSummary fallbacks", () => {
  it("does not claim the bases are empty when ESPN sent no count", () => {
    const out = situationSummary(
      { situation: { lastPlay: { text: "LeBron James makes 25-foot three point jumper" } } },
      MLB, { detail: "3:24 - 4th" }
    );
    expect(out).not.toContain("Bases empty");
    expect(out).toContain("LeBron");
  });

  it("still describes the count when ESPN does send one", () => {
    const out = situationSummary({ situation: { balls: 1, strikes: 2, outs: 0 } }, MLB, {});
    expect(out).toContain("1-2");
    expect(out).toContain("Bases empty");
  });
});

describe("baseball run distribution", () => {
  it("matches published win-probability benchmarks within a couple of points", () => {
    // Reference values are the standard MLB win-expectancy tables.
    const cases = [
      [[0, 1, true, { outs: 0 }], 0.50],
      [[1, 5, true, { outs: 0 }], 0.65],
      [[1, 8, true, { outs: 0 }], 0.75],
      [[3, 9, true, { outs: 0 }], 0.97],
      [[0, 9, false, { outs: 0 }], 0.66],
      [[0, 9, false, { outs: 0, onFirst: true, onSecond: true, onThird: true }], 0.94],
      [[-3, 1, true, { outs: 0 }], 0.22]
    ];
    cases.forEach(([args, expected]) => {
      expect(liveWinProbBaseball(...args)).toBeCloseTo(expected, 1);
    });
  });

  it("stays a valid probability and monotonic in margin across every game state", () => {
    for (let inning = 1; inning <= 10; inning++) {
      for (const isTop of [true, false]) {
        for (let outs = 0; outs <= 2; outs++) {
          let prev = -1;
          for (let m = -8; m <= 8; m++) {
            const p = liveWinProbBaseball(m, inning, isTop, { outs });
            expect(Number.isFinite(p)).toBe(true);
            expect(p).toBeGreaterThanOrEqual(0);
            expect(p).toBeLessThanOrEqual(1);
            expect(p).toBeGreaterThanOrEqual(prev - 1e-9);
            prev = p;
          }
        }
      }
    }
  });

  it("models run scoring as over-dispersed, not Poisson", () => {
    // A 2-run lead in the middle innings must not look as safe as an
    // equal-variance (Poisson) model would make it.
    const p = liveWinProbBaseball(2, 3, false, { outs: 0 });
    expect(p).toBeGreaterThan(0.68);
    expect(p).toBeLessThan(0.82);
  });
});
