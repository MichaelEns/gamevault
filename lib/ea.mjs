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
 * `remid` is the long-lived "remember me" cookie, which is why it is the one
 * worth storing; `sid` is a short session cookie and is optional.
 */
export async function accessToken(env) {
  const cookies = [
    `remid=${env.EA_REMID}`,
    env.EA_SID ? `sid=${env.EA_SID}` : null,
  ].filter(Boolean).join('; ');

  const url = `${AUTH}?client_id=${CLIENT_ID}&response_type=token` +
              `&redirect_uri=nucleus%3Arest&prompt=none&release_type=prod`;
  const data = await req(url, { headers: { Cookie: cookies }, retries: 1 });

  if (data?.error === 'login_required' || data?.error_code === 'login_required') {
    throw new Error(
      'EA rejected the stored session (login_required). The EA_REMID cookie has ' +
      'expired or was copied incorrectly. Run "npm run ea-auth" again to refresh it.',
    );
  }
  if (!data?.access_token) {
    throw new Error(`EA returned no access token: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return data.access_token;
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
 * Owned games.
 *
 * Paginated: EA returns a `next` cursor and will not hand over the whole
 * library in one response.
 */
export async function ownedGames(env) {
  if (!configured(env)) throw new Error('EA_REMID is not set');

  return cached('ea:owned', TTL.library, async () => {
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
  });
}
