/**
 * Turn Nintendo play records into a reviewable ownership list.
 *
 * Nintendo publishes no purchase API, and nxapi has no ownership command --
 * its Parental Controls summaries report what was PLAYED. Play time is a
 * decent proxy but a lossy one, and it is lossy in the direction that matters:
 * demos, free trials, a friend's cartridge and the Nintendo Switch Online
 * classics library all produce play records for games you do not own. The NSO
 * classics case is the same mistake this app already had to fix once, when a
 * console-only Game Pass title was reported as "included".
 *
 * So nothing here asserts ownership. It produces a list, sorted by play time,
 * for you to prune -- and everything that survives is your claim, not an
 * inference.
 *
 *   nxapi pctl dump-summaries ./nintendo-data      (once, on a PC)
 *   node tools/nintendo-import.mjs ./nintendo-data
 *
 * Existing manual entries are preserved: a title already on your list is never
 * dropped just because it has no recent play record.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { stdin, stdout, argv } from 'node:process';
import path from 'node:path';

/** Titles NSO gives you access to rather than selling you. */
const NSO_CLASSICS = /^(NES|SNES|Nintendo 64|GBA|Game Boy|SEGA Mega Drive|SEGA Genesis)[\s\u2013-]+Nintendo Switch Online/i;

/**
 * Collect played titles from an `nxapi pctl dump-summaries` directory.
 *
 * Both daily and monthly summaries carry a `playedApps` array. Shapes have
 * varied across nxapi versions, so this reads defensively and reports what it
 * understood rather than assuming.
 */
export async function collectPlayedTitles(dir) {
  const byTitle = new Map();
  let filesRead = 0;
  const skipped = [];

  async function walk(current) {
    let entries;
    try { entries = await readdir(current); } catch { return; }
    for (const name of entries) {
      const full = path.join(current, name);
      const info = await stat(full).catch(() => null);
      if (info?.isDirectory()) { await walk(full); continue; }
      if (!name.endsWith('.json')) continue;

      let data;
      try {
        data = JSON.parse(await readFile(full, 'utf8'));
      } catch (e) {
        // Reported rather than swallowed: a summary that will not parse is a
        // game you own quietly going missing, which is exactly the kind of
        // silent loss this import exists to avoid.
        skipped.push({ file: full, reason: e.message });
        continue;
      }
      filesRead++;

      // A summary may be the object itself, or wrapped, or an array of them.
      const candidates = Array.isArray(data) ? data : [data, data?.result, data?.summary];
      for (const c of candidates) {
        const apps = c?.playedApps ?? c?.playedApp ?? null;
        if (!Array.isArray(apps)) continue;
        for (const app of apps) {
          const title = (app?.title ?? app?.name ?? '').trim();
          if (!title) continue;
          const seconds = Number(app?.playingTime ?? app?.playing_time ?? 0) || 0;
          const prev = byTitle.get(title) ?? { title, seconds: 0, appId: app?.applicationId ?? null };
          // Monthly summaries already aggregate their daily rows, so taking
          // the maximum avoids counting the same play time twice.
          prev.seconds = Math.max(prev.seconds, seconds);
          byTitle.set(title, prev);
        }
      }
    }
  }

  await walk(dir);
  const titles = [...byTitle.values()].sort((a, b) => b.seconds - a.seconds);
  return { titles, filesRead, skipped };
}

export function formatDuration(seconds) {
  if (!seconds) return 'no recorded time';
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h >= 1) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Flags a title as needing a closer look, and says why. */
export function suspicion(entry) {
  if (NSO_CLASSICS.test(entry.title)) return 'NSO classics - included with the subscription, not owned';
  if (/\bdemo\b|\btrial\b|\bdemo version\b/i.test(entry.title)) return 'looks like a demo';
  if (entry.seconds > 0 && entry.seconds < 900) return 'under 15 minutes - could be a demo or a borrowed cartridge';
  return null;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
if (import.meta.url === `file://${argv[1]?.replace(/\\/g, '/')}` || argv[1]?.endsWith('nintendo-import.mjs')) {
  const dir = argv[2];
  if (!dir) {
    console.error('Usage: node tools/nintendo-import.mjs <nxapi-summaries-dir>\n');
    console.error('First, on a PC with nxapi installed:');
    console.error('  npm install --global nxapi');
    console.error('  nxapi pctl auth');
    console.error('  nxapi pctl dump-summaries ./nintendo-data\n');
    console.error('Then point this at ./nintendo-data.');
    process.exit(1);
  }

  const { titles, filesRead, skipped } = await collectPlayedTitles(dir);
  if (skipped.length) {
    console.warn(`Warning: ${skipped.length} file(s) could not be parsed and were ignored:`);
    for (const s of skipped.slice(0, 5)) console.warn(`  ${s.file}`);
    console.warn('Games recorded only in those files will be missing from this list.\n');
  }
  if (!filesRead) {
    console.error(`No JSON summaries found under ${dir}.`);
    console.error('Did "nxapi pctl dump-summaries" write somewhere else?');
    process.exit(1);
  }
  if (!titles.length) {
    console.error(`Read ${filesRead} files but found no playedApps entries.`);
    console.error('Parental Controls only records play time for consoles linked to it.');
    process.exit(1);
  }

  console.log(`Read ${filesRead} summary files; found ${titles.length} played titles.\n`);
  console.log('These are games you PLAYED, which is not the same as games you own.');
  console.log('Remove anything you do not own before saving.\n');

  const flagged = [];
  titles.forEach((t, i) => {
    const why = suspicion(t);
    if (why) flagged.push(i + 1);
    console.log(
      `${String(i + 1).padStart(3)}. ${t.title.padEnd(46).slice(0, 46)} ` +
      `${formatDuration(t.seconds).padStart(12)}${why ? `   <- ${why}` : ''}`,
    );
  });

  if (flagged.length) {
    console.log(`\n${flagged.length} entry(s) flagged above: ${flagged.join(', ')}`);
  }

  const rl = createInterface({ input: stdin, output: stdout });
  const ask = (q) => new Promise((r) => rl.question(q, (a) => r(a.trim())));

  console.log('\nEnter the numbers to REMOVE, separated by spaces or commas.');
  console.log('Ranges work too (e.g. "3 7 12-15"). Press Enter to keep everything.');
  const answer = await ask('Remove: ');

  const remove = new Set();
  for (const part of answer.split(/[\s,]+/).filter(Boolean)) {
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      for (let i = Number(range[1]); i <= Number(range[2]); i++) remove.add(i);
    } else if (/^\d+$/.test(part)) {
      remove.add(Number(part));
    }
  }

  const kept = titles.filter((_, i) => !remove.has(i + 1)).map((t) => t.title);
  rl.close();

  console.log(`\nKeeping ${kept.length} of ${titles.length}.`);

  // Merge rather than replace: a game owned but not played recently has no
  // record here, and must not be dropped for that reason.
  const { load } = await import('../lib/manual.mjs');
  const existing = await load();
  const previous = existing.nintendo ?? [];
  const merged = [...new Set([...previous, ...kept])].sort((a, b) => a.localeCompare(b));
  if (previous.length) {
    console.log(`Merged with ${previous.length} existing entries -> ${merged.length} total.`);
  }

  const payload = { ...existing, nintendo: merged };
  console.log('\nSet this as the MANUAL_LIBRARY secret (one line):\n');
  console.log(JSON.stringify(payload));
  console.log('\nThe data/ directory is gitignored, so the cloud build cannot read');
  console.log('a local file - this secret is how manual entries reach it.');
}
