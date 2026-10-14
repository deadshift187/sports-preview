// Offline shell: cache the app, always try network first for the schedule data.
var SHELL = "gf-shell-v14";
var FILES = ["./index.html", "./app.css", "./app.js", "./rank.js", "./manifest.json", "./icon.svg"];
self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(SHELL).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.map(function (k) { if (k !== SHELL) return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener("fetch", function (e) {
  var url = e.request.url;
  if (url.indexOf("/data/") >= 0) {
    // schedule data: network first, fall back to last cached copy
    e.respondWith(fetch(e.request).then(function (r) {
      var cp = r.clone(); caches.open(SHELL).then(function (c) { c.put(e.request, cp); }); return r;
    }).catch(function () { return caches.match(e.request); }));
    return;
  }
  e.respondWith(caches.match(e.request).then(function (r) { return r || fetch(e.request); }));
});
