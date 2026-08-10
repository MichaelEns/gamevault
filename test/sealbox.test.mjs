/**
 * Sealed-box encryption for GitHub Actions secrets.
 *
 * This is the one piece of the app where a silent failure would be genuinely
 * bad: a malformed sealed box is still valid base64, so GitHub accepts the PUT
 * and the secret simply arrives empty in the workflow. Nothing surfaces until
 * a build mysteriously reports no data.
 *
 * The construction was additionally proven end-to-end against the real API:
 * a canary secret written by this code was read back by a workflow, which
 * compared SHA-256 digests rather than printing the value. It matched.
 */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { PATHS } from '../lib/paths.mjs';
import { sealSecret } from '../lib/github-secrets.mjs';

let fails = 0;
const ok = (cond, msg) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); fails++; }
  else console.log(`  ok:   ${msg}`);
};

const bundlePath = path.join(PATHS.root, 'site', 'sealbox.js');
const { nacl, blake2b } = await import(pathToFileURL(bundlePath).href);
const deps = { nacl, blake2b };

console.log('The browser bundle is self-sufficient');
ok(typeof nacl?.box === 'function', 'exports nacl.box');
ok(typeof nacl?.box?.keyPair === 'function', 'exports nacl.box.keyPair');
ok(typeof blake2b === 'function', 'exports blake2b');

console.log('\nBLAKE2b matches the RFC 7693 test vector');
// If this is wrong the nonce is wrong, and GitHub cannot decrypt anything.
const vec = Buffer.from(blake2b(new TextEncoder().encode('abc'), undefined, 64)).toString('hex');
ok(vec === 'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d1' +
           '7d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923',
   'blake2b("abc", 64) matches the published vector');
const vec24 = blake2b(new TextEncoder().encode('abc'), undefined, 24);
ok(vec24.length === 24, 'a 24-byte digest is produced for the sealed-box nonce');

console.log('\nEntropy is wired explicitly, not sniffed');
// tweetnacl throws "no PRNG" when its environment detection fails, which it
// did in the ESM bundle. An ephemeral key without entropy would break the box.
let threw = null;
try { nacl.randomBytes(32); } catch (e) { threw = e; }
ok(threw === null, threw ? `randomBytes threw: ${threw.message}` : 'nacl.randomBytes works in the bundle');
const r1 = Buffer.from(nacl.randomBytes(32)).toString('hex');
const r2 = Buffer.from(nacl.randomBytes(32)).toString('hex');
ok(r1 !== r2, 'successive random draws differ');
ok(!/^0+$/.test(r1), 'random bytes are not all zero');

console.log('\nSealed box has the right shape');
const key = Buffer.alloc(32, 7).toString('base64');
const sealed = sealSecret('hello', key, deps);
const raw = Buffer.from(sealed, 'base64');
// 32-byte ephemeral public key + 16-byte Poly1305 tag + message.
ok(raw.length === 32 + 16 + 'hello'.length, `53 bytes for a 5-byte message (got ${raw.length})`);

const long = sealSecret('x'.repeat(500), key, deps);
ok(Buffer.from(long, 'base64').length === 32 + 16 + 500, 'scales with message length');

console.log('\nEvery seal is unique (the ephemeral key must be fresh)');
const seals = new Set();
for (let i = 0; i < 20; i++) seals.add(sealSecret('same value', key, deps));
ok(seals.size === 20, `20 seals of one value produced ${seals.size} distinct ciphertexts`);
// The ephemeral public key is the first 32 bytes; those must differ too.
const epks = new Set([...seals].map((s) => Buffer.from(s, 'base64').subarray(0, 32).toString('hex')));
ok(epks.size === 20, 'each seal used a different ephemeral key');

console.log('\nA bad public key is rejected rather than producing garbage');
for (const [bad, why] of [
  [Buffer.alloc(31, 1).toString('base64'), '31 bytes'],
  [Buffer.alloc(33, 1).toString('base64'), '33 bytes'],
  [Buffer.alloc(0).toString('base64'), 'empty'],
]) {
  let msg = '';
  try { sealSecret('x', bad, deps); } catch (e) { msg = e.message; }
  ok(/expected 32/.test(msg), `${why} -> ${msg || 'NO ERROR'}`);
}

console.log('\nUnicode survives the round trip through UTF-8');
const unicode = 'kéy-\u00e9\u4e2d\u6587-\ud83c\udfae';
const u = Buffer.from(sealSecret(unicode, key, deps), 'base64');
ok(u.length === 32 + 16 + new TextEncoder().encode(unicode).length,
   'length reflects UTF-8 byte count, not JS string length');

console.log('\nThe bundle carries no network or storage access');
// It is vendored crypto; anything else in there would be a supply-chain smell.
const src = await readFile(bundlePath, 'utf8');
for (const bad of ['fetch(', 'XMLHttpRequest', 'localStorage', 'document.cookie', 'eval(']) {
  ok(!src.includes(bad), `no ${bad} in the bundle`);
}

console.log('');
if (fails) { console.log(`${fails} assertion(s) failed.`); process.exit(1); }
console.log('All sealed-box tests passed.');
