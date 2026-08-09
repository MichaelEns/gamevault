/**
 * GameVault service worker.
 *
 * Scope is deliberately narrow. Caching the app SHELL (html/css/js/icons)
 * makes the PWA open instantly and survive a dropped connection, which is
 * the point of installing it on a phone.
 *
 * API responses are NEVER cached. Prices and ownership are exactly the data
 * you must not see a stale copy of -- a cached "on sale" or "you own this"
 * is worse than no answer at all.
 */
const VERSION = 'gv-v1';
const SHELL = [
  '/',
  '/style.css',
  '/app.js',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()), // a failed precache must not block install
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never serve API data from cache, and never store it.
  if (url.pathname.startsWith('/api/')) return;

  // Login page must always be live so a redirect is not masked by a cache hit.
  if (url.pathname === '/login' || url.pathname === '/login.html') return;

  // Shell: cache-first, then refresh in the background.
  event.respondWith(
    caches.match(request).then((hit) => {
      const network = fetch(request)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(request, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => hit); // offline: fall back to whatever we have
      return hit || network;
    }),
  );
});
