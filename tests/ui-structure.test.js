import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ballparkSvgFallback } from "../js/three/ballpark.js";
import { stadiumForTeam } from "../js/three/stadium-configs.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const html = readFileSync(join(root, "index.html"), "utf8");
const css = ["tokens.css", "shell.css", "slate.css", "game.css", "research.css", "intelligence.css", "ballpark.css", "responsive.css", "motion.css"]
  .map(file => readFileSync(join(root, "css", file), "utf8"))
  .join("\n");
const workflow = readFileSync(join(root, ".github/workflows/pages.yml"), "utf8");

describe("Diamond Signal application shell", () => {
  it("exposes the complete primary information architecture", () => {
    ["slate", "live", "picks", "standings", "players", "teams", "model", "performance", "data"].forEach(view => {
      expect(html).toContain(`data-view="${view}"`);
    });
    ["game", "ballpark", "betting"].forEach(panel => expect(html).toContain(`id="pnl-${panel}"`));
  });

  it("ships the Diamond Signal shell without the deprecated hidden interface", () => {
    expect(html).toContain("DIAMOND SIGNAL");
    expect(html).toContain('id="ds-settings"');
    expect(html).not.toContain("legacy-slate");
    expect(html).not.toContain("bankroll-in-top");
  });

  it("loads analytics first and the 3D engine as a separate module", () => {
    expect(html.indexOf('js/predict-core.js')).toBeLessThan(html.indexOf('js/three/ballpark.js'));
    expect(html).toContain('js/data/baseball-intel.js');
    expect(html).toContain('js/data/mlb-intel-client.js');
    expect(html).toContain('js/ui/quant-lab.js');
    expect(html).toContain('css/quant-lab.css');
  });

  it("mounts the baseball-intelligence workspaces and interaction modes", () => {
    ["ql-live-root", "ql-picks-root", "ql-standings-root", "ql-players-root", "ql-teams-root", "ql-player-drawer"].forEach(id => {
      expect(html).toContain(`id="${id}"`);
    });
    ["Overview", "Lineups", "Matchup", "Play-by-play", "Moments", "Today", "Upcoming", "Results", "Division", "Wild Card"].forEach(label => {
      expect(readFileSync(join(root, "js", "ui", "quant-lab.js"), "utf8")).toContain(label);
    });
  });

  it("defines all requested responsive QA breakpoints and reduced motion", () => {
    ["1260px", "1024px", "767px", "430px"].forEach(width => expect(css).toContain(`max-width: ${width}`));
    expect(css).toContain("prefers-reduced-motion: reduce");
  });

  it("keeps the full module tree in the GitHub Pages artifact", () => {
    expect(workflow).toContain("cp -R css _site/");
    expect(workflow).toContain("cp -R js _site/");
  });
});

describe("Ballpark Live fallback", () => {
  it("preserves game and geometry context without WebGL", () => {
    const config = stadiumForTeam("BOS");
    const fallback = ballparkSvgFallback(config, { away: "NYY", home: "BOS" });
    expect(fallback).toContain("Fenway Park");
    expect(fallback).toContain("NYY at BOS");
    expect(fallback).toContain("2D fallback");
    expect(fallback).toContain("CF 390′");
  });
});
