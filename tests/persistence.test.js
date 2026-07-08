import { describe, it, expect } from "vitest";
import { parseStoredWeights, parseBacktestStore, isBacktestStale } from "../js/persistence.js";

const DEFAULTS = { power: 0.015, hfa: 0.14, shrink: 0.77 };
const SCHEMA = 2;

describe("parseStoredWeights", () => {
  it("returns defaults (with the current schema stamped) when nothing is stored", () => {
    expect(parseStoredWeights(null, DEFAULTS, SCHEMA)).toEqual(Object.assign({}, DEFAULTS, { __schema: SCHEMA }));
    expect(parseStoredWeights("", DEFAULTS, SCHEMA)).toEqual(Object.assign({}, DEFAULTS, { __schema: SCHEMA }));
  });

  it("returns defaults instead of crashing on corrupt JSON", () => {
    expect(parseStoredWeights("{not valid json", DEFAULTS, SCHEMA)).toEqual(Object.assign({}, DEFAULTS, { __schema: SCHEMA }));
  });

  it("discards a save from an old, incompatible schema rather than half-trusting it", () => {
    const stale = JSON.stringify({ power: 999, hfa: 999, shrink: 999, __schema: 1 });
    expect(parseStoredWeights(stale, DEFAULTS, SCHEMA)).toEqual(Object.assign({}, DEFAULTS, { __schema: SCHEMA }));
  });

  it("passes through a valid current-schema save untouched", () => {
    const saved = JSON.stringify({ power: 0.02, hfa: 0.16, shrink: 0.80, __schema: SCHEMA });
    expect(parseStoredWeights(saved, DEFAULTS, SCHEMA)).toEqual({ power: 0.02, hfa: 0.16, shrink: 0.80, __schema: SCHEMA });
  });

  it("backfills a key missing from an otherwise-valid save from defaults", () => {
    // e.g. a new weight was added to DEFAULT_WEIGHTS after this was saved.
    const saved = JSON.stringify({ power: 0.02, __schema: SCHEMA });
    const result = parseStoredWeights(saved, DEFAULTS, SCHEMA);
    expect(result.power).toBe(0.02);
    expect(result.hfa).toBe(DEFAULTS.hfa);
    expect(result.shrink).toBe(DEFAULTS.shrink);
  });
});

describe("parseBacktestStore", () => {
  it("returns an empty store for missing/null/corrupt input", () => {
    expect(parseBacktestStore(null)).toEqual({});
    expect(parseBacktestStore(undefined)).toEqual({});
    expect(parseBacktestStore("{broken")).toEqual({});
  });
  it("parses a valid store through untouched", () => {
    const raw = JSON.stringify({ g1: { home: "NYY", away: "BOS" }, __schema: 2 });
    expect(parseBacktestStore(raw)).toEqual({ g1: { home: "NYY", away: "BOS" }, __schema: 2 });
  });
});

describe("isBacktestStale", () => {
  it("is not stale when the store is empty (nothing to invalidate)", () => {
    expect(isBacktestStale({}, 2)).toBe(false);
    expect(isBacktestStale({ __schema: 1 }, 2)).toBe(false); // only meta keys, no real games
  });
  it("is stale when real games exist under an old schema", () => {
    expect(isBacktestStale({ g1: { home: "NYY" }, __schema: 1 }, 2)).toBe(true);
  });
  it("is not stale when real games exist under the current schema", () => {
    expect(isBacktestStale({ g1: { home: "NYY" }, __schema: 2 }, 2)).toBe(false);
  });
});
