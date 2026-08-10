/**
 * Field matching: turn a raw form control into a semantic key.
 *
 * A field descriptor is whatever the page gives us about one control:
 *   { label, name, id, placeholder, ariaLabel, type, required, options }
 *
 * Matching is scored rather than first-match-wins, because job forms label the
 * same thing a dozen ways ("Mobile", "Phone number", "Contact no.") and a
 * single control often carries contradictory hints (name="field_1234",
 * label="Email").
 */

const SOURCE_WEIGHTS = {
  label: 4,
  ariaLabel: 4,
  placeholder: 2,
  name: 2,
  id: 1
};

const SOURCES = Object.keys(SOURCE_WEIGHTS);

/** Lowercase, collapse separators, so "first_name" and "First Name*" agree. */
export function normalizeText(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    // Apostrophes close up rather than split, so "don't" -> "dont" and the
    // decline-to-answer phrasings stay matchable.
    .replace(/['’ʼ`]/g, "")
    .replace(/[_\-.]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Rules are ordered most-specific-first. `patterns` are matched against
 * normalized text; `exclude` vetoes a rule outright so that "Company website"
 * never resolves to "Current company".
 */
export const FIELD_RULES = [
  { key: "confirmEmail", patterns: [/\b(confirm|verify|re enter|repeat)\b.*\bemail\b/, /\bemail\b.*\bconfirm/] },
  { key: "email", patterns: [/\be ?mail\b/, /\bemail address\b/] },

  { key: "firstName", patterns: [/\bfirst name\b/, /\bgiven name\b/, /\bforename\b/] },
  { key: "lastName", patterns: [/\blast name\b/, /\bfamily name\b/, /\bsurname\b/] },
  { key: "preferredName", patterns: [/\b(preferred|nick) name\b/, /\bgoes by\b/] },
  { key: "fullName", patterns: [/\bfull name\b/, /\byour name\b/, /^name$/, /\bcandidate name\b/, /\blegal name\b/] },

  { key: "phone", patterns: [/\bphone\b/, /\bmobile\b/, /\bcell\b/, /\btelephone\b/, /\bcontact number\b/] },

  { key: "linkedin", patterns: [/\blinked ?in\b/] },
  { key: "github", patterns: [/\bgit ?hub\b/] },
  { key: "portfolio", patterns: [/\bportfolio\b/, /\bpersonal (site|website)\b/, /\bdribbble\b/, /\bbehance\b/] },
  {
    key: "website",
    patterns: [/\bwebsite\b/, /\bweb ?site url\b/, /\bblog\b/],
    exclude: [/\bcompany\b/, /\bemployer\b/, /\bportfolio\b/]
  },

  { key: "resume", patterns: [/\bresume\b/, /\bcv\b/, /\bcurriculum vitae\b/] },
  { key: "coverLetter", patterns: [/\bcover letter\b/, /\bmotivation letter\b/] },

  {
    key: "currentCompany",
    patterns: [/\bcurrent (company|employer)\b/, /\bcompany\b/, /\bemployer\b/],
    exclude: [/\bwhy\b/, /\bwebsite\b/, /\bknow\b/, /\bhear\b/]
  },
  {
    key: "currentTitle",
    patterns: [/\bcurrent (title|role|position)\b/, /\bjob title\b/, /\btitle\b/, /\boccupation\b/],
    exclude: [/\bmr\b/, /\bms\b/, /\bapplying\b/, /\bposition applied\b/]
  },
  { key: "yearsExperience", patterns: [/\byears? of (relevant )?experience\b/, /\byears? experience\b/, /\bhow many years\b/] },

  { key: "school", patterns: [/\b(school|university|college|institution)\b/, /\balma mater\b/] },
  { key: "degree", patterns: [/\bdegree\b/, /\bqualification\b/] },
  { key: "major", patterns: [/\b(major|discipline|field of study)\b/] },
  { key: "graduationYear", patterns: [/\bgraduation (year|date)\b/, /\byear graduated\b/, /\bend date\b/] },

  { key: "city", patterns: [/\bcity\b/, /\btown\b/, /\blocality\b/] },
  { key: "state", patterns: [/\bstate\b/, /\bprovince\b/, /\bregion\b/] },
  { key: "postalCode", patterns: [/\b(zip|postal)( ?code)?\b/, /\bpostcode\b/] },
  { key: "country", patterns: [/\bcountry\b/] },
  {
    key: "addressLine1",
    patterns: [/\bstreet\b/, /\baddress line 1\b/, /\baddress\b/],
    exclude: [/\bemail\b/, /\bip\b/]
  },
  { key: "location", patterns: [/\b(current )?location\b/, /\bwhere are you based\b/, /\bbased in\b/] },

  { key: "requiresSponsorship", patterns: [/\bsponsor(ship)?\b/, /\bvisa (support|sponsorship)\b/] },
  {
    key: "workAuthorized",
    patterns: [/\b(legally )?authoriz(ed|ation) to work\b/, /\bright to work\b/, /\bwork permit\b/, /\beligible to work\b/]
  },
  { key: "willingToRelocate", patterns: [/\brelocat/] },
  { key: "remotePreference", patterns: [/\bremote\b/, /\bhybrid\b/, /\bon ?site\b/, /\bwork (arrangement|preference)\b/] },

  { key: "salaryExpectation", patterns: [/\b(salary|compensation|pay)\b.*\b(expect|requirement|desired|range)\b/, /\bexpected (salary|compensation)\b/, /\bdesired (salary|compensation|pay)\b/, /\bsalary\b/, /\bcompensation\b/] },
  { key: "startDate", patterns: [/\b(start|available|availability) date\b/, /\bwhen can you start\b/, /\bearliest start\b/] },
  { key: "noticePeriod", patterns: [/\bnotice period\b/] },

  { key: "howDidYouHear", patterns: [/\bhow did you (hear|find)\b/, /\bsource\b/, /\bwhere did you (hear|find)\b/] },
  { key: "referral", patterns: [/\brefer(ral|red by)\b/, /\bwho referred\b/, /\bemployee referral\b/] },
  { key: "whyCompany", patterns: [/\bwhy (do you want to work |are you interested in )?(at |in )?(this )?(company|us|here)\b/, /\bwhy join\b/, /\bwhy are you interested\b/] },
  { key: "whyRole", patterns: [/\bwhy (this|the) (role|position|job)\b/, /\bwhat interests you about (this|the) (role|position)\b/] },

  { key: "pronouns", patterns: [/\bpronoun/] },
  { key: "gender", patterns: [/\bgender\b/, /\bsex\b/] },
  { key: "race", patterns: [/\b(race|ethnicity|ethnic)\b/] },
  { key: "veteranStatus", patterns: [/\bveteran\b/, /\bmilitary service\b/] },
  { key: "disabilityStatus", patterns: [/\bdisabilit(y|ies)\b/] },
  { key: "hispanicLatino", patterns: [/\bhispanic\b/, /\blatin[oax]\b/] },

  { key: "consent", patterns: [/\bi (agree|consent|acknowledge|certify)\b/, /\bprivacy (policy|notice)\b/, /\bterms\b/, /\bgdpr\b/, /\bdata (processing|retention)\b/] }
];

const RULE_ORDER = new Map(FIELD_RULES.map((rule, index) => [rule.key, index]));

function matchRule(rule, normalized) {
  let best = null;
  for (const source of SOURCES) {
    const text = normalized[source];
    if (!text) continue;
    if (rule.exclude && rule.exclude.some((pattern) => pattern.test(text))) return null;
    if (!rule.patterns.some((pattern) => pattern.test(text))) continue;
    const weight = SOURCE_WEIGHTS[source];
    if (!best || weight > best.weight) best = { source, weight };
  }
  return best;
}

/**
 * Resolve a descriptor to `{ key, score, source }`, or null when nothing fits.
 * Ties break toward the earlier (more specific) rule.
 */
export function matchField(descriptor = {}) {
  const normalized = {};
  for (const source of SOURCES) normalized[source] = normalizeText(descriptor[source]);

  // A control's own type is a strong hint the text can't override.
  if (descriptor.type === "file" && !normalized.label && !normalized.name) {
    return { key: "resume", score: SOURCE_WEIGHTS.label, source: "type" };
  }

  let winner = null;
  for (const rule of FIELD_RULES) {
    const hit = matchRule(rule, normalized);
    if (!hit) continue;
    const candidate = { key: rule.key, score: hit.weight, source: hit.source };
    if (!winner) {
      winner = candidate;
      continue;
    }
    if (candidate.score > winner.score) winner = candidate;
    else if (candidate.score === winner.score && RULE_ORDER.get(candidate.key) < RULE_ORDER.get(winner.key)) {
      winner = candidate;
    }
  }

  if (winner && descriptor.type === "file" && winner.key !== "resume" && winner.key !== "coverLetter") {
    return { key: "resume", score: winner.score, source: "type" };
  }
  return winner;
}

/** Annotate a list of descriptors with their matched key. */
export function matchFields(descriptors = []) {
  return descriptors.map((descriptor) => {
    const match = matchField(descriptor);
    return { ...descriptor, key: match ? match.key : null, matchScore: match ? match.score : 0 };
  });
}
