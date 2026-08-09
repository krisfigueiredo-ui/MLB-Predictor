import { describe, it, expect } from "vitest";
import {
  normalizeGameFeed,
  normalizeStandings,
  aggregateRecentHitting,
  diamondSignalScore
} from "../js/data/baseball-intel.js";

describe("baseball intelligence normalization", () => {
  it("normalizes confirmed lineups and real play descriptions", () => {
    const players = {};
    for (let id = 1; id <= 9; id += 1) {
      players[`ID${id}`] = { person: { id, fullName: `Player ${id}` }, position: { abbreviation: id === 1 ? "CF" : "IF" }, seasonStats: { batting: { avg: ".250", ops: ".750", homeRuns: id } } };
    }
    const feed = {
      gamePk: 99,
      gameData: { venue: { name: "Test Park" }, status: { detailedState: "Final" } },
      liveData: {
        boxscore: { teams: { away: { battingOrder: [1,2,3,4,5,6,7,8,9], players }, home: { battingOrder: [], players: {} } } },
        linescore: { currentInning: 1, inningHalf: "Top", teams: { away: { runs: 1 }, home: { runs: 0 } } },
        plays: { allPlays: [{ atBatIndex: 0, about: { inning: 1, isTopInning: true, halfInning: "top" }, result: { event: "Home Run", description: "Player 1 homers.", rbi: 1, awayScore: 1, homeScore: 0 }, matchup: { batter: { id: 1, fullName: "Player 1" }, pitcher: { id: 20, fullName: "Pitcher 1", primaryPosition: { abbreviation: "P" } } } }] }
      }
    };
    const game = normalizeGameFeed(feed, { away: "NYY", home: "BOS", homeProbability: 0.55 });
    expect(game.lineups.away.status).toBe("CONFIRMED");
    expect(game.lineups.away.starters).toHaveLength(9);
    expect(game.plays[0].description).toBe("Player 1 homers.");
    expect(game.moments[0].momentType).toBe("HOME RUN");
    expect(game.winProbability[0].homeProbability).toBeLessThan(0.55);
  });

  it("normalizes standings without manufacturing missing split records", () => {
    const result = normalizeStandings({ records: [{ league: { id: 103, name: "American League" }, division: { id: 201, name: "American League East" }, teamRecords: [{ team: { id: 147, name: "New York Yankees" }, wins: 60, losses: 40, winningPercentage: ".600", gamesBack: "-", divisionRank: "1", runDifferential: 88, records: { splitRecords: [] } }] }] }, { 147: "NYY" });
    expect(result[0]).toMatchObject({ team: "NYY", wins: 60, losses: 40, pct: 0.6, divisionRank: 1, runDifferential: 88, home: null });
  });

  it("aggregates recent hitting from source game logs", () => {
    const recent = aggregateRecentHitting([{ date: "2026-08-08", stat: { atBats: 4, hits: 2, doubles: 1, homeRuns: 1, baseOnBalls: 1 } }, { date: "2026-08-07", stat: { atBats: 4, hits: 1, strikeOuts: 2 } }], 5);
    expect(recent.games).toBe(2);
    expect(recent.avg).toBeCloseTo(0.375);
    expect(recent.ops).toBeGreaterThan(1);
  });

  it("documents a deterministic signal score with and without market data", () => {
    const withMarket = diamondSignalScore({ modelProbability: 0.65, dispersion: 0.02, dataQuality: 90, starterContribution: 0.2, marketEdge: 0.06 });
    const noMarket = diamondSignalScore({ modelProbability: 0.65, dispersion: 0.02, dataQuality: 90, starterContribution: 0.2, marketEdge: null });
    expect(withMarket.marketQualified).toBe(true);
    expect(noMarket.marketQualified).toBe(false);
    expect(withMarket.components.reduce((sum, component) => sum + component.weight, 0)).toBeCloseTo(1);
    expect(noMarket.score).toBeGreaterThan(0);
  });
});
