/**
 * Applicant tracking system detection.
 *
 * Most postings run on a handful of ATS platforms with stable markup, so
 * knowing which one we're on gives reliable form, apply-button, and submit
 * selectors. Unknown hosts fall back to a generic adapter that works on plain
 * HTML forms.
 */

const ADAPTERS = {
  greenhouse: {
    name: "greenhouse",
    hosts: [/(^|\.)greenhouse\.io$/, /(^|\.)greenhouse-boards\.com$/],
    markers: [/grnhse_app/i, /greenhouse\.io\/embed/i],
    formSelector: "form#application_form, form[action*='greenhouse'], main form, form",
    applyButtonSelectors: ["#apply_button", "a[href='#app']", "button:has-text('Apply')"],
    submitSelectors: ["#submit_app", "input[type='submit']", "button[type='submit']"],
    multiStep: false
  },
  lever: {
    name: "lever",
    hosts: [/(^|\.)lever\.co$/],
    markers: [/lever-application/i, /postings-btn/i],
    formSelector: "form.application-form, form[action*='lever'], form",
    applyButtonSelectors: [".postings-btn-wrapper a", "a[href*='/apply']", "button:has-text('Apply')"],
    submitSelectors: ["button.postings-btn", "button[type='submit']", "input[type='submit']"],
    multiStep: false
  },
  ashby: {
    name: "ashby",
    hosts: [/(^|\.)ashbyhq\.com$/],
    markers: [/ashby_embed/i, /_ashby/i],
    formSelector: "form",
    applyButtonSelectors: ["button:has-text('Apply')", "a:has-text('Apply')"],
    submitSelectors: ["button[type='submit']", "button:has-text('Submit')"],
    multiStep: false
  },
  smartrecruiters: {
    name: "smartrecruiters",
    hosts: [/(^|\.)smartrecruiters\.com$/],
    markers: [/smartrecruiters/i],
    formSelector: "form",
    applyButtonSelectors: ["button:has-text('Apply')", "a:has-text('I'm interested')"],
    submitSelectors: ["button[type='submit']", "button:has-text('Submit')"],
    multiStep: false
  },
  workday: {
    name: "workday",
    hosts: [/(^|\.)myworkdayjobs\.com$/, /(^|\.)workday\.com$/],
    markers: [/workday/i],
    formSelector: "form, div[data-automation-id='applyFlow']",
    applyButtonSelectors: ["a[data-automation-id='adventureButton']", "button:has-text('Apply')"],
    submitSelectors: ["button[data-automation-id='bottom-navigation-next-button']", "button[type='submit']"],
    multiStep: true,
    notes: "Workday applications span several pages and usually require an account; expect to finish this one by hand."
  },
  generic: {
    name: "generic",
    hosts: [],
    markers: [],
    formSelector: "form",
    applyButtonSelectors: ["button:has-text('Apply')", "a:has-text('Apply')"],
    submitSelectors: ["button[type='submit']", "input[type='submit']", "button:has-text('Submit')"],
    multiStep: false
  }
};

export function getAdapter(name) {
  return ADAPTERS[name] || ADAPTERS.generic;
}

/**
 * Identify the ATS from the URL, falling back to markers in the page HTML for
 * boards embedded on a company's own careers site.
 */
export function detectATS(url, html = "") {
  let hostname = "";
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    hostname = "";
  }

  for (const adapter of Object.values(ADAPTERS)) {
    if (adapter.hosts.some((pattern) => pattern.test(hostname))) return adapter.name;
  }
  if (html) {
    for (const adapter of Object.values(ADAPTERS)) {
      if (adapter.markers.length > 0 && adapter.markers.some((pattern) => pattern.test(html))) return adapter.name;
    }
  }
  return "generic";
}

/**
 * Best-effort company and role from the URL, used when the caller doesn't
 * supply them. Page-title parsing refines this later.
 */
export function jobMetaFromUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return {};
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  const host = parsed.hostname.toLowerCase();
  const meta = {};

  if (/greenhouse|lever|ashbyhq|smartrecruiters/.test(host)) {
    // e.g. /acme/jobs/12345 or /acme/12345
    if (segments.length > 0) meta.company = titleize(segments[0]);
  } else {
    const parts = host.replace(/^www\./, "").split(".");
    if (parts.length > 1) meta.company = titleize(parts[parts.length - 2]);
  }

  const slug = segments[segments.length - 1] || "";
  if (slug && !/^\d+$/.test(slug) && !/^[0-9a-f-]{20,}$/i.test(slug)) {
    meta.role = titleize(slug.replace(/\b\d{4,}\b/g, ""));
  }
  return meta;
}

function titleize(value) {
  return value
    .replace(/[-_+]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}
