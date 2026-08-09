/**
 * Subscription entitlement tests.
 *
 * The failure this guards against: a title is on Console Game Pass but not
 * PC. A PC-only subscriber told "included" skips the purchase and then
 * cannot launch the game. Same expensive direction as a false ownership
 * claim, so it gets the same scrutiny.
 */
import { entitledCollections, findAccess, COLLECTIONS, PLANS } from '../lib/gamepass.mjs';

let fails = 0;
const ok = (cond, msg) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); fails++; }
  else console.log(`  ok:   ${msg}`);
};
const keys = (env) => entitledCollections(env).keys.sort().join(',');

console.log('Collections');
ok(Boolean(COLLECTIONS.cloud), 'Xbox Cloud Gaming is a tracked collection');
ok(Object.keys(COLLECTIONS).length === 4, '4 collections: pc, console, cloud, eaplay');

console.log('\nPlan -> collection mapping');
ok(keys({ SUBSCRIPTIONS: 'ultimate' }) === 'cloud,console,eaplay,pc',
   'ultimate grants everything (incl. cloud + EA Play)');
ok(keys({ SUBSCRIPTIONS: 'pc' }) === 'eaplay,pc', 'PC Game Pass grants PC + EA Play');
ok(keys({ SUBSCRIPTIONS: 'console' }) === 'console', 'console grants console only');
ok(keys({ SUBSCRIPTIONS: 'eaplay' }) === 'eaplay', 'standalone EA Play grants EA Play only');
ok(keys({ SUBSCRIPTIONS: 'none' }) === '', '"none" grants nothing');

console.log('\nInput handling');
ok(keys({ SUBSCRIPTIONS: 'pc,console' }) === 'console,eaplay,pc', 'comma list combines plans');
ok(keys({ SUBSCRIPTIONS: 'PC' }) === 'eaplay,pc', 'case-insensitive');
ok(keys({ SUBSCRIPTIONS: ' pc ,  console ' }) === 'console,eaplay,pc', 'whitespace tolerated');
ok(keys({ SUBSCRIPTIONS: 'cloud' }) === 'cloud', 'raw collection names accepted');
ok(keys({ SUBSCRIPTIONS: 'pc,bogus' }) === 'eaplay,pc', 'unknown tokens ignored, valid ones kept');

console.log('\nUnset defaults to everything, but flags the assumption');
const unset = entitledCollections({});
ok(unset.keys.length === 4, 'unset -> all collections');
ok(unset.assumed === true, 'and marks itself as assumed, so the UI can warn');
ok(entitledCollections({ SUBSCRIPTIONS: 'pc' }).assumed === false, 'explicit config is not assumed');

console.log('\nfindAccess tags each hit with entitlement');
const fake = {
  pc: { label: 'PC Game Pass', games: [{ title: 'Hades', norm: 'hades' }] },
  console: { label: 'Console Game Pass', games: [
    { title: 'Hades', norm: 'hades' },
    { title: 'Cyberpunk 2077', norm: 'cyberpunk 2077' },
  ] },
};

const hades = findAccess('Hades', fake, ['pc', 'eaplay']);
ok(hades.length === 2, 'Hades found in both collections');
ok(hades.find((h) => h.service === 'pc').entitled === true, 'PC hit is entitled');
ok(hades.find((h) => h.service === 'console').entitled === false, 'console hit is NOT entitled');

const cp = findAccess('Cyberpunk 2077', fake, ['pc', 'eaplay']);
ok(cp.length === 1, 'Cyberpunk found only on console');
ok(cp[0].entitled === false, 'and correctly marked un-entitled for a PC subscriber');

const cpUltimate = findAccess('Cyberpunk 2077', fake, ['pc', 'console', 'cloud', 'eaplay']);
ok(cpUltimate[0].entitled === true, 'an Ultimate subscriber IS entitled to the console tier');

console.log('\nStill never fuzzy-matches (a false "free" is expensive)');
ok(findAccess('Hades II', fake, ['pc']).length === 0, 'Hades II is not confused with Hades');
ok(findAccess('Cyberpunk', fake, ['console']).length === 0, 'partial title does not match');

console.log('');
if (fails) { console.log(`${fails} assertion(s) failed.`); process.exit(1); }
console.log('All subscription entitlement tests passed.');
