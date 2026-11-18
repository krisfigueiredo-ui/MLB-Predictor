import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PlayerPortrait, RosterBadge, TeamCrest, readableOn } from "@/components/identity/identity";
import type { Player, Team } from "@/lib/types";

const celtics: Team = {
  id: 2, league: "NBA", slug: "nba-bos", abbr: "BOS", location: "Boston", nickname: "Celtics", name: "Boston Celtics",
  primary: "#007A33", secondary: "#BA9653", conference: "East", logo: null,
};

describe("identity system", () => {
  it("renders an original crest with the team's abbreviation when no licensed logo exists", () => {
    render(<TeamCrest team={celtics} />);
    expect(screen.getByRole("img", { name: "Boston Celtics crest" })).toBeInTheDocument();
    expect(screen.getByText("BOS")).toBeInTheDocument();
  });

  it("uses the registered licensed logo for that exact team", () => {
    render(<TeamCrest team={{ ...celtics, logo: { url: "https://cdn.example/bos.svg", license: "x", source: "y", verified: true } }} />);
    const img = screen.getByAltText("Boston Celtics logo") as HTMLImageElement;
    expect(img.src).toBe("https://cdn.example/bos.svg");
  });

  it("picks readable text colours", () => {
    expect(readableOn("#FFFFFF")).toBe("#0A1222");
    expect(readableOn("#00471B")).toBe("#FFFFFF");
  });

  it("draws the player's verified jersey number in team colours", () => {
    const p: Player = { id: 1, league: "NBA", name: "Jaylen Brown", first: "Jaylen", last: "Brown", position: "G-F", jersey: "7", team: celtics,
      roster: { verified: false, source: "static_seed_2025_26", season: "2025-26", verified_at: null }, portrait: null };
    const { container } = render(<PlayerPortrait player={p} />);
    expect(screen.getByRole("img", { name: "Jaylen Brown illustrated avatar" })).toBeInTheDocument();
    expect(container.querySelector("text:last-of-type")?.textContent).toBe("7");
    render(<RosterBadge player={p} />);
    expect(screen.getByText(/seed roster/i)).toBeInTheDocument();
  });
});
