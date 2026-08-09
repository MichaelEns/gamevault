import { hashPassword, verifyPassword, mintToken, verifyToken, isThrottled, noteFailure, clearFailures, requireAuthOrRefuse, parseCookies } from '../lib/auth.mjs';

let fails = 0;
const ok = (cond, msg) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); fails++; }
  else console.log(`  ok:   ${msg}`);
};

console.log('Password hashing');
const h = hashPassword('correct horse battery staple');
ok(h.startsWith('scrypt$'), 'hash is tagged with its scheme');
ok(!h.includes('correct horse'), 'plaintext never appears in the hash');
ok(verifyPassword('correct horse battery staple', h), 'correct password verifies');
ok(!verifyPassword('Correct horse battery staple', h), 'wrong case rejected');
ok(!verifyPassword('', h), 'empty password rejected');
ok(!verifyPassword('correct horse battery stapl', h), 'near-miss rejected');
ok(hashPassword('same') !== hashPassword('same'), 'same password -> different hash (random salt)');

console.log('\nMalformed stored hashes must not throw or pass');
for (const bad of ['', 'garbage', 'scrypt$only-one-part', 'md5$aa$bb', null, undefined, 'scrypt$zz$zz']) {
  ok(verifyPassword('anything', bad) === false, `rejected: ${JSON.stringify(bad)}`);
}

console.log('\nSession tokens');
const secret = 'a'.repeat(64);
const tok = mintToken(secret);
ok(verifyToken(tok, secret), 'freshly minted token verifies');
ok(!verifyToken(tok, 'b'.repeat(64)), 'token forged under another secret is rejected');
ok(!verifyToken('', secret), 'empty token rejected');
ok(!verifyToken('nonsense', secret), 'malformed token rejected');
ok(!verifyToken(`${Date.now() + 60000}.deadbeef`, secret), 'bad signature rejected');
const expired = mintToken(secret, -1000);
ok(!verifyToken(expired, secret), 'expired token rejected');
// tamper with the expiry to try to extend a valid session
const [exp, sig] = tok.split('.');
ok(!verifyToken(`${Number(exp) + 999999}.${sig}`, secret), 'extending the expiry invalidates the signature');

console.log('\nBrute-force throttle');
const ip = '203.0.113.7';
ok(!isThrottled(ip), 'fresh IP is not throttled');
for (let i = 0; i < 8; i++) noteFailure(ip);
ok(isThrottled(ip), 'throttled after 8 failures');
clearFailures(ip);
ok(!isThrottled(ip), 'successful login clears the throttle');

console.log('\nStartup guard -- the important one');
let threw = false;
try { requireAuthOrRefuse({ hash: null, host: '0.0.0.0' }); } catch { threw = true; }
ok(threw, 'REFUSES to bind 0.0.0.0 with no password');
threw = false;
try { requireAuthOrRefuse({ hash: null, host: '::' }); } catch { threw = true; }
ok(threw, 'REFUSES to bind :: with no password');
threw = false;
try { requireAuthOrRefuse({ hash: null, host: '127.0.0.1' }); } catch { threw = true; }
ok(!threw, 'allows loopback with no password (local use stays frictionless)');
threw = false;
try { requireAuthOrRefuse({ hash: 'scrypt$aa$bb', host: '0.0.0.0' }); } catch { threw = true; }
ok(!threw, 'allows 0.0.0.0 when a password IS set');

console.log('\nCookie parsing');
const c = parseCookies('a=1; gv_session=tok%20en; b=2');
ok(c.gv_session === 'tok en', 'url-decodes cookie values');
ok(Object.keys(parseCookies('')).length === 0, 'empty header -> no cookies');
ok(Object.keys(parseCookies(undefined)).length === 0, 'missing header -> no cookies');

console.log('');
if (fails) { console.log(`${fails} assertion(s) failed.`); process.exit(1); }
console.log('All auth tests passed.');
