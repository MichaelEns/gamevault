/**
 * Which titles get a price lookup, and in what order.
 *
 * The budget is finite (ITAD is rate-limited and a build has to finish), so
 * this is a genuine allocation problem rather than a formality. It lives in
 * its own module because getting it wrong is silent: the build succeeds, the
 * snapshot looks healthy, and the one search you actually cared about shows
 * no shops.
 *
 * The ordering principle: price what you might BUY.
 *
 *   1. Watchlist - you asked for these by name.
 *   2. Trending  - what an unplanned search is most likely to land on.
 *   3. Owned     - only when explicitly requested. "Is this a good price?"
 *                  is not a question you ask about a game already in your
 *                  library, and 1,400 owned titles will happily consume the
 *                  entire budget and leave nothing for the other two.
 */

/** Trim, drop empties, and drop case-insensitive duplicates already seen. */
function dedupe(list, seen) {
  const out = [];
  for (const raw of list ?? []) {
    const title = String(raw ?? '').trim();
    if (!title) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(title);
  }
  return out;
}

/**
 * @param {object} o
 * @param {string[]} [o.watchlist]  titles you asked to track
 * @param {string[]} [o.trending]   titles other people are tracking
 * @param {string[]} [o.owned]      titles already in your library
 * @param {number}   [o.cap]        maximum lookups this build may spend
 * @param {boolean}  [o.priceOwned] include owned titles at all
 * @returns {{targets: string[], counts: {watchlist:number, trending:number, owned:number, dropped:number}}}
 */
export function selectPriceTargets({
  watchlist = [], trending = [], owned = [], cap = 800, priceOwned = false,
} = {}) {
  const limit = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : 800;
  const seen = new Set();

  const w = dedupe(watchlist, seen);
  const t = dedupe(trending, seen);
  const o = priceOwned ? dedupe(owned, seen) : [];

  const wanted = [...w, ...t, ...o];
  const targets = wanted.slice(0, limit);

  // Report what SURVIVED the cap, not what was requested. A log that says
  // "200 trending" when the cap admitted 12 of them is how a truncated build
  // passes for a healthy one.
  const taken = (list, offset) =>
    Math.max(0, Math.min(list.length, limit - offset));

  return {
    targets,
    counts: {
      watchlist: taken(w, 0),
      trending: taken(t, w.length),
      owned: taken(o, w.length + t.length),
      dropped: wanted.length - targets.length,
    },
  };
}
