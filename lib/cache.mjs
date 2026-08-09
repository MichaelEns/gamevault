import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { PATHS } from './paths.mjs';

const CACHE_DIR = PATHS.cache;

/**
 * Disk cache with TTL.
 *
 * This is not a performance nicety -- it is what keeps us inside the
 * storefronts' rate limits. Steam's storefront API in particular starts
 * refusing requests at roughly 200 per 5 minutes per IP, and a single
 * library sync can touch hundreds of appids.
 */
const mem = new Map();

function keyToFile(key) {
  const h = createHash('sha1').update(key).digest('hex');
  return path.join(CACHE_DIR, `${h}.json`);
}

export async function cacheGet(key, ttlMs) {
  const now = Date.now();

  const hit = mem.get(key);
  if (hit && now - hit.at < ttlMs) return hit.value;

  try {
    const raw = await readFile(keyToFile(key), 'utf8');
    const rec = JSON.parse(raw);
    if (now - rec.at < ttlMs) {
      mem.set(key, rec);
      return rec.value;
    }
  } catch {
    // absent or corrupt -- treated as a miss
  }
  return undefined;
}

export async function cacheSet(key, value) {
  const rec = { at: Date.now(), value };
  mem.set(key, rec);
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(keyToFile(key), JSON.stringify(rec), 'utf8');
  } catch {
    // A cache write failure must never break a lookup.
  }
}

/** Run `fn` only on a cache miss. */
export async function cached(key, ttlMs, fn) {
  const hit = await cacheGet(key, ttlMs);
  if (hit !== undefined) return hit;
  const value = await fn();
  await cacheSet(key, value);
  return value;
}

export const TTL = {
  price: 30 * 60 * 1000,        // prices move on sale boundaries
  search: 60 * 60 * 1000,
  catalog: 6 * 60 * 60 * 1000,  // Game Pass / EA Play rosters change slowly
  library: 15 * 60 * 1000,
  historyLow: 12 * 60 * 60 * 1000,
};
