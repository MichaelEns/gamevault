/**
 * GameVault service worker - static (GitHub Pages) build.
 *
 * All paths are RELATIVE. Pages serves this from a subdirectory, so an
 * absolute '/style.css' would resolve to the domain root and 404 -- which
 * is exactly what broke the first install.
 *
 * The app SHELL is cached so the PWA opens instantly and works offline.
 * The SNAPSHOT is not: it is the data you actually want current, and a
 * stale cached copy would silently show old prices. It is fetched
 * network-first, falling back to cache only when genuinely offline.
 */
const VERSION = 'gv-static-v2';

// Relative to the SW's own scope, which on Pages is /gamevault/.
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app-static.js',
  './snapshot-crypto.mjs',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),  // a failed precache must not block install
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

  const isSnapshot = url.pathname.endsWith('/snapshot.json') ||
                     url.pathname.endsWith('/snapshot-meta.json');

  if (isSnapshot) {
    // Network-first: freshness matters more than speed for the data itself.
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(request, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(request)),   // offline: last known snapshot
    );
    return;
  }

  // Shell: cache-first, refreshed in the background.
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
        .catch(() => hit);
      return hit || network;
    }),
  );
});