/**
 * GameVault — static client.
 *
 * Reads one encrypted snapshot, decrypts it in the browser, and does every
 * lookup locally. There is no server: the whole point is that this works
 * from GitHub Pages, offline, with your PC switched off.
 *
 * The decrypted snapshot is held in memory only. Reloading or locking
 * clears it; the passphrase is never persisted.
 */
import { decryptJson } from './snapshot-crypto.mjs';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

let SNAP = null;

const money = (a, c) =>
  a === null || a === undefined ? '—' : `${!c || c === 'USD' ? '$' : ''}${Number(a).toFixed(2)}${c && c !== 'USD' ? ' ' + c : ''}`;

// ---------- freshness ----------
// Surfaced prominently rather than hidden: a stale price presented
// confidently is worse than an obviously old one.
function ageOf(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  const h = ms / 3_600_000;
  const label = h < 1 ? `${Math.max(1, Math.round(ms / 60_000))} min ago`
    : h < 48 ? `${Math.round(h)}h ago`
    : `${Math.round(h / 24)} days ago`;
  return { hours: h, label, stale: h >= 12, verystale: h >= 72 };
}

// ---------- boot ----------
try {
  const meta = await (await fetch('./snapshot-meta.json', { cache: 'no-cache' })).json();
  const age = ageOf(meta.builtAt);
  const cls = age.verystale ? 'very-stale' : age.stale ? 'stale' : '';
  $('#freshness').innerHTML =
    `<span class="${cls}">Snapshot built ${esc(age.label)}</span><br>` +
    `${meta.counts.owned} owned · ${meta.counts.subscriptions} in subscriptions · ${meta.counts.priced} priced`;
  if (!meta.encrypted) {
    $('#unlockErr').textContent = 'This snapshot is NOT encrypted — anyone can read it.';
  }
} catch {
  $('#freshness').textContent = 'No snapshot found yet. Run the sync workflow.';
}

$('#unlockForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#unlockForm button');
  const err = $('#unlockErr');
  err.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Unlocking…';

  try {
    const envelope = await (await fetch('./snapshot.json', { cache: 'no-cache' })).json();
    SNAP = envelope.format === 'gamevault-plain-snapshot'
      ? envelope.snapshot
      : await decryptJson(envelope, $('#pass').value);

    $('#pass').value = '';
    $('#lock').classList.add('hidden');
    $('#app').classList.remove('hidden');

    const age = ageOf(SNAP.builtAt);
    $('#tag').innerHTML =
      `${SNAP.counts.owned} games owned · updated <span class="${age.stale ? 'stale' : ''}">${esc(age.label)}</span>`;
    if (age.stale) {
      showNotice(`Prices are from ${age.label}. Ownership and subscription info stays accurate; ` +
                 `a sale that started since then will not show.`);
    }
    $('#q').focus();
  } catch (e2) {
    err.textContent = e2.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Unlock';
  }
});

$('#lockBtn').addEventListener('click', () => {
  SNAP = null;                      // drop the plaintext from memory
  $('#results').innerHTML = '';
  $('#app').classList.add('hidden');
  $('#lock').classList.remove('hidden');
});

function showNotice(msg) {
  const n = $('#notice');
  n.textContent = msg;
  n.className = 'notice';
}

// ---------- search ----------
// Mirrors lib/match.mjs normalisation. Kept deliberately simple: the heavy
// matching already happened when the snapshot was built.
function normalize(title) {
  return String(title ?? '')
    .replace(/[\u2122\u00ae\u00a9\u2120]/g, ' ')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+(windows|pc|for pc)$/g, ' ')
    .replace(/^(the|a|an)\s+(?=.)/, '')
    .trim();
}

$('#searchForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const term = $('#q').value.trim();
  if (!term || !SNAP) return;

  const q = normalize(term);
  const seen = new Set();
  const hits = [];

  const consider = (norm, title) => {
    if (!norm || seen.has(norm)) return;
    if (!norm.includes(q) && !q.includes(norm)) return;
    seen.add(norm);
    hits.push({ norm, title });
  };

  for (const [norm, entries] of Object.entries(SNAP.index)) {
    consider(norm, entries[0]?.title ?? norm);
  }
  for (const s of Object.values(SNAP.subs)) {
    for (const norm of s.norms) consider(norm, norm);
  }
  for (const [norm, p] of Object.entries(SNAP.prices)) consider(norm, p.title);

  hits.sort((a, b) => {
    const ax = a.norm === q ? 0 : a.norm.startsWith(q) ? 1 : 2;
    const bx = b.norm === q ? 0 : b.norm.startsWith(q) ? 1 : 2;
    return ax - bx || a.title.localeCompare(b.title);
  });

  render(hits.slice(0, 40), term);
});

function render(hits, term) {
  const results = $('#results');
  if (!hits.length) {
    results.innerHTML =
      `<div class="spin">Nothing matching “${esc(term)}” in your library or subscriptions.<br>` +
      `<span style="color:var(--dim);font-size:13px">This snapshot only covers what you own, ` +
      `the subscription rosters, and your watchlist.</span></div>`;
    return;
  }

  results.innerHTML = hits.map((h) => {
    const owned = SNAP.index[h.norm] ?? [];
    const price = SNAP.prices[h.norm] ?? null;
    const verdict = SNAP.verdicts[h.norm] ?? null;

    const access = [];
    for (const [key, s] of Object.entries(SNAP.subs)) {
      if (s.norms.includes(h.norm)) {
        access.push({ label: s.label, entitled: SNAP.entitled.includes(key) });
      }
    }

    // Derive a verdict locally when the builder had no price for this title
    // (it is in your library or a roster but was not priced).
    let v = verdict;
    if (!v) {
      if (owned.length) v = { verdict: 'owned', label: 'You already own this', reason: 'Already in your library — do not buy again.' };
      else if (access.some((a) => a.entitled)) {
        v = { verdict: 'included', label: 'Included in your subscription',
              reason: `Playable at no extra cost via ${access.filter((a) => a.entitled).map((a) => a.label).join(', ')}.` };
      } else if (access.length) {
        v = { verdict: 'unknown', label: 'No price data',
              reason: `On ${access.map((a) => a.label).join(', ')}, which your plan does not include. No price in this snapshot.` };
      } else {
        v = { verdict: 'unknown', label: 'No price data', reason: 'Not priced in this snapshot — add it to watchlist.txt.' };
      }
    }

    const ownBadges = owned.map((o) => `<span class="badge own">Owned · ${esc(o.store)}</span>`).join('');
    const subBadges = access.map((a) => a.entitled
      ? `<span class="badge sub">${esc(a.label)}</span>`
      : `<span class="badge">${esc(a.label)} · not your plan</span>`).join('');

    const rows = (price?.deals ?? []).map((d, i) => `
      <div class="price-row ${i === 0 ? 'cheapest' : ''}">
        <span class="shop">${d.url ? `<a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.shop)}</a>` : esc(d.shop)}</span>
        <span class="cut">${d.cut ? `-${d.cut}%` : ''}</span>
        <span class="amt">${money(d.amount)}</span>
      </div>`).join('');

    const low = price?.low
      ? `<div class="lowline">All-time low: <strong>${money(price.low.amount, price.low.currency)}</strong>${price.low.shop ? ` at ${esc(price.low.shop)}` : ''}</div>`
      : '';

    return `
      <article class="card v-${esc(v.verdict)}">
        <div class="card-head">
          <h2 class="title">${esc(price?.title ?? h.title)}</h2>
          <span class="verdict">${esc(v.label)}</span>
        </div>
        <p class="reason">${esc(v.reason)}</p>
        ${ownBadges || subBadges ? `<div class="badges">${ownBadges}${subBadges}</div>` : ''}
        ${rows ? `<div class="prices">${rows}</div>` : ''}
        ${low}
      </article>`;
  }).join('');

  const age = ageOf(SNAP.builtAt);
  $('#sources').textContent =
    `Offline snapshot · built ${age.label} · ${SNAP.counts.owned} owned, ${SNAP.counts.priced} priced`;
}
