/**
 * Sources-panel render test.
 *
 * app-static.js touches the DOM at module scope, so it cannot simply be
 * imported under Node. This provides a DOM small enough to be honest about
 * what it is, and large enough that renderSetup() runs for real.
 *
 * Why this exists: renderSetup() is called automatically whenever the
 * snapshot has 0 owned games -- which is exactly the state a new install is
 * in. A throw there would break the app on first unlock, for everyone, at
 * the only moment they have nothing else to look at.
 */
import { readFile, writeFile, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { PATHS } from '../lib/paths.mjs';

const CLIENT = path.join(PATHS.root, 'site', 'app-static.js');

let fails = 0;
const ok = (cond, msg) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); fails++; }
  else console.log(`  ok:   ${msg}`);
};

// ---- minimal DOM -----------------------------------------------------------
const nodes = new Map();
function makeNode(id) {
  const classes = new Set();
  return {
    id,
    innerHTML: '', textContent: '', value: '', checked: false, disabled: false,
    style: {},
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    _classes: classes,
    addEventListener() {},
    focus() {},
  };
}

// The element list is derived from the real index.html rather than hand
// maintained, so the fixture cannot drift out of sync with the markup. That
// also makes this a genuine check: if app-static.js looks up an element the
// HTML does not define, $() returns null and the module throws here.
const indexHtml = await readFile(path.join(PATHS.root, 'site', 'index.html'), 'utf8');
const ids = [...indexHtml.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
for (const id of ids) nodes.set(id, makeNode(id));
// Descendant selectors the app uses that are not plain ids.
nodes.set('unlockForm button', makeNode('unlockFormButton'));

globalThis.document = {
  querySelector: (sel) => nodes.get(sel.replace(/^#/, '')) ?? null,
  querySelectorAll: () => [],
  addEventListener() {},
};
globalThis.localStorage = {
  _d: new Map(),
  getItem(k) { return this._d.has(k) ? this._d.get(k) : null; },
  setItem(k, v) { this._d.set(k, String(v)); },
  removeItem(k) { this._d.delete(k); },
};
globalThis.window = { addEventListener() {}, location: { protocol: 'https:', hostname: 'x' } };
globalThis.fetch = async () => { throw new Error('network disabled in this test'); };

// ---- load the real client --------------------------------------------------
const mod = await import(pathToFileURL(CLIENT).href)
  .catch((e) => { console.log(`  FAIL: module did not load: ${e.message}`); fails++; return null; });

console.log('The real client module loads against a DOM');
ok(mod !== null, 'app-static.js evaluated without throwing');

// renderSetup is module-private, so drive it the way the app does: through
// the Sources button handler, with a snapshot injected via the same globals.
// Simplest faithful approach -- re-evaluate the source with a test hook.
const src = await readFile(CLIENT, 'utf8');
const hooked = src.replace(
  /^\$\('#setupBtn'\)\.addEventListener[\s\S]*$/m,
  'globalThis.__renderSetup = renderSetup;\nglobalThis.__setSnap = (s) => { SNAP = s; };\n',
);
// Written beside the original so its relative import of ./snapshot-crypto.mjs
// still resolves; a data: URL cannot resolve relative specifiers.
const hookedPath = path.join(PATHS.root, 'site', `.hooked-${process.pid}.mjs`);
await writeFile(hookedPath, hooked, 'utf8');
try {
  await import(pathToFileURL(hookedPath).href);
} finally {
  await rm(hookedPath, { force: true });
}

console.log('\nrenderSetup survives a completely empty snapshot');
// This is the exact shape a brand-new install produces.
globalThis.__setSnap({
  builtAt: new Date().toISOString(),
  counts: { owned: 0, subscriptions: 1812, priced: 0 },
  entitled: ['pc', 'console', 'cloud', 'eaplay'],
  stores: {},
  providers: {},
});
let threw = null;
try { globalThis.__renderSetup(); } catch (e) { threw = e; }
ok(threw === null, threw ? `threw: ${threw.message}` : 'no exception with empty stores/providers');
const emptyHtml = nodes.get('setup').innerHTML;
ok(emptyHtml.includes('Steam'), 'lists Steam');
ok(emptyHtml.includes('not connected'), 'marks unconfigured sources as not connected');
ok(emptyHtml.includes('steamcommunity.com/dev/apikey'), 'links the page that issues the key');
ok(emptyHtml.includes('settings/secrets/actions'), 'links the GitHub secret form');
ok(!emptyHtml.includes('undefined'), 'no "undefined" leaked into the markup');
ok(!emptyHtml.includes('[object Object]'), 'no "[object Object]" leaked into the markup');

console.log('\nrenderSetup reflects a working source');
globalThis.__setSnap({
  builtAt: new Date().toISOString(),
  counts: { owned: 312, subscriptions: 1812, priced: 400 },
  entitled: ['pc'],
  stores: { steam: { ok: true, count: 312 }, itch: { ok: false, error: 'HTTP 403', count: 0 } },
  providers: { steam: { configured: true, note: 'ready' }, itch: { configured: true, note: 'ready' } },
});
threw = null;
try { globalThis.__renderSetup(); } catch (e) { threw = e; }
ok(threw === null, threw ? `threw: ${threw.message}` : 'no exception with populated stores');
const liveHtml = nodes.get('setup').innerHTML;
ok(liveHtml.includes('312 titles'), 'shows the synced count for a working source');
ok(liveHtml.includes('src ok'), 'flags the working source as ok');
ok(liveHtml.includes('HTTP 403'), 'surfaces a failed sync error instead of hiding it');
ok(!liveHtml.includes('undefined'), 'no "undefined" in the populated render');

console.log('\nMarkup is escaped (store errors are attacker-adjacent text)');
globalThis.__setSnap({
  builtAt: new Date().toISOString(),
  counts: { owned: 1, subscriptions: 0, priced: 0 },
  entitled: [],
  stores: { steam: { ok: false, error: '<img src=x onerror=alert(1)>', count: 0 } },
  providers: { steam: { configured: true, note: 'ready' } },
});
threw = null;
try { globalThis.__renderSetup(); } catch (e) { threw = e; }
ok(threw === null, 'no exception with hostile text');
const evil = nodes.get('setup').innerHTML;
ok(!evil.includes('<img src=x'), 'raw tag from a sync error is not injected');
ok(evil.includes('&lt;img'), 'it is escaped instead');

console.log('');
if (fails) { console.log(`${fails} assertion(s) failed.`); process.exit(1); }
console.log('All sources-panel tests passed.');
