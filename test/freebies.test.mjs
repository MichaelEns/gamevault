/**
 * Free-to-keep detection.
 *
 * Two rules that are easy to conflate, and they pull in opposite directions:
 *
 *   owned on THAT store      -> nothing to claim, hide it
 *   owned on ANOTHER store   -> still claim it, a free permanent copy on a
 *                               second store costs nothing
 *
 * Getting the first wrong wastes your time; getting the second wrong loses you
 * a free game. Neither is acceptable, so both are pinned here.
 */
import { epicFreeGames, annotateOwnership, timeLeft } from '../lib/freebies.mjs';

let fails = 0;
const ok = (cond, msg) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); fails++; }
  else console.log(`  ok:   ${msg}`);
};

const HOUR = 3600000;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

// Epic's real payload shape, including the cases that must NOT be reported.
const PAYLOAD = {
  data: { Catalog: { searchStore: { elements: [
    {
      title: 'Beacon Pines', id: 'offer-1', namespace: 'ns-1',
      catalogNs: { mappings: [{ pageSlug: 'beacon-pines-629fc3' }] },
      promotions: { promotionalOffers: [{ promotionalOffers: [{
        startDate: iso(now - HOUR), endDate: iso(now + 48 * HOUR),
        discountSetting: { discountPercentage: 0 },
      }] }] },
    },
    {
      // Owned on Epic already -> not worth claiming.
      title: 'We Were Here Together', id: 'offer-2', namespace: 'ns-2',
      catalogNs: { mappings: [{ pageSlug: 'we-were-here-together' }] },
      promotions: { promotionalOffers: [{ promotionalOffers: [{
        startDate: iso(now - HOUR), endDate: iso(now + 24 * HOUR),
        discountSetting: { discountPercentage: 0 },
      }] }] },
    },
    {
      // Owned on STEAM -> still worth a free Epic copy.
      title: 'Celeste', id: 'offer-3', namespace: 'ns-3',
      catalogNs: { mappings: [{ pageSlug: 'celeste' }] },
      promotions: { promotionalOffers: [{ promotionalOffers: [{
        startDate: iso(now - HOUR), endDate: iso(now + 12 * HOUR),
        discountSetting: { discountPercentage: 0 },
      }] }] },
    },
    {
      // UPCOMING, not yet live -> must not be reported as claimable.
      title: 'Future Giveaway', id: 'offer-4', namespace: 'ns-4',
      catalogNs: { mappings: [{ pageSlug: 'future' }] },
      promotions: { promotionalOffers: [{ promotionalOffers: [{
        startDate: iso(now + 72 * HOUR), endDate: iso(now + 168 * HOUR),
        discountSetting: { discountPercentage: 0 },
      }] }] },
    },
    {
      // An ordinary 80% discount is not free.
      title: 'Merely Discounted', id: 'offer-5', namespace: 'ns-5',
      catalogNs: { mappings: [{ pageSlug: 'discounted' }] },
      promotions: { promotionalOffers: [{ promotionalOffers: [{
        startDate: iso(now - HOUR), endDate: iso(now + HOUR),
        discountSetting: { discountPercentage: 20 },
      }] }] },
    },
    {
      // Expired.
      title: 'Last Week', id: 'offer-6', namespace: 'ns-6',
      catalogNs: { mappings: [{ pageSlug: 'last-week' }] },
      promotions: { promotionalOffers: [{ promotionalOffers: [{
        startDate: iso(now - 200 * HOUR), endDate: iso(now - HOUR),
        discountSetting: { discountPercentage: 0 },
      }] }] },
    },
    { title: 'No Promotions At All', id: 'offer-7', namespace: 'ns-7', promotions: null },
  ] } } },
};

const realFetch = globalThis.fetch;
globalThis.fetch = async () => ({
  ok: true, status: 200, headers: new Map(),
  text: async () => JSON.stringify(PAYLOAD),
});

let free;
try {
  // A unique country avoids the on-disk cache from an earlier run.
  free = await epicFreeGames(`T${Date.now()}`);
} finally {
  globalThis.fetch = realFetch;
}

console.log('Only games that are actually free RIGHT NOW are reported');
const titles = free.map((g) => g.title);
ok(titles.includes('Beacon Pines'), 'a live 100%-off promotion is included');
ok(!titles.includes('Future Giveaway'), 'an upcoming giveaway is NOT claimable yet');
ok(!titles.includes('Merely Discounted'), 'an 80% discount is not free');
ok(!titles.includes('Last Week'), 'an expired giveaway is excluded');
ok(!titles.includes('No Promotions At All'), 'an entry with no promotions is ignored');
ok(free.length === 3, `three live giveaways (got ${free.length})`);

console.log('\nClaim links point at the actual store page');
const bp = free.find((g) => g.title === 'Beacon Pines');
ok(bp.url.includes('beacon-pines-629fc3'), `slug resolved: ${bp.url}`);
ok(Boolean(bp.namespace && bp.offerId), 'namespace and offer id captured');

console.log('\nOwned on THAT store -> nothing to do');
const index = {
  'we were here together': { epic: true },
  celeste: { steam: true },
};
const annotated = annotateOwnership(free, index);
const wwht = annotated.find((g) => g.title === 'We Were Here Together');
ok(wwht.ownedHere === true, 'recognised as already owned on Epic');
ok(wwht.worthClaiming === false, 'and therefore not worth claiming');

console.log('\nOwned on ANOTHER store -> still worth claiming');
// The rule most easily got backwards: a Steam copy is no reason to decline a
// free permanent Epic copy.
const celeste = annotated.find((g) => g.title === 'Celeste');
ok(celeste.ownedHere === false, 'not owned on Epic');
ok(celeste.worthClaiming === true, 'so it IS worth claiming');
ok(celeste.ownedElsewhere.includes('steam'), 'and it says where you already own it');

console.log('\nOwned nowhere -> worth claiming, with nothing to explain');
ok(bp.namespace !== null, 'sanity');
const bpA = annotated.find((g) => g.title === 'Beacon Pines');
ok(bpA.worthClaiming === true, 'worth claiming');
ok(bpA.ownedElsewhere.length === 0, 'no other-store note to show');

console.log('\nAn empty library never suppresses a giveaway');
// Failing open matters: if ownership data is missing, showing a game you
// already have wastes a click, but hiding one loses it permanently.
const noIndex = annotateOwnership(free, {});
ok(noIndex.every((g) => g.worthClaiming), 'with no library, everything is offered');

console.log('\nTime remaining reads the way a person would say it');
ok(timeLeft(iso(now + 3 * HOUR), now) === '3 hours left', timeLeft(iso(now + 3 * HOUR), now));
ok(timeLeft(iso(now + 72 * HOUR), now) === '3 days left', timeLeft(iso(now + 72 * HOUR), now));
ok(timeLeft(iso(now + 30 * 60000), now).includes('minutes'), timeLeft(iso(now + 30 * 60000), now));
ok(timeLeft(iso(now - HOUR), now) === 'ended', 'an expired window says so');

console.log('');
if (fails) { console.log(`${fails} assertion(s) failed.`); process.exit(1); }
console.log('All freebie tests passed.');
