/**
 * Sign in to the browser-claimed storefronts, once, and save the session.
 *
 * Amazon cannot be claimed over HTTP - gaming.amazon.com answers 403 to
 * anything that does not look like a browser - so this opens a real one, waits
 * for you to sign in, and stores the resulting cookies and localStorage.
 *
 * Playwright's storageState is exactly the right shape for this: it is JSON,
 * small enough for a GitHub secret, and restores a logged-in session without
 * carrying a whole browser profile around.
 *
 *   npm run browser-login              # all stores
 *   npm run browser-login -- prime     # just one
 */
import { writeFileSync } from 'node:fs';
import { argv } from 'node:process';
import { createInterface } from 'node:readline';
import { STORES } from '../lib/browser-claim.mjs';

function emit(value) {
  const i = argv.indexOf('--out');
  if (i === -1 || !argv[i + 1]) return;
  writeFileSync(argv[i + 1], typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

const wanted = argv.slice(2).filter((a) => !a.startsWith('--') && STORES[a]);
const stores = wanted.length ? wanted : Object.keys(STORES);

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('Playwright is not installed. Run:\n');
  console.error('  npm install playwright');
  console.error('  npx playwright install chromium');
  process.exit(1);
}

console.log('Browser sign-in for automatic claiming\n');
console.log('A browser window will open for each store. Sign in normally,');
console.log('including any 2FA, then return here and press Enter.\n');
console.log('Only cookies and local storage are kept - no password is stored,');
console.log('and nothing is sent anywhere except to the storefront itself.\n');

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  // A default Playwright user agent advertises automation; storefronts treat
  // that as a bot even when a real person is driving.
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
             '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
});

const ask = (q) => new Promise((resolve) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.question(q, () => { rl.close(); resolve(); });
});

try {
  for (const key of stores) {
    const store = STORES[key];
    console.log(`\n--- ${store.label} ---`);
    const page = await context.newPage();
    await page.goto(store.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await ask(`Sign in to ${store.label} in the browser, then press Enter here... `);

    const signedIn = await store.loginCheck(page).catch(() => false);
    console.log(signedIn
      ? `  ${store.label}: signed in.`
      : `  ${store.label}: still looks signed out - claiming will be skipped for it.`);
    await page.close().catch(() => {});
  }

  const state = await context.storageState();
  const json = JSON.stringify(state);
  console.log(`\nCaptured ${state.cookies.length} cookies and ` +
              `${state.origins.length} origins (${(json.length / 1024).toFixed(1)}KB).`);

  if (json.length > 45000) {
    // GitHub caps a secret at 48KB, and silently failing to store it would be
    // worse than saying so.
    console.log('\nThat is close to GitHub\u2019s 48KB secret limit. Sign in to fewer');
    console.log('stores at once, or drop one you do not need.');
  }

  console.log('\nAdd this as the BROWSER_STATE secret:\n');
  console.log(json);
  emit(json);
  console.log('\nSessions expire eventually. When they do, claiming stops and the');
  console.log('app reports it, because every claim is checked against your library.');
} finally {
  await browser.close().catch(() => {});
}
