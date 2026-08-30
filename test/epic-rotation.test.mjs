/**
 * The rotated Epic refresh token must survive a local run.
 *
 * Epic retires a refresh token as soon as it is used. In CI the replacement is
 * written to a GitHub secret, but a developer running these tools by hand has
 * no secrets token, so before this was fixed the new token was simply dropped:
 * `npm run epic-claim-auth` would spend a credential that was good for another
 * year and leave the config holding the spent one. The verification tool broke
 * the thing it was verifying.
 *
 * Driven entirely offline against a throwaway home directory and a stubbed
 * Epic, so it exercises the real rotation path without touching a real login.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const fails = [];
function ok(cond, msg) {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${msg}`);
  if (!cond) fails.push(msg);
}

const home = mkdtempSync(path.join(tmpdir(), 'gv-legendary-'));
process.env.USERPROFILE = home;
process.env.HOME = home;
for (const k of ['EPIC_COOKIES', 'LEGENDARY_CONFIG', 'GAMEVAULT_LEGENDARY_BIN',
                 'LEGENDARY_USER_JSON', 'EPIC_REFRESH_TOKEN', 'EPIC_ACCESS_TOKEN',
                 'GAMEVAULT_SECRETS_TOKEN', 'GITHUB_REPOSITORY']) {
  delete process.env[k];
}

const cfgDir = path.join(home, '.config', 'legendary');
mkdirSync(cfgDir, { recursive: true });
const cfgFile = path.join(cfgDir, 'user.json');

// An expired access token with a refresh token still good for a year - exactly
// the state a machine is in after not running the tools for a few weeks.
writeFileSync(cfgFile, JSON.stringify({
  account_id: 'acct-1',
  displayName: 'tester',
  access_token: 'OLD-ACCESS',
  refresh_token: 'OLD-REFRESH',
  expires_at: '2020-01-01T00:00:00.000Z',
  refresh_expires_at: '2027-01-01T00:00:00.000Z',
  extra_field_legendary_cares_about: 'keep me',
}, null, 2));

const calls = [];
globalThis.fetch = async (url, opts = {}) => {
  calls.push(String(url));
  if (String(url).includes('/account/api/oauth/token')) {
    ok(new URLSearchParams(opts.body).get('refresh_token') === 'OLD-REFRESH',
       'refresh is attempted with the stored token');
    return { ok: true, status: 200, json: async () => ({
      access_token: 'NEW-ACCESS',
      refresh_token: 'NEW-REFRESH',
      expires_in: 28800,
      expires_at: '2030-01-01T00:00:00.000Z',
      refresh_expires_at: '2031-01-01T00:00:00.000Z',
    }) };
  }
  if (String(url).includes('/account/api/oauth/exchange')) {
    return { ok: true, status: 200, json: async () => ({ code: 'EXCHANGE-CODE' }) };
  }
  if (String(url).includes('/id/api/exchange/code')) {
    return { ok: true, status: 200,
             headers: { getSetCookie: () => ['EPIC_SESSION_AP=abc; Path=/'] },
             json: async () => ({}) };
  }
  throw new Error(`unexpected fetch: ${url}`);
};

const epic = await import('../lib/epic-claim.mjs');

ok(epic.configured({}) === true,
   'configured() sees a legendary login on disk with no env vars set');

try {
  await epic.probeSession({});
} catch (e) {
  console.log(`  (session probe ended with: ${e.message})`);
}

ok(calls.some((u) => u.includes('/account/api/oauth/token')),
   'the refresh endpoint was actually called');

const after = JSON.parse(readFileSync(cfgFile, 'utf8'));
ok(after.refresh_token === 'NEW-REFRESH',
   'the rotated refresh token was written back to legendary config');
ok(after.access_token === 'NEW-ACCESS',
   'the new access token was written back too');
ok(after.extra_field_legendary_cares_about === 'keep me',
   'unrelated fields legendary owns are preserved');
ok(after.account_id === 'acct-1', 'account id preserved');
ok(after.refresh_expires_at === '2031-01-01T00:00:00.000Z',
   'the new refresh expiry is recorded');
ok(epic.rotatedRefreshToken === 'NEW-REFRESH',
   'the rotation is still reported for the CI write-back path');

// No stray temp file left next to a credential.
const { readdirSync } = await import('node:fs');
ok(!readdirSync(cfgDir).some((f) => f.endsWith('.tmp')),
   'no temporary file is left beside the credential');

rmSync(home, { recursive: true, force: true });
console.log(fails.length ? `\nFAILURES: ${fails.length}` : '\nall epic rotation cases pass');
process.exit(fails.length ? 1 : 0);
