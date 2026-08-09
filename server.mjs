import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';

import { settle, pool } from './lib/http.mjs';
import { normalizeTitle, bestMatch, isRelevant } from './lib/match.mjs';
import { scoreDeal, bestOffer } from './lib/deal.mjs';
import { PATHS } from './lib/paths.mjs';
import { sessionInfo } from './lib/sessions.mjs';
import {
  configuredHash, verifyPassword, loadOrCreateSecret, mintToken,
  isAuthed, isThrottled, noteFailure, clearFailures,
  sessionCookie, clearCookie, requireAuthOrRefuse,
} from './lib/auth.mjs';
import * as steam from './lib/steam.mjs';
import * as gog from './lib/gog.mjs';
import * as itch from './lib/itch.mjs';
import * as nintendo from './lib/nintendo.mjs';
import * as manual from './lib/manual.mjs';
import * as epic from './lib/epic.mjs';
import * as itad from './lib/itad.mjs';
import * as gamepass from './lib/gamepass.mjs';
import { loadLibrary, syncLibrary, findOwned, providerStatus } from './lib/library.mjs';

const ROOT = PATHS.root;
const PORT = Number(process.env.PORT ?? 8787);

/** Minimal .env loader -- keeps secrets out of the shell history. */
async function loadEnv() {
  const env = { ...process.env };
  if (!existsSync(PATHS.env)) return env;
  const text = await readFile(PATHS.env, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i);
    if (!m) continue;
    let v = m[2].trim().replace(/^["']|["']$/g, '');
    if (v) env[m[1]] = v;
  }
  return env;
}
let ENV = await loadEnv();

const HOST = ENV.HOST ?? '0.0.0.0';
const AUTH_HASH = configuredHash(ENV);
const SESSION_SECRET = await loadOrCreateSecret();

// Hard-fail rather than silently publishing a personal library to the internet.
requireAuthOrRefuse({ hash: AUTH_HASH, host: HOST });

/** Behind a reverse proxy (Fly, Cloudflare, nginx) the real scheme/IP is in headers. */
const TRUST_PROXY = String(ENV.TRUST_PROXY ?? 'true') !== 'false';
const clientIp = (req) =>
  (TRUST_PROXY && (req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()) ||
  req.socket.remoteAddress || 'unknown';
const isHttps = (req) =>
  (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https') ||
  Boolean(req.socket.encrypted);

async function readBody(req, limit = 8192) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};

function send(res, status, body, type = 'application/json') {
  const payload = type === 'application/json' ? JSON.stringify(body) : body;
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(payload);
}

/**
 * Core query: everything you need to decide at sale time.
 * Ownership + subscription access + best price + deal verdict.
 */
async function handleSearch(term, country) {
  const lib = await loadLibrary();

  const [steamRes, gogRes, itchRes, nintendoRes, subsRes, itadRes] = await Promise.all([
    settle('steam', steam.search(term, country)),
    settle('gog', gog.search(term, country)),
    ENV.ITCH_API_KEY ? settle('itch', itch.search(term, ENV)) : Promise.resolve({ store: 'itch', ok: true, data: [] }),
    settle('nintendo', nintendo.search(term, country)),
    settle('subs', gamepass.allCollections(country)),
    itad.hasKey(ENV) ? settle('itad', itad.search(term, ENV, 20)) : Promise.resolve({ store: 'itad', ok: false, error: 'no ITAD key' }),
  ]);

  const storeHits = [
    ...(steamRes.ok ? steamRes.data : []),
    ...(gogRes.ok ? gogRes.data : []),
    ...(itchRes.ok ? itchRes.data : []),
    ...(nintendoRes.ok ? nintendoRes.data : []),
  ];

  // Group storefront hits into games by normalised title.
  const groups = new Map();
  for (const hit of storeHits) {
    const key = normalizeTitle(hit.title);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, { key, title: hit.title, offers: [] });
    groups.get(key).offers.push(hit);
  }

  // ITAD supplies cross-store pricing and, crucially, historical lows.
  let itadPrices = {};
  let itadLows = {};
  let itadById = new Map();
  if (itadRes.ok && itadRes.data?.length) {
    const wanted = itadRes.data.slice(0, 12);
    for (const g of wanted) itadById.set(g.id, g);
    const ids = wanted.map((g) => g.id);
    const [p, l] = await Promise.all([
      itad.prices(ids, ENV, country).catch(() => ({})),
      itad.historyLow(ids, ENV, country).catch(() => ({})),
    ]);
    itadPrices = p;
    itadLows = l;

    // Include ITAD-only titles so Epic-exclusive games still show up
    // even though Epic's own API is unreachable.
    for (const g of wanted) {
      const key = normalizeTitle(g.title);
      if (!groups.has(key)) groups.set(key, { key, title: g.title, offers: [] });
    }
  }

  const subs = subsRes.ok ? subsRes.data : {};
  const entitled = gamepass.entitledCollections(ENV);

  const results = [...groups.values()]
    .filter((g) => isRelevant(term, g.title))
    .map((g) => {
    const owned = findOwned(g.title, lib);
    const access = gamepass.findAccess(g.title, subs, entitled.keys);

    // Attach ITAD data by fuzzy-matching this group's title.
    const itadMatch = bestMatch(g.title, [...itadById.values()], (x) => x.title);
    const deals = itadMatch ? (itadPrices[itadMatch.item.id] ?? []) : [];
    const low = itadMatch ? (itadLows[itadMatch.item.id] ?? null) : null;

    // Cheapest of: ITAD's cross-store deals, or the direct storefront hits.
    const direct = g.offers
      .filter((o) => o.price?.current)
      .map((o) => ({
        shop: o.store,
        price: { amount: o.price.current.amount, currency: o.price.current.currency },
        regular: o.price.original ?? null,
        discountPct: o.price.discountPct ?? 0,
        url: o.url,
      }));
    const allDeals = [...deals, ...direct];
    const best = bestOffer(allDeals);

    const regular =
      best?.regular?.amount ??
      direct.find((d) => d.regular)?.regular?.amount ??
      null;

    const verdict = scoreDeal({
      owned: owned.length > 0,
      access,
      current: best?.price?.amount ?? null,
      regular,
      low: low?.amount ?? null,
    });

    return {
      title: g.title,
      key: g.key,
      owned,
      access,
      best: best ? { shop: best.shop, amount: best.price.amount, currency: best.price.currency, url: best.url } : null,
      regular,
      low,
      deals: allDeals
        .filter((d) => d.price)
        .sort((a, b) => a.price.amount - b.price.amount)
        .slice(0, 10),
      offers: g.offers,
      verdict,
    };
  });

  results.sort((a, b) => a.verdict.rank - b.verdict.rank || a.title.localeCompare(b.title));

  return {
    term,
    country,
    subscriptions: {
      entitled: entitled.keys,
      assumed: entitled.assumed,
      note: entitled.assumed
        ? 'SUBSCRIPTIONS is unset, so ALL Game Pass tiers are assumed. Set it in .env ' +
          '(e.g. SUBSCRIPTIONS=pc) or some titles will be reported as included when your plan does not cover them.'
        : null,
    },
    results,
    sources: {
      steam: steamRes.ok ? 'ok' : steamRes.error,
      gog: gogRes.ok ? 'ok' : gogRes.error,
      itch: itchRes.ok ? 'ok' : itchRes.error,
      nintendo: nintendoRes.ok ? 'ok' : nintendoRes.error,
      subscriptions: subsRes.ok ? `ok (${Object.keys(subs).length} rosters)` : subsRes.error,
      itad: itadRes.ok ? 'ok' : itadRes.error,
      epic: 'store API is Cloudflare-protected; Epic prices come via ITAD, ownership via legendary',
      amazon: 'Prime Gaming has no public API; ownership via the manual library',
    },
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  try {
    // Health is deliberately public: cloud platforms probe it before a
    // session exists. It reveals nothing beyond "the process is up".
    if (p === '/api/health') {
      return send(res, 200, { ok: true, time: new Date().toISOString(), authRequired: Boolean(AUTH_HASH) });
    }

    // ---- authentication gate -------------------------------------------
    if (p === '/api/login' && req.method === 'POST') {
      const ip = clientIp(req);
      if (isThrottled(ip)) {
        return send(res, 429, { error: 'Too many attempts. Wait 15 minutes.' });
      }
      let password = '';
      try {
        password = JSON.parse(await readBody(req))?.password ?? '';
      } catch {
        return send(res, 400, { error: 'bad request' });
      }
      if (!AUTH_HASH || !verifyPassword(password, AUTH_HASH)) {
        noteFailure(ip);
        // Deliberately vague, and no timing signal beyond scrypt itself.
        return send(res, 401, { error: 'Incorrect password.' });
      }
      clearFailures(ip);
      res.setHeader('Set-Cookie', sessionCookie(mintToken(SESSION_SECRET), { secure: isHttps(req) }));
      return send(res, 200, { ok: true });
    }

    if (p === '/api/logout') {
      res.setHeader('Set-Cookie', clearCookie());
      return send(res, 200, { ok: true });
    }

    const authed = isAuthed(req, { hash: AUTH_HASH, secret: SESSION_SECRET });

    // PWA assets stay public. iOS fetches the manifest and icons when you
    // "Add to Home Screen", sometimes before a session cookie is attached,
    // and the service worker must be fetchable to register at all. None of
    // these reveal anything about your library.
    const PUBLIC_ASSETS = new Set([
      '/manifest.webmanifest', '/sw.js', '/style.css',
      '/gamevault.ico', '/favicon.ico',
      '/icon-180.png', '/icon-192.png', '/icon-512.png', '/icon-maskable.png',
    ]);

    // The login page must stay reachable while logged out.
    if (!authed) {
      if (p === '/' || p === '/login' || p === '/login.html') {
        const body = await readFile(path.join(PATHS.public, 'login.html'));
        return send(res, 200, body, 'text/html; charset=utf-8');
      }
      if (PUBLIC_ASSETS.has(p)) {
        const file = p === '/favicon.ico' ? '/gamevault.ico' : p;
        const full = path.join(PATHS.public, file);
        if (existsSync(full)) {
          return send(res, 200, await readFile(full), MIME[path.extname(full)] ?? 'application/octet-stream');
        }
      }
      if (p.startsWith('/api/')) return send(res, 401, { error: 'authentication required' });
      res.writeHead(302, { Location: '/login' });
      return res.end();
    }

    if (p === '/api/status') {
      const lib = await loadLibrary();
      return send(res, 200, {
        providers: await providerStatus(ENV),
        sessions: await sessionInfo(),
        pricing: {
          itad: itad.hasKey(ENV) ? 'ready' : 'ITAD_API_KEY missing — no historical lows, Steam/GOG prices only',
          steam: 'ready (no key needed)',
          gog: 'ready (no key needed)',
        },
        subscriptions: 'ready (no key needed)',
        library: {
          syncedAt: lib.syncedAt,
          stores: Object.fromEntries(
            Object.entries(lib.stores ?? {}).map(([k, v]) => [
              k, { ok: v.ok, count: v.count ?? (v.games?.length ?? 0), error: v.error ?? null },
            ]),
          ),
          totalTitles: Object.keys(lib.index ?? {}).length,
        },
      });
    }

    if (p === '/api/search') {
      const term = (url.searchParams.get('q') ?? '').trim();
      if (!term) return send(res, 400, { error: 'Missing ?q=' });
      const country = url.searchParams.get('cc') ?? ENV.COUNTRY ?? 'US';
      return send(res, 200, await handleSearch(term, country));
    }

    if (p === '/api/manual' && req.method === 'GET') {
      return send(res, 200, {
        stores: manual.MANUAL_STORES,
        summary: await manual.summary(),
        entries: await manual.load(),
      });
    }

    if (p === '/api/manual' && req.method === 'POST') {
      let body;
      try {
        body = JSON.parse(await readBody(req, 256 * 1024));
      } catch {
        return send(res, 400, { error: 'bad request' });
      }
      const { store, titles } = body ?? {};
      if (!store || !manual.MANUAL_STORES[store]) {
        return send(res, 400, { error: `store must be one of: ${Object.keys(manual.MANUAL_STORES).join(', ')}` });
      }
      try {
        const rec = await manual.setStore(store, titles ?? '');
        // Re-index immediately so the new titles are searchable without a
        // separate sync click, and without touching any network provider.
        await syncLibrary(ENV, 'manual');
        return send(res, 200, { store, count: rec.titles.length, updatedAt: rec.updatedAt });
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
    }

    if (p === '/api/library') {
      return send(res, 200, await loadLibrary());
    }

    if (p === '/api/sync' && req.method === 'POST') {
      const only = url.searchParams.get('store');
      const lib = await syncLibrary(ENV, only);
      return send(res, 200, {
        syncedAt: lib.syncedAt,
        stores: Object.fromEntries(
          Object.entries(lib.stores).map(([k, v]) => [
            k, { ok: v.ok, count: v.count ?? 0, error: v.error ?? null },
          ]),
        ),
        totalTitles: Object.keys(lib.index).length,
      });
    }

    if (p === '/api/subscriptions') {
      const country = url.searchParams.get('cc') ?? ENV.COUNTRY ?? 'US';
      const subs = await gamepass.allCollections(country);
      return send(res, 200, Object.fromEntries(
        Object.entries(subs).map(([k, v]) => [k, { label: v.label, count: v.count }]),
      ));
    }

    // Static assets
    const file = p === '/' ? '/index.html' : (p === '/favicon.ico' ? '/gamevault.ico' : p);
    const full = path.join(PATHS.public, file);
    if (!full.startsWith(PATHS.public)) return send(res, 403, { error: 'forbidden' });
    if (existsSync(full)) {
      const body = await readFile(full);
      return send(res, 200, body, MIME[path.extname(full)] ?? 'application/octet-stream');
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, 500, { error: e.message, stack: e.stack?.split('\n').slice(0, 4) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`GameVault listening on http://${HOST}:${PORT}`);
  console.log(`  auth:      ${AUTH_HASH ? 'ENABLED (password required)' : 'disabled (loopback only)'}`);
  console.log(`  ITAD key:  ${itad.hasKey(ENV) ? 'set' : 'MISSING (no historical lows)'}`);
  console.log(`  Steam:     ${ENV.STEAM_API_KEY && ENV.STEAM_ID ? 'configured' : 'not configured'}`);
  console.log(`  itch.io:   ${ENV.ITCH_API_KEY ? 'configured' : 'not configured'}`);
});
