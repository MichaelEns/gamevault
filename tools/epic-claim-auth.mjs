/**
 * Check that automatic Epic claiming is ready.
 *
 * There is nothing to sign into and no cookie to copy. Epic lets a launcher
 * token be exchanged for a web session, and legendary already holds one for
 * reading your library - so the credential set up to LIST Epic games is also
 * enough to CLAIM them.
 *
 * Copying a cookie was the previous plan and it could not have worked: Epic
 * marks its session cookies HttpOnly, so devtools shows no "Cookie:" request
 * header and document.cookie cannot see them either. Anyone following those
 * instructions would have collected a set missing the one that matters.
 *
 *   node tools/epic-claim-auth.mjs
 */
import * as epicClaim from '../lib/epic-claim.mjs';
import { epicFreeGames } from '../lib/freebies.mjs';

console.log('Epic automatic claiming\n');
console.log('No sign-in needed: legendary\u2019s existing login is exchanged for a');
console.log('web session each time, so nothing extra is stored.\n');

if (!epicClaim.configured(process.env)) {
  console.error('Epic is not set up yet. Run this first:');
  console.error('  .\\finish-setup.ps1 -Only epic');
  process.exit(1);
}

console.log('Checking Epic accepts the launcher token...');
try {
  const free = await epicFreeGames(process.env.COUNTRY || 'US');

  if (!free.length) {
    await epicClaim.probeSession(process.env);
    console.log('Session works. Nothing is free right now; the next scheduled');
    console.log('build will claim automatically when something is.');
    process.exit(0);
  }

  const target = free[0];
  console.log(`Currently free: ${target.title}`);
  console.log('Claiming it now, as a live test...\n');

  const result = await epicClaim.claim(process.env, target).catch((e) => ({ error: e }));

  if (result?.error?.alreadyOwned) {
    console.log(`You already own ${target.title}, which proves the session works.`);
  } else if (result?.error) {
    console.error(`Failed: ${result.error.message}`);
    if (/expired|401/.test(result.error.message)) {
      console.error('\nThe launcher token has expired. Re-run:');
      console.error('  .\\finish-setup.ps1 -Only epic');
    }
    process.exit(1);
  } else {
    console.log(`Claimed ${target.title}.`);
  }

  console.log('\nAutomatic claiming is ready. Every claim is checked against your');
  console.log('library on the next sync, and anything that did not arrive shows in');
  console.log('red in the app and opens a GitHub issue, so a silent failure cannot');
  console.log('go unnoticed.');
} catch (e) {
  console.error('\nFailed: ' + e.message);
  process.exit(1);
}