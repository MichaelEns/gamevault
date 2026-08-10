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
 * Turn whatever the user pasted into a 64-bit SteamID.
 *
 * Nobody knows their SteamID64 offhand; they know their profile URL. Steam
 * itself hands out two forms of that URL, only one of which contains the id.
 * Accepting all of them removes a step that is easy to get wrong and gives no
 * useful error when you do -- GetOwnedGames just returns nothing.
 *
 * Accepts:
 *   76561197960287930                                  (already an id)
 *   https://steamcommunity.com/profiles/7656119796...  (id form)
 *   https://steamcommunity.com/id/gaben                (vanity form)
 *   gaben                                              (bare vanity name)
 */
export async function toSteamId64(input, key) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('STEAM_ID is not set');

  // A SteamID64 is 17 digits and always starts 765.
  if (/^\d{17}$/.test(raw)) return raw;

  const profiles = raw.match(/steamcommunity\.com\/profiles\/(\d{17})/i);
  if (profiles) return profiles[1];

  const vanityUrl = raw.match(/steamcommunity\.com\/id\/([^/?#\s]+)/i);
  const vanity = vanityUrl ? vanityUrl[1] : raw;

  if (/^\d+$/.test(vanity)) {
    throw new Error(
      `"${raw}" is ${vanity.length} digits; a SteamID64 is 17. That is probably ` +
      'an account ID rather than a SteamID64 - use your profile URL instead.',
    );
  }
  return resolveVanity(vanity, key);
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

  const id64 = await toSteamId64(steamId, key);

  const url =
    `${API}/IPlayerService/GetOwnedGames/v1/?key=${key}&steamid=${id64}` +
    `&include_appinfo=1&include_played_free_games=1&format=json`;
  const data = await cached(`steam:owned:${id64}`, TTL.library, () => req(url));

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
