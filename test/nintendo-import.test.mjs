/**
 * Nintendo play-record import.
 *
 * Nintendo has no purchase API, so play time is the only signal available.
 * It is a proxy, and a lossy one in the dangerous direction: demos, trials,
 * borrowed cartridges and the NSO classics library all leave play records for
 * games you do not own. So the import must present a list to prune, never
 * assert ownership on its own -- and it must not quietly drop titles you
 * already claimed.
 */
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { collectPlayedTitles, formatDuration, suspicion } from '../tools/nintendo-import.mjs';

let fails = 0;
const ok = (cond, msg) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); fails++; }
  else console.log(`  ok:   ${msg}`);
};

const root = path.join(tmpdir(), `gv-nintendo-${process.pid}`);
const daily = path.join(root, 'devices', 'abc123', 'daily');
const monthly = path.join(root, 'devices', 'abc123', 'monthly');
await mkdir(daily, { recursive: true });
await mkdir(monthly, { recursive: true });

// Shapes taken from nxapi's Parental Controls output. Deliberately includes a
// wrapped form and an array form, because these have varied across versions.
await writeFile(path.join(daily, '2026-01-02.json'), JSON.stringify({
  date: '2026-01-02',
  playedApps: [
    { applicationId: '0100000000010000', title: 'The Legend of Zelda: Tears of the Kingdom', playingTime: 7200 },
    { applicationId: '0100000000020000', title: 'Super Mario Odyssey', playingTime: 1800 },
  ],
}), 'utf8');

await writeFile(path.join(daily, '2026-01-03.json'), JSON.stringify({
  result: {
    date: '2026-01-03',
    playedApps: [
      // Same title again: monthly aggregates dailies, so this must not double.
      { applicationId: '0100000000010000', title: 'The Legend of Zelda: Tears of the Kingdom', playingTime: 3600 },
      { applicationId: '0100000000030000', title: 'NES - Nintendo Switch Online', playingTime: 5400 },
    ],
  },
}), 'utf8');

await writeFile(path.join(monthly, '2026-01.json'), JSON.stringify([{
  month: '2026-01',
  playedApps: [
    { applicationId: '0100000000010000', title: 'The Legend of Zelda: Tears of the Kingdom', playingTime: 36000 },
    { applicationId: '0100000000040000', title: 'Pikmin 4 Demo', playingTime: 600 },
    { applicationId: '0100000000050000', title: 'Mario Kart 8 Deluxe', playingTime: 300 },
  ],
}]), 'utf8');

await writeFile(path.join(root, 'not-json.txt'), 'ignore me', 'utf8');
await writeFile(path.join(root, 'broken.json'), '{ this is not json', 'utf8');

try {
  console.log('Reads nxapi summaries in every shape they come in');
  const { titles, filesRead, skipped } = await collectPlayedTitles(root);
  ok(filesRead === 3, `parsed the 3 valid JSON files, skipping the text file (got ${filesRead})`);
  ok(titles.length === 5, `found 5 distinct titles (got ${titles.length})`);
  ok(titles.some((t) => t.title === 'Super Mario Odyssey'), 'plain object shape parsed');
  ok(titles.some((t) => t.title === 'NES - Nintendo Switch Online'), 'wrapped {result:...} shape parsed');
  ok(titles.some((t) => t.title === 'Mario Kart 8 Deluxe'), 'array shape parsed');

  console.log('\nMalformed input is skipped but REPORTED, not swallowed');
  // A summary that will not parse is a game quietly going missing.
  ok(skipped.length === 1, `the broken file was reported (got ${skipped.length})`);
  ok(skipped[0].file.endsWith('broken.json'), `and named: ${path.basename(skipped[0].file)}`);

  console.log('\nPlay time is not double-counted across daily and monthly files');
  const zelda = titles.find((t) => t.title.includes('Zelda'));
  // 2h + 1h daily and 10h monthly are the SAME play time reported twice.
  ok(zelda.seconds === 36000, `Zelda shows 10h, not 13h (got ${formatDuration(zelda.seconds)})`);

  console.log('\nSorted by play time, so the most likely purchases come first');
  ok(titles[0].title.includes('Zelda'), `most-played first (${titles[0].title})`);
  ok(titles[titles.length - 1].seconds <= titles[0].seconds, 'descending order');

  console.log('\nThings you can play without owning are flagged');
  const flagOf = (name) => suspicion(titles.find((t) => t.title === name));
  ok(/NSO classics/.test(flagOf('NES - Nintendo Switch Online') ?? ''),
     'NSO classics flagged as subscription access, not ownership');
  ok(/demo/i.test(flagOf('Pikmin 4 Demo') ?? ''), 'a demo is flagged by name');
  ok(/15 minutes/.test(flagOf('Mario Kart 8 Deluxe') ?? ''),
     '5 minutes of play is flagged as possibly borrowed');
  ok(suspicion(titles.find((t) => t.title.includes('Zelda'))) === null,
     'a genuinely played game is NOT flagged');

  console.log('\nDurations read the way a person would say them');
  ok(formatDuration(36000) === '10h 0m', `36000s -> ${formatDuration(36000)}`);
  ok(formatDuration(300) === '5m', `300s -> ${formatDuration(300)}`);
  ok(formatDuration(0) === 'no recorded time', `0s -> ${formatDuration(0)}`);

  console.log('\nAn empty or missing directory is reported, not crashed on');
  const none = await collectPlayedTitles(path.join(root, 'does-not-exist'));
  ok(none.filesRead === 0 && none.titles.length === 0, 'missing directory yields an empty result');

  console.log('\nManual entries reach a build that has no data directory');
  // data/ is gitignored, so without the env path the entire manual library
  // contributed nothing to the deployed snapshot -- indistinguishable from
  // having entered nothing at all.
  const manual = await import('../lib/manual.mjs');
  const before = process.env.MANUAL_LIBRARY;
  try {
    process.env.MANUAL_LIBRARY = JSON.stringify({ nintendo: ['Metroid Dread', 'Splatoon 3'] });
    const loaded = await manual.load();
    ok(loaded.nintendo?.length === 2, `MANUAL_LIBRARY is read from the environment (${loaded.nintendo?.length} titles)`);
    ok(loaded.nintendo.includes('Metroid Dread'), 'and the titles survive intact');

    // A malformed secret must fail loudly: silently returning {} would drop
    // every hand-entered game with no indication.
    process.env.MANUAL_LIBRARY = '{ broken';
    let threw = '';
    await manual.load().catch((e) => { threw = e.message; });
    ok(/could not be parsed/.test(threw), `a malformed secret fails loudly: ${threw.slice(0, 60)}`);

    process.env.MANUAL_LIBRARY = '"a string, not an object"';
    threw = '';
    await manual.load().catch((e) => { threw = e.message; });
    ok(/could not be parsed/.test(threw), 'and so does valid JSON of the wrong shape');
  } finally {
    if (before === undefined) delete process.env.MANUAL_LIBRARY;
    else process.env.MANUAL_LIBRARY = before;
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('');
if (fails) { console.log(`${fails} assertion(s) failed.`); process.exit(1); }
console.log('All Nintendo import tests passed.');
