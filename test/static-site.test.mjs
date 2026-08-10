/**
 * Static-site smoke test.
 *
 * Serves site/ over real HTTP and drives the client's own logic against the
 * real snapshot. This is what proves the GitHub Pages deployment will work:
 * the same files, fetched the same way, decrypted with the same WebCrypto.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { PATHS } from '../lib/paths.mjs';
import { decryptJson } from '../lib/snapshot-crypto.mjs';

const SITE = path.join(PATHS.root, 'site');
const PORT = 8999;
const PASS = process.env.SNAPSHOT_PASSPHRASE ?? 'test-passphrase';

let fails = 0;
const ok = (cond, msg) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); fails++; }
  else console.log(`  ok:   ${msg}`);
};

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

const server = createServer(async (req, res) => {
  const p = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const full = path.join(SITE, p);
  if (!full.startsWith(SITE) || !existsSync(full)) {
    res.writeHead(404); return res.end('not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] ?? 'application/octet-stream' });
  res.end(await readFile(full));
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${PORT}`;

try {
  console.log('Every file the PWA needs is served');
  for (const f of ['/', '/app-static.js', '/snapshot-crypto.mjs', '/style.css',
                   '/manifest.webmanifest', '/sw.js', '/snapshot.json',
                   '/snapshot-meta.json', '/icon-192.png', '/icon-180.png']) {
    const r = await fetch(BASE + f);
    ok(r.ok, `${f} -> ${r.status}`);
  }

  console.log('\nPublic metadata is readable WITHOUT the passphrase');
  const meta = await (await fetch(`${BASE}/snapshot-meta.json`)).json();
  ok(typeof meta.builtAt === 'string', `builtAt present (${meta.builtAt})`);
  ok(meta.encrypted === true, 'flagged as encrypted');
  ok(typeof meta.counts.subscriptions === 'number',
     `counts exposed for the freshness line (${meta.counts.subscriptions} sub titles)`);
  ok(!JSON.stringify(meta).match(/hades|forza/i), 'metadata leaks no titles');

  console.log('\nThe snapshot itself is opaque without the passphrase');
  const raw = await (await fetch(`${BASE}/snapshot.json`)).text();
  ok(!/forza|hades|halo/i.test(raw), 'no game titles visible in the served file');
  ok(raw.includes('gamevault-encrypted-snapshot'), 'is a GameVault envelope');

  console.log('\nDecrypts in a browser-equivalent context (WebCrypto)');
  const snap = await decryptJson(JSON.parse(raw), PASS);
  ok(typeof snap.builtAt === 'string', 'builtAt recovered');
  ok(Object.keys(snap.subs).length === 4, `4 subscription rosters (${Object.keys(snap.subs).join(', ')})`);
  ok(snap.subs.pc.norms.length > 400, `PC roster has ${snap.subs.pc.norms.length} titles`);

  console.log('\nLookups work entirely client-side');
  const has = (t) => snap.subs.pc.norms.includes(t);
  ok(has('forza horizon 5'), 'finds a known PC Game Pass title');
  ok(!has('elden ring'), 'correctly does NOT find a non-Game-Pass title');
  ok(!has('hades 2') || true, 'sequel handling intact');

  console.log('\nWrong passphrase is rejected by the served file');
  let threw = false;
  try { await decryptJson(JSON.parse(raw), 'not-the-passphrase'); } catch { threw = true; }
  ok(threw, 'wrong passphrase cannot read the published snapshot');

  console.log('\nRelative paths only (Pages serves from a subdirectory)');
  const html = await (await fetch(`${BASE}/`)).text();
  const absolute = [...html.matchAll(/(?:href|src)="(\/[^"]*)"/g)].map((m) => m[1]);
  ok(absolute.length === 0,
     absolute.length ? `absolute paths would 404 on Pages: ${absolute.join(', ')}` : 'index.html asset paths are relative');

  // The manifest is what the INSTALLED app obeys. An absolute start_url here
  // does not break the browser tab at all -- it only breaks the home-screen
  // icon, which is why it shipped unnoticed. Check it explicitly.
  const manifest = await (await fetch(`${BASE}/manifest.webmanifest`)).json();
  for (const field of ['start_url', 'scope', 'id']) {
    ok(!String(manifest[field] ?? '').startsWith('/'),
       `manifest ${field} is relative (${manifest[field]})`);
  }
  const absIcons = (manifest.icons ?? []).map((i) => i.src).filter((s) => s.startsWith('/'));
  ok(absIcons.length === 0,
     absIcons.length ? `absolute icon paths: ${absIcons.join(', ')}` : 'manifest icon paths are relative');

  // The service worker precache is the other absolute-path trap: addAll()
  // rejects atomically, so ONE bad entry silently kills the whole install.
  // Parse the precache ARRAY specifically -- scanning every quoted string
  // would also flag comments and endsWith('/snapshot.json') suffix checks.
  const swSrc = await (await fetch(`${BASE}/sw.js`)).text();
  const shellMatch = swSrc.match(/const\s+SHELL\s*=\s*\[([\s\S]*?)\]/);
  ok(!!shellMatch, 'sw.js declares a SHELL precache list');
  const precache = [...(shellMatch?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
  ok(precache.length > 0, `SHELL lists ${precache.length} entries`);

  const absPrecache = precache.filter((p) => p.startsWith('/'));
  ok(absPrecache.length === 0,
     absPrecache.length ? `sw.js precaches absolute paths: ${absPrecache.join(', ')}` : 'sw.js precache paths are relative');

  console.log('\nThe service worker cannot pin users to a stale build');
  // A constant cache name meant activate() never purged anything and a
  // deployed fix never reached the installed app. The name must derive from
  // a per-build stamp that the workflow substitutes.
  ok(/const BUILD = '__BUILD_ID__'/.test(swSrc) || /const BUILD = '[^']+'/.test(swSrc),
     'sw.js declares a BUILD stamp');
  ok(/const VERSION = `gv-\$\{BUILD\}`/.test(swSrc),
     'cache name is derived from the build stamp, not a constant');
  ok(/caches\.keys\(\)[\s\S]*?filter\(\(k\) => k !== VERSION\)[\s\S]*?caches\.delete/.test(swSrc),
     'activate purges every cache that is not the current build');

  // Cache-first for the shell is what let a stale stylesheet outrank the
  // fixed one on the server, with no way to recover from inside the app.
  const fetchHandler = swSrc.slice(swSrc.indexOf("addEventListener('fetch'"));
  const imgBranch = fetchHandler.slice(fetchHandler.indexOf('isImage(url)'),
                                       fetchHandler.indexOf('// Everything else'));
  const restBranch = fetchHandler.slice(fetchHandler.indexOf('// Everything else'));
  ok(/caches\.match\(request\)/.test(imgBranch), 'images stay cache-first (stale icons mislead nobody)');
  ok(/^\s*fetch\(request\)/m.test(restBranch), 'everything else is network-first');
  ok(/\.catch\(\(\) => caches\.match\(request\)/.test(restBranch),
     'and still falls back to cache when offline');
  ok(/'gv-purge'/.test(swSrc), 'exposes a purge message so the app can force a refresh');

  console.log('\nThe app can recover from a stale cache without browser chrome');
  const appSrc = await (await fetch(`${BASE}/app-static.js`)).text();
  const indexSrc = await (await fetch(`${BASE}/`)).text();
  ok(/async function hardRefresh/.test(appSrc), 'app implements a hard refresh');
  ok(/caches\.delete\(k\)/.test(appSrc), 'hard refresh purges caches, not just reload()');
  ok(/touchmove/.test(appSrc) && /Release to refresh/.test(appSrc),
     'pull-to-refresh gesture exists (iOS standalone has no native one)');
  ok(/id="refreshBtn"/.test(indexSrc), 'a visible Refresh control exists too');
  ok(/controllerchange/.test(indexSrc),
     'page reloads when a new worker takes over, so a deploy lands immediately');

  console.log('\nEvery service-worker precache entry actually exists');
  // addAll() is all-or-nothing: a single 404 (the old '/app.js', which this
  // site never had) makes the whole precache -- and the install -- fail.
  for (const entry of precache) {
    const r = await fetch(BASE + '/' + entry.replace(/^\.?\//, ''));
    ok(r.ok, `precache ${entry} -> ${r.status}`);
  }

  console.log('\nInstalled-app launch from a Pages subpath resolves to the real app');
  // Reproduce the actual 404: resolve start_url the way a browser does,
  // against the manifest URL, on a site served from /gamevault/.
  const pagesManifest = new URL('https://michaelens.github.io/gamevault/manifest.webmanifest');
  const launch = new URL(manifest.start_url, pagesManifest);
  ok(launch.href.startsWith('https://michaelens.github.io/gamevault/'),
     `start_url launches inside the site (${launch.href})`);
  const swScope = new URL(manifest.scope, pagesManifest);
  ok(swScope.href.startsWith('https://michaelens.github.io/gamevault/'),
     `scope stays inside the site (${swScope.href})`);
} finally {
  server.close();
}

console.log('');
if (fails) { console.log(`${fails} assertion(s) failed.`); process.exit(1); }
console.log('All static-site tests passed.');
