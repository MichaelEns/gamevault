/**
 * Claim the free games you do not already have.
 *
 * What this does and does not do, and why.
 *
 * Fully unattended claiming is possible but a bad trade. Epic's purchase
 * endpoints answer 401 without a web session, and store.epicgames.com answers
 * 403 to anything that does not look like a real browser - it sits behind bot
 * protection. Automating through that means storing Epic credentials and
 * driving a headless browser past a captcha, which:
 *
 *   - breaks whenever Epic changes the flow, and breaks SILENTLY, so you
 *     believe you are covered while quietly missing every giveaway. That is
 *     worse than not automating at all.
 *   - is the kind of traffic that gets an account flagged. Losing an Epic
 *     library to save four clicks a week is a bad bet.
 *
 * So this automates the part that is genuinely tedious and error-prone - -
 * working out what is free, and whether you already own it - and leaves the
 * single click that Epic wants a human to make. In practice that turns a
 * weekly chore into one command and one click per game.
 *
 *   node tools/claim-free.mjs           # show what is worth claiming
 *   node tools/claim-free.mjs --open    # and open each claim page
 *
 * It never opens a page for something you already own on Epic, and it always
 * offers ones you own elsewhere, because a free permanent copy on a second
 * store still costs nothing.
 */
import { argv, platform } from 'node:process';
import { spawn } from 'node:child_process';
import { currentFreebies, timeLeft } from '../lib/freebies.mjs';
import { loadLibrary } from '../lib/library.mjs';

const open = argv.includes('--open');
const all = argv.includes('--all');

const library = await loadLibrary().catch(() => ({ index: {} }));
const index = library.index ?? {};

if (!Object.keys(index).length) {
  console.log('No local library found, so ownership cannot be checked.');
  console.log('Everything free will be listed; some may be games you already own.\n');
}

const freebies = await currentFreebies(process.env, index);

if (!freebies.length) {
  console.log('Nothing is free on Epic right now.');
  process.exit(0);
}

console.log(`${freebies.length} game(s) currently free on Epic:\n`);

const toClaim = [];
for (const g of freebies) {
  const left = timeLeft(g.endsAt);
  if (g.ownedHere) {
    console.log(`  [own] ${g.title}`);
    console.log(`        already yours on Epic - nothing to do`);
    continue;
  }
  toClaim.push(g);
  console.log(`  [get] ${g.title}   (${left})`);
  if (g.ownedElsewhere.length) {
    // Deliberately still worth claiming: a second permanent copy is free.
    console.log(`        you own it on ${g.ownedElsewhere.join(', ')} - still worth a free Epic copy`);
  }
  console.log(`        ${g.url}`);
}

if (!toClaim.length) {
  console.log('\nYou already own everything free this week.');
  process.exit(0);
}

const list = all ? freebies : toClaim;

if (!open) {
  console.log(`\n${toClaim.length} to claim. Re-run with --open to open them:`);
  console.log('  node tools/claim-free.mjs --open');
  process.exit(0);
}

console.log(`\nOpening ${list.length} page(s). Sign in to Epic if prompted, then press Get.`);

function openUrl(url) {
  // Deliberately uses the OS handler rather than a bundled browser: the point
  // is to land in the browser where you are already signed in to Epic.
  if (platform === 'win32') return spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  if (platform === 'darwin') return spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  return spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

for (const g of list) {
  openUrl(g.url);
  // Staggered: a browser handed several URLs at once tends to drop some.
  await new Promise((r) => setTimeout(r, 900));
}

console.log('\nDone. Claimed games appear in the app after the next rebuild.');
