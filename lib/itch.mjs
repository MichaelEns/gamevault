import { req } from './http.mjs';
import { cached, TTL } from './cache.mjs';
import { isAddon } from './match.mjs';

/**
 * itch.io -- the only store in this app with a first-class, documented,
 * officially-supported ownership API.
 *
 * Key: https://itch.io/user/settings/api-keys
 */
const API = 'https://api.itch.io';
const LEGACY = 'https://itch.io/api/1';

function needKey(env) {
  if (!env.ITCH_API_KEY) {
    throw new Error(
      'ITCH_API_KEY is not set. Create one at https://itch.io/user/settings/api-keys',
    );
  }
  return env.ITCH_API_KEY;
}

/** Verify the key and return the profile it belongs to. */
export async function whoami(env) {
  const key = needKey(env);
  const data = await req(`${LEGACY}/${key}/me`);
  if (data?.errors) throw new Error(`itch.io rejected the key: ${data.errors.join(', ')}`);
  return data?.user ?? null;
}

/**
 * Everything in your itch.io library, including bundle keys.
 * Paginated: itch returns 50 per page and a lot of people have large
 * bundles (Bundle for Racial Justice was ~1700 items), so we page until
 * exhausted rather than trusting the first response.
 */
export async function ownedGames(env) {
  const key = needKey(env);

  return cached('itch:owned', TTL.library, async () => {
    const out = [];
    for (let page = 1; page <= 60; page++) {
      const data = await req(`${LEGACY}/${key}/my-owned-keys?page=${page}`);
      if (data?.errors) throw new Error(`itch.io: ${data.errors.join(', ')}`);
      const keys = data?.owned_keys ?? [];
      if (!keys.length) break;
      for (const k of keys) {
        const g = k.game;
        if (!g?.title) continue;
        out.push({
          store: 'itch',
          id: String(g.id),
          title: g.title,
          url: g.url ?? null,
          author: g.user?.display_name ?? g.user?.username ?? null,
        });
      }
      if (keys.length < 50) break;
    }
    return out.filter((g) => !isAddon(g.title));
  });
}

/** Search itch.io's catalogue (the key doubles as the search credential). */
export async function search(term, env) {
  const key = needKey(env);
  const data = await cached(`itch:search:${term}`, TTL.search, () =>
    req(`${API}/search/games?query=${encodeURIComponent(term)}`, {
      headers: { Authorization: `Bearer ${key}` },
    }),
  );
  return (data?.games ?? []).filter((g) => !isAddon(g.title)).map((g) => ({
    store: 'itch',
    id: String(g.id),
    title: g.title,
    url: g.url ?? null,
    image: g.cover_url ?? null,
    price: g.min_price === 0
      ? { current: { amount: 0, currency: 'USD' }, original: null, discountPct: 0, isFree: true }
      : {
          current: { amount: (g.min_price ?? 0) / 100, currency: 'USD' },
          original: null,
          discountPct: 0,
          isFree: false,
        },
  }));
}
