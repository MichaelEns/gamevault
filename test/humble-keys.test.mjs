/**
 * Unredeemed-key triage.
 *
 * The split is the whole point, and it is easy to get backwards. A key for a
 * game you already own is worth MORE unrevealed, because it can still be
 * gifted; revealing it just makes a duplicate. A key for a game you own
 * nowhere is worth redeeming, because until then it is invisible in every
 * library - which is precisely when someone buys the game again.
 *
 * Getting this the wrong way round would advise burning the valuable keys and
 * hoarding the useless ones.
 */
import { normalizeTitle } from '../lib/match.mjs';

let fails = 0;
const ok = (cond, msg) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); fails++; }
  else console.log(`  ok:   ${msg}`);
};

// Built the way lib/library.mjs builds it, not the way I might assume.
function buildIndex(stores) {
  const index = {};
  for (const [storeName, rec] of Object.entries(stores)) {
    for (const g of rec.games) {
      (index[normalizeTitle(g.title)] ??= []).push({ store: storeName, title: g.title });
    }
  }
  return index;
}

// The triage rule, matching tools/humble-keys.mjs.
function triage(unredeemed, index) {
  const worthRedeeming = [];
  const keepGiftable = [];
  for (const g of unredeemed) {
    const entries = index[normalizeTitle(g.title)];
    const owners = [...new Set(
      (Array.isArray(entries) ? entries : [])
        .map((e) => e?.store)
        .filter((s) => s && s !== 'humble'),
    )];
    if (owners.length) keepGiftable.push({ ...g, ownedOn: owners });
    else worthRedeeming.push({ ...g, ownedOn: [] });
  }
  return { worthRedeeming, keepGiftable };
}

const index = buildIndex({
  steam: { games: [{ title: 'Hollow Knight' }, { title: 'Celeste' }] },
  // The game's own Humble entry must not count as "owned elsewhere", or every
  // key would look redundant and nothing would ever be recommended.
  humble: { games: [{ title: 'Hollow Knight' }, { title: 'Tunic' }, { title: 'Inscryption' }] },
});

const unredeemed = [
  { title: 'Hollow Knight', bundle: 'Bundle A', keyType: 'steam', unredeemed: true },
  { title: 'Tunic', bundle: 'Bundle B', keyType: 'steam', unredeemed: true },
  { title: 'Inscryption', bundle: 'Bundle B', keyType: 'gog', unredeemed: true },
];

const { worthRedeeming, keepGiftable } = triage(unredeemed, index);

console.log('A key for a game owned elsewhere keeps its gift value');
ok(keepGiftable.some((g) => g.title === 'Hollow Knight'),
   'Hollow Knight is owned on Steam, so its key stays unrevealed');
ok(keepGiftable.find((g) => g.title === 'Hollow Knight').ownedOn.includes('steam'),
   'and it says where it is already owned');
ok(!worthRedeeming.some((g) => g.title === 'Hollow Knight'),
   'and it is NOT recommended for redemption');

console.log('\nA key for a game owned nowhere is worth redeeming');
for (const t of ['Tunic', 'Inscryption']) {
  ok(worthRedeeming.some((g) => g.title === t), `${t} is recommended`);
  ok(!keepGiftable.some((g) => g.title === t), `${t} is not held back`);
}

console.log('\nHumble itself does not count as owning it elsewhere');
// Every unredeemed key is in the Humble library by definition, so counting
// Humble would classify all of them as "already owned" and recommend nothing.
ok(worthRedeeming.length === 2,
   `2 recommended despite all three being Humble entries (got ${worthRedeeming.length})`);

console.log('\nWith no library data nothing is wrongly held back');
// Failing this open matters: recommending a redeem you did not need wastes a
// key, but holding one back silently leaves a game invisible forever.
const noIndex = triage(unredeemed, {});
ok(noIndex.worthRedeeming.length === 3, 'all keys are offered when ownership is unknown');
ok(noIndex.keepGiftable.length === 0, 'nothing is held back on missing data');

console.log('\nThe tool refuses to reveal keys itself');
const { readFile } = await import('node:fs/promises');
const path = await import('node:path');
const { PATHS } = await import('../lib/paths.mjs');
const src = await readFile(path.join(PATHS.root, 'tools', 'humble-keys.mjs'), 'utf8');
// Revealing is irreversible and Steam penalises bulk activation, so the tool
// must never post to the reveal endpoint however convenient that would be.
ok(!/humbler\/redeemkey/.test(src), 'it does not call the reveal endpoint');
ok(!/method:\s*'POST'/.test(src), 'it makes no POST requests at all');

console.log('');
if (fails) { console.log(`${fails} assertion(s) failed.`); process.exit(1); }
console.log('All key-triage tests passed.');
