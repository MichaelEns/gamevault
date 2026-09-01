/**
 * Claim verification.
 *
 * This is the mechanism that makes automated claiming defensible, so its
 * failure modes matter more than most:
 *
 *   - reporting success when a game never arrived would be the silent failure
 *     the whole design exists to prevent;
 *   - reporting failure too eagerly would cry wolf every build and train the
 *     user to ignore it, which comes to the same thing.
 *
 * Both directions are pinned here.
 */
import { verifyClaims, nextLog, recordAttempt, reportable, classifyFailure, publicAlerts, claimFilter, retryable } from '../lib/claims.mjs';
import { normalizeTitle } from '../lib/match.mjs';

let fails = 0;
const ok = (cond, msg) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); fails++; }
  else console.log(`  ok:   ${msg}`);
};

const HOUR = 3600000;
const NOW = Date.parse('2026-08-10T12:00:00Z');
const ago = (h) => new Date(NOW - h * HOUR).toISOString();

// Built the way lib/library.mjs builds it.
const index = {};
for (const [store, titles] of Object.entries({ epic: ['Beacon Pines'], steam: ['Celeste'] })) {
  for (const t of titles) (index[normalizeTitle(t)] ??= []).push({ store, title: t });
}

const log = [
  // Arrived.
  { title: 'Beacon Pines', norm: 'beacon pines', store: 'epic', attemptedAt: ago(24), ok: true, attempts: 1 },
  // Claimed minutes ago - too soon to judge.
  { title: 'Tunic', norm: 'tunic', store: 'epic', attemptedAt: ago(1), ok: true, attempts: 1 },
  // Claimed a day ago and still absent.
  { title: 'Inscryption', norm: 'inscryption', store: 'epic', attemptedAt: ago(30), ok: true, attempts: 1 },
  // Owned on Steam, but the claim was for EPIC - a Steam copy does not prove
  // the Epic claim worked, and treating it as proof would hide a real failure.
  { title: 'Celeste', norm: 'celeste', store: 'epic', attemptedAt: ago(30), ok: true, attempts: 1 },
];

const { verified, pending, failed } = verifyClaims(log, index, NOW);

console.log('A game that arrived is confirmed');
ok(verified.some((v) => v.title === 'Beacon Pines'), 'Beacon Pines verified from the library');
ok(verified[0].verifiedAt, 'and stamped with when it was confirmed');

console.log('\nA recent claim is not judged prematurely');
// Crying wolf every build is how a warning gets ignored.
ok(pending.some((p) => p.title === 'Tunic'), 'a claim an hour old is still pending, not failed');
ok(!failed.some((f) => f.title === 'Tunic'), 'and is not reported as a failure');

console.log('\nA claim that never arrived is reported');
ok(failed.some((f) => f.title === 'Inscryption'), 'Inscryption failed after the grace period');
ok(/never arrived/.test(failed.find((f) => f.title === 'Inscryption').reason),
   'and the reason distinguishes "accepted but absent" from "rejected"');

console.log('\nOwning it on ANOTHER store does not prove the claim worked');
// The claim was for Epic. A Steam copy is irrelevant, and accepting it would
// silently mask exactly the failure this is meant to catch.
ok(failed.some((f) => f.title === 'Celeste'),
   'a Steam copy does not verify an Epic claim');

console.log('\nA rejected claim keeps its own error, not a generic one');
const rejected = verifyClaims(
  [{ title: 'X', norm: 'x', store: 'epic', attemptedAt: ago(30), ok: false, error: 'Epic refused the order: SOLD_OUT' }],
  {}, NOW,
);
ok(/SOLD_OUT/.test(rejected.failed[0].reason), `keeps the real reason: ${rejected.failed[0].reason}`);

console.log('\nFailures are retried, but not forever');
// Retrying indefinitely would poke the storefront every six hours, which is
// the behaviour most likely to get an account noticed.
let carried = nextLog({ pending: [], failed: [{ ...failed[0], attempts: 1 }], attempts: [] });
ok(carried[0].attempts === 1 && !carried[0].giveUp, 'a first failure is kept for retry');
carried = nextLog({ pending: [], failed: [{ ...failed[0], attempts: 3 }], attempts: [] });
ok(carried[0].giveUp === true, 'after three attempts it stops being retried');

console.log('\nVerified claims are dropped so the log cannot grow forever');
const trimmed = nextLog({ pending, failed, attempts: [] });
ok(!trimmed.some((e) => e.title === 'Beacon Pines'), 'the confirmed claim is gone');
ok(trimmed.some((e) => e.title === 'Tunic'), 'the pending one is carried forward');

console.log('\nA new attempt records what actually happened');
const okAttempt = recordAttempt({ title: 'New Game', store: 'epic', url: 'u' }, { ok: true });
ok(okAttempt.norm === normalizeTitle('New Game'), 'normalised for later lookup');
ok(okAttempt.ok === true && okAttempt.error === null, 'success recorded without an error');
const badAttempt = recordAttempt({ title: 'Bad', store: 'epic' }, { ok: false, error: 'nope' });
ok(badAttempt.ok === false && badAttempt.error === 'nope', 'failure keeps its message');

console.log('\nOnly genuine problems are surfaced to the user');
const surfaced = reportable([
  { title: 'ok', ok: true },
  { title: 'rejected', ok: false, error: 'refused' },
  { title: 'absent', failedAt: new Date(NOW - HOUR).toISOString() },
  { title: 'ancient', failedAt: new Date(NOW - 30 * 24 * HOUR).toISOString() },
], NOW);
ok(surfaced.some((s) => s.title === 'rejected'), 'a rejected claim is reported');
ok(surfaced.some((s) => s.title === 'absent'), 'a missing game is reported');
ok(!surfaced.some((s) => s.title === 'ok'), 'a successful claim is not');
ok(!surfaced.some((s) => s.title === 'ancient'), 'and a month-old failure stops nagging');

console.log('\nA dead credential is distinguished from one game being refused');
// This is the distinction that decides what the reader has to DO. An expired
// cookie breaks every future claim and is fixed by re-authenticating; a
// sold-out game is fixed by nothing at all.
ok(classifyFailure({ ok: false, error: 'Epic rejected the session (401). EPIC_COOKIES has expired - sign in again.' }) === 'auth',
   'an expired Epic session is "auth"');
ok(classifyFailure({ ok: false, error: 'Humble rejected the session (401). The HUMBLE_SESSION cookie has expired' }) === 'auth',
   'an expired Humble session is "auth"');
ok(classifyFailure({ ok: false, error: 'Epic refused the order: SOLD_OUT' }) === 'rejected',
   'a sold-out game is only "rejected"');
ok(classifyFailure({ failedAt: ago(1), reason: 'the claim appeared to succeed, but the game never arrived in your library' }) === 'missing',
   'accepted-then-absent is "missing"');

console.log('\nThe published alert form leaks no titles');
// snapshot-meta.json is served UNENCRYPTED so the app can show freshness
// before unlocking, so anything added to it is world-readable. A title
// reaching this structure would put part of the library in the clear, which
// is the one outcome the whole encrypted-snapshot design exists to prevent.
const secretLog = [
  { title: 'Epic Mage Bundle', norm: 'epic mage bundle', store: 'epic', ok: false,
    error: 'Epic rejected the session (401). EPIC_COOKIES has expired - sign in again.' },
  { title: 'Hades', norm: 'hades', store: 'gog', failedAt: ago(1), giveUp: true },
];
const published = publicAlerts(secretLog, { secret: 'pass', now: NOW });
const asText = JSON.stringify(published);
ok(!/epic mage bundle|hades/i.test(asText), `no title appears in ${asText}`);
ok(published.every((a) => Object.keys(a).sort().join() === 'givenUp,id,kind,store'),
   'and no unexpected field can smuggle one in');
ok(published[0].kind === 'auth' && published[0].store === 'epic',
   'the actionable part survives: epic / auth');
ok(published[1].givenUp === true, 'and "no longer being retried" is carried through');

console.log('\nAlert ids are stable, distinct, and keyed');
// Stable: an id that changed every build would make one unfixed problem look
// like a new problem every six hours. Distinct: without per-failure identity,
// one failure resolving as another appears leaves the count unchanged and a
// counter-watcher silent through a brand-new failure.
const again = publicAlerts(secretLog, { secret: 'pass', now: NOW + HOUR });
ok(again[0].id === published[0].id, 'the same failure keeps its id across builds');
ok(published[0].id !== published[1].id, 'different failures get different ids');
const otherKey = publicAlerts(secretLog, { secret: 'different', now: NOW });
ok(otherKey[0].id !== published[0].id,
   'the id is keyed on the passphrase, so a public title list cannot be hashed to match it');
ok(/^[0-9a-f]{12}$/.test(published[0].id), `and is opaque (${published[0].id})`);

console.log('\nA failure is actually retried, and the retry loop terminates');
// This is the pair of bugs that made a stuck claim permanent: the skip set was
// inverted (it skipped everything NOT given up, so nothing was ever retried),
// and a retry appended a second entry whose count restarted at 1. Simulated
// over many builds because both faults are only visible over time - a single
// call to either function looks perfectly correct.
{
  const HOURS_PER_BUILD = 6;
  const free = { title: 'Stuck Game', norm: 'stuck game', store: 'epic' };
  let log = [];
  let sent = 0;
  let clock = NOW;

  // 20 days, so the run crosses the point where the alert should age out.
  for (let build = 0; build < 80; build++) {
    clock += HOURS_PER_BUILD * HOUR;
    // The game is never in the library, so the claim never verifies.
    const o = verifyClaims(log, {}, clock);
    const attempts = [];
    if (claimFilter(log)(free)) {
      sent++;
      attempts.push({ ...recordAttempt(free, { ok: false, error: 'Epic rejected the session (401)' }),
                      attemptedAt: new Date(clock).toISOString() });
    }
    log = nextLog({ pending: o.pending, failed: o.failed, attempts });
  }

  ok(sent === 3, `exactly MAX_ATTEMPTS requests were sent over 80 builds, not 1 and not 80 (sent ${sent})`);
  ok(log.length === 1, `and the log holds one entry for it, not one per retry (${log.length})`);
  ok(log[0].giveUp === true, 'the surviving entry is marked given up');
  ok(reportable(log, clock).length === 0,
     'and once stale it stops being reported, so the alert can finally clear');
  // The tombstone has to survive, or the game becomes claimable all over again.
  ok(!claimFilter(log)(free), 'while still blocking any further attempt');
}

console.log('\nLooking at a failure again does not reset its age');
// failedAt used to be re-stamped on every build, so it always read "now". That
// silently defeated every age-based rule: the alert could never grow old
// enough to stop being reported, no matter how long it had really been there.
{
  const first = verifyClaims(
    [{ title: 'Y', norm: 'y', store: 'epic', attemptedAt: ago(30), ok: true, attempts: 1 }],
    {}, NOW,
  ).failed[0];
  const later = verifyClaims([first], {}, NOW + 10 * 24 * HOUR).failed[0];
  ok(later.failedAt === first.failedAt,
     `failedAt survives ten more days of builds unchanged (${later.failedAt})`);
  ok(reportable([later], NOW + 20 * 24 * HOUR).length === 0,
     'so it does eventually age out of the alerts');
}

console.log('\nA claim inside its grace window is never re-sent');
// Re-sending here would double-claim a request that may still succeed.
ok(!claimFilter([{ store: 'epic', norm: 'tunic', attemptedAt: ago(1), ok: true, attempts: 1 }])
    ({ store: 'epic', norm: 'tunic' }),
   'a pending claim blocks a second attempt');
ok(!claimFilter([{ store: 'epic', norm: 'x', failedAt: ago(1), attempts: 3, giveUp: true }])
    ({ store: 'epic', norm: 'x' }),
   'a given-up claim is not retried');
ok(claimFilter([{ store: 'epic', norm: 'x', failedAt: ago(1), attempts: 1 }])
    ({ store: 'epic', norm: 'x' }),
   'but a failure with attempts left IS retried');

console.log('\nA failure on one store does not suppress the same game on another');
// The skip set used to be keyed on title alone, so a dead Epic session would
// silently stop the same giveaway being claimed on GOG, where nothing is wrong.
ok(claimFilter([{ store: 'epic', norm: 'hades', failedAt: ago(1), attempts: 3, giveUp: true }])
    ({ store: 'gog', norm: 'hades' }),
   'the GOG copy is still claimable');

console.log('\nAn outright rejection stops nagging eventually');
// It used to return early, before the age check, so it was reported forever.
const staleReject = [{ title: 'old', store: 'epic', norm: 'old', ok: false, error: 'refused',
                       attemptedAt: ago(24 * 30), failedAt: ago(24 * 30) }];
ok(reportable(staleReject, NOW).length === 0, 'a month-old rejection is no longer reported');
ok(reportable([{ ...staleReject[0], attemptedAt: ago(2), failedAt: ago(2) }], NOW).length === 1,
   'but a fresh one still is');

console.log('');
if (fails) { console.log(`${fails} assertion(s) failed.`); process.exit(1); }
console.log('All claim-verification tests passed.');
