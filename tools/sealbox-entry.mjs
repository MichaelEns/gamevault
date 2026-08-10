// Entry point bundled into site/sealbox.js. Keeping it to exactly these two
// exports means the bundle contains only what sealing a secret needs.
import nacl from 'tweetnacl';
import { blake2b } from 'blakejs';

// tweetnacl sniffs its environment for a random source and throws "no PRNG"
// when that fails -- which it did in this bundle. Wiring it explicitly to
// globalThis.crypto removes the guesswork: the same call works in Node and in
// every browser, so the bundle cannot end up without entropy on some device.
// A sealed box reusing an ephemeral key would be a genuine break, so this must
// never fall back to anything weaker.
if (!globalThis.crypto?.getRandomValues) {
  throw new Error('No secure random source available (crypto.getRandomValues)');
}
nacl.setPRNG((x, n) => {
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  x.set(bytes.subarray(0, n));
  bytes.fill(0);
});

export { nacl, blake2b };