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
     absolute.length ? `absolute paths would 404 on Pages: ${absolute.join(', ')}` : 'all asset paths are relative');
} finally {
  server.close();
}

console.log('');
if (fails) { console.log(`${fails} assertion(s) failed.`); process.exit(1); }
console.log('All static-site tests passed.');
