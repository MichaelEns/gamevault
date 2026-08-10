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
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import * as ea from '../lib/ea.mjs';

/**
 * Hand the credential back to a caller through a file.
 *
 * finish-setup.ps1 used to scrape this value out of stdout, which meant
 * piping the tool's output - and a piped stream buffers, so the prompts
 * below never reached the screen and the script appeared to hang while
 * silently waiting for input. Writing to a file lets the tool own the
 * console, which is the only way an interactive prompt works.
 */
function emit(value) {
  const i = process.argv.indexOf('--out');
  if (i === -1 || !process.argv[i + 1]) return;
  writeFileSync(process.argv[i + 1], value, 'utf8');
}
function ask(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: stdin, output: stdout });
    rl.question(question, (a) => { rl.close(); resolve(a.trim()); });
  });
}

console.log('EA sign-in (one time)\n');
console.log('The cookie lives on accounts.ea.com, NOT on www.ea.com - looking');
console.log('under ea.com and finding nothing is the expected result.\n');
console.log('1. Sign in at https://www.ea.com in your browser.');
console.log('2. In the SAME browser, open this URL:\n');
console.log('     https://accounts.ea.com/connect/auth?client_id=ORIGIN_JS_SDK' +
            '&response_type=token&redirect_uri=nucleus:rest&prompt=none\n');
console.log('   Seeing JSON with "access_token" means you are signed in.');
console.log('   Seeing "login_required" means you are not - sign in and retry.');
console.log('   Visiting it also makes accounts.ea.com appear in the cookie list.\n');
console.log('3. Press F12 -> Application -> Cookies -> https://accounts.ea.com');
console.log('4. Copy the Value of the cookie named  remid\n');
console.log('A bare value or the whole cookie string both work.\n');

let remid = await ask('remid cookie value: ');

// Accept a pasted cookie header as well as a bare value; copying the whole row
// out of devtools is the more likely action.
const match = remid.match(/remid=([^;\s]+)/);
if (match) remid = match[1];
if (remid.startsWith('"') && remid.endsWith('"')) remid = remid.slice(1, -1);

if (!remid) {
  console.error('No value entered.');
  process.exit(1);
}

// Pasting the access_token is the most likely wrong answer, because step 2
// puts one on screen. It is not interchangeable: it expires within hours, so
// storing it would appear to work today and quietly stop working tomorrow.
if (remid.startsWith('{') || /access_token/.test(remid)) {
  console.error('\nThat looks like the JSON from step 2 rather than the cookie.');
  console.error('The access_token in it expires within hours, so it cannot be stored.');
  console.error('Use F12 -> Application -> Cookies -> accounts.ea.com and copy "remid".');
  process.exit(1);
}
if (remid.length < 20) {
  console.error(`\nThat is ${remid.length} characters, which is too short for remid.`);
  console.error('Check you copied the Value column rather than the Name.');
  process.exit(1);
}

console.log('\nVerifying with EA...');
try {
  // One pass: whoami and the library share a single token, because EA will
  // not issue a second one from the same session in quick succession.
  const { player, games } = await ea.verify({ EA_REMID: remid });
  if (!player?.displayName) {
    console.error('EA accepted the cookie but returned no player. Response: ' + JSON.stringify(player));
    process.exit(1);
  }
  console.log(`Signed in as ${player.displayName}`);

  console.log(`Found ${games.length} owned EA games.`);
  if (games.length) {
    console.log('For example: ' + games.slice(0, 3).map((g) => g.title).join(', '));
  }

  // EA rotates remid when it is used, so the value that just worked may
  // already be spent. Storing the spent one is what made the previous attempt
  // authenticate successfully and then fail on the very next run.
  const toStore = ea.rotatedRemid ?? remid;
  if (ea.rotatedRemid) {
    console.log('\nEA issued a replacement cookie during this check, which is why');
    console.log('a stored value can work once and then stop. The replacement is');
    console.log('what gets saved below.');
  }

  console.log('\nAdd this as the EA_REMID secret:\n');
  console.log(toStore);
  emit(toStore);
  console.log('\nEA rotates this cookie as it is used, so it will need refreshing');
  console.log('from time to time. If EA ownership stops updating, run this again.');
} catch (e) {
  console.error('\nFailed: ' + e.message);
  if (/login_required/.test(e.message)) {
    console.error('\nEA rotates remid when it is used, so a cookie that worked a moment');
    console.error('ago may already be spent. Reload accounts.ea.com in the browser and');
    console.error('copy the CURRENT value of remid, then run this again.');
  } else {
    console.error('\nCheck you copied `remid` from accounts.ea.com and not `sid`.');
  }
  process.exit(1);
}
