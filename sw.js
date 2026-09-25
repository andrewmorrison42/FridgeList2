// Service worker: caches the app shell so it opens instantly and survives brief
// signal loss (§3.1, FR-SYNC-6).
//
// It caches APPLICATION CODE ONLY. Household data lives in IndexedDB and is
// never served from here — a cached copy of someone's shopping list is exactly
// the "stale data presented as current" that FR-SYNC-2 forbids.

const CACHE = 'fridgelist-v3';
const SHELL = [
  './', './index.html', './manifest.webmanifest', './icon.svg',
  './src/ui/styles.css', './src/ui/main.js', './src/ui/app.js', './src/ui/dom.js',
  './src/ui/views.js', './src/ui/status.js', './src/ui/connect.js', './src/ui/editor.js',
  './src/core/events.js', './src/core/merge.js', './src/core/store.js',
  './src/core/units.js', './src/core/generate.js', './src/core/carryover.js',
  './src/core/shop.js', './src/core/library.js', './src/core/recipes-format.js',
  './src/data/storage.js', './src/data/sync.js', './src/data/presence.js',
  './src/data/persist.js', './src/data/onedrive.js', './src/data/auth.js', './src/data/recipes.js',
  './src/version.js',
  // The starter recipes, for a device not yet connected to OneDrive.
  './data/recipes-data.reviewed.json',
];

self.addEventListener('install', (e) => {
  // `reload`: straight from the site, not the browser's copy, which GitHub
  // Pages lets it keep for up to ten minutes.
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Never intercept the data backend: a cached response would be stale data
  // wearing a current face.
  if (url.origin !== self.location.origin) return;
  if (e.request.method !== 'GET') return;

  // Network first, so an updated app is picked up; cache is the fallback that
  // makes the app work in a dead spot.
  //
  // `no-cache` makes the browser check with the site each time (a 304 when
  // nothing changed). Without it, GitHub Pages' ten-minute cache headers let
  // the browser hand back old files after an update — or a mix of old and new.
  const fresh = e.request.mode === 'navigate'
    ? new Request(e.request.url, { cache: 'no-cache', credentials: 'same-origin' })
    : new Request(e.request, { cache: 'no-cache' });
  e.respondWith(
    fetch(fresh)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r ?? caches.match('./index.html'))),
  );
});
