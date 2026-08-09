const $ = (s) => document.querySelector(s);
const results = $('#results');
const notice = $('#notice');
const statusPanel = $('#status');
const manualPanel = $('#manual');

const money = (a, c) =>
  a === null || a === undefined ? '—' : `${c === 'USD' || !c ? '$' : ''}${Number(a).toFixed(2)}${c && c !== 'USD' ? ' ' + c : ''}`;

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

function showNotice(msg, isErr = false) {
  notice.textContent = msg;
  notice.className = `notice${isErr ? ' err' : ''}`;
}
function hideNotice() { notice.className = 'notice hidden'; }

function card(r) {
  const own = r.owned.map((o) => `<span class="badge own">Owned · ${esc(o.store)}</span>`).join('');
  const sub = r.access.map((a) =>
    a.entitled === false
      ? `<span class="badge">${esc(a.label)} · not your plan</span>`
      : `<span class="badge sub">${esc(a.label)}</span>`).join('');

  const rows = (r.deals ?? []).map((d, i) => `
    <div class="price-row ${i === 0 ? 'cheapest' : ''}">
      <span class="shop">${d.url ? `<a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.shop)}</a>` : esc(d.shop)}</span>
      <span class="cut">${d.discountPct ? `-${d.discountPct}%` : ''}</span>
      <span class="amt">${money(d.price?.amount, d.price?.currency)}</span>
    </div>`).join('');

  const lowLine = r.low
    ? `<div class="lowline">All-time low: <strong>${money(r.low.amount, r.low.currency)}</strong>${r.low.shop ? ` at ${esc(r.low.shop)}` : ''}${r.low.when ? ` · ${new Date(r.low.when).toLocaleDateString()}` : ''}</div>`
    : `<div class="lowline">No price history (add an ITAD key for all-time lows).</div>`;

  return `
  <article class="card v-${esc(r.verdict.verdict)}">
    <div class="card-head">
      <h2 class="title">${esc(r.title)}</h2>
      <span class="verdict">${esc(r.verdict.label)}</span>
    </div>
    <p class="reason">${esc(r.verdict.reason)}</p>
    ${own || sub ? `<div class="badges">${own}${sub}</div>` : ''}
    ${rows ? `<div class="prices">${rows}</div>` : ''}
    ${lowLine}
  </article>`;
}

async function search(term) {
  results.innerHTML = `<div class="spin">Searching stores, subscriptions and price history…</div>`;
  hideNotice();
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(term)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? 'search failed');

    if (!data.results.length) {
      results.innerHTML = `<div class="spin">No matches for “${esc(term)}”.</div>`;
    } else {
      results.innerHTML = data.results.map(card).join('');
    }

    const bad = Object.entries(data.sources).filter(([k, v]) => v !== 'ok' && k !== 'epic' && k !== 'amazon');
    $('#sources').textContent =
      'Sources: ' + Object.entries(data.sources).map(([k, v]) => `${k}=${v}`).join('  ·  ');

    const warnings = [];
    if (data.subscriptions?.assumed && data.results.some((r) => r.access?.length)) {
      warnings.push(data.subscriptions.note);
    }
    if (bad.length) {
      warnings.push('Some sources were unavailable: ' + bad.map(([k, v]) => `${k} (${v})`).join('; '));
    }
    if (warnings.length) showNotice(warnings.join('  —  '));
  } catch (e) {
    results.innerHTML = '';
    showNotice(e.message, true);
  }
}

// Show the sign-out button only when this instance actually requires auth
// (locally it does not, and an inert button would be confusing).
fetch('/api/health')
  .then((r) => r.json())
  .then((d) => { if (d.authRequired) $('#logoutBtn').classList.remove('hidden'); })
  .catch(() => {});

$('#logoutBtn').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  location.href = '/login';
});

// Any 401 mid-session means the cookie expired -- bounce to the login page
// rather than showing a confusing empty result set.
const _fetch = window.fetch;
window.fetch = async (...args) => {
  const res = await _fetch(...args);
  if (res.status === 401 && !String(args[0]).includes('/api/login')) {
    location.href = '/login';
  }
  return res;
};

$('#searchForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const t = $('#q').value.trim();
  if (t) search(t);
});

$('#syncBtn').addEventListener('click', async () => {
  const btn = $('#syncBtn');
  btn.disabled = true;
  btn.textContent = 'Syncing…';
  try {
    const res = await fetch('/api/sync', { method: 'POST' });
    const d = await res.json();
    const parts = Object.entries(d.stores ?? {}).map(
      ([k, v]) => `${k}: ${v.ok ? `${v.count} games` : `FAILED — ${v.error}`}`,
    );
    showNotice(
      parts.length ? `${d.totalTitles} unique titles. ` + parts.join(' · ')
                   : 'No ownership providers configured yet — see Status.',
      parts.some((p) => p.includes('FAILED')),
    );
  } catch (e) {
    showNotice(e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sync library';
  }
});

$('#manualBtn').addEventListener('click', async () => {
  if (!manualPanel.classList.contains('hidden')) {
    manualPanel.classList.add('hidden');
    return;
  }
  const d = await (await fetch('/api/manual')).json();

  manualPanel.innerHTML = `
    <h3>Manual library</h3>
    <p style="color:var(--dim);font-size:13px;margin:0 0 14px">
      For stores with no ownership API. Paste one title per line — they then
      behave exactly like synced ownership everywhere else in the app.
      <br><strong>Prime Gaming note:</strong> most Prime offers are delivered as
      GOG/Epic keys. Anything you redeemed that way is already covered — only
      list Amazon Games launcher titles here.
    </p>
    ${Object.entries(d.stores).map(([key, meta]) => {
      const cur = (d.entries?.[key]?.titles ?? []).join('\n');
      const n = d.summary?.[key]?.count ?? 0;
      return `
        <div style="margin-bottom:14px">
          <label style="display:block;font-size:13px;margin-bottom:5px">
            <strong>${esc(meta.label)}</strong>
            <span style="color:var(--dim)"> — ${esc(meta.reason)} · ${n} saved</span>
          </label>
          <textarea data-store="${esc(key)}" rows="4" spellcheck="false"
            placeholder="One title per line…"
            style="width:100%;padding:9px 11px;border-radius:8px;border:1px solid var(--line);
                   background:var(--panel2);color:var(--text);font:13px/1.5 monospace;resize:vertical"
          >${esc(cur)}</textarea>
        </div>`;
    }).join('')}
    <button id="manualSave">Save manual library</button>
  `;
  manualPanel.classList.remove('hidden');

  $('#manualSave').addEventListener('click', async () => {
    const btn = $('#manualSave');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    const results = [];
    try {
      for (const ta of manualPanel.querySelectorAll('textarea[data-store]')) {
        const res = await fetch('/api/manual', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ store: ta.dataset.store, titles: ta.value }),
        });
        const r = await res.json();
        if (res.ok && r.count) results.push(`${ta.dataset.store}: ${r.count}`);
      }
      showNotice(results.length ? `Saved — ${results.join(' · ')}` : 'Manual library cleared.');
      manualPanel.classList.add('hidden');
    } catch (e) {
      showNotice(e.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save manual library';
    }
  });
});

$('#statusBtn').addEventListener('click', async () => {
  if (!statusPanel.classList.contains('hidden')) {
    statusPanel.classList.add('hidden');
    return;
  }
  const d = await (await fetch('/api/status')).json();
  const row = (k, ready, note) =>
    `<div class="row"><span>${esc(k)}</span><span class="${ready ? 'ok' : 'no'}">${esc(note)}</span></div>`;

  statusPanel.innerHTML = `
    <h3>Ownership providers</h3>
    ${Object.entries(d.providers).map(([k, v]) => row(k, v.configured, v.note)).join('')}
    <h3 style="margin-top:14px">Pricing</h3>
    ${Object.entries(d.pricing).map(([k, v]) => row(k, v === 'ready' || v.startsWith('ready'), v)).join('')}
    <h3 style="margin-top:14px">Library</h3>
    ${row('last sync', Boolean(d.library.syncedAt), d.library.syncedAt ?? 'never synced')}
    ${row('unique titles', d.library.totalTitles > 0, String(d.library.totalTitles))}
    ${Object.entries(d.library.stores ?? {}).map(([k, v]) => row(k, v.ok, v.ok ? `${v.count} games` : v.error)).join('')}
  `;
  statusPanel.classList.remove('hidden');
});
