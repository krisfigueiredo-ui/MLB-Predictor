import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendEntry, isDuplicate, jobKey, normalizeUrl, readEntries } from "../job-agent/src/log.js";
import { detectATS, getAdapter, jobMetaFromUrl } from "../job-agent/src/ats.js";

describe("url normalization", () => {
  it("ignores tracking params, fragments and trailing slashes", () => {
    const canonical = "boards.greenhouse.io/acme/jobs/123";
    expect(normalizeUrl("https://boards.greenhouse.io/acme/jobs/123")).toBe(canonical);
    expect(normalizeUrl("https://boards.greenhouse.io/acme/jobs/123/?gh_src=linkedin")).toBe(canonical);
    expect(normalizeUrl("https://BOARDS.greenhouse.io/acme/jobs/123#app")).toBe(canonical);
  });

  it("falls back to the raw string for non-URLs", () => {
    expect(normalizeUrl("not a url")).toBe("not a url");
  });
});

describe("duplicate detection", () => {
  const entries = [
    { key: jobKey({ url: "https://jobs.lever.co/acme/abc" }), url: "https://jobs.lever.co/acme/abc", company: "Acme", role: "SRE", status: "submitted" },
    { key: "x", company: "Globex", role: "Backend Engineer", status: "prepared" },
    { key: "y", company: "Initech", role: "Data Engineer", status: "failed" }
  ];

  it("matches the same posting even with a different tracking URL", () => {
    expect(isDuplicate(entries, { url: "https://jobs.lever.co/acme/abc?utm_source=x" })).toBe(true);
  });

  it("matches on company and role when the URL differs", () => {
    expect(isDuplicate(entries, { url: "https://globex.com/careers/9", company: "Globex", role: "Backend Engineer" })).toBe(true);
  });

  it("does not block a genuinely new posting", () => {
    expect(isDuplicate(entries, { url: "https://jobs.lever.co/acme/xyz", company: "Acme", role: "Platform Engineer" })).toBe(false);
  });

  it("lets you retry a failed attempt", () => {
    expect(isDuplicate(entries, { url: "https://initech.com/j/1", company: "Initech", role: "Data Engineer" })).toBe(false);
  });
});

describe("log file round-trip", () => {
  let dir;
  let path;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "job-agent-log-"));
    path = join(dir, "nested", "applications.jsonl");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns an empty list before anything is logged", () => {
    expect(readEntries(path)).toEqual([]);
  });

  it("appends records, creating the directory, and reads them back", () => {
    appendEntry(path, { url: "https://jobs.lever.co/acme/abc", company: "Acme", status: "submitted" });
    appendEntry(path, { url: "https://jobs.lever.co/acme/def", company: "Acme", status: "prepared" });

    const entries = readEntries(path);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ company: "Acme", status: "submitted", key: "jobs.lever.co/acme/abc" });
    expect(entries[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(isDuplicate(entries, { url: "https://jobs.lever.co/acme/abc" })).toBe(true);
  });

  it("skips corrupt lines rather than failing the run", () => {
    appendEntry(path, { url: "https://a.example/1", status: "submitted" });
    appendFileSync(path, "{ not json\n");
    appendEntry(path, { url: "https://a.example/2", status: "submitted" });
    expect(readEntries(path)).toHaveLength(2);
  });
});

describe("ATS detection", () => {
  it("recognizes the major boards by host", () => {
    expect(detectATS("https://boards.greenhouse.io/acme/jobs/1")).toBe("greenhouse");
    expect(detectATS("https://jobs.lever.co/acme/abc")).toBe("lever");
    expect(detectATS("https://jobs.ashbyhq.com/acme/abc")).toBe("ashby");
    expect(detectATS("https://acme.wd1.myworkdayjobs.com/careers/job/1")).toBe("workday");
  });

  it("recognizes an embedded board from the page markup", () => {
    expect(detectATS("https://acme.com/careers/backend", "<div id='grnhse_app'></div>")).toBe("greenhouse");
  });

  it("falls back to generic for an unknown site or malformed url", () => {
    expect(detectATS("https://acme.com/careers/backend")).toBe("generic");
    expect(detectATS("not a url")).toBe("generic");
  });

  it("flags Workday as multi-step so the agent does not half-submit it", () => {
    expect(getAdapter("workday").multiStep).toBe(true);
    expect(getAdapter("greenhouse").multiStep).toBe(false);
    expect(getAdapter("nonexistent").name).toBe("generic");
  });

  it("guesses company and role from the posting URL", () => {
    expect(jobMetaFromUrl("https://boards.greenhouse.io/acme/jobs/123")).toEqual({ company: "Acme" });
    expect(jobMetaFromUrl("https://jobs.lever.co/globex/senior-backend-engineer"))
      .toEqual({ company: "Globex", role: "Senior Backend Engineer" });
    expect(jobMetaFromUrl("https://careers.initech.com/openings/data-engineer"))
      .toEqual({ company: "Initech", role: "Data Engineer" });
    expect(jobMetaFromUrl("nonsense")).toEqual({});
  });
});
