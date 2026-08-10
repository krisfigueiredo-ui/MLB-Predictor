import { describe, it, expect } from "vitest";
import { matchField, matchFields, normalizeText } from "../job-agent/src/fields.js";

describe("field text normalization", () => {
  it("collapses separators and punctuation so label variants agree", () => {
    expect(normalizeText("First_Name")).toBe("first name");
    expect(normalizeText("  Phone Number*  ")).toBe("phone number");
    expect(normalizeText("E-mail Address:")).toBe("e mail address");
    expect(normalizeText(null)).toBe("");
  });
});

describe("field matching", () => {
  it("matches the common contact fields across labeling styles", () => {
    expect(matchField({ label: "First Name" }).key).toBe("firstName");
    expect(matchField({ name: "last_name" }).key).toBe("lastName");
    expect(matchField({ label: "E-mail Address" }).key).toBe("email");
    expect(matchField({ placeholder: "Mobile" }).key).toBe("phone");
    expect(matchField({ ariaLabel: "LinkedIn Profile" }).key).toBe("linkedin");
  });

  it("prefers the label over an opaque field name", () => {
    const match = matchField({ label: "Email", name: "field_9182734", id: "q_1" });
    expect(match.key).toBe("email");
    expect(match.source).toBe("label");
  });

  it("distinguishes confirm-email from the email field itself", () => {
    expect(matchField({ label: "Confirm Email" }).key).toBe("confirmEmail");
    expect(matchField({ label: "Email" }).key).toBe("email");
  });

  it("does not read 'Company website' as the current employer", () => {
    expect(matchField({ label: "Current Company" }).key).toBe("currentCompany");
    // Ambiguous between two rules that each veto the other, so it stays
    // unmatched and gets reported rather than filled with the wrong value.
    expect(matchField({ label: "Company website" })).toBeNull();
  });

  it("keeps 'How did you hear about us' out of the company field", () => {
    expect(matchField({ label: "How did you hear about this company?" }).key).toBe("howDidYouHear");
  });

  it("routes file inputs to a document key", () => {
    expect(matchField({ label: "Resume/CV", type: "file" }).key).toBe("resume");
    expect(matchField({ label: "Cover Letter", type: "file" }).key).toBe("coverLetter");
    expect(matchField({ label: "", name: "", type: "file" }).key).toBe("resume");
    // A file input labeled something unrelated is still a document upload.
    expect(matchField({ label: "Attach your portfolio", type: "file" }).key).toBe("resume");
  });

  it("separates work authorization from sponsorship, which have opposite answers", () => {
    expect(matchField({ label: "Are you legally authorized to work in the US?" }).key).toBe("workAuthorized");
    expect(matchField({ label: "Will you now or in the future require sponsorship?" }).key).toBe("requiresSponsorship");
  });

  it("matches the EEO block", () => {
    expect(matchField({ label: "Gender" }).key).toBe("gender");
    expect(matchField({ label: "Race / Ethnicity" }).key).toBe("race");
    expect(matchField({ label: "Veteran Status" }).key).toBe("veteranStatus");
    expect(matchField({ label: "Disability Status" }).key).toBe("disabilityStatus");
  });

  it("returns null when nothing plausibly fits", () => {
    expect(matchField({ label: "Favourite dinosaur" })).toBeNull();
    expect(matchField({})).toBeNull();
  });

  it("annotates a list of descriptors in place", () => {
    const annotated = matchFields([{ label: "First Name" }, { label: "Nonsense" }]);
    expect(annotated[0].key).toBe("firstName");
    expect(annotated[1].key).toBeNull();
    expect(annotated[0].matchScore).toBeGreaterThan(annotated[1].matchScore);
  });
});
