/**
 * Turn a scraped form into an ordered plan of actions.
 *
 * Planning is deliberately separate from execution: the plan is inspectable,
 * testable, and printed in full before anything is submitted.
 */

import { matchFields } from "./fields.js";
import { planField } from "./answers.js";

const FILLABLE = new Set(["fill", "select", "check", "upload"]);

export function planApplication(fields = [], profile, context = {}) {
  const matched = matchFields(fields);
  const steps = matched.map((field) => planField(field, profile, context));

  const actions = steps.filter((step) => FILLABLE.has(step.action));
  const skipped = steps.filter((step) => step.action === "skip");
  const blockers = skipped.filter((step) => step.field.required);

  return {
    steps,
    actions,
    skipped,
    blockers,
    canSubmit: blockers.length === 0,
    summary: {
      total: steps.length,
      filled: actions.length,
      skipped: skipped.length,
      requiredUnanswered: blockers.length
    }
  };
}

/** Labels often already carry the page's own required marker; don't double it. */
function describeField(field) {
  const raw = field.label || field.name || field.id || "(unlabeled)";
  const label = raw.replace(/\s*[*✱]\s*$/, "").replace(/\s*\(required\)\s*$/i, "").trim();
  return field.required ? `${label} *` : label;
}

/** Human-readable plan, printed before every fill and before any submission. */
export function formatPlan(plan) {
  const lines = [];
  for (const step of plan.steps) {
    const tag = `[${step.action}]`.padEnd(9);
    const label = describeField(step.field);
    if (step.action === "skip") {
      lines.push(`  ${tag}${label} — ${step.reason}`);
    } else if (step.action === "upload") {
      lines.push(`  ${tag}${label} <- ${step.value}`);
    } else {
      const flat = String(step.value).replace(/\s+/g, " ");
      const shown = flat.length > 60 ? `${flat.slice(0, 57)}...` : flat;
      lines.push(`  ${tag}${label} <- ${shown}`);
    }
  }
  const s = plan.summary;
  lines.push(`  ${s.filled} filled, ${s.skipped} skipped, ${s.requiredUnanswered} required field(s) unanswered`);
  return lines.join("\n");
}
