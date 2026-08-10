/**
 * Answer resolution: semantic key -> the value from your profile.
 *
 * Every answer traces back to something you wrote in the profile. When a field
 * has no profile value the resolver returns null and the caller records it as
 * unanswered — the agent never fabricates an answer on your behalf.
 */

import { normalizeText } from "./fields.js";
import { displayName } from "./profile.js";

const AFFIRMATIVE = ["yes", "y", "true", "i am", "authorized", "agree", "i agree", "accept"];
const NEGATIVE = ["no", "n", "false", "i am not", "not required", "decline"];
const DECLINE = ["decline", "prefer not", "do not wish", "dont wish", "not wish to", "choose not", "i dont wish to answer"];

/** Resolvers keyed by the semantic keys produced by fields.js. */
const RESOLVERS = {
  firstName: (p) => p.personal?.firstName,
  lastName: (p) => p.personal?.lastName,
  preferredName: (p) => p.personal?.preferredName || p.personal?.firstName,
  fullName: (p) => displayName(p) || undefined,
  email: (p) => p.personal?.email,
  confirmEmail: (p) => p.personal?.email,
  phone: (p) => p.personal?.phone,
  pronouns: (p) => p.personal?.pronouns,

  addressLine1: (p) => p.personal?.location?.addressLine1,
  city: (p) => p.personal?.location?.city,
  state: (p) => p.personal?.location?.state,
  postalCode: (p) => p.personal?.location?.postalCode,
  country: (p) => p.personal?.location?.country,
  location: (p) => {
    const loc = p.personal?.location || {};
    return [loc.city, loc.state, loc.country].filter(Boolean).join(", ") || undefined;
  },

  linkedin: (p) => p.links?.linkedin,
  github: (p) => p.links?.github,
  portfolio: (p) => p.links?.portfolio,
  website: (p) => p.links?.website || p.links?.portfolio,

  resume: (p) => p.documents?.resume,
  coverLetter: (p, ctx) => ctx?.coverLetterPath || p.documents?.coverLetter,

  currentCompany: (p) => p.work?.currentCompany,
  currentTitle: (p) => p.work?.currentTitle,
  yearsExperience: (p) => (p.work?.yearsExperience === undefined ? undefined : String(p.work.yearsExperience)),
  salaryExpectation: (p) => p.work?.salaryExpectation,
  startDate: (p) => p.work?.startDate,
  noticePeriod: (p) => p.work?.noticePeriod,

  school: (p) => p.education?.school,
  degree: (p) => p.education?.degree,
  major: (p) => p.education?.major,
  graduationYear: (p) => (p.education?.graduationYear === undefined ? undefined : String(p.education.graduationYear)),

  workAuthorized: (p) => p.eligibility?.workAuthorized,
  requiresSponsorship: (p) => p.eligibility?.requiresSponsorship,
  willingToRelocate: (p) => p.eligibility?.willingToRelocate,
  remotePreference: (p) => p.eligibility?.remotePreference,

  gender: (p) => p.demographics?.gender,
  race: (p) => p.demographics?.race,
  hispanicLatino: (p) => p.demographics?.hispanicLatino,
  veteranStatus: (p) => p.demographics?.veteranStatus,
  disabilityStatus: (p) => p.demographics?.disabilityStatus,

  howDidYouHear: (p) => p.answers?.howDidYouHear,
  referral: (p) => p.answers?.referral,
  whyCompany: (p, ctx) => ctx?.whyCompany || p.answers?.whyCompany,
  whyRole: (p, ctx) => ctx?.whyRole || p.answers?.whyRole,
  consent: () => true
};

/**
 * Look up a custom answer by matching the question text against the patterns in
 * `profile.answers.custom`. Longest matching pattern wins, so a specific entry
 * beats a catch-all.
 */
export function customAnswer(profile, questionText) {
  const entries = profile.answers?.custom;
  if (!Array.isArray(entries) || !questionText) return undefined;
  const haystack = normalizeText(questionText);
  let best;
  for (const entry of entries) {
    if (!entry || !entry.match) continue;
    const needle = normalizeText(entry.match);
    if (!needle || !haystack.includes(needle)) continue;
    if (!best || needle.length > best.length) best = { length: needle.length, answer: entry.answer };
  }
  return best ? best.answer : undefined;
}

/**
 * Resolve one semantic key. Returns `{ value }` or null when the profile has
 * nothing to say. `context` carries per-application extras (a generated cover
 * letter path, tailored freeform answers).
 */
export function resolveAnswer(key, profile, context = {}) {
  if (!key) return null;
  const resolver = RESOLVERS[key];
  if (!resolver) return null;
  const value = resolver(profile, context);
  if (value === undefined || value === null || value === "") return null;
  return { key, value };
}

function optionMatchesList(option, list) {
  return list.some((candidate) => option === candidate || option.startsWith(`${candidate} `));
}

/**
 * Pick the option from a select/radio group that expresses `value`.
 * Handles booleans ("Yes"/"No"), decline-to-answer variants, and plain text.
 * Returns the original option string, or null if nothing is a safe match.
 */
export function matchOption(value, options = []) {
  if (value === undefined || value === null || options.length === 0) return null;
  const normalizedOptions = options.map((option) => ({ raw: option, text: normalizeText(option) }));

  if (typeof value === "boolean") {
    const wanted = value ? AFFIRMATIVE : NEGATIVE;
    const hit = normalizedOptions.find((option) => optionMatchesList(option.text, wanted));
    return hit ? hit.raw : null;
  }

  const wanted = normalizeText(value);
  if (!wanted) return null;

  const exact = normalizedOptions.find((option) => option.text === wanted);
  if (exact) return exact.raw;

  if (DECLINE.some((phrase) => wanted.includes(phrase))) {
    const declined = normalizedOptions.find((option) => DECLINE.some((phrase) => option.text.includes(phrase)));
    if (declined) return declined.raw;
  }

  const contains = normalizedOptions.find((option) => option.text.includes(wanted) || wanted.includes(option.text));
  if (contains && contains.text.length > 1) return contains.raw;

  return null;
}

/**
 * Decide what to do with a single matched field.
 * Returns an action object; `action: "skip"` always carries a reason so the
 * run report can explain every gap.
 */
export function planField(field, profile, context = {}) {
  const question = field.label || field.ariaLabel || field.placeholder || field.name || "";

  // A cover letter is a file upload on some boards and a textarea on others.
  if (field.key === "coverLetter" && field.type !== "file" && context.coverLetterText) {
    return { field, action: "fill", value: context.coverLetterText };
  }
  const resolved = resolveAnswer(field.key, profile, context);
  const custom = customAnswer(profile, question);
  const value = resolved ? resolved.value : custom;

  if (value === undefined || value === null || value === "") {
    return { field, action: "skip", reason: field.key ? `no profile value for "${field.key}"` : "unrecognized field" };
  }

  if (field.type === "file") {
    return { field, action: "upload", value: String(value) };
  }

  if (field.type === "checkbox") {
    const checked = typeof value === "boolean" ? value : !NEGATIVE.includes(normalizeText(value));
    return { field, action: "check", value: checked };
  }

  if (Array.isArray(field.options) && field.options.length > 0) {
    const option = matchOption(value, field.options);
    if (!option) {
      return {
        field,
        action: "skip",
        reason: `no option matches "${value}" (options: ${field.options.join(" | ")})`
      };
    }
    return { field, action: field.type === "radio" ? "check" : "select", value: option };
  }

  return { field, action: "fill", value: String(value) };
}
