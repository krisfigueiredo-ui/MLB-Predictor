/**
 * Cover letter assembly.
 *
 * Deterministic by default: your template, your highlights, ranked against the
 * job description by keyword overlap. Claude-assisted tailoring is optional and
 * lives in llm.js — it rewrites your own material, it does not invent history.
 */

import { normalizeText } from "./fields.js";
import { displayName } from "./profile.js";

const DEFAULT_TEMPLATE = [
  "Dear {{company}} hiring team,",
  "",
  "I'm applying for the {{role}} role. {{opening}}",
  "",
  "{{highlights}}",
  "",
  "{{closing}}",
  "",
  "{{signoff}}",
  "{{name}}"
].join("\n");

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "you", "our", "are", "will", "your", "have", "this", "that",
  "from", "who", "all", "can", "into", "their", "them", "they", "has", "was", "were", "been",
  "job", "role", "work", "team", "teams", "years", "year", "including", "such", "about",
  "we", "us", "a", "an", "in", "of", "to", "on", "at", "as", "is", "it", "be", "or", "by"
]);

/** Content words from free text, used for highlight ranking. */
export function keywords(text) {
  return normalizeText(text)
    .split(" ")
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
}

/**
 * Rank profile highlights against the job description.
 * A highlight scores on its declared keywords first, then on words in its text.
 * With no job description, the profile's own order is preserved.
 */
export function rankHighlights(highlights = [], jobDescription = "", limit = 3) {
  const wanted = new Set(keywords(jobDescription));
  const scored = highlights.map((highlight, index) => {
    const text = typeof highlight === "string" ? highlight : highlight.text || "";
    const declared = typeof highlight === "string" ? [] : highlight.keywords || [];
    let score = 0;
    for (const keyword of declared) {
      if (keywords(keyword).some((word) => wanted.has(word))) score += 3;
    }
    for (const word of new Set(keywords(text))) {
      if (wanted.has(word)) score += 1;
    }
    return { text, score, index };
  });

  return scored
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))
    .slice(0, limit)
    .filter((entry) => entry.text)
    .map((entry) => entry.text);
}

/**
 * Substitute {{placeholders}}. Missing keys are reported rather than silently
 * left as literal braces in a letter you're about to send.
 */
export function renderTemplate(template, vars = {}) {
  const missing = new Set();
  const text = template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key) => {
    const value = vars[key];
    if (value === undefined || value === null || value === "") {
      missing.add(key);
      return "";
    }
    return String(value);
  });
  return { text: text.replace(/\n{3,}/g, "\n\n").trim(), missing: [...missing] };
}

/**
 * Build the letter body for one job.
 * `job` is `{ company, role, description, url }`.
 */
export function buildCoverLetter(profile, job = {}, options = {}) {
  const config = profile.coverLetter || {};
  const template = options.template || config.template || DEFAULT_TEMPLATE;
  const bullets = rankHighlights(profile.highlights || [], job.description || "", options.maxHighlights || 3);

  const vars = {
    company: job.company || "your",
    role: job.role || "the advertised",
    name: displayName(profile),
    opening: options.opening || config.opening || "",
    closing: options.closing || config.closing || "",
    signoff: config.signoff || "Best regards,",
    highlights: bullets.map((line) => `- ${line}`).join("\n"),
    currentTitle: profile.work?.currentTitle || "",
    currentCompany: profile.work?.currentCompany || "",
    yearsExperience: profile.work?.yearsExperience ?? ""
  };

  const rendered = renderTemplate(template, vars);
  return { text: rendered.text, missing: rendered.missing, highlights: bullets };
}
