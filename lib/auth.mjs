import { randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { PATHS } from './paths.mjs';

/**
 * Authentication.
 *
 * Locally this app needed none -- it listened on localhost and only you
 * could reach it. The moment it is reachable from the internet, every
 * endpoint becomes public: your library, which stores you have linked, and
 * a /api/sync button that spends your API quota. So access is gated.
 *
 * Self-contained on purpose (no OAuth provider, no external identity
 * service): a plain password form works from a locked-down corporate
 * laptop where you cannot install a VPN client or a browser extension.
 */

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days -- "don't log in constantly"
const SCRYPT_KEYLEN = 64;
const COOKIE = 'gv_session';

// Brute-force throttle. In-memory is sufficient: a restart clears it, but a
// restart also invalidates nothing else, and the lockout window is short.
const attempts = new Map();
const MAX_ATTEMPTS = 8;
const LOCKOUT_MS = 15 * 60 * 1000;

/**
 * Session-signing secret. Persisted so that sessions survive a restart --
 * otherwise every container redeploy would log you out of every device.
 */
export async function loadOrCreateSecret() {
  const file = path.join(PATHS.data, 'session-secret');
  if (existsSync(file)) {
    const s = (await readFile(file, 'utf8')).trim();
    if (s.length >= 32) return s;
  }
  const secret = randomBytes(32).toString('hex');
  await mkdir(PATHS.data, { recursive: true });
  await writeFile(file, secret, 'utf8');
  return secret;
}

/** scrypt hash, formatted `scrypt$<salt-hex>$<key-hex>`. */
export function hashPassword(password, salt = randomBytes(16)) {
  const key = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

/** Constant-time password check against a stored hash. */
export function verifyPassword(password, stored) {
  try {
    const [scheme, saltHex, keyHex] = String(stored).split('$');
    if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;
    const key = scryptSync(password, Buffer.from(saltHex, 'hex'), SCRYPT_KEYLEN);
    const expected = Buffer.from(keyHex, 'hex');
    if (key.length !== expected.length) return false;
    return timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

/**
 * Resolve the configured credential.
 * GAMEVAULT_PASSWORD_HASH is preferred; GAMEVAULT_PASSWORD is the
 * convenience form and is hashed here so the comparison is never a plain
 * string equality.
 */
export function configuredHash(env) {
  if (env.GAMEVAULT_PASSWORD_HASH) return env.GAMEVAULT_PASSWORD_HASH.trim();
  if (env.GAMEVAULT_PASSWORD) return hashPassword(env.GAMEVAULT_PASSWORD);
  return null;
}

export function isThrottled(ip) {
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > LOCKOUT_MS) {
    attempts.delete(ip);
    return false;
  }
  return rec.count >= MAX_ATTEMPTS;
}

export function noteFailure(ip) {
  const rec = attempts.get(ip) ?? { count: 0, first: Date.now() };
  rec.count += 1;
  attempts.set(ip, rec);
}

export function clearFailures(ip) {
  attempts.delete(ip);
}

/** Signed, expiring session token: `<expiry>.<hmac>`. */
export function mintToken(secret, ttlMs = SESSION_TTL_MS) {
  const exp = Date.now() + ttlMs;
  const sig = createHmac('sha256', secret).update(String(exp)).digest('hex');
  return `${exp}.${sig}`;
}

export function verifyToken(token, secret) {
  if (!token) return false;
  const [expStr, sig] = String(token).split('.');
  if (!expStr || !sig) return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || Date.now() >= exp) return false;
  const expected = createHmac('sha256', secret).update(expStr).digest('hex');
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(token, { secure }) {
  const bits = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export const COOKIE_NAME = COOKIE;

/**
 * Is this request authenticated?
 * Returns true when auth is disabled AND we are bound to loopback --
 * see requireAuthOrRefuse() for why that combination is the only safe one.
 */
export function isAuthed(req, { hash, secret }) {
  if (!hash) return true; // auth disabled; startup already proved this is loopback-only
  const cookies = parseCookies(req.headers.cookie);
  return verifyToken(cookies[COOKIE], secret);
}

/**
 * Startup guard.
 *
 * Refuse to serve on a non-loopback interface without a password. Getting
 * this wrong silently publishes a personal game library and a sync button
 * to the internet, so it is a hard failure rather than a warning.
 */
export function requireAuthOrRefuse({ hash, host }) {
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (hash || loopback) return;
  throw new Error(
    `Refusing to start: binding to ${host} exposes GameVault beyond this machine, ` +
    'but no password is set.\n' +
    '  Set GAMEVAULT_PASSWORD (or GAMEVAULT_PASSWORD_HASH) in the environment,\n' +
    '  or bind to 127.0.0.1 for local-only use (HOST=127.0.0.1).',
  );
}
