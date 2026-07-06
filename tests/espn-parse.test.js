import { describe, it, expect } from "vitest";
import { ourAbbrFromEspn, weatherFromESPN, realOddsFromESPN, applyRealPitcher, applyRealRecordCore } from "../js/espn-parse.js";

describe("ourAbbrFromEspn", () => {
  it("maps the 3 teams where ESPN's abbreviation differs from ours", () => {
    expect(ourAbbrFromEspn("OAK")).toBe("ATH");
    expect(ourAbbrFromEspn("CHW")).toBe("CWS");
    expect(ourAbbrFromEspn("ARI")).toBe("AZ");
  });
  it("passes through any abbreviation that already matches", () => {
    expect(ourAbbrFromEspn("NYY")).toBe("NYY");
    expect(ourAbbrFromEspn("SD")).toBe("SD");
  });
});

describe("weatherFromESPN", () => {
  it("returns null when there's no weather data and the venue isn't indoor", () => {
    expect(weatherFromESPN({}, {})).toBeNull();
  });
  it("reports a closed roof when indoor and no weather object is present", () => {
    expect(weatherFromESPN({}, { venue: { indoor: true } })).toBe("Indoor / roof closed");
  });
  it("combines temperature and condition when both are present", () => {
    const comp = { weather: { temperature: 78, displayValue: "Sunny" } };
    expect(weatherFromESPN({}, comp)).toBe("78F Sunny");
  });
  it("falls back to highTemperature when temperature is absent", () => {
    const comp = { weather: { highTemperature: 91, displayValue: "Clear" } };
    expect(weatherFromESPN({}, comp)).toBe("91F Clear");
  });
  it("reads weather from the event object if the competition doesn't have it", () => {
    const ev = { weather: { temperature: 60, displayValue: "Overcast" } };
    expect(weatherFromESPN(ev, {})).toBe("60F Overcast");
  });
  it("reads weather nested under venue.weather as a last resort", () => {
    const comp = { venue: { weather: { temperature: 55 } } };
    expect(weatherFromESPN({}, comp)).toBe("55F");
  });
  it("appends a roof-closed note for a dome game that still reports weather", () => {
    const comp = { venue: { indoor: true, weather: { temperature: 72 } } };
    expect(weatherFromESPN({}, comp)).toBe("72F (roof closed)");
  });
});

describe("realOddsFromESPN", () => {
  it("returns null when there's no odds array", () => {
    expect(realOddsFromESPN({}, 0.5)).toBeNull();
    expect(realOddsFromESPN({ odds: [] }, 0.5)).toBeNull();
  });
  it("returns null when moneylines are missing (e.g. spread-only entry)", () => {
    const comp = { odds: [{ details: "NYY -1.5" }] };
    expect(realOddsFromESPN(comp, 0.5)).toBeNull();
  });
  it("converts moneylines to de-vigged implied probabilities that sum to 1", () => {
    const comp = { odds: [{ homeTeamOdds: { moneyLine: -150 }, awayTeamOdds: { moneyLine: 130 }, overUnder: 8.5, provider: { name: "consensus" } }] };
    const r = realOddsFromESPN(comp, 0.5);
    expect(r.homeML).toBe(-150);
    expect(r.awayML).toBe(130);
    expect(r.homeImpl + r.awayImpl).toBeCloseTo(1, 5);
    expect(r.homeImpl).toBeGreaterThan(r.awayImpl); // -150 favorite implies higher win prob
    expect(r.overUnder).toBe(8.5);
    expect(r.provider).toBe("consensus");
    expect(r.real).toBe(true);
  });
  it("defaults the provider name when ESPN doesn't supply one", () => {
    const comp = { odds: [{ homeTeamOdds: { moneyLine: 100 }, awayTeamOdds: { moneyLine: -120 } }] };
    expect(realOddsFromESPN(comp, 0.5).provider).toBe("ESPN BET");
  });
});

describe("applyRealPitcher", () => {
  it("does nothing when there's no probable-pitcher entry", () => {
    const p = { era: "4.00", xfip: "4.00", realQ: false, synth: true };
    applyRealPitcher(p, null);
    expect(p).toEqual({ era: "4.00", xfip: "4.00", realQ: false, synth: true });
  });

  it("overlays real ERA and marks the pitcher as real/non-synthetic", () => {
    const p = { era: "4.00", xfip: "4.00", whip: "1.20", realQ: false, synth: true };
    const prob = { statistics: [{ name: "ERA", displayValue: "2.85" }] };
    applyRealPitcher(p, prob);
    expect(p.era).toBe("2.85");
    expect(p.xfip).toBe("2.85"); // ERA drives the run-prevention feature when that's all we have
    expect(p.realQ).toBe(true);
    expect(p.synth).toBe(false);
  });

  it("overlays WHIP separately from ERA", () => {
    const p = { whip: "1.20" };
    applyRealPitcher(p, { statistics: [{ name: "whip", displayValue: "0.95" }] });
    expect(p.whip).toBe("0.95");
  });

  it("ignores unrecognized stat entries without throwing", () => {
    const p = { era: "4.00" };
    applyRealPitcher(p, { statistics: [{ name: "strikeouts", displayValue: "180" }] });
    expect(p.era).toBe("4.00");
    expect(p.realQ).toBeUndefined();
  });

  it("does not mark realQ true when a stat exists but has no usable value", () => {
    const p = { era: "4.00", realQ: false, synth: true };
    applyRealPitcher(p, { statistics: [{ name: "ERA", displayValue: null, value: null }] });
    expect(p.realQ).toBe(false);
    expect(p.synth).toBe(true);
  });

  it("reads stats nested under prob.athlete.statistics as a fallback location", () => {
    const p = {};
    applyRealPitcher(p, { athlete: { statistics: [{ name: "ERA", displayValue: "3.10" }] } });
    expect(p.era).toBe("3.10");
  });

  it("copies the win-loss record when present", () => {
    const p = {};
    applyRealPitcher(p, { record: "8-4" });
    expect(p.wl).toBe("8-4");
  });
});

describe("applyRealRecordCore", () => {
  it("returns the existing split unchanged when comp is missing", () => {
    const existing = { rec: "10-5" };
    expect(applyRealRecordCore(existing, null)).toBe(existing);
  });
  it("returns null (no existing split, nothing to add) when comp has no records", () => {
    expect(applyRealRecordCore(null, {})).toBeNull();
  });
  it("creates a default split from scratch when real records are present and none existed", () => {
    const comp = { records: [{ type: "total", summary: "20-10" }] };
    const r = applyRealRecordCore(null, comp);
    expect(r.rec).toBe("20-10");
    expect(r._real).toBe(true);
    expect(r.home).toBe("0-0"); // default, no home-specific record in this fixture
  });
  it("overlays home/away splits when present, without touching other existing fields", () => {
    const existing = { rec: "0-0", home: "0-0", away: "0-0", l10: "7-3" };
    const comp = {
      records: [
        { type: "total", summary: "20-10" },
        { type: "home", summary: "12-3" },
        { type: "road", summary: "8-7" },
      ],
    };
    const r = applyRealRecordCore(existing, comp);
    expect(r.rec).toBe("20-10");
    expect(r.home).toBe("12-3");
    expect(r.away).toBe("8-7");
    expect(r.l10).toBe("7-3"); // untouched
    expect(existing.rec).toBe("0-0"); // original object not mutated
  });
  it("does not modify the passed-in existing split object (returns a copy)", () => {
    const existing = { rec: "0-0" };
    const comp = { records: [{ type: "total", summary: "15-15" }] };
    applyRealRecordCore(existing, comp);
    expect(existing.rec).toBe("0-0");
  });
});
