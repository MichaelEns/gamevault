/**
 * Deal scoring.
 *
 * The question is "should I buy this now?", and a raw discount percentage
 * answers it badly: publishers inflate MSRP, and "-75%" means nothing if
 * the game hit -85% twice last year. The historical low is the honest
 * yardstick, so it dominates the verdict whenever we have it.
 */

export const VERDICT = {
  OWNED: 'owned',
  INCLUDED: 'included',
  FREE: 'free',
  BEST_EVER: 'best-ever',
  MATCHES_LOW: 'matches-low',
  NEAR_LOW: 'near-low',
  GOOD: 'good',
  MEH: 'meh',
  WAIT: 'wait',
  FULL_PRICE: 'full-price',
  UNKNOWN: 'unknown',
};

const LABEL = {
  [VERDICT.OWNED]: 'You already own this',
  [VERDICT.INCLUDED]: 'Included in your subscription',
  [VERDICT.FREE]: 'Free',
  [VERDICT.BEST_EVER]: 'Best price ever',
  [VERDICT.MATCHES_LOW]: 'Matches historical low',
  [VERDICT.NEAR_LOW]: 'Close to historical low',
  [VERDICT.GOOD]: 'Good discount',
  [VERDICT.MEH]: 'Modest discount',
  [VERDICT.WAIT]: 'Wait for a better sale',
  [VERDICT.FULL_PRICE]: 'Full price',
  [VERDICT.UNKNOWN]: 'Not enough price data',
};

const RANK = {
  [VERDICT.OWNED]: 0,
  [VERDICT.INCLUDED]: 1,
  [VERDICT.FREE]: 2,
  [VERDICT.BEST_EVER]: 3,
  [VERDICT.MATCHES_LOW]: 4,
  [VERDICT.NEAR_LOW]: 5,
  [VERDICT.GOOD]: 6,
  [VERDICT.MEH]: 7,
  [VERDICT.WAIT]: 8,
  [VERDICT.FULL_PRICE]: 9,
  [VERDICT.UNKNOWN]: 10,
};

/**
 * @param {object} o
 * @param {boolean} o.owned           already in your library
 * @param {Array}  o.access           subscription hits (Game Pass / EA Play)
 * @param {number} o.current          best current price
 * @param {number} [o.regular]        list price
 * @param {number} [o.low]            all-time low
 */
export function scoreDeal({ owned, access = [], current, regular, low }) {
  if (owned) return build(VERDICT.OWNED, 'Already in your library — do not buy again.');

  // Only subscriptions you actually hold can justify skipping a purchase.
  // A title on Console Game Pass is useless to a PC-only subscriber, and
  // reporting it as "included" would make you skip a game you cannot launch.
  const entitled = access.filter((a) => a.entitled !== false);
  const notEntitled = access.filter((a) => a.entitled === false);

  if (entitled.length) {
    const names = entitled.map((a) => a.label).join(', ');
    return build(VERDICT.INCLUDED, `Playable at no extra cost via ${names}.`);
  }

  // Not entitled, but worth surfacing -- it changes what you might buy.
  const aside = notEntitled.length
    ? ` (on ${notEntitled.map((a) => a.label).join(', ')}, which your plan does not include)`
    : '';

  if (current === 0) return build(VERDICT.FREE, `Currently free.${aside}`);
  if (current === null || current === undefined) {
    return build(VERDICT.UNKNOWN, `No current price found on the tracked stores.${aside}`);
  }

  const pctOffRegular =
    regular && regular > 0 ? Math.round((1 - current / regular) * 100) : 0;

  // Without a historical low we can only judge the discount itself, and we
  // say so rather than implying more confidence than we have.
  if (low === null || low === undefined) {
    const why =
      `${pctOffRegular}% off list. No price history available ` +
      `(add an ITAD key for historical lows).${aside}`;
    if (pctOffRegular >= 60) return build(VERDICT.GOOD, why, { pctOffRegular });
    if (pctOffRegular >= 30) return build(VERDICT.MEH, why, { pctOffRegular });
    if (pctOffRegular > 0) return build(VERDICT.WAIT, why, { pctOffRegular });
    return build(VERDICT.FULL_PRICE, why, { pctOffRegular });
  }

  const deltaVsLow = current - low;
  const pctAboveLow = low > 0 ? (deltaVsLow / low) * 100 : deltaVsLow > 0 ? 100 : 0;
  const extra = { pctOffRegular, low, deltaVsLow: round2(deltaVsLow) };

  if (current < low - 0.005) {
    return build(VERDICT.BEST_EVER, `Cheapest it has ever been — beats the previous low of ${fmt(low)}.${aside}`, extra);
  }
  if (Math.abs(deltaVsLow) <= 0.005) {
    return build(VERDICT.MATCHES_LOW, `Exactly matches the all-time low of ${fmt(low)}.${aside}`, extra);
  }
  if (pctAboveLow <= 10) {
    return build(VERDICT.NEAR_LOW, `Within ${Math.round(pctAboveLow)}% of the all-time low (${fmt(low)}).${aside}`, extra);
  }
  if (pctAboveLow <= 25) {
    return build(VERDICT.GOOD, `${fmt(deltaVsLow)} above the all-time low (${fmt(low)}) — a solid buy.${aside}`, extra);
  }
  if (pctAboveLow <= 60) {
    return build(VERDICT.MEH, `${fmt(deltaVsLow)} above the all-time low (${fmt(low)}).${aside}`, extra);
  }
  return build(
    VERDICT.WAIT,
    `Well above the all-time low of ${fmt(low)} — it has been ${fmt(deltaVsLow)} cheaper. Wait.${aside}`,
    extra,
  );
}

function build(verdict, reason, extra = {}) {
  return { verdict, label: LABEL[verdict], rank: RANK[verdict], reason, ...extra };
}

const round2 = (n) => Math.round(n * 100) / 100;
const fmt = (n) => `$${round2(Math.abs(n)).toFixed(2)}`;

/** Best (cheapest) purchasable offer from a list of store deals. */
export function bestOffer(deals) {
  const priced = (deals ?? []).filter((d) => d.price && typeof d.price.amount === 'number');
  if (!priced.length) return null;
  return priced.reduce((a, b) => (b.price.amount < a.price.amount ? b : a));
}
