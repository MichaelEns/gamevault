/**
 * Free-to-keep games, and whether you already have them.
 *
 * Epic gives away one or two games a week - occasionally one a day during
 * sales - and they are permanent once claimed. The cost of missing one is
 * small but real, and the cost of checking manually every week is exactly the
 * chore this app exists to remove.
 *
 * Two rules from the request, and they are not the same rule:
 *   - do NOT bother claiming something you already own on that same store
 *   - DO claim it even if you own it elsewhere, because a second permanent
 *     copy on another store is still worth having and costs nothing
 *
 * That second rule is why this reports ownership per store rather than as a
 * single yes/no. "You own this on Steam" is not a reason to skip a free Epic
 * copy; "you own this on Epic" is.
 */
import { req } from './http.mjs';
import { cached, TTL } from './cache.mjs';
import { normalizeTitle } from './match.mjs';

const EPIC_PROMOS =
  'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions';

/**
 * Games Epic is giving away right now.
 *
 * Epic's payload also contains UPCOMING giveaways and ordinary discounts, so
 * an entry only counts when the discount is 100% and the window is open. A
 * percentage of 0 in Epic's terms means "you pay 0% of the price".
 */
export async function epicFreeGames(country = 'US') {
  return cached(`freebies:epic:${country}`, TTL.price, async () => {
    const url = `${EPIC_PROMOS}?locale=en-US&country=${country}&allowCountries=${country}`;
    const data = await req(url, { retries: 1 });
    const elements = data?.data?.Catalog?.searchStore?.elements ?? [];
    const now = Date.now();
    const out = [];

    for (const el of elements) {
      const offers = el?.promotions?.promotionalOffers ?? [];
      for (const group of offers) {
        for (const promo of group?.promotionalOffers ?? []) {
          if (promo?.discountSetting?.discountPercentage !== 0) continue;
          const startsAt = Date.parse(promo.startDate);
          const endsAt = Date.parse(promo.endDate);
          if (!(now >= startsAt && now <= endsAt)) continue;

          // Epic's slug lives in one of several places depending on how the
          // product was published; a wrong slug is a dead link.
          const slug = el?.catalogNs?.mappings?.[0]?.pageSlug
                    ?? el?.offerMappings?.[0]?.pageSlug
                    ?? el?.productSlug
                    ?? el?.urlSlug;

          out.push({
            store: 'epic',
            title: (el.title ?? '').trim(),
            norm: normalizeTitle(el.title ?? ''),
            endsAt: promo.endDate,
            // Needed to build a direct claim link.
            namespace: el?.namespace ?? null,
            offerId: el?.id ?? null,
            // The slug is Epic's own `pageSlug`, so it is as authoritative as
            // it gets - but it cannot be verified from a script, because
            // store.epicgames.com sits behind bot protection that answers an
            // identical 403 challenge for real and invented slugs alike. So a
            // direct link is offered, and the free-games page is always shown
            // alongside it: if a slug is ever wrong, the user is still one
            // click from the right place rather than staring at a dead link.
            url: slug
              ? `https://store.epicgames.com/en-US/p/${slug}`
              : FREE_GAMES_PAGE,
            hasDirectLink: Boolean(slug),
          });
        }
      }
    }

    // Epic sometimes lists the same giveaway under several offer entries.
    const seen = new Set();
    return out.filter((g) => {
      if (!g.norm || seen.has(g.norm)) return false;
      seen.add(g.norm);
      return true;
    });
  });
}

/**
 * Annotate free games with where you already own them.
 *
 * @param {object} index  normalised title -> ARRAY of { store, title, id, url }
 *
 * The shape matters and got this wrong once: lib/library.mjs builds the index
 * as an array of entries per title, not an object keyed by store. Reading it
 * with Object.keys() yielded ["0"], so nothing ever matched, every giveaway
 * was reported as unowned, and the note read "you own it on 0". The test
 * passed because it used an invented index shape rather than the real one.
 */
export function annotateOwnership(freebies, index = {}) {
  return freebies.map((g) => {
    const entries = index[g.norm];
    const owners = [...new Set(
      (Array.isArray(entries) ? entries : [])
        .map((e) => e?.store)
        .filter(Boolean),
    )];
    const ownedHere = owners.includes(g.store);
    return {
      ...g,
      ownedHere,
      ownedElsewhere: owners.filter((s) => s !== g.store),
      // The whole point: worth claiming unless you already have it HERE.
      worthClaiming: !ownedHere,
    };
  });
}

/** Everything currently free, annotated. Country affects Epic's catalogue. */
export async function currentFreebies(env, index = {}) {
  const country = env?.COUNTRY || 'US';
  const epic = await epicFreeGames(country).catch(() => []);
  return annotateOwnership(epic, index);
}

/** How long is left, in the terms a person would use. */
export function timeLeft(endsAt, now = Date.now()) {
  const ms = Date.parse(endsAt) - now;
  if (!Number.isFinite(ms) || ms <= 0) return 'ended';
  const hours = Math.floor(ms / 3600000);
  if (hours < 1) return `${Math.max(1, Math.round(ms / 60000))} minutes left`;
  if (hours < 48) return `${hours} hours left`;
  return `${Math.floor(hours / 24)} days left`;
}
