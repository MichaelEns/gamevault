// Live, on-demand price lookup for games that are not in the snapshot.
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

const BASE = 'https://api.isthereanydeal.com';

// Session-scoped so a repeated search is instant and we never hammer the API,
// but a new tab picks up genuinely fresh prices.
const memo = new Map();

/** Storefront search URLs — the fallback that always works, no API needed. */
export function storeLinks(title) {
  const q = encodeURIComponent(title);
  return [
    { shop: 'Steam', url: `https://store.steampowered.com/search/?term=${q}` },
    { shop: 'GOG', url: `https://www.gog.com/en/games?query=${q}` },
    { shop: 'Epic', url: `https://store.epicgames.com/en-US/browse?q=${q}` },
    { shop: 'Humble', url: `https://www.humblebundle.com/store/search?search=${q}` },
    { shop: 'IsThereAnyDeal', url: `https://isthereanydeal.com/search/?q=${q}` },
  ];
}

async function itad(path, key, { method = 'GET', body = null, params = {} } = {}) {
  const qs = new URLSearchParams({ key, ...params });
  const res = await fetch(`${BASE}${path}?${qs}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`ITAD ${path} ${res.status}`);
  return res.json();
}

/**
 * Look up current deals and the all-time low for a title.
 *
 * Resolves to null when live lookup is unavailable (no key, CORS refusal,
 * nothing found) so callers can fall back without special-casing errors.
 */
export async function livePrice(title, live) {
  if (!live?.itadKey || !title) return null;

  const cacheKey = title.toLowerCase();
  if (memo.has(cacheKey)) return memo.get(cacheKey);

  const pending = (async () => {
    const country = live.country || 'US';

    const found = await itad('/games/search/v1', live.itadKey, {
      params: { title, results: '5' },
    });
    const game = Array.isArray(found) ? found[0] : found?.[0];
    if (!game?.id) return null;

    // Prices and the historical low are separate endpoints; one without the
    // other cannot answer "is this actually a good price", so fetch both and
    // tolerate the low failing on its own.
    const [pricesRes, lowRes] = await Promise.all([
      itad('/games/prices/v3', live.itadKey, {
        method: 'POST',
        body: [game.id],
        params: { country, capacity: '12', nondeals: 'true', vouchers: 'true' },
      }),
      itad('/games/historylow/v1', live.itadKey, {
        method: 'POST', body: [game.id], params: { country },
      }).catch(() => null),
    ]);

    const entry = pricesRes?.find?.((e) => e.id === game.id) ?? pricesRes?.[0];
    const deals = (entry?.deals ?? []).map((d) => ({
      shop: d.shop?.name ?? 'unknown',
      amount: d.price?.amount ?? null,
      regular: d.regular?.amount ?? null,
      currency: d.price?.currency ?? 'USD',
      cut: d.cut ?? 0,
      url: d.url ?? null,
    })).filter((d) => d.amount !== null)
      .sort((a, b) => a.amount - b.amount);

    const lowEntry = lowRes?.find?.((e) => e.id === game.id) ?? lowRes?.[0];
    const low = lowEntry?.low
      ? {
          amount: lowEntry.low.amount,
          currency: lowEntry.low.currency,
          shop: lowEntry.low.shop?.name ?? null,
        }
      : null;

    if (!deals.length) return null;
    return { title: game.title ?? title, deals, low, live: true };
  })().catch(() => null)   // CORS refusal, network, or malformed response.
    .then((result) => {
      // Only successes are worth remembering. Caching a null would let one
      // dropped request hide a game's prices for the rest of the session, and
      // the retry costs nothing because the user has to search again anyway.
      if (result === null) memo.delete(cacheKey);
      return result;
    });

  memo.set(cacheKey, pending);
  return pending;
}

/** Reset between tests. */
export function _clearCache() { memo.clear(); }
