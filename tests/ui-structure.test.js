import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ballparkSvgFallback } from "../js/three/ballpark.js";
import { stadiumForTeam } from "../js/three/stadium-configs.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const html = readFileSync(join(root, "index.html"), "utf8");
const css = readFileSync(join(root, "css/quant-lab.css"), "utf8");
const workflow = readFileSync(join(root, ".github/workflows/pages.yml"), "utf8");

describe("Quant Lab application shell", () => {
  it("exposes the complete primary information architecture", () => {
    ["slate", "game", "ballpark", "model", "performance", "market", "data"].forEach(view => {
      expect(html).toContain(`data-view="${view}"`);
    });
  });

  it("loads analytics first and the 3D engine as a separate module", () => {
    expect(html.indexOf('js/predict-core.js')).toBeLessThan(html.indexOf('js/three/ballpark.js'));
    expect(html).toContain('js/ui/quant-lab.js');
    expect(html).toContain('css/quant-lab.css');
  });

  it("defines all requested responsive QA breakpoints and reduced motion", () => {
    ["1220px", "1024px", "760px", "420px"].forEach(width => expect(css).toContain(`max-width:${width}`));
    expect(css).toContain("prefers-reduced-motion:reduce");
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
