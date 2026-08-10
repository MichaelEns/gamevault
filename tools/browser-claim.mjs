/**
 * Claim free games with a real browser.
 *
 * Run by .github/workflows/claim.yml, deliberately in its own workflow: this
 * is the most fragile code in the project - it depends on page markup that
 * changes without warning - and a failure here must not be able to disturb the
 * library sync.
 *
 *   node tools/browser-claim.mjs            # every store
 *   node tools/browser-claim.mjs prime      # one store
 */
import { argv, env } from 'node:process';
import { writeFileSync } from 'node:fs';
import { STORES, claimStore } from '../lib/browser-claim.mjs';

const wanted = argv.slice(2).filter((a) => !a.startsWith('--') && STORES[a]);
const stores = wanted.length ? wanted : Object.keys(STORES);

if (!env.BROWSER_STATE) {
  console.error('BROWSER_STATE is not set. Run "npm run browser-login" on a PC first.');
  process.exit(1);
}

let state;
try {
  state = JSON.parse(env.BROWSER_STATE);
} catch (e) {
  console.error(`BROWSER_STATE is not valid JSON (${e.message}).`);
  process.exit(1);
}

const { chromium } = await import('playwright');
const browser = await chromium.launch({
  headless: true,
  args: ['--disable-blink-features=AutomationControlled'],
});
const context = await browser.newContext({
  storageState: state,
  viewport: { width: 1280, height: 900 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
             '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  locale: 'en-US',
});

// navigator.webdriver is the single most-checked automation tell. Removing it
// is not about evading detection for its own sake - it is a real account
// signing in to claim its own free games - but storefronts refuse the request
// outright otherwise.
await context.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
});

const results = [];
try {
  for (const key of stores) {
    const log = (m) => console.log(`  [${key}] ${m}`);
    console.log(`\n${STORES[key].label}`);
    const r = await claimStore(context, key, log);
    results.push(r);
    if (!r.ok) console.log(`  [${key}] FAILED: ${r.error}`);
  }

  // The session is refreshed by use, so save what it looks like now. Without
  // this the stored state slowly goes stale and claiming stops for reasons
  // that look like nothing in particular.
  const refreshed = JSON.stringify(await context.storageState());
  if (env.GAMEVAULT_SECRETS_TOKEN && env.GITHUB_REPOSITORY && refreshed !== env.BROWSER_STATE) {
    try {
      const [{ putSecret }, nacl, blakejs] = await Promise.all([
        import('../lib/github-secrets.mjs'),
        import('tweetnacl').then((m) => m.default ?? m),
        import('blakejs'),
      ]);
      await putSecret(env.GAMEVAULT_SECRETS_TOKEN, env.GITHUB_REPOSITORY, 'BROWSER_STATE', refreshed,
                      { nacl, blake2b: blakejs.blake2b });
      console.log('\nBROWSER_STATE refreshed.');
    } catch (e) {
      console.log(`\n::warning::Could not refresh BROWSER_STATE: ${e.message}`);
    }
  }
} finally {
  await browser.close().catch(() => {});
}

const claimed = results.flatMap((r) => r.claimed);
const failures = results.filter((r) => !r.ok);

console.log('\n---');
console.log(`Claimed ${claimed.length} game(s).`);
for (const c of claimed) console.log(`  ${c}`);
if (failures.length) {
  console.log(`${failures.length} store(s) failed:`);
  for (const f of failures) console.log(`  ${f.label}: ${f.error}`);
}

// Written for the workflow to act on, rather than parsed back out of the log.
writeFileSync('claim-result.json', JSON.stringify({
  at: new Date().toISOString(),
  claimed,
  failures: failures.map((f) => ({ store: f.store, label: f.label, error: f.error })),
}, null, 2), 'utf8');

// A store failing is reported, not fatal: one broken storefront must not stop
// the others from being claimed on the next run.
process.exit(0);
