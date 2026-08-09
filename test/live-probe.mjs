// Ad-hoc live probes against the real storefronts. Not part of the test
// suite -- these hit the network and are for manual verification.
import { search as steamSearch } from '../lib/steam.mjs';
import { search as epicSearch } from '../lib/epic.mjs';

const term = process.argv[2] ?? 'hades';

for (const [name, fn] of [['STEAM', steamSearch], ['EPIC', epicSearch]]) {
  try {
    const r = await fn(term);
    console.log(`\n${name}: ${r.length} result(s)`);
    for (const x of r.slice(0, 5)) {
      const p = x.price?.current ? `$${x.price.current.amount.toFixed(2)}` : 'n/a';
      const d = x.price?.discountPct ? ` (-${x.price.discountPct}%)` : '';
      console.log(`  - ${x.title}  ${p}${d}`);
      if (x.url) console.log(`      ${x.url}`);
    }
  } catch (e) {
    console.log(`\n${name}: ERROR ${e.message}`);
  }
}
