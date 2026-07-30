// Service worker for the All-Sports Predictor.
//
// The routing policy lives in js/ms-pwa.js so it can be unit tested in Node;
// this file is just the plumbing that applies it. See that file for why live
// data is deliberately never cached.
/* eslint-env serviceworker */
importScripts("./js/ms-pwa.js");

var P = self.MS.pwa;

// ---- install: precache the shell -------------------------------------------
self.addEventListener("install", function(event) {
  event.waitUntil(
    caches.open(P.SHELL_CACHE).then(function(cache) {
      // addAll is atomic: one 404 would throw away the whole precache and
      // leave the app with no offline shell at all. Add individually and
      // tolerate misses so a single renamed asset can't break installation.
      return Promise.all(P.SHELL_ASSETS.map(function(url) {
        return cache.add(new Request(url, { cache: "reload" })).catch(function() {
          return null;
        });
      }));
    }).then(function() {
      // Take over as soon as the new worker is ready rather than waiting for
      // every tab to close; the shell is versioned so this is safe.
      return self.skipWaiting();
    })
  );
});

// ---- activate: drop caches from older versions ------------------------------
self.addEventListener("activate", function(event) {
  event.waitUntil(
    caches.keys().then(function(names) {
      return Promise.all(
        P.staleCaches(names, [P.SHELL_CACHE, P.IMAGE_CACHE]).map(function(name) {
          return caches.delete(name);
        })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

// ---- fetch ------------------------------------------------------------------
self.addEventListener("fetch", function(event) {
  var req = event.request;
  if (req.method !== "GET") return;

  var kind = P.classifyRequest(req.url, { selfOrigin: self.location.origin });

  // Live data: straight to the network, always. If it fails the app shows its
  // own "feed unavailable" state, which is the honest offline answer.
  if (kind === "api") return;

  // Page loads: try the network so a redeploy is picked up promptly, but fall
  // back to the cached shell so the app opens offline.
  if (P.isNavigation(req)) {
    event.respondWith(
      fetch(req).then(function(res) {
        var copy = res.clone();
        caches.open(P.SHELL_CACHE).then(function(c) { c.put(req, copy); });
        return res;
      }).catch(function() {
        return caches.match(req).then(function(hit) {
          return hit || caches.match("./index.html");
        });
      })
    );
    return;
  }

  if (kind === "image") {
    event.respondWith(cacheFirst(req, P.IMAGE_CACHE, true));
    return;
  }

  if (kind === "shell") {
    event.respondWith(cacheFirst(req, P.SHELL_CACHE, false));
    return;
  }

  // Anything else: network, with a cached copy as a backstop if one exists.
  event.respondWith(
    fetch(req).catch(function() { return caches.match(req); })
  );
});

// Serve from cache when present, otherwise fetch and store. `trim` keeps the
// runtime image cache bounded.
//
// This must never reject: a rejected respondWith surfaces as an opaque network
// error the page can't reason about. On failure it resolves to a plain 503 so
// an <img> fires onerror normally and the logo fallback chain takes over.
function cacheFirst(req, cacheName, trim) {
  return caches.match(req).then(function(hit) {
    if (hit) return hit;
    return fetch(req).then(function(res) {
      // Opaque cross-origin responses still cache usefully for <img>.
      if (res && (res.ok || res.type === "opaque")) {
        var copy = res.clone();
        caches.open(cacheName).then(function(cache) {
          return cache.put(req, copy).then(function() {
            if (trim) return trimCache(cache);
          });
        }).catch(function() { /* quota or storage error: serve it anyway */ });
      }
      return res;
    }).catch(function() {
      // One more look in case a parallel request populated the cache.
      return caches.match(req).then(function(late) {
        return late || new Response("", { status: 503, statusText: "Offline" });
      });
    });
  });
}

function trimCache(cache) {
  return cache.keys().then(function(keys) {
    return Promise.all(P.overflowKeys(keys, P.IMAGE_CACHE_LIMIT).map(function(k) {
      return cache.delete(k);
    }));
  });
}

// Let the page tell a waiting worker to activate immediately.
self.addEventListener("message", function(event) {
  if (event.data === "skip-waiting") self.skipWaiting();
});
