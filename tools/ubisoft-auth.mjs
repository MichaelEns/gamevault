/**
 * One-time Ubisoft sign-in that survives 2FA.
 *
 * Ubisoft's own login is not the obstacle it appears to be. Signing in with a
 * password on a 2FA account returns a `twoFactorAuthenticationTicket`; clearing
 * that challenge once returns a `rememberMeTicket`, which authenticates future
 * sessions on its own. That ticket is what a scheduled build needs.
 *
 * This is also strictly better than storing the password:
 *   - the ticket only grants session creation, not account access
 *   - it can be revoked from Ubisoft's account security page
 *   - the password never has to leave this machine
 *
 * Run it on a PC (it needs the code Ubisoft sends you), then put the printed
 * ticket in the UBISOFT_REMEMBER_TICKET secret and delete UBISOFT_PASSWORD.
 *
 *   node tools/ubisoft-auth.mjs
 *
 * Every response is reported verbatim on failure. Ubisoft moves these
 * endpoints and header names around, and a silent failure here would be
 * indistinguishable from a wrong password.
 */
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';

const AUTH = 'https://public-ubiservices.ubi.com/v3/profiles/sessions';
// The API application id. The Ubisoft Connect PC client's own id (314d4fef...)
// is blocked at the gateway for third parties and returns 403 errorCode 1002
// regardless of credentials.
const APP_ID = 'f68a4bb5-608a-4ff2-8123-be8ef797e0a6';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

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
function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: stdin, output: stdout, terminal: true });
    if (!hidden) {
      rl.question(question, (a) => { rl.close(); resolve(a.trim()); });
      return;
    }
    // Suppress echo so the password is not left on screen or in scrollback.
    stdout.write(question);
    const onData = (char) => {
      if (['\n', '\r', '\u0004'].includes(String(char))) stdin.removeListener('data', onData);
      else stdout.write('\x1B[2K\x1B[200D' + question + '*'.repeat(rl.line.length));
    };
    stdin.on('data', onData);
    rl.question('', (a) => { stdout.write('\n'); rl.close(); resolve(a.trim()); });
  });
}

async function post(headers, body) {
  const res = await fetch(AUTH, {
    method: 'POST',
    headers: { 'Ubi-AppId': APP_ID, 'Content-Type': 'application/json', 'User-Agent': UA, ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep the raw text for the report */ }
  return { status: res.status, json, text };
}

function fail(step, res) {
  console.error(`\n${step} failed (HTTP ${res.status}).`);
  console.error('Ubisoft said:');
  console.error(res.text.slice(0, 600));
  if (res.status === 403 && res.text.includes('1002')) {
    console.error('\nerrorCode 1002 means this application id is blocked at the gateway.');
  }
  process.exit(1);
}

console.log('Ubisoft sign-in (one time)\n');
console.log('Your password is used once, here, to obtain a reusable ticket.');
console.log('It is never stored and never sent anywhere else.\n');

const email = await ask('Ubisoft email: ');
const password = await ask('Password (hidden): ', { hidden: true });

const basic = Buffer.from(`${email}:${password}`, 'utf8').toString('base64');
let res = await post({ Authorization: `Basic ${basic}` }, { rememberMe: true });

if (res.status === 401) {
  console.error('\nUbisoft rejected the email or password (401).');
  process.exit(1);
}
if (res.status !== 200) fail('Sign-in', res);

let session = res.json;

if (session?.twoFactorAuthenticationTicket) {
  console.log('\nTwo-factor authentication required.');
  console.log('Ubisoft has sent a code to your email or authenticator app.');
  const code = await ask('Code: ');

  res = await post({
    Authorization: `ubi_2fa_v1 t=${session.twoFactorAuthenticationTicket}`,
    'Ubi-2FACode': code,
  }, { rememberMe: true });

  if (res.status !== 200) fail('Two-factor verification', res);
  session = res.json;
}

if (!session?.rememberMeTicket) {
  console.error('\nSigned in, but Ubisoft did not return a rememberMeTicket.');
  console.error('Without one every build would trigger a fresh 2FA challenge.');
  console.error('Response keys: ' + Object.keys(session ?? {}).join(', '));
  process.exit(1);
}

console.log('\nSigned in as ' + (session.nameOnPlatform ?? 'unknown'));
console.log('\nAdd this as the UBISOFT_REMEMBER_TICKET secret:\n');
console.log(session.rememberMeTicket);
emit(session.rememberMeTicket);
console.log('\nThen DELETE the UBISOFT_PASSWORD secret - it is no longer needed,');
console.log('and this ticket can be revoked from Ubisoft account security.');
