/**
 * Triage unredeemed Humble keys.
 *
 * "Redeem them all" sounds obviously right and is not, because revealing a key
 * is irreversible and costs you something:
 *
 *   - An UNREVEALED key can still be gifted or traded. A revealed one is
 *     committed to whoever activates it. Humble warns about this precisely
 *     because it cannot be undone.
 *   - Bundles overlap heavily with Steam libraries, so a large share of
 *     unredeemed keys are for games already owned. Burning those converts
 *     something giftable into a duplicate that does nothing.
 *   - Steam rate-limits key activation and penalises failures: roughly ten
 *     bad attempts locks activation for an hour, and sustained abuse can
 *     restrict the account. Feeding it a long list of keys, some of which are
 *     already-owned or region-locked, is exactly how that happens.
 *
 * So this automates the part that is genuinely tedious and error-prone -
 * working out WHICH keys are worth redeeming - and leaves the irreversible
 * step to a deliberate decision.
 *
 *   node tools/humble-keys.mjs
 *
 * The interesting output is the split: keys for games you own nowhere are
 * worth redeeming, and keys for games already in your Steam library are worth
 * keeping exactly as they are.
 */
import { argv } from 'node:process';
import * as humble from '../lib/humble.mjs';
import { loadLibrary } from '../lib/library.mjs';
import { normalizeTitle } from '../lib/match.mjs';

const asJson = argv.includes('--json');

if (!process.env.HUMBLE_SESSION) {
  console.error('HUMBLE_SESSION is not set. Run "npm run humble-auth" first.');
  process.exit(1);
}

const [library, games] = await Promise.all([
  loadLibrary().catch(() => ({ index: {} })),
  humble.ownedGames(process.env),
]);
const index = library.index ?? {};

const unredeemed = games.filter((g) => g.unredeemed);
if (!unredeemed.length) {
  console.log('No unredeemed Humble keys. Everything is already claimed.');
  process.exit(0);
}

/** Where else this game is already owned, excluding Humble itself. */
function ownedElsewhere(title) {
  const entries = index[normalizeTitle(title)];
  return [...new Set(
    (Array.isArray(entries) ? entries : [])
      .map((e) => e?.store)
      .filter((s) => s && s !== 'humble'),
  )];
}

const worthRedeeming = [];
const keepGiftable = [];

for (const g of unredeemed) {
  const owners = ownedElsewhere(g.title);
  const entry = { ...g, ownedOn: owners };
  // A key for a game you already own is worth more unrevealed: it can be
  // given to someone, whereas revealing it just makes a second copy.
  if (owners.length) keepGiftable.push(entry);
  else worthRedeeming.push(entry);
}

if (asJson) {
  console.log(JSON.stringify({ worthRedeeming, keepGiftable }, null, 2));
  process.exit(0);
}

console.log(`${unredeemed.length} unredeemed Humble key(s).\n`);

console.log(`WORTH REDEEMING - ${worthRedeeming.length} game(s) you own nowhere else`);
console.log('These are invisible in every library until redeemed, which is');
console.log('exactly when you would buy one of them again by mistake.\n');
for (const g of worthRedeeming) {
  console.log(`  ${g.title}`);
  if (g.bundle) console.log(`      from ${g.bundle}${g.keyType ? ` (${g.keyType})` : ''}`);
}

if (keepGiftable.length) {
  console.log(`\nKEEP AS THEY ARE - ${keepGiftable.length} key(s) for games you already own`);
  console.log('Revealing these would only create a duplicate, and would end their');
  console.log('one useful property: an unrevealed key can still be given away.\n');
  for (const g of keepGiftable) {
    console.log(`  ${g.title}`);
    console.log(`      already owned on ${g.ownedOn.join(', ')}`);
  }
}

console.log('\n---');
console.log('Revealing is deliberately not automated. Two reasons, both real:');
console.log('  1. Humble puts the reveal endpoint behind bot protection, so');
console.log('     driving it needs a browser pretending not to be a script.');
console.log('  2. Steam locks key activation after about ten failed attempts');
console.log('     and penalises sustained abuse. A long list of keys, some');
console.log('     already-owned or region-locked, is how that gets triggered.');
console.log('');
console.log('Redeem the list above in batches, at:');
console.log('  https://www.humblebundle.com/home/keys?filter=unredeemed');
console.log('  https://store.steampowered.com/account/registerkey');
