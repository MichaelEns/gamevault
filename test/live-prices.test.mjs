/**
 * Live price lookup for games the snapshot does not cover.
 *
 * This path exists because the interesting question - "should I buy this?" -
 * is by definition about a game you do NOT own, and therefore about a game
 * that is usually absent from a snapshot built from your library.
 *
 * The failure modes worth pinning:
 *
 *   - a CORS refusal must degrade to storefront links, not to a blank card or
 *     an unhandled rejection. The browser may simply refuse this call and the
 *     app cannot control that;
 *   - the response shape must be parsed the way the PRODUCTION client parses
 *     it. An invented fixture is worse than no test: the freebies index bug
 *     survived twenty passing assertions precisely because its fixture was
 *     made up rather than taken from the real thing.
 *
 * So the fixtures below mirror lib/itad.mjs's own parsing of ITAD v3
 * (`deals[].price.amount`, `deals[].regular.amount`, `.shop.name`, `.cut`),
 * not a guess at it.
 */
import { liveSearch, livePrice, livePrices, storeLinks, _clearCache } from '../site/live-prices.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

let fails = 0;
const ok = (cond, msg) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); fails++; }
  else console.log(`  ok:   ${msg}`);
};

const LIVE = { itadKey: 'test-key', country: 'US' };

// Exactly the wire shape lib/itad.mjs reads in prices()/historyLow().
const SEARCH_HIT = [{ id: 'uuid-007', slug: '007-first-light', title: '007 First Light', type: 'game' }];
const PRICES = [{
  id: 'uuid-007',
  deals: [
    { shop: { id: 61, name: 'Steam' }, price: { amount: 59.99, currency: 'USD' },
      regular: { amount: 69.99, currency: 'USD' }, cut: 14, url: 'https://store.steampowered.com/x' },
    { shop: { id: 35, name: 'GreenManGaming' }, price: { amount: 48.99, currency: 'USD' },
      regular: { amount: 69.99, currency: 'USD' }, cut: 30, url: 'https://gmg/x' },
  ],
}];
const LOWS = [{ id: 'uuid-007', low: { amount: 44.99, currency: 'USD', shop: { name: 'Fanatical' }, timestamp: '2026-01-02' } }];

/** Stub fetch, routing by path the way the real API does. */
function stubFetch(routes) {
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const hit = Object.entries(routes).find(([p]) => u.pathname.startsWith(p));
    if (!hit) return { ok: false, status: 404, json: async () => ({}) };
    const body = typeof hit[1] === 'function' ? hit[1](u, opts) : hit[1];
    if (body instanceof Error) throw body;
    return { ok: true, status: 200, json: async () => body };
  };
}

const realFetch = globalThis.fetch;

console.log('A game absent from the snapshot still gets prices');
_clearCache();
stubFetch({
  '/games/search/v1': SEARCH_HIT,
  '/games/prices/v3': PRICES,
  '/games/historylow/v1': LOWS,
});
{
  const r = await livePrice('007 First Light', LIVE);
  ok(r !== null, 'a live lookup returns a result');
  ok(r.deals.length === 2, `both shops are listed (got ${r?.deals.length})`);
  ok(r.deals[0].shop === 'GreenManGaming',
     `cheapest first, so the card leads with the best offer (got ${r?.deals[0].shop})`);
  ok(r.deals[0].amount === 48.99, 'price comes from deals[].price.amount');
  ok(r.deals[0].regular === 69.99,
     'regular price survives, without which the discount cannot be scored');
  ok(r.low?.amount === 44.99, 'the all-time low is the yardstick for "good deal"');
  ok(r.low?.shop === 'Fanatical', 'and names the shop that hit it');
}

console.log('\nA browser refusing the call degrades, and never throws');
_clearCache();
stubFetch({ '/games/search/v1': new TypeError('Failed to fetch') });
{
  let threw = false;
  let r;
  try { r = await livePrice('007 First Light', LIVE); } catch { threw = true; }
  ok(!threw, 'a CORS refusal does not produce an unhandled rejection');
  ok(r === null, 'and resolves to null so the caller can fall back');
}

console.log('\nThe fallback answers "who sells this" without any API at all');
{
  const links = storeLinks('007 First Light');
  ok(links.length >= 4, `several storefronts offered (got ${links.length})`);
  ok(links.every((l) => { try { new URL(l.url); return true; } catch { return false; } }),
     'every link is a valid URL');
  ok(links.every((l) => l.url.includes('007%20First%20Light') || l.url.includes('007+First+Light')),
     'the title is URL-encoded, so titles with spaces and symbols still search');
  ok(links.some((l) => /steam/i.test(l.shop)) && links.some((l) => /gog/i.test(l.shop)),
     'the big PC stores are covered');
}

console.log('\nDegenerate responses are treated as "no data", not as a price');
for (const [label, routes] of [
  ['no search results', { '/games/search/v1': [] }],
  ['a game with no deals', { '/games/search/v1': SEARCH_HIT, '/games/prices/v3': [{ id: 'uuid-007', deals: [] }], '/games/historylow/v1': [] }],
  ['deals with null prices', { '/games/search/v1': SEARCH_HIT, '/games/prices/v3': [{ id: 'uuid-007', deals: [{ shop: { name: 'Steam' }, price: null }] }], '/games/historylow/v1': [] }],
]) {
  _clearCache();
  stubFetch(routes);
  const r = await livePrice('007 First Light', LIVE);
  ok(label === 'no search results' ? r === null : r?.deals.length === 0,
     `${label} never becomes a price or removes a catalog listing`);
}

console.log('\nMissing history is survivable; missing prices is not');
_clearCache();
stubFetch({
  '/games/search/v1': SEARCH_HIT,
  '/games/prices/v3': PRICES,
  '/games/historylow/v1': new Error('history endpoint down'),
});
{
  const r = await livePrice('007 First Light', LIVE);
  ok(r !== null, 'prices still returned when the history call fails');
  ok(r.low === null, 'and the low is simply absent rather than wrong');
}

console.log('\nWithout a key the app does not pretend to try');
_clearCache();
let called = 0;
globalThis.fetch = async () => { called++; throw new Error('should not be called'); };
{
  ok(await livePrice('007 First Light', null) === null, 'no live config -> null');
  ok(await livePrice('007 First Light', { country: 'US' }) === null, 'no key -> null');
  ok(await livePrice('', LIVE) === null, 'empty title -> null');
  ok(called === 0, 'and no request is made at all');
}

console.log('\nRepeat searches do not re-hit the API');
_clearCache();
let hits = 0;
stubFetch({
  '/games/search/v1': () => { hits++; return SEARCH_HIT; },
  '/games/prices/v3': PRICES,
  '/games/historylow/v1': LOWS,
});
{
  await livePrice('007 First Light', LIVE);
  await livePrice('007 first light', LIVE);   // same game, different casing
  ok(hits === 1, `one lookup for two searches of the same title (got ${hits})`);
}

console.log('\nBut a failure is not remembered, so one blip is not permanent');
_clearCache();
{
  let attempt = 0;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname.startsWith('/games/search/v1')) {
      attempt++;
      if (attempt === 1) throw new TypeError('Failed to fetch');
      return { ok: true, status: 200, json: async () => SEARCH_HIT };
    }
    if (u.pathname.startsWith('/games/prices/v3')) return { ok: true, status: 200, json: async () => PRICES };
    return { ok: true, status: 200, json: async () => LOWS };
  };
  ok(await livePrice('007 First Light', LIVE) === null, 'the first attempt fails');
  const second = await livePrice('007 First Light', LIVE);
  ok(second !== null,
     'and searching again retries rather than replaying the cached failure');
  ok(second?.deals?.length === 2, 'the retry returns real prices');
}

console.log('\nThe key is sent as a parameter, never in a logged URL path');
_clearCache();
let seenUrl = '';
stubFetch({ '/games/search/v1': (u) => { seenUrl = u.toString(); return []; } });
await livePrice('Portal', LIVE);
ok(seenUrl.includes('key=test-key'), 'the key is passed to ITAD');
ok(!seenUrl.includes('/test-key'), 'and is not interpolated into the path');

globalThis.fetch = realFetch;

console.log('\nCatalog searches return every relevant title, independently of offers');
try {
  const title = "Castlevania: Belmont's Curse";
  const game = { id: 'belmont', title };
  const anniversary = { id: 'anniversary', title: 'Castlevania Anniversary Collection' };
  _clearCache();
  let pricesCalled = 0;
  stubFetch({
    '/games/search/v1': (url) => {
      assert.equal(url.searchParams.get('results'), '50');
      return [
        anniversary, game, { id: 'demo', title: `${title} Demo` },
        { id: 'wrong', title: 'Unrelated game' }, game, { title: 'Malformed game' },
      ];
    },
    '/games/prices/v3': (_, opts) => {
      pricesCalled++;
      const ids = JSON.parse(opts.body);
      return [{ id: 'wrong', deals: PRICES[0].deals },
        ...ids.map((id) => ({ id, deals: id === 'belmont' ? [] : PRICES[0].deals }))];
    },
    '/games/historylow/v1': [],
  });
  const catalog = await liveSearch('Castlevania', LIVE);
  assert.deepEqual(catalog.games.map((g) => g.id), ['anniversary', 'belmont']);
  assert.equal(pricesCalled, 0, 'discovery does not require prices');
  const results = await livePrices(catalog.games, LIVE);
  assert.equal(pricesCalled, 1, 'all catalog prices are fetched in one batch');
  assert.equal(results[1].title, title);
  assert.deepEqual(results[1].deals, [], 'no-price title survives without borrowing unrelated offers');
  assert.equal((await livePrice(title, LIVE)).deals.length, 0);
  assert.equal(pricesCalled, 1, 'ID cache is reused by exact lookup');
  assert.equal(await livePrice('Castlevania', LIVE), null, 'broad query cannot inherit first result prices');

  _clearCache();
  let requestedIds;
  stubFetch({
    '/games/search/v1': [anniversary, game],
    '/games/prices/v3': (_, opts) => { requestedIds = JSON.parse(opts.body); return []; },
    '/games/historylow/v1': [],
  });
  const exact = await livePrice(title.replace("'", '\u2019'), LIVE);
  assert.equal(exact.title, title);
  assert.deepEqual(requestedIds, ['belmont'], 'correct result is selected even when not first');
  for (const term of ["Belmont's", 'Belmont', title]) {
    assert((await liveSearch(term, LIVE)).games.some((g) => g.id === 'belmont'), term);
  }

  _clearCache();
  const countries = [];
  stubFetch({
    '/games/prices/v3': (url) => { countries.push(url.searchParams.get('country')); return []; },
    '/games/historylow/v1': [],
  });
  await livePrices([game], LIVE);
  await livePrices([game], { ...LIVE, country: 'CA' });
  assert.deepEqual(countries, ['US', 'CA'], 'country prices never share cache entries');

  _clearCache();
  stubFetch({ '/games/search/v1': { error: 'not an array' } });
  assert((await liveSearch(title, LIVE)).error, 'malformed catalog surfaces as a failure');
  stubFetch({ '/games/search/v1': [game] });
  assert.equal((await liveSearch(title, LIVE)).games[0].id, 'belmont', 'failed catalog request is retried');

  _clearCache();
  stubFetch({ '/games/prices/v3': new TypeError('Failed to fetch'), '/games/historylow/v1': [] });
  assert((await livePrices([game], LIVE))[0].error, 'price failure is explicit');
  stubFetch({ '/games/prices/v3': [], '/games/historylow/v1': [] });
  assert.equal((await livePrices([game], LIVE))[0].error, undefined, 'price failure is retried');

  assert.equal(await readFile(new URL('../site/match.mjs', import.meta.url), 'utf8'),
    await readFile(new URL('../lib/match.mjs', import.meta.url), 'utf8'),
    'client and snapshot share the exact canonical matching rules');
  ok(true, 'catalog merging, exact identity, no-price entries, batching and retry contracts');
} finally {
  globalThis.fetch = realFetch;
}

if (fails) { console.log(`\n${fails} assertion(s) failed.`); process.exit(1); }
console.log('\nAll live-price assertions passed.');
