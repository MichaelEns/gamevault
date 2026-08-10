/**
 * One-time GOG sign-in, for claiming giveaways.
 *
 * GOG's login page has bot protection, so this takes the code from a completed
 * browser login rather than driving the sign-in - the same approach used for
 * EA and Humble.
 *
 *   node tools/gog-auth.mjs
 */
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { stdin, stdout } from 'node:process';

const CLIENT_ID = '46899977096215655';
const CLIENT_SECRET = '9d85c43b1482497dbbce61f6e4aa173a433796eeae2ca8c5f6129f2dc4de46d9';
const REDIRECT = 'https://embed.gog.com/on_login_success?origin=client';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

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

const loginUrl = `https://auth.gog.com/auth?client_id=${CLIENT_ID}` +
                 `&redirect_uri=${encodeURIComponent(REDIRECT)}` +
                 '&response_type=code&layout=client2';

console.log('GOG sign-in (one time)\n');
console.log('1. Open this in your browser and sign in:\n');
console.log(`     ${loginUrl}\n`);
console.log('2. After signing in the page will look blank or show an error.');
console.log('   That is expected - what matters is the ADDRESS BAR, which will');
console.log('   contain  ?code=SOMETHING\n');
console.log('3. Copy that code (or paste the whole URL).\n');

let code = await ask('code: ');
const m = code.match(/[?&]code=([^&\s]+)/);
if (m) code = m[1];
if (!code) { console.error('Nothing entered.'); process.exit(1); }

console.log('\nExchanging it with GOG...');
const url = `https://auth.gog.com/token?client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}` +
            `&grant_type=authorization_code&code=${encodeURIComponent(code)}` +
            `&redirect_uri=${encodeURIComponent(REDIRECT)}`;

try {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  const data = await res.json();

  if (!data?.refresh_token) {
    console.error(`\nGOG returned no refresh token (HTTP ${res.status}).`);
    console.error(JSON.stringify(data).slice(0, 200));
    // The code is single-use and short-lived, which is the usual cause.
    console.error('\nThese codes expire within minutes and can only be used once.');
    console.error('Open the login URL again for a fresh one.');
    process.exit(1);
  }

  console.log('Signed in successfully.');

  const gog = await import('../lib/gog-claim.mjs');
  const giveaway = await gog.currentGiveaway().catch(() => []);
  console.log(giveaway.length
    ? `Currently being given away: ${giveaway[0].title}`
    : 'No GOG giveaway running right now - that is the usual state.');

  console.log('\nAdd this as the GOG_REFRESH_TOKEN secret:\n');
  console.log(data.refresh_token);
  emit(data.refresh_token);
  console.log('\nGOG issues a new token on every use and retires the old one, so');
  console.log('GAMEVAULT_SECRETS_TOKEN must be set or this will work exactly once.');
} catch (e) {
  console.error('\nFailed: ' + e.message);
  process.exit(1);
}
