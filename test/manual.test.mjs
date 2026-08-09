/**
 * Manual-library tests.
 *
 * The realistic input is a paste from a store page, so the parsing has to
 * survive bullets, numbering, blank lines and stray separators -- and the
 * result must be indistinguishable from API-synced ownership.
 */
import { setStore, clearStore, load, ownedGames, summary, MANUAL_STORES } from '../lib/manual.mjs';
import { normalizeTitle } from '../lib/match.mjs';

let fails = 0;
const ok = (cond, msg) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); fails++; }
  else console.log(`  ok:   ${msg}`);
};

// Isolate from the real library.
process.env.GAMEVAULT_DATA_DIR = process.env.GAMEVAULT_DATA_DIR ?? '';

console.log('Store registry');
ok(Boolean(MANUAL_STORES.amazon), 'Amazon Prime Gaming is a manual store');
ok(Boolean(MANUAL_STORES.nintendo), 'Nintendo eShop is a manual store');
let threw = false;
try { await setStore('not-a-store', 'x'); } catch { threw = true; }
ok(threw, 'unknown store is rejected');

console.log('\nPaste parsing');
const messy = `
  Fallout 76
  - Baldur's Gate: Dark Alliance
  1. Tomb Raider
  2) Rise of the Tomb Raider

  Star Wars: Knights of the Old Republic
  • Dead Space
`;
const rec = await setStore('amazon', messy);
const titles = rec.titles;
ok(titles.length === 6, `parsed 6 titles from a messy paste (got ${titles.length})`);
ok(titles.includes('Fallout 76'), 'plain line kept');
ok(titles.includes("Baldur's Gate: Dark Alliance"), 'leading dash stripped');
ok(titles.includes('Tomb Raider'), '"1." numbering stripped');
ok(titles.includes('Rise of the Tomb Raider'), '"2)" numbering stripped');
ok(titles.includes('Dead Space'), 'bullet character stripped');
ok(!titles.some((t) => t === ''), 'blank lines dropped');

console.log('\nComma-separated input also works');
const nin = await setStore('nintendo', 'Metroid Dread, Hades, Celeste');
ok(nin.titles.length === 3, `comma list -> 3 titles (got ${nin.titles.length})`);

console.log('\nDeduplication');
const dup = await setStore('other', 'Hades\nhades\n  Hades  \nHades™');
ok(dup.titles.length === 1, `case/space/trademark variants collapse to 1 (got ${dup.titles.length})`);

console.log('\nSequels must NOT be collapsed');
const seq = await setStore('other', 'Hades\nHades II');
ok(seq.titles.length === 2, 'Hades and Hades II are kept separate');

console.log('\nFlattened output matches the API-provider shape');
const owned = await ownedGames();
const sample = owned.find((g) => g.store === 'nintendo');
ok(Boolean(sample), 'nintendo entries present');
ok(sample.manual === true, 'entries are flagged manual');
ok('title' in sample && 'store' in sample && 'id' in sample, 'same fields as synced providers');
ok(owned.some((g) => g.store === 'amazon'), 'amazon entries present');

console.log('\nNormalisation is shared with the matcher (so lookups agree)');
ok(normalizeTitle(sample.title).length > 0, 'manual titles normalise like store titles');

console.log('\nSummary + clearing');
const s = await summary();
ok(s.amazon.count === 6, `summary counts amazon (${s.amazon.count})`);
ok(typeof s.amazon.reason === 'string', 'summary explains why the store is manual');
await clearStore('amazon');
await clearStore('nintendo');
await clearStore('other');
const after = await load();
ok(!after.amazon && !after.nintendo && !after.other, 'cleared stores are removed');

console.log('');
if (fails) { console.log(`${fails} assertion(s) failed.`); process.exit(1); }
console.log('All manual-library tests passed.');
