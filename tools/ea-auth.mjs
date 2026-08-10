/**
 * One-time EA sign-in.
 *
 * Origin shut down, but EA libraries were not lost: they moved to the EA app
 * on the same account, and EA's Juno aggregation layer still serves them.
 *
 * Unlike Epic (legendary) and Amazon (nile) there is no open-source CLI that
 * performs an EA login, and EA's login page has bot protection that a script
 * has no business trying to defeat. So authentication is a cookie you copy
 * once from a browser where you are already signed in.
 *
 *   node tools/ea-auth.mjs
 *
 * The `remid` cookie is EA's long-lived "remember me" value, which is why it
 * is the one worth storing. It is verified here before you are told to save
 * it, so a mistyped copy fails now rather than silently producing an empty
 * library later.
 */
import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import * as ea from '../lib/ea.mjs';

function ask(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: stdin, output: stdout });
    rl.question(question, (a) => { rl.close(); resolve(a.trim()); });
  });
}

console.log('EA sign-in (one time)\n');
console.log('1. Sign in at https://www.ea.com in your browser.');
console.log('2. Open developer tools (F12) -> Application -> Cookies -> https://www.ea.com');
console.log('3. Find the cookie named  remid  and copy its Value.\n');
console.log('If you paste the whole cookie string, only remid is used.\n');

let remid = await ask('remid cookie value: ');

// Accept a pasted cookie header as well as a bare value; copying the whole row
// out of devtools is the more likely action.
const match = remid.match(/remid=([^;\s]+)/);
if (match) remid = match[1];

if (!remid) {
  console.error('No value entered.');
  process.exit(1);
}

console.log('\nVerifying with EA...');
try {
  const player = await ea.whoami({ EA_REMID: remid });
  if (!player?.displayName) {
    console.error('EA accepted the cookie but returned no player. Response: ' + JSON.stringify(player));
    process.exit(1);
  }
  console.log(`Signed in as ${player.displayName}`);

  const games = await ea.ownedGames({ EA_REMID: remid });
  console.log(`Found ${games.length} owned EA games.`);
  if (games.length) {
    console.log('For example: ' + games.slice(0, 3).map((g) => g.title).join(', '));
  }

  console.log('\nAdd this as the EA_REMID secret:\n');
  console.log(remid);
  console.log('\nIt is a long-lived cookie, but not permanent. If EA ownership');
  console.log('stops updating, run this again to refresh it.');
} catch (e) {
  console.error('\nFailed: ' + e.message);
  console.error('\nIf this says login_required, the cookie was copied incorrectly');
  console.error('or has expired. Make sure you copied `remid` and not `sid`.');
  process.exit(1);
}
