import { describe, it, expect } from "vitest";
import {
  VERSION, SHELL_CACHE, IMAGE_CACHE, SHELL_ASSETS, API_HOSTS, IMAGE_HOSTS,
  hostOf, classifyRequest, isNavigation, staleCaches, overflowKeys,
  isStandalone, installState, isIosSafari
} from "../js/ms-pwa.js";

describe("cache names", () => {
  it("are versioned and distinct", () => {
    expect(SHELL_CACHE).toContain(VERSION);
    expect(IMAGE_CACHE).toContain(VERSION);
    expect(SHELL_CACHE).not.toBe(IMAGE_CACHE);
  });
});

describe("shell asset list", () => {
  it("uses relative paths so the app works from a project subpath", () => {
    // GitHub Pages serves this repo at /all-sports-predictor/, not the domain
    // root, so nothing may be anchored with a leading slash.
    SHELL_ASSETS.forEach(a => expect(a.startsWith("./")).toBe(true));
  });

  it("covers every script the dashboard loads", () => {
    ["ms-app.js", "ms-leagues.js", "ms-espn.js", "ms-ratings.js", "ms-features.js",
     "ms-backtest.js", "ms-model.js", "ms-live.js", "ms-news.js", "ms-logos.js",
     "ms-pwa.js", "ml-train.js", "calibration.js"].forEach(f => {
      expect(SHELL_ASSETS.some(a => a.endsWith("/" + f))).toBe(true);
    });
  });

  it("includes the page, the manifest and the icons", () => {
    expect(SHELL_ASSETS).toContain("./index.html");
    expect(SHELL_ASSETS).toContain("./manifest.webmanifest");
    expect(SHELL_ASSETS.some(a => a.includes("icon-192"))).toBe(true);
  });

  it("carries no leftovers from the repo this was split out of", () => {
    expect(SHELL_ASSETS).not.toContain("./sports.html");
    expect(SHELL_ASSETS.some(a => a.includes("betting.js"))).toBe(false);
  });

  it("has no duplicates", () => {
    expect(new Set(SHELL_ASSETS).size).toBe(SHELL_ASSETS.length);
  });
});

describe("classifyRequest", () => {
  const self = "https://krisfigueiredo-ui.github.io";

  it("never caches live data", () => {
    // This is the load-bearing rule: a cached scoreboard would present a
    // finished game as if it were still in progress.
    API_HOSTS.forEach(h => {
      expect(classifyRequest("https://" + h + "/apis/site/v2/sports/baseball/mlb/scoreboard")).toBe("api");
    });
    expect(classifyRequest("https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/news")).toBe("api");
    expect(classifyRequest("https://site.api.espn.com/apis/site/v2/sports")).toBe("api");
  });

  it("caches artwork, which is effectively immutable", () => {
    IMAGE_HOSTS.forEach(h => {
      expect(classifyRequest("https://" + h + "/i/teamlogos/mlb/500/nyy.png")).toBe("image");
    });
  });

  it("treats our own static assets as shell", () => {
    expect(classifyRequest(self + "/all-sports-predictor/index.html", { selfOrigin: self })).toBe("shell");
    expect(classifyRequest(self + "/all-sports-predictor/js/ms-app.js", { selfOrigin: self })).toBe("shell");
    expect(classifyRequest(self + "/all-sports-predictor/manifest.webmanifest", { selfOrigin: self })).toBe("shell");
    expect(classifyRequest(self + "/all-sports-predictor/", { selfOrigin: self })).toBe("shell");
    expect(classifyRequest(self + "/all-sports-predictor/icons/icon-192.png", { selfOrigin: self })).toBe("shell");
  });

  it("ignores query strings when deciding", () => {
    expect(classifyRequest(self + "/all-sports-predictor/index.html?tab=live", { selfOrigin: self })).toBe("shell");
  });

  it("leaves unrecognised cross-origin requests alone", () => {
    expect(classifyRequest("https://example.com/thing.js", { selfOrigin: self })).toBe("other");
  });

  it("survives a malformed URL", () => {
    expect(() => classifyRequest("::::")).not.toThrow();
    expect(hostOf("::::")).toBe("");
  });
});

describe("isNavigation", () => {
  it("detects a navigation request", () => {
    expect(isNavigation({ mode: "navigate", method: "GET" })).toBe(true);
  });
  it("falls back to the Accept header when mode is absent", () => {
    expect(isNavigation({
      method: "GET",
      headers: { get: () => "text/html,application/xhtml+xml" }
    })).toBe(true);
  });
  it("is false for asset fetches and non-GET", () => {
    expect(isNavigation({ method: "GET", headers: { get: () => "image/png" } })).toBe(false);
    expect(isNavigation({ method: "POST", mode: "cors" })).toBe(false);
    expect(isNavigation(null)).toBe(false);
    expect(isNavigation({ method: "GET" })).toBe(false);
  });
});

describe("staleCaches", () => {
  it("deletes only our own caches from older versions", () => {
    const existing = ["ms-shell-v1", "ms-img-v1", "ms-shell-v2", "ms-img-v2", "some-other-app-cache"];
    const stale = staleCaches(existing, ["ms-shell-v2", "ms-img-v2"]);
    expect(stale).toEqual(["ms-shell-v1", "ms-img-v1"]);
  });
  it("never touches a cache belonging to something else", () => {
    expect(staleCaches(["workbox-precache", "next-data"], [])).toEqual([]);
  });
  it("returns nothing when everything is current", () => {
    expect(staleCaches(["ms-shell-v1"], ["ms-shell-v1"])).toEqual([]);
    expect(staleCaches([], ["ms-shell-v1"])).toEqual([]);
  });
});

describe("overflowKeys", () => {
  it("evicts the oldest entries past the limit", () => {
    const keys = Array.from({ length: 10 }, (_, i) => "k" + i);
    expect(overflowKeys(keys, 8)).toEqual(["k0", "k1"]);
  });
  it("evicts nothing while under the limit", () => {
    expect(overflowKeys(["a", "b"], 8)).toEqual([]);
    expect(overflowKeys([], 8)).toEqual([]);
    expect(overflowKeys(null, 8)).toEqual([]);
  });
  it("handles being exactly at the limit", () => {
    expect(overflowKeys(["a", "b"], 2)).toEqual([]);
  });
});

describe("isStandalone", () => {
  const mm = matches => q => ({ matches: matches.includes(q) });

  it("detects an installed Android/desktop app", () => {
    expect(isStandalone({}, mm(["(display-mode: standalone)"]))).toBe(true);
    expect(isStandalone({}, mm(["(display-mode: window-controls-overlay)"]))).toBe(true);
  });
  it("detects an installed iOS app via the legacy flag", () => {
    expect(isStandalone({ standalone: true }, mm([]))).toBe(true);
  });
  it("is false in a normal browser tab", () => {
    expect(isStandalone({}, mm([]))).toBe(false);
    expect(isStandalone({ standalone: false }, mm([]))).toBe(false);
  });
  it("survives a browser with no matchMedia", () => {
    expect(isStandalone({}, undefined)).toBe(false);
    expect(isStandalone({}, () => { throw new Error("unsupported"); })).toBe(false);
  });
});

describe("isIosSafari", () => {
  it("recognises iOS Safari, which can install but never fires the prompt event", () => {
    expect(isIosSafari("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")).toBe(true);
    expect(isIosSafari("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Safari/604.1")).toBe(true);
  });
  it("excludes other iOS browsers, which cannot install either", () => {
    expect(isIosSafari("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) CriOS/120.0 Mobile/15E148 Safari/604.1")).toBe(false);
    expect(isIosSafari("Mozilla/5.0 (iPhone) FxiOS/120.0 Mobile Safari")).toBe(false);
  });
  it("excludes desktop and Android", () => {
    expect(isIosSafari("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15")).toBe(false);
    expect(isIosSafari("Mozilla/5.0 (Linux; Android 14) Chrome/120.0 Mobile Safari/537.36")).toBe(false);
    expect(isIosSafari("")).toBe(false);
    expect(isIosSafari(null)).toBe(false);
  });
});

describe("installState", () => {
  it("hides the button once the app is installed", () => {
    expect(installState({ standalone: true, deferredPrompt: true })).toBe("hidden");
  });
  it("offers a one-tap install when the browser gave us a prompt", () => {
    expect(installState({ standalone: false, deferredPrompt: true })).toBe("available");
  });
  it("falls back to manual instructions on iOS Safari", () => {
    expect(installState({ standalone: false, deferredPrompt: false, iosSafari: true })).toBe("ios");
  });
  it("stays hidden where installation isn't offered at all", () => {
    expect(installState({ standalone: false, deferredPrompt: false, iosSafari: false })).toBe("hidden");
    expect(installState({})).toBe("hidden");
  });
  it("prefers the real prompt over the iOS hint if somehow both apply", () => {
    expect(installState({ deferredPrompt: true, iosSafari: true })).toBe("available");
  });
});

describe("relative URLs", () => {
  it("treats a relative same-origin asset as shell, not cross-origin", () => {
    // In a service worker request.url is always absolute, but the classifier
    // must not mistake a relative path for a foreign host.
    expect(hostOf("./js/ms-app.js")).toBe("");
    expect(classifyRequest("./js/ms-app.js", { selfOrigin: "https://example.github.io" })).toBe("shell");
    expect(classifyRequest("/all-sports-predictor/index.html", { selfOrigin: "https://example.github.io" })).toBe("shell");
  });
});
