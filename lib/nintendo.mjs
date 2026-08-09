import { req } from './http.mjs';
import { cached, TTL } from './cache.mjs';
import { isAddon } from './match.mjs';

/**
 * Nintendo eShop.
 *
 * Search and prices are fully public -- the US storefront is Algolia-backed
 * and the credentials below are the ones the store page ships to every
 * browser. Prices come back inline on the search hit, so a normal lookup is
 * one request.
 *
 * OWNERSHIP IS NOT AVAILABLE. Nintendo publishes no purchase-history API,
 * and the only unofficial route runs through the Switch Online mobile app
 * auth flow, which needs a third-party token-minting service to complete.
 * That is not something to route a personal Nintendo account through, so
 * eShop ownership is handled by the manual library instead (lib/manual.mjs).
 *
 * Region matters and is easy to get wrong: nsuids are region-specific. An
 * nsuid from the European search returns `not_found` from the US price API
 * (verified), so the US index is used for US pricing rather than mapping
 * between regions.
 */
const ALGOLIA_APP = 'U3B6GR4UA3';
const ALGOLIA_KEY = 'a29c6927638bfd8cee23993e51e721c9';
const PRICE_API = 'https://api.ec.nintendo.com/v1/price';

const INDEX_FOR = {
  US: 'store_game_en_us',
  CA: 'store_game_en_us',
};

export async function search(term, country = 'US') {
  const index = INDEX_FOR[country] ?? INDEX_FOR.US;
  const url = `https://${ALGOLIA_APP.toLowerCase()}-dsn.algolia.net/1/indexes/${index}/query`;

  const data = await cached(`nintendo:search:${index}:${term}`, TTL.search, () =>
    req(url, {
      method: 'POST',
      headers: {
        'X-Algolia-Application-Id': ALGOLIA_APP,
        'X-Algolia-API-Key': ALGOLIA_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ params: `query=${encodeURIComponent(term)}&hitsPerPage=20` }),
    }),
  );

  return (data?.hits ?? [])
    .filter((h) => h.title && !isAddon(h.title))
    .map((h) => {
      const p = h.price ?? {};
      const final = typeof p.finalPrice === 'number' ? p.finalPrice : null;
      const reg = typeof p.regPrice === 'number' ? p.regPrice : null;
      return {
        store: 'nintendo',
        id: String(h.nsuid ?? h.objectID ?? ''),
        title: h.title,
        platform: h.platform ?? null,
        url: h.url ? `https://www.nintendo.com${h.url}` : null,
        image: h.productImage ?? null,
        price:
          final === null
            ? null
            : {
                current: { amount: final, currency: 'USD' },
                original: reg === null ? null : { amount: reg, currency: 'USD' },
                discountPct:
                  reg && reg > 0 && final < reg ? Math.round((1 - final / reg) * 100) : 0,
                isFree: final === 0,
              },
      };
    });
}

/**
 * Direct price lookup by nsuid. Not needed for search (prices are inline)
 * but useful for re-checking a specific title at sale time.
 */
export async function priceByNsuid(nsuids, country = 'US') {
  const ids = [].concat(nsuids).filter(Boolean);
  if (!ids.length) return {};
  const url = `${PRICE_API}?country=${country}&lang=en&ids=${ids.join(',')}`;
  const data = await cached(`nintendo:price:${country}:${ids.join(',')}`, TTL.price, () => req(url));

  const out = {};
  for (const p of data?.prices ?? []) {
    if (p.sales_status === 'not_found') continue;
    const num = (v) => (v === undefined || v === null ? null : Number(String(v).replace(/[^0-9.]/g, '')));
    const reg = num(p.regular_price?.raw_value ?? p.regular_price?.amount);
    const disc = num(p.discount_price?.raw_value ?? p.discount_price?.amount);
    const final = disc ?? reg;
    out[String(p.title_id)] = {
      current: final === null ? null : { amount: final, currency: p.regular_price?.currency ?? 'USD' },
      original: reg === null ? null : { amount: reg, currency: p.regular_price?.currency ?? 'USD' },
      discountPct: reg && disc && reg > 0 ? Math.round((1 - disc / reg) * 100) : 0,
      isFree: final === 0,
      salesStatus: p.sales_status,
    };
  }
  return out;
}
