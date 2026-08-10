/**
 * One-time Epic sign-in, for claiming free games.
 *
 * Only the payment host is involved, and it is auth-gated rather than
 * bot-protected - verified directly:
 *
 *   store.epicgames.com/purchase          403  bot-protected
 *   payment-website-pci.../purchase       401  auth-gated only
 *
 * So a session cookie is enough and no browser impersonation is required.
 * Epic's login itself has bot protection, which is why this takes a cookie
 * rather than driving the sign-in - the same conclusion reached for EA and
 * Humble.
 *
 *   node tools/epic-claim-auth.mjs
 */
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { stdin, stdout } from 'node:process';
import * as epicClaim from '../lib/epic-claim.mjs';
import { epicFreeGames } from '../lib/freebies.mjs';

function emit(value) {
  const i = process.argv.indexOf('--out');
  if (i === -1 || !process.argv[i + 1]) return;
  const payload = typeof value === 'string' ? value : JSON.stringify(value);
  writeFileSync(process.argv[i + 1], payload, 'utf8');
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: stdin, output: stdout });
    rl.question(question, (a) => { rl.close(); resolve(a.trim()); });
  });
}

console.log('Epic sign-in for automatic claiming (one time)\n');
console.log('1. Sign in at https://www.epicgames.com in your browser.');
console.log('2. Press F12 -> Network, then reload the page.');
console.log('3. Click any request to epicgames.com, find the "Cookie:" request');
console.log('   header, and copy the WHOLE value.\n');
console.log('Copying the whole header is deliberate: Epic\u2019s checkout needs');
console.log('several cookies together, and picking out one is how this fails.\n');

const cookies = await ask('Cookie header: ');
if (!cookies) { console.error('Nothing entered.'); process.exit(1); }
if (cookies.length < 40) {
  console.error('\nThat looks too short for a full cookie header.');
  console.error('Copy the entire "Cookie:" value, not a single cookie.');
  process.exit(1);
}
if (!/EPIC_BEARER_TOKEN|EPIC_SSO|EPIC_DEVICE|EPIC_SESSION/i.test(cookies)) {
  console.log('\nWarning: none of Epic\u2019s usual session cookies are in there.');
  console.log('Checking anyway - if this fails, you likely copied the wrong header.\n');
}

console.log('Checking with Epic...');
try {
  const free = await epicFreeGames(process.env.COUNTRY || 'US');
  if (!free.length) {
    console.log('\nNothing is free on Epic right now, so the claim path cannot be');
    console.log('exercised. The cookie will be stored and used at the next giveaway.');
    console.log('\nAdd this as the EPIC_COOKIES secret:\n');
    console.log(cookies);
    emit(cookies);
    process.exit(0);
  }

  // Reaching the purchase page proves the session works, without buying
  // anything: the token fetch is a GET and commits to nothing.
  const target = free[0];
  console.log(`Testing against the current giveaway: ${target.title}`);
  const result = await epicClaim.claim(process.env.EPIC_COOKIES
    ? process.env
    : { ...process.env, EPIC_COOKIES: cookies }, target).catch((e) => ({ error: e }));

  if (result?.error?.alreadyOwned) {
    console.log('Epic says you already own it - which means the session works.');
  } else if (result?.error) {
    console.error(`\nFailed: ${result.error.message}`);
    console.error('\nIf this says 401, the cookie header was copied incorrectly or');
    console.error('has expired. Copy it again from a freshly loaded page.');
    process.exit(1);
  } else {
    console.log(`Claimed ${target.title} successfully.`);
  }

  console.log('\nAdd this as the EPIC_COOKIES secret:\n');
  console.log(cookies);
  emit(cookies);
  console.log('\nEpic sessions expire after a while. If claiming stops working,');
  console.log('run this again - and the app will tell you, because every claim is');
  console.log('checked against your library on the next sync.');
} catch (e) {
  console.error('\nFailed: ' + e.message);
  process.exit(1);
}
