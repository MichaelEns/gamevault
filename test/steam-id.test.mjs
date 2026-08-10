/**
 * SteamID normalisation.
 *
 * STEAM_ID is the field most likely to be filled in wrongly, because nobody
 * knows their SteamID64 and Steam hands out two different profile URL shapes,
 * only one of which contains it. Getting it wrong produces no useful error --
 * GetOwnedGames simply returns nothing, which looks identical to a private
 * profile.
 */
import { toSteamId64 } from '../lib/steam.mjs';

let fails = 0;
const ok = (cond, msg) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); fails++; }
  else console.log(`  ok:   ${msg}`);
};

const ID = '76561197960287930';

console.log('Forms that need no network call');
// A key of null proves these never reach the API: resolveVanity would throw.
for (const [input, why] of [
  [ID, 'a bare SteamID64'],
  [`  ${ID}  `, 'a SteamID64 with stray whitespace'],
  [`https://steamcommunity.com/profiles/${ID}`, 'a /profiles/ URL'],
  [`https://steamcommunity.com/profiles/${ID}/`, 'a /profiles/ URL with trailing slash'],
  [`steamcommunity.com/profiles/${ID}`, 'a /profiles/ URL without scheme'],
  [`https://steamcommunity.com/profiles/${ID}?snr=1_x`, 'a /profiles/ URL with query'],
]) {
  const got = await toSteamId64(input, null).catch((e) => `THREW: ${e.message}`);
  ok(got === ID, `${why} -> ${got}`);
}

console.log('\nVanity forms are extracted before being resolved');
// Stub the network by passing a key and intercepting fetch. The shape mirrors
// what lib/http.mjs actually consumes (it reads res.text(), not res.json()).
const realFetch = globalThis.fetch;
let asked = null;
globalThis.fetch = async (url) => {
  asked = new URL(url).searchParams.get('vanityurl');
  return {
    ok: true,
    status: 200,
    headers: new Map(),
    text: async () => JSON.stringify({ response: { success: 1, steamid: ID } }),
  };
};
try {
  for (const [input, expected] of [
    ['https://steamcommunity.com/id/gaben', 'gaben'],
    ['https://steamcommunity.com/id/gaben/', 'gaben'],
    ['steamcommunity.com/id/gaben', 'gaben'],
    ['https://steamcommunity.com/id/gaben?utm=x', 'gaben'],
    ['gaben', 'gaben'],
  ]) {
    asked = null;
    const got = await toSteamId64(input, 'KEY').catch((e) => `THREW: ${e.message}`);
    ok(asked === expected && got === ID,
       `${input} -> asked Steam for "${asked}" -> ${got}`);
  }
} finally {
  globalThis.fetch = realFetch;
}

console.log('\nBad input fails loudly instead of silently returning nothing');
let msg = '';
await toSteamId64('', null).catch((e) => { msg = e.message; });
ok(/not set/i.test(msg), `empty -> ${msg}`);

msg = '';
await toSteamId64('12345678', null).catch((e) => { msg = e.message; });
ok(/17/.test(msg), `an 8-digit account id is rejected with an explanation -> ${msg}`);

msg = '';
await toSteamId64(null, null).catch((e) => { msg = e.message; });
ok(/not set/i.test(msg), `null -> ${msg}`);

console.log('');
if (fails) { console.log(`${fails} assertion(s) failed.`); process.exit(1); }
console.log('All Steam ID tests passed.');
