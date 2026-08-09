# Running GameVault in the cloud

Goal: one instance you reach from both the home PC and the work laptop,
without syncing anything between them.

---

## Before anything else: it is now password-protected

Locally this app needed no login — it listened on `localhost` and only you
could reach it. On a public host, every endpoint is public: your library,
which stores you have linked, and a `/api/sync` button that spends your API
quota.

So the app now **refuses to start** on a non-loopback interface unless
`GAMEVAULT_PASSWORD` (or `GAMEVAULT_PASSWORD_HASH`) is set. That is a hard
failure, not a warning — the failure mode it prevents is silent.

```
Error: Refusing to start: binding to 0.0.0.0 exposes GameVault beyond this
machine, but no password is set.
```

Sessions last 30 days and survive redeploys, so in practice you sign in once
per browser.

Generate a strong password and a pre-hashed form (so the plaintext never sits
in a config file):

```powershell
node -e "const{hashPassword}=await import('./lib/auth.mjs');const p=require('crypto').randomBytes(18).toString('base64url');console.log('PASSWORD:',p);console.log('HASH:',hashPassword(p))" --input-type=module
```

---

## Option A — Fly.io (recommended)

Free-tier friendly, gives you HTTPS and a hostname, scales to zero when idle,
and **builds remotely** — which matters here, because this work network blocks
PyPI and cannot build the Epic-enabled image locally.

```powershell
fly launch --no-deploy --copy-config
fly volumes create gamevault_data --size 1
fly secrets set GAMEVAULT_PASSWORD='<your password>' `
                ITAD_API_KEY='...' `
                STEAM_API_KEY='...' STEAM_ID='...' `
                ITCH_API_KEY='...'
fly deploy
```

Then open `https://<app>.fly.dev` from either machine.

`fly.toml` is already configured: TLS forced, `/data` volume mounted, health
check on `/api/health`, `min_machines_running = 0` so it costs nothing idle
(first request after a sleep takes a few seconds).

## Option B — Docker anywhere (VPS, home server, NAS)

```powershell
# create a .env next to docker-compose.yml with GAMEVAULT_PASSWORD etc.
docker compose up -d
```

Compose deliberately binds to `127.0.0.1:8787`, **not** `0.0.0.0` — put a
reverse proxy in front for TLS rather than exposing the port directly:

- **Caddy** — two lines of config, automatic Let's Encrypt certs
- **Cloudflare Tunnel** — no open inbound ports at all, and you can layer
  Cloudflare Access in front for a second auth factor

## Option C — Tailscale (most private)

Put it on a private mesh; nothing is exposed publicly and no password is
strictly needed. **But** a managed work laptop usually will not let you
install the Tailscale client, which defeats the purpose here. Mentioned for
completeness.

---

## Will the work laptop actually reach it?

Usually yes — it is plain outbound HTTPS to a normal hostname, which is what
corporate proxies allow.

Two things that can bite:

- **Domain-category filtering.** A bare `*.fly.dev` host may be uncategorised
  and blocked. A custom domain you own is far less likely to be.
- **TLS inspection.** Corporate MITM proxies re-sign traffic. Browsers on a
  managed laptop already trust the corporate CA, so the web UI is fine.

Nothing about this touches work systems or work credentials — every service
(Steam, Epic, GOG, itch.io, Ubisoft, ITAD) is a personal account.

---

## Epic in the cloud

`legendary` supports non-interactive auth, so this works headlessly:

```powershell
fly ssh console
/opt/legendary/bin/legendary auth --code <authorization code>
```

Get the code by visiting the Epic login URL that
`legendary auth --disable-webview` prints, then pasting the `authorizationCode`
from the resulting JSON. The token lands in `/data/legendary` (the mounted
volume) and refreshes itself, so it survives redeploys.

If the image was built where PyPI is unreachable, legendary is skipped and the
status page says `legendary not installed` — every other provider still works.
This is deliberate: an optional provider must not fail the whole build.

## Ubisoft in the cloud — don't

Ubisoft needs your **real account password**, and there is no OAuth path. An
environment variable on a rented host is a materially worse place for that
than your own PC, so `docker-compose.yml` deliberately omits it.

If you want Ubisoft coverage, sync it locally and push the result:

```powershell
# on your home PC, with UBISOFT_* set in .env
npm start
# click "Sync library", then copy data/library.json to the cloud volume
```

Most Ubisoft titles are also on Steam, so Steam ownership usually covers it
anyway.

---

## What is stored where

| Data | Location | Survives redeploy |
|---|---|---|
| Session-signing secret | `/data/session-secret` | yes (volume) — otherwise every redeploy logs out every device |
| Your library | `/data/library.json` | yes |
| Cached prices | `/data/cache/` | yes |
| Ubisoft ticket | `/data/sessions.json` | yes |
| Epic OAuth token | `/data/legendary/` | yes |
| API keys | environment / `fly secrets` | yes |

## Security summary

- scrypt password hashing, constant-time comparison
- HMAC-signed session cookies: `HttpOnly`, `SameSite=Lax`, `Secure` behind TLS
- Login throttled to 8 attempts per IP per 15 minutes
- Container runs as a non-root user
- Startup refuses to expose the app without a password
- `/api/health` is the only public route (cloud platforms probe it before a
  session exists); it reveals only liveness

Verified end-to-end against a running server and a running container:
unauthenticated requests to `/api/status`, `/api/library`, `/api/search` and
`/api/sync` all return 401, and forged or expired cookies are rejected.
