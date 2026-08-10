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

const REPO = 'MichaelEns/gamevault';
const SECRETS_URL = `https://github.com/${REPO}/settings/secrets/actions`;
const VARS_URL = `https://github.com/${REPO}/settings/variables/actions`;

const SOURCES = [
  {
    key: 'steam', label: 'Steam', unlocks: 'Everything you own on Steam',
    needs: ['STEAM_API_KEY', 'STEAM_ID'],
    get: 'https://steamcommunity.com/dev/apikey',
    hint: 'Free key. STEAM_ID accepts your profile URL \u2014 either ' +
          'steamcommunity.com/id/yourname or .../profiles/7656... \u2014 so you do ' +
          'not need to look up a SteamID64. Your profile\u2019s "Game details" must ' +
          'be set to Public, or Steam returns an empty list rather than an error.',
  },
  {
    key: 'itad', label: 'Prices & historical lows', unlocks: 'Is this actually a good price?',
    needs: ['ITAD_API_KEY'],
    get: 'https://isthereanydeal.com/apps/my/',
    hint: 'Highest value single key: without it there are no prices at all, ' +
          'so every verdict is ownership-only.',
    variable: false,
  },
  {
    key: 'itch', label: 'itch.io', unlocks: 'Your itch.io purchases and bundles',
    needs: ['ITCH_API_KEY'],
    get: 'https://itch.io/user/settings/api-keys',
  },
  {
    key: 'epic', label: 'Epic Games', unlocks: 'Your Epic library',
    needs: ['LEGENDARY_CONFIG'],
    get: null,
    hint: 'Run "npm run epic-auth" on a PC, then paste the resulting ' +
          'config into the LEGENDARY_CONFIG secret. Epic has no public ' +
          'library API, so this borrows a real client\u2019s login.',
  },
  {
    key: 'amazon', label: 'Prime Gaming', unlocks: 'Games claimed with Prime',
    needs: ['NILE_CONFIG'],
    get: null,
    hint: 'Run "npm run amazon-auth" on a PC and paste the config. ' +
          'Amazon Luna is not possible \u2014 its client only talks to ' +
          'internal amazon hosts that do not resolve publicly.',
  },
  {
    key: 'nintendo', label: 'Nintendo', unlocks: 'eShop prices (ownership is manual)',
    needs: [],
    get: null,
    hint: 'Nintendo exposes no purchase-history API. Prices work; ' +
          'ownership has to be typed into the manual library.',
  },
];

/**
 * "Remember on this device".
 *
 * Opt-in, and off by default. Storing the passphrase means anyone who can
 * unlock your phone can read your library -- which is a reasonable trade
 * when the phone itself is behind Face ID, but it should be your choice,
 * not a default. Scoped to this origin, and cleared by Lock or Forget.
 */
const REMEMBER_KEY = 'gv.passphrase';
const remembered = () => {
  try { return localStorage.getItem(REMEMBER_KEY); } catch { return null; }
};
const forget = () => {
  try { localStorage.removeItem(REMEMBER_KEY); } catch { /* private mode */ }
};

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

async function unlockWith(passphrase) {
  const envelope = await (await fetch('./snapshot.json', { cache: 'no-cache' })).json();
  SNAP = envelope.format === 'gamevault-plain-snapshot'
    ? envelope.snapshot
    : await decryptJson(envelope, passphrase);

  $('#pass').value = '';
  $('#lock').classList.add('hidden');
  $('#app').classList.remove('hidden');
  // Tells the update handler not to reload underneath a live session; the
  // decrypted snapshot exists only in memory.
  globalThis.__gvUnlocked = true;

  const age = ageOf(SNAP.builtAt);
  $('#tag').innerHTML =
    `${SNAP.counts.owned} games owned · updated <span class="${age.stale ? 'stale' : ''}">${esc(age.label)}</span>`;
  if (age.stale) {
    showNotice(`Prices are from ${age.label}. Ownership and subscription info stays accurate; ` +
               `a sale that started since then will not show.`);
  }
  // An empty library is almost always a missing key, not a real answer.
  // Say so at the moment it matters instead of silently returning nothing.
  if ((SNAP.counts.owned ?? 0) === 0) {
    showNotice('No ownership data yet — subscription lookups still work. ' +
               'Open Sources to connect Steam and the rest.');
    renderSetup();
  }
  $('#q').focus();
}

$('#unlockForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#unlockForm button');
  const err = $('#unlockErr');
  const pass = $('#pass').value;
  err.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Unlocking…';

  try {
    await unlockWith(pass);
    // Only persist AFTER a successful decrypt, so a typo is never stored.
    if ($('#remember').checked) {
      try { localStorage.setItem(REMEMBER_KEY, pass); } catch { /* private mode */ }
    } else {
      forget();
    }
  } catch (e2) {
    err.textContent = e2.message;
    forget();   // a stored passphrase that no longer works must not linger
  } finally {
    btn.disabled = false;
    btn.textContent = 'Unlock';
  }
});

// Auto-unlock when the user opted in. A stored passphrase that fails (because
// the secret was rotated) silently falls back to the normal prompt.
(async () => {
  const saved = remembered();
  if (!saved) return;
  $('#remember').checked = true;
  try {
    await unlockWith(saved);
  } catch {
    forget();
    $('#unlockErr').textContent = 'Saved passphrase no longer works — it may have been rotated.';
  }
})();

$('#lockBtn').addEventListener('click', () => {
  SNAP = null;                      // drop the plaintext from memory
  forget();                         // Lock means lock: don't auto-reopen
  globalThis.__gvUnlocked = false;  // a pending update may now apply freely
  $('#remember').checked = false;
  $('#results').innerHTML = '';
  $('#q').value = '';
  $('#setup').classList.add('hidden');
  $('#app').classList.add('hidden');
  $('#lock').classList.remove('hidden');
});

/* ---------- Sources panel ----------
 *
 * Answers "why does this say 0 games owned?" without making you read the
 * repo. Each entry links straight to the page that issues the credential
 * and to the GitHub secret form that consumes it.
 *
 * Note what this panel deliberately does NOT do: log you in. Steam, GOG and
 * ITAD send no Access-Control-Allow-Origin header, so a browser cannot read
 * their responses from this origin no matter how it authenticates. That is
 * the same constraint that made this a nightly-snapshot app instead of a
 * live one. The credential has to be handed to the GitHub Action, which is
 * not a browser and is not subject to CORS.
 */


function renderSetup() {
  const box = $('#setup');
  const prov = SNAP?.providers ?? {};
  const stores = SNAP?.stores ?? {};

  const rows = SOURCES.map((s) => {
    const p = prov[s.key] ?? {};
    const st = stores[s.key];
    // "Configured" comes from the builder; the store record proves it worked.
    const live = st && st.ok !== false && (st.count ?? 0) > 0;
    const state = live ? 'ok' : (p.configured ? 'warn' : 'off');
    const badge = live ? `${st.count} titles`
                : p.configured ? 'configured, nothing synced'
                : 'not connected';
    const note = st?.error ? `Last sync failed: ${st.error}`
               : (p.note && p.note !== 'ready' ? p.note : s.hint ?? '');

    const links = [];
    if (s.get) links.push(`<a href="${s.get}" target="_blank" rel="noopener">Get key</a>`);
    if (s.needs.length) links.push(`<a href="${SECRETS_URL}" target="_blank" rel="noopener">Add secret</a>`);
    if (s.needs.length) {
      links.push(`<a href="#" data-copy="${esc(SECRETS_URL)}" class="copyable">Copy link</a>`);
    }

    return `<div class="src ${state}">
      <div class="src-head">
        <strong>${esc(s.label)}</strong>
        <span class="src-badge">${esc(badge)}</span>
      </div>
      <div class="src-body">
        <div class="src-unlocks">${esc(s.unlocks)}</div>
        ${s.needs.length
          ? s.needs.map((n) => `<code class="copyable" data-copy="${esc(n)}" title="Copy name">${esc(n)}</code>`).join(' ')
          : ''}
        ${note ? `<p class="src-note">${esc(note)}</p>` : ''}
        ${links.length ? `<p class="src-links">${links.join(' · ')}</p>` : ''}
      </div>
    </div>`;
  }).join('');

  box.innerHTML = `
    <h2 class="setup-title">Where your data comes from</h2>
    <p class="setup-intro">
      Keys go to the GitHub Action that builds your snapshot, not to this page.
      Steam, GOG and IsThereAnyDeal all refuse cross-origin browser requests,
      so signing in here could not fetch your library even if it were offered
      &mdash; that restriction is on the browser origin, not on the login.
    </p>
    <p class="setup-warn">
      <strong>If &ldquo;Add secret&rdquo; shows a 404:</strong> that is GitHub
      hiding the page, not a broken link. Repository settings return 404 rather
      than 403 when you are signed out, or signed in as an account without
      access to <code>${esc(REPO)}</code>. Sign in as
      <code>${esc(REPO.split('/')[0])}</code> and open the link again, or use
      <span class="copyable" data-copy="gh secret set STEAM_API_KEY --repo ${esc(REPO)}"><code>gh secret set</code></span>
      on a PC, which never puts the key on screen.
    </p>
    ${rows}
    <p class="setup-foot">
      Subscriptions: <a href="${VARS_URL}" target="_blank" rel="noopener">SUBSCRIPTIONS variable</a>
      (currently <code>${esc((SNAP?.entitled ?? []).join(', ') || 'none')}</code>).
      After changing anything, run the
      <a href="https://github.com/${REPO}/actions" target="_blank" rel="noopener">snapshot workflow</a>
      to rebuild.
    </p>`;
  box.classList.remove('hidden');
}

// Tap-to-copy for secret names, links and the CLI command. On a phone the
// realistic path is "copy this, paste it into a browser where you are actually
// signed in", so copying has to work without a keyboard.
$('#setup').addEventListener('click', async (e) => {
  const el = e.target.closest('[data-copy]');
  if (!el) return;
  e.preventDefault();
  const text = el.getAttribute('data-copy');
  try {
    await navigator.clipboard.writeText(text);
    const prev = el.textContent;
    el.textContent = 'Copied';
    setTimeout(() => { el.textContent = prev; }, 1200);
  } catch {
    // Clipboard access can be refused; showing the value still lets them act.
    showNotice(`Copy this: ${text}`);
  }
});

/* ---------- setting keys from inside the app ----------
 *
 * There is deliberately no "Sign in with GitHub" here, and it is not an
 * oversight. github.com/login/device/code and /login/oauth/access_token send
 * no Access-Control-Allow-Origin header at all, so neither the device flow nor
 * the OAuth code flow can run in a page; the code flow would also need a
 * client secret, which cannot exist in a public static site.
 *
 * api.github.com, however, sends Access-Control-Allow-Origin: *, including on
 * the Actions secrets endpoints. So the app cannot log in, but it can act with
 * a token you paste in once.
 *
 * The token is stored only in this origin's localStorage and sent only to
 * api.github.com. It is never written into the snapshot, never logged, and
 * never included in an error message.
 */
const TOKEN_KEY = 'gv.ghtoken';
const readToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
const writeToken = (t) => { try { localStorage.setItem(TOKEN_KEY, t); } catch { /* private mode */ } };
const clearToken = () => { try { localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ } };

let GH = null;   // lazily imported { nacl, blake2b } + api helpers

async function ghModule() {
  if (!GH) {
    // ~40KB of vendored crypto; only fetched if you actually connect.
    const [sealbox, api] = await Promise.all([
      import('./sealbox.js'),
      import('./github-secrets.mjs'),
    ]);
    GH = { deps: { nacl: sealbox.nacl, blake2b: sealbox.blake2b }, api };
  }
  return GH;
}

function renderConnect(state = {}) {
  const box = $('#connect');
  const token = readToken();
  const owner = REPO.split('/')[0];

  box.innerHTML = token ? `
    <h2 class="setup-title">Add a key</h2>
    <p class="setup-intro">
      Connected to <code>${esc(REPO)}</code>. Values are sealed in this browser
      with the repository&rsquo;s public key before they are sent, so GitHub
      receives ciphertext and nothing readable is ever transmitted.
    </p>
    <form id="secretForm" class="secret-form">
      <label for="secretName">Secret</label>
      <select id="secretName">
        <option value="ITAD_API_KEY">ITAD_API_KEY &mdash; prices and historical lows</option>
        <option value="STEAM_API_KEY">STEAM_API_KEY &mdash; Steam ownership</option>
        <option value="STEAM_ID">STEAM_ID &mdash; your profile URL is fine</option>
        <option value="ITCH_API_KEY">ITCH_API_KEY &mdash; itch.io purchases</option>
        <option value="LEGENDARY_CONFIG">LEGENDARY_CONFIG &mdash; Epic (base64)</option>
        <option value="NILE_CONFIG">NILE_CONFIG &mdash; Prime Gaming (base64)</option>
      </select>
      <label for="secretValue">Value</label>
      <input id="secretValue" type="password" autocomplete="off" autocapitalize="off"
             autocorrect="off" spellcheck="false" placeholder="Paste the key">
      <label class="inline"><input id="thenRun" type="checkbox" checked> Rebuild the snapshot afterwards</label>
      <button type="submit">Save to GitHub</button>
    </form>
    <p id="connectMsg" class="src-note">${esc(state.msg ?? '')}</p>
    <p class="setup-foot">
      Already set: <span id="secretList">${esc(state.names ?? 'checking\u2026')}</span><br>
      <a href="#" id="disconnectBtn">Disconnect</a> &mdash; removes the token from this device.
    </p>`
  : `
    <h2 class="setup-title">Add keys from this app</h2>
    <p class="setup-intro">
      GitHub&rsquo;s OAuth and device-flow endpoints send no CORS headers, so
      this app cannot offer a &ldquo;Sign in with GitHub&rdquo; button &mdash;
      no page on any origin can. The REST API does allow browser requests, so a
      token works instead.
    </p>
    <ol class="steps">
      <li>Open <a href="https://github.com/settings/personal-access-tokens/new"
                  target="_blank" rel="noopener">fine-grained token</a>
          (sign in as <code>${esc(owner)}</code>).</li>
      <li>Repository access &rarr; <strong>Only select repositories</strong> &rarr;
          <code>${esc(REPO)}</code>.</li>
      <li>Repository permissions &rarr; <strong>Secrets: Read and write</strong>.
          Add <strong>Actions: Read and write</strong> too if you want the app to
          trigger rebuilds.</li>
      <li>Paste it below.</li>
    </ol>
    <form id="tokenForm" class="secret-form">
      <input id="ghToken" type="password" autocomplete="off" autocapitalize="off"
             autocorrect="off" spellcheck="false" placeholder="github_pat_...">
      <button type="submit">Connect</button>
    </form>
    <p id="connectMsg" class="src-note">${esc(state.msg ?? '')}</p>
    <p class="setup-foot">
      The token stays in this browser and is sent only to api.github.com. Scope
      it to this one repository so it can do nothing else.
    </p>`;
  box.classList.remove('hidden');

  if (token) wireSecretForm(); else wireTokenForm();
}

function wireTokenForm() {
  $('#tokenForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#ghToken');
    const token = input.value.trim();
    const msg = $('#connectMsg');
    if (!token) return;
    msg.textContent = 'Checking\u2026';
    try {
      const { api } = await ghModule();
      // Prove the token can do the job before storing it, rather than
      // discovering it is under-scoped at the moment you try to save a key.
      await api.getPublicKey(token, REPO);
      writeToken(token);
      input.value = '';
      renderConnect({ msg: 'Connected.' });
      refreshSecretList();
    } catch (err) {
      msg.textContent = err.message;
    }
  });
}

function wireSecretForm() {
  $('#disconnectBtn').addEventListener('click', (e) => {
    e.preventDefault();
    clearToken();
    renderConnect({ msg: 'Token removed from this device.' });
  });

  $('#secretForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#secretName').value;
    const valueEl = $('#secretValue');
    const value = valueEl.value.trim();
    const msg = $('#connectMsg');
    const btn = $('#secretForm button');
    if (!value) { msg.textContent = 'Enter a value first.'; return; }

    btn.disabled = true;
    msg.textContent = 'Encrypting and sending\u2026';
    try {
      const { api, deps } = await ghModule();
      const token = readToken();
      const what = await api.putSecret(token, REPO, name, value, deps);
      valueEl.value = '';           // never leave a key sitting in the field
      msg.textContent = `${name} ${what}.`;

      if ($('#thenRun').checked) {
        try {
          await api.runWorkflow(token, REPO);
          msg.textContent = `${name} ${what}. Rebuild started \u2014 refresh in a minute or two.`;
        } catch (err) {
          msg.textContent = `${name} ${what}, but the rebuild could not start: ${err.message}`;
        }
      }
      refreshSecretList();
    } catch (err) {
      msg.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
}

async function refreshSecretList() {
  const el = $('#secretList');
  if (!el) return;
  try {
    const { api } = await ghModule();
    const names = await api.listSecretNames(readToken(), REPO);
    // SNAPSHOT_PASSPHRASE is set up separately and is not a data source.
    const shown = names.filter((n) => n !== 'SNAPSHOT_PASSPHRASE');
    el.textContent = shown.length ? shown.join(', ') : 'none yet';
  } catch (err) {
    el.textContent = err.message;
  }
}

$('#connectBtn').addEventListener('click', () => {
  const box = $('#connect');
  if (!box.classList.contains('hidden')) { box.classList.add('hidden'); return; }
  renderConnect();
  if (readToken()) refreshSecretList();
});

$('#setupBtn').addEventListener('click', () => {
  const box = $('#setup');
  if (!box.classList.contains('hidden')) { box.classList.add('hidden'); return; }
  renderSetup();
});

// A gesture alone is undiscoverable, and there is no gesture on a desktop.
$('#refreshBtn').addEventListener('click', async () => {
  const b = $('#refreshBtn');
  b.disabled = true;
  b.textContent = 'Refreshing\u2026';
  await hardRefresh();
});
/* ---------- pull to refresh ----------
 *
 * iOS standalone PWAs have no browser chrome, so there is no native
 * pull-to-refresh and no address bar to reload from. When a service worker
 * served a stale asset there was literally no way for the user to recover
 * from inside the app. This provides that escape hatch.
 *
 * It purges the caches before reloading rather than just calling reload(),
 * because a plain reload can still be answered from the cache -- which is the
 * exact situation this exists to break out of. localStorage is untouched, so
 * a remembered passphrase survives.
 */
async function hardRefresh() {
  try {
    if (navigator.serviceWorker?.controller) {
      navigator.serviceWorker.controller.postMessage('gv-purge');
    }
    const regs = await navigator.serviceWorker?.getRegistrations?.() ?? [];
    await Promise.all(regs.map((r) => r.update().catch(() => {})));
    if (globalThis.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch { /* refreshing must work even if cache APIs are unavailable */ }
  // Cache-busted so the reload itself cannot be answered from an HTTP cache.
  location.replace(location.pathname + '?r=' + Date.now());
}

(function pullToRefresh() {
  const el = $('#ptr');
  if (!el) return;
  const THRESHOLD = 70;      // px of pull before it commits
  const MAX = 110;           // rubber-band ceiling
  let startY = 0;
  let pulling = false;
  let dist = 0;

  const setText = (t) => { const n = $('#ptrText'); if (n) n.textContent = t; };
  const reset = () => {
    el.style.transition = 'height .2s ease';
    el.style.height = '0px';
    pulling = false;
    dist = 0;
    setTimeout(() => { el.style.transition = ''; }, 220);
  };

  document.addEventListener('touchstart', (e) => {
    // Only from a genuine top-of-page position, so this never fights scrolling.
    if (window.scrollY > 0 || e.touches.length !== 1) return;
    startY = e.touches[0].clientY;
    pulling = true;
    dist = 0;
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!pulling) return;
    const delta = e.touches[0].clientY - startY;
    if (delta <= 0 || window.scrollY > 0) { reset(); return; }
    // Resistance, so it feels like a pull rather than a drag.
    dist = Math.min(MAX, delta * 0.5);
    el.style.height = `${dist}px`;
    setText(dist >= THRESHOLD ? 'Release to refresh' : 'Pull to refresh');
  }, { passive: true });

  document.addEventListener('touchend', () => {
    if (!pulling) return;
    if (dist >= THRESHOLD) {
      setText('Refreshing\u2026');
      el.style.height = `${THRESHOLD}px`;
      hardRefresh();
      return;
    }
    reset();
  }, { passive: true });
})();

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
