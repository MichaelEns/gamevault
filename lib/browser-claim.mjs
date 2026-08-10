/**
 * Browser-driven claiming, for storefronts whose APIs refuse automation.
 *
 * Epic and GOG expose auth-gated endpoints, so those are claimed directly over
 * HTTP - see lib/epic-claim.mjs and lib/gog-claim.mjs. Amazon does not:
 * gaming.amazon.com/graphql answers 403 to anything that does not look like a
 * browser, and no token gets past it. The only way in is to actually be a
 * browser.
 *
 * That is a real trade and worth naming. This is the most fragile code here:
 * it depends on Amazon's page markup, so it breaks whenever they redesign, and
 * it breaks by silently finding nothing rather than by erroring. It runs in
 * its own workflow for exactly that reason - a Playwright failure must not be
 * able to disturb the library sync, which is the part that has to keep
 * working.
 *
 * What makes the fragility acceptable is that a silent break is caught: every
 * claim is checked against the library on the next sync, and anything that did
 * not arrive is reported. Without that this would not be worth building.
 */

const STORES = {
  /**
   * Prime Gaming.
   *
   * The valuable one: several games at once, refreshed weekly, and the offers
   * disappear when the month rolls over. Also the only store here that cannot
   * be done over HTTP.
   */
  prime: {
    label: 'Prime Gaming',
    url: 'https://gaming.amazon.com/home',
    loginCheck: async (page) => {
      // Amazon shows a sign-in link when logged out. Checking for the absence
      // of that is more stable than looking for an account menu, which moves.
      const signIn = await page.locator('[data-a-target="sign-in-button"], a[href*="signin"]').count();
      return signIn === 0;
    },
    claim: async (page, log) => {
      const claimed = [];
      await page.goto('https://gaming.amazon.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
      // Amazon lazy-loads offers, so the page has to be scrolled before the
      // full set exists in the DOM.
      for (let i = 0; i < 6; i++) {
        await page.mouse.wheel(0, 2000);
        await page.waitForTimeout(700);
      }

      // Offer cards carry a "Claim" or "Get game" control. Several selectors
      // because Amazon uses different ones per offer type, and a single one
      // silently matching nothing is the failure mode to avoid.
      const buttons = page.locator(
        'button:has-text("Claim game"), button:has-text("Get game"), ' +
        'button:has-text("Claim"), [data-a-target="FGWPOffer"] button',
      );
      const count = await buttons.count();
      log(`found ${count} claimable offer(s)`);

      for (let i = 0; i < Math.min(count, 20); i++) {
        const btn = buttons.nth(i);
        let title = 'unknown';
        try {
          title = (await btn.locator('xpath=ancestor::*[self::div][3]')
            .locator('[data-a-target="offer-title"], h3, .tw-typo-body-l')
            .first().innerText({ timeout: 3000 })).trim();
        } catch { /* the title is nice to have, not essential */ }

        try {
          await btn.click({ timeout: 10000 });
          await page.waitForTimeout(3500);
          claimed.push(title);
          log(`claimed ${title}`);
        } catch (e) {
          log(`could not claim ${title}: ${e.message.split('\n')[0]}`);
        }
      }
      return claimed;
    },
  },

  /**
   * Epic, as a fallback.
   *
   * Normally claimed over HTTP. This exists so a change to Epic's checkout
   * does not mean missing giveaways until someone notices and rewrites it.
   */
  epic: {
    label: 'Epic Games',
    url: 'https://store.epicgames.com/en-US/free-games',
    loginCheck: async (page) => {
      const signIn = await page.locator('a[href*="/id/login"], button:has-text("Sign In")').count();
      return signIn === 0;
    },
    claim: async (page, log) => {
      const claimed = [];
      await page.goto('https://store.epicgames.com/en-US/free-games', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(4000);

      const cards = page.locator('a:has-text("Free Now")');
      const count = await cards.count();
      log(`found ${count} giveaway(s)`);

      for (let i = 0; i < Math.min(count, 5); i++) {
        try {
          const href = await cards.nth(i).getAttribute('href');
          if (!href) continue;
          await page.goto(`https://store.epicgames.com${href}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
          await page.waitForTimeout(2500);

          const title = await page.locator('h1').first().innerText().catch(() => 'unknown');
          const getBtn = page.locator('button:has-text("Get")').first();
          if (!(await getBtn.count())) { log(`${title}: no Get button (already owned?)`); continue; }

          await getBtn.click({ timeout: 10000 });
          await page.waitForTimeout(3000);
          const placeOrder = page.frameLocator('iframe').locator('button:has-text("Place Order")').first();
          await placeOrder.click({ timeout: 15000 }).catch(() => {});
          await page.waitForTimeout(4000);
          claimed.push(title);
          log(`claimed ${title}`);
        } catch (e) {
          log(`Epic claim ${i} failed: ${e.message.split('\n')[0]}`);
        }
      }
      return claimed;
    },
  },

  /** GOG giveaways, also as a fallback to the HTTP path. */
  gog: {
    label: 'GOG',
    url: 'https://www.gog.com/giveaway',
    loginCheck: async (page) => {
      const signIn = await page.locator('a[href*="/account/login"], .menu-item--sign-in').count();
      return signIn === 0;
    },
    claim: async (page, log) => {
      const claimed = [];
      await page.goto('https://www.gog.com/giveaway', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(3000);

      const btn = page.locator('.giveaway__claim, button:has-text("Claim")').first();
      if (!(await btn.count())) { log('no giveaway running'); return claimed; }

      const title = await page.locator('.giveaway__content-header, h2').first()
        .innerText().catch(() => 'GOG giveaway');
      try {
        await btn.click({ timeout: 10000 });
        await page.waitForTimeout(3000);
        claimed.push(title);
        log(`claimed ${title}`);
      } catch (e) {
        log(`could not claim: ${e.message.split('\n')[0]}`);
      }
      return claimed;
    },
  },
};

export { STORES };

/**
 * Run one store's claim routine against an existing session.
 *
 * @param {import('playwright').BrowserContext} context
 */
export async function claimStore(context, storeKey, log = console.log) {
  const store = STORES[storeKey];
  if (!store) throw new Error(`Unknown store: ${storeKey}`);

  const page = await context.newPage();
  try {
    await page.goto(store.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2500);

    if (!(await store.loginCheck(page))) {
      // Distinguished from "nothing to claim" deliberately: an expired session
      // and an empty week look identical in the results otherwise, and only
      // one of them needs the user to do something.
      throw new Error(`Not signed in to ${store.label} - the stored session has expired`);
    }

    const claimed = await store.claim(page, log);
    return { store: storeKey, label: store.label, claimed, ok: true };
  } catch (e) {
    return { store: storeKey, label: store.label, claimed: [], ok: false, error: e.message };
  } finally {
    await page.close().catch(() => {});
  }
}
