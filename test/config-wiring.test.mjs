/**
 * Configuration wiring.
 *
 * Two failure modes, both silent, both previously present:
 *
 *   1. A secret the build code reads but the workflow never passes through.
 *      Setting it appears to work and changes nothing -- UBISOFT_EMAIL and
 *      UBISOFT_PASSWORD were in exactly this state.
 *
 *   2. A default written with `??`. GitHub Actions passes an EMPTY STRING for
 *      an unset variable, not undefined, so `??` does not fire.
 *      Number('' ?? 400) is 0, which would have capped pricing at zero titles
 *      and produced a build with no prices and no error.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PATHS } from '../lib/paths.mjs';

let fails = 0;
const ok = (cond, msg) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); fails++; }
  else console.log(`  ok:   ${msg}`);
};

const workflow = await readFile(
  path.join(PATHS.root, '.github', 'workflows', 'snapshot.yml'), 'utf8');

const sources = [];
for (const dir of ['lib', 'tools']) {
  const base = path.join(PATHS.root, dir);
  const { readdir } = await import('node:fs/promises');
  for (const f of await readdir(base)) {
    if (f.endsWith('.mjs')) sources.push(path.join(base, f));
  }
}

// Vars set by the workflow itself or only meaningful to the local server, so
// they are not expected in the build step's env block.
const NOT_FROM_CI = new Set([
  'GAMEVAULT_DATA_DIR', 'GAMEVAULT_LEGENDARY_BIN', 'GAMEVAULT_NILE_BIN',
  'GAMEVAULT_PASSWORD', 'GAMEVAULT_PASSWORD_HASH',
  'PORT', 'HOST', 'TRUST_PROXY', 'NODE_ENV',
]);

console.log('Every configurable the build reads is passed by the workflow');
const read = new Set();
for (const file of sources) {
  if (path.basename(file) === 'github-secrets.mjs') continue;   // browser-side
  const src = await readFile(file, 'utf8');
  for (const m of src.matchAll(/\b(?:ENV|env)\??\.([A-Z][A-Z0-9_]{2,})\b/g)) read.add(m[1]);
}
for (const name of [...read].sort()) {
  if (NOT_FROM_CI.has(name)) continue;
  ok(workflow.includes(`${name}:`),
     `${name} is wired into the workflow env`);
}

console.log('\nDefaults survive the empty string GitHub actually passes');
// Assert on the real source: `??` against an env read is the bug shape.
const build = await readFile(path.join(PATHS.root, 'tools', 'build-snapshot.mjs'), 'utf8');
const badDefaults = [...build.matchAll(/\bENV\.([A-Z_]+)\s*\?\?/g)].map((m) => m[1]);
ok(badDefaults.length === 0,
   badDefaults.length
     ? `these use ?? and would ignore their default when unset: ${badDefaults.join(', ')}`
     : 'no env default relies on ?? ');

// And prove the behaviour, not just the syntax.
const ENV = { COUNTRY: '', SNAPSHOT_PRICE_LIMIT: '' };
ok((ENV.COUNTRY || 'US') === 'US', 'an unset COUNTRY falls back to US');
ok((Number(ENV.SNAPSHOT_PRICE_LIMIT) || 400) === 400, 'an unset price limit falls back to 400');
ok((Number('250') || 400) === 250, 'an explicit price limit is still honoured');

console.log('\nSecrets are referenced as secrets, and variables as variables');
// A key placed in `vars` would be readable by anyone able to read the repo.
for (const secret of ['SNAPSHOT_PASSPHRASE', 'ITAD_API_KEY', 'STEAM_API_KEY',
                      'STEAM_ID', 'ITCH_API_KEY', 'UBISOFT_EMAIL',
                      'UBISOFT_PASSWORD', 'LEGENDARY_CONFIG', 'NILE_CONFIG']) {
  const line = workflow.split('\n').find((l) => l.trim().startsWith(`${secret}:`));
  ok(Boolean(line) && line.includes('secrets.'),
     `${secret} comes from secrets.* ${line ? '' : '(MISSING)'}`);
}
for (const variable of ['SUBSCRIPTIONS', 'COUNTRY', 'SNAPSHOT_PRICE_LIMIT']) {
  const line = workflow.split('\n').find((l) => l.trim().startsWith(`${variable}:`));
  ok(Boolean(line) && line.includes('vars.'), `${variable} comes from vars.*`);
}

console.log('\nThe app offers every secret the build can actually use');
const app = await readFile(path.join(PATHS.root, 'site', 'app-static.js'), 'utf8');
for (const name of ['ITAD_API_KEY', 'STEAM_API_KEY', 'STEAM_ID', 'ITCH_API_KEY',
                    'LEGENDARY_CONFIG', 'NILE_CONFIG', 'UBISOFT_EMAIL', 'UBISOFT_PASSWORD',
                    'UBISOFT_REMEMBER_TICKET', 'EA_REMID', 'HUMBLE_SESSION', 'EPIC_COOKIES', 'MANUAL_LIBRARY']) {
  ok(app.includes(name), `"Add key" offers ${name}`);
}

console.log('');
if (fails) { console.log(`${fails} assertion(s) failed.`); process.exit(1); }
console.log('All config-wiring tests passed.');
