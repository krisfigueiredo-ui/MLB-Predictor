/**
 * Profile loading and validation.
 *
 * The profile is the single source of truth for every answer the agent gives.
 * Nothing is invented at fill time: if a field has no profile value, the agent
 * reports it as unanswered rather than guessing.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const REQUIRED = [
  ["personal.firstName", (p) => p.personal?.firstName],
  ["personal.lastName", (p) => p.personal?.lastName],
  ["personal.email", (p) => p.personal?.email]
];

export function validateProfile(profile) {
  const errors = [];
  if (!profile || typeof profile !== "object") {
    return ["profile must be a JSON object"];
  }
  for (const [path, get] of REQUIRED) {
    if (!get(profile)) errors.push(`missing required field: ${path}`);
  }
  const email = profile.personal?.email;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.push(`personal.email does not look like an email address: ${email}`);
  }
  const years = profile.work?.yearsExperience;
  if (years !== undefined && years !== null && Number.isNaN(Number(years))) {
    errors.push(`work.yearsExperience must be a number, got: ${years}`);
  }
  return errors;
}

/** Resolve document paths relative to the profile file so profiles stay portable. */
function resolveDocuments(profile, baseDir) {
  const documents = { ...(profile.documents || {}) };
  for (const [name, value] of Object.entries(documents)) {
    if (typeof value !== "string" || value.length === 0) continue;
    documents[name] = isAbsolute(value) ? value : resolve(baseDir, value);
  }
  return { ...profile, documents };
}

export function loadProfile(path) {
  if (!existsSync(path)) {
    throw new Error(`profile not found: ${path}\nCopy job-agent/profile.example.json and fill it in.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`profile is not valid JSON (${path}): ${error.message}`);
  }
  const errors = validateProfile(parsed);
  if (errors.length > 0) {
    throw new Error(`profile is invalid (${path}):\n  - ${errors.join("\n  - ")}`);
  }
  const profile = resolveDocuments(parsed, dirname(resolve(path)));

  const missingDocs = Object.entries(profile.documents || {})
    .filter(([, value]) => typeof value === "string" && value.length > 0 && !existsSync(value))
    .map(([name, value]) => `${name}: ${value}`);
  if (missingDocs.length > 0) {
    throw new Error(`profile references files that do not exist:\n  - ${missingDocs.join("\n  - ")}`);
  }
  return profile;
}

/** Full name, honouring a preferred first name when one is set. */
export function displayName(profile) {
  const first = profile.personal?.preferredName || profile.personal?.firstName || "";
  const last = profile.personal?.lastName || "";
  return [first, last].filter(Boolean).join(" ");
}
