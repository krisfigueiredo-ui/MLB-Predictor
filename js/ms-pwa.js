// Installable-app support: the caching policy, shared between the service
// worker (which pulls it in with importScripts) and the unit tests.
//
// The policy matters more than usual here. This app shows live sports data, so
// serving a cached scoreboard would present a finished game as if it were still
// in progress -- exactly the kind of dishonesty the rest of the app is built to
// avoid. So the rule is deliberately asymmetric:
//
//   app shell  -> cache-first   (it is versioned; a stale shell is harmless)
//   ESPN API   -> network-only  (never cached; offline must FAIL, visibly)
//   ESPN CDN   -> cache-first   (crests and headshots are effectively immutable)
//
// Offline, the shell loads and every data request fails, which lands the UI in
// the "the feed did not return" state it already handles. That is the correct
// offline experience for this app: the frame, honestly empty.
(function(root, factory) {
  var mod = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = mod;
  }
  root.MS = root.MS || {};
  root.MS.pwa = mod;
})(typeof globalThis !== "undefined" ? globalThis : this, function() {

// Bump this on any change to a shell asset. The activate handler deletes every
// cache that doesn't belong to the current version.
var VERSION = "1";

var SHELL_CACHE = "ms-shell-v" + VERSION;
var IMAGE_CACHE = "ms-img-v" + VERSION;
var IMAGE_CACHE_LIMIT = 400;

// Everything needed to boot the dashboard with no network at all. Paths are
// relative so the app works whether it is served from a domain root or from
// a project subpath (GitHub Pages serves this repo at /all-sports-predictor/).
var SHELL_ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./js/ml-train.js",
  "./js/calibration.js",
  "./js/ms-leagues.js",
  "./js/ms-espn.js",
  "./js/ms-logos.js",
  "./js/ms-ratings.js",
  "./js/ms-features.js",
  "./js/ms-backtest.js",
  "./js/ms-model.js",
  "./js/ms-live.js",
  "./js/ms-news.js",
  "./js/ms-pwa.js",
  "./js/ms-app.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png"
];

// Hosts whose responses must never be served from cache.
var API_HOSTS = [
  "site.api.espn.com",
  "sports.core.api.espn.com",
  "site.web.api.espn.com",
  "statsapi.mlb.com"
];

// Hosts serving immutable-ish artwork worth keeping.
var IMAGE_HOSTS = ["a.espncdn.com", "a1.espncdn.com", "a2.espncdn.com", "a3.espncdn.com"];

// Hostname of an absolute URL, or "" for a relative or malformed one. No
// placeholder base: resolving a relative path against a fake origin would hand
// back that fake host, and the caller would then treat a same-origin asset as
// cross-origin.
function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch (e) {
    return "";
  }
}

// Decide how a request should be handled.
//   "api"    -> network only, never cached
//   "image"  -> cache first, runtime cache
//   "shell"  -> cache first, precached
//   "other"  -> network, fall back to cache if present
function classifyRequest(url, opts) {
  opts = opts || {};
  var host = hostOf(url);
  if (API_HOSTS.indexOf(host) >= 0) return "api";
  if (IMAGE_HOSTS.indexOf(host) >= 0) return "image";
  // Anything cross-origin we didn't name is left alone.
  if (opts.selfOrigin && host && host !== hostOf(opts.selfOrigin)) return "other";
  var path = String(url).split("?")[0];
  if (/\.(html|js|css|webmanifest|png|svg|ico)$/.test(path) || /\/$/.test(path)) return "shell";
  return "other";
}

// A navigation request (the user opening or reloading the page) needs a shell
// response even when offline, so it is handled separately from asset fetches.
function isNavigation(request) {
  if (!request) return false;
  if (request.mode === "navigate") return true;
  return request.method === "GET" &&
         typeof request.headers === "object" && request.headers &&
         typeof request.headers.get === "function" &&
         String(request.headers.get("accept") || "").indexOf("text/html") >= 0;
}

// Caches that belong to an older version and should be deleted on activate.
function staleCaches(existing, keep) {
  var keepSet = {};
  (keep || []).forEach(function(k) { keepSet[k] = 1; });
  return (existing || []).filter(function(name) {
    // Only ever delete caches this app owns.
    return /^ms-(shell|img)-v/.test(name) && !keepSet[name];
  });
}

// Keep the runtime image cache from growing without bound: drop the oldest
// entries once it passes the limit. Returns the keys to delete.
function overflowKeys(keys, limit) {
  var max = limit == null ? IMAGE_CACHE_LIMIT : limit;
  if (!keys || keys.length <= max) return [];
  return keys.slice(0, keys.length - max);
}

// Is the app running as an installed app rather than in a browser tab?
function isStandalone(nav, matchMediaFn) {
  if (nav && nav.standalone === true) return true;              // iOS Safari
  if (typeof matchMediaFn === "function") {
    try {
      if (matchMediaFn("(display-mode: standalone)").matches) return true;
      if (matchMediaFn("(display-mode: window-controls-overlay)").matches) return true;
    } catch (e) { /* matchMedia unsupported */ }
  }
  return false;
}

// What the install button should show, given what the platform told us.
//   "hidden"    -> already installed, or the browser gave us no prompt
//   "available" -> a deferred beforeinstallprompt is in hand
//   "ios"       -> iOS Safari never fires the event; show manual instructions
function installState(opts) {
  opts = opts || {};
  if (opts.standalone) return "hidden";
  if (opts.deferredPrompt) return "available";
  if (opts.iosSafari) return "ios";
  return "hidden";
}

// iOS Safari is the one platform that supports installing but never fires
// beforeinstallprompt, so it needs to be sniffed to show the Share-sheet hint.
function isIosSafari(userAgent) {
  var ua = String(userAgent || "");
  var isIos = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && /Mobile/.test(ua));
  if (!isIos) return false;
  // Chrome/Firefox on iOS can't install either, and identify themselves.
  return !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
}

return {
  VERSION: VERSION,
  SHELL_CACHE: SHELL_CACHE,
  IMAGE_CACHE: IMAGE_CACHE,
  IMAGE_CACHE_LIMIT: IMAGE_CACHE_LIMIT,
  SHELL_ASSETS: SHELL_ASSETS,
  API_HOSTS: API_HOSTS,
  IMAGE_HOSTS: IMAGE_HOSTS,
  hostOf: hostOf,
  classifyRequest: classifyRequest,
  isNavigation: isNavigation,
  staleCaches: staleCaches,
  overflowKeys: overflowKeys,
  isStandalone: isStandalone,
  installState: installState,
  isIosSafari: isIosSafari
};

});
