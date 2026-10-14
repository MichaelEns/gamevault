// Live catalog search and prices, independent of snapshot coverage.
//
// Why this exists: the snapshot prices a fixed budget of titles, and pricing
// games you already own answers a question nobody asks. The interesting case -
// "should I buy this?" - is by definition about something absent from your
// library, so it will usually be absent from the snapshot too.
//
// This is deliberately a PROGRESSIVE ENHANCEMENT. ITAD's error responses carry
// no Access-Control-Allow-Origin header, so a browser may refuse the call
// outright; its preflight does answer ACAO:*, so a successful response may
// well be allowed. Rather than guess, we try, and fall back to storefront
// search links when the browser blocks us. Either way the card is useful.

import { normalizeTitle, isRelevant, isAddon } from './match.mjs';

const BASE = 'https://api.isthereanydeal.com';

// Session-scoped so a repeated search is instant and we never hammer the API,
// but a new tab picks up genuinely fresh prices.
const memo = new Map();
const searches = new Map();

/** Storefront search URLs — the fallback that always works, no API needed. */
export function storeLinks(title) {
  const q = encodeURIComponent(title);
  return [
    { shop: 'Steam', url: `https://store.steampowered.com/search/?term=${q}` },
    { shop: 'GOG', url: `https://www.gog.com/en/games?query=${q}` },
    { shop: 'Epic', url: `https://store.epicgames.com/en-US/browse?q=${q}` },
    { shop: 'Xbox', url: `https://www.xbox.com/en-US/Search/Results?q=${q}` },
    { shop: 'Humble', url: `https://www.humblebundle.com/store/search?search=${q}` },
    { shop: 'IsThereAnyDeal', url: `https://isthereanydeal.com/search/?q=${q}` },
  ];
}

async function itad(path, key, { method = 'GET', body = null, params = {} } = {}) {
  const qs = new URLSearchParams({ key, ...params });
  const res = await fetch(`${BASE}${path}?${qs}`, {
    method,
    // ITAD accepts JSON bodies but its preflight does not allow content-type.
    // text/plain is CORS-safelisted, so the authenticated POST can reach it.
    headers: body ? { 'content-type': 'text/plain;charset=UTF-8' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`ITAD ${path} ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(`ITAD ${path} returned an invalid response`);
  return data;
}

/** Catalog results survive missing prices; failures remain visible to the UI. */
export async function liveSearch(title, live) {
  if (!live?.itadKey || !normalizeTitle(title)) {
    return { games: [], available: false, error: null };
  }
  const cacheKey = `${live.itadKey}\0${normalizeTitle(title)}`;
  if (searches.has(cacheKey)) return searches.get(cacheKey);

  const pending = (async () => {
    try {
      const found = await itad('/games/search/v1', live.itadKey, {
        params: { title, results: '50' },
      });
      const seen = new Set();
      const games = found.filter((game) => {
        if (!game?.id || typeof game.title !== 'string' || seen.has(game.id)) return false;
        if (game.type === 'dlc' || isAddon(game.title) || !isRelevant(title, game.title)) return false;
        seen.add(game.id);
        return true;
      }).map(({ id, title }) => ({ id, title }));
      return { games, available: true, error: null };
    } catch {
      return { games: [], available: true,
        error: 'Live catalog search failed. The service may be unavailable or blocked by the browser.' };
    }
  })().then((result) => {
    if (result.error && searches.get(cacheKey) === pending) searches.delete(cacheKey);
    return result;
  });
  searches.set(cacheKey, pending);
  return pending;
}

/**
 * Price a known catalog ID, or an exact canonical title match.
 *
 * A broad query must never borrow the first game's prices. Empty deals are
 * a valid catalog result, not a failed search or a zero-dollar offer.
 */
export async function livePrice(title, live, game = null) {
  if (!live?.itadKey || !title) return null;
  if (!game) {
    const found = await liveSearch(title, live);
    game = found.games.find((g) => normalizeTitle(g.title) === normalizeTitle(title));
  }
  if (!game?.id || normalizeTitle(game.title) !== normalizeTitle(title)) return null;
  return (await livePrices([game], live))[0];
}

/** Batch visible catalog entries instead of making two requests per card. */
export async function livePrices(games, live) {
  if (!live?.itadKey || !games.length) return [];
  const country = live.country || 'US';
  const key = (game) => `${live.itadKey}\0${country}\0${game.id}`;
  const missing = [...new Map(games.filter((g) => !memo.has(key(g))).map((g) => [g.id, g])).values()];

  if (missing.length) {
    const pending = (async () => {
      const [pricesRes, lowRes] = await Promise.all([
        itad('/games/prices/v3', live.itadKey, {
          method: 'POST',
          body: missing.map((g) => g.id),
          params: { country, capacity: '12', nondeals: 'true', vouchers: 'true' },
        }),
        itad('/games/historylow/v1', live.itadKey, {
          method: 'POST', body: missing.map((g) => g.id), params: { country },
        }).catch(() => null),
      ]);

      return missing.map((game) => {
        const entry = pricesRes.find((e) => e.id === game.id);
        const deals = (entry?.deals ?? []).map((d) => ({
          shop: d.shop?.name ?? 'unknown',
          amount: d.price?.amount ?? null,
          regular: d.regular?.amount ?? null,
          currency: d.price?.currency ?? 'USD',
          cut: d.cut ?? 0,
          url: d.url ?? null,
        })).filter((d) => typeof d.amount === 'number' && Number.isFinite(d.amount) && d.amount >= 0)
          .sort((a, b) => a.amount - b.amount);

        const lowEntry = lowRes?.find((e) => e.id === game.id);
        const low = typeof lowEntry?.low?.price?.amount === 'number' && Number.isFinite(lowEntry.low.price.amount)
          ? {
              amount: lowEntry.low.price.amount,
              currency: lowEntry.low.price.currency,
              shop: lowEntry.low.shop?.name ?? null,
            }
          : null;

        return { title: game.title, deals, low, live: true, historyUnavailable: lowRes === null };
      });
    })().catch(() => missing.map((game) => ({
      title: game.title, deals: [], low: null, live: true,
      error: 'Live price lookup failed. The service may be unavailable or blocked by the browser.',
    })));

    missing.forEach((game, i) => {
      const entry = pending.then((results) => {
        const result = results[i];
        if ((result.error || result.historyUnavailable) && memo.get(key(game)) === entry) memo.delete(key(game));
        return result;
      });
      memo.set(key(game), entry);
    });
  }
  return Promise.all(games.map((game) => memo.get(key(game))));
}

/** Reset between tests. */
export function _clearCache() { memo.clear(); searches.clear(); }
