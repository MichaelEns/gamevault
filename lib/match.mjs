/**
 * Cross-store title matching.
 *
 * The whole app hinges on this. "Do I own it?" is only as good as our
 * ability to recognise that Steam's `Hades`, Epic's `Hades`, and the
 * Microsoft Store's `Hades - Windows` are one game -- while NOT collapsing
 * `Hades` into `Hades II`, or a game into its soundtrack/DLC.
 *
 * Deliberately conservative: a false positive here tells you that you own
 * something you do not, which is the expensive direction of the error.
 */

// Edition/platform noise that never distinguishes two different games.
const EDITION_NOISE = [
  'game of the year edition', 'game of the year', 'goty edition',
  'definitive edition', 'complete edition', 'ultimate edition',
  'deluxe edition', 'standard edition', 'special edition',
  'enhanced edition', 'remastered edition', 'anniversary edition',
  'gold edition', 'premium edition', 'legendary edition',
  'digital edition', 'collectors edition', 'collector edition',
  'director s cut', 'directors cut',
  'pc edition', 'windows edition',
  'for windows', 'windows 10', 'windows',
  'pc', 'steam edition',
];

// Tokens that mean "this is an add-on, not the base game".
const NON_GAME_MARKERS = [
  'soundtrack', 'ost', 'original soundtrack',
  'dlc', 'expansion pass', 'season pass', 'bundle',
  'demo', 'trial', 'beta', 'playtest', 'art book', 'artbook',
  'wallpaper', 'digital deluxe upgrade', 'upgrade pack',
  'pre-order bonus', 'preorder bonus', 'skin pack',
  'bonus content', 'redmod', 'mod tools', 'sdk',
  // Storefronts list localisation packs as separate zero-price products.
  // They are not the game, and letting them through fills results with
  // "Cyberpunk 2077 Russian Voiceover Pack" entries priced at $0.
  'voiceover pack', 'voice pack', 'language pack', 'audio pack',
  'currency pack', 'credits pack', 'coin pack', 'points pack',
  'character pack', 'weapon pack', 'costume pack', 'outfit pack',
  'avatar', 'theme', 'emote',
];

const ROMAN = {
  i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10,
  xi: 11, xii: 12, xiii: 13, xiv: 14, xv: 15, xvi: 16,
};

/** True when a title looks like DLC/soundtrack/demo rather than a game. */
export function isAddon(title) {
  const t = ` ${basicClean(title)} `;
  if (NON_GAME_MARKERS.some((m) => t.includes(` ${m} `))) return true;
  // Storefronts append a parenthetical to add-ons that would otherwise read
  // like the base game, e.g. "X Voiceover Pack (Base game)".
  if (/\(\s*base game\s*\)/i.test(title)) return true;
  return false;
}

function basicClean(s) {
  return String(s ?? '')
    // Strip these BEFORE NFKD: NFKD expands U+2122 into the literal
    // letters "TM", which would turn "Hades™" into "hadestm".
    .replace(/[\u2122\u00ae\u00a9\u2120]/g, ' ')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')              // combining diacritics
    .replace(/[\u2018\u2019\u201c\u201d]/g, "'")  // smart quotes
    .replace(/[\u2013\u2014]/g, '-')              // en/em dash
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Canonical key for a title. Two titles matching on this key are treated
 * as the same game.
 */
export function normalizeTitle(title) {
  let s = basicClean(title);

  // Trailing " - Windows" style platform suffixes (Microsoft Store habit).
  s = s.replace(/\s+(windows|pc|for pc)$/g, ' ');

  for (const noise of EDITION_NOISE) {
    s = s.replace(new RegExp(`(^|\\s)${noise}(\\s|$)`, 'g'), ' ');
  }

  // Roman numerals -> arabic, so "Hades II" and "Hades 2" agree.
  s = s
    .split(/\s+/)
    .map((w) => (ROMAN[w] !== undefined ? String(ROMAN[w]) : w))
    .join(' ');

  // Leading article only when something follows it.
  s = s.replace(/^(the|a|an)\s+(?=.)/, '');

  return s.replace(/\s+/g, ' ').trim();
}

/** Levenshtein, capped for speed on long strings. */
function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * 0..1 similarity between two raw titles.
 *
 * Hard rule: if both titles carry a trailing series number and the numbers
 * differ, similarity is 0. Edit distance alone rates "Hades" vs "Hades II"
 * as very similar, which would make you think you own a sequel you do not.
 */
export function similarity(a, b) {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const seqA = na.match(/\b(\d{1,2})$/);
  const seqB = nb.match(/\b(\d{1,2})$/);
  if (seqA && seqB && seqA[1] !== seqB[1]) return 0;
  // One has a sequel number and the other does not -> different entries.
  if (Boolean(seqA) !== Boolean(seqB)) {
    const stripped = (seqA ? na : nb).replace(/\s*\d{1,2}$/, '');
    if (stripped === (seqA ? nb : na)) return 0;
  }

  const dist = editDistance(na, nb);
  return 1 - dist / Math.max(na.length, nb.length);
}

export const MATCH_THRESHOLD = 0.87;

export function titlesMatch(a, b) {
  return similarity(a, b) >= MATCH_THRESHOLD;
}

/**
 * Is this result actually relevant to what was searched?
 *
 * Some storefronts (GOG's `like:` operator especially) return loose
 * associations -- searching "hades" yields "DROD RPG: Tendry's Tale".
 * Keep a result only when the query appears as a whole word in the title,
 * or the two titles are genuinely close.
 */
export function isRelevant(term, title) {
  const q = normalizeTitle(term);
  const t = normalizeTitle(title);
  if (!q || !t) return false;
  if (t === q) return true;

  const qWords = q.split(' ').filter(Boolean);
  const tWords = new Set(t.split(' ').filter(Boolean));

  // Every query word present as a whole word in the title.
  if (qWords.every((w) => tWords.has(w))) return true;

  // Single-word query: allow a prefix hit ("portal" -> "portal 2"), which
  // matters because sequels are legitimate results for a series search.
  if (qWords.length === 1 && [...tWords].some((w) => w.startsWith(qWords[0]) && qWords[0].length >= 4)) {
    return true;
  }

  return similarity(term, title) >= 0.6;
}

/**
 * Find the best entry in `candidates` for `title`.
 * Returns null rather than a weak guess.
 */
export function bestMatch(title, candidates, getTitle = (x) => x) {
  let best = null;
  let bestScore = 0;
  for (const c of candidates) {
    const score = similarity(title, getTitle(c));
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return bestScore >= MATCH_THRESHOLD ? { item: best, score: bestScore } : null;
}
