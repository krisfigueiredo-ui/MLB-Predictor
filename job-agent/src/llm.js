/**
 * Optional Claude-assisted writing (Anthropic Messages API).
 *
 * Used for two things only: tailoring the cover letter draft you already wrote,
 * and answering freeform application questions from facts in your profile.
 * Both are grounded — the model is told to work only from the profile, and to
 * return INSUFFICIENT_PROFILE_DATA rather than invent experience. Anything it
 * declines to answer is reported as unanswered, never filled with a guess.
 *
 * Entirely optional: without credentials the agent falls back to the
 * deterministic template path.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-opus-5";
const NO_ANSWER = "INSUFFICIENT_PROFILE_DATA";

// Thinking is on by default on Claude Opus 5 and shares max_tokens with the
// response, so leave headroom well above the length of the letter itself.
const MAX_TOKENS = 8000;

const SYSTEM = [
  "You help someone fill out their own job applications.",
  "",
  "Ground rules:",
  "- Use only facts present in the candidate profile JSON you are given.",
  "- Never invent employers, titles, dates, degrees, metrics, or skills.",
  "- Never overstate: if the profile says 3 years, do not write 'nearly a decade'.",
  "- Write in first person as the candidate, in plain direct prose.",
  "- No preamble, no commentary, no markdown headings. Output only the text asked for.",
  `- If the profile lacks the facts needed to answer honestly, reply with exactly ${NO_ANSWER}.`
].join("\n");

let cachedClient;

function getClient() {
  if (cachedClient !== undefined) return cachedClient;
  try {
    cachedClient = new Anthropic();
  } catch {
    cachedClient = null;
  }
  return cachedClient;
}

/** Only the profile facts a writing task needs — no documents, no custom answers. */
function profileFacts(profile) {
  return {
    name: [profile.personal?.firstName, profile.personal?.lastName].filter(Boolean).join(" "),
    location: profile.personal?.location,
    currentTitle: profile.work?.currentTitle,
    currentCompany: profile.work?.currentCompany,
    yearsExperience: profile.work?.yearsExperience,
    education: profile.education,
    highlights: profile.highlights,
    links: profile.links
  };
}

function extractText(response) {
  // A safety classifier can decline; check stop_reason before reading content.
  if (response.stop_reason === "refusal") {
    return { text: null, refused: true, category: response.stop_details?.category ?? null };
  }
  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
  return { text, refused: false };
}

async function ask(prompt, { maxTokens = MAX_TOKENS } = {}) {
  const client = getClient();
  if (!client) return { text: null, reason: "anthropic sdk unavailable" };

  const request = {
    model: MODEL,
    max_tokens: maxTokens,
    output_config: { effort: "medium" },
    system: SYSTEM,
    messages: [{ role: "user", content: prompt }]
  };

  let response;
  try {
    // Server-side fallback re-runs the request on another model if a safety
    // classifier declines it, so a false positive doesn't lose the letter.
    response = await client.beta.messages.create({
      ...request,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default"
    });
  } catch (error) {
    if (error?.status !== 400) {
      return { text: null, reason: `Claude request failed: ${error.message}` };
    }
    // Older API surfaces reject the fallback beta; the plain request still works.
    try {
      response = await client.messages.create(request);
    } catch (retryError) {
      return { text: null, reason: `Claude request failed: ${retryError.message}` };
    }
  }

  const { text, refused, category } = extractText(response);
  if (refused) return { text: null, reason: `Claude declined this request (${category ?? "unspecified"})` };
  if (!text || text.includes(NO_ANSWER)) return { text: null, reason: "profile lacks the facts to answer honestly" };
  if (response.stop_reason === "max_tokens") return { text: null, reason: "response was truncated" };
  return { text };
}

/**
 * True when the SDK is installed and a credential source looks configured.
 * The SDK only fails on credentials at request time, so check for them here —
 * otherwise --ai reports "available" and then fails on every posting.
 */
export function llmAvailable() {
  if (!getClient()) return false;
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return true;
  // `ant auth login` stores a profile the SDK picks up on its own.
  const configDir = process.env.ANTHROPIC_CONFIG_DIR
    || (process.platform === "win32"
      ? join(process.env.APPDATA || "", "Anthropic")
      : join(homedir(), ".config", "anthropic"));
  return existsSync(join(configDir, "credentials"));
}

/**
 * Rewrite the template-generated draft for one specific posting.
 * Returns `{ text }` on success or `{ text: null, reason }` — callers keep the
 * deterministic draft whenever tailoring is unavailable.
 */
export async function tailorCoverLetter({ profile, job, draft }) {
  const prompt = [
    "Tailor this cover letter draft to the job below.",
    "Keep it under 250 words, keep the candidate's voice, and keep every factual claim traceable to the profile.",
    "Do not add achievements that are not in the profile.",
    "",
    `COMPANY: ${job.company || "unknown"}`,
    `ROLE: ${job.role || "unknown"}`,
    "",
    "JOB DESCRIPTION:",
    (job.description || "(not provided)").slice(0, 6000),
    "",
    "CANDIDATE PROFILE (JSON):",
    JSON.stringify(profileFacts(profile), null, 2),
    "",
    "CURRENT DRAFT:",
    draft
  ].join("\n");

  return ask(prompt);
}

/**
 * Answer one freeform application question ("Why do you want to work here?").
 * Returns `{ text: null, reason }` when the profile can't support an answer.
 */
export async function answerFreeform({ profile, job, question, maxWords = 150 }) {
  const prompt = [
    `Answer this job application question in at most ${maxWords} words.`,
    "",
    `QUESTION: ${question}`,
    "",
    `COMPANY: ${job.company || "unknown"}`,
    `ROLE: ${job.role || "unknown"}`,
    "",
    "JOB DESCRIPTION:",
    (job.description || "(not provided)").slice(0, 4000),
    "",
    "CANDIDATE PROFILE (JSON):",
    JSON.stringify(profileFacts(profile), null, 2)
  ].join("\n");

  return ask(prompt, { maxTokens: 6000 });
}
