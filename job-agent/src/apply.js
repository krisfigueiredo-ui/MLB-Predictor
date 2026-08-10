/**
 * Orchestration for a single application.
 *
 * Order of operations is fixed and deliberate:
 *   dedupe -> open -> read form -> plan -> print plan -> fill -> screenshot
 *   -> (submit only when asked and only when nothing required is missing) -> log
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { detectATS, getAdapter, jobMetaFromUrl } from "./ats.js";
import { buildCoverLetter } from "./cover-letter.js";
import { planApplication, formatPlan } from "./plan.js";
import { appendEntry, isDuplicate, readEntries } from "./log.js";
import { llmAvailable, tailorCoverLetter, answerFreeform } from "./llm.js";
import {
  applyAction,
  confirmSubmission,
  extractFields,
  launchBrowser,
  openPosting,
  pageText,
  revealForm,
  screenshot,
  submitForm
} from "./browser.js";

const FREEFORM_KEYS = new Set(["whyCompany", "whyRole"]);

function slugify(value) {
  return String(value || "job")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "job";
}

/** Fill in company/role from the URL and page title when not supplied. */
function resolveJobMeta(job, url, title) {
  const fromUrl = jobMetaFromUrl(url);
  const meta = { url, company: job.company || fromUrl.company, role: job.role || fromUrl.role };
  if (title) {
    // Titles are usually "Role - Company" or "Role at Company".
    const match = title.match(/^(.*?)\s+(?:-|–|—|\bat\b|\|)\s+(.*)$/);
    if (match) {
      if (!job.role) meta.role = match[1].trim();
      if (!job.company) meta.company = match[2].trim().replace(/\s*\|.*$/, "");
    } else if (!job.role) {
      meta.role = title.trim();
    }
  }
  return meta;
}

/**
 * Try to answer freeform questions the profile didn't cover, using Claude
 * grounded in the profile. Questions it can't ground stay unanswered.
 */
async function fillFreeformGaps(plan, profile, job, log) {
  const candidates = plan.skipped.filter((step) => {
    const field = step.field;
    if (field.type !== "textarea" && !FREEFORM_KEYS.has(field.key)) return false;
    const question = field.label || field.ariaLabel || field.placeholder || "";
    return question.length > 10;
  });
  if (candidates.length === 0) return [];

  const answered = [];
  for (const step of candidates) {
    const question = step.field.label || step.field.ariaLabel || step.field.placeholder;
    log(`  drafting an answer for: ${question.slice(0, 80)}`);
    const result = await answerFreeform({ profile, job, question });
    if (!result.text) {
      log(`    left blank — ${result.reason}`);
      continue;
    }
    answered.push({ field: step.field, action: "fill", value: result.text, generated: true });
  }
  return answered;
}

/**
 * Apply to one posting.
 * Returns a report; the browser is always closed, success or failure.
 */
export async function applyToJob(job, profile, options = {}) {
  const {
    submit = false,
    headless = true,
    outDir = "runs",
    logPath = "applications.jsonl",
    useLLM = false,
    force = false,
    log = console.log
  } = options;

  const url = job.url;
  if (!url) throw new Error("job.url is required");

  const previous = readEntries(logPath);
  if (!force && isDuplicate(previous, job)) {
    log(`skipping ${url} — already in ${logPath} (use --force to apply anyway)`);
    return { status: "skipped", reason: "duplicate", url };
  }

  const urlMeta = jobMetaFromUrl(url);
  const runDir = join(outDir, `${Date.now()}-${slugify(job.company || urlMeta.company || job.role || urlMeta.role)}`);
  mkdirSync(runDir, { recursive: true });

  const { browser, context } = await launchBrowser({ headless });
  const report = { url, status: "failed", runDir, actions: [], unanswered: [] };

  try {
    const page = await openPosting(context, url);
    const html = await page.content();
    const atsName = detectATS(url, html);
    const adapter = getAdapter(atsName);
    log(`ATS: ${atsName}${adapter.notes ? ` — ${adapter.notes}` : ""}`);

    await revealForm(page, adapter);

    const title = await page.title();
    const description = await pageText(page);
    const meta = resolveJobMeta(job, url, title);
    report.company = meta.company;
    report.role = meta.role;
    report.ats = atsName;
    log(`Posting: ${meta.role || "(unknown role)"} @ ${meta.company || "(unknown company)"}`);

    const fields = await extractFields(page);
    log(`Found ${fields.length} form field(s).`);
    if (fields.length === 0) {
      throw new Error("no form fields found — the application may be behind a login or on another page");
    }

    // Cover letter: deterministic draft, optionally tailored by Claude.
    const letter = buildCoverLetter(profile, { ...meta, description });
    let letterText = letter.text;
    if (useLLM && llmAvailable()) {
      const tailored = await tailorCoverLetter({ profile, job: { ...meta, description }, draft: letterText });
      if (tailored.text) letterText = tailored.text;
      else log(`Cover letter left as the template draft — ${tailored.reason}`);
    }
    const letterPath = join(runDir, "cover-letter.txt");
    writeFileSync(letterPath, letterText, "utf8");

    const planContext = {
      coverLetterText: letterText,
      coverLetterPath: profile.documents?.coverLetter || null
    };

    let plan = planApplication(fields, profile, planContext);
    log("Plan:");
    log(formatPlan(plan));

    if (useLLM && llmAvailable() && plan.skipped.length > 0) {
      const extra = await fillFreeformGaps(plan, profile, { ...meta, description }, log);
      if (extra.length > 0) {
        const generated = new Set(extra.map((step) => step.field.marker));
        plan = {
          ...plan,
          actions: [...plan.actions, ...extra],
          skipped: plan.skipped.filter((step) => !generated.has(step.field.marker)),
          blockers: plan.blockers.filter((step) => !generated.has(step.field.marker))
        };
        plan.canSubmit = plan.blockers.length === 0;
      }
    }

    for (const step of plan.actions) {
      const result = await applyAction(page, step);
      const label = step.field.label || step.field.name || step.field.id;
      if (!result.ok) log(`  ! could not ${step.action} "${label}": ${result.error}`);
      report.actions.push({ field: label, action: step.action, ok: result.ok, error: result.error });
    }

    report.unanswered = plan.skipped.map((step) => ({
      field: step.field.label || step.field.name,
      required: Boolean(step.field.required),
      reason: step.reason
    }));

    const filledShot = await screenshot(page, join(runDir, "filled.png"));
    log(`Filled form screenshot: ${filledShot}`);
    writeFileSync(join(runDir, "plan.json"), JSON.stringify({ meta, plan: plan.summary, steps: report.actions, unanswered: report.unanswered }, null, 2));

    const failedActions = report.actions.filter((action) => !action.ok);

    if (!submit) {
      report.status = "prepared";
      log("Not submitting (dry run). Review the screenshot, then re-run with --submit.");
    } else if (!plan.canSubmit) {
      report.status = "prepared";
      log(`Not submitting: ${plan.blockers.length} required field(s) have no answer in your profile.`);
      for (const blocker of plan.blockers) {
        log(`  - ${blocker.field.label || blocker.field.name}: ${blocker.reason}`);
      }
    } else if (failedActions.length > 0 && !force) {
      report.status = "prepared";
      log(`Not submitting: ${failedActions.length} field(s) failed to fill. Re-run with --force to submit anyway.`);
    } else if (adapter.multiStep && !force) {
      report.status = "prepared";
      log(`Not submitting: ${atsName} applications span multiple pages. Finish this one by hand, or re-run with --force.`);
    } else {
      const result = await submitForm(page, adapter);
      if (!result.ok) {
        report.status = "prepared";
        log(`Submit failed: ${result.error}`);
      } else {
        const confirmation = await confirmSubmission(page);
        report.status = confirmation.confirmed ? "submitted" : "unconfirmed";
        report.confirmation = confirmation.evidence;
        log(confirmation.confirmed
          ? `Submitted — confirmed by page text: "${confirmation.evidence}"`
          : `Clicked submit but could not confirm (${confirmation.evidence}). Check the screenshot.`);
      }
      report.finalScreenshot = await screenshot(page, join(runDir, "after-submit.png"));
    }
  } catch (error) {
    report.status = "failed";
    report.error = error.message;
    log(`Error: ${error.message}`);
  } finally {
    await browser.close();
  }

  appendEntry(logPath, {
    url,
    company: report.company,
    role: report.role,
    ats: report.ats,
    status: report.status,
    runDir: report.runDir,
    unanswered: report.unanswered.length,
    error: report.error
  });

  return report;
}
