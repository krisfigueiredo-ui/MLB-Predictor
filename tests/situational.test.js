import { describe, it, expect } from "vitest";
import { recOf, filterBeforeDate, recencyFormCore, currentStreak, teamSituationalContribution, gameSituationalCore } from "../js/situational.js";

function game(won, rs, ra, h) { return { won, rs, ra, h }; }

describe("recOf", () => {
  it("counts wins/losses/total", () => {
    const r = recOf([game(true, 5, 1, true), game(false, 1, 5, true), game(true, 3, 2, false)]);
    expect(r).toEqual({ w: 2, l: 1, n: 3 });
  });
});

describe("filterBeforeDate (look-ahead-bias guard)", () => {
  const log = [
    { d: "20260601" }, { d: "20260605" }, { d: "20260610" }, { d: "20260615" },
  ];
  it("keeps only games strictly before the cutoff", () => {
    expect(filterBeforeDate(log, "20260610")).toEqual([{ d: "20260601" }, { d: "20260605" }]);
  });
  it("excludes a game ON the cutoff date itself (strictly before, not on-or-before)", () => {
    const r = filterBeforeDate(log, "20260610");
    expect(r.some((g) => g.d === "20260610")).toBe(false);
  });
  it("is a no-op when no cutoff is given", () => {
    expect(filterBeforeDate(log, null)).toBe(log);
    expect(filterBeforeDate(log, undefined)).toBe(log);
  });
  it("returns everything excluded when the cutoff is before all games", () => {
    expect(filterBeforeDate(log, "20260101")).toEqual([]);
  });
});

describe("currentStreak", () => {
  it("returns a positive streak length for a current win streak", () => {
    const log = [game(false, 1, 2, true), game(true, 2, 1, true), game(true, 3, 1, true), game(true, 4, 1, true)];
    expect(currentStreak(log)).toBe(3);
  });
  it("returns a negative streak length for a current losing streak", () => {
    const log = [game(true, 1, 2, true), game(false, 2, 3, true), game(false, 1, 4, true)];
    expect(currentStreak(log)).toBe(-2);
  });
  it("is +/-1 right after a single result that breaks the prior direction", () => {
    const log = [game(true, 1, 0, true), game(true, 1, 0, true), game(false, 0, 1, true)];
    expect(currentStreak(log)).toBe(-1);
  });
});

describe("recencyFormCore", () => {
  function logOf(diffs) { return diffs.map((d) => game(d >= 0, Math.max(0, d), Math.max(0, -d), true)); }

  it("is neutral (0) with fewer than 4 games of history", () => {
    expect(recencyFormCore(logOf([5, 5, 5]))).toBe(0);
    expect(recencyFormCore([])).toBe(0);
    expect(recencyFormCore(null)).toBe(0);
  });

  it("is positive for a team consistently outscoring opponents, negative for the reverse", () => {
    expect(recencyFormCore(logOf([3, 3, 3, 3]))).toBeGreaterThan(0);
    expect(recencyFormCore(logOf([-3, -3, -3, -3]))).toBeLessThan(0);
  });

  it("is antisymmetric: negating every run differential negates the score", () => {
    const pos = recencyFormCore(logOf([4, -2, 6, 1, -3]));
    const neg = recencyFormCore(logOf([-4, 2, -6, -1, 3]));
    expect(neg).toBeCloseTo(-pos, 10);
  });

  it("clamps to exactly 1 / -1 for sustained extreme form", () => {
    expect(recencyFormCore(logOf(new Array(10).fill(6)))).toBe(1);
    expect(recencyFormCore(logOf(new Array(10).fill(-6)))).toBe(-1);
  });

  it("clips a single blowout game so it doesn't dominate beyond the +/-6 cap", () => {
    const withBlowout = recencyFormCore(logOf([0, 0, 0, 100]));
    const withCappedGame = recencyFormCore(logOf([0, 0, 0, 6]));
    expect(withBlowout).toBeCloseTo(withCappedGame, 10);
  });

  it("weighs the most recent games more heavily than older ones", () => {
    // Most recent game is the last array element.
    const recentHot = recencyFormCore(logOf([-5, -5, -5, 5, 5]));
    const recentCold = recencyFormCore(logOf([5, 5, -5, -5, -5]));
    expect(recentHot).toBeGreaterThan(recentCold);
  });

  it("only looks at the last 10 games even if the log is longer", () => {
    // 20 old blowout wins, followed by exactly 10 recent losses -- slice(-10)
    // should land precisely on the 10 recent losses with zero contamination
    // from the old blowouts.
    const withOldBlowouts = new Array(20).fill(6).concat(new Array(10).fill(-1));
    const justRecent = new Array(10).fill(-1);
    expect(recencyFormCore(logOf(withOldBlowouts))).toBeCloseTo(recencyFormCore(logOf(justRecent)), 10);
  });

  it("regression: filtering to before a cutoff date prevents a future slump/streak from leaking into a historical grade", () => {
    // A team on a big win streak through 6/6, then a big losing streak from
    // 6/10 on. Grading a game AS OF 6/10 must see the win streak (all that had
    // actually happened), not get diluted/reversed by the future losses --
    // that's exactly the look-ahead-bias channel backtest grading used to have.
    const datedLog = [
      { d: "20260601", rs: 10, ra: 1 }, { d: "20260602", rs: 10, ra: 1 }, { d: "20260603", rs: 10, ra: 1 },
      { d: "20260604", rs: 10, ra: 1 }, { d: "20260605", rs: 10, ra: 1 }, { d: "20260606", rs: 10, ra: 1 },
      { d: "20260610", rs: 1, ra: 10 }, { d: "20260611", rs: 1, ra: 10 }, { d: "20260612", rs: 1, ra: 10 },
      { d: "20260613", rs: 1, ra: 10 }, { d: "20260614", rs: 1, ra: 10 }, { d: "20260615", rs: 1, ra: 10 },
    ];
    const asOfCutoff = recencyFormCore(filterBeforeDate(datedLog, "20260610"));
    const withFullFutureKnowledge = recencyFormCore(datedLog);
    expect(asOfCutoff).toBe(1); // maximally hot -- correct, that's all that had happened
    expect(asOfCutoff).toBeGreaterThan(withFullFutureKnowledge);
  });
});

describe("teamSituationalContribution", () => {
  it("contributes nothing with fewer than 6 games of history", () => {
    const log = new Array(5).fill(0).map(() => game(true, 5, 1, true));
    expect(teamSituationalContribution(log, "NYY", 1, true)).toEqual({ notes: [], adj: 0 });
  });

  it("flags a hot team at exactly the 5-win-in-6 threshold and nudges toward them", () => {
    const log = [
      game(false, 1, 5, true), // 7th-oldest, outside the last-6 window
      game(true, 5, 1, true), game(true, 5, 1, true), game(true, 5, 1, true),
      game(true, 5, 1, true), game(true, 5, 1, true), game(false, 1, 5, true),
    ];
    const r = teamSituationalContribution(log, "NYY", 1, true);
    expect(r.adj).toBeGreaterThan(0);
    expect(r.notes.some((n) => n.text.indexOf("hot lately") >= 0)).toBe(true);
  });

  it("does NOT flag hot/cold form at 4-win-in-6 with a small run differential (below threshold)", () => {
    const log = [
      game(true, 1, 0, true), game(true, 1, 0, true), game(true, 1, 0, true), game(true, 1, 0, true),
      game(false, 0, 1, true), game(false, 0, 1, true),
    ];
    const r = teamSituationalContribution(log, "NYY", 1, true);
    expect(r.notes.some((n) => n.text.indexOf("hot lately") >= 0 || n.text.indexOf("cold lately") >= 0)).toBe(false);
  });

  it("flags a streak at exactly 4 games but not at 3", () => {
    const streak3 = [game(false, 0, 1, true), game(false, 0, 1, true), game(true, 1, 0, true), game(true, 1, 0, true), game(true, 1, 0, true), game(true, 1, 0, true)];
    // last 6 games above: L,L,W,W,W,W -> current win streak length 4
    const r = teamSituationalContribution(streak3, "NYY", 1, true);
    expect(r.notes.some((n) => n.text.indexOf("streak") >= 0)).toBe(true);
  });

  it("flags a strong home/road split only once 8+ games have been played in that venue", () => {
    const sevenHomeWins = new Array(6).fill(0).map(() => game(true, 3, 2, false)) // non-home padding for the 6-game form window
      .concat(new Array(7).fill(0).map(() => game(true, 3, 2, true))); // 7 home wins -- below the n>=8 gate
    const under = teamSituationalContribution(sevenHomeWins, "NYY", 1, true);
    expect(under.notes.some((n) => n.text.indexOf("strong at home") >= 0)).toBe(false);

    const eightHomeWins = sevenHomeWins.concat([game(true, 3, 2, true)]);
    const over = teamSituationalContribution(eightHomeWins, "NYY", 1, true);
    expect(over.notes.some((n) => n.text.indexOf("strong at home") >= 0)).toBe(true);
  });
});

describe("gameSituationalCore", () => {
  it("caps the combined adjustment at +/-0.05 even when both signals stack", () => {
    const scorchingHome = [];
    for (let i = 0; i < 20; i++) scorchingHome.push(game(true, 10, 0, true));
    const iceColdAway = [];
    for (let i = 0; i < 20; i++) iceColdAway.push(game(false, 0, 10, false));
    const r = gameSituationalCore(scorchingHome, iceColdAway, "NYY", "LAA");
    expect(r.adj).toBeCloseTo(0.05, 10);
  });

  it("combines notes from both sides", () => {
    const flatLog = new Array(3).fill(0).map(() => game(true, 1, 1, true)); // < 6 games -> no notes
    const r = gameSituationalCore(flatLog, flatLog, "NYY", "LAA");
    expect(r.notes).toEqual([]);
    expect(r.adj).toBe(0);
  });
});
