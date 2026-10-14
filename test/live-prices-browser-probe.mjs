// Opt-in production-network check. No ownership, account access or mock APIs.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

assert(process.env.ITAD_API_KEY, 'ITAD_API_KEY is required for the authenticated browser probe');
const live = { itadKey: process.env.ITAD_API_KEY, country: process.env.COUNTRY || 'US' };
const base = 'https://michaelens.github.io/gamevault/';
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route(base, (route) => route.fulfill({
    contentType: 'text/html', body: '<!DOCTYPE html><title>GameVault live price probe</title>',
  }));
  for (const name of ['live-prices.js', 'match.mjs']) {
    const body = await readFile(new URL(`../site/${name}`, import.meta.url), 'utf8');
    await context.route(base + name, (route) => route.fulfill({ contentType: 'text/javascript', body }));
  }
  const page = await context.newPage();
  const responses = [];
  const failedRequests = [];
  const postTypes = [];
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.hostname === 'api.isthereanydeal.com') {
      responses.push({ path: url.pathname, status: response.status() });
    }
  });
  page.on('requestfailed', (request) => {
    if (new URL(request.url()).hostname === 'api.isthereanydeal.com') {
      failedRequests.push(new URL(request.url()).pathname);
    }
  });
  page.on('request', (request) => {
    if (new URL(request.url()).hostname === 'api.isthereanydeal.com' && request.method() === 'POST') {
      postTypes.push(request.headers()['content-type']);
    }
  });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(async (config) => {
    const { liveSearch, livePrices } = await import('./live-prices.js');
    const title = "Castlevania: Belmont's Curse";
    const queries = [];
    let target;
    for (const term of ['Castlevania', "Belmont's", title]) {
      const found = await liveSearch(term, config);
      if (found.error) return { error: found.error, stage: 'catalog' };
      const game = found.games.find((g) => g.title === title);
      queries.push({ term, matches: found.games.length, found: Boolean(game) });
      if (game) target = game;
    }
    if (!target) return { error: 'Target title absent from authenticated catalog results', queries };
    const targetPrice = (await livePrices([target], config))[0];
    const portal = await liveSearch('Portal 2', config);
    const portalGame = portal.games.find((g) => g.title === 'Portal 2');
    if (!portalGame) return { error: portal.error || 'Portal 2 catalog lookup failed' };
    const price = (await livePrices([portalGame], config))[0];
    return {
      queries,
      target: { error: targetPrice.error, offers: targetPrice.deals.length,
        historyUnavailable: targetPrice.historyUnavailable },
      knownPricedGame: { error: price.error, offers: price.deals.length, hasLow: price.low !== null,
        historyUnavailable: price.historyUnavailable },
    };
  }, live);
  console.log(JSON.stringify({ origin: new URL(base).origin, ...result, responses }));
  assert.equal(result.error, undefined, result.error);
  assert(result.queries.every((q) => q.found), 'target must appear for broad and exact queries');
  assert.equal(result.target.error, undefined, result.target.error);
  assert.equal(result.knownPricedGame.error, undefined, result.knownPricedGame.error);
  assert(result.knownPricedGame.offers > 0, 'a known priced game must return real offers');
  assert.equal(result.knownPricedGame.historyUnavailable, false, 'authenticated history endpoint must succeed');
  assert.equal(result.target.historyUnavailable, false, 'target history endpoint must succeed');
  assert(result.knownPricedGame.hasLow, 'Portal 2 must have a real historical low');
  assert.deepEqual(failedRequests, [], 'no browser-blocked requests');
  assert(responses.length >= 7 && responses.every((r) => r.status === 200),
    `API responses must succeed: ${JSON.stringify(responses)}`);
  assert(postTypes.length >= 4 && postTypes.every((type) => type === 'text/plain;charset=UTF-8'));
  console.log('Authenticated live catalog, prices and historical lows passed in a real browser.');
} finally {
  await browser.close();
}
