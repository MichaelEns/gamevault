/**
 * Credentials must never reach an error message.
 *
 * This is not hypothetical. Pasting the Steam API key into STEAM_ID produced
 * `Steam could not resolve vanity name "<the key>"`, which is stored in the
 * snapshot as stores.steam.error and rendered in the app's Sources panel.
 *
 * The wider version of the same bug was in lib/http.mjs: both Steam and
 * IsThereAnyDeal pass their key as a query parameter, and every HTTP failure
 * interpolated the full URL. Any 429 or 5xx would have carried the key into
 * the snapshot and onto the screen.
 *
 * GitHub masks registered secrets in workflow logs and did mask this one, but
 * that protection stops at the log. It does not extend to the snapshot, the
 * UI, or a local run.
 */
import { redactUrl, HttpError } from '../lib/http.mjs';
import { toSteamId64 } from '../lib/steam.mjs';

let fails = 0;
const ok = (cond, msg) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); fails++; }
  else console.log(`  ok:   ${msg}`);
};

const KEY = 'A1B2C3D4E5F60718293A4B5C6D7E8F90';

console.log('URLs are stripped of credentials');
for (const [url, why] of [
  [`https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${KEY}&steamid=765`, 'Steam key param'],
  [`https://api.isthereanydeal.com/games/prices/v3?key=${KEY}&country=US`, 'ITAD key param'],
  [`https://x.test/a?api_key=${KEY}`, 'api_key'],
  [`https://x.test/a?apikey=${KEY}`, 'apikey'],
  [`https://x.test/a?token=${KEY}`, 'token'],
  [`https://x.test/a?access_token=${KEY}`, 'access_token'],
  [`https://x.test/a?password=${KEY}`, 'password'],
  [`https://user:${KEY}@x.test/a`, 'credentials in userinfo'],
]) {
  const out = redactUrl(url);
  ok(!out.includes(KEY), `${why}: ${out}`);
}

console.log('\nNon-secret parts of the URL survive, so errors stay useful');
const kept = redactUrl(`https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${KEY}&steamid=76561197960287930`);
ok(kept.includes('GetOwnedGames'), 'the endpoint is still identifiable');
ok(kept.includes('76561197960287930'), 'non-secret parameters are preserved');
ok(kept.includes('REDACTED'), 'the redaction is visible rather than silent');

console.log('\nMalformed URLs are still scrubbed');
const junk = redactUrl(`not a url key=${KEY}&x=1`);
ok(!junk.includes(KEY), `unparseable input is scrubbed: ${junk}`);

console.log('\nHttpError cannot carry a key');
const err = new HttpError(429, `https://api.steampowered.com/x?key=${KEY}`, 'rate limited');
ok(!err.message.includes(KEY), `message is clean: ${err.message}`);
ok(!err.url.includes(KEY), 'the .url property is clean too');

console.log('\nSteam ID mistakes are described, not quoted');
// The precise mistake that happened: API key pasted into STEAM_ID.
let msg = '';
await toSteamId64(KEY, 'irrelevant').catch((e) => { msg = e.message; });
ok(!msg.includes(KEY), 'the pasted value is not echoed');
ok(/looks like a Steam API key/.test(msg), `and the mix-up is named outright: ${msg}`);

// A wrong-length numeric id must not be echoed either.
msg = '';
await toSteamId64('1234567890', 'irrelevant').catch((e) => { msg = e.message; });
ok(!msg.includes('1234567890'), 'a wrong-length id is not echoed');
ok(/10 digits/.test(msg), `its shape is described instead: ${msg}`);

// An ordinary failed vanity lookup must describe, not quote.
const realFetch = globalThis.fetch;
globalThis.fetch = async () => ({
  ok: true, status: 200, headers: new Map(),
  text: async () => JSON.stringify({ response: { success: 42 } }),
});
try {
  msg = '';
  await toSteamId64('some-private-handle', 'k').catch((e) => { msg = e.message; });
  ok(!msg.includes('some-private-handle'), 'a failed lookup does not echo the name');
  ok(/\d+ characters/.test(msg), `it reports the shape: ${msg}`);
} finally {
  globalThis.fetch = realFetch;
}

console.log('');
if (fails) { console.log(`${fails} assertion(s) failed.`); process.exit(1); }
console.log('All redaction tests passed.');
