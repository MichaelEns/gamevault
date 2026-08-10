#!/usr/bin/env node
/**
 * Build the snapshot the PWA reads.
 *
 * Runs in GitHub Actions (or locally). Everything the phone needs is
 * pre-computed here, because the browser cannot call these APIs itself:
 * Steam, GOG, Game Pass and ITAD all refuse cross-origin requests, and the
 * API keys must never reach client-side code.
 *
 * Output: site/snapshot.json -- encrypted when SNAPSHOT_PASSPHRASE is set,
 * which it must be for a public repo.
 *
 *   node tools/build-snapshot.mjs
 */
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { PATHS } from '../lib/paths.mjs';
import { settle, pool } from '../lib/http.mjs';
import { normalizeTitle } from '../lib/match.mjs';
import { scoreDeal, bestOffer } from '../lib/deal.mjs';
import * as gamepass from '../lib/gamepass.mjs';
import * as itad from '../lib/itad.mjs';
import * as steam from '../lib/steam.mjs';
import * as gog from '../lib/gog.mjs';
import * as nintendo from '../lib/nintendo.mjs';
import { syncLibrary, loadLibrary, providerStatus } from '../lib/library.mjs';
import { currentFreebies } from '../lib/freebies.mjs';

const OUT_DIR = path.join(PATHS.root, 'site');
const ENV = process.env;
// GitHub Actions passes an EMPTY STRING for a variable that is not set, not
// undefined, so `??` never fires for it. Using `||` is what actually applies
// the default -- with `??`, an unset SNAPSHOT_PRICE_LIMIT becomes Number('')
// === 0 and the build silently prices nothing.
const COUNTRY = ENV.COUNTRY || 'US';

const log = (m) => console.log(`  ${m}`);

/** Watchlist: games you want price/deal data for but may not own. */
async function loadWatchlist() {
  const file = path.join(PATHS.root, 'watchlist.txt');
  if (!existsSync(file)) return [];
  const text = await readFile(file, 'utf8');
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter(Boolean);
}

async function main() {
  const startedAt = Date.now();
  console.log('Building GameVault snapshot');
  console.log('');

  // ---- 1. Ownership ------------------------------------------------------
  // In CI the CLI-backed providers (Epic/Amazon) only work if their tokens
  // were restored from secrets; syncLibrary already degrades per-provider.
  console.log('1. Ownership');
  let library;
  try {
    library = await syncLibrary(ENV);
  } catch (e) {
    log(`sync failed (${e.message}) - falling back to the last good library`);
    library = await loadLibrary();
  }
  const stores = {};
  for (const [name, rec] of Object.entries(library.stores ?? {})) {
    stores[name] = { ok: rec.ok !== false, count: rec.count ?? 0, error: rec.error ?? null };
    log(`${name.padEnd(10)} ${rec.ok !== false ? `${rec.count ?? 0} titles` : `FAILED: ${rec.error}`}`);
  }
  const ownedTitles = Object.values(library.stores ?? {})
    .flatMap((s) => s.games ?? [])
    .map((g) => g.title);
  log(`index: ${Object.keys(library.index ?? {}).length} unique titles`);

  // ---- 2. Subscriptions --------------------------------------------------
  console.log('');
  console.log('2. Subscription rosters');
  const subs = {};
  const collections = await gamepass.allCollections(COUNTRY).catch((e) => {
    log(`rosters failed: ${e.message}`);
    return {};
  });
  for (const [key, coll] of Object.entries(collections)) {
    // Only the normalised key is needed for lookups; dropping the rest
    // keeps the snapshot small enough to decrypt fast on a phone.
    subs[key] = { label: coll.label, count: coll.count, norms: coll.games.map((g) => g.norm) };
    log(`${coll.label.padEnd(20)} ${coll.count}`);
  }

  // ---- 3. Prices ---------------------------------------------------------
  console.log('');
  console.log('3. Prices and historical lows');
  const watchlist = await loadWatchlist();
  log(`watchlist: ${watchlist.length} entries`);

  // Price the watchlist plus your owned titles, de-duplicated. Owned games
  // still get prices so the app can show "you own this, and it is 80% off"
  // -- useful for gifting, and for spotting a better edition.
  const wanted = [...new Set([...watchlist, ...ownedTitles].map((t) => t.trim()).filter(Boolean))];
  const cap = Number(ENV.SNAPSHOT_PRICE_LIMIT) || 400;
  const priceTargets = wanted.slice(0, cap);
  if (wanted.length > cap) {
    log(`capping at ${cap} titles (set SNAPSHOT_PRICE_LIMIT to raise)`);
  }

  const prices = {};
  if (!itad.hasKey(ENV)) {
    log('no ITAD key - skipping prices and historical lows');
  } else {
    let done = 0;
    // Small concurrency: ITAD is generous but this is a background job, and
    // being a good citizen costs nothing here.
    const chunks = [];
    for (let i = 0; i < priceTargets.length; i += 20) chunks.push(priceTargets.slice(i, i + 20));

    for (const chunk of chunks) {
      const found = await pool(chunk, 4, async (title) => {
        const g = await itad.lookup(title, ENV).catch(() => null);
        return g ? { title, id: g.id } : null;
      });
      const hits = found.filter((x) => x && !x.__error && x.id);
      if (hits.length) {
        const ids = hits.map((h) => h.id);
        const [deals, lows] = await Promise.all([
          itad.prices(ids, ENV, COUNTRY).catch(() => ({})),
          itad.historyLow(ids, ENV, COUNTRY).catch(() => ({})),
        ]);
        for (const h of hits) {
          const d = deals[h.id] ?? [];
          const low = lows[h.id] ?? null;
          const best = bestOffer(d);
          if (!best && !low) continue;
          prices[normalizeTitle(h.title)] = {
            title: h.title,
            best: best ? { shop: best.shop, amount: best.price.amount, currency: best.price.currency, url: best.url } : null,
            regular: best?.regular?.amount ?? null,
            low: low ? { amount: low.amount, currency: low.currency, shop: low.shop } : null,
            deals: d.filter((x) => x.price)
              .sort((a, b) => a.price.amount - b.price.amount)
              .slice(0, 6)
              .map((x) => ({ shop: x.shop, amount: x.price.amount, cut: x.discountPct, url: x.url })),
          };
        }
      }
      done += chunk.length;
      process.stdout.write(`\r  priced ${done}/${priceTargets.length}`);
    }
    process.stdout.write('\n');
    log(`${Object.keys(prices).length} titles have price data`);
  }

  // ---- 4. Pre-compute verdicts ------------------------------------------
  // Doing this here rather than in the browser keeps the client trivial and
  // means the verdict logic has exactly one implementation (lib/deal.mjs),
  // already covered by tests.
  console.log('');
  console.log('4. Deal verdicts');
  const entitled = gamepass.entitledCollections(ENV);
  const verdicts = {};
  for (const [norm, p] of Object.entries(prices)) {
    const owned = (library.index?.[norm] ?? []).length > 0;
    const access = [];
    for (const [key, s] of Object.entries(subs)) {
      if (s.norms.includes(norm)) {
        access.push({ service: key, label: s.label, entitled: entitled.keys.includes(key) });
      }
    }
    verdicts[norm] = scoreDeal({
      owned,
      access,
      current: p.best?.amount ?? null,
      regular: p.regular,
      low: p.low?.amount ?? null,
    });
  }
  log(`${Object.keys(verdicts).length} verdicts computed`);

  // ---- 4b. Free-to-keep giveaways ----------------------------------------
  // Cheap (one public request) and time-sensitive: a giveaway missed is gone.
  console.log('');
  console.log('4b. Free to keep right now');
  const freebies = await currentFreebies(ENV, library.index ?? {}).catch((e) => {
    log(`freebies failed: ${e.message}`);
    return [];
  });
  for (const f of freebies) {
    log(`${f.title} - ${f.ownedHere ? 'already owned on Epic' : 'WORTH CLAIMING'}`);
  }
  if (!freebies.length) log('nothing free right now');

  // ---- 5. Assemble -------------------------------------------------------
  // EA rotates its remid cookie when it is used, so the stored secret is spent
  // after a single build. Writing the replacement back is the only way a
  // scheduled build keeps working; without it EA would sync once and then fail
  // every time, looking exactly like an expired credential.
  if (ENV.EA_REMID && ENV.GAMEVAULT_SECRETS_TOKEN) {
    try {
      const ea = await import('../lib/ea.mjs');
      if (ea.rotatedRemid && ea.rotatedRemid !== ENV.EA_REMID) {
        const [{ putSecret }, nacl, blakejs] = await Promise.all([
          import('../lib/github-secrets.mjs'),
          import('tweetnacl').then((m) => m.default ?? m),
          import('blakejs'),
        ]);
        const repo = ENV.GITHUB_REPOSITORY;
        await putSecret(ENV.GAMEVAULT_SECRETS_TOKEN, repo, 'EA_REMID', ea.rotatedRemid,
                        { nacl, blake2b: blakejs.blake2b });
        console.log('  EA issued a replacement cookie; EA_REMID updated.');
      }
    } catch (e) {
      // Never fatal: a snapshot without a refreshed cookie is still a good
      // snapshot, and the next build will simply report EA as failing.
      console.log(`  could not update EA_REMID: ${e.message}`);
    }
  }
  // Which providers are wired up, so the app can explain an empty library
  // instead of just showing "0 games owned". This goes INSIDE the encrypted
  // payload -- it names the services you use, which is nobody else's
  // business on a public repo.
  const providers = await providerStatus(ENV).catch(() => ({}));

  const snapshot = {
    builtAt: new Date().toISOString(),
    country: COUNTRY,
    entitled: entitled.keys,
    entitledAssumed: entitled.assumed,
    stores,
    providers,
    freebies,
    // The index maps normalised title -> where you own it.
    index: library.index ?? {},
    subs,
    prices,
    verdicts,
    counts: {
      owned: Object.keys(library.index ?? {}).length,
      subscriptions: Object.values(subs).reduce((n, s) => n + s.count, 0),
      priced: Object.keys(prices).length,
    },
  };

  await mkdir(OUT_DIR, { recursive: true });

  const passphrase = ENV.SNAPSHOT_PASSPHRASE;
  let payload;
  if (passphrase) {
    const { encryptJson } = await import('../lib/snapshot-crypto.mjs');
    payload = await encryptJson(snapshot, passphrase);
    console.log('');
    log('encrypted (AES-256-GCM, PBKDF2-SHA256)');
  } else {
    payload = { format: 'gamevault-plain-snapshot', version: 1, snapshot };
    console.log('');
    log('WARNING: SNAPSHOT_PASSPHRASE is not set - writing PLAINTEXT.');
    log('         Never publish a plaintext snapshot to a public repo.');
  }

  const file = path.join(OUT_DIR, 'snapshot.json');
  await writeFile(file, JSON.stringify(payload), 'utf8');

  // A tiny public manifest so the app can show freshness before unlocking.
  await writeFile(path.join(OUT_DIR, 'snapshot-meta.json'), JSON.stringify({
    builtAt: snapshot.builtAt,
    encrypted: Boolean(passphrase),
    counts: snapshot.counts,
  }), 'utf8');

  const kb = (JSON.stringify(payload).length / 1024).toFixed(1);
  console.log('');
  console.log(`Wrote ${file} (${kb} KB) in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  console.log(`  owned ${snapshot.counts.owned} | subs ${snapshot.counts.subscriptions} | priced ${snapshot.counts.priced}`);
}

main().catch((e) => {
  console.error('Snapshot build failed:', e.message);
  process.exit(1);
});
