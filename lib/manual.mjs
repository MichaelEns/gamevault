import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { PATHS } from './paths.mjs';
import { normalizeTitle } from './match.mjs';

/**
 * Manually-entered ownership.
 *
 * Some storefronts publish no ownership API and have no community client
 * that speaks their protocol:
 *
 *   Amazon Prime Gaming -- gaming.amazon.com requires an Amazon session;
 *                          there is no public endpoint and no legendary
 *                          equivalent.
 *   Nintendo eShop      -- no purchase-history API. The only unofficial
 *                          route goes through the Switch Online app auth
 *                          flow, which needs a third-party token-minting
 *                          service. Not worth routing an account through.
 *
 * Rather than pretend those stores do not exist, or ship a fragile scraper
 * that breaks silently, you paste the titles once and they behave exactly
 * like API-synced ownership everywhere else in the app.
 *
 * Worth knowing about Prime Gaming specifically: most of its offers are
 * delivered as keys redeemed on GOG, Epic or Legacy Games. Anything you
 * redeemed that way is ALREADY covered by those providers -- only the
 * Amazon Games launcher titles need listing here.
 */
const FILE = () => path.join(PATHS.data, 'manual-library.json');

/** Stores that accept manual entries, with a note on why. */
export const MANUAL_STORES = {
  amazon: { label: 'Amazon Prime Gaming', reason: 'no public ownership API' },
  nintendo: { label: 'Nintendo eShop', reason: 'no purchase-history API' },
  battlenet: { label: 'Battle.net', reason: 'no public ownership API' },
  rockstar: { label: 'Rockstar', reason: 'no public ownership API' },
  other: { label: 'Other', reason: 'anything else you own' },
};

export async function load() {
  // In CI there is no data directory -- it is gitignored, precisely because a
  // public repo should not contain a list of what you own. Without this branch
  // the entire manual library silently contributed nothing to the deployed
  // snapshot, which is indistinguishable from having entered nothing.
  const fromEnv = process.env.MANUAL_LIBRARY;
  if (fromEnv) {
    try {
      const raw = JSON.parse(fromEnv);
      if (raw && typeof raw === 'object') return raw;
      throw new Error('not an object');
    } catch (e) {
      // Loud, because a malformed secret here loses ownership data quietly.
      throw new Error(
        `MANUAL_LIBRARY is set but could not be parsed as JSON (${e.message}). ` +
        'Expected {"nintendo":["Title", ...], ...}',
      );
    }
  }

  try {
    const raw = JSON.parse(await readFile(FILE(), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

async function save(obj) {
  await mkdir(PATHS.data, { recursive: true });
  await writeFile(FILE(), JSON.stringify(obj, null, 2), 'utf8');
}

/**
 * Replace the entire list for one store.
 * Accepts newline- or comma-separated text as well as an array, because
 * the realistic input is a paste from a library page.
 */
export async function setStore(store, titles) {
  if (!MANUAL_STORES[store]) throw new Error(`Unknown manual store: ${store}`);

  const list = (Array.isArray(titles) ? titles : String(titles ?? '').split(/[\r\n]+/))
    .flatMap((t) => String(t).split(/\s*[,;]\s*/))
    .map((t) => t.trim())
    .filter(Boolean)
    // Drop obvious paste artefacts: bullets, numbering, trailing counts.
    .map((t) => t.replace(/^[-*\u2022\d.)\s]+/, '').trim())
    .filter((t) => t.length > 1 && t.length <= 200);

  // De-duplicate on the normalised key so "Hades" and "Hades " collapse.
  const seen = new Map();
  for (const t of list) {
    const key = normalizeTitle(t);
    if (key && !seen.has(key)) seen.set(key, t);
  }

  const all = await load();
  all[store] = {
    updatedAt: new Date().toISOString(),
    titles: [...seen.values()].sort((a, b) => a.localeCompare(b)),
  };
  await save(all);
  return all[store];
}

export async function clearStore(store) {
  const all = await load();
  delete all[store];
  await save(all);
}

/** Flatten to the same shape the API-backed providers return. */
export async function ownedGames() {
  const all = await load();
  const out = [];
  for (const [store, rec] of Object.entries(all)) {
    for (const title of rec.titles ?? []) {
      out.push({ store, id: null, title, url: null, manual: true });
    }
  }
  return out;
}

export async function summary() {
  const all = await load();
  const out = {};
  for (const [store, rec] of Object.entries(MANUAL_STORES)) {
    out[store] = {
      label: rec.label,
      reason: rec.reason,
      count: all[store]?.titles?.length ?? 0,
      updatedAt: all[store]?.updatedAt ?? null,
    };
  }
  return out;
}
