import { req } from './http.mjs';
import { cached, TTL } from './cache.mjs';
import { isAddon } from './match.mjs';
import { getSession, setSession, clearSession } from './sessions.mjs';

/**
 * Ubisoft Connect ownership.
 *
 * UNOFFICIAL. Ubisoft publishes no ownership API, so this drives the same
 * private endpoints the Ubisoft Connect client uses.
 *
 * Known, accepted limitations -- surfaced as clear errors rather than
 * pretending to work:
 *   - Requires storing your Ubisoft email + password locally in .env.
 *   - Two-factor authentication CANNOT be satisfied here; if 2FA is on,
 *     this will fail and there is no workaround short of disabling it.
 *   - Ubisoft may invalidate the app id or endpoint shape at any time.
 *
 * Most Ubisoft titles are also sold on Steam, so Steam ownership usually
 * covers the same ground without any of this.
 */
const AUTH = 'https://public-ubiservices.ubi.com/v3/profiles/sessions';

/**
 * Ubisoft uses DIFFERENT application IDs for logging in and for API calls, and
 * getting this wrong looks exactly like a credential problem.
 *
 * `314d4fef...` is the Ubisoft Connect PC client's own ID. Ubisoft has blocked
 * third-party use of it at the gateway: it answers every request, including
 * ones with deliberately fake credentials, with
 *   403 errorCode 1002 "The Service: authentication, is not currently
 *   available for Application 314d4fef-..."
 *
 * `f68a4bb5...` is the ID the client uses for its API requests. Probed the same
 * way it returns 401 "Invalid credentials" -- the application is accepted and
 * only the credentials are refused, which is the response we want.
 */
const UBI_APP_ID = 'f68a4bb5-608a-4ff2-8123-be8ef797e0a6';

// Ubisoft has moved this around; try in order and report what happened.
const OWNERSHIP_ENDPOINTS = [
  // GraphQL is what the current client uses; the REST paths are older
  // fallbacks kept because they still answer for some accounts.
  'https://api-ubiservices.ubi.com/v1/profiles/me/global/ubiconnect/entitlement/api/entitlements',
  'https://public-ubiservices.ubi.com/v1/profiles/me/global/ubiconnect/library/api/games',
  'https://public-ubiservices.ubi.com/v1/profiles/me/club/ownedgames',
  'https://public-ubiservices.ubi.com/v2/profiles/me/ownedgames',
];

export function configured(env) {
  return Boolean(env.UBISOFT_REMEMBER_TICKET || (env.UBISOFT_EMAIL && env.UBISOFT_PASSWORD));
}

/**
 * Log in, reusing a stored session ticket when one is still valid.
 *
 * Ubisoft tickets last a few hours. Re-sending the password on every sync
 * is the behaviour most likely to trip an account-security challenge, so
 * we authenticate once and then ride the ticket until it expires.
 */
async function login(env, { force = false } = {}) {
  if (!configured(env)) {
    throw new Error(
      'Ubisoft is not configured. Set UBISOFT_REMEMBER_TICKET (preferred - run ' +
      '"node tools/ubisoft-auth.mjs" once to obtain it), or UBISOFT_EMAIL and ' +
      'UBISOFT_PASSWORD for an account without 2FA.',
    );
  }

  // A password login on a 2FA account makes Ubisoft send a code EVERY time.
  // On the six-hourly schedule that is four unsolicited security codes a day,
  // to no purpose: a scheduled build cannot type one in, and repeatedly
  // triggering challenges is the kind of pattern that gets an account
  // flagged. So outside an interactive session, only the ticket is used.
  const interactive = !env.CI && !env.GITHUB_ACTIONS;
  if (!env.UBISOFT_REMEMBER_TICKET && !interactive) {
    throw new Error(
      'Only UBISOFT_EMAIL / UBISOFT_PASSWORD are set, and a password login ' +
      'would trigger a fresh 2FA code on every scheduled build. Run ' +
      '"npm run ubisoft-auth" once on a PC, set UBISOFT_REMEMBER_TICKET, then ' +
      'delete UBISOFT_PASSWORD.',
    );
  }

  if (!force) {
    const saved = await getSession('ubisoft');
    if (saved?.ticket && saved?.sessionId) return saved;
  }

  // A remember-me ticket is preferred over the password: it clears 2FA (which
  // a password alone cannot), it grants only session creation rather than
  // account access, and it can be revoked without changing the password.
  const basic = Buffer.from(`${env.UBISOFT_EMAIL}:${env.UBISOFT_PASSWORD}`, 'utf8').toString('base64');
  const authHeader = env.UBISOFT_REMEMBER_TICKET
    ? `rm_v1 t=${env.UBISOFT_REMEMBER_TICKET}`
    : `Basic ${basic}`;

  let data;
  try {
    data = await req(AUTH, {
      method: 'POST',
      headers: {
        'Ubi-AppId': UBI_APP_ID,
        Authorization: authHeader,
        'Content-Type': 'application/json',
        'Ubi-RequestedPlatformType': 'uplay',
      },
      body: JSON.stringify({ rememberMe: true }),
      retries: 0,
    });
  } catch (e) {
    if (e.status === 401) {
      throw new Error('Ubisoft rejected the credentials (401). Check UBISOFT_EMAIL / UBISOFT_PASSWORD.');
    }
    if (e.status === 403) {
      // Probed with deliberately fake credentials and the response is
      // identical: errorCode 1002 from UbiServices.Gateway, "The Service:
      // authentication, is not currently available for Application <id>".
      // Ubisoft has disabled logins for this client ID, so this is not about
      // the account, the password, or 2FA -- and no retry will help.
      const disabled = typeof e.body === 'string' && e.body.includes('1002');
      throw new Error(
        disabled
          ? 'Ubisoft has disabled logins for this client ID (403, errorCode 1002). ' +
            'Fake credentials get the identical response, so this is not your account, ' +
            'password or 2FA. Nothing can be synced until Ubisoft re-enables it - ' +
            'delete UBISOFT_EMAIL and UBISOFT_PASSWORD rather than leave an account ' +
            'password stored for a source that cannot work.'
          : 'Ubisoft refused the login (403). This is usually the client ID being ' +
            'blocked rather than a credential problem.',
      );
    }
    throw e;
  }

  if (data?.twoFactorAuthenticationTicket) {
    // 2FA cannot be cleared by a password alone, but it does not have to be:
    // clearing it once interactively returns a rememberMeTicket that
    // authenticates on its own afterwards. Saying "there is no path" here was
    // simply wrong, and would have left this permanently unconfigurable.
    throw new Error(
      'This Ubisoft account has two-factor authentication, which a password ' +
      'alone cannot clear. Run "node tools/ubisoft-auth.mjs" once on a PC to ' +
      'complete 2FA and obtain a reusable ticket, then set it as ' +
      'UBISOFT_REMEMBER_TICKET and delete UBISOFT_PASSWORD.',
    );
  }
  if (!data?.ticket) throw new Error('Ubisoft login returned no session ticket.');

  const session = { ticket: data.ticket, sessionId: data.sessionId, profileId: data.profileId };

  // Honour the server's own expiry when it gives one, otherwise assume a
  // conservative 2h so we refresh before the ticket actually dies.
  const expiresAt = data.expiration ? Date.parse(data.expiration) : null;
  const ttl = expiresAt && expiresAt > Date.now()
    ? expiresAt - Date.now() - 60_000
    : 2 * 60 * 60 * 1000;
  await setSession('ubisoft', session, ttl);

  return session;
}

export async function ownedGames(env) {
  return cached('ubisoft:owned', TTL.library, async () => {
    // A stored ticket can be revoked server-side before its stated expiry,
    // so a 401 means "re-login once", not "give up".
    for (const force of [false, true]) {
      const session = await login(env, { force });
      const headers = {
        'Ubi-AppId': UBI_APP_ID,
        'Ubi-SessionId': session.sessionId,
        Authorization: `Ubi_v1 t=${session.ticket}`,
        'Content-Type': 'application/json',
      };

      const failures = [];
      let sawAuthFailure = false;

      for (const url of OWNERSHIP_ENDPOINTS) {
        try {
          const data = await req(url, { headers, retries: 0 });
          const games = extractTitles(data);
          if (games.length) {
            return games
              .filter((t) => !isAddon(t))
              .map((title) => ({ store: 'ubisoft', id: null, title, url: null }));
          }
          failures.push(`${url} -> 200 but no recognisable game list`);
        } catch (e) {
          if (e.status === 401) sawAuthFailure = true;
          failures.push(`${url} -> ${e.status ?? ''} ${e.message}`.trim());
        }
      }

      if (sawAuthFailure && !force) {
        await clearSession('ubisoft');
        continue; // one retry with a fresh login
      }

      throw new Error(
        'Ubisoft login succeeded but no ownership endpoint returned a usable list. ' +
        'These private endpoints move without notice. Detail:\n  ' + failures.join('\n  '),
      );
    }
  });
}

/** Ubisoft's shapes vary by endpoint; pull titles out of whatever we got. */
function extractTitles(data) {
  const titles = new Set();
  const walk = (node, depth = 0) => {
    if (!node || depth > 6) return;
    if (Array.isArray(node)) return node.forEach((n) => walk(n, depth + 1));
    if (typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string' && /^(name|title|productName|displayName)$/i.test(k) && v.trim()) {
        titles.add(v.trim());
      } else walk(v, depth + 1);
    }
  };
  walk(data);
  return [...titles];
}
