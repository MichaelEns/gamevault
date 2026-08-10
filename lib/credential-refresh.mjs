/**
 * Persist a rotated credential the moment it is issued.
 *
 * Several providers here retire a credential the instant it is used: Ubisoft,
 * GOG and Epic all hand back a replacement and refuse the old one afterwards.
 * That makes the window between "received a new token" and "stored the new
 * token" a genuine race, not a theoretical one.
 *
 * Writing at the end of the build left that window about five minutes wide.
 * Builds queue rather than run in parallel, but the queue does not eliminate
 * the overlap - observed runs started 24 seconds before their predecessor
 * finished - and a build that starts in that window reads the secret as it was
 * BEFORE the write, uses a token the previous build already spent, and fails.
 *
 * Writing immediately shrinks the window to the length of one API call. It
 * cannot be closed entirely without locking, which GitHub Actions has no
 * primitive for, so the residual case is handled where it surfaces: a 401 on a
 * rotating credential says plainly that a concurrent build may have consumed
 * it, rather than blaming the credential.
 */
let putSecretFn = null;
let cryptoDeps = null;

async function ensureDeps() {
  if (putSecretFn && cryptoDeps) return true;
  try {
    const [{ putSecret }, nacl, blakejs] = await Promise.all([
      import('./github-secrets.mjs'),
      import('tweetnacl').then((m) => m.default ?? m),
      import('blakejs'),
    ]);
    putSecretFn = putSecret;
    cryptoDeps = { nacl, blake2b: blakejs.blake2b };
    return true;
  } catch (e) {
    console.log(`::error::Cannot seal secrets (${e.message}). Rotating credentials will not survive.`);
    return false;
  }
}

/**
 * Store a rotated credential now.
 *
 * Best-effort by design: failing to persist must not abandon a snapshot that
 * is otherwise fine. But it is reported loudly, because the visible symptom
 * otherwise arrives a build later and points nowhere near the cause.
 */
export async function persistRotated(env, name, value) {
  if (!value || value === env[name]) return false;
  if (!env.GAMEVAULT_SECRETS_TOKEN || !env.GITHUB_REPOSITORY) {
    console.log(`::warning::${name} rotated but GAMEVAULT_SECRETS_TOKEN is not set, ` +
                'so it cannot be saved. This provider will fail on the next build.');
    return false;
  }
  if (!(await ensureDeps())) return false;

  try {
    await putSecretFn(env.GAMEVAULT_SECRETS_TOKEN, env.GITHUB_REPOSITORY, name, value, cryptoDeps);
    // Update the in-process copy too, so anything later in this same build
    // uses the new value rather than the one it started with.
    env[name] = value;
    console.log(`  ${name} refreshed immediately (the provider rotated it).`);
    return true;
  } catch (e) {
    console.log(`::error::Could not save rotated ${name}: ${e.message}`);
    if (/401|403|404/.test(e.message)) {
      console.log('  GAMEVAULT_SECRETS_TOKEN needs "Secrets: Read and write" on this repository.');
    }
    return false;
  }
}
