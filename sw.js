// GAME FINDER service worker.
// Opens INSTANTLY from the saved copy (cache-first app shell), while the page checks for a new
// version every few minutes / on foreground / on launch. A new version installs in the background
// and only swaps in when the page says it's safe (not mid-popup / typing) - see app.js.
// SHELL is stamped per publish by build_public.py so each deploy is its own cache.
var SHELL = "gf-20261014170239";   // build_public.py replaces this with gf-<timestamp>
var SHELL_FILES = ["./index.html", "./app.css", "./app.js", "./rank.js", "./live.js"];
var STATIC = ["./manifest.json", "./icon.svg", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", function (e) {
  // Pre-cache the shell, but DO NOT skipWaiting automatically - the page triggers the swap safely.
  e.waitUntil(caches.open(SHELL).then(function (c) { return c.addAll(SHELL_FILES.concat(STATIC)).catch(function () {}); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.map(function (k) { if (k !== SHELL) return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

// The page asks us to take over once it's safe to swap.
self.addEventListener("message", function (e) { if (e.data && e.data.type === "skipWaiting") self.skipWaiting(); });

function cacheFirst(req) {
  return caches.match(req).then(function (m) {
    if (m) return m;
    return fetch(req).then(function (r) { if (r && r.ok) { var cp = r.clone(); caches.open(SHELL).then(function (c) { c.put(req, cp); }); } return r; });
  });
}
function networkFirst(req) {
  return fetch(req).then(function (r) {
    if (r && r.ok) { var cp = r.clone(); caches.open(SHELL).then(function (c) { c.put(req, cp); }); }
    return r;
  }).catch(function () { return caches.match(req); });
}

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  // Schedule data is network-first (its own refresh cycle); everything else opens from cache.
  e.respondWith(req.url.indexOf("/data/") >= 0 ? networkFirst(req) : cacheFirst(req));
});
