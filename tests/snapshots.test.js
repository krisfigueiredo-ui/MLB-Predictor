import { describe, it, expect } from "vitest";
import {
  SNAPSHOT_SCHEMA,
  createPredictionSnapshot,
  parseSnapshotStore,
  appendImmutableSnapshot,
  gradePredictionSnapshot,
  markLegacyRows
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
    away: "NYY"
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
    expect(graded.snapshots["401"].rawProb).toBe(0.61);
  });

  it("survives malformed storage and marks old logs legacy", () => {
    expect(parseSnapshotStore("bad json").snapshots).toEqual({});
    expect(markLegacyRows([{ id: 1 }])[0].snapshotStatus).toBe("LEGACY");
  });
});
