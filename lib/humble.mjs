/**
 * Humble Bundle ownership.
 *
 * The reason this matters more than it looks: most Humble purchases are Steam
 * keys, and a REDEEMED key is already visible through the Steam sync. What is
 * invisible everywhere else is an UNREDEEMED one - a game you paid for, own,
 * and cannot see in any library. That is exactly the situation in which you
 * would buy it again, which is the mistake this whole app exists to prevent.
 *
 * So Humble is not just another store here; it is the one source that can
 * answer "you already bought this, you just never redeemed it".
 *
 * Endpoints (verified live):
 *   GET /api/v1/user/order?ajax=true            401 without a session
 *   GET /api/v1/order/{gamekey}?all_tpkds=true  per-order detail
 *   /home/library                               302 -> /login, i.e. cookie auth
 *
 * Authentication is the `_simpleauth_sess` cookie copied from a signed-in
 * browser. Humble's login has bot protection and 2FA, so a script has no
 * business trying to drive it - the same conclusion reached for EA.
 */
import { req, pool } from './http.mjs';
import { cached, TTL } from './cache.mjs';
import { normalizeTitle } from './match.mjs';
import { createHash } from 'node:crypto';

const BASE = 'https://www.humblebundle.com';

export function configured(env) {
  return Boolean(env.HUMBLE_SESSION);
}

/**
 * Cache key tied to the session it came from.
 *
 * A key of just "humble:owned" would serve one account's library to another,
 * and would answer with stale data even when the session had been rejected --
 * turning an authentication failure into silently wrong ownership. Only a
 * fingerprint is used; the cache filename must not contain the cookie.
 */
function cacheKey(env) {
  const fp = createHash('sha256').update(String(env.HUMBLE_SESSION)).digest('hex').slice(0, 12);
  return `humble:owned:${fp}`;
}

function headers(env) {
  // Humble rejects requests that do not look like its own web client.
  return {
    Cookie: `_simpleauth_sess=${env.HUMBLE_SESSION}`,
    Accept: 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    Referer: `${BASE}/home/library`,
  };
}

/** Order keys only; the detail of each order is a separate request. */
export async function orderKeys(env) {
  const data = await req(`${BASE}/api/v1/user/order?ajax=true`, {
    headers: headers(env),
    retries: 1,
  }).catch((e) => {
    if (e.status === 401) {
      throw new Error(
        'Humble rejected the session (401). The HUMBLE_SESSION cookie has expired ' +
        'or was copied incorrectly. Run "npm run humble-auth" again to refresh it.',
      );
    }
    throw e;
  });
  if (!Array.isArray(data)) {
    throw new Error('Humble returned an unexpected order list shape');
  }
  return data.map((o) => o?.gamekey).filter(Boolean);
}

/**
 * Is this key still sitting unredeemed?
 *
 * Humble marks a redeemed key by filling in `redeemed_key_val`. Treating a
 * missing field as "redeemed" would hide exactly the purchases worth
 * surfacing, so anything ambiguous is reported as unredeemed - the direction
 * that prompts you to check rather than the one that lets you rebuy.
 */
function isUnredeemed(tpk) {
  if (tpk?.redeemed_key_val) return false;
  if (tpk?.is_gift) return false;          // given away, not yours
  return true;
}

const STEAM_KEY = /steam/i;

/** Everything in one order: third-party keys and DRM-free products alike. */
async function orderGames(env, gamekey) {
  const order = await req(`${BASE}/api/v1/order/${encodeURIComponent(gamekey)}?all_tpkds=true`, {
    headers: headers(env),
    retries: 1,
  });

  const bundle = order?.product?.human_name ?? order?.product?.machine_name ?? null;
  const out = [];

  // Third-party keys: Steam, GOG, Origin, Uplay etc.
  for (const tpk of order?.tpkds ?? []) {
    const title = (tpk?.human_name ?? '').trim();
    if (!title) continue;
    const unredeemed = isUnredeemed(tpk);
    out.push({
      store: 'humble',
      id: String(tpk?.machine_name ?? title),
      title,
      bundle,
      keyType: tpk?.key_type ?? tpk?.key_type_human_name ?? null,
      unredeemed,
      // A redeemed Steam key is already visible via the Steam sync; an
      // unredeemed one is visible nowhere else at all.
      alsoOnSteam: !unredeemed && STEAM_KEY.test(tpk?.key_type ?? ''),
      url: `${BASE}/downloads?key=${encodeURIComponent(gamekey)}`,
    });
  }

  // DRM-free products, which are owned outright with no key involved.
  for (const sub of order?.subproducts ?? []) {
    const title = (sub?.human_name ?? '').trim();
    if (!title) continue;
    const downloads = sub?.downloads ?? [];
    if (!downloads.length) continue;       // soundtracks/books have none
    out.push({
      store: 'humble',
      id: String(sub?.machine_name ?? title),
      title,
      bundle,
      keyType: 'drm-free',
      unredeemed: false,
      alsoOnSteam: false,
      url: sub?.url ?? `${BASE}/downloads?key=${encodeURIComponent(gamekey)}`,
    });
  }

  return out;
}

export async function ownedGames(env, { fresh = false } = {}) {
  if (!configured(env)) throw new Error('HUMBLE_SESSION is not set');

  const run = async () => {
    const keys = await orderKeys(env);
    if (!keys.length) return [];

    // One request per order, and a heavy Humble account has hundreds. Four at
    // a time is brisk without hammering a service that is doing us a favour.
    const results = await pool(keys, 4, (k) => orderGames(env, k));

    const failures = results.filter((r) => r?.__error).length;
    const games = results.filter((r) => Array.isArray(r)).flat();

    if (failures && !games.length) {
      throw new Error(`All ${failures} Humble order requests failed`);
    }

    // De-duplicate: bundles overlap constantly, and the same game appears in
    // several. Keep the UNREDEEMED copy when there is a choice, because that
    // is the one carrying information you do not have anywhere else.
    const best = new Map();
    for (const g of games) {
      const k = normalizeTitle(g.title);
      if (!k) continue;
      const prev = best.get(k);
      if (!prev || (prev.unredeemed === false && g.unredeemed === true)) best.set(k, g);
    }

    const list = [...best.values()];
    if (failures) list.partial = failures;
    return list;
  };

  // The auth tool must actually reach Humble to prove a cookie works; a cached
  // answer would "verify" a cookie that had already expired.
  return fresh ? run() : cached(cacheKey(env), TTL.library, run);
}

/** Used by the auth tool to confirm a cookie before it is stored. */
export async function summary(env) {
  const games = await ownedGames(env, { fresh: true });
  return {
    total: games.length,
    unredeemed: games.filter((g) => g.unredeemed).length,
    drmFree: games.filter((g) => g.keyType === 'drm-free').length,
  };
}
