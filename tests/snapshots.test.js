import { describe, it, expect } from "vitest";
import {
  SNAPSHOT_SCHEMA,
  createPredictionSnapshot,
  parseSnapshotStore,
  appendImmutableSnapshot,
  gradePredictionSnapshot,
  markLegacyRows,
  normalizeLegacyPredictionResult,
  mergePredictionResults,
  summarizePredictionResults
} from "../js/data/snapshots.js";

function input() {
  return {
    gameId: "401",
    timestamp: 1000,
    firstPitch: 2000,
    modelVersion: "2.0.0",
    weightVersion: "w1",
    calibrationVersion: "rolling-alpha-v1",
    rawProb: 0.61,
    calibratedProb: 0.58,
    publishedProb: 0.58,
    eloProb: 0.6,
    poissonProb: 0.55,
    featureProb: 0.65,
    features: { elo: 0.1 },
    contributions: { elo: 0.2 },
    dataQuality: { complete: 0.9 },
    market: { homeML: -120 },
    home: "TOR",
    away: "NYY",
    selection: { team: "TOR", probability: 0.58, signalScore: 7.4 },
    projectedScore: { home: 4.6, away: 3.9 },
    signal: { score: 7.4, components: [{ label: "Confidence", value: 0.58 }] }
  };
}

describe("point-in-time snapshots", () => {
  it("creates a frozen record before first pitch", () => {
    const snapshot = createPredictionSnapshot(input(), 1500);
    expect(snapshot.schema).toBe(SNAPSHOT_SCHEMA);
    expect(snapshot.status).toBe("FROZEN");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.features)).toBe(true);
    expect(Object.isFrozen(snapshot.market)).toBe(true);
    expect(Object.isFrozen(snapshot.selection)).toBe(true);
    expect(() => { snapshot.features.elo = 99; }).toThrow();
  });

  it("refuses a snapshot captured after first pitch", () => {
    expect(createPredictionSnapshot(input(), 2100)).toBeNull();
  });

  it("keeps the first snapshot immutable on duplicate append", () => {
    const first = createPredictionSnapshot(input(), 1500);
    const changed = createPredictionSnapshot({ ...input(), rawProb: 0.9 }, 1500);
    const once = appendImmutableSnapshot(null, first);
    const twice = appendImmutableSnapshot(once, changed);
    expect(twice.snapshots["401"].rawProb).toBe(0.61);
  });

  it("grades without replacing the frozen inputs", () => {
    const store = appendImmutableSnapshot(null, createPredictionSnapshot(input(), 1500));
    const graded = gradePredictionSnapshot(store, "401", { homeScore: 5, awayScore: 3, gradedAt: 3000 });
    expect(graded.snapshots["401"].result.actualHome).toBe(true);
    expect(graded.snapshots["401"].result.outcome).toBe("WON");
    expect(graded.snapshots["401"].selection.team).toBe("TOR");
    expect(graded.snapshots["401"].rawProb).toBe(0.61);
  });

  it("survives malformed storage and marks old logs legacy", () => {
    expect(parseSnapshotStore("bad json").snapshots).toEqual({});
    expect(markLegacyRows([{ id: 1 }])[0].snapshotStatus).toBe("LEGACY");
    expect(createPredictionSnapshot({ ...input(), publishedProb: null }, 1500).publishedProb).toBeNull();
  });

  it("recovers the selected side for older frozen records missing selection metadata", () => {
    const old = { ...input(), selection: null, publishedProb: 0.58, result: { homeScore: 2, awayScore: 5, outcome: "LOSS" } };
    const parsed = parseSnapshotStore(JSON.stringify({ snapshots: { "401": old } }));
    expect(parsed.snapshots["401"].selection).toMatchObject({ team: "TOR", probability: 0.58, recovered: true });
    expect(parsed.snapshots["401"].result).toMatchObject({ selectedTeam: "TOR", actualHome: false, outcome: "LOST" });
  });

  it("normalizes only verified legacy results and recomputes the outcome", () => {
    const legacy = normalizeLegacyPredictionResult({
      gid: "old-1", ts: 5000, home: "BOS", away: "NYY", pick: "NYY",
      homeP: 0.44, awayP: 0.56, conf: 0.56, hs: 2, as: 5, real: true,
      correct: false
    });
    expect(legacy.snapshotStatus).toBe("VERIFIED LEGACY");
    expect(legacy.selection.team).toBe("NYY");
    expect(legacy.result.outcome).toBe("WON");
    expect(normalizeLegacyPredictionResult({ home: "BOS", away: "NYY", real: false })).toBeNull();
  });

  it("prefers the frozen snapshot when the verified legacy log has the same game", () => {
    const frozen = gradePredictionSnapshot(
      appendImmutableSnapshot(null, createPredictionSnapshot(input(), 1500)),
      "401",
      { homeScore: 5, awayScore: 3, gradedAt: 3000 }
    ).snapshots["401"];
    const merged = mergePredictionResults([frozen], [{
      gid: "401", ts: 2000, home: "TOR", away: "NYY", pick: "NYY",
      homeP: 0.4, awayP: 0.6, hs: 5, as: 3, real: true
    }]);
    expect(merged).toHaveLength(1);
    expect(merged[0].status).toBe("FROZEN");
    expect(merged[0].selection.team).toBe("TOR");
  });

  it("summarizes team accuracy, home-away splits, and confidence tiers", () => {
    const rows = [
      { home: "TOR", away: "NYY", selection: { team: "TOR", probability: 0.62 }, result: { outcome: "WON" } },
      { home: "BOS", away: "TOR", selection: { team: "TOR", probability: 0.58 }, result: { outcome: "LOST" } },
      { home: "LAD", away: "SD", selection: { team: "SD", probability: 0.66 }, result: { outcome: "WON" } }
    ];
    const summary = summarizePredictionResults(rows);
    expect(summary.picks).toBe(3);
    expect(summary.wins).toBe(2);
    expect(summary.home).toMatchObject({ picks: 1, wins: 1 });
    expect(summary.away).toMatchObject({ picks: 2, wins: 1 });
    expect(summary.highConfidence).toMatchObject({ picks: 2, wins: 2, accuracy: 1 });
    expect(summary.teams.find((row) => row.team === "TOR")).toMatchObject({ picks: 2, wins: 1, losses: 1, accuracy: 0.5 });
  });
});
