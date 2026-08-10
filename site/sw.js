/**
 * GameVault service worker - static (GitHub Pages) build.
 *
 * All paths are RELATIVE. Pages serves this from a subdirectory, so an
 * absolute '/style.css' would resolve to the domain root and 404.
 *
 * CACHING STRATEGY -- network-first for everything except images.
 *
 * An earlier version was cache-first for the app shell with a fixed cache
 * name. Both halves of that were wrong: the fixed name meant activate()
 * never purged anything, and cache-first meant a stale stylesheet beat the
 * fixed one on the server indefinitely. A deployed fix never reached the
 * installed app, and with no browser chrome in standalone mode there was no
 * way for the user to force it.
 *
 * The shell is ~60KB and the app already fetches the snapshot from the
 * network on unlock, so network-first costs almost nothing, and it removes
 * that entire failure mode. The cache still exists and still serves the app
 * offline -- it is just no longer authoritative while online.
 */

// Replaced at deploy time; the workflow fails the build if this placeholder
// survives, because a constant cache name is what caused the stale-asset bug.
const BUILD = '__BUILD_ID__';
const VERSION = `gv-${BUILD}`;

const SHELL = [
  './',
  './index.html',
  './style.css',
  './app-static.js',
  './live-prices.js',
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

// Cache names used before the build stamp existed. Those builds were
// cache-first, so a page loaded under them is showing assets that may be
// arbitrarily old and predates the reload-on-update handler in index.html.
// Navigating those clients is the only way to correct them from here.
const LEGACY_CACHES = ['gv-static-v1', 'gv-static-v2'];

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const stale = keys.filter((k) => k !== VERSION);
    await Promise.all(stale.map((k) => caches.delete(k)));
    await self.clients.claim();

    // Deliberately NOT done for ordinary upgrades: a forced navigation during
    // a scheduled rebuild would drop the decrypted snapshot and bounce the
    // user back to the passphrase screen mid-use. Once network-first is in
    // effect, every launch fetches current assets anyway, so this is only
    // needed to escape the older cache-first builds.
    if (!stale.some((k) => LEGACY_CACHES.includes(k))) return;
    const windows = await self.clients.matchAll({ type: 'window' });
    for (const c of windows) {
      if (typeof c.navigate === 'function') c.navigate(c.url).catch(() => {});
    }
  })());
});

// Lets the page trigger a genuine refresh (pull-to-refresh) without having to
// know the cache name.
self.addEventListener('message', (event) => {
  if (event.data === 'gv-purge') {
    event.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))));
  }
});

const isImage = (url) => /\.(png|jpg|jpeg|webp|svg|ico)$/i.test(url.pathname);

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Icons are content-stable and the most expensive thing to refetch; they are
  // also the only assets whose staleness cannot mislead anyone.
  if (isImage(url)) {
    event.respondWith(
      caches.match(request).then((hit) => hit || fetch(request).then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(request, copy)).catch(() => {});
        }
        return res;
      })),
    );
    return;
  }

  // Everything else: network wins when reachable, cache covers offline.
  event.respondWith(
    fetch(request)
      .then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(request).then((hit) => hit || caches.match('./index.html'))),
  );
});
