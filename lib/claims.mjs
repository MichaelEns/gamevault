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
 * How long a failure keeps being reported, and kept in the log.
 *
 * A failure nobody has acted on in two weeks has either been handled by hand
 * or is never going to be. An alert that can never clear is an alert that gets
 * ignored, which defeats the point of raising it at all.
 */
const REPORT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** Identity of a claim: the same game on two stores is two different claims. */
const entryKey = (e) => `${e.store ?? ''}\u0000${e.norm ?? normalizeTitle(e.title ?? '')}`;

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
      // When it was FIRST judged failed, not when it was last looked at.
      // Re-stamping this every build made the field mean "now" forever, which
      // silently defeats every age-based rule downstream: the alert could
      // never grow old enough to stop being reported.
      failedAt: entry.failedAt ?? new Date(now).toISOString(),
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
 * them would grow the snapshot forever. Failures are kept: while they are
 * still being retried the app reports them, and afterwards they remain as a
 * tombstone recording that this game was tried and abandoned. Entries are
 * keyed, so a retry replaces the record it retried rather than joining it.
 */
export function nextLog({ pending, failed, attempts }) {
  const out = new Map();
  for (const p of pending) out.set(entryKey(p), p);

  for (const f of failed) {
    const tries = (f.attempts ?? 1);
    // Retried a few times, then left alone. Something that has failed three
    // times is not going to succeed on the fourth, and repeatedly poking a
    // storefront is exactly the behaviour that gets an account noticed.
    //
    // `attempts` counts requests actually sent, so it is incremented where a
    // request is made (below), not here. This only decides when to stop.
    //
    // A given-up entry is KEPT rather than dropped once it stops being
    // reported: it is the tombstone that stops the game being claimed all
    // over again. Only verified claims are discarded, and those are the ones
    // that would actually accumulate.
    out.set(entryKey(f), tries >= MAX_ATTEMPTS
      ? { ...f, attempts: tries, giveUp: true }
      : { ...f, attempts: tries });
  }

  // A fresh attempt supersedes the record that prompted it and inherits its
  // strike count. Without this a retry would append a SECOND entry for the
  // same game whose count restarts at 1, so MAX_ATTEMPTS could never be
  // reached and the pair would retry each other forever.
  for (const a of attempts) {
    const prior = out.get(entryKey(a));
    out.set(entryKey(a), prior ? { ...a, attempts: (prior.attempts ?? 1) + 1 } : a);
  }

  return [...out.values()];
}

/**
 * Whether a failure is recent enough to still be worth reporting.
 *
 * Anchored on when the claim was actually SENT, because that is the event
 * that failed; `failedAt` is merely when a later build got around to noticing.
 * A retry sends a new request and so starts a new clock, which is what keeps
 * an ongoing problem visible while letting a dead one fall silent.
 */
function withinWindow(entry, now) {
  const stamp = Date.parse(entry.attemptedAt ?? entry.failedAt ?? '');
  // No usable timestamp: keep it rather than silently discarding a failure.
  if (!Number.isFinite(stamp)) return true;
  return (now - stamp) < REPORT_WINDOW_MS;
}

/**
 * Whether a recorded claim should be sent again on this build.
 *
 * Only something already judged failed is retried. An entry with no
 * `failedAt` is still inside the grace window - its claim may yet turn up,
 * and re-sending it would double-poke the storefront for nothing.
 */
export function retryable(entry = {}) {
  if (!entry.failedAt || entry.giveUp) return false;
  return (entry.attempts ?? 1) < MAX_ATTEMPTS;
}

/**
 * A predicate for "may this game be claimed on this build?".
 *
 * The claim log is the only record of what has already been tried, so this is
 * what stands between a transient failure and a claim request on every single
 * build. It is keyed on store AND title: the same game given away on two
 * stores is two independent claims, and a failure on one must not silently
 * suppress the other.
 */
export function claimFilter(log = []) {
  const blocked = new Set(log.filter((e) => !retryable(e)).map(entryKey));
  return (game) => !blocked.has(entryKey(game));
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

/** Failures worth telling the user about: still failing, not yet stale. */
export function reportable(log, now = Date.now()) {
  return log.filter((e) => {
    const isFailure = (e.ok === false && e.error) || Boolean(e.failedAt);
    if (!isFailure) return false;
    // Every failure ages out, including an outright rejection. Previously a
    // rejected claim returned true before this check ever ran, so its alert
    // could never clear - the storefront had long since moved on to a
    // different free game and the same warning was still being raised.
    return withinWindow(e, now);
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
