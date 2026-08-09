/**
 * Snapshot encryption.
 *
 * The repo has to be PUBLIC (free GitHub Pages only works from public
 * repos), so the published snapshot is world-readable. Encrypting it means
 * the repo can stay public while the contents -- your game library -- stay
 * private.
 *
 * Deliberately uses `globalThis.crypto.subtle` (WebCrypto) rather than
 * `node:crypto`. It is the SAME API in Node 20+ and in every browser, so
 * the encrypt path in CI and the decrypt path in the PWA run byte-identical
 * code. Using node:crypto here would mean two implementations that could
 * silently drift apart -- and the failure mode is "your snapshot is
 * undecryptable", which you would not discover until you needed it.
 *
 * Scheme: PBKDF2-SHA256 -> AES-256-GCM.
 *   - random 16-byte salt per snapshot (so the same passphrase never
 *     produces the same key twice)
 *   - random 12-byte IV per snapshot (GCM requires a unique IV per message)
 *   - GCM's auth tag detects tampering, so a corrupted or edited snapshot
 *     fails loudly instead of decrypting to garbage
 */

// OWASP's current floor for PBKDF2-HMAC-SHA256. Costs ~0.5s on a phone,
// which is a one-time price at unlock and makes brute force expensive.
export const PBKDF2_ITERATIONS = 600_000;

const enc = new TextEncoder();
const dec = new TextDecoder();

const subtle = () => {
  const c = globalThis.crypto;
  if (!c?.subtle) {
    throw new Error(
      'WebCrypto is unavailable. Node 20+ or a modern browser is required.',
    );
  }
  return c.subtle;
};

async function deriveKey(passphrase, salt, iterations) {
  const base = await subtle().importKey(
    'raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey'],
  );
  return subtle().deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

const toB64 = (bytes) => Buffer.from(bytes).toString('base64');
const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/**
 * Encrypt an arbitrary JSON-serialisable value.
 * Returns a self-describing envelope: everything needed to decrypt except
 * the passphrase, so a future reader never has to guess parameters.
 */
export async function encryptJson(value, passphrase, { iterations = PBKDF2_ITERATIONS } = {}) {
  if (!passphrase) throw new Error('A passphrase is required to encrypt the snapshot.');

  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, iterations);

  const plaintext = enc.encode(JSON.stringify(value));
  const cipher = await subtle().encrypt({ name: 'AES-GCM', iv }, key, plaintext);

  return {
    format: 'gamevault-encrypted-snapshot',
    version: 1,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: toB64(salt) },
    cipher: { name: 'AES-GCM', iv: toB64(iv) },
    data: toB64(new Uint8Array(cipher)),
  };
}

/**
 * Decrypt an envelope produced by encryptJson.
 * A wrong passphrase surfaces as a clear message rather than the raw
 * OperationError WebCrypto throws.
 */
export async function decryptJson(envelope, passphrase) {
  if (envelope?.format !== 'gamevault-encrypted-snapshot') {
    throw new Error('This does not look like a GameVault snapshot.');
  }
  if (envelope.version !== 1) {
    throw new Error(`Unsupported snapshot version ${envelope.version}. Update the app.`);
  }

  const salt = fromB64(envelope.kdf.salt);
  const iv = fromB64(envelope.cipher.iv);
  const key = await deriveKey(passphrase, salt, envelope.kdf.iterations);

  let plain;
  try {
    plain = await subtle().decrypt(
      { name: 'AES-GCM', iv }, key, fromB64(envelope.data),
    );
  } catch {
    // GCM auth failure: wrong passphrase, or the file was altered.
    throw new Error('Wrong passphrase (or the snapshot has been tampered with).');
  }
  return JSON.parse(dec.decode(plain));
}
