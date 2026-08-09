#!/usr/bin/env node
/**
 * `npm run doctor` -- tell me exactly what is and is not working, offline.
 *
 * Deliberately usable without starting the server, because the common
 * question on a fresh machine is "why is this provider not showing up",
 * and the answer should not require reading source.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { PATHS } from '../lib/paths.mjs';
import { sessionInfo } from '../lib/sessions.mjs';
import * as epic from '../lib/epic.mjs';

const C = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
  head: (s) => `\x1b[36m${s}\x1b[0m`,
};

async function loadEnv() {
  const env = { ...process.env };
  if (!existsSync(PATHS.env)) return env;
  for (const line of (await readFile(PATHS.env, 'utf8')).split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i);
    if (!m) continue;
    const v = m[2].trim().replace(/^["']|["']$/g, '');
    if (v) env[m[1]] = v;
  }
  return env;
}

const row = (label, state, note) => {
  const mark = state === 'ok' ? C.ok('  ok  ') : state === 'warn' ? C.warn(' skip ') : C.bad('  --  ');
  console.log(`  ${mark} ${label.padEnd(22)} ${note}`);
};

const env = await loadEnv();
console.log('');
console.log(C.head('GameVault doctor'));
console.log(C.dim(`  project: ${PATHS.root}`));
console.log('');

// --- runtime ---
console.log(C.head('Runtime'));
const major = Number(process.versions.node.split('.')[0]);
row('node', major >= 20 ? 'ok' : 'bad',
    `${process.versions.node}${major >= 20 ? '' : '  <- need 20+ for built-in fetch'}`);
row('.env file', existsSync(PATHS.env) ? 'ok' : 'bad',
    existsSync(PATHS.env) ? PATHS.env : 'missing -- run setup.ps1 (or copy .env.example to .env)');
console.log('');

// --- works with no credentials ---
console.log(C.head('Works with no credentials'));
row('Steam prices', 'ok', 'public API');
row('GOG prices', 'ok', 'public API');
row('Game Pass access', 'ok', 'public catalog');
row('EA Play access', 'ok', 'public catalog');
console.log('');

// --- pricing quality ---
console.log(C.head('Deal quality'));
row('IsThereAnyDeal', env.ITAD_API_KEY ? 'ok' : 'warn',
    env.ITAD_API_KEY
      ? 'all-time lows + ~40 stores'
      : 'no key -> no price history, so "good deal" is just % off list'
        + '\n' + ' '.repeat(31) + C.dim('https://isthereanydeal.com/apps/my/'));
console.log('');

// --- ownership ---
console.log(C.head('Ownership (each is optional)'));
row('Steam', env.STEAM_API_KEY && env.STEAM_ID ? 'ok' : 'warn',
    env.STEAM_API_KEY
      ? (env.STEAM_ID ? 'key + id set' : 'STEAM_API_KEY set but STEAM_ID missing')
      : 'no key ' + C.dim('https://steamcommunity.com/dev/apikey'));
if (env.STEAM_API_KEY && env.STEAM_ID) {
  console.log(' '.repeat(31) + C.dim('reminder: profile > privacy > "Game details" must be Public'));
}

row('itch.io', env.ITCH_API_KEY ? 'ok' : 'warn',
    env.ITCH_API_KEY ? 'key set' : 'no key ' + C.dim('https://itch.io/user/settings/api-keys'));

const ep = await epic.authStatus().catch(() => ({ installed: false, loggedIn: false }));
row('Epic', ep.loggedIn ? 'ok' : 'warn',
    !ep.installed
      ? 'legendary not installed -- run setup.ps1'
      : ep.loggedIn
        ? `logged in as ${ep.account} (${ep.gamesAvailable} games)`
        : 'not logged in -- run: .venv\\Scripts\\legendary auth');

row('Ubisoft', env.UBISOFT_EMAIL && env.UBISOFT_PASSWORD ? 'ok' : 'warn',
    env.UBISOFT_EMAIL && env.UBISOFT_PASSWORD
      ? 'credentials set (will fail if 2FA is on)'
      : 'not configured -- unofficial, and Steam covers most Ubisoft titles');
console.log('');

// --- stored sessions ---
const sessions = await sessionInfo();
console.log(C.head('Stored sessions'));
if (!Object.keys(sessions).length) {
  console.log(C.dim('  none yet -- created automatically after the first sync'));
} else {
  for (const [k, v] of Object.entries(sessions)) {
    row(k, v.valid ? 'ok' : 'warn',
        v.valid ? `valid until ${v.expiresAt ?? 'n/a'}` : 'expired -- will re-login on next sync');
  }
}
console.log('');

// --- library ---
console.log(C.head('Library'));
try {
  const lib = JSON.parse(await readFile(PATHS.library, 'utf8'));
  row('last sync', lib.syncedAt ? 'ok' : 'warn', lib.syncedAt ?? 'never');
  row('unique titles', Object.keys(lib.index ?? {}).length ? 'ok' : 'warn',
      String(Object.keys(lib.index ?? {}).length));
  for (const [k, v] of Object.entries(lib.stores ?? {})) {
    row(`  ${k}`, v.ok ? 'ok' : 'bad', v.ok ? `${v.count} games` : v.error);
  }
} catch {
  row('library', 'warn', 'not synced yet -- start the app and click "Sync library"');
}

console.log('');
const missing = [];
if (!env.ITAD_API_KEY) missing.push('ITAD_API_KEY (biggest win)');
if (!env.STEAM_API_KEY || !env.STEAM_ID) missing.push('Steam');
if (missing.length) {
  console.log(C.warn('Next step: ') + `add ${missing.join(', ')} to .env, then re-run this.`);
} else {
  console.log(C.ok('Everything configured. ') + 'Start with: npm start');
}
console.log('');
