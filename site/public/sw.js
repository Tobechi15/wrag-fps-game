// Minimal service worker - exists ONLY to satisfy the browser's PWA
// "installability" requirement for Add to Home Screen (Chrome/Android in
// particular requires a registered service worker with a fetch handler,
// alongside the web manifest - see web.dev's installability criteria).
// Deliberately does NOT cache anything or serve content offline - this
// site needs a live connection anyway (auth, wallet balance, live match
// data), so a real offline cache would show stale/misleading state rather
// than actually helping. Every request just falls through to a normal
// network fetch, completely unmodified - registering a no-op fetch
// listener (no event.respondWith call) is enough for that.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', () => {});
