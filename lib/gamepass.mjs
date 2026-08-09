import { req, pool } from './http.mjs';
import { cached, TTL } from './cache.mjs';
import { normalizeTitle } from './match.mjs';

/**
 * Subscription catalogs (Game Pass and EA Play).
 *
 * "Do I have access?" for a subscription is a CATALOG question, not an
 * account question -- if the game is in the roster for your tier, you can
 * play it. That means this whole provider needs no authentication at all.
 *
 * EA Play rides the same endpoint because it is bundled into Game Pass
 * Ultimate.
 */
const SIGL = 'https://catalog.gamepass.com/sigls/v2';
const DISPLAY = 'https://displaycatalog.mp.microsoft.com/v7.0/products';

export const COLLECTIONS = {
  pc:      { id: 'fdd9e2a7-0fee-49f6-ad69-4354098401ff', label: 'PC Game Pass' },
  console: { id: 'f6f1f99f-9b49-4ccd-b3bf-4d9767a77f5e', label: 'Console Game Pass' },
  cloud:   { id: '29a81209-df6f-41fd-a528-2ae6b91f719c', label: 'Xbox Cloud Gaming' },
  eaplay:  { id: 'b8900d09-a491-44cc-916e-32b5acae621b', label: 'EA Play' },
};

/**
 * Which tiers a subscription plan actually grants.
 * Cloud gaming and EA Play both ride along with Ultimate, which is why a
 * plan maps to several collections.
 */
export const PLANS = {
  ultimate:    { label: 'Game Pass Ultimate', grants: ['pc', 'console', 'cloud', 'eaplay'] },
  pc:          { label: 'PC Game Pass',       grants: ['pc', 'eaplay'] },
  console:     { label: 'Console Game Pass',  grants: ['console'] },
  eaplay:      { label: 'EA Play (standalone)', grants: ['eaplay'] },
};

/**
 * Resolve the collections a user can actually play from.
 *
 * Defaults to ALL collections when unset, which matches the old behaviour,
 * but that default is generous: Cyberpunk 2077, for example, is on Console
 * Game Pass and not PC. Telling a PC-only subscriber it is "included" would
 * make them skip a purchase for a game they cannot launch -- the same
 * expensive direction as a false ownership claim. Set SUBSCRIPTIONS to fix.
 */
export function entitledCollections(env) {
  const raw = String(env?.SUBSCRIPTIONS ?? '').trim();
  if (!raw) return { keys: Object.keys(COLLECTIONS), assumed: true };

  const keys = new Set();
  for (const token of raw.split(/[,\s]+/).filter(Boolean)) {
    const t = token.toLowerCase();
    if (t === 'none') return { keys: [], assumed: false };
    if (PLANS[t]) PLANS[t].grants.forEach((k) => keys.add(k));
    else if (COLLECTIONS[t]) keys.add(t);
  }
  return { keys: [...keys], assumed: false };
}

async function productIds(siglId, market) {
  const url = `${SIGL}?id=${siglId}&language=en-us&market=${market}`;
  const arr = await req(url);
  return (Array.isArray(arr) ? arr : []).map((x) => x.id).filter(Boolean);
}

async function titlesFor(ids, market) {
  // displaycatalog rejects very long bigIds lists; chunk conservatively.
  const chunks = [];
  for (let i = 0; i < ids.length; i += 20) chunks.push(ids.slice(i, i + 20));

  const results = await pool(chunks, 3, async (chunk) => {
    const url =
      `${DISPLAY}?bigIds=${chunk.join(',')}&market=${market}` +
      `&languages=en-us&MS-CV=DGU1mcuYo0WMMp+F.1`;
    const data = await req(url);
    return (data?.Products ?? []).map((p) => {
      const lp = p.LocalizedProperties?.[0] ?? {};
      return {
        productId: p.ProductId,
        title: lp.ProductTitle ?? '',
        publisher: lp.PublisherName ?? null,
      };
    });
  });

  return results.flat().filter((x) => x && x.title && !x.__error);
}

/** Full roster for one collection, title-normalised for lookup. */
export async function collection(which, market = 'US') {
  const meta = COLLECTIONS[which];
  if (!meta) throw new Error(`Unknown subscription collection: ${which}`);

  return cached(`gamepass:${which}:${market}`, TTL.catalog, async () => {
    const ids = await productIds(meta.id, market);
    const items = await titlesFor(ids, market);
    return {
      key: which,
      label: meta.label,
      count: items.length,
      games: items.map((g) => ({ ...g, norm: normalizeTitle(g.title) })),
    };
  });
}

/** All three rosters at once. */
export async function allCollections(market = 'US') {
  const keys = Object.keys(COLLECTIONS);
  const loaded = await pool(keys, 3, (k) => collection(k, market));
  const out = {};
  keys.forEach((k, i) => {
    if (loaded[i] && !loaded[i].__error) out[k] = loaded[i];
  });
  return out;
}

/**
 * Which subscriptions include this title.
 *
 * Uses exact normalised-title equality: a fuzzy hit here would claim you
 * have free access to something you would actually have to buy.
 *
 * Each hit carries `entitled` — whether YOUR plan covers that collection.
 * Un-entitled hits are still returned (it is useful to know a game is on
 * Console Game Pass) but must not drive an "included" verdict.
 */
export function findAccess(title, collections, entitledKeys = null) {
  const want = normalizeTitle(title);
  const hits = [];
  for (const [key, coll] of Object.entries(collections ?? {})) {
    const match = coll.games?.find((g) => g.norm === want);
    if (match) {
      hits.push({
        service: key,
        label: coll.label,
        title: match.title,
        entitled: entitledKeys ? entitledKeys.includes(key) : true,
      });
    }
  }
  return hits;
}
