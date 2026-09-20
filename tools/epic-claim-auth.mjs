/** Check that the legendary login used for Epic library sync still works. */
import * as epicClaim from '../lib/epic-claim.mjs';
import { epicFreeGames } from '../lib/freebies.mjs';

console.log('Epic library login\n');

if (!epicClaim.configured(process.env)) {
  console.error('Epic is not set up yet. Run this first:');
  console.error('  .\\finish-setup.ps1 -Only epic');
  process.exit(1);
}

console.log('Checking Epic accepts the launcher token...');
try {
  await epicClaim.probeSession(process.env);
  console.log('The legendary login works.');

  const free = await epicFreeGames(process.env.COUNTRY || 'US');
  if (!free.length) {
    console.log('Nothing is free right now.');
    process.exit(0);
  }

  console.log('\nCurrently free:');
  for (const game of free) {
    console.log(`  ${game.title}`);
    console.log(`  ${game.url}`);
  }

  console.log('\nEpic now requires its JavaScript browser checkout and anti-bot');
  console.log('validation, so GameVault does not pretend it can claim these from CI.');
  console.log('Run this to open anything missing in your Epic library:');
  console.log('  npm run free -- --open');
  console.log('\nThe scheduled build emails you directly when browser confirmation is');
  console.log('needed. It does not open a GitHub issue.');
} catch (e) {
  console.error('\nFailed: ' + e.message);
  process.exit(1);
}