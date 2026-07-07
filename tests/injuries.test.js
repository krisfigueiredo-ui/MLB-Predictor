import { describe, it, expect } from "vitest";
import { starTierCore, isOutStatus, injuryImpactCore } from "../js/injuries.js";

const YANKEES_STARS = [["Judge", 1], ["Cole", 1], ["Stanton", 2], ["Goldschmidt", 2]];

describe("starTierCore", () => {
  it("finds the tier for a listed star by case-insensitive substring match", () => {
    expect(starTierCore(YANKEES_STARS, "Aaron Judge")).toBe(1);
    expect(starTierCore(YANKEES_STARS, "giancarlo stanton")).toBe(2);
  });
  it("returns null for a player not on the star list", () => {
    expect(starTierCore(YANKEES_STARS, "Some Bench Guy")).toBeNull();
  });
  it("returns null / handles an empty or missing star list gracefully", () => {
    expect(starTierCore([], "Aaron Judge")).toBeNull();
    expect(starTierCore(undefined, "Aaron Judge")).toBeNull();
  });
});

describe("isOutStatus", () => {
  it("treats Out / IL variants / suspensions as out", () => {
    ["Out", "60-Day IL", "15-Day-IL", "10-Day-IL", "Injured List", "IL", "IL-10", "Suspended", "Restricted List"]
      .forEach((s) => expect(isOutStatus(s)).toBe(true));
  });
  it("does NOT treat day-to-day as out", () => {
    expect(isOutStatus("Day-To-Day")).toBe(false);
  });
  it("regression: does not misclassify Illness as an IL absence via a bare 'il' prefix match", () => {
    // "Illness" starts with "il" but is not "Injured List" -- a naive
    // status.indexOf("il")===0 check would wrongly treat a sick, possibly-
    // playing player as out, docking that team's win probability for nothing.
    expect(isOutStatus("Illness")).toBe(false);
    expect(isOutStatus("Ill")).toBe(false);
  });
});

describe("injuryImpactCore", () => {
  it("returns a zero/empty result when there are no reported injuries", () => {
    expect(injuryImpactCore([], YANKEES_STARS)).toEqual({ players: [], adj: 0, dtd: [] });
    expect(injuryImpactCore(null, YANKEES_STARS)).toEqual({ players: [], adj: 0, dtd: [] });
  });

  it("docks more for a tier-1 star being out than a bench player", () => {
    const starOut = injuryImpactCore([{ name: "Aaron Judge", pos: "RF", status: "Out" }], YANKEES_STARS);
    const benchOut = injuryImpactCore([{ name: "Some Bench Guy", pos: "1B", status: "Out" }], YANKEES_STARS);
    expect(starOut.adj).toBe(-0.035);
    expect(benchOut.adj).toBe(-0.005);
    expect(starOut.adj).toBeLessThan(benchOut.adj);
  });

  it("does not penalize a day-to-day player, but tracks them separately", () => {
    const r = injuryImpactCore([{ name: "Aaron Judge", pos: "RF", status: "Day-To-Day" }], YANKEES_STARS);
    expect(r.adj).toBe(0);
    expect(r.players).toEqual([]);
    expect(r.dtd.length).toBe(1);
  });

  it("regression: a sick-but-possibly-playing star (status 'Illness') is not treated as out", () => {
    const r = injuryImpactCore([{ name: "Aaron Judge", pos: "RF", status: "Illness" }], YANKEES_STARS);
    expect(r.adj).toBe(0);
    expect(r.players).toEqual([]);
    expect(r.dtd.length).toBe(1);
  });

  it("caps the total adjustment at -0.06 even with many stars out", () => {
    const everyoneOut = YANKEES_STARS.map(([name]) => ({ name: name, pos: "?", status: "Out" }));
    const r = injuryImpactCore(everyoneOut, YANKEES_STARS);
    expect(r.adj).toBe(-0.06);
  });
});
