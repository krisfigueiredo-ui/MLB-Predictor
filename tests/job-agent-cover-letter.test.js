import { describe, it, expect } from "vitest";
import { buildCoverLetter, keywords, rankHighlights, renderTemplate } from "../job-agent/src/cover-letter.js";

const highlights = [
  { text: "Rebuilt the ingestion pipeline in Go, cutting p99 latency to 240ms.", keywords: ["go", "latency"] },
  { text: "Migrated 60 services to Kubernetes with no downtime.", keywords: ["kubernetes", "platform"] },
  { text: "Mentored four engineers to promotion.", keywords: ["mentorship"] }
];

const profile = {
  personal: { firstName: "Jordan", lastName: "Rivera", email: "jordan@example.com" },
  work: { currentTitle: "Senior Backend Engineer", currentCompany: "Northwind", yearsExperience: 7 },
  highlights,
  coverLetter: { opening: "I build backend systems.", closing: "Happy to talk.", signoff: "Best," }
};

describe("keyword extraction", () => {
  it("drops stop words and short tokens", () => {
    expect(keywords("We are looking for a Go engineer with Kubernetes experience"))
      .toEqual(["looking", "engineer", "kubernetes", "experience"]);
  });
});

describe("highlight ranking", () => {
  it("puts the highlights that match the posting first", () => {
    const ranked = rankHighlights(highlights, "We need a Kubernetes platform engineer", 2);
    expect(ranked[0]).toContain("Kubernetes");
  });

  it("keeps profile order when there is no job description", () => {
    expect(rankHighlights(highlights, "", 3)).toEqual(highlights.map((h) => h.text));
  });

  it("respects the limit and accepts plain strings", () => {
    expect(rankHighlights(["one", "two", "three"], "", 2)).toEqual(["one", "two"]);
  });

  it("returns nothing when there are no highlights", () => {
    expect(rankHighlights([], "Go engineer")).toEqual([]);
  });
});

describe("template rendering", () => {
  it("substitutes placeholders", () => {
    const result = renderTemplate("Hello {{company}}, re: {{role}}", { company: "Acme", role: "SRE" });
    expect(result.text).toBe("Hello Acme, re: SRE");
    expect(result.missing).toEqual([]);
  });

  it("reports placeholders it could not fill instead of leaving braces in the letter", () => {
    const result = renderTemplate("Hello {{company}}, re: {{role}}", { company: "Acme" });
    expect(result.text).toBe("Hello Acme, re:");
    expect(result.missing).toEqual(["role"]);
  });
});

describe("cover letter assembly", () => {
  it("builds a letter naming the company, role and candidate", () => {
    const letter = buildCoverLetter(profile, { company: "Acme", role: "Backend Engineer" });
    expect(letter.text).toContain("Dear Acme hiring team,");
    expect(letter.text).toContain("Backend Engineer");
    expect(letter.text).toContain("Jordan Rivera");
    expect(letter.text).toContain("I build backend systems.");
    expect(letter.text).toContain("Best,");
  });

  it("leads with the highlights that match the posting", () => {
    const letter = buildCoverLetter(profile, {
      company: "Acme",
      role: "Platform Engineer",
      description: "Kubernetes platform work"
    });
    expect(letter.highlights[0]).toContain("Kubernetes");
    expect(letter.text).toContain("- Migrated 60 services to Kubernetes");
  });

  it("honours a custom template", () => {
    const letter = buildCoverLetter(
      { ...profile, coverLetter: { ...profile.coverLetter, template: "{{role}} at {{company}} — {{currentTitle}}" } },
      { company: "Acme", role: "SRE" }
    );
    expect(letter.text).toBe("SRE at Acme — Senior Backend Engineer");
  });

  it("stays coherent when company and role are unknown", () => {
    const letter = buildCoverLetter(profile, {});
    expect(letter.text).toContain("Dear your hiring team,");
    expect(letter.text).not.toContain("{{");
  });

  it("caps the number of highlights", () => {
    const letter = buildCoverLetter(profile, { company: "Acme" }, { maxHighlights: 1 });
    expect(letter.highlights).toHaveLength(1);
  });
});
