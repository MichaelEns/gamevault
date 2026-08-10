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
  'globalThis.__renderSetup = renderSetup;\n' +
  'globalThis.__setSnap = (s) => { SNAP = s; };\n' +
  'globalThis.__setLive = (m) => { LIVE_SECRETS = m; };\n' +
  'globalThis.__pushSource = (s) => { SOURCES.push(s); };\n' +
  'globalThis.__popSource = () => { SOURCES.pop(); };\n',
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

console.log('\nA key saved since the last build is not reported as missing');
// The reported bug: keys were saved correctly and the panel still said "not
// connected", because it only ever saw the snapshot. Distinguishing the two
// requires comparing the secret's updated_at against the snapshot's builtAt.
const BUILT = '2026-08-10T01:00:00.000Z';
const AFTER = '2026-08-10T01:30:00.000Z';
const BEFORE = '2026-08-10T00:30:00.000Z';

globalThis.__setSnap({
  builtAt: BUILT,
  counts: { owned: 0, subscriptions: 1812, priced: 0 },
  entitled: ['pc'],
  stores: {},
  providers: {},
});

// (a) No live data at all -- must not claim anything it cannot know.
globalThis.__setLive(null);
globalThis.__renderSetup();
ok(nodes.get('setup').innerHTML.includes('not connected'),
   'without a token it still reports "not connected"');

// (b) Secret exists and is NEWER than the snapshot -> pending, not missing.
globalThis.__setLive(new Map([['ITAD_API_KEY', AFTER]]));
globalThis.__renderSetup();
let html = nodes.get('setup').innerHTML;
ok(html.includes('rebuild pending'), 'a key saved after the build shows as "rebuild pending"');
ok(html.includes('will be used by the next rebuild'), 'and explains why it is not visible yet');

// (c) Secret exists, OLDER than the snapshot, still no data -> a real problem.
globalThis.__setLive(new Map([['ITAD_API_KEY', BEFORE]]));
globalThis.__renderSetup();
html = nodes.get('setup').innerHTML;
ok(html.includes('saved, but no data'),
   'a key older than the build that produced nothing is flagged, not excused');
ok(!html.includes('rebuild pending'), 'and is NOT mislabelled as pending');

// (d) Multi-secret source: both must be present before it counts as saved.
globalThis.__setLive(new Map([['STEAM_API_KEY', AFTER]]));   // STEAM_ID missing
globalThis.__renderSetup();
html = nodes.get('setup').innerHTML;
const steamCard = cardFor(html, 'Steam');
ok(steamCard.includes('not connected'),
   'a source needing two secrets is not "saved" with only one');

// (e) A working source is never downgraded by the live check.
globalThis.__setSnap({
  builtAt: BUILT,
  counts: { owned: 996, subscriptions: 1812, priced: 71 },
  entitled: ['pc'],
  stores: { steam: { ok: true, count: 996 } },
  providers: { steam: { configured: true, note: 'ready' } },
});
globalThis.__setLive(new Map([['STEAM_API_KEY', AFTER], ['STEAM_ID', AFTER]]));
globalThis.__renderSetup();
html = nodes.get('setup').innerHTML;
ok(html.includes('996 titles'), 'a working source still shows its count');
ok(cardFor(html, 'Steam').includes('src ok'),
   'and stays marked ok even though its secrets are newer than the build');

console.log('\nThe panel states what it is actually showing');
ok(nodes.get('setup').innerHTML.includes('not GitHub'),
   'says it reflects the snapshot rather than current settings');

// Extract a whole source card by the label it contains. Index-slicing from the
// label misses the opening tag, and therefore the class that carries the state.
function cardFor(html, label) {
  // parts[0] is everything BEFORE the first card -- including the intro, which
  // mentions Steam. Skipping it is what makes this select a card rather than
  // prose that happens to contain the same word.
  const parts = html.split('<div class="src ').slice(1);
  const hit = parts.find((p) => p.includes(label));
  return hit ? `<div class="src ${hit}` : '';
}

console.log('\nA price source is judged on prices, not on a store record');
// ITAD never appears in snapshot.stores because it is not an ownership
// provider. Without its own signal it could only ever read "not connected",
// however well it was working -- which is exactly what happened.
globalThis.__setSnap({
  builtAt: BUILT,
  counts: { owned: 1012, subscriptions: 1812, priced: 71 },
  entitled: ['pc'],
  stores: { steam: { ok: true, count: 996 } },   // no `itad` key, by design
  providers: { steam: { configured: true, note: 'ready' } },
});
globalThis.__setLive(new Map([['ITAD_API_KEY', BEFORE]]));
globalThis.__renderSetup();
html = nodes.get('setup').innerHTML;
const itadCard = cardFor(html, 'Prices &');
ok(itadCard.includes('71 titles priced'), 'ITAD reports the number of priced titles');
ok(itadCard.includes('src ok'), 'and is marked working');
ok(!itadCard.includes('not connected'), 'and is NOT reported as missing');

// With no prices at all it must still report honestly.
globalThis.__setSnap({
  builtAt: BUILT,
  counts: { owned: 1012, subscriptions: 1812, priced: 0 },
  entitled: ['pc'], stores: {}, providers: {},
});
globalThis.__setLive(new Map([['ITAD_API_KEY', BEFORE]]));
globalThis.__renderSetup();
html = nodes.get('setup').innerHTML;
ok(cardFor(html, 'Prices &').includes('saved, but no data'),
   'zero priced titles with an older key is still flagged');

// Exercises the "unavailable" rendering path without depending on any real
// source being dead. Sources do die upstream, so the mechanism has to keep
// working even when nothing is currently using it.
function SOURCES_FOR_TEST_UNAVAILABLE() {
  const marker = 'A Dead Storefront';
  globalThis.__pushSource({
    key: '__test_dead', label: marker, unlocks: 'nothing',
    needs: ['DEAD_KEY'], get: null,
    unavailable: 'This storefront shut down its API.',
  });
  globalThis.__setLive(new Map([['DEAD_KEY', AFTER]]));
  globalThis.__renderSetup();
  const out = cardFor(nodes.get('setup').innerHTML, marker);
  globalThis.__popSource();
  return out;
}

console.log('\nUbisoft now uses the API app id, not the blocked client id');
// Ubisoft blocks the Connect PC client's own app id at the gateway: it returns
// 403 errorCode 1002 even for deliberately fake credentials. The app id used
// for API requests is accepted and answers 401 "Invalid credentials" instead,
// so Ubisoft is a normal, configurable source again rather than a dead one.
globalThis.__setLive(new Map([['UBISOFT_REMEMBER_TICKET', AFTER]]));
globalThis.__renderSetup();
html = nodes.get('setup').innerHTML;
const ubiCard = cardFor(html, 'Ubisoft Connect');
ok(ubiCard.includes('rebuild pending'),
   'a ticket newer than the build reads as pending');
ok(!ubiCard.includes('unavailable'),
   'and Ubisoft is no longer flagged as permanently unavailable');

// The hint and the pending note are mutually exclusive, so check the hint in
// the state where it is actually rendered.
globalThis.__setLive(null);
globalThis.__renderSetup();
ok(/ubisoft-auth\.mjs/.test(cardFor(nodes.get('setup').innerHTML, 'Ubisoft Connect')),
   'and when unconfigured it names the 2FA route rather than declaring it impossible');

// The "unavailable" mechanism itself must still work, since a source can
// genuinely die upstream again. Exercise it directly rather than deleting it.
const dead = SOURCES_FOR_TEST_UNAVAILABLE();
ok(dead.includes('unavailable'), 'a source marked unavailable still renders as such');
ok(!dead.includes('rebuild pending'),
   'and is never called pending, which would imply waiting helps');

console.log('\nMarkup is escaped (store errors are attacker-adjacent text)');globalThis.__setSnap({
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
