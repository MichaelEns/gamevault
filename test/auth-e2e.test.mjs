/**
 * End-to-end auth test against a REAL running server.
 *
 * The unit tests cover the crypto; this proves the HTTP gate actually
 * wires it up -- that an unauthenticated request cannot reach your
 * library, and that a valid session can.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8911;
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'test-password-do-not-reuse';

let fails = 0;
const ok = (cond, msg) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); fails++; }
  else console.log(`  ok:   ${msg}`);
};

const child = spawn(process.execPath, ['server.mjs'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '0.0.0.0',
    GAMEVAULT_PASSWORD: PASSWORD,
    GAMEVAULT_DATA_DIR: path.join(ROOT, 'data', 'e2e-test'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', () => {});
child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

// wait for readiness
let up = false;
for (let i = 0; i < 40; i++) {
  try {
    const r = await fetch(`${BASE}/api/health`);
    if (r.ok) { up = true; break; }
  } catch { /* not yet */ }
  await sleep(250);
}

try {
  ok(up, 'server started on 0.0.0.0 with a password set');

  const health = await (await fetch(`${BASE}/api/health`)).json();
  ok(health.authRequired === true, 'health reports authRequired=true');

  console.log('\nUnauthenticated access must be refused');
  for (const route of ['/api/status', '/api/library', '/api/search?q=hades', '/api/subscriptions']) {
    const r = await fetch(`${BASE}${route}`, { redirect: 'manual' });
    ok(r.status === 401, `${route} -> 401`);
  }
  const sync = await fetch(`${BASE}/api/sync`, { method: 'POST', redirect: 'manual' });
  ok(sync.status === 401, 'POST /api/sync -> 401 (cannot burn your API quota)');

  const rootRes = await fetch(`${BASE}/`, { redirect: 'manual' });
  ok(rootRes.status === 200, 'GET / serves the login page while logged out');
  const html = await rootRes.text();
  ok(html.includes('Sign in'), 'login page rendered');

  console.log('\nWrong password');
  const bad = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'wrong' }),
  });
  ok(bad.status === 401, 'wrong password -> 401');
  ok(!(bad.headers.get('set-cookie') ?? '').includes('gv_session='), 'no session cookie issued on failure');

  console.log('\nCorrect password');
  const good = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  ok(good.status === 200, 'correct password -> 200');
  const setCookie = good.headers.get('set-cookie') ?? '';
  ok(setCookie.includes('gv_session='), 'session cookie issued');
  ok(setCookie.includes('HttpOnly'), 'cookie is HttpOnly (not readable by scripts)');
  ok(setCookie.includes('SameSite=Lax'), 'cookie is SameSite=Lax (CSRF mitigation)');

  const cookie = setCookie.split(';')[0];

  console.log('\nAuthenticated access');
  const status = await fetch(`${BASE}/api/status`, { headers: { Cookie: cookie } });
  ok(status.status === 200, '/api/status with cookie -> 200');

  console.log('\nForged cookies must not work');
  for (const forged of ['gv_session=garbage', 'gv_session=9999999999999.deadbeef', 'gv_session=']) {
    const r = await fetch(`${BASE}/api/status`, { headers: { Cookie: forged }, redirect: 'manual' });
    ok(r.status === 401, `forged "${forged.slice(0, 30)}" -> 401`);
  }

  console.log('\nLogout');
  const out = await fetch(`${BASE}/api/logout`, { headers: { Cookie: cookie } });
  ok((out.headers.get('set-cookie') ?? '').includes('Max-Age=0'), 'logout clears the cookie');
} finally {
  child.kill();
}

console.log('');
if (fails) { console.log(`${fails} assertion(s) failed.`); process.exit(1); }
console.log('All auth end-to-end tests passed.');
