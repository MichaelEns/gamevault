// Verify the subscription-access claims against the real live roster.
// A false "included" is the expensive error: it tells you NOT to buy
// something you actually would have to buy.
import { collection, allCollections, findAccess } from '../lib/gamepass.mjs';

const pc = await collection('pc');
console.log(`PC Game Pass roster: ${pc.count} titles\n`);

console.log('Entries matching /hades/:');
for (const h of pc.games.filter((g) => /hades/i.test(g.title))) {
  console.log(`  - ${h.title}   [norm: ${h.norm}]`);
}

const subs = await allCollections();
console.log('\nfindAccess() results:');
for (const t of ['Hades', 'Hades II', 'Elden Ring', 'Cyberpunk 2077', 'Forza Horizon 5']) {
  const hits = findAccess(t, subs);
  console.log(`  ${t.padEnd(18)} -> ${hits.length ? hits.map((h) => h.label).join(', ') : 'not included'}`);
}
