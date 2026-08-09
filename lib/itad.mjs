import { req } from './http.mjs';
import { cached, TTL } from './cache.mjs';

/**
 * IsThereAnyDeal -- the price + deal engine.
 *
 * Deliberately the primary pricing source rather than scraping each
 * storefront. Reasons:
 *   - Epic's storefront GraphQL sits behind a Cloudflare bot challenge and
 *     cannot be relied on from a script.
 *   - Steam's storefront API is rate limited to roughly 200 req / 5 min.
 *   - "Is this a good deal?" needs the HISTORICAL LOW, which no storefront
 *     exposes -- only an aggregator tracks it.
 *
 * One free key (https://isthereanydeal.com/apps/my/) covers Steam, Epic,
 * GOG, Ubisoft, EA, Fanatical, GreenManGaming, Humble and ~40 others.
 */
const BASE = 'https://api.isthereanydeal.com';

export function hasKey(env) {
  return Boolean(env.ITAD_API_KEY);
}

function needKey(env) {
  if (!env.ITAD_API_KEY) {
    throw new Error(
      'ITAD_API_KEY is not set. Get a free key at https://isthereanydeal.com/apps/my/ ' +
      'and add it to .env -- without it, prices are Steam-only and there are no historical lows.',
    );
  }
  return env.ITAD_API_KEY;
}

/** Search ITAD's game index. */
export async function search(term, env, limit = 20) {
  const key = needKey(env);
  const url = `${BASE}/games/search/v1?key=${key}&title=${encodeURIComponent(term)}&results=${limit}`;
  const data = await cached(`itad:search:${term}:${limit}`, TTL.search, () => req(url));
  return (Array.isArray(data) ? data : []).map((g) => ({
    id: g.id,
    slug: g.slug,
    title: g.title,
    type: g.type,
  }));
}

/** Resolve a single title to an ITAD game id. */
export async function lookup(title, env) {
  const key = needKey(env);
  const url = `${BASE}/games/lookup/v1?key=${key}&title=${encodeURIComponent(title)}`;
  const data = await cached(`itad:lookup:${title}`, TTL.search, () => req(url));
  return data?.found ? data.game : null;
}

/** Current deals across every tracked shop, for a set of ITAD game ids. */
export async function prices(ids, env, country = 'US') {
  if (!ids.length) return {};
  const key = needKey(env);
  const url = `${BASE}/games/prices/v3?key=${key}&country=${country}&capacity=12&nondeals=true&vouchers=true`;
  const data = await cached(`itad:prices:${country}:${ids.join(',')}`, TTL.price, () =>
    req(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ids),
    }),
  );

  const out = {};
  for (const entry of data ?? []) {
    out[entry.id] = (entry.deals ?? []).map((d) => ({
      shop: d.shop?.name ?? 'unknown',
      shopId: d.shop?.id ?? null,
      price: d.price ? { amount: d.price.amount, currency: d.price.currency } : null,
      regular: d.regular ? { amount: d.regular.amount, currency: d.regular.currency } : null,
      discountPct: d.cut ?? 0,
      url: d.url ?? null,
      drm: (d.drm ?? []).map((x) => x.name),
      expiry: d.expiry ?? null,
    }));
  }
  return out;
}

/** All-time historical low per game id -- the core "good deal" reference. */
export async function historyLow(ids, env, country = 'US') {
  if (!ids.length) return {};
  const key = needKey(env);
  const url = `${BASE}/games/historylow/v1?key=${key}&country=${country}`;
  const data = await cached(`itad:low:${country}:${ids.join(',')}`, TTL.historyLow, () =>
    req(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ids),
    }),
  );

  const out = {};
  for (const entry of data ?? []) {
    out[entry.id] = entry.low
      ? {
          amount: entry.low.amount,
          currency: entry.low.currency,
          shop: entry.low.shop?.name ?? null,
          when: entry.low.timestamp ?? null,
        }
      : null;
  }
  return out;
}
