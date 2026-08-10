/**
 * Price budget allocation.
 *
 * This is pinned because its failure mode is invisible. An earlier version
 * took the first N of a combined list, which meant 1,400 owned titles ate the
 * entire budget and every searchable game got nothing - a build that looked
 * completely healthy and answered the one question it existed to answer with
 * silence.
 */
import { selectPriceTargets } from '../lib/price-budget.mjs';

let fails = 0;
const ok = (cond, msg) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); fails++; }
  else console.log(`  ok:   ${msg}`);
};

const owned = Array.from({ length: 1414 }, (_, i) => `Owned Game ${i}`);
const trending = Array.from({ length: 200 }, (_, i) => `Trending Game ${i}`);
const watchlist = ['007 First Light'];

console.log('A large library does not crowd out the games you might buy');
{
  const { targets, counts } = selectPriceTargets({ watchlist, trending, owned, cap: 800 });
  ok(counts.watchlist === 1, `the watchlist is priced (${counts.watchlist}/1)`);
  ok(counts.trending === 200, `every trending title is priced (${counts.trending}/200)`);
  ok(counts.owned === 0, 'owned titles are skipped by default');
  ok(targets.length === 201, `so the build spends 201 lookups, not 800 (got ${targets.length})`);
  ok(targets[0] === '007 First Light', 'the watchlist goes first');
  ok(!targets.some((t) => t.startsWith('Owned Game')), 'and no owned title is in the list');
}

console.log('\nPRICE_OWNED restores the old behaviour without losing priority');
{
  const { targets, counts } = selectPriceTargets({ watchlist, trending, owned, cap: 800, priceOwned: true });
  ok(targets.length === 800, `the cap is respected (${targets.length})`);
  ok(counts.watchlist === 1 && counts.trending === 200,
     'watchlist and trending still come first, in full');
  ok(counts.owned === 599, `owned fills the remainder (${counts.owned})`);
  ok(counts.dropped === 1414 - 599, `and the shortfall is reported (${counts.dropped})`);
}

console.log('\nA title is never priced twice');
{
  const { targets } = selectPriceTargets({
    watchlist: ['Celeste'],
    trending: ['celeste', 'CELESTE ', 'Hades'],
    owned: ['Celeste'],
    priceOwned: true,
  });
  ok(targets.length === 2, `Celeste/celeste/CELESTE collapse to one (got ${targets.length})`);
  ok(targets[0] === 'Celeste' && targets[1] === 'Hades', 'the first spelling wins, order preserved');
}

console.log('\nCounts describe what survived the cap, not what was requested');
{
  const { counts, targets } = selectPriceTargets({
    watchlist: ['A', 'B', 'C'], trending: ['D', 'E'], owned: ['F'], cap: 4, priceOwned: true,
  });
  ok(targets.length === 4, 'the cap is honoured');
  ok(counts.watchlist === 3, 'all three watchlist entries fit');
  ok(counts.trending === 1, `only one trending title fit, and says so (got ${counts.trending})`);
  ok(counts.owned === 0, 'nothing owned fit');
  ok(counts.dropped === 2, `two titles were dropped (got ${counts.dropped})`);
}

console.log('\nJunk input cannot poison the list');
{
  const { targets } = selectPriceTargets({
    watchlist: ['  Spaced  ', '', '   ', null, undefined, 'Real'],
    trending: [],
  });
  ok(targets.length === 2, `empties and nulls are dropped (got ${targets.length})`);
  ok(targets[0] === 'Spaced', 'and titles are trimmed');
}

console.log('\nDegenerate caps fall back rather than pricing nothing');
for (const [label, cap] of [['empty string', ''], ['zero', 0], ['NaN', Number.NaN], ['negative', -5]]) {
  const { targets } = selectPriceTargets({ trending, cap: Number(cap) });
  ok(targets.length === 200, `${label} cap -> default, not silence (got ${targets.length})`);
}

console.log('\nNo input at all is survivable');
{
  const { targets, counts } = selectPriceTargets();
  ok(targets.length === 0 && counts.dropped === 0, 'returns an empty plan without throwing');
}

if (fails) { console.log(`\n${fails} assertion(s) failed.`); process.exit(1); }
console.log('\nAll price-budget assertions passed.');
