// Nicole's Dog Co. service worker
// Bump VERSION on every deploy so phones pick up the new app (the app shows "A new version is ready").
const VERSION = "dogco-2026-11-07-1";
const SHELL = "shell-" + VERSION;
const RUNTIME = "runtime-" + VERSION;
const SHELL_FILES = ["./", "./index.html", "./offline.html", "./manifest.webmanifest", "./firebase-config.js",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/maskable-512.png", "./icons/apple-touch-icon.png", "./icons/favicon-32.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== SHELL && k !== RUNTIME).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("message", e => { if (e.data === "SKIP_WAITING") self.skipWaiting(); });

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Never intercept database, storage or auth traffic: Firebase handles its own offline queue.
  if (/firestore\.googleapis\.com|firebasestorage\.googleapis\.com|identitytoolkit|securetoken|googleapis\.com\/(v1|upload)/.test(url.href)) return;

  // Pages: network first so updates arrive, fall back to the cached app, then the offline page.
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).then(res => { const copy = res.clone(); caches.open(SHELL).then(c => c.put("./index.html", copy)); return res; })
      .catch(() => caches.match("./index.html").then(r => r || caches.match("./offline.html"))));
    return;
  }
  // Fonts and the Firebase SDK: cache first (they never change at a given URL).
  if (/fonts\.(googleapis|gstatic)\.com|www\.gstatic\.com\/firebasejs/.test(url.href)) {
    e.respondWith(caches.open(RUNTIME).then(c => c.match(req).then(hit => hit || fetch(req).then(res => { if (res.ok || res.type === "opaque") c.put(req, res.clone()); return res; }))));
    return;
  }
  // Own files: serve from cache, refresh in the background.
  if (url.origin === self.location.origin) {
    e.respondWith(caches.open(RUNTIME).then(c => c.match(req).then(hit => {
      const net = fetch(req).then(res => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => hit || caches.match(req));
      return hit || net;
    })));
  }
});
