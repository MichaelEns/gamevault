/**
 * Epic claim support.
 *
 * Epic's current checkout is a JavaScript application protected by Cloudflare,
 * Talon and an hCaptcha challenge. The launcher exchange still proves that the
 * stored legendary login works, but it no longer yields a checkout session to
 * a plain HTTP client. Pretending otherwise caused every scheduled claim to
 * fail after the account exchange had apparently succeeded.
 *
 * GameVault therefore treats Epic giveaways as browser actions. The scheduled
 * build records one reminder, the local mailer sends it directly, and the app
 * provides Epic's product link. Once the game appears in the Epic library, the
 * next build clears that reminder. GOG claiming remains unattended.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const LAUNCHER = 'https://account-public-service-prod.ol.epicgames.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Where legendary keeps its login, in the order it prefers. */
function legendaryUserPaths() {
  const home = homedir();
  return [
    join(home, '.config', 'legendary', 'user.json'),
    join(home, 'AppData', 'Local', 'legendary', 'user.json'),
    join(home, 'AppData', 'Roaming', 'legendary', 'user.json'),
  ];
}

export function configured(env = {}) {
  if (env.LEGENDARY_CONFIG || env.LEGENDARY_USER_JSON || env.EPIC_ACCESS_TOKEN) {
    return true;
  }
  return legendaryUserPaths().some((p) => existsSync(p));
}

/**
 * A currently-valid launcher access token.
 *
 * Legendary stores both an access token and a refresh token, and the access
 * token lasts about eight hours. When Epic rotates the refresh token, preserve
 * the replacement in GitHub Actions or in legendary's local file.
 */
export let rotatedRefreshToken = null;
let tokenCache = null;

async function launcherToken(env) {
  if (env.EPIC_ACCESS_TOKEN) return env.EPIC_ACCESS_TOKEN;
  if (tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.token;

  const stored = await readLegendaryConfig(env);
  if (!stored) return null;
  if (env.EPIC_REFRESH_TOKEN) stored.refresh_token = String(env.EPIC_REFRESH_TOKEN).trim();

  const expiresAt = Date.parse(stored.expires_at ?? '');
  if (stored.access_token && Number.isFinite(expiresAt) &&
      expiresAt - Date.now() > 5 * 60 * 1000) {
    return stored.access_token;
  }
  if (!stored.refresh_token) {
    throw new Error(
      'legendary config has no refresh token - re-run ".\\finish-setup.ps1 -Only epic"',
    );
  }

  // These launcher client credentials are public and are also used by
  // legendary and Heroic.
  const basic = Buffer.from(
    '34a02cf8f4414e29b15921876da36f9a:daafbccc737745039dffe53d94fc76cf',
  ).toString('base64');

  const res = await fetch(`${LAUNCHER}/account/api/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: `basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: stored.refresh_token,
      token_type: 'eg1',
    }),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.access_token) {
    throw new Error(
      `Epic refused to refresh the launcher token (${res.status}). The stored ` +
      'login has expired - re-run ".\\finish-setup.ps1 -Only epic".',
    );
  }
  if (data.refresh_token && data.refresh_token !== stored.refresh_token) {
    rotatedRefreshToken = data.refresh_token;
    const { persistRotated } = await import('./credential-refresh.mjs');
    const saved = await persistRotated(env, 'EPIC_REFRESH_TOKEN', data.refresh_token);
    if (!saved) {
      const wroteBack = await updateLegendaryConfig({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: data.expires_at ?? null,
        refresh_expires_at: data.refresh_expires_at ?? null,
      });
      if (wroteBack) {
        console.log('Epic rotated its refresh token; saved to legendary\'s own ' +
                    'config, so this machine stays signed in.');
      }
    }
  }
  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() +
      Math.max(60, (Number(data.expires_in) || 28800) - 300) * 1000,
  };
  return data.access_token;
}

/** Legendary's stored credentials, wherever it put them. */
let legendarySourcePath = null;
async function readLegendaryFile() {
  legendarySourcePath = null;
  const { readFile } = await import('node:fs/promises');
  for (const path of legendaryUserPaths()) {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8'));
      legendarySourcePath = path;
      return parsed;
    } catch {
      // Try the next platform-specific location.
    }
  }
  return null;
}

async function readLegendaryConfig(env) {
  legendarySourcePath = null;
  if (env.LEGENDARY_USER_JSON) {
    try {
      return JSON.parse(env.LEGENDARY_USER_JSON);
    } catch {
      // Fall through to legendary's own file.
    }
  }
  return readLegendaryFile();
}

/**
 * Preserve a refresh token that legendary rotated while reading the library.
 *
 * The CLI updates user.json on the ephemeral Actions runner. Without copying
 * that token to its own secret, the next runner restores the spent token from
 * LEGENDARY_CONFIG and eventually loses Epic ownership sync.
 */
export async function persistLegendaryRefreshToken(env = {}) {
  if (!env.GITHUB_ACTIONS) return false;
  const stored = await readLegendaryFile();
  const refreshToken = stored?.refresh_token;
  if (!refreshToken || refreshToken === env.EPIC_REFRESH_TOKEN) return false;
  const { persistRotated } = await import('./credential-refresh.mjs');
  return persistRotated(env, 'EPIC_REFRESH_TOKEN', refreshToken);
}

/** Atomically write a rotated token back into legendary's own config. */
async function updateLegendaryConfig(fresh) {
  if (!legendarySourcePath) return false;
  try {
    const { readFile, writeFile, rename } = await import('node:fs/promises');
    const current = JSON.parse(await readFile(legendarySourcePath, 'utf8'));
    const tmp = `${legendarySourcePath}.gamevault.tmp`;
    await writeFile(tmp, JSON.stringify({ ...current, ...fresh }, null, 2),
                    { mode: 0o600 });
    await rename(tmp, legendarySourcePath);
    return true;
  } catch (e) {
    console.log(`::warning::Epic token rotated but legendary's config could not be ` +
                `updated (${e.message}). Re-run ".\\finish-setup.ps1 -Only epic" if ` +
                'the next run reports an expired login.');
    return false;
  }
}

/**
 * Confirm that Epic accepts the launcher login without placing an order.
 *
 * The returned exchange code is deliberately discarded. Redeeming it into a
 * store session now requires Epic's browser application and anti-bot checks.
 */
export async function probeSession(env = {}) {
  const token = await launcherToken(env);
  if (!token) {
    throw new Error('No Epic launcher token available (is LEGENDARY_CONFIG set?)');
  }

  const res = await fetch(`${LAUNCHER}/account/api/oauth/exchange`, {
    headers: { Authorization: `bearer ${token}`, 'User-Agent': UA },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.code) {
    throw new Error(
      `Epic refused an exchange code (${res.status}). Re-run ` +
      '".\\finish-setup.ps1 -Only epic".',
    );
  }
  return true;
}

/**
 * Epic's current free-game checkout requires a real, interactive browser.
 *
 * The marker lets the snapshot builder record a single actionable reminder
 * rather than retrying a request that cannot satisfy the browser challenge.
 */
export async function claim(env, game) {
  if (!configured(env)) {
    throw new Error(
      'Epic is not set up: no legendary login was found. Run ' +
      '".\\finish-setup.ps1 -Only epic".',
    );
  }
  const error = new Error(
    `Epic requires browser checkout. Open ${game.url ?? 'the Epic free-games page'} ` +
    'and choose Get, then Add to library.',
  );
  error.manualAction = true;
  throw error;
}

export async function claimAll(env, freebies, { limit = 5 } = {}) {
  const results = [];
  const targets = freebies.filter((g) => g.worthClaiming).slice(0, limit);
  for (const game of targets) {
    try {
      await claim(env, game);
    } catch (e) {
      results.push({
        game,
        ok: false,
        alreadyOwned: false,
        manualAction: e.manualAction === true,
        note: e.message,
      });
    }
  }
  return results;
}
