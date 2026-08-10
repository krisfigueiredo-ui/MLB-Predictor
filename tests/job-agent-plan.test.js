import { describe, it, expect } from "vitest";
import { planApplication, formatPlan } from "../job-agent/src/plan.js";

const profile = {
  personal: { firstName: "Jordan", lastName: "Rivera", email: "jordan@example.com", phone: "+1 555 0134" },
  documents: { resume: "/home/jordan/resume.pdf" },
  eligibility: { workAuthorized: true },
  answers: {}
};

const form = [
  { marker: "0", type: "text", label: "First Name *", required: true },
  { marker: "1", type: "text", label: "Last Name", required: true },
  { marker: "2", type: "email", label: "Email", required: true },
  { marker: "3", type: "text", label: "Phone", required: false },
  { marker: "4", type: "file", label: "Resume/CV", required: true },
  { marker: "5", type: "select", label: "Are you authorized to work?", required: true, options: ["Yes", "No"] },
  { marker: "6", type: "text", label: "Desired salary", required: true },
  { marker: "7", type: "text", label: "Favourite dinosaur", required: false }
];

describe("application planning", () => {
  it("fills everything the profile covers and reports the rest", () => {
    const plan = planApplication(form, profile);
    expect(plan.summary.filled).toBe(6);
    expect(plan.summary.skipped).toBe(2);
    expect(plan.actions.map((step) => step.action)).toEqual([
      "fill", "fill", "fill", "fill", "upload", "select"
    ]);
  });

  it("blocks submission on a required field it cannot answer", () => {
    const plan = planApplication(form, profile);
    expect(plan.canSubmit).toBe(false);
    expect(plan.blockers).toHaveLength(1);
    expect(plan.blockers[0].field.label).toBe("Desired salary");
  });

  it("allows submission when only optional fields are unanswered", () => {
    const plan = planApplication(form.filter((field) => field.label !== "Desired salary"), profile);
    expect(plan.canSubmit).toBe(true);
    expect(plan.summary.requiredUnanswered).toBe(0);
    // The unrecognized optional question is still reported, just not blocking.
    expect(plan.skipped.map((step) => step.field.label)).toEqual(["Favourite dinosaur"]);
  });

  it("handles an empty form without throwing", () => {
    const plan = planApplication([], profile);
    expect(plan.summary).toEqual({ total: 0, filled: 0, skipped: 0, requiredUnanswered: 0 });
    expect(plan.canSubmit).toBe(true);
  });

  it("prints a plan that names every field and its outcome", () => {
    const text = formatPlan(planApplication(form, profile));
    expect(text).toContain("[fill]   First Name * <- Jordan");
    expect(text).toContain("[upload] Resume/CV * <- /home/jordan/resume.pdf");
    expect(text).toContain("[select] Are you authorized to work? * <- Yes");
    expect(text).toContain("[skip]   Desired salary *");
    // The page's own "*" marker is not doubled up with ours.
    expect(text).not.toContain("* *");
    expect(text).toContain("1 required field(s) unanswered");
  });

  it("truncates long values in the printed plan", () => {
    const plan = planApplication(
      [{ marker: "0", type: "textarea", label: "Cover letter" }],
      profile,
      { coverLetterText: "x".repeat(200) }
    );
    const line = formatPlan(plan).split("\n")[0];
    expect(line).toContain("...");
    expect(line.length).toBeLessThan(100);
  });
});
