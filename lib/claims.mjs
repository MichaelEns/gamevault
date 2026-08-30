/**
 * Claim attempts, and whether they actually worked.
 *
 * Automating a claim is only defensible if a failure is noticed. An automation
 * that quietly stops working is worse than none at all: it produces confident
 * inaction, and you find out months later that you missed everything.
 *
 * So every claim is recorded, and the NEXT build checks the library for it.
 * The library is the only honest arbiter here - Epic returning HTTP 200 says
 * the request was accepted, not that the game arrived. A claim is verified
 * only when the game shows up in the synced library.
 *
 * The log lives inside the snapshot, and each build reads the previous
 * published snapshot to carry it forward. That works because the build already
 * holds the passphrase, and it avoids keeping state anywhere else.
 */
import { createHmac } from 'node:crypto';
import { decryptJson } from './snapshot-crypto.mjs';
import { normalizeTitle } from './match.mjs';

/** How long to wait before treating an unverified claim as failed. */
const GRACE_MS = 12 * 60 * 60 * 1000;   // two scheduled builds

/** Stop re-attempting a claim that has failed this many times. */
const MAX_ATTEMPTS = 3;

/**
 * Read the claim log out of the previously published snapshot.
 *
 * Deliberately tolerant: a missing, unreadable or undecryptable snapshot means
 * starting fresh, which is correct on a first run and harmless afterwards. It
 * must never break a build.
 */
export async function loadPreviousClaims(siteUrl, passphrase) {
  if (!siteUrl) return [];
  try {
    const res = await fetch(`${siteUrl.replace(/\/$/, '')}/snapshot.json`, { cache: 'no-store' });
    if (!res.ok) return [];
    const envelope = await res.json();
    const snap = envelope?.format === 'gamevault-plain-snapshot'
      ? envelope.snapshot
      : await decryptJson(envelope, passphrase);
    return Array.isArray(snap?.claimLog) ? snap.claimLog : [];
  } catch {
    return [];
  }
}

/**
 * Decide the fate of every recorded claim, given the current library.
 *
 * @param {Array}  log    previous claim entries
 * @param {object} index  normalised title -> [{ store, ... }]
 * @param {number} now
 */
export function verifyClaims(log, index = {}, now = Date.now()) {
  const verified = [];
  const pending = [];
  const failed = [];

  for (const entry of log) {
    const owners = (Array.isArray(index[entry.norm]) ? index[entry.norm] : [])
      .map((e) => e?.store)
      .filter(Boolean);

    if (owners.includes(entry.store)) {
      // It arrived. Nothing more to say about it.
      verified.push({ ...entry, verifiedAt: new Date(now).toISOString() });
      continue;
    }

    const age = now - Date.parse(entry.attemptedAt);
    if (!Number.isFinite(age) || age < GRACE_MS) {
      // Too soon to judge: the library sync and the claim may not have lined
      // up yet, and calling that a failure would cry wolf on every run.
      pending.push(entry);
      continue;
    }

    failed.push({
      ...entry,
      failedAt: new Date(now).toISOString(),
      reason: entry.error
        ? `claim was rejected: ${entry.error}`
        : 'the claim appeared to succeed, but the game never arrived in your library',
    });
  }

  return { verified, pending, failed };
}

/**
 * The log to publish for the next build.
 *
 * Verified claims are dropped - they have served their purpose and keeping
 * them would grow the snapshot forever. Failures are kept until they stop
 * being retried, so the app can keep reporting them.
 */
export function nextLog({ pending, failed, attempts }) {
  const out = [...pending];
  for (const f of failed) {
    const tries = (f.attempts ?? 1);
    // Retried a few times, then left alone. Something that has failed three
    // times is not going to succeed on the fourth, and repeatedly poking a
    // storefront is exactly the behaviour that gets an account noticed.
    if (tries < MAX_ATTEMPTS) out.push({ ...f, attempts: tries });
    else out.push({ ...f, attempts: tries, giveUp: true });
  }
  out.push(...attempts);
  return out;
}

/** A new attempt record. */
export function recordAttempt(game, { ok, error = null }) {
  return {
    title: game.title,
    norm: game.norm ?? normalizeTitle(game.title),
    store: game.store,
    url: game.url ?? null,
    attemptedAt: new Date().toISOString(),
    ok,
    error,
    attempts: 1,
  };
}

/** Failures worth telling the user about: still failing, not yet given up on. */
export function reportable(log, now = Date.now()) {
  return log.filter((e) => {
    if (e.ok === false && e.error) return true;
    if (!e.failedAt) return false;
    // Give up entries are still worth showing once, but not forever.
    const age = now - Date.parse(e.failedAt);
    return Number.isFinite(age) && age < 14 * 24 * 60 * 60 * 1000;
  });
}

/**
 * What kind of failure this is, as one of four fixed words.
 *
 * The distinction is the difference between two very different jobs:
 *
 *   auth     - the stored credential is dead, so EVERY future claim fails too.
 *              Claiming this one game by hand fixes nothing; the secret has to
 *              be refreshed. This is the case worth interrupting someone for.
 *   rejected - the storefront said no to this specific game (sold out, wrong
 *              region, already owned). Nothing is broken.
 *   missing  - accepted, then never arrived. Claim it by hand.
 *   error    - anything else.
 *
 * A fixed vocabulary, rather than the raw message, is what makes this safe to
 * publish: the strings can never grow to contain a game title.
 */
export function classifyFailure(entry = {}) {
  const text = `${entry.error ?? ''} ${entry.reason ?? ''}`;
  if (/\b40[13]\b|expired|sign in again|login_required|rejected the session/i.test(text)) {
    return 'auth';
  }
  if (entry.ok === false && entry.error) return 'rejected';
  if (entry.failedAt) return 'missing';
  return 'error';
}

/**
 * The publishable form of the failures: enough to alert on, no titles.
 *
 * snapshot-meta.json is served unencrypted so the app can show freshness
 * before you unlock, so everything here is world-readable and the bar is
 * therefore "provably leaks nothing", not "probably fine". Hence a fixed
 * vocabulary for `kind`, a bare store name, and an opaque id.
 *
 * The id exists because a bare count cannot be alerted on correctly. If one
 * failure resolves in the same build that another appears, the count stays at
 * 1 and a counter-watcher stays silent through a brand-new failure. Ids make
 * "the same problem, still there" distinguishable from "a different problem".
 *
 * It is an HMAC keyed on the snapshot passphrase rather than a plain hash.
 * Free-game titles come from a short public list, so a plain hash of one could
 * simply be looked up in a table built from that list; keying it means the id
 * is stable across builds (it must be, or every build looks like a new alert)
 * while revealing nothing to anyone without the passphrase.
 */
export function publicAlerts(log, { secret = '', now = Date.now() } = {}) {
  const key = secret || 'gamevault-unkeyed';
  return reportable(log, now).map((e) => {
    const id = createHmac('sha256', key)
      .update(`${e.store ?? ''}\u0000${e.norm ?? e.title ?? ''}`)
      .digest('hex')
      .slice(0, 12);
    return {
      id,
      store: String(e.store ?? 'unknown'),
      kind: classifyFailure(e),
      givenUp: e.giveUp === true,
    };
  });
}
