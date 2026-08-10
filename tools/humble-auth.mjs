/**
 * One-time Humble Bundle sign-in.
 *
 * Humble's login has bot protection and 2FA, so this does not attempt it -
 * the same conclusion reached for EA. Instead it takes the `_simpleauth_sess`
 * cookie from a browser where you are already signed in.
 *
 *   node tools/humble-auth.mjs
 *
 * The cookie is verified against your real library before you are told to save
 * it, and the summary deliberately calls out UNREDEEMED keys: those are
 * purchases invisible in Steam or anywhere else, and they are the whole reason
 * this source is worth having.
 */
import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import * as humble from '../lib/humble.mjs';

function ask(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: stdin, output: stdout });
    rl.question(question, (a) => { rl.close(); resolve(a.trim()); });
  });
}

console.log('Humble Bundle sign-in (one time)\n');
console.log('1. Sign in at https://www.humblebundle.com in your browser.');
console.log('2. Open developer tools (F12) -> Application -> Cookies -> humblebundle.com');
console.log('3. Find the cookie named  _simpleauth_sess  and copy its Value.\n');
console.log('The value usually starts with "eyJ" and is quite long.');
console.log('If you paste the whole cookie string, only _simpleauth_sess is used.\n');

let session = await ask('_simpleauth_sess value: ');

const match = session.match(/_simpleauth_sess=([^;\s]+)/);
if (match) session = match[1];
// Browsers show this value URL-quoted; Humble rejects it in that form.
if (session.startsWith('"') && session.endsWith('"')) session = session.slice(1, -1);

if (!session) {
  console.error('No value entered.');
  process.exit(1);
}

console.log('\nChecking with Humble (this reads every order, so give it a moment)...');
try {
  const s = await humble.summary({ HUMBLE_SESSION: session });

  console.log(`\nFound ${s.total} games across your Humble orders.`);
  console.log(`  ${s.drmFree} DRM-free`);
  console.log(`  ${s.unredeemed} with keys you have NOT redeemed`);

  if (s.unredeemed) {
    console.log('\nThose unredeemed ones are the point of this: you own them,');
    console.log('but they appear in no library, so nothing else can tell you.');
  }

  if (!s.total) {
    console.log('\nThe cookie worked but no games were found. If you know your');
    console.log('library is not empty, the cookie may belong to a different account.');
  }

  console.log('\nAdd this as the HUMBLE_SESSION secret:\n');
  console.log(session);
  console.log('\nHumble sessions expire after a while. If Humble stops updating,');
  console.log('run this again to refresh it.');
} catch (e) {
  console.error('\nFailed: ' + e.message);
  console.error('\nIf this says 401, the cookie was copied incorrectly or has expired.');
  console.error('Make sure you copied _simpleauth_sess and not another cookie.');
  process.exit(1);
}
