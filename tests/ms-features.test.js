import { describe, it, expect } from "vitest";
import {
  FEATURE_KEYS, pythagExp, createState, rating, form, seasonAgg, pythag, h2hEdge,
  restDays, rankFeature, clampScale, buildFeatures, updateState, stateSummary, powerRankings
} from "../js/ms-features.js";
import * as ratings from "../js/ms-ratings.js";
import { makeLeague } from "../js/ms-leagues.js";

const NBA = makeLeague("basketball", "nba", "NBA", "NBA", "us");
const EPL = makeLeague("soccer", "eng.1", "Premier League", "EPL", "gb-eng");

function game(id, date, homeId, awayId, hs, as, extra) {
  return Object.assign({
    id, date,
    home: { id: homeId, shortName: homeId, score: hs },
    away: { id: awayId, shortName: awayId, score: as }
  }, extra || {});
}

describe("state bookkeeping", () => {
  it("starts every team at 1500 with no log", () => {
    const s = createState(NBA);
    expect(rating(s, "unknown")).toBe(1500);
    expect(seasonAgg(s, "unknown")).toBeNull();
    expect(form(s, "unknown", 10)).toBeNull();
  });

  it("moves ratings in opposite directions by the same amount", () => {
    const s = createState(NBA);
    updateState(s, game("1", "2025-01-01T00:00Z", "A", "B", 110, 100), NBA, ratings);
    expect(s.elo.A).toBeGreaterThan(1500);
    expect(s.elo.B).toBeLessThan(1500);
    expect(s.elo.A - 1500).toBeCloseTo(1500 - s.elo.B, 9);
  });

  it("records the game in both teams' logs from their own perspective", () => {
    const s = createState(NBA);
    updateState(s, game("1", "2025-01-01T00:00Z", "A", "B", 110, 100), NBA, ratings);
    expect(s.log.A[0]).toMatchObject({ won: true, scored: 110, allowed: 100, home: true });
    expect(s.log.B[0]).toMatchObject({ won: false, scored: 100, allowed: 110, home: false });
  });

  it("ignores a game with missing scores", () => {
    const s = createState(NBA);
    updateState(s, game("1", "2025-01-01T00:00Z", "A", "B", null, 100), NBA, ratings);
    expect(s.counts.games).toBe(0);
  });

  it("counts draws separately and gives both sides half credit", () => {
    const s = createState(EPL);
    updateState(s, game("1", "2025-01-01T00:00Z", "A", "B", 1, 1), EPL, ratings);
    expect(s.counts.draws).toBe(1);
    expect(s.log.A[0].drew).toBe(true);
    expect(form(s, "A", 5)).toBe(0.5);
    // Home advantage means a draw at home is a below-expectation result, so the
    // home side loses a little rating and the away side gains it.
    expect(s.elo.A).toBeLessThan(1500);
    expect(s.elo.B).toBeGreaterThan(1500);
    expect(1500 - s.elo.A).toBeCloseTo(s.elo.B - 1500, 9);
  });

  it("moves nothing on a draw when there is no home advantage", () => {
    const neutral = makeLeague("soccer", "fifa.cwc", "Club World Cup", "CWC", "world");
    const s2 = createState(neutral);
    updateState(s2, game("1", "2025-01-01T00:00Z", "A", "B", 1, 1, { neutralSite: true }), neutral, ratings);
    expect(s2.elo.A).toBeCloseTo(1500, 9);
    expect(s2.elo.B).toBeCloseTo(1500, 9);
  });

  it("gives no home credit at a neutral site", () => {
    const s = createState(NBA);
    updateState(s, game("1", "2025-01-01T00:00Z", "A", "B", 110, 100, { neutralSite: true }), NBA, ratings);
    expect(s.log.A[0].home).toBe(false);
  });
});

describe("derived statistics", () => {
  const s = createState(NBA);
  updateState(s, game("1", "2025-01-01T00:00Z", "A", "B", 110, 100), NBA, ratings);
  updateState(s, game("2", "2025-01-03T00:00Z", "B", "A", 120, 90), NBA, ratings);
  updateState(s, game("3", "2025-01-06T00:00Z", "A", "C", 105, 95), NBA, ratings);

  it("aggregates a season log", () => {
    const agg = seasonAgg(s, "A");
    expect(agg.n).toBe(3);
    expect(agg.scoredAvg).toBeCloseTo((110 + 90 + 105) / 3, 9);
    expect(agg.winPct).toBeCloseTo(2 / 3, 9);
  });

  it("computes recent form and venue splits", () => {
    expect(form(s, "A", 10)).toBeCloseTo(2 / 3, 9);
    expect(form(s, "A", 10, "home")).toBe(1);      // both home games won
    expect(form(s, "A", 10, "away")).toBe(0);
  });

  it("computes head-to-head from the home team's perspective, both directions", () => {
    // A beat B at home, B beat A at home -> level.
    expect(h2hEdge(s, "A", "B")).toBeCloseTo(0, 9);
    expect(h2hEdge(s, "A", "Z")).toBeNull();
  });

  it("computes rest days and caps a long layoff", () => {
    const ms = Date.parse("2025-01-08T00:00Z");
    expect(restDays(s, "A", ms)).toBeCloseTo(2, 6);
    expect(restDays(s, "A", Date.parse("2026-01-01T00:00Z"))).toBe(21);
    expect(restDays(s, "never-played", ms)).toBeNull();
  });

  it("computes pythagorean expectation", () => {
    expect(pythag(100, 100, 2)).toBeCloseTo(0.5, 12);
    expect(pythag(120, 100, 2)).toBeGreaterThan(0.5);
    expect(pythagExp("baseball")).toBe(1.83);
    expect(pythagExp("unknown-sport")).toBe(2.0);
  });

  it("summarises the league's empirics", () => {
    const sum = stateSummary(s);
    expect(sum.games).toBe(3);
    expect(sum.homeWinRate + sum.awayWinRate + sum.drawRate).toBeCloseTo(1, 9);
    expect(stateSummary(createState(NBA)).games).toBe(0);
  });

  it("ranks teams by rating", () => {
    const rows = powerRankings(s);
    expect(rows).toHaveLength(3);
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1].elo).toBeGreaterThanOrEqual(rows[i].elo);
    expect(powerRankings(s, 2)).toHaveLength(2);
  });
});

describe("feature scaling helpers", () => {
  it("compresses poll rank, treating unranked as neutral", () => {
    expect(rankFeature(1)).toBeGreaterThan(rankFeature(10));
    expect(rankFeature(99)).toBe(0);
    expect(rankFeature(null)).toBe(0);
    expect(rankFeature(0)).toBe(0);
  });

  it("normalises scoring differences against the league's scale", () => {
    // Two goals in soccer and forty points in basketball should land in a
    // comparable range once scaled by each league's expected total.
    const soccerish = clampScale(2, EPL);
    const hoops = clampScale(40, NBA);
    expect(Math.abs(soccerish)).toBeLessThanOrEqual(3);
    expect(Math.abs(hoops)).toBeLessThanOrEqual(3);
    expect(clampScale(1000, NBA)).toBe(3);
    expect(clampScale(-1000, NBA)).toBe(-3);
  });
});

describe("buildFeatures", () => {
  it("emits every declared feature key", () => {
    const s = createState(NBA);
    const f = buildFeatures(game("x", "2025-01-01T00:00Z", "A", "B", null, null), s, NBA);
    FEATURE_KEYS.forEach(k => expect(Number.isFinite(f[k])).toBe(true));
  });

  it("is entirely neutral for the first game of a window", () => {
    const s = createState(NBA);
    const f = buildFeatures(game("x", "2025-01-01T00:00Z", "A", "B", null, null), s, NBA);
    expect(f.hfa).toBe(1);
    FEATURE_KEYS.filter(k => k !== "hfa").forEach(k => expect(f[k]).toBe(0));
  });

  it("zeroes the home-advantage slot at a neutral site", () => {
    const s = createState(NBA);
    const f = buildFeatures(game("x", "2025-01-01T00:00Z", "A", "B", null, null, { neutralSite: true }), s, NBA);
    expect(f.hfa).toBe(0);
  });

  it("reflects a rating edge once history exists", () => {
    const s = createState(NBA);
    for (let i = 0; i < 6; i++) {
      updateState(s, game("g" + i, `2025-01-0${i + 1}T00:00Z`, "A", "B", 120, 95), NBA, ratings);
    }
    const f = buildFeatures(game("next", "2025-01-20T00:00Z", "A", "B", null, null), s, NBA);
    expect(f.eloDiff).toBeGreaterThan(0);
    expect(f.formDiff).toBeGreaterThan(0);
    expect(f.marginDiff).toBeGreaterThan(0);
    expect(f.pythagDiff).toBeGreaterThan(0);
    expect(f.h2hDiff).toBeGreaterThan(0);
    expect(f.experience).toBeGreaterThan(0);
  });

  it("flips sign when the sides swap", () => {
    const s = createState(NBA);
    for (let i = 0; i < 6; i++) {
      updateState(s, game("g" + i, `2025-01-0${i + 1}T00:00Z`, "A", "B", 120, 95), NBA, ratings);
    }
    const fwd = buildFeatures(game("n1", "2025-01-20T00:00Z", "A", "B", null, null), s, NBA);
    const rev = buildFeatures(game("n2", "2025-01-20T00:00Z", "B", "A", null, null), s, NBA);
    expect(rev.eloDiff).toBeCloseTo(-fwd.eloDiff, 9);
    expect(rev.pythagDiff).toBeCloseTo(-fwd.pythagDiff, 9);
  });

  it("uses ESPN's curated rank when present", () => {
    const s = createState(NBA);
    const g = game("x", "2025-01-01T00:00Z", "A", "B", null, null);
    g.home.rank = 2; g.away.rank = 20;
    expect(buildFeatures(g, s, NBA).rankDiff).toBeGreaterThan(0);
  });

  it("returns null when a side is missing", () => {
    const s = createState(NBA);
    expect(buildFeatures({ home: null, away: { id: "B" } }, s, NBA)).toBeNull();
  });
});
