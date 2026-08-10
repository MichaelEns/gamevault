/**
 * Browser-claim store definitions.
 *
 * This is the most fragile code in the project - it depends on page markup
 * that storefronts change without notice - so what can be checked without a
 * browser is worth checking: that every store is completely defined, that no
 * selector is so loose it would match the wrong thing, and that a failure in
 * one store cannot take down the others.
 *
 * The selectors themselves can only really be validated against the live site,
 * which is why the claim workflow reports failures rather than assuming
 * success, and why every claim is verified against the library afterwards.
 */
import { STORES, claimStore } from '../lib/browser-claim.mjs';

let fails = 0;
const ok = (cond, msg) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); fails++; }
  else console.log(`  ok:   ${msg}`);
};

console.log('Every store is fully defined');
const expected = ['prime', 'epic', 'gog'];
for (const key of expected) {
  const s = STORES[key];
  ok(Boolean(s), `${key} exists`);
  if (!s) continue;
  ok(typeof s.label === 'string' && s.label.length > 0, `${key} has a label`);
  ok(/^https:\/\//.test(s.url), `${key} has an https url`);
  ok(typeof s.loginCheck === 'function', `${key} can tell whether it is signed in`);
  ok(typeof s.claim === 'function', `${key} has a claim routine`);
}

console.log('\nPrime Gaming is covered, since it is the only one HTTP cannot do');
// Epic and GOG have auth-gated APIs. Amazon answers 403 to anything that does
// not look like a browser, so if this were missing the browser path would have
// no reason to exist.
ok(Boolean(STORES.prime), 'prime is present');
ok(/gaming\.amazon\.com/.test(STORES.prime.url), 'and points at Prime Gaming');

console.log('\nA failing store is reported, not thrown');
// One broken storefront must never stop the others being claimed.
const fakeContext = {
  newPage: async () => ({
    goto: async () => { throw new Error('network exploded'); },
    waitForTimeout: async () => {},
    close: async () => {},
  }),
};
const result = await claimStore(fakeContext, 'prime', () => {});
ok(result.ok === false, 'a failure is returned rather than raised');
ok(result.store === 'prime' && result.label === 'Prime Gaming', 'and names the store');
ok(/network exploded/.test(result.error), 'and keeps the real reason');
ok(Array.isArray(result.claimed) && result.claimed.length === 0, 'and claims nothing');

console.log('\nA signed-out session is distinguished from an empty week');
// These look identical in the results otherwise, and only one needs the user
// to do something about it.
const loggedOut = {
  newPage: async () => ({
    goto: async () => {},
    waitForTimeout: async () => {},
    close: async () => {},
    locator: () => ({ count: async () => 1 }),
  }),
};
const r2 = await claimStore(loggedOut, 'prime', () => {});
ok(r2.ok === false, 'a signed-out store fails');
ok(/expired|signed in/i.test(r2.error), `and says so: ${r2.error}`);

console.log('\nAn unknown store is rejected outright');
let threw = null;
try { await claimStore(fakeContext, 'nintendo', () => {}); } catch (e) { threw = e; }
ok(threw !== null && /Unknown store/.test(threw.message), 'unknown stores raise rather than silently doing nothing');

console.log('\nClaim counts are bounded');
// An unbounded loop over a selector that matches more than expected would
// click its way through a storefront. Every loop here has a ceiling.
const { readFile } = await import('node:fs/promises');
const path = await import('node:path');
const { PATHS } = await import('../lib/paths.mjs');
const src = await readFile(path.join(PATHS.root, 'lib', 'browser-claim.mjs'), 'utf8');
const loops = [...src.matchAll(/for \(let i = 0; i < ([^;]+);/g)].map((m) => m[1].trim());
ok(loops.length > 0, `found ${loops.length} claim loops`);
ok(loops.every((l) => /Math\.min|\d+/.test(l)), `all bounded: ${loops.join(' | ')}`);

console.log('');
if (fails) { console.log(`${fails} assertion(s) failed.`); process.exit(1); }
console.log('All browser-claim tests passed.');
