import { describe, it, expect } from "vitest";
import { recOf, currentStreak, teamSituationalContribution, gameSituationalCore } from "../js/situational.js";

function game(won, rs, ra, h) { return { won, rs, ra, h }; }

describe("recOf", () => {
  it("counts wins/losses/total", () => {
    const r = recOf([game(true, 5, 1, true), game(false, 1, 5, true), game(true, 3, 2, false)]);
    expect(r).toEqual({ w: 2, l: 1, n: 3 });
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
