/**
 * GOG giveaways.
 *
 * GOG runs occasional giveaways - a handful a year rather than weekly - and
 * they are genuinely worth catching because they are usually full games and
 * the window is short, often 48 hours. Missing one because nobody was looking
 * is exactly the failure this app exists to prevent.
 *
 * Probed before building against it:
 *
 *   auth.gog.com/token           400 invalid_grant  client accepted, token was fake
 *   gog.com/giveaway/claim       401 Unauthorized   auth-gated, not bot-protected
 *   giveaway/api/getGiveawayDetails  404            no giveaway running just now
 *
 * So the claim path is reachable with a token, and nothing has to pretend to
 * be a browser. GOG's OAuth is the one Heroic and Lutris use; the client
 * credentials are published in both, which is what makes a token refresh
 * possible without embedding anything private.
 */
import { req } from './http.mjs';
import { cached, TTL } from './cache.mjs';
import { normalizeTitle } from './match.mjs';

const AUTH = 'https://auth.gog.com/token';
const GIVEAWAY = 'https://www.gog.com/giveaway/api/getGiveawayDetails';
const CLAIM = 'https://www.gog.com/giveaway/claim';
const CLIENT_ID = '46899977096215655';
const CLIENT_SECRET = '9d85c43b1482497dbbce61f6e4aa173a433796eeae2ca8c5f6129f2dc4de46d9';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export function configured(env) {
  return Boolean(env.GOG_REFRESH_TOKEN);
}

/** The replacement refresh token, if GOG issued one. */
export let rotatedToken = null;

let accessCache = null;

/**
 * Exchange the stored refresh token for an access token.
 *
 * GOG returns a NEW refresh token each time and retires the old one, the same
 * shape Ubisoft has. Capturing the replacement is therefore not optional: a
 * stored token would authenticate exactly one build and then be refused.
 */
export async function accessToken(env) {
  if (accessCache && Date.now() < accessCache.expiresAt) return accessCache.token;

  const url = `${AUTH}?client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}` +
              `&grant_type=refresh_token&refresh_token=${encodeURIComponent(String(env.GOG_REFRESH_TOKEN).trim())}`;
  const data = await req(url, { headers: { 'User-Agent': UA }, retries: 1 }).catch((e) => {
    if (/400|invalid_grant/i.test(e.message)) {
      throw new Error(
        'GOG rejected the refresh token. GOG issues a new one on every use and ' +
        'retires the old one, so a stored token is spent after a single build ' +
        'unless GAMEVAULT_SECRETS_TOKEN is set for it to be written back. ' +
        'Run "npm run gog-auth" again.',
      );
    }
    throw e;
  });

  if (!data?.access_token) throw new Error('GOG returned no access token');
  if (data.refresh_token && data.refresh_token !== env.GOG_REFRESH_TOKEN) {
    rotatedToken = data.refresh_token;
  }
  accessCache = {
    token: data.access_token,
    expiresAt: Date.now() + Math.max(60, (Number(data.expires_in) || 3600) - 60) * 1000,
  };
  return data.access_token;
}

/**
 * The giveaway running right now, if any.
 *
 * Public: no token needed to look. A 404 means nothing is running, which is
 * the usual state and must not be reported as an error.
 */
export async function currentGiveaway() {
  return cached('freebies:gog', TTL.price, async () => {
    try {
      const data = await req(GIVEAWAY, { headers: { 'User-Agent': UA }, retries: 0 });
      const title = data?.giveaway?.gameTitle ?? data?.gameTitle ?? data?.title;
      if (!title) return [];
      return [{
        store: 'gog',
        title: String(title).trim(),
        norm: normalizeTitle(title),
        endsAt: data?.giveaway?.endDate ?? data?.endDate ?? null,
        giveawayId: data?.giveaway?.id ?? data?.id ?? null,
        url: 'https://www.gog.com/giveaway',
      }];
    } catch (e) {
      // 404 is the normal, boring case: no giveaway is running.
      if (/404/.test(e.message)) return [];
      throw e;
    }
  });
}

/** Claim the current giveaway. */
export async function claim(env, game) {
  if (!configured(env)) throw new Error('GOG_REFRESH_TOKEN is not set');
  const token = await accessToken(env);

  const res = await fetch(CLAIM, {
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': UA,
      Accept: 'application/json',
    },
  });
  const text = await res.text();

  if (res.status === 401) throw new Error('GOG rejected the token when claiming (401)');
  if (/already/i.test(text)) {
    const e = new Error('already owned');
    e.alreadyOwned = true;
    throw e;
  }
  if (!res.ok) throw new Error(`GOG returned ${res.status} when claiming`);
  return { confirmed: true, raw: text.slice(0, 200) };
}
