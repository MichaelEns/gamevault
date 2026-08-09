import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { PATHS } from './paths.mjs';
import { isAddon } from './match.mjs';

const execFileAsync = promisify(execFile);

/**
 * Amazon Games / Prime Gaming ownership, via the `nile` CLI.
 *
 * nile (https://github.com/imLinguin/nile, GPL-3.0) is the Amazon equivalent
 * of legendary: it speaks Amazon's real entitlement protocol
 * (AnimusEntitlementsService.GetEntitlements on sds.amazon.com) and holds its
 * own OAuth token, so GameVault never sees your Amazon credentials.
 *
 * Why a CLI rather than talking to Amazon directly: the entitlements service
 * is an AWS Coral endpoint that requires request signing, a device
 * registration handshake and protobuf payloads. Reimplementing that would be
 * fragile and would duplicate a maintained project for no benefit.
 *
 * NOT the same thing as Amazon Luna. Luna is the cloud-streaming service and
 * its catalog APIs resolve only on Amazon-internal hosts (*.xcorp.amazon.com),
 * so it has no usable public surface -- see README.
 */

/** Locate nile: explicit override, project venv, then PATH. */
function nilePath() {
  if (process.env.GAMEVAULT_NILE_BIN) return process.env.GAMEVAULT_NILE_BIN;
  const venvWin = path.join(PATHS.root, '.venv', 'Scripts', 'nile.exe');
  if (existsSync(venvWin)) return venvWin;
  const venvNix = path.join(PATHS.root, '.venv', 'bin', 'nile');
  if (existsSync(venvNix)) return venvNix;
  return 'nile';
}

/** Is nile present, and is it logged in? */
export async function authStatus() {
  const bin = nilePath();
  try {
    const { stdout } = await execFileAsync(bin, ['auth', '--status'], {
      timeout: 30000,
      windowsHide: true,
    });
    // nile prints: {"Username": "...", "LoggedIn": true}
    const line = (stdout || '').trim().split('\n').find((l) => l.trim().startsWith('{'));
    if (!line) return { installed: true, loggedIn: false, account: null };
    const parsed = JSON.parse(line);
    const loggedIn = parsed?.LoggedIn === true;
    return {
      installed: true,
      loggedIn,
      account: loggedIn ? (parsed.Username ?? null) : null,
    };
  } catch (e) {
    if (e.code === 'ENOENT') return { installed: false, loggedIn: false, account: null };
    return {
      installed: true,
      loggedIn: false,
      account: null,
      error: (e.stderr || e.message || '').slice(0, 300),
    };
  }
}

/**
 * Owned Amazon Games titles.
 *
 * `library sync` refreshes from Amazon; `library list --json` prints the
 * cached entitlements. Sync is best-effort so a network blip still returns
 * the last known library rather than nothing.
 */
export async function ownedGames() {
  const bin = nilePath();
  const status = await authStatus();

  if (!status.installed) {
    throw new Error(
      'nile is not installed. Run setup.ps1, or: ' +
      'pip install git+https://github.com/imLinguin/nile.git',
    );
  }
  if (!status.loggedIn) {
    throw new Error('nile is not logged in. Run: .venv\\Scripts\\nile auth --login');
  }

  try {
    await execFileAsync(bin, ['library', 'sync'], {
      timeout: 180000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
  } catch {
    // Fall through to the cached list rather than failing the whole sync.
  }

  const { stdout } = await execFileAsync(bin, ['library', 'list', '--json'], {
    timeout: 60000,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });

  return parseLibrary(stdout);
}

/**
 * Parse `nile library list --json`.
 * Exported so the shape can be tested without Amazon credentials.
 */
export function parseLibrary(stdout) {
  const line = (stdout || '').trim().split('\n').find((l) => l.trim().startsWith('['));
  if (!line) return [];

  let games;
  try {
    games = JSON.parse(line);
  } catch {
    return [];
  }
  if (!Array.isArray(games)) return [];

  return games
    .map((g) => {
      // nile entries are entitlements: { product: { id, title, ... } }
      const product = g?.product ?? g ?? {};
      const title = product.title ?? g?.title ?? null;
      if (!title) return null;
      return {
        store: 'amazon',
        id: String(product.id ?? g?.id ?? ''),
        title: String(title),
        url: null,
      };
    })
    .filter(Boolean)
    .filter((g) => !isAddon(g.title));
}
