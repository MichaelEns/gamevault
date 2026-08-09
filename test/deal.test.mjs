import { scoreDeal, bestOffer, VERDICT } from '../lib/deal.mjs';

let fails = 0;
const ok = (cond, msg) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); fails++; }
  else console.log(`  ok:   ${msg}`);
};
const v = (o) => scoreDeal(o).verdict;

console.log('Ownership and subscription outrank every price signal');
ok(v({ owned: true, current: 0.01, regular: 60, low: 0.01 }) === VERDICT.OWNED,
   'owned wins even at an all-time-low price');
ok(v({ owned: false, access: [{ label: 'PC Game Pass', entitled: true }], current: 5, regular: 60, low: 4 })
   === VERDICT.INCLUDED, 'subscription access beats a cheap price');
ok(v({ owned: false, current: 0, regular: 20, low: 0 }) === VERDICT.FREE, 'free is free');

console.log('\nSubscription ENTITLEMENT — a tier you do not have must not count');
const consoleOnly = scoreDeal({
  owned: false,
  access: [{ label: 'Console Game Pass', entitled: false }],
  current: 17.99, regular: 59.99, low: 14.99,
});
ok(consoleOnly.verdict !== VERDICT.INCLUDED,
   `console-only title is NOT "included" for a PC subscriber (got ${consoleOnly.verdict})`);
ok(consoleOnly.reason.includes('does not include'),
   'and it says why: the plan does not cover that tier');
ok(scoreDeal({
     owned: false,
     access: [{ label: 'Console Game Pass', entitled: false }, { label: 'PC Game Pass', entitled: true }],
     current: 17.99, regular: 59.99,
   }).verdict === VERDICT.INCLUDED,
   'one entitled tier among several is enough');
ok(scoreDeal({ owned: false, access: [{ label: 'X' }], current: 5, regular: 60 }).verdict === VERDICT.INCLUDED,
   'legacy hits with no entitled flag still count (backwards compatible)');

console.log('\nHistorical low drives the verdict');
ok(v({ owned: false, current: 9.99, regular: 60, low: 12.99 }) === VERDICT.BEST_EVER,
   'below previous low -> best ever');
ok(v({ owned: false, current: 12.99, regular: 60, low: 12.99 }) === VERDICT.MATCHES_LOW,
   'equal to low -> matches low');
ok(v({ owned: false, current: 13.50, regular: 60, low: 12.99 }) === VERDICT.NEAR_LOW,
   'within 10% of low -> near low');
ok(v({ owned: false, current: 15.00, regular: 60, low: 12.99 }) === VERDICT.GOOD,
   '~16% above low -> good');
ok(v({ owned: false, current: 19.00, regular: 60, low: 12.99 }) === VERDICT.MEH,
   '~46% above low -> meh');
ok(v({ owned: false, current: 45.00, regular: 60, low: 12.99 }) === VERDICT.WAIT,
   'far above low -> wait');

console.log('\nA big headline discount does NOT beat price history');
const trap = scoreDeal({ owned: false, current: 29.99, regular: 119.99, low: 11.99 });
ok(trap.verdict === VERDICT.WAIT,
   `75% off but 2.5x the all-time low -> ${trap.verdict} (not "good")`);

console.log('\nNo history: fall back to discount, and admit the uncertainty');
ok(v({ owned: false, current: 20, regular: 60 }) === VERDICT.GOOD, '67% off -> good');
ok(v({ owned: false, current: 42, regular: 60 }) === VERDICT.MEH, '30% off -> meh');
ok(v({ owned: false, current: 57, regular: 60 }) === VERDICT.WAIT, '5% off -> wait');
ok(v({ owned: false, current: 60, regular: 60 }) === VERDICT.FULL_PRICE, 'no discount -> full price');
ok(scoreDeal({ owned: false, current: 20, regular: 60 }).reason.includes('ITAD'),
   'says why confidence is limited when history is missing');

console.log('\nMissing data is reported, not guessed');
ok(v({ owned: false, current: null }) === VERDICT.UNKNOWN, 'null price -> unknown');

console.log('\nbestOffer picks the cheapest priced deal');
const best = bestOffer([
  { shop: 'Steam', price: { amount: 24.99 } },
  { shop: 'Fanatical', price: { amount: 17.49 } },
  { shop: 'Epic', price: null },
]);
ok(best?.shop === 'Fanatical', `cheapest is Fanatical (${best?.price?.amount})`);
ok(bestOffer([]) === null, 'no deals -> null');
ok(bestOffer([{ shop: 'X', price: null }]) === null, 'unpriced only -> null');

console.log('');
if (fails) { console.log(`${fails} assertion(s) failed.`); process.exit(1); }
console.log('All deal-scoring tests passed.');
