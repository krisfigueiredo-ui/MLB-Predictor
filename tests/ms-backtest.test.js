import { describe, it, expect } from "vitest";
import {
  isoDate, dateRange, chunkRanges, lookbackRange, sortByDate, isGradable, dedupeById,
  replay, splitDraws, chronoSplit, walkForwardFolds, grade, baselineHome, betBacktest,
  closingLineValue
} from "../js/ms-backtest.js";
import * as features from "../js/ms-features.js";
import * as ratings from "../js/ms-ratings.js";
import { makeLeague } from "../js/ms-leagues.js";

const deps = { features, ratings };
const NBA = makeLeague("basketball", "nba", "NBA", "NBA", "us");
const EPL = makeLeague("soccer", "eng.1", "Premier League", "EPL", "gb-eng");

function done(id, date, homeId, awayId, hs, as, odds) {
  return {
    id, date,
    status: { state: "post", final: true, completed: true, cancelled: false },
    home: { id: homeId, shortName: homeId, score: hs },
    away: { id: awayId, shortName: awayId, score: as },
    odds: odds || null
  };
}

describe("date helpers", () => {
  it("builds an inclusive range", () => {
    const r = dateRange("2025-01-01", "2025-01-05");
    expect(r).toEqual(["2025-01-01", "2025-01-02", "2025-01-03", "2025-01-04", "2025-01-05"]);
  });
  it("crosses month and year boundaries", () => {
    expect(dateRange("2024-12-30", "2025-01-02")).toHaveLength(4);
    expect(dateRange("2024-02-27", "2024-03-01")).toHaveLength(4);   // leap year
  });
  it("returns nothing for an inverted or invalid range", () => {
    expect(dateRange("2025-01-05", "2025-01-01")).toEqual([]);
    expect(dateRange("junk", "2025-01-01")).toEqual([]);
  });

  it("chunks dates into request windows", () => {
    const chunks = chunkRanges(dateRange("2025-01-01", "2025-03-01"), 30);
    expect(chunks[0].from).toBe("2025-01-01");
    expect(chunks[chunks.length - 1].to).toBe("2025-03-01");
    chunks.forEach(c => expect(c.from <= c.to).toBe(true));
  });

  it("walks back a lookback window from a reference date", () => {
    const r = lookbackRange(30, "2025-03-01");
    expect(r.end).toBe("2025-03-01");
    expect(r.start).toBe("2025-01-30");
  });

  it("formats a UTC date", () => {
    expect(isoDate(new Date(Date.UTC(2025, 0, 9)))).toBe("2025-01-09");
  });
});

describe("gradability and dedupe", () => {
  it("accepts a clean completed game", () => {
    expect(isGradable(done("1", "2025-01-01T00:00Z", "A", "B", 100, 99))).toBe(true);
  });
  it("rejects unfinished, postponed, and score-less games", () => {
    const g = done("1", "2025-01-01T00:00Z", "A", "B", 100, 99);
    expect(isGradable(Object.assign({}, g, { status: { final: false } }))).toBe(false);
    expect(isGradable(Object.assign({}, g, { status: { final: true, cancelled: true } }))).toBe(false);
    expect(isGradable(Object.assign({}, g, { home: { id: "A", score: null } }))).toBe(false);
    expect(isGradable(Object.assign({}, g, { home: { score: 1 } }))).toBe(false);   // no id
    expect(isGradable(null)).toBe(false);
  });
  it("drops duplicate ids, which overlapping date ranges produce", () => {
    const a = done("1", "2025-01-01T00:00Z", "A", "B", 1, 0);
    expect(dedupeById([a, a, done("2", "2025-01-02T00:00Z", "A", "B", 1, 0)])).toHaveLength(2);
  });
  it("sorts by kickoff time", () => {
    const out = sortByDate([
      done("2", "2025-01-05T00:00Z", "A", "B", 1, 0),
      done("1", "2025-01-01T00:00Z", "A", "B", 1, 0)
    ]);
    expect(out.map(g => g.id)).toEqual(["1", "2"]);
  });
});

describe("replay", () => {
  const games = [
    done("1", "2025-01-01T00:00Z", "A", "B", 110, 100),
    done("2", "2025-01-03T00:00Z", "C", "A", 90, 105),
    done("3", "2025-01-05T00:00Z", "A", "C", 115, 95)
  ];

  it("emits one sample per gradable game, in date order", () => {
    const r = replay(games, NBA, deps);
    expect(r.samples).toHaveLength(3);
    expect(r.samples.map(s => s.id)).toEqual(["1", "2", "3"]);
  });

  it("builds features BEFORE folding in the result — no leakage", () => {
    const r = replay(games, NBA, deps);
    // Game 1 is the first thing that happens, so nothing can be known yet.
    expect(r.samples[0].feat.eloDiff).toBe(0);
    expect(r.samples[0].feat.formDiff).toBe(0);
    expect(r.samples[0].eloPrior).toBeCloseTo(ratings.eloProb(1500, 1500, NBA.hfa), 9);
    // By game 3, A's earlier wins are visible.
    expect(r.samples[2].feat.eloDiff).toBeGreaterThan(0);
  });

  it("labels outcomes and leaves draws unlabelled for binary training", () => {
    const r = replay([
      done("1", "2025-01-01T00:00Z", "A", "B", 2, 1),
      done("2", "2025-01-02T00:00Z", "A", "B", 1, 1),
      done("3", "2025-01-03T00:00Z", "A", "B", 0, 1)
    ], EPL, deps);
    expect(r.samples.map(s => s.outcome)).toEqual(["home", "draw", "away"]);
    expect(r.samples.map(s => s.y)).toEqual([1, null, 0]);
  });

  it("ignores ungradable games but still returns state", () => {
    const r = replay([
      done("1", "2025-01-01T00:00Z", "A", "B", 110, 100),
      Object.assign(done("2", "2025-01-02T00:00Z", "A", "B", 0, 0), { status: { final: true, cancelled: true } })
    ], NBA, deps);
    expect(r.samples).toHaveLength(1);
    expect(r.summary.games).toBe(1);
  });

  it("records the market when ESPN carried one", () => {
    const r = replay([done("1", "2025-01-01T00:00Z", "A", "B", 110, 100, { homeML: -150, awayML: 130 })], NBA, deps);
    expect(r.samples[0].market.home + r.samples[0].market.away).toBeCloseTo(1, 9);
  });

  it("handles an empty input", () => {
    const r = replay([], NBA, deps);
    expect(r.samples).toEqual([]);
    expect(r.summary.games).toBe(0);
  });
});

describe("splits", () => {
  const samples = Array.from({ length: 20 }, (_, i) => ({ t: i, y: i % 2, feat: {}, drew: false }));

  it("splits chronologically, not randomly", () => {
    const { train, test } = chronoSplit(samples, 0.75);
    expect(train).toHaveLength(15);
    expect(test).toHaveLength(5);
    expect(Math.max(...train.map(s => s.t))).toBeLessThan(Math.min(...test.map(s => s.t)));
  });

  it("always leaves at least one game on each side", () => {
    expect(chronoSplit(samples, 0.999).test.length).toBeGreaterThanOrEqual(1);
    expect(chronoSplit(samples, 0.001).train.length).toBeGreaterThanOrEqual(1);
    expect(chronoSplit([{ t: 1, y: 1 }], 0.75).train).toHaveLength(1);
  });

  it("separates draws from the binary training set", () => {
    const s = splitDraws([{ drew: false, y: 1 }, { drew: true, y: null }, { drew: false, y: 0 }]);
    expect(s.binary).toHaveLength(2);
    expect(s.draws).toBe(1);
    expect(s.drawRate).toBeCloseTo(1 / 3, 9);
  });

  it("builds expanding walk-forward folds where train always precedes test", () => {
    const folds = walkForwardFolds(samples, 4);
    expect(folds.length).toBeGreaterThan(0);
    folds.forEach(f => {
      expect(f.train.length).toBeGreaterThan(0);
      expect(f.test.length).toBeGreaterThan(0);
      expect(Math.max(...f.train.map(s => s.t))).toBeLessThan(Math.min(...f.test.map(s => s.t)));
    });
    // Each fold trains on strictly more history than the last.
    for (let i = 1; i < folds.length; i++) {
      expect(folds[i].train.length).toBeGreaterThan(folds[i - 1].train.length);
    }
  });

  it("returns no folds when there is not enough data", () => {
    expect(walkForwardFolds([{ t: 1 }], 5)).toEqual([]);
  });
});

describe("grade", () => {
  const samples = [
    { y: 1, feat: {} }, { y: 1, feat: {} }, { y: 0, feat: {} }, { y: 0, feat: {} }
  ];

  it("scores a perfect model", () => {
    const g = grade(samples, s => (s.y === 1 ? 0.99 : 0.01));
    expect(g.acc).toBe(1);
    expect(g.brier).toBeLessThan(0.001);
  });

  it("scores a coin flip", () => {
    const g = grade(samples, () => 0.5);
    expect(g.brier).toBeCloseTo(0.25, 9);
    expect(g.logloss).toBeCloseTo(Math.log(2), 6);
  });

  it("skips draws and unusable predictions", () => {
    expect(grade([{ y: null }], () => 0.5).n).toBe(0);
    expect(grade(samples, () => null).n).toBe(0);
    expect(grade([], () => 0.5).acc).toBeNull();
  });

  it("reports the always-home baseline", () => {
    expect(baselineHome(samples).homeWinRate).toBeCloseTo(0.5, 9);
    expect(baselineHome([]).homeWinRate).toBeNull();
  });
});

describe("betBacktest", () => {
  function sample(t, y, homeML, awayML) {
    return {
      t, y, date: "2025-01-0" + ((t % 9) + 1) + "T00:00Z", feat: {},
      odds: { homeML, awayML },
      market: ratings.marketProbs({ homeML, awayML })
    };
  }

  it("only bets when the edge clears the threshold", () => {
    // Market says 50/50; a model that agrees should never bet.
    const s = [sample(1, 1, 100, 100), sample(2, 0, 100, 100)];
    expect(betBacktest(s, () => 0.5, { minEdge: 0.04, mode: "flat" }).bets).toBe(0);
    // A model 20 points clear of the market should bet every time.
    expect(betBacktest(s, () => 0.7, { minEdge: 0.04, mode: "flat" }).bets).toBe(2);
  });

  it("pays out at the recorded price", () => {
    const r = betBacktest([sample(1, 1, 100, 100)], () => 0.9, { minEdge: 0.04, mode: "flat", stake: 1 });
    expect(r.bets).toBe(1);
    expect(r.wins).toBe(1);
    expect(r.pnl).toBeCloseTo(1, 9);       // +100 on a 1u stake
    expect(r.roi).toBeCloseTo(1, 9);
  });

  it("loses the stake when the pick is wrong", () => {
    const r = betBacktest([sample(1, 0, 100, 100)], () => 0.9, { minEdge: 0.04, mode: "flat", stake: 1 });
    expect(r.pnl).toBeCloseTo(-1, 9);
  });

  it("sizes Kelly stakes off the bankroll and compounds", () => {
    const r = betBacktest([sample(1, 1, 100, 100), sample(2, 1, 100, 100)],
      () => 0.8, { minEdge: 0.04, mode: "kelly", kellyFraction: 0.25, bankroll: 100 });
    expect(r.bets).toBe(2);
    expect(r.bankroll).toBeGreaterThan(100);
    // The second stake is larger because the bankroll grew.
    expect(r.curve[1].stake).toBeGreaterThan(r.curve[0].stake);
  });

  it("skips games with no market", () => {
    expect(betBacktest([{ t: 1, y: 1, feat: {}, market: null }], () => 0.9, {}).bets).toBe(0);
  });

  it("produces a cumulative curve", () => {
    const r = betBacktest([sample(1, 1, 100, 100), sample(2, 0, 100, 100)],
      () => 0.9, { minEdge: 0.04, mode: "flat", stake: 1 });
    expect(r.curve).toHaveLength(2);
    expect(r.curve[1].pnl).toBeCloseTo(0, 9);
  });
});

describe("closingLineValue", () => {
  it("averages the move from taken price to close", () => {
    const c = closingLineValue([
      { takenProb: 0.50, closeProb: 0.54 },
      { takenProb: 0.60, closeProb: 0.58 }
    ]);
    expect(c.n).toBe(2);
    expect(c.avg).toBeCloseTo(0.01, 9);
    expect(c.positiveRate).toBeCloseTo(0.5, 9);
  });
  it("handles an empty or incomplete record set", () => {
    expect(closingLineValue([]).n).toBe(0);
    expect(closingLineValue([{ takenProb: 0.5 }]).n).toBe(0);
  });
});
