/**
 * EA (formerly Origin) ownership.
 *
 * Origin shut down and its entitlements API went with it:
 * api1.origin.com/ecommerce2/... now returns 404 "Origin has shut down".
 * Libraries were not lost, though - they moved to the EA app on the same EA
 * account, and EA's newer "Juno" aggregation layer still serves them.
 *
 * Two things make this work:
 *   1. The legacy Origin web client id (ORIGIN_JS_SDK) is still accepted by
 *      accounts.ea.com, so a browser session can be exchanged for a token.
 *      Verified: with no session it answers 200 {"error":"login_required"},
 *      i.e. the client is valid and only the session is missing.
 *   2. service-aggregation-layer.juno.ea.com/graphql answers 401
 *      {"code":"UNAUTHENTICATED"} without a token - live, and token-gated.
 *
 * Endpoint sequence follows lutris/lutris:lutris/services/ea_app.py, which is
 * maintained and uses this same path.
 *
 * There is no EA equivalent of `legendary` or `nile`, so authentication is a
 * cookie the user copies once: EA's login has bot protection that a script
 * should not be trying to defeat.
 */
import { req } from './http.mjs';
import { cached, TTL } from './cache.mjs';
import { normalizeTitle } from './match.mjs';

const AUTH = 'https://accounts.ea.com/connect/auth';
const JUNO = 'https://service-aggregation-layer.juno.ea.com/graphql';
const CLIENT_ID = 'ORIGIN_JS_SDK';

export function configured(env) {
  return Boolean(env.EA_REMID);
}

/**
 * Exchange the browser session cookie for a bearer token.
 *
 * Memoised for the life of the process. EA will not issue a second token from
 * the same session in quick succession - the follow-up answers
 * login_required - so calling this twice made the first call succeed and the
 * second fail, which looked exactly like an expired cookie. It was not: the
 * first call had already proved the cookie was good.
 *
 * `remid` is the long-lived "remember me" cookie, which is why it is the one
 * worth storing; `sid` is a short session cookie and is optional.
 */
let tokenCache = null;

/**
 * Cookies EA has handed back during this process.
 *
 * `remid` is a remember-me credential whose job is to mint a session cookie
 * (`sid`); EA's own clients keep a cookie jar and send everything back. Sending
 * only remid and discarding the response cookies means each call asks EA to
 * bootstrap a fresh session, which is the most likely reason a first call
 * succeeds and later ones are refused.
 *
 * Kept as a jar rather than a single value because guessing which one cookie
 * mattered has already been wrong twice.
 */
const jar = new Map();

/** Everything EA sent back, for diagnosis when a sign-in fails. */
export let lastExchange = null;

function cookieHeader(env) {
  const out = new Map();
  if (env.EA_REMID) out.set('remid', env.EA_REMID);
  if (env.EA_SID) out.set('sid', env.EA_SID);
  // Anything EA issued during this run wins over what was passed in.
  for (const [k, v] of jar) out.set(k, v);
  return [...out].map(([k, v]) => `${k}=${v}`).join('; ');
}

export async function accessToken(env, { fresh = false } = {}) {
  if (!fresh && tokenCache && tokenCache.remid === env.EA_REMID && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }

  const url = `${AUTH}?client_id=${CLIENT_ID}&response_type=token` +
              `&redirect_uri=nucleus%3Arest&prompt=none&release_type=prod`;

  // A direct fetch rather than req(), because the Set-Cookie headers matter
  // here and the shared helper only returns a parsed body.
  const res = await fetch(url, {
    headers: {
      Cookie: cookieHeader(env),
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                    '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Accept: 'application/json',
    },
  }).catch((e) => { throw new Error(`Could not reach accounts.ea.com: ${e.message}`); });

  // Store every cookie before anything can throw, so a session cookie is not
  // lost merely because the body turned out to be an error.
  const setCookies = res.headers.getSetCookie?.() ?? [];
  for (const c of setCookies) {
    const m = c.match(/^([^=]+)=([^;]*)/);
    if (m && m[2]) jar.set(m[1].trim(), m[2]);
  }

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }

  lastExchange = {
    status: res.status,
    sentCookies: cookieHeader(env).split('; ').map((c) => c.split('=')[0]),
    receivedCookies: setCookies.map((c) => c.split('=')[0]),
    body: text.slice(0, 300),
  };

  if (data?.error === 'login_required' || data?.error_code === 'login_required') {
    throw new Error(
      'EA rejected the session (login_required). Sending only remid asks EA to ' +
      'create a new session each time, which it will not always do - supplying ' +
      'the sid cookie as well is usually what fixes this.',
    );
  }
  if (!data?.access_token) {
    throw new Error(`EA returned no access token (HTTP ${res.status}): ${text.slice(0, 160)}`);
  }

  // EA reports expires_in in seconds; hold it slightly short of that.
  const ttl = Math.max(60, (Number(data.expires_in) || 3600) - 60) * 1000;
  tokenCache = { remid: env.EA_REMID, token: data.access_token, expiresAt: Date.now() + ttl };
  return data.access_token;
}

/** The cookies worth storing after a successful exchange. */
export function currentCookies(env) {
  return {
    remid: jar.get('remid') ?? env.EA_REMID ?? null,
    sid: jar.get('sid') ?? env.EA_SID ?? null,
  };
}

async function graphql(token, query, variables) {
  const data = await req(JUNO, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      // EA's gateway accepts the token under several names; Lutris sends all
      // three and so do we, because which one is honoured has changed before.
      AuthToken: token,
      'X-AuthToken': token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
    retries: 1,
  });
  if (data?.errors?.length) {
    throw new Error(`EA GraphQL: ${data.errors.map((e) => e.message).join('; ').slice(0, 200)}`);
  }
  return data?.data;
}

const ENTITLEMENTS = `
query getEntitlements($limit: Int, $next: String) {
  me {
    ownedGameProducts(
      locale: "DEFAULT"
      entitlementEnabled: true
      storefronts: [EA]
      type: [DIGITAL_FULL_GAME, PACKAGED_FULL_GAME]
      platforms: [PC]
      paging: { limit: $limit, next: $next }
    ) {
      next
      items {
        originOfferId
        product { baseItem { title gameType } gameSlug }
      }
    }
  }
}`;

/** Who the stored cookie belongs to; used to confirm auth without listing games. */
export async function whoami(env) {
  const token = await accessToken(env);
  const data = await graphql(token, 'query { me { player { pd psd displayName } } }', {});
  return data?.me?.player ?? null;
}

/**
 * Who the stored cookie belongs to, plus the library, in one pass.
 *
 * Deliberately a single function rather than whoami() then ownedGames(): each
 * would otherwise fetch its own token, and EA refuses the second request.
 */
export async function verify(env) {
  const player = await whoami(env);
  const games = await ownedGames(env, { fresh: true });
  return { player, games };
}

/**
 * Owned games.
 *
 * Paginated: EA returns a `next` cursor and will not hand over the whole
 * library in one response.
 */
export async function ownedGames(env, { fresh = false } = {}) {
  if (!configured(env)) throw new Error('EA_REMID is not set');

  const run = async () => {
    const token = await accessToken(env);
    const out = [];
    let next = null;
    let pages = 0;

    do {
      const data = await graphql(token, ENTITLEMENTS, { limit: 100, next });
      const page = data?.me?.ownedGameProducts;
      if (!page) break;

      for (const item of page.items ?? []) {
        const base = item?.product?.baseItem;
        // Expansions and add-ons are entitlements too; only base games are
        // things you would sensibly answer "do I own this?" about.
        if (base?.gameType && base.gameType !== 'BASE_GAME') continue;
        const title = base?.title;
        if (!title) continue;
        out.push({
          store: 'ea',
          id: String(item.originOfferId ?? title),
          title,
          url: item?.product?.gameSlug
            ? `https://www.ea.com/games/${item.product.gameSlug}`
            : 'https://www.ea.com/ea-app',
        });
      }
      next = page.next ?? null;
    } while (next && ++pages < 20);   // bounded: never loop on a stuck cursor

    // EA lists some products more than once across storefronts.
    const seen = new Set();
    return out.filter((g) => {
      const k = normalizeTitle(g.title);
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };

  // The auth tool must reach EA for real to prove a cookie works; a cached
  // answer would happily "verify" a cookie that had already expired.
  return fresh ? run() : cached('ea:owned', TTL.library, run);
}
