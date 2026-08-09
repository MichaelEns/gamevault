import { req, pool } from './http.mjs';
import { cached, TTL } from './cache.mjs';
import { isAddon } from './match.mjs';

const STORE = 'https://store.steampowered.com';
const API = 'https://api.steampowered.com';

const money = (cents, currency) =>
  cents === null || cents === undefined ? null : { amount: cents / 100, currency: currency || 'USD' };

/** Search the Steam storefront. No auth required. */
export async function search(term, cc = 'US') {
  const url = `${STORE}/api/storesearch/?term=${encodeURIComponent(term)}&l=english&cc=${cc}`;
  const data = await cached(`steam:search:${cc}:${term}`, TTL.search, () => req(url));
  return (data.items ?? [])
    .filter((it) => !isAddon(it.name))
    .map((it) => ({
      store: 'steam',
      id: String(it.id),
      title: it.name,
      url: `${STORE}/app/${it.id}/`,
      image: it.tiny_image ?? null,
      price: it.price
        ? {
            current: money(it.price.final, it.price.currency),
            original: money(it.price.initial, it.price.currency),
            discountPct:
              it.price.initial > 0
                ? Math.round((1 - it.price.final / it.price.initial) * 100)
                : 0,
            isFree: false,
          }
        : { current: null, original: null, discountPct: 0, isFree: true },
    }));
}

/** Authoritative price for one appid. */
export async function price(appid, cc = 'US') {
  const url = `${STORE}/api/appdetails?appids=${appid}&cc=${cc}&filters=price_overview,basic`;
  const data = await cached(`steam:price:${cc}:${appid}`, TTL.price, () => req(url));
  const rec = data?.[String(appid)];
  if (!rec?.success) return null;
  const d = rec.data;
  if (d.is_free) return { current: { amount: 0, currency: 'USD' }, original: null, discountPct: 0, isFree: true };
  const p = d.price_overview;
  if (!p) return null;
  return {
    current: money(p.final, p.currency),
    original: money(p.initial, p.currency),
    discountPct: p.discount_percent ?? 0,
    isFree: false,
  };
}

/** Resolve a vanity URL name (e.g. /id/gaben) to a 64-bit SteamID. */
export async function resolveVanity(vanity, key) {
  const url = `${API}/ISteamUser/ResolveVanityURL/v1/?key=${key}&vanityurl=${encodeURIComponent(vanity)}`;
  const data = await req(url);
  if (data?.response?.success !== 1) {
    throw new Error(`Steam could not resolve vanity name "${vanity}"`);
  }
  return data.response.steamid;
}

/**
 * Owned games.
 *
 * Requires a Steam Web API key AND the profile's "Game details" privacy
 * set to Public -- Steam returns an empty list rather than an error when
 * it is private, so we surface that as an explicit failure instead of
 * silently reporting a library of zero games.
 */
export async function ownedGames({ key, steamId }) {
  if (!key) throw new Error('STEAM_API_KEY is not set');
  if (!steamId) throw new Error('STEAM_ID is not set');

  const url =
    `${API}/IPlayerService/GetOwnedGames/v1/?key=${key}&steamid=${steamId}` +
    `&include_appinfo=1&include_played_free_games=1&format=json`;
  const data = await cached(`steam:owned:${steamId}`, TTL.library, () => req(url));

  const games = data?.response?.games;
  if (!Array.isArray(games)) {
    throw new Error(
      'Steam returned no game list. This almost always means the profile\'s ' +
      '"Game details" privacy is not set to Public (Steam > Profile > Edit > Privacy).',
    );
  }
  return games.map((g) => ({
    store: 'steam',
    id: String(g.appid),
    title: g.name,
    playtimeMinutes: g.playtime_forever ?? 0,
    url: `${STORE}/app/${g.appid}/`,
  }));
}

/** Attach live prices to a handful of search hits, politely. */
export async function enrichPrices(items, cc = 'US') {
  return pool(items, 4, async (it) => {
    if (it.price?.current) return it;
    const p = await price(it.id, cc).catch(() => null);
    return p ? { ...it, price: p } : it;
  });
}
