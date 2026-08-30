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
import { selectPriceTargets } from '../lib/price-budget.mjs';
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

// GitHub Actions passes an EMPTY STRING for an unset variable, never
// undefined, so `??` never fires on one and `Number('' ?? 400)` is 0. Every
// default here has to key off emptiness, not nullishness.
const flag = (v, dflt = false) => {
  const s = String(v ?? '').trim();
  return s ? /^(1|true|yes|on)$/i.test(s) : dflt;
};

/** Watchlist: games you want price/deal data for but may not own. */
async function loadWatchlist() {
  // Like the manual library, this has to reach the cloud build somehow: the
  // file is local and gitignored, so a watchlist edited on a PC contributed
  // nothing to the published snapshot.
  const fromEnv = ENV.WATCHLIST;
  if (fromEnv) {
    return fromEnv.split(/[\r\n,]+/).map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean);
  }
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

  // Trending titles are priced too. Without them a search for something you do
  // not own answered "you don't have it" and nothing else - no shops, no
  // prices - which is only half the question. The app now also falls back to a
  // live ITAD lookup for anything missing here, so this is a fast path rather
  // than the only path.
  const trending = await itad.trending(ENV, Number(ENV.TRENDING_LIMIT) || 200).catch(() => []);
  if (trending.length) log(`trending: ${trending.length} titles people are tracking`);

  // Settle the browser question with the real key while we have it.
  const liveCors = flag(ENV.LIVE_PRICES, true) && await itad.corsCheck(ENV);
  log(`live price lookup from the browser: ${liveCors ? 'ALLOWED' : 'blocked (snapshot + store links only)'}`);

  const cap = Number(ENV.SNAPSHOT_PRICE_LIMIT) || 800;

  // Owned titles are NOT priced by default. See lib/price-budget.mjs for why;
  // PRICE_OWNED=1 restores the old behaviour.
  const { targets: priceTargets, counts: budget } = selectPriceTargets({
    watchlist,
    trending: trending.map((t) => t.title),
    owned: ownedTitles,
    cap,
    priceOwned: flag(ENV.PRICE_OWNED, false),
  });
  log(`pricing ${priceTargets.length} titles: ${budget.watchlist} watchlist, ` +
      `${budget.trending} trending, ${budget.owned} owned` +
      (budget.dropped ? ` (${budget.dropped} dropped at the cap)` : ''));

  const prices = {};
  // Identifiers we were handed directly, so they never need looking up again.
  const knownIds = new Map(
    trending.filter((t) => t.id).map((t) => [String(t.title).toLowerCase(), t.id]),
  );
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
        // Trending entries arrive from ITAD with their own ids. Round-tripping
        // those back through an exact-title lookup threw away a reliable
        // identifier in favour of a fuzzy one, and lost roughly four out of
        // five titles: 393 targets produced 79 prices. Use the id when we
        // already have it and only search for titles we do not.
        const known = knownIds.get(title.toLowerCase());
        if (known) return { title, id: known };
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

    // A watchlist entry that silently produces no price is the exact failure
    // this feature exists to prevent, and it is invisible in the totals: the
    // build succeeds, the count looks plausible, and the one game you asked
    // about by name has nothing. Name them so a typo or an unrecognised title
    // is obvious rather than inferred from a number.
    const missed = watchlist.filter((t) => !prices[normalizeTitle(t)]);
    if (missed.length) {
      log(`::warning::no price found for ${missed.length} watchlist title(s): ${missed.join(', ')}`);
      log('the app will look these up live instead; check the spelling if that also fails');
    }
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

  // ---- 4c. Unredeemed Humble keys ----------------------------------------
  // Computed here rather than in a separate tool, because everything needed is
  // already in hand: the Humble library and the ownership index. An unredeemed
  // key is invisible in every library until it is redeemed, which is exactly
  // when someone buys the game a second time.
  const humbleGames = library.stores?.humble?.games ?? [];
  const unredeemedKeys = humbleGames.filter((g) => g.unredeemed);
  const keys = { worthRedeeming: [], keepGiftable: [] };
  for (const g of unredeemedKeys) {
    const entries = (library.index ?? {})[normalizeTitle(g.title)];
    const owners = [...new Set(
      (Array.isArray(entries) ? entries : [])
        .map((e) => e?.store)
        // Humble itself must not count: every unredeemed key is in the Humble
        // library by definition, so counting it would mark them all redundant.
        .filter((s) => s && s !== 'humble'),
    )];
    const entry = { title: g.title, bundle: g.bundle ?? null, keyType: g.keyType ?? null, ownedOn: owners };
    // A key for a game you already own is worth MORE unrevealed: revealing it
    // makes a duplicate and ends the one thing it could still do, be gifted.
    if (owners.length) keys.keepGiftable.push(entry);
    else keys.worthRedeeming.push(entry);
  }
  if (unredeemedKeys.length) {
    console.log('');
    console.log('4c. Unredeemed Humble keys');
    log(`${keys.worthRedeeming.length} worth redeeming, ${keys.keepGiftable.length} worth keeping giftable`);
  }

  // ---- 4d. Claim free games, and check the last lot arrived ---------------
  // Order matters: verify BEFORE claiming, so a claim made minutes ago is not
  // immediately judged against a library that predates it.
  const claimsMod = await import('../lib/claims.mjs');
  const siteUrl = ENV.SITE_URL || (ENV.GITHUB_REPOSITORY
    ? `https://${ENV.GITHUB_REPOSITORY.split('/')[0].toLowerCase()}.github.io/${ENV.GITHUB_REPOSITORY.split('/')[1]}`
    : null);
  const previousLog = await claimsMod.loadPreviousClaims(siteUrl, ENV.SNAPSHOT_PASSPHRASE);
  const outcome = claimsMod.verifyClaims(previousLog, library.index ?? {});

  if (previousLog.length) {
    console.log('');
    console.log('4d. Verifying previous claims');
    for (const v of outcome.verified) log(`${v.title} - arrived, confirmed owned`);
    for (const p of outcome.pending) log(`${p.title} - claimed, not yet visible (still within grace)`);
    for (const f of outcome.failed) log(`${f.title} - DID NOT ARRIVE: ${f.reason}`);
  }

  let attempts = [];
  const claimers = {
    epic: await import('../lib/epic-claim.mjs'),
    gog: await import('../lib/gog-claim.mjs'),
  };
  const claimable = freebies.filter((f) => f.worthClaiming);

  if (claimable.length) {
    console.log('');
    console.log('4e. Claiming free games');
    // Never re-attempt something already tracked, or a failed claim would be
    // retried on every single build.
    const tracked = new Set(previousLog.filter((e) => !e.giveUp).map((e) => e.norm));

    for (const [store, mod] of Object.entries(claimers)) {
      const todo = claimable.filter((f) => f.store === store && !tracked.has(f.norm));
      if (!todo.length) continue;
      if (!mod.configured(ENV)) {
        log(`${todo.length} free on ${store}, but it is not set up for claiming`);
        continue;
      }
      for (const game of todo) {
        try {
          await mod.claim(ENV, game);
          log(`${game.title} (${store}) - claimed`);
          attempts.push(claimsMod.recordAttempt(game, { ok: true }));
        } catch (e) {
          // Already owned is not a failure and must not be recorded as one.
          if (e.alreadyOwned) { log(`${game.title} (${store}) - already owned`); continue; }
          log(`${game.title} (${store}) - FAILED: ${e.message}`);
          attempts.push(claimsMod.recordAttempt(game, { ok: false, error: e.message }));
        }
        // Paced deliberately: there is no throughput to gain from bursts, and
        // a burst of purchase requests is the pattern worth avoiding.
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    if (!attempts.length) log('nothing new to claim');
  }

  const claimLog = claimsMod.nextLog({ pending: outcome.pending, failed: outcome.failed, attempts });
  const claimFailures = claimsMod.reportable(claimLog);

  // ---- 5. Assemble -------------------------------------------------------
  // Some providers hand out rotating credentials: EA replaces its remid
  // cookie, Ubisoft issues a new remember-me ticket, and in both cases the old
  // value stops working. A stored secret is therefore spent after a single
  // build unless the replacement is written back - which produces the
  // particularly confusing failure of a source that syncs once and then never
  // again, looking exactly like a bad credential.
  if (ENV.GAMEVAULT_SECRETS_TOKEN && ENV.GITHUB_REPOSITORY) {
    const rotations = [];
    try {
      const eaMod = await import('../lib/ea.mjs');
      const fresh = eaMod.currentCookies(ENV);
      if (ENV.EA_REMID && fresh.remid && fresh.remid !== ENV.EA_REMID) {
        rotations.push(['EA_REMID', fresh.remid]);
      }
      if (fresh.sid && fresh.sid !== ENV.EA_SID) rotations.push(['EA_SID', fresh.sid]);
      // Printed so the schedule can be checked against reality: if a cookie
      // lives less than the six hours between builds, the refresh chain
      // cannot sustain itself and that needs to be visible.
      if (eaMod.cookieLifetimes) log(`EA cookie lifetimes: ${eaMod.cookieLifetimes}`);
    } catch { /* EA not configured */ }
    try {
      const ubiMod = await import('../lib/ubisoft.mjs');
      if (ubiMod.rotatedTicket) rotations.push(['UBISOFT_REMEMBER_TICKET', ubiMod.rotatedTicket]);
    } catch { /* Ubisoft not configured */ }
    try {
      // GOG issues a new refresh token on every use and retires the old one.
      const gogMod = await import('../lib/gog-claim.mjs');
      if (gogMod.rotatedToken) rotations.push(['GOG_REFRESH_TOKEN', gogMod.rotatedToken]);
    } catch { /* GOG not configured */ }
    try {
      // Epic rotates the launcher refresh token when it is used to mint a
      // new access token, so the whole LEGENDARY_CONFIG archive goes stale
      // unless the replacement is kept.
      const epicMod = await import('../lib/epic-claim.mjs');
      if (epicMod.rotatedRefreshToken) rotations.push(['EPIC_REFRESH_TOKEN', epicMod.rotatedRefreshToken]);
    } catch { /* Ubisoft not configured */ }

    if (rotations.length) {
      try {
        const [{ putSecret }, nacl, blakejs] = await Promise.all([
          import('../lib/github-secrets.mjs'),
          import('tweetnacl').then((m) => m.default ?? m),
          import('blakejs'),
        ]);
        for (const [name, value] of rotations) {
          await putSecret(ENV.GAMEVAULT_SECRETS_TOKEN, ENV.GITHUB_REPOSITORY, name, value,
                          { nacl, blake2b: blakejs.blake2b });
          console.log(`  ${name} refreshed (the provider rotated it).`);
        }
      } catch (e) {
        // Loud, and specifically NOT swallowed. A failure here costs nothing
        // today and kills every rotating credential tomorrow, which is exactly
        // the shape of failure that hid twice already: the provider works,
        // then dies a build later for reasons pointing nowhere near this.
        console.log(`::error::Could not refresh rotated credentials: ${e.message}`);
        console.log('  The provider that rotated will fail on the next build.');
        if (/401|403|404/.test(e.message)) {
          console.log('  GAMEVAULT_SECRETS_TOKEN needs "Secrets: Read and write" on this repository.');
        }
      }
    } else if (ENV.UBISOFT_REMEMBER_TICKET || ENV.EA_REMID) {
      // Silence here is ambiguous - it could mean nothing rotated, or that
      // rotation was never detected. Say which.
      log('no credentials rotated this run');
    }
  } else if (ENV.EA_REMID || ENV.UBISOFT_REMEMBER_TICKET) {
    console.log('  note: EA and Ubisoft rotate their credentials. Without ' +
                'GAMEVAULT_SECRETS_TOKEN they will work once and then need re-authenticating.');
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
    keys,
    claimLog,
    claimFailures,
    // The index maps normalised title -> where you own it.
    index: library.index ?? {},
    subs,
    prices,
    verdicts,
    // Credential for live, on-demand price lookup from the browser.
    //
    // Only shipped when the browser can actually use it - measured this build,
    // not assumed. It rides inside the AES-256-GCM payload, so it is readable
    // only by someone who already has your passphrase, and it is a free
    // read-only price key rather than an account credential. Even so, there is
    // no reason to hand out a key that cannot be used. LIVE_PRICES=0 opts out.
    live: liveCors ? { itadKey: ENV.ITAD_API_KEY, country: COUNTRY } : null,
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
    // A count only - the titles are ownership data and belong inside the
    // encrypted payload, but the notifier needs to know whether to notify.
    claimFailures: (snapshot.claimFailures ?? []).length,
    // ...and a title-free description of each one, so the notifier can tell a
    // dead credential (which breaks every future claim) apart from one game
    // being sold out, and can tell "still the same problem" apart from "a new
    // problem" when the count happens not to move. See claims.publicAlerts.
    claimAlerts: claimsMod.publicAlerts(snapshot.claimFailures ?? [],
                                        { secret: passphrase ?? '' }),
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
