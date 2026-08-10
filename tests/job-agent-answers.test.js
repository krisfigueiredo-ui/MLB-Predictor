import { describe, it, expect } from "vitest";
import { customAnswer, matchOption, planField, resolveAnswer } from "../job-agent/src/answers.js";

const profile = {
  personal: {
    firstName: "Jordan",
    lastName: "Rivera",
    preferredName: "Jo",
    email: "jordan@example.com",
    phone: "+1 555 0134",
    location: { city: "Austin", state: "Texas", country: "United States", postalCode: "78702" }
  },
  links: { linkedin: "https://linkedin.com/in/jordanrivera", portfolio: "https://jordanrivera.dev" },
  documents: { resume: "/home/jordan/resume.pdf" },
  work: { currentTitle: "Senior Backend Engineer", currentCompany: "Northwind", yearsExperience: 7 },
  eligibility: { workAuthorized: true, requiresSponsorship: false, willingToRelocate: false },
  demographics: { gender: "Prefer not to say", veteranStatus: "I don't wish to answer" },
  answers: {
    howDidYouHear: "Company website",
    custom: [
      { match: "on-call", answer: "Yes, four years of pager duty." },
      { match: "on-call rotation in europe", answer: "Yes, with timezone overlap until 6pm CET." }
    ]
  }
};

describe("answer resolution", () => {
  it("reads straight values out of the profile", () => {
    expect(resolveAnswer("email", profile).value).toBe("jordan@example.com");
    expect(resolveAnswer("currentTitle", profile).value).toBe("Senior Backend Engineer");
    expect(resolveAnswer("resume", profile).value).toBe("/home/jordan/resume.pdf");
  });

  it("derives composite values", () => {
    expect(resolveAnswer("fullName", profile).value).toBe("Jo Rivera");
    expect(resolveAnswer("location", profile).value).toBe("Austin, Texas, United States");
    expect(resolveAnswer("confirmEmail", profile).value).toBe("jordan@example.com");
  });

  it("stringifies numbers so form fills stay predictable", () => {
    expect(resolveAnswer("yearsExperience", profile).value).toBe("7");
  });

  it("preserves false rather than treating it as missing", () => {
    expect(resolveAnswer("requiresSponsorship", profile)).toEqual({ key: "requiresSponsorship", value: false });
  });

  it("returns null when the profile says nothing", () => {
    expect(resolveAnswer("salaryExpectation", profile)).toBeNull();
    expect(resolveAnswer("noSuchKey", profile)).toBeNull();
    expect(resolveAnswer(null, profile)).toBeNull();
  });

  it("prefers per-application context over the stored document", () => {
    expect(resolveAnswer("coverLetter", profile, { coverLetterPath: "/tmp/letter.txt" }).value).toBe("/tmp/letter.txt");
  });
});

describe("custom answers", () => {
  it("matches a question by substring", () => {
    expect(customAnswer(profile, "Are you comfortable with on-call?")).toBe("Yes, four years of pager duty.");
  });

  it("lets the more specific pattern win", () => {
    expect(customAnswer(profile, "Can you join an on-call rotation in Europe?"))
      .toBe("Yes, with timezone overlap until 6pm CET.");
  });

  it("returns undefined when nothing matches", () => {
    expect(customAnswer(profile, "What is your favourite colour?")).toBeUndefined();
  });
});

describe("option matching", () => {
  it("maps booleans onto yes/no choices", () => {
    expect(matchOption(true, ["Yes", "No"])).toBe("Yes");
    expect(matchOption(false, ["Yes", "No"])).toBe("No");
    expect(matchOption(true, ["Yes, I am authorized", "No, I am not"])).toBe("Yes, I am authorized");
  });

  it("matches text options exactly before falling back to containment", () => {
    expect(matchOption("Remote", ["On-site", "Hybrid", "Remote"])).toBe("Remote");
    expect(matchOption("Company website", ["Referral", "Company Website", "LinkedIn"])).toBe("Company Website");
  });

  it("maps any decline phrasing onto the form's own decline option", () => {
    expect(matchOption("Prefer not to say", ["Male", "Female", "I don't wish to answer"]))
      .toBe("I don't wish to answer");
    expect(matchOption("I don't wish to answer", ["Yes", "No", "Decline to self-identify"]))
      .toBe("Decline to self-identify");
  });

  it("refuses to guess when no option is a real match", () => {
    expect(matchOption("Remote", ["On-site", "Hybrid"])).toBeNull();
    expect(matchOption("Yes", [])).toBeNull();
    expect(matchOption(null, ["Yes", "No"])).toBeNull();
  });
});

describe("field planning", () => {
  it("plans a text fill", () => {
    const step = planField({ key: "email", type: "text", label: "Email" }, profile);
    expect(step).toMatchObject({ action: "fill", value: "jordan@example.com" });
  });

  it("plans a file upload", () => {
    const step = planField({ key: "resume", type: "file", label: "Resume" }, profile);
    expect(step).toMatchObject({ action: "upload", value: "/home/jordan/resume.pdf" });
  });

  it("plans a select using the form's own option text", () => {
    const step = planField(
      { key: "workAuthorized", type: "select", label: "Authorized to work?", options: ["Yes", "No"] },
      profile
    );
    expect(step).toMatchObject({ action: "select", value: "Yes" });
  });

  it("plans a radio choice", () => {
    const step = planField(
      { key: "requiresSponsorship", type: "radio", label: "Require sponsorship?", options: ["Yes", "No"] },
      profile
    );
    expect(step).toMatchObject({ action: "check", value: "No" });
  });

  it("skips with a reason when the profile has no value", () => {
    const step = planField({ key: "salaryExpectation", type: "text", label: "Desired salary" }, profile);
    expect(step.action).toBe("skip");
    expect(step.reason).toContain("salaryExpectation");
  });

  it("skips rather than picking a wrong option", () => {
    const step = planField(
      { key: "gender", type: "select", label: "Gender", options: ["Male", "Female"] },
      profile
    );
    expect(step.action).toBe("skip");
    expect(step.reason).toContain("no option matches");
  });

  it("falls back to a custom answer for an unrecognized question", () => {
    const step = planField({ key: null, type: "textarea", label: "Are you OK with on-call?" }, profile);
    expect(step).toMatchObject({ action: "fill", value: "Yes, four years of pager duty." });
  });

  it("types the cover letter into a textarea and uploads it to a file input", () => {
    const context = { coverLetterText: "Dear team,\n\nHello.", coverLetterPath: "/tmp/letter.txt" };
    expect(planField({ key: "coverLetter", type: "textarea", label: "Cover letter" }, profile, context))
      .toMatchObject({ action: "fill", value: "Dear team,\n\nHello." });
    expect(planField({ key: "coverLetter", type: "file", label: "Cover letter" }, profile, context))
      .toMatchObject({ action: "upload", value: "/tmp/letter.txt" });
  });

  it("checks a consent box", () => {
    const step = planField({ key: "consent", type: "checkbox", label: "I agree to the privacy policy" }, profile);
    expect(step).toMatchObject({ action: "check", value: true });
  });
});
