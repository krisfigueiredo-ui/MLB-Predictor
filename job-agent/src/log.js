/**
 * Application log (JSONL, one record per attempt).
 *
 * Doubles as the duplicate guard: applying twice to the same posting is worse
 * than not applying at all, so every run checks the log first.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { normalizeText } from "./fields.js";

/** Drop tracking params and trailing slashes so the same posting matches itself. */
export function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = "";
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.hostname.toLowerCase()}${path}`;
  } catch {
    return String(url || "").trim().toLowerCase();
  }
}

/** Identity of a posting: its URL, plus company+role as a secondary key. */
export function jobKey(job = {}) {
  if (job.url) return normalizeUrl(job.url);
  return `${normalizeText(job.company)}::${normalizeText(job.role)}`;
}

export function isDuplicate(entries = [], job = {}) {
  const key = jobKey(job);
  const company = normalizeText(job.company);
  const role = normalizeText(job.role);
  return entries.some((entry) => {
    if (entry.status === "failed") return false;
    if (entry.key && entry.key === key) return true;
    if (!company || !role) return false;
    return normalizeText(entry.company) === company && normalizeText(entry.role) === role;
  });
}

export function readEntries(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * Record one attempt. `status` is "submitted", "prepared" (filled but not
 * submitted), or "failed".
 */
export function appendEntry(path, entry) {
  const record = {
    timestamp: new Date().toISOString(),
    key: jobKey(entry),
    ...entry
  };
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
  return record;
}
