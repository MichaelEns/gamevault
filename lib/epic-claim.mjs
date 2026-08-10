/**
 * Claiming Epic's weekly free games without a browser.
 *
 * The obstacle was never authentication, it was bot protection - and it turns
 * out those live on different hosts. Probed directly:
 *
 *   store.epicgames.com/purchase          403  bot-protected
 *   store.epicgames.com/graphql           403  bot-protected
 *   payment-website-pci.../purchase       401  auth-gated only
 *   payment-website-pci.../order-preview  401  auth-gated only
 *   payment-website-pci.../confirm-order  401  auth-gated only
 *
 * So the entire purchase flow is reachable with a session cookie, and none of
 * it requires pretending to be a browser. That is the difference between
 * automation that works and automation that fights a WAF.
 *
 * Even so, a claim is never assumed to have succeeded. HTTP 200 means Epic
 * accepted the request, not that the game arrived; lib/claims.mjs confirms
 * that separately by looking for it in the next library sync. An automation
 * that silently stops working is worse than none, because it replaces a chore
 * you would notice with a confidence you would not.
 */
import { normalizeTitle } from './match.mjs';

const PAY = 'https://payment-website-pci.ol.epicgames.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export function configured(env) {
  return Boolean(env.EPIC_COOKIES);
}

function headers(env, extra = {}) {
  const cookies = String(env.EPIC_COOKIES).trim();
  if (/[\r\n]/.test(cookies)) {
    throw new Error('EPIC_COOKIES contains a line break, so it cannot be sent as a header.');
  }
  return {
    Cookie: cookies,
    'User-Agent': UA,
    Accept: 'application/json, text/html',
    ...extra,
  };
}

/**
 * The purchase token for an offer.
 *
 * Epic embeds it in the purchase page as a hidden input. This is the one part
 * of the flow that parses HTML, so it is also the part most likely to break
 * when Epic changes its markup - hence the explicit, named error rather than
 * a silent empty string.
 */
async function purchaseToken(env, namespace, offerId) {
  const url = `${PAY}/purchase?showNavigation=true&highlightColor=0078f2` +
              `&offers=1-${encodeURIComponent(namespace)}-${encodeURIComponent(offerId)}`;
  const res = await fetch(url, { headers: headers(env) });
  const html = await res.text();

  if (res.status === 401) {
    throw new Error('Epic rejected the session (401). EPIC_COOKIES has expired - sign in again.');
  }
  if (!res.ok) throw new Error(`Epic purchase page returned ${res.status}`);

  const m = html.match(/id="purchaseToken"[^>]*value="([^"]+)"/)
        ?? html.match(/"purchaseToken"\s*:\s*"([^"]+)"/);
  if (!m) {
    // Distinguish "already owned" from "markup changed": both produce no
    // token, and treating the first as an error would report failures for
    // games that are perfectly fine.
    if (/already own|ALREADY_OWNED/i.test(html)) {
      const e = new Error('already owned');
      e.alreadyOwned = true;
      throw e;
    }
    throw new Error('No purchase token on the page - Epic may have changed its checkout.');
  }
  return m[1];
}

/** Claim one free game. Resolves when Epic reports the order confirmed. */
export async function claim(env, game) {
  if (!configured(env)) throw new Error('EPIC_COOKIES is not set');
  if (!game.namespace || !game.offerId) {
    throw new Error(`No offer identifiers for "${game.title}"`);
  }

  const token = await purchaseToken(env, game.namespace, game.offerId);

  const body = new URLSearchParams({
    useDefault: 'true',
    setDefault: 'false',
    namespace: game.namespace,
    country: env.COUNTRY || 'US',
    countryName: env.COUNTRY || 'US',
    orderId: '',
    orderComplete: '',
    orderError: '',
    orderPending: '',
    offers: game.offerId,
    offerPrice: '',
    'offers[]': game.offerId,
    // A free game must cost nothing. Sending the price explicitly means Epic
    // rejects the order outright if it is not actually free, rather than this
    // quietly buying something.
    totalAmount: '0',
  });

  const res = await fetch(`${PAY}/purchase/confirm-order`, {
    method: 'POST',
    headers: headers(env, {
      'Content-Type': 'application/x-www-form-urlencoded',
      'x-requested-with': 'XMLHttpRequest',
      'x-epic-purchase-token': token,
    }),
    body,
  });

  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* Epic sometimes answers HTML */ }

  if (res.status === 401) {
    throw new Error('Epic rejected the session while ordering (401).');
  }
  if (data?.errorCode) {
    if (/already own/i.test(data.message ?? data.errorCode)) {
      const e = new Error('already owned');
      e.alreadyOwned = true;
      throw e;
    }
    throw new Error(`Epic refused the order: ${data.message ?? data.errorCode}`);
  }
  if (!res.ok) throw new Error(`Epic returned ${res.status} when confirming the order`);

  // Epic answers CONFIRMED for a completed order. Anything else is reported
  // rather than assumed good - the verification pass will settle it either way.
  const confirmed = data?.confirmation === true
                 || /CONFIRMED|SUCCESS/i.test(data?.orderStatus ?? data?.status ?? '');
  return { confirmed, raw: (data ?? text) };
}

/**
 * Claim everything worth claiming, one at a time.
 *
 * Sequential and paced on purpose. Epic gives away one or two games a week, so
 * there is no throughput to gain from concurrency, and a burst of purchase
 * requests is exactly the pattern worth avoiding on an account that matters.
 */
export async function claimAll(env, freebies, { limit = 5 } = {}) {
  const results = [];
  const targets = freebies.filter((g) => g.worthClaiming && g.namespace && g.offerId).slice(0, limit);

  for (const game of targets) {
    try {
      const r = await claim(env, game);
      results.push({
        game,
        ok: true,
        alreadyOwned: false,
        note: r.confirmed ? 'order confirmed' : 'order accepted but not confirmed',
      });
    } catch (e) {
      results.push({
        game,
        ok: e.alreadyOwned === true,
        alreadyOwned: e.alreadyOwned === true,
        note: e.alreadyOwned ? 'already owned' : e.message,
      });
    }
    if (targets.length > 1) await new Promise((r) => setTimeout(r, 3000));
  }
  return results;
}

export { normalizeTitle };
