import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { settle } from './http.mjs';
import { normalizeTitle } from './match.mjs';
import { PATHS } from './paths.mjs';
import * as steam from './steam.mjs';
import * as epic from './epic.mjs';
import * as itch from './itch.mjs';
import * as ubisoft from './ubisoft.mjs';
import * as amazon from './amazon.mjs';
import * as ea from './ea.mjs';
import * as humble from './humble.mjs';
import * as manual from './manual.mjs';

const LIB_FILE = PATHS.library;

/**
 * The unified library.
 *
 * Stored on disk so a sale-time lookup is instant and does not depend on
 * every provider being reachable. Each provider is synced independently:
 * one dead store degrades that store's entry, it does not wipe the library.
 */
export async function loadLibrary() {
  try {
    return JSON.parse(await readFile(LIB_FILE, 'utf8'));
  } catch {
    return { syncedAt: null, stores: {}, index: {} };
  }
}

async function saveLibrary(lib) {
  await mkdir(path.dirname(LIB_FILE), { recursive: true });
  await writeFile(LIB_FILE, JSON.stringify(lib, null, 2), 'utf8');
}

/**
 * Sync every configured ownership provider.
 *
 * @param {string|null} only  restrict to one provider. Pass 'manual' to skip
 *   every network provider and just re-index the hand-entered titles --
 *   which is what happens after editing the manual library, so a paste is
 *   searchable immediately without spending anyone's API quota.
 */
export async function syncLibrary(env, only = null) {
  const prev = await loadLibrary();
  const want = (name) => (!only || only === name) && only !== 'manual';

  const jobs = [];
  if (want('steam') && env.STEAM_API_KEY && env.STEAM_ID) {
    jobs.push(settle('steam', steam.ownedGames({ key: env.STEAM_API_KEY, steamId: env.STEAM_ID })));
  }
  if (want('epic')) jobs.push(settle('epic', epic.ownedGames()));
  if (want('amazon')) jobs.push(settle('amazon', amazon.ownedGames()));
  if (want('itch') && env.ITCH_API_KEY) jobs.push(settle('itch', itch.ownedGames(env)));
  if (want('ea') && ea.configured(env)) jobs.push(settle('ea', ea.ownedGames(env)));
  if (want('humble') && humble.configured(env)) jobs.push(settle('humble', humble.ownedGames(env)));
  if (want('ubisoft') && ubisoft.configured(env)) {
    jobs.push(settle('ubisoft', ubisoft.ownedGames(env)));
  }

  const results = await Promise.all(jobs);

  const stores = { ...prev.stores };
  for (const r of results) {
    if (r.ok) {
      stores[r.store] = {
        ok: true,
        count: r.data.length,
        syncedAt: new Date().toISOString(),
        games: r.data,
      };
    } else {
      // Keep the last good snapshot; record why the refresh failed.
      stores[r.store] = {
        ...(prev.stores[r.store] ?? { games: [], count: 0 }),
        ok: false,
        error: r.error,
        failedAt: new Date().toISOString(),
      };
    }
  }

  // Manually-entered ownership (Nintendo, Battle.net, ...). These need no
  // network call and cannot fail, so they are merged in unconditionally.
  //
  // MERGED, not overwritten: Amazon can now be synced properly via nile, so a
  // store may have both API-synced and hand-entered titles. Replacing the
  // record wholesale would silently discard a real 50-game nile sync in
  // favour of 3 manual entries.
  const manualGames = await manual.ownedGames().catch(() => []);
  const byStore = {};
  for (const g of manualGames) (byStore[g.store] ??= []).push(g);

  // First strip any manual entries merged in by a PREVIOUS sync. Without
  // this, a title removed from the manual list would linger forever: it had
  // already been folded into `games` and would be mistaken for synced data
  // on the next pass.
  for (const [storeName, rec] of Object.entries(stores)) {
    if (!rec.games?.some((g) => g.manual)) continue;
    const synced = rec.games.filter((g) => !g.manual);
    if (synced.length === 0 && !byStore[storeName]) {
      delete stores[storeName];
    } else {
      stores[storeName] = {
        ...rec, games: synced, count: synced.length, hasManual: false, manualCount: 0,
      };
    }
  }

  for (const [storeName, manualList] of Object.entries(byStore)) {
    const existing = stores[storeName];
    const synced = existing?.games ?? [];

    // De-duplicate against synced titles so a game you own on Amazon and also
    // typed by hand is not counted twice.
    const seen = new Set(synced.map((g) => normalizeTitle(g.title)));
    const extra = manualList.filter((g) => {
      const k = normalizeTitle(g.title);
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    stores[storeName] = {
      ok: existing?.ok ?? true,
      error: existing?.ok === false ? existing.error : undefined,
      manual: synced.length === 0,
      hasManual: true,
      manualCount: extra.length,
      count: synced.length + extra.length,
      syncedAt: new Date().toISOString(),
      games: [...synced, ...extra],
    };
  }

  const index = {};
  for (const [storeName, rec] of Object.entries(stores)) {
    for (const g of rec.games ?? []) {
      const key = normalizeTitle(g.title);
      if (!key) continue;
      (index[key] ??= []).push({ store: storeName, title: g.title, id: g.id, url: g.url });
    }
  }

  const lib = { syncedAt: new Date().toISOString(), stores, index };
  await saveLibrary(lib);
  return lib;
}

/** Exact normalised-title lookup: which of your stores has this game. */
export function findOwned(title, lib) {
  return lib?.index?.[normalizeTitle(title)] ?? [];
}

/** Which ownership providers are usable given the current config. */
export async function providerStatus(env) {
  const epicAuth = await epic.authStatus().catch(() => ({ installed: false, loggedIn: false }));
  const amazonAuth = await amazon.authStatus().catch(() => ({ installed: false, loggedIn: false }));
  const manualSummary = await manual.summary().catch(() => ({}));
  return {
    steam: {
      configured: Boolean(env.STEAM_API_KEY && env.STEAM_ID),
      note: env.STEAM_API_KEY
        ? env.STEAM_ID
          ? 'ready'
          : 'STEAM_ID missing'
        : 'STEAM_API_KEY missing (free: steamcommunity.com/dev/apikey)',
    },
    epic: {
      configured: epicAuth.installed && epicAuth.loggedIn,
      note: !epicAuth.installed
        ? 'legendary not installed'
        : epicAuth.loggedIn
          ? `logged in as ${epicAuth.account ?? 'unknown'}`
          : 'run: .venv\\Scripts\\legendary auth',
    },
    ea: {
      configured: ea.configured(env),
      note: ea.configured(env)
        ? 'ready'
        : 'EA_REMID missing - run "npm run ea-auth" once (Origin libraries moved to the EA app)',
    },
    humble: {
      configured: humble.configured(env),
      note: humble.configured(env)
        ? 'ready'
        : 'HUMBLE_SESSION missing - run "npm run humble-auth" (finds keys you bought but never redeemed)',
    },
    itch: {
      configured: Boolean(env.ITCH_API_KEY),
      note: env.ITCH_API_KEY ? 'ready' : 'ITCH_API_KEY missing (itch.io/user/settings/api-keys)',
    },
    ubisoft: {
      configured: ubisoft.configured(env),
      note: ubisoft.configured(env)
        ? 'ready (fails if 2FA is enabled)'
        : 'UBISOFT_EMAIL / UBISOFT_PASSWORD missing',
    },
    // Amazon: real ownership via nile, with manual entry as a fallback.
    amazon: {
      configured: amazonAuth.installed && amazonAuth.loggedIn,
      note: !amazonAuth.installed
        ? 'nile not installed — run setup.ps1 (adds Amazon Games ownership). Until then, use Manual library.'
        : amazonAuth.loggedIn
          ? `logged in as ${amazonAuth.account ?? 'unknown'}`
          : 'run: .venv\\Scripts\\nile auth --login',
    },
    nintendo: {
      configured: (manualSummary.nintendo?.count ?? 0) > 0,
      manual: true,
      note: manualSummary.nintendo?.count
        ? `${manualSummary.nintendo.count} titles entered manually`
        : 'no purchase-history API — add titles under "Manual library" (eShop prices still work)',
    },
  };
}
