import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import path from 'node:path';
import { PATHS } from './paths.mjs';

/**
 * Persistent session store.
 *
 * Static API keys live in .env, but some providers hand out short-lived
 * SESSION tokens after a login. Without somewhere to keep them, every sync
 * would re-authenticate from scratch -- which is both slow and the thing
 * most likely to trip an account-security flag or a rate limit.
 *
 * Kept separate from .env because these are machine-generated and rotate;
 * .env is hand-edited and stable.
 */
async function readAll() {
  try {
    return JSON.parse(await readFile(PATHS.sessions, 'utf8'));
  } catch {
    return {};
  }
}

async function writeAll(obj) {
  await mkdir(path.dirname(PATHS.sessions), { recursive: true });
  await writeFile(PATHS.sessions, JSON.stringify(obj, null, 2), 'utf8');
  // Best effort on POSIX; a no-op on Windows, where setup.ps1 tightens the ACL.
  try { await chmod(PATHS.sessions, 0o600); } catch { /* not supported here */ }
}

/** Return a stored session, or undefined if absent/expired. */
export async function getSession(provider) {
  const all = await readAll();
  const rec = all[provider];
  if (!rec) return undefined;
  if (rec.expiresAt && Date.now() >= rec.expiresAt) return undefined;
  return rec.value;
}

/**
 * Store a session.
 * @param {number} ttlMs how long the provider says it is good for
 */
export async function setSession(provider, value, ttlMs) {
  const all = await readAll();
  all[provider] = {
    value,
    savedAt: Date.now(),
    expiresAt: ttlMs ? Date.now() + ttlMs : null,
  };
  await writeAll(all);
}

export async function clearSession(provider) {
  const all = await readAll();
  delete all[provider];
  await writeAll(all);
}

/** Non-secret summary, for the status page. */
export async function sessionInfo() {
  const all = await readAll();
  const out = {};
  for (const [k, v] of Object.entries(all)) {
    out[k] = {
      savedAt: v.savedAt ? new Date(v.savedAt).toISOString() : null,
      expiresAt: v.expiresAt ? new Date(v.expiresAt).toISOString() : null,
      valid: !v.expiresAt || Date.now() < v.expiresAt,
    };
  }
  return out;
}
