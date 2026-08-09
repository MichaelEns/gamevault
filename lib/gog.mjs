import { req } from './http.mjs';
import { cached, TTL } from './cache.mjs';
import { isAddon } from './match.mjs';

/** GOG storefront search. Public, no auth. */
const CATALOG = 'https://catalog.gog.com/v1/catalog';

export async function search(term, country = 'US', currency = 'USD') {
  const url =
    `${CATALOG}?query=like:${encodeURIComponent(term)}&limit=20` +
    `&countryCode=${country}&currencyCode=${currency}&locale=en-US` +
    `&productType=in:game,pack&order=desc:score`;

  const data = await cached(`gog:search:${country}:${term}`, TTL.search, () => req(url));

  return (data?.products ?? [])
    .filter((p) => !isAddon(p.title ?? ''))
    .map((p) => {
      const pr = p.price ?? {};
      const num = (v) => {
        if (v === null || v === undefined) return null;
        const n = Number(String(v).replace(/[^0-9.]/g, ''));
        return Number.isFinite(n) ? n : null;
      };
      const final = num(pr.final ?? pr.finalMoney?.amount);
      const base = num(pr.base ?? pr.baseMoney?.amount);
      return {
        store: 'gog',
        id: String(p.id),
        title: p.title,
        url: p.storeLink ?? (p.slug ? `https://www.gog.com/en/game/${p.slug}` : null),
        image: p.coverHorizontal ?? null,
        price:
          final === null
            ? null
            : {
                current: { amount: final, currency },
                original: base === null ? null : { amount: base, currency },
                discountPct: base && base > 0 ? Math.round((1 - final / base) * 100) : 0,
                isFree: final === 0,
              },
      };
    });
}
