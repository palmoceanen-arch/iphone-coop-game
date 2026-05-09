// Minimal service worker. Its sole purpose is to satisfy Chrome's
// installability requirement for desktop PWAs (a registered SW with
// a `fetch` event listener). We do *not* cache anything — the dev
// server / Vite already serves with appropriate cache headers, and
// caching would actively interfere with iteration during development.
//
// If you ever want true offline support, this is the file to grow:
// add a precache list during `install`, swap to a cache-first
// strategy in `fetch`, and bump CACHE_VERSION on every release so
// old clients pick up new assets.

self.addEventListener('install', (event) => {
  // Activate immediately so the page's first load can register and
  // satisfy the installability check on the same visit.
  self.skipWaiting();
  // No precache work — install resolves immediately.
  void event;
});

self.addEventListener('activate', (event) => {
  // Claim any open clients so they're controlled by this SW without
  // needing a reload.
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Pass-through: let the network handle the request. Required for
  // Chrome to consider the SW "valid" for PWA installability.
  void event;
});
