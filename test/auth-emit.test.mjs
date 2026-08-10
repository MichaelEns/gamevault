/**
 * The auth tools' emit() contract.
 *
 * Every interactive sign-in tool hands its credential back through a file
 * rather than stdout, because stdout has to stay free for prompts. The
 * PowerShell caller then stores it - as one secret, or as several when the
 * file contains a JSON object.
 *
 * This is worth pinning because the failure mode is late and expensive: the
 * user completes a sign-in, and only at the very last step does it fall over,
 * having already spent their time. That happened once, when an object was
 * passed to writeFileSync, which accepts only strings.
 */
import { readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { PATHS } from '../lib/paths.mjs';

const run = promisify(execFile);
let fails = 0;
const ok = (cond, msg) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); fails++; }
  else console.log(`  ok:   ${msg}`);
};

const TOOLS = ['ea-auth.mjs', 'ubisoft-auth.mjs', 'humble-auth.mjs'];

console.log('Every auth tool can emit a credential to a file');
for (const t of TOOLS) {
  const src = await readFile(path.join(PATHS.root, 'tools', t), 'utf8');
  ok(/function emit\(/.test(src), `${t} defines emit()`);
  ok(/--out/.test(src), `${t} accepts --out`);
  // The specific bug: handing an object straight to writeFileSync.
  ok(/typeof value === 'string' \? value : JSON\.stringify\(value\)/.test(src),
     `${t} serialises an object instead of passing it raw`);
}

console.log('\nemit() writes both shapes correctly');
const probe = path.join(tmpdir(), `gv-emit-${process.pid}.mjs`);
const outFile = path.join(tmpdir(), `gv-emit-${process.pid}.txt`);
const { writeFile } = await import('node:fs/promises');

// Uses the same implementation the tools use, extracted from one of them, so
// this cannot drift from what actually ships.
const eaSrc = await readFile(path.join(PATHS.root, 'tools', 'ea-auth.mjs'), 'utf8');
const emitStart = eaSrc.indexOf('function emit(');
// Match the closing brace at column 0, not the first '}' after writeFileSync -
// that one belongs to the `import { writeFileSync }` line further up.
const emitEnd = eaSrc.indexOf('\n}', emitStart) + 2;
const emitFn = eaSrc.slice(emitStart, emitEnd);
ok(emitStart !== -1 && emitFn.includes('writeFileSync'), 'extracted the real emit() from ea-auth.mjs');
ok(emitFn.trimEnd().endsWith('}'), 'and the extraction is a complete function');

try {
  await writeFile(probe,
    `import { writeFileSync } from 'node:fs';\n${emitFn}\n` +
    `emit(process.argv.includes('--object') ? { A: 'a'.repeat(25), B: 'b'.repeat(25) } : 'x'.repeat(30));\n`,
    'utf8');

  await run(process.execPath, [probe, '--out', outFile]);
  ok(existsSync(outFile), 'a string credential is written');
  ok((await readFile(outFile, 'utf8')) === 'x'.repeat(30), 'and written verbatim, not JSON-quoted');

  await rm(outFile, { force: true });
  await run(process.execPath, [probe, '--out', outFile, '--object']);
  const raw = await readFile(outFile, 'utf8');
  ok(raw.startsWith('{'), 'several credentials are written as a JSON object');
  const parsed = JSON.parse(raw);
  ok(parsed.A?.length === 25 && parsed.B?.length === 25, 'both values survive intact');

  console.log('\nWithout --out it writes nothing and does not throw');
  await rm(outFile, { force: true });
  await run(process.execPath, [probe]);
  ok(!existsSync(outFile), 'no file is created when no --out is given');
} finally {
  await rm(probe, { force: true });
  await rm(outFile, { force: true });
}

console.log('');
if (fails) { console.log(`${fails} assertion(s) failed.`); process.exit(1); }
console.log('All auth-emit tests passed.');
