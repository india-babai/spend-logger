/*
 * Service worker: makes the app work offline.
 *
 * Strategy is "stale-while-revalidate": every request is answered from the
 * cache straight away (fast, works offline), and in the background the file
 * is re-fetched so the next launch picks up any update you deployed.
 *
 * Bump CACHE_VERSION if you add/rename files in ASSETS, so old caches are
 * cleaned up.
 */
const CACHE_VERSION = 'spendlogger-v3';

const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './invest.js',
  './statement-import.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

// Pre-cache the app shell on install.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Remove caches from older versions.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Only handle our own GET requests.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);
    const cached = await cache.match(req, { ignoreSearch: true });

    const network = fetch(req)
      .then((res) => {
        if (res.ok) cache.put(req, res.clone());
        return res;
      })
      .catch(() => null);

    // Keep the worker alive until the background refresh finishes.
    event.waitUntil(network);

    if (cached) return cached;
    const fresh = await network;
    if (fresh) return fresh;
    // Offline and not cached: fall back to the app shell for page loads.
    if (req.mode === 'navigate') return cache.match('./index.html');
    return Response.error();
  })());
});
