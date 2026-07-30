import { describe, it, expect } from "vitest";
import {
  trainLeagueModel, toConfidencePairs, modelProb, modelWeight, predictGame, predictDuel,
  predictField, predict, confidenceLabel, serializeModel, saveModel, getModel, clearModels,
  loadStore, STORE_KEY
} from "../js/ms-model.js";
import * as features from "../js/ms-features.js";
import * as ratings from "../js/ms-ratings.js";
import * as backtest from "../js/ms-backtest.js";
import * as ml from "../js/ml-train.js";
import * as calibration from "../js/calibration.js";
import { makeLeague } from "../js/ms-leagues.js";

const deps = { features, ratings, backtest, ml, calibration };
const NBA = makeLeague("basketball", "nba", "NBA", "NBA", "us");
const EPL = makeLeague("soccer", "eng.1", "Premier League", "EPL", "gb-eng");
const ATP = makeLeague("tennis", "atp", "ATP Tour", "ATP", "world");
const PGA = makeLeague("golf", "pga", "PGA Tour", "PGA", "us");

// A reproducible synthetic season with real latent team strengths, so the
// model has genuine signal to find and we can assert it finds it.
function season(nTeams, rounds, seedVal, opts) {
  opts = opts || {};
  let seed = seedVal;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const gauss = () => Math.sqrt(-2 * Math.log(Math.max(1e-9, rnd()))) * Math.cos(2 * Math.PI * rnd());
  const teams = Array.from({ length: nTeams }, (_, i) => ({ id: "T" + i, strength: gauss() * 6 }));
  const games = [];
  let day = 0;
  for (let r = 0; r < rounds; r++) {
    for (let a = 0; a < nTeams; a++) {
      const b = (a + 1 + r) % nTeams;
      if (a >= b) continue;
      day++;
      const date = new Date(Date.UTC(2024, 9, 1) + day * 8 * 3600000).toISOString();
      const margin = (teams[a].strength - teams[b].strength) + 3 + gauss() * 11;
      let hs = 110 + Math.round(margin / 2), as = 110 - Math.round(margin / 2);
      if (hs === as) hs++;
      games.push({
        id: "g" + games.length, date,
        status: { state: "post", final: true, completed: true, cancelled: false },
        home: { id: teams[a].id, shortName: teams[a].id, score: hs },
        away: { id: teams[b].id, shortName: teams[b].id, score: as },
        odds: opts.odds ? { homeML: -120, awayML: 100 } : null
      });
    }
  }
  return games;
}

const replayed = backtest.replay(season(20, 26, 12345), NBA, deps);
const trained = trainLeagueModel(replayed.samples, NBA, deps, { now: "2025-01-01T00:00:00Z" });

describe("trainLeagueModel", () => {
  it("fits a model when there is enough graded history", () => {
    expect(trained.trained).toBe(true);
    expect(trained.leagueId).toBe("basketball/nba");
    expect(trained.w).toHaveLength(trained.features.length);
    expect(trained.nTrain + trained.nTest).toBe(trained.n);
  });

  it("refuses to fit on a thin sample and says why", () => {
    const thin = trainLeagueModel(replayed.samples.slice(0, 10), NBA, deps);
    expect(thin.trained).toBe(false);
    expect(thin.reason).toMatch(/not enough/);
  });

  it("splits chronologically so the test period is strictly later", () => {
    // Reconstruct the split the trainer used and confirm the ordering.
    const parts = backtest.chronoSplit(backtest.splitDraws(replayed.samples).binary, 0.75);
    expect(Math.max(...parts.train.map(s => s.t))).toBeLessThan(Math.min(...parts.test.map(s => s.t)));
    expect(parts.train).toHaveLength(trained.nTrain);
  });

  it("beats the always-home baseline and the Elo-only prior on held-out data", () => {
    expect(trained.metrics.test.acc).toBeGreaterThan(0.5);
    expect(trained.metrics.test.logloss).toBeLessThan(trained.metrics.eloOnly.logloss);
    expect(trained.metrics.auc).toBeGreaterThan(0.5);
  });

  it("reports walk-forward folds alongside the single split", () => {
    expect(trained.metrics.folds.length).toBeGreaterThan(0);
    trained.metrics.folds.forEach(f => {
      expect(f.n).toBeGreaterThan(0);
      expect(Number.isFinite(f.logloss)).toBe(true);
    });
    expect(Number.isFinite(trained.metrics.foldMeanLogloss)).toBe(true);
  });

  it("produces a calibration report over picked-side confidence", () => {
    const c = trained.metrics.calibration;
    expect(c).not.toBeNull();
    // Bins span [0.5, 1]; every populated bin's mean confidence must sit there.
    c.bins.filter(b => b.n > 0).forEach(b => {
      expect(b.pbar).toBeGreaterThanOrEqual(0.5);
      expect(b.pbar).toBeLessThanOrEqual(1);
    });
    expect(c.bins.filter(b => b.n > 0).length).toBeGreaterThan(1);
  });

  it("records the draw rate for draw-capable leagues", () => {
    const soccer = backtest.replay([
      ...Array.from({ length: 80 }, (_, i) => ({
        id: "s" + i, date: new Date(Date.UTC(2024, 7, 1) + i * 86400000).toISOString(),
        status: { state: "post", final: true, completed: true, cancelled: false },
        home: { id: "H" + (i % 8), shortName: "H", score: i % 4 === 0 ? 1 : 2 },
        away: { id: "A" + (i % 7), shortName: "A", score: 1 }
      }))
    ], EPL, deps);
    const m = trainLeagueModel(soccer.samples, EPL, deps);
    expect(m.drawRate).toBeGreaterThan(0);
    expect(m.drawRate).toBeLessThan(1);
  });
});

describe("toConfidencePairs", () => {
  it("folds away-favoured predictions onto the picked side", () => {
    expect(toConfidencePairs([{ p: 0.8, y: 1 }])).toEqual([{ p: 0.8, y: 1 }]);
    expect(toConfidencePairs([{ p: 0.2, y: 0 }])).toEqual([{ p: 0.8, y: 1 }]);
    expect(toConfidencePairs([{ p: 0.3, y: 1 }])).toEqual([{ p: 0.7, y: 0 }]);
  });
  it("never emits a confidence below 0.5", () => {
    toConfidencePairs([{ p: 0.01, y: 1 }, { p: 0.49, y: 0 }, { p: 0.99, y: 1 }])
      .forEach(d => expect(d.p).toBeGreaterThanOrEqual(0.5));
  });
});

describe("modelWeight", () => {
  it("is zero for an untrained model", () => {
    expect(modelWeight(null)).toBe(0);
    expect(modelWeight({ trained: false })).toBe(0);
  });

  it("is zero when the model lost to the Elo prior on held-out data", () => {
    expect(modelWeight({
      trained: true, nTrain: 500,
      metrics: { test: { logloss: 0.70 }, eloOnly: { logloss: 0.60 } }
    })).toBe(0);
  });

  it("grows with training size but never dominates the prior", () => {
    const small = modelWeight({ trained: true, nTrain: 100, metrics: { test: { logloss: 0.5 }, eloOnly: { logloss: 0.6 } } });
    const large = modelWeight({ trained: true, nTrain: 5000, metrics: { test: { logloss: 0.5 }, eloOnly: { logloss: 0.6 } } });
    expect(large).toBeGreaterThan(small);
    expect(large).toBeLessThanOrEqual(0.75);
  });
});

describe("predictGame", () => {
  const upcoming = {
    id: "next", date: "2025-03-01T00:00Z", status: { state: "pre" },
    home: { id: "T0", shortName: "T0" }, away: { id: "T5", shortName: "T5" },
    odds: { homeML: -140, awayML: 120 }
  };

  it("returns a probability pair that sums to one", () => {
    const p = predictGame(upcoming, replayed.state, NBA, trained, deps);
    expect(p.homeWinProb + p.awayWinProb).toBeCloseTo(1, 12);
    expect(p.homeWinProb).toBeGreaterThan(0);
    expect(p.homeWinProb).toBeLessThan(1);
  });

  it("lands between the Elo prior and the fitted model", () => {
    const p = predictGame(upcoming, replayed.state, NBA, trained, deps);
    const lo = Math.min(p.eloProb, p.modelProb), hi = Math.max(p.eloProb, p.modelProb);
    expect(p.homeWinProb).toBeGreaterThanOrEqual(lo - 1e-9);
    expect(p.homeWinProb).toBeLessThanOrEqual(hi + 1e-9);
  });

  it("falls back to pure Elo with no model", () => {
    const p = predictGame(upcoming, replayed.state, NBA, null, deps);
    expect(p.modelProb).toBeNull();
    expect(p.modelWeight).toBe(0);
    expect(p.homeWinProb).toBeCloseTo(p.eloProb, 9);
  });

  it("drops home advantage at a neutral site", () => {
    const neutral = Object.assign({}, upcoming, { neutralSite: true });
    const a = predictGame(upcoming, replayed.state, NBA, null, deps);
    const b = predictGame(neutral, replayed.state, NBA, null, deps);
    expect(b.eloProb).toBeLessThan(a.eloProb);
    expect(b.neutral).toBe(true);
  });

  it("compares against the market and finds the better side", () => {
    const p = predictGame(upcoming, replayed.state, NBA, trained, deps);
    expect(p.market.home + p.market.away).toBeCloseTo(1, 9);
    expect(p.edges.length).toBeGreaterThanOrEqual(2);
    expect(p.bestEdge).not.toBeNull();
    // The best edge really is the largest one.
    p.edges.filter(e => e.edge != null).forEach(e => {
      expect(p.bestEdge.edge).toBeGreaterThanOrEqual(e.edge);
    });
  });

  it("omits market fields when ESPN carried no line", () => {
    const noOdds = Object.assign({}, upcoming, { odds: null });
    const p = predictGame(noOdds, replayed.state, NBA, trained, deps);
    expect(p.market).toBeUndefined();
    expect(p.edges).toBeUndefined();
  });

  it("adds a three-way outcome and goal markets for draw-capable sports", () => {
    const soccerGame = {
      id: "s", date: "2025-03-01T00:00Z", status: { state: "pre" },
      home: { id: "H1", shortName: "H1" }, away: { id: "A1", shortName: "A1" }
    };
    const p = predictGame(soccerGame, features.createState(EPL), EPL, null, deps, { drawRate: 0.26 });
    expect(p.threeWay.home + p.threeWay.draw + p.threeWay.away).toBeCloseTo(1, 9);
    expect(p.goals.totals[2.5].over + p.goals.totals[2.5].under).toBeCloseTo(1, 9);
    expect(p.goals.topScores.length).toBeGreaterThan(0);
    expect(p.drawProb).toBeCloseTo(p.threeWay.draw, 12);
  });

  it("returns null when a side is missing", () => {
    expect(predictGame({ home: null, away: {} }, replayed.state, NBA, trained, deps)).toBeNull();
  });
});

describe("predictDuel", () => {
  it("runs the tennis hierarchy rather than reading Elo directly", () => {
    const state = features.createState(ATP);
    state.elo = { P1: 1800, P2: 1500 };
    const p = predictDuel({ id: "m", home: { id: "P1" }, away: { id: "P2" } }, state, ATP, deps, { bestOf: 3 });
    expect(p.tennis).toBeDefined();
    expect(p.tennis.hold.a).toBeGreaterThan(p.tennis.hold.b);
    expect(p.homeWinProb).toBeCloseTo(p.tennis.match, 12);
    expect(p.homeWinProb + p.awayWinProb).toBeCloseTo(1, 12);
  });

  it("is a coin flip between equally rated players", () => {
    const p = predictDuel({ id: "m", home: { id: "X" }, away: { id: "Y" } }, features.createState(ATP), ATP, deps);
    expect(p.homeWinProb).toBeCloseTo(0.5, 8);
  });

  it("uses a plain Elo read for MMA, where there is no serve structure", () => {
    const ufc = makeLeague("mma", "ufc", "UFC", "UFC", "world");
    const state = features.createState(ufc);
    state.elo = { F1: 1700, F2: 1500 };
    const p = predictDuel({ id: "f", home: { id: "F1" }, away: { id: "F2" } }, state, ufc, deps);
    expect(p.tennis).toBeUndefined();
    expect(p.homeWinProb).toBeCloseTo(ratings.eloProb(1700, 1500, 0), 9);
  });
});

describe("predictField", () => {
  it("rates the whole field and sorts by win probability", () => {
    const state = features.createState(PGA);
    state.elo = { A: 1700, B: 1600, C: 1500, D: 1400 };
    const g = { id: "t", field: [{ id: "A", name: "A" }, { id: "B", name: "B" }, { id: "C", name: "C" }, { id: "D", name: "D" }] };
    const p = predictField(g, state, PGA, deps, { iters: 600 });
    expect(p.fieldSize).toBe(4);
    expect(p.entrants[0].id).toBe("A");
    expect(p.entrants.reduce((s, e) => s + e.winProb, 0)).toBeCloseTo(1, 9);
    // Top-10 in a 4-player field is everyone.
    p.entrants.forEach(e => {
      expect(e.top10).toBeCloseTo(1, 6);
      expect(e.top5).toBeCloseTo(1, 6);
    });
  });

  it("returns null for an empty field", () => {
    expect(predictField({ id: "t", field: [] }, features.createState(PGA), PGA, deps)).toBeNull();
  });
});

describe("predict dispatch", () => {
  it("routes each league kind to the right model", () => {
    const g = { id: "g", date: "2025-01-01T00:00Z", home: { id: "T0" }, away: { id: "T1" } };
    expect(predict(g, replayed.state, NBA, trained, deps).kind).toBe("team");
    expect(predict(g, features.createState(ATP), ATP, null, deps).kind).toBe("duel");
    const field = { id: "f", field: [{ id: "A" }, { id: "B" }] };
    expect(predict(field, features.createState(PGA), PGA, null, deps, { iters: 200 }).kind).toBe("field");
  });
});

describe("confidenceLabel", () => {
  it("scales with how much history backs the matchup", () => {
    const s = features.createState(NBA);
    expect(confidenceLabel(s, "A", "B", null).level).toBe("none");
    s.log.A = new Array(3).fill({}); s.log.B = new Array(3).fill({});
    expect(confidenceLabel(s, "A", "B", null).level).toBe("low");
    s.log.A = new Array(10).fill({}); s.log.B = new Array(10).fill({});
    expect(confidenceLabel(s, "A", "B", null).level).toBe("medium");
    s.log.A = new Array(40).fill({}); s.log.B = new Array(40).fill({});
    expect(confidenceLabel(s, "A", "B", null).level).toBe("high");
  });
  it("is limited by the thinner of the two sides", () => {
    const s = features.createState(NBA);
    s.log.A = new Array(50).fill({}); s.log.B = new Array(2).fill({});
    expect(confidenceLabel(s, "A", "B", null).level).toBe("low");
  });
});

describe("persistence", () => {
  // Minimal localStorage stand-in.
  function memStore() {
    const m = {};
    return {
      getItem: k => (k in m ? m[k] : null),
      setItem: (k, v) => { m[k] = String(v); },
      removeItem: k => { delete m[k]; },
      _raw: m
    };
  }

  it("round-trips a model through storage", () => {
    const st = memStore();
    expect(saveModel(st, trained)).toBe(true);
    const back = getModel(st, "basketball/nba");
    expect(back.trained).toBe(true);
    expect(back.w).toEqual(trained.w);
  });

  it("drops the bulky diagnostics before saving", () => {
    expect(serializeModel(trained).lossCurve).toBeUndefined();
    expect(serializeModel(trained).metrics.calibration.bins).toBeUndefined();
    // The original is untouched.
    expect(trained.lossCurve.length).toBeGreaterThan(0);
    expect(trained.metrics.calibration.bins.length).toBeGreaterThan(0);
  });

  it("returns an empty store for missing or corrupt data", () => {
    const st = memStore();
    expect(loadStore(st)).toEqual({});
    st.setItem(STORE_KEY, "{not json");
    expect(loadStore(st)).toEqual({});
    expect(getModel(st, "anything")).toBeNull();
  });

  it("keeps models from different leagues side by side", () => {
    const st = memStore();
    saveModel(st, trained);
    saveModel(st, { leagueId: "soccer/eng.1", trained: true, w: [1] });
    expect(Object.keys(loadStore(st))).toHaveLength(2);
    clearModels(st);
    expect(loadStore(st)).toEqual({});
  });

  it("survives a storage that throws (private browsing)", () => {
    const hostile = { getItem: () => { throw new Error("nope"); }, setItem: () => { throw new Error("nope"); }, removeItem: () => { throw new Error("nope"); } };
    expect(loadStore(hostile)).toEqual({});
    expect(saveModel(hostile, trained)).toBe(false);
    expect(clearModels(hostile)).toBe(false);
  });

  it("refuses to save a model with no league id", () => {
    expect(saveModel(memStore(), { trained: true })).toBe(false);
  });
});

describe("modelProb", () => {
  it("returns null without a trained model", () => {
    expect(modelProb({ hfa: 1 }, null, deps)).toBeNull();
    expect(modelProb({ hfa: 1 }, { trained: false }, deps)).toBeNull();
    expect(modelProb(null, trained, deps)).toBeNull();
  });
  it("produces a probability from a feature vector", () => {
    const p = modelProb(replayed.samples[replayed.samples.length - 1].feat, trained, deps);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1);
  });
});
