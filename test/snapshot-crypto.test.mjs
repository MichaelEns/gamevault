/**
 * Snapshot crypto tests.
 *
 * The failure this guards against is the worst one in the design: a
 * snapshot that encrypts fine in CI and cannot be decrypted by the phone.
 * You would not discover that until you needed it.
 *
 * These run against `globalThis.crypto.subtle` -- the same WebCrypto
 * implementation the browser uses -- so a pass here is real evidence the
 * browser can read what the Action wrote.
 */
import { encryptJson, decryptJson, PBKDF2_ITERATIONS } from '../lib/snapshot-crypto.mjs';

let fails = 0;
const ok = (cond, msg) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); fails++; }
  else console.log(`  ok:   ${msg}`);
};

// Keep tests fast: the iteration count is orthogonal to correctness, and
// the real value is asserted separately.
const FAST = { iterations: 1000 };
const PASS = 'correct horse battery staple';

console.log('Round-trip');
const payload = {
  builtAt: '2026-08-09T00:00:00Z',
  index: { hades: [{ store: 'steam', title: 'Hades' }] },
  nested: { deep: [1, 2, { a: 'b' }] },
  unicode: 'Ori & the Blind Forest \u2122 \u2014 caf\u00e9',
};
const env = await encryptJson(payload, PASS, FAST);
const back = await decryptJson(env, PASS);
ok(JSON.stringify(back) === JSON.stringify(payload), 'decrypts to exactly what went in');
ok(back.unicode === payload.unicode, 'unicode survives (TM, em-dash, accents)');

console.log('\nThe envelope must not leak the plaintext');
const blob = JSON.stringify(env);
ok(!blob.includes('Hades'), 'game titles do not appear in the envelope');
ok(!blob.includes('hades'), 'nor in lowercase');
ok(!blob.includes(PASS), 'the passphrase never appears');

console.log('\nEnvelope is self-describing');
ok(env.format === 'gamevault-encrypted-snapshot', 'tagged with a format id');
ok(env.version === 1, 'carries a version');
ok(env.kdf?.name === 'PBKDF2' && env.kdf.hash === 'SHA-256', 'records the KDF');
ok(env.cipher?.name === 'AES-GCM', 'records the cipher');
ok(typeof env.kdf.salt === 'string' && typeof env.cipher.iv === 'string', 'carries salt + iv');

console.log('\nWrong passphrase fails clearly, not silently');
let msg = '';
try { await decryptJson(env, 'wrong passphrase'); } catch (e) { msg = e.message; }
ok(msg.includes('Wrong passphrase'), `clear error: "${msg}"`);
msg = '';
try { await decryptJson(env, ''); } catch (e) { msg = e.message; }
ok(msg.length > 0, 'empty passphrase rejected');

console.log('\nTampering is detected (AES-GCM auth tag)');
const tampered = structuredClone(env);
const raw = Buffer.from(tampered.data, 'base64');
raw[Math.floor(raw.length / 2)] ^= 0xff;          // flip one bit mid-ciphertext
tampered.data = raw.toString('base64');
msg = '';
try { await decryptJson(tampered, PASS); } catch (e) { msg = e.message; }
ok(msg.includes('tampered') || msg.includes('Wrong passphrase'), 'a single flipped bit is caught');

console.log('\nSalt and IV are per-snapshot, never reused');
const a = await encryptJson(payload, PASS, FAST);
const b = await encryptJson(payload, PASS, FAST);
ok(a.kdf.salt !== b.kdf.salt, 'salt differs between builds');
ok(a.cipher.iv !== b.cipher.iv, 'IV differs between builds (GCM requires this)');
ok(a.data !== b.data, 'identical input encrypts to different ciphertext');
ok(JSON.stringify(await decryptJson(a, PASS)) === JSON.stringify(await decryptJson(b, PASS)),
   'both still decrypt to the same value');

console.log('\nMalformed input is rejected, not crashed on');
for (const bad of [null, undefined, {}, { format: 'something-else' }, { format: 'gamevault-encrypted-snapshot', version: 99 }]) {
  let threw = false;
  try { await decryptJson(bad, PASS); } catch { threw = true; }
  ok(threw, `rejected: ${JSON.stringify(bad)}`);
}

console.log('\nProduction iteration count meets the OWASP floor');
ok(PBKDF2_ITERATIONS >= 600_000, `PBKDF2 iterations = ${PBKDF2_ITERATIONS.toLocaleString()}`);

console.log('\nA real-size snapshot encrypts in reasonable time');
const big = { index: {} };
for (let i = 0; i < 3000; i++) {
  big.index[`game ${i}`] = [{ store: 'steam', title: `Game ${i}`, id: String(i) }];
}
const t0 = Date.now();
const bigEnv = await encryptJson(big, PASS, FAST);
const bigBack = await decryptJson(bigEnv, PASS);
const ms = Date.now() - t0;
ok(Object.keys(bigBack.index).length === 3000, `3000-title snapshot round-trips (${ms}ms)`);
ok(Buffer.from(bigEnv.data, 'base64').length > 0, `ciphertext ${(Buffer.from(bigEnv.data, 'base64').length / 1024).toFixed(0)} KB`);

console.log('');
if (fails) { console.log(`${fails} assertion(s) failed.`); process.exit(1); }
console.log('All snapshot crypto tests passed.');
