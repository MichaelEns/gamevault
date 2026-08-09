import { req } from './http.mjs';
import { cached, TTL } from './cache.mjs';
import { isAddon } from './match.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { PATHS } from './paths.mjs';

const execFileAsync = promisify(execFile);
const GQL = 'https://store.epicgames.com/graphql';

const SEARCH_QUERY = `
query searchStoreQuery($keywords: String, $country: String!, $locale: String, $count: Int) {
  Catalog {
    searchStore(keywords: $keywords, country: $country, locale: $locale, count: $count) {
      elements {
        title
        id
        namespace
        offerType
        productSlug
        urlSlug
        keyImages { type url }
        price(country: $country) {
          totalPrice { discountPrice originalPrice currencyCode }
        }
      }
    }
  }
}`;

/** Search the Epic storefront. No auth required. */
export async function search(term, country = 'US') {
  const body = JSON.stringify({
    query: SEARCH_QUERY,
    variables: { keywords: term, country, locale: 'en-US', count: 20 },
  });
  const data = await cached(`epic:search:${country}:${term}`, TTL.search, () =>
    req(GQL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }),
  );

  const els = data?.data?.Catalog?.searchStore?.elements ?? [];
  return els
    .filter((e) => !isAddon(e.title))
    .filter((e) => !['ADDON', 'DLC'].includes(String(e.offerType ?? '').toUpperCase()))
    .map((e) => {
      const tp = e.price?.totalPrice;
      const cur = tp?.currencyCode || 'USD';
      const slug = e.productSlug || e.urlSlug;
      const img = (e.keyImages ?? []).find((k) =>
        ['OfferImageWide', 'DieselStoreFrontWide', 'Thumbnail'].includes(k.type),
      );
      return {
        store: 'epic',
        id: e.id,
        title: e.title,
        url: slug ? `https://store.epicgames.com/en-US/p/${String(slug).replace(/\/home$/, '')}` : null,
        image: img?.url ?? null,
        price: tp
          ? {
              current: { amount: tp.discountPrice / 100, currency: cur },
              original: { amount: tp.originalPrice / 100, currency: cur },
              discountPct:
                tp.originalPrice > 0
                  ? Math.round((1 - tp.discountPrice / tp.originalPrice) * 100)
                  : 0,
              isFree: tp.discountPrice === 0,
            }
          : null,
      };
    });
}

function legendaryPath() {
  // Explicit override wins (the container installs it outside the project).
  if (process.env.GAMEVAULT_LEGENDARY_BIN) return process.env.GAMEVAULT_LEGENDARY_BIN;
  if (existsSync(PATHS.venvWin)) return PATHS.venvWin;
  if (existsSync(PATHS.venvNix)) return PATHS.venvNix;
  return 'legendary'; // fall back to a system-wide install on PATH
}

/** Is legendary present and already authenticated? */
export async function authStatus() {
  const bin = legendaryPath();
  try {
    const { stdout } = await execFileAsync(bin, ['status', '--json'], {
      timeout: 30000,
      windowsHide: true,
    });
    const out = (stdout || '').trim();
    const parsed = JSON.parse(out);
    // legendary reports the literal string "<not logged in>" (angle brackets
    // included) when there is no session -- not null, not absent. Treating a
    // truthy `account` as logged in would report a working Epic provider
    // that fails the moment you sync.
    const acct = String(parsed?.account ?? '').trim();
    const loggedIn = Boolean(acct) && !/^<.*>$/.test(acct) && !/not logged in/i.test(acct);
    return {
      installed: true,
      loggedIn,
      account: loggedIn ? acct : null,
      gamesAvailable: parsed?.games_available ?? 0,
    };
  } catch (e) {
    if (e.code === 'ENOENT') return { installed: false, loggedIn: false, account: null };
    return {
      installed: true,
      loggedIn: false,
      account: null,
      error: (e.stderr || e.message || '').slice(0, 300),
    };
  }
}

/**
 * Owned Epic games via the legendary CLI.
 *
 * legendary holds its own OAuth token from `legendary auth`, so we never
 * see or store Epic credentials ourselves.
 */
export async function ownedGames() {
  const bin = legendaryPath();
  const status = await authStatus();
  if (!status.installed) {
    throw new Error('legendary is not installed. Run: .venv\\Scripts\\pip install legendary-gl');
  }
  if (!status.loggedIn) {
    throw new Error('legendary is not logged in. Run: .venv\\Scripts\\legendary auth');
  }

  const { stdout } = await execFileAsync(bin, ['list', '--json'], {
    timeout: 120000,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  const games = JSON.parse(stdout || '[]');
  return games
    .filter((g) => !g.is_dlc)
    .map((g) => ({
      store: 'epic',
      id: g.app_name,
      title: g.app_title ?? g.title ?? g.app_name,
      url: null,
    }))
    .filter((g) => !isAddon(g.title));
}
