/**
 * Writing GitHub Actions secrets from a browser.
 *
 * Why this is possible at all: api.github.com sends
 * Access-Control-Allow-Origin: *, including on the Actions secrets endpoints.
 * That is the opposite of Steam, GOG and IsThereAnyDeal, which is why the
 * library data has to come from a scheduled build but the *configuration*
 * does not.
 *
 * Why there is no "Sign in with GitHub" button: github.com/login/device/code
 * and /login/oauth/access_token send no CORS headers at all, so neither the
 * device flow nor the OAuth code flow can run in a page. Probed directly --
 * both return no Access-Control-Allow-Origin. A token is the only route.
 *
 * The value must be sealed with libsodium's crypto_box_seal against the
 * repository's public key. WebCrypto cannot do this: sealed box needs
 * XSalsa20-Poly1305 and BLAKE2b, neither of which it implements. Hence
 * tweetnacl (X25519 + XSalsa20-Poly1305) and blakejs.
 */

const API = 'https://api.github.com';

function api(token, path, opts = {}) {
  return fetch(`${API}${path}`, {
    ...opts,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      Authorization: `Bearer ${token}`,
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.headers ?? {}),
    },
  });
}

const b64decode = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64encode = (b) => btoa(String.fromCharCode(...b));

/**
 * crypto_box_seal.
 *
 * seal(m, pk) = epk || box(m, nonce, pk, esk)
 *   where nonce = blake2b(epk || pk, 24)
 *
 * The ephemeral key is what makes it anonymous: the recipient can decrypt
 * without knowing who sent it, which is exactly GitHub's model.
 */
export function sealSecret(value, publicKeyBase64, { nacl, blake2b }) {
  const messageBytes = new TextEncoder().encode(value);
  const publicKey = b64decode(publicKeyBase64);
  if (publicKey.length !== 32) {
    throw new Error(`Repository public key is ${publicKey.length} bytes, expected 32`);
  }

  const ephemeral = nacl.box.keyPair();

  const nonceInput = new Uint8Array(64);
  nonceInput.set(ephemeral.publicKey, 0);
  nonceInput.set(publicKey, 32);
  const nonce = blake2b(nonceInput, undefined, 24);

  const boxed = nacl.box(messageBytes, nonce, publicKey, ephemeral.secretKey);

  const sealed = new Uint8Array(ephemeral.publicKey.length + boxed.length);
  sealed.set(ephemeral.publicKey, 0);
  sealed.set(boxed, ephemeral.publicKey.length);
  return b64encode(sealed);
}

/** The repo's current public key, needed before anything can be sealed. */
export async function getPublicKey(token, repo) {
  const res = await api(token, `/repos/${repo}/actions/secrets/public-key`);
  if (!res.ok) throw new Error(await describe(res, repo));
  return res.json();
}

/** Create or update one Actions secret. */
export async function putSecret(token, repo, name, value, deps) {
  if (!/^[A-Z_][A-Z0-9_]*$/i.test(name)) {
    throw new Error(`"${name}" is not a valid secret name`);
  }
  const key = await getPublicKey(token, repo);
  const res = await api(token, `/repos/${repo}/actions/secrets/${encodeURIComponent(name)}`, {
    method: 'PUT',
    body: JSON.stringify({
      encrypted_value: sealSecret(value, key.key, deps),
      key_id: key.key_id,
    }),
  });
  // 201 = created, 204 = updated.
  if (res.status !== 201 && res.status !== 204) throw new Error(await describe(res, repo));
  return res.status === 201 ? 'created' : 'updated';
}

/** Create or update a (non-secret) Actions variable, e.g. SUBSCRIPTIONS. */
export async function putVariable(token, repo, name, value) {
  const existing = await api(token, `/repos/${repo}/actions/variables/${encodeURIComponent(name)}`);
  const res = existing.ok
    ? await api(token, `/repos/${repo}/actions/variables/${encodeURIComponent(name)}`,
                { method: 'PATCH', body: JSON.stringify({ name, value }) })
    : await api(token, `/repos/${repo}/actions/variables`,
                { method: 'POST', body: JSON.stringify({ name, value }) });
  if (!res.ok && res.status !== 204) throw new Error(await describe(res, repo));
  return existing.ok ? 'updated' : 'created';
}

/** Names only -- GitHub never returns secret values, not even to the owner. */
export async function listSecretNames(token, repo) {
  const res = await api(token, `/repos/${repo}/actions/secrets?per_page=100`);
  if (!res.ok) throw new Error(await describe(res, repo));
  const data = await res.json();
  return (data.secrets ?? []).map((s) => s.name);
}

/** Kick off a rebuild so a newly added key takes effect immediately. */
export async function runWorkflow(token, repo, workflow = 'snapshot.yml', ref = 'main') {
  const res = await api(token, `/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
    method: 'POST',
    body: JSON.stringify({ ref }),
  });
  if (res.status !== 204) throw new Error(await describe(res, repo));
  return true;
}

/**
 * GitHub's failures here are easy to misread, so translate them.
 * A 404 in particular does NOT mean "wrong URL" -- it is what GitHub returns
 * instead of 403 when the token cannot see the resource.
 */
async function describe(res, repo) {
  let detail = '';
  try { detail = (await res.json()).message ?? ''; } catch { /* not JSON */ }

  if (res.status === 401) {
    return 'Token rejected (401). It may be expired, revoked, or mistyped.';
  }
  if (res.status === 403) {
    const scopes = res.headers.get('x-accepted-github-permissions');
    return `Token lacks permission (403).${scopes ? ` Needs: ${scopes}.` : ''} ` +
           'A fine-grained token needs "Secrets: Read and write" on this repository.';
  }
  if (res.status === 404) {
    return `Not found (404) for ${repo}. GitHub returns 404 rather than 403 when a ` +
           'token cannot see a repository, so this usually means the token is not ' +
           'scoped to this repository, or belongs to a different account.';
  }
  return `GitHub returned ${res.status}${detail ? `: ${detail}` : ''}`;
}
