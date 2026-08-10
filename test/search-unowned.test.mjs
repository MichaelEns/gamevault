/**
 * Searching for a game you do NOT own.
 *
 * This is the case the app was worst at. Searching "007 First Light" produced
 * "Nothing matching ... in your library or subscriptions" and stopped: it
 * answered the ownership question correctly and abandoned the price question
 * entirely, which is the half most likely to be the reason you searched.
 *
 * Pinned here because the regression is silent - the app looks like it is
 * working, and a dead end is indistinguishable from a genuine "no results"
 * unless something checks.
 */
import { readFile, writeFile, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { PATHS } from '../lib/paths.mjs';
import { _clearCache } from '../site/live-prices.js';

const CLIENT = path.join(PATHS.root, 'site', 'app-static.js');

let fails = 0;
const ok = (cond, msg) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); fails++; }
  else console.log(`  ok:   ${msg}`);
};

// ---- minimal DOM -----------------------------------------------------------
// Deliberately small. It only has to be faithful about the parts render() and
// fillLivePrices() actually touch: innerHTML, and finding cards by selector.
const nodes = new Map();
function makeNode(id) {
  const classes = new Set();
  const node = {
    id, innerHTML: '', textContent: '', value: '', checked: false, disabled: false,
    style: {}, dataset: {},
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    _classes: classes,
    addEventListener() {}, focus() {},
    querySelector: () => null,
  };
  return node;
}

const indexHtml = await readFile(path.join(PATHS.root, 'site', 'index.html'), 'utf8');
for (const id of [...indexHtml.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1])) {
  nodes.set(id, makeNode(id));
}
nodes.set('unlockForm button', makeNode('unlockFormButton'));

// Cards are looked up by attribute selector after render(). Create them on
// demand rather than pre-registering by name: the test must not encode its own
// guess at how titles are normalised, or it would pass while the app looked up
// a selector that never matches anything.
const cards = new Map();
globalThis.document = {
  querySelector: (sel) => {
    if (sel.startsWith('.card[')) {
      const m = sel.match(/data-norm="([^"]*)"/);
      const norm = m?.[1];
      if (norm === undefined) return null;
      if (!cards.has(norm)) cards.set(norm, makeCard(norm));
      return cards.get(norm);
    }
    return nodes.get(sel.replace(/^#/, '')) ?? null;
  },
  querySelectorAll: () => [],
  addEventListener() {},
};
globalThis.localStorage = {
  _d: new Map(),
  getItem(k) { return this._d.has(k) ? this._d.get(k) : null; },
  setItem(k, v) { this._d.set(k, String(v)); },
  removeItem(k) { this._d.delete(k); },
};
globalThis.window = { addEventListener() {}, location: { protocol: 'https:', hostname: 'x' }, CSS: null };
globalThis.CSS = undefined;

/** Register a card the way the browser would after innerHTML is set. */
function makeCard(norm) {
  const parts = { pricearea: makeNode('pricearea'), verdict: makeNode('verdict'), reason: makeNode('reason') };
  return {
    className: '', dataset: { norm },
    querySelector: (sel) => parts[sel.replace('.', '')] ?? null,
    _parts: parts,
  };
}

/** The single card produced by the last render, whatever it was normalised to. */
function theCard() {
  const all = [...cards.values()];
  if (all.length !== 1) throw new Error(`expected exactly one card, saw ${all.length}`);
  return all[0];
}

// ---- load the real client with private functions exposed -------------------
const src = await readFile(CLIENT, 'utf8');
const hooked = `${src}\nglobalThis.__render = render;\nglobalThis.__setSnap = (s) => { SNAP = s; };\n`;
const hookedPath = path.join(PATHS.root, 'site', `.hooked-search-${process.pid}.mjs`);
await writeFile(hookedPath, hooked, 'utf8');

const PRICED = [{
  id: 'g1', deals: [
    { shop: { name: 'Steam' }, price: { amount: 59.99, currency: 'USD' },
      regular: { amount: 69.99, currency: 'USD' }, cut: 14, url: 'https://steam/x' },
  ],
}];

/** Route ITAD calls; `mode` decides whether the browser is allowed to. */
function net(mode) {
  globalThis.fetch = async (url) => {
    if (mode === 'cors-blocked') throw new TypeError('Failed to fetch');
    const u = new URL(url);
    if (u.pathname.startsWith('/games/search/v1')) {
      return { ok: true, status: 200, json: async () => [{ id: 'g1', title: '007 First Light' }] };
    }
    if (u.pathname.startsWith('/games/prices/v3')) {
      return { ok: true, status: 200, json: async () => PRICED };
    }
    if (u.pathname.startsWith('/games/historylow/v1')) {
      return { ok: true, status: 200, json: async () => [{ id: 'g1', low: { amount: 44.99, currency: 'USD', shop: { name: 'Fanatical' } } }] };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

const BASE_SNAP = {
  builtAt: new Date().toISOString(),
  counts: { owned: 1414, subscriptions: 1812, priced: 201 },
  entitled: ['pc'], stores: {}, providers: {},
  index: {}, subs: {}, prices: {}, verdicts: {},
};

const results = nodes.get('results');
const flush = () => new Promise((r) => setTimeout(r, 0));

try {
  await import(pathToFileURL(hookedPath).href);

  console.log('An unowned game is no longer a dead end');
  globalThis.__setSnap({ ...BASE_SNAP, live: { itadKey: 'k', country: 'US' } });
  net('ok');
  globalThis.__render([], '007 First Light');
  ok(!/Nothing matching/i.test(results.innerHTML),
     'the "nothing matching" dead end is gone');
  ok(/<article class="card/.test(results.innerHTML),
     'a card is rendered for a game absent from the snapshot');
  ok(/007 First Light/.test(results.innerHTML), 'and it names the game searched for');

  await flush(); await flush(); await flush();
  const card = theCard();
  ok(/Steam/.test(card._parts.pricearea.innerHTML),
     'the storefront selling it is listed');
  ok(/59\.99/.test(card._parts.pricearea.innerHTML),
     'with its price');
  ok(/44\.99/.test(card._parts.pricearea.innerHTML),
     'and the all-time low, which is what makes the price meaningful');
  ok(card.className.includes('v-'), `the verdict class is applied (got "${card.className}")`);

  console.log('\nWhen the browser blocks the call, the card still helps');
  globalThis.__setSnap({ ...BASE_SNAP, live: { itadKey: 'k', country: 'US' } });
  net('cors-blocked');
  cards.clear();
  _clearCache();
  globalThis.__render([], '007 First Light');
  await flush(); await flush(); await flush();
  const blocked = theCard();
  ok(/storelink/.test(blocked._parts.pricearea.innerHTML),
     'storefront search links are offered instead of an empty card');
  ok(/store\.steampowered\.com/.test(blocked._parts.pricearea.innerHTML),
     'including Steam');
  ok(/007%20First%20Light/.test(blocked._parts.pricearea.innerHTML),
     'pre-filled with the title searched for');
  ok(blocked._parts.verdict.textContent === 'No price data',
     `the verdict is honest about it (got "${blocked._parts.verdict.textContent}")`);

  console.log('\nA game you own is not looked up at all');
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('should not run'); };
  globalThis.__setSnap({
    ...BASE_SNAP,
    index: { celeste: [{ store: 'steam', title: 'Celeste' }] },
    live: { itadKey: 'k', country: 'US' },
  });
  cards.clear();
  globalThis.__render([{ norm: 'celeste', title: 'Celeste' }], 'Celeste');
  await flush(); await flush();
  ok(calls === 0, `owned games spend no lookups (made ${calls})`);
  ok(/You already own this/.test(results.innerHTML), 'and still answer the ownership question');

  console.log('\nA game in a subscription you pay for is not looked up either');
  calls = 0;
  globalThis.__setSnap({
    ...BASE_SNAP,
    subs: { pc: { label: 'PC Game Pass', norms: ['hades'], count: 1 } },
    entitled: ['pc'],
    live: { itadKey: 'k', country: 'US' },
  });
  cards.clear();
  globalThis.__render([{ norm: 'hades', title: 'Hades' }], 'Hades');
  await flush(); await flush();
  ok(calls === 0, `subscription titles spend no lookups (made ${calls})`);

  console.log('\nWithout a live key the app falls back rather than failing');
  globalThis.__setSnap({ ...BASE_SNAP, live: null });
  cards.clear();
  globalThis.__render([], '007 First Light');
  await flush(); await flush();
  const nokey = theCard();
  ok(/storelink/.test(nokey._parts.pricearea.innerHTML),
     'store links appear even with live lookup disabled');

  console.log('\nSearch terms are escaped, not injected');
  globalThis.__setSnap({ ...BASE_SNAP, live: null });
  cards.clear();
  globalThis.__render([], '<img src=x onerror=alert(1)>');
  ok(!/<img src=x/.test(results.innerHTML),
     'a script-y search term is escaped in the no-results card');
} finally {
  await rm(hookedPath, { force: true });
}

if (fails) { console.log(`\n${fails} assertion(s) failed.`); process.exit(1); }
console.log('\nAll unowned-search assertions passed.');
