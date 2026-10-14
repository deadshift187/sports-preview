// GAME FINDER service worker.
// SHELL is stamped per publish by build_public.py, so every deploy makes a new cache and the
// old one is deleted on activate. The app shell (html/css/js) is served NETWORK-FIRST so a
// returning visitor always gets the latest when online (falling back to cache offline); only
// icons/static assets are cache-first. Schedule data is network-first too.
var SHELL = "gf-20261014161608";   // build_public.py replaces this with gf-<timestamp>
var SHELL_FILES = ["./index.html", "./app.css", "./app.js", "./rank.js"];
var STATIC = ["./manifest.json", "./icon.svg", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(SHELL).then(function (c) {
    return c.addAll(SHELL_FILES.concat(STATIC)).catch(function () {});
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.map(function (k) { if (k !== SHELL) return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function networkFirst(req) {
  return fetch(req).then(function (r) {
    if (r && r.ok) { var cp = r.clone(); caches.open(SHELL).then(function (c) { c.put(req, cp); }); }
    return r;
  }).catch(function () { return caches.match(req).then(function (m) { return m || caches.match("./index.html"); }); });
}
function cacheFirst(req) {
  return caches.match(req).then(function (m) {
    return m || fetch(req).then(function (r) { if (r && r.ok) { var cp = r.clone(); caches.open(SHELL).then(function (c) { c.put(req, cp); }); } return r; });
  });
}

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = req.url;
  // app shell + data: always network-first (fresh when online); icons/static: cache-first.
  var netFirst = req.mode === "navigate" || /\.(?:html|js|css)(?:\?|$)/.test(url) || url.indexOf("/data/") >= 0;
  e.respondWith(netFirst ? networkFirst(req) : cacheFirst(req));
});
