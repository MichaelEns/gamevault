import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * All paths resolve from the project root, derived from this module's own
 * location -- never from process.cwd().
 *
 * Using cwd meant the app only worked when launched from inside the project
 * directory. A desktop shortcut, a scheduled task, or `node C:\...\server.mjs`
 * from anywhere else would silently write its cache and library to whatever
 * directory happened to be current, and would fail to find legendary.
 */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Data lives beside the code by default, but in a container it belongs on a
 * mounted volume so a redeploy does not wipe your library, cached prices,
 * stored sessions, or the session-signing secret (which would log every
 * device out).
 */
const DATA = process.env.GAMEVAULT_DATA_DIR
  ? path.resolve(process.env.GAMEVAULT_DATA_DIR)
  : path.join(ROOT, 'data');

export const PATHS = {
  root: ROOT,
  env: path.join(ROOT, '.env'),
  envExample: path.join(ROOT, '.env.example'),
  data: DATA,
  cache: path.join(DATA, 'cache'),
  library: path.join(DATA, 'library.json'),
  sessions: path.join(DATA, 'sessions.json'),
  public: path.join(ROOT, 'public'),
  venvWin: path.join(ROOT, '.venv', 'Scripts', 'legendary.exe'),
  venvNix: path.join(ROOT, '.venv', 'bin', 'legendary'),
};
