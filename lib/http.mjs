const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Strip credentials out of a URL before it can appear in a message.
 *
 * Both Steam and IsThereAnyDeal take their API key as a query parameter, so
 * any error carrying a raw URL carries the key with it. Those errors are not
 * transient: they are stored in the snapshot as stores[].error and rendered in
 * the app. Redacting here rather than at each call site means a new provider
 * cannot reintroduce the leak by forgetting.
 *
 * GitHub masks registered secrets in workflow logs, which covered this in CI,
 * but that protection does not extend to the snapshot or the UI.
 */
const SECRET_PARAMS = /^(key|api_key|apikey|token|access_token|auth|password|secret|sig|signature)$/i;

export function redactUrl(url) {
  try {
    const u = new URL(url);
    let redacted = false;
    for (const name of [...u.searchParams.keys()]) {
      if (SECRET_PARAMS.test(name)) { u.searchParams.set(name, 'REDACTED'); redacted = true; }
    }
    if (u.username || u.password) { u.username = ''; u.password = ''; redacted = true; }
    return redacted ? u.toString() : url;
  } catch {
    // Not a parseable URL; strip anything that looks like a key=value pair
    // rather than returning it untouched.
    return String(url).replace(/\b(key|api_key|apikey|token|password|secret)=[^&\s]+/gi, '$1=REDACTED');
  }
}

export class HttpError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status} for ${redactUrl(url)}`);
    this.status = status;
    this.url = redactUrl(url);
    this.body = body;
  }
}

/**
 * fetch with a timeout and bounded retry.
 *
 * Retries only on 429/5xx and network faults. A 4xx other than 429 is a
 * real answer (bad key, unknown appid) and retrying it just wastes the
 * rate-limit budget we are trying to protect.
 */
export async function req(url, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 20000,
    retries = 2,
    json = true,
  } = opts;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: { 'User-Agent': UA, ...headers },
        body,
        signal: ac.signal,
      });
      const text = await res.text();

      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        if (retryable && attempt < retries) {
          await sleep(600 * (attempt + 1) ** 2);
          continue;
        }
        throw new HttpError(res.status, url, text.slice(0, 400));
      }
      if (!json) return text;
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`Non-JSON response from ${redactUrl(url)}: ${text.slice(0, 160)}`);
      }
    } catch (e) {
      lastErr = e;
      if (e instanceof HttpError) throw e;
      if (attempt < retries) {
        await sleep(600 * (attempt + 1) ** 2);
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run tasks with bounded concurrency, preserving input order. */
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        out[idx] = await fn(items[idx], idx);
      } catch (e) {
        out[idx] = { __error: e.message };
      }
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Never let one dead storefront sink the whole query. Returns a
 * discriminated result so the UI can say "Epic is down" instead of
 * quietly showing incomplete data as if it were complete.
 */
export async function settle(name, promise) {
  try {
    return { store: name, ok: true, data: await promise };
  } catch (e) {
    return { store: name, ok: false, error: e.message ?? String(e) };
  }
}
