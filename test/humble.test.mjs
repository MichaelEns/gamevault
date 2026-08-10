/**
 * Humble Bundle ownership.
 *
 * The case that matters is the unredeemed key. A redeemed Steam key is already
 * visible through the Steam sync, so it adds nothing; an UNREDEEMED one is a
 * game you paid for that appears in no library anywhere. That is precisely the
 * situation in which someone buys a game twice, so getting this wrong defeats
 * the point of the source.
 */
import * as humble from '../lib/humble.mjs';

let fails = 0;
const ok = (cond, msg) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); fails++; }
  else console.log(`  ok:   ${msg}`);
};

// --- a fake Humble account --------------------------------------------------
const ORDERS = {
  'order-1': {
    product: { human_name: 'Humble Indie Bundle 12' },
    tpkds: [
      { machine_name: 'hollow_knight', human_name: 'Hollow Knight',
        key_type: 'steam', redeemed_key_val: 'ABCDE-12345-FGHIJ' },
      { machine_name: 'celeste', human_name: 'Celeste',
        key_type: 'steam' },                              // never redeemed
    ],
    subproducts: [
      { machine_name: 'ost_celeste', human_name: 'Celeste Soundtrack' },   // no downloads
      { machine_name: 'vvvvvv', human_name: 'VVVVVV',
        downloads: [{ platform: 'windows' }], url: 'https://example.test/vvvvvv' },
    ],
  },
  'order-2': {
    product: { human_name: 'Humble Choice January' },
    tpkds: [
      // Same game as order-1, but this copy IS redeemed. The unredeemed copy
      // must win, since it carries information Steam cannot provide.
      { machine_name: 'celeste', human_name: 'Celeste',
        key_type: 'steam', redeemed_key_val: 'ZZZZZ-99999-YYYYY' },
      { machine_name: 'gifted', human_name: 'A Gifted Game',
        key_type: 'steam', is_gift: true },               // given away
      { machine_name: 'gog_game', human_name: 'A GOG Game', key_type: 'gog' },
    ],
  },
};

const realFetch = globalThis.fetch;
let requests = 0;
globalThis.fetch = async (url, opts) => {
  requests++;
  const u = String(url);
  const cookie = opts?.headers?.Cookie ?? '';
  const json = (o, status = 200) => ({
    ok: status < 400, status, headers: new Map(),
    text: async () => JSON.stringify(o),
  });

  if (!/_simpleauth_sess=good/.test(cookie)) {
    return { ok: false, status: 401, headers: new Map(), text: async () => '<html>Unauthorized</html>' };
  }
  if (u.includes('/api/v1/user/order')) {
    return json(Object.keys(ORDERS).map((gamekey) => ({ gamekey })));
  }
  const m = u.match(/\/api\/v1\/order\/([^?]+)/);
  if (m && ORDERS[m[1]]) return json(ORDERS[m[1]]);
  return { ok: false, status: 404, headers: new Map(), text: async () => '' };
};

try {
  console.log('An expired or wrong cookie is reported clearly');
  // Fresh, because a cached answer would "verify" a cookie that had already
  // expired. This exact bug was caught by running the suite twice: the second
  // run served the first run's library to a session that had been rejected.
  let msg = '';
  await humble.ownedGames({ HUMBLE_SESSION: 'bad' }, { fresh: true }).catch((e) => { msg = e.message; });
  ok(/401/.test(msg) && /humble-auth/.test(msg), `explains how to fix it: ${msg.slice(0, 72)}...`);
  ok(!msg.includes('bad'), 'and does not echo the cookie value');

  console.log('\nA rejected session is never answered from another session\'s cache');
  // Populate the cache under a good session, then confirm a bad one still fails.
  await humble.ownedGames({ HUMBLE_SESSION: 'good' });
  msg = '';
  await humble.ownedGames({ HUMBLE_SESSION: 'bad' }).catch((e) => { msg = e.message; });
  ok(/401/.test(msg), 'a different session does not inherit the cached library');

  console.log('\nReads keys and DRM-free products from every order');
  const games = await humble.ownedGames({ HUMBLE_SESSION: 'good' });
  const byTitle = Object.fromEntries(games.map((g) => [g.title, g]));
  ok(Boolean(byTitle['Hollow Knight']), 'found a redeemed Steam key');
  ok(Boolean(byTitle['Celeste']), 'found a key present in two orders');
  ok(Boolean(byTitle['VVVVVV']), 'found a DRM-free product');
  ok(Boolean(byTitle['A GOG Game']), 'found a non-Steam key');

  console.log('\nItems with nothing to download are not games');
  ok(!byTitle['Celeste Soundtrack'], 'a soundtrack with no downloads is skipped');

  console.log('\nUnredeemed keys are identified - the whole point of this source');
  ok(byTitle['Celeste'].unredeemed === true,
     'the UNREDEEMED copy wins over the redeemed duplicate');
  ok(byTitle['Hollow Knight'].unredeemed === false, 'a redeemed key is not flagged');
  ok(byTitle['A GOG Game'].unredeemed === true, 'an unredeemed GOG key is flagged');
  ok(byTitle['VVVVVV'].unredeemed === false, 'DRM-free is owned outright, never "unredeemed"');

  console.log('\nA redeemed Steam key is marked as already covered by Steam');
  ok(byTitle['Hollow Knight'].alsoOnSteam === true, 'redeemed Steam key marked as duplicated in Steam');
  ok(byTitle['A GOG Game'].alsoOnSteam === false, 'a GOG key is not');
  ok(byTitle['Celeste'].alsoOnSteam === false, 'an unredeemed Steam key is NOT claimed to be in Steam');

  console.log('\nGifted keys are not counted as yours');
  ok(!byTitle['A Gifted Game']?.unredeemed, 'a gift is not reported as an unredeemed purchase');

  console.log('\nBundle provenance is kept, so a result can say where it came from');
  ok(byTitle['Hollow Knight'].bundle === 'Humble Indie Bundle 12', 'bundle name recorded');

  console.log('\nSummary counts what the auth tool reports back');
  // The cache would otherwise answer instantly with the previous result.
  const s = await humble.summary({ HUMBLE_SESSION: 'good' });
  ok(s.total === games.length, `total matches (${s.total})`);
  ok(s.unredeemed === games.filter((g) => g.unredeemed).length, `unredeemed counted (${s.unredeemed})`);
  ok(s.drmFree === 1, `DRM-free counted (${s.drmFree})`);
} finally {
  globalThis.fetch = realFetch;
}

console.log('');
if (fails) { console.log(`${fails} assertion(s) failed.`); process.exit(1); }
console.log('All Humble tests passed.');
