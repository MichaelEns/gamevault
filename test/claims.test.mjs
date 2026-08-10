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
import { verifyClaims, nextLog, recordAttempt, reportable } from '../lib/claims.mjs';
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

console.log('');
if (fails) { console.log(`${fails} assertion(s) failed.`); process.exit(1); }
console.log('All claim-verification tests passed.');
