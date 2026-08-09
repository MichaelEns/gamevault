/**
 * Amazon Games (nile) provider tests.
 *
 * The credentialed path cannot be tested here, but the two things that
 * actually break in the field can: parsing nile's output shape, and
 * degrading honestly when nile is absent or logged out.
 */
import { parseLibrary, authStatus } from '../lib/amazon.mjs';

let fails = 0;
const ok = (cond, msg) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); fails++; }
  else console.log(`  ok:   ${msg}`);
};

console.log('parseLibrary -- nile entitlement shape { product: { id, title } }');
const real = JSON.stringify([
  { product: { id: 'amzn1.adg.product.abc', title: 'Fallout 76' } },
  { product: { id: 'amzn1.adg.product.def', title: 'Tomb Raider' } },
  { product: { id: 'amzn1.adg.product.ghi', title: 'Dead Space' } },
]);
const parsed = parseLibrary(real);
ok(parsed.length === 3, `parsed 3 games (got ${parsed.length})`);
ok(parsed[0].store === 'amazon', 'tagged with store=amazon');
ok(parsed[0].title === 'Fallout 76', 'title extracted from product.title');
ok(parsed[0].id === 'amzn1.adg.product.abc', 'id extracted from product.id');

console.log('\nAdd-ons must not count as owning a game');
const withAddons = JSON.stringify([
  { product: { id: '1', title: 'Fallout 76' } },
  { product: { id: '2', title: 'Fallout 76 Soundtrack' } },
  { product: { id: '3', title: 'Game X Season Pass' } },
  { product: { id: '4', title: 'Game Y Demo' } },
]);
const filtered = parseLibrary(withAddons);
ok(filtered.length === 1, `only the base game survives (got ${filtered.length})`);
ok(filtered[0].title === 'Fallout 76', 'and it is the right one');

console.log('\nFlat shape (defensive -- nile could change)');
ok(parseLibrary(JSON.stringify([{ id: 'x', title: 'Some Game' }])).length === 1,
   'falls back to a flat {id,title} entry');

console.log('\nMalformed output must return [] rather than throw');
for (const bad of ['', 'not json', '[', 'null', '{}', '[{"product":{}}]', undefined]) {
  let threw = false;
  let out = null;
  try { out = parseLibrary(bad); } catch { threw = true; }
  ok(!threw && Array.isArray(out), `safe on ${JSON.stringify(bad)?.slice(0, 20) ?? 'undefined'} -> []`);
}

console.log('\nnile chatter before the JSON must not break parsing');
const noisy = 'INFO: syncing library\nWARNING: something\n' + real;
ok(parseLibrary(noisy).length === 3, 'finds the JSON line among log output');

console.log('\nauthStatus degrades honestly when nile is absent');
const st = await authStatus();
ok(typeof st.installed === 'boolean', 'reports installed as a boolean');
ok(st.loggedIn === false || st.loggedIn === true, 'reports loggedIn');
if (!st.installed) {
  ok(st.account === null, 'no account claimed when nile is not installed');
  console.log('        (nile not installed here — that is expected on this machine)');
} else {
  console.log(`        (nile IS installed: loggedIn=${st.loggedIn})`);
}

console.log('');
if (fails) { console.log(`${fails} assertion(s) failed.`); process.exit(1); }
console.log('All Amazon provider tests passed.');
