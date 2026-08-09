/**
 * Library merge tests.
 *
 * Guards a bug introduced when Amazon gained a real API: manual entries were
 * REPLACING synced store records, so 3 hand-typed titles could silently
 * discard a 50-game nile sync.
 */
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(tmpdir(), 'gv-merge-'));
process.env.GAMEVAULT_DATA_DIR = dir;

// Import AFTER setting the data dir so PATHS resolves to the sandbox.
const { syncLibrary, loadLibrary, findOwned } = await import('../lib/library.mjs');
const { setStore } = await import('../lib/manual.mjs');

let fails = 0;
const ok = (cond, msg) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); fails++; }
  else console.log(`  ok:   ${msg}`);
};

// Simulate a completed nile sync by seeding the library file directly.
await mkdir(dir, { recursive: true });
await writeFile(path.join(dir, 'library.json'), JSON.stringify({
  syncedAt: new Date().toISOString(),
  stores: {
    amazon: {
      ok: true,
      count: 3,
      games: [
        { store: 'amazon', id: '1', title: 'Fallout 76' },
        { store: 'amazon', id: '2', title: 'Tomb Raider' },
        { store: 'amazon', id: '3', title: 'Dead Space' },
      ],
    },
  },
  index: {},
}), 'utf8');

console.log('Manual entries must MERGE into a synced store, not replace it');
await setStore('amazon', 'Batman: Arkham Knight\nFallout 76');   // 1 new + 1 duplicate
await syncLibrary({}, 'manual');

let lib = await loadLibrary();
const amazon = lib.stores.amazon;
ok(amazon.count === 4, `3 synced + 1 new manual = 4 (got ${amazon.count})`);
ok(amazon.games.some((g) => g.title === 'Tomb Raider'), 'synced title survived');
ok(amazon.games.some((g) => g.title === 'Batman: Arkham Knight'), 'manual title added');
ok(amazon.manualCount === 1, `only the non-duplicate counted as manual (got ${amazon.manualCount})`);

console.log('\nDuplicates across synced + manual are not double-counted');
ok(amazon.games.filter((g) => /fallout 76/i.test(g.title)).length === 1,
   'Fallout 76 appears once, not twice');

console.log('\nBoth sources are searchable');
ok(findOwned('Tomb Raider', lib).length === 1, 'synced title resolves');
ok(findOwned('Batman: Arkham Knight', lib).length === 1, 'manual title resolves');
ok(findOwned('Hades', lib).length === 0, 'unowned title does not resolve');

console.log('\nA purely-manual store still works on its own');
await setStore('nintendo', 'Metroid Dread');
await syncLibrary({}, 'manual');
lib = await loadLibrary();
ok(lib.stores.nintendo?.count === 1, 'nintendo store created from manual entries');
ok(lib.stores.nintendo.manual === true, 'flagged as manual (no API behind it)');

console.log('\nClearing a manual list removes a purely-manual store...');
await setStore('nintendo', '');
await syncLibrary({}, 'manual');
lib = await loadLibrary();
ok(!lib.stores.nintendo, 'nintendo removed');

console.log('...but must NOT delete a store that has real synced data');
await setStore('amazon', '');
await syncLibrary({}, 'manual');
lib = await loadLibrary();
ok(lib.stores.amazon?.count === 3, `amazon keeps its 3 synced games (got ${lib.stores.amazon?.count})`);

await rm(dir, { recursive: true, force: true });

console.log('');
if (fails) { console.log(`${fails} assertion(s) failed.`); process.exit(1); }
console.log('All library merge tests passed.');
