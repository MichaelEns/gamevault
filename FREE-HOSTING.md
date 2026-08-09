# Free hosting: GitHub Actions + Pages

The phone reads one encrypted file. No server, no card, no new accounts.

---

## Why this design

A pure static site cannot do the job directly. I tested every API from a
browser origin:

| API | CORS |
|---|---|
| Steam storesearch / appdetails | **blocked** (no `Access-Control-Allow-Origin`) |
| GOG catalog | **blocked** (`ACAO: https://www.gog.com`) |
| Game Pass sigls | **blocked** |
| IsThereAnyDeal | **blocked** |
| Microsoft displaycatalog | allowed |
| Nintendo Algolia | allowed |

So the browser can reach two of six. On top of that, an API key in
client-side JavaScript is readable by anyone who opens devtools.

The fix: do the work where secrets are safe (GitHub Actions), publish the
result as a static file, and let the phone read it.

---

## The economics — how is this actually free?

Nothing here is a trial or a loss-leader.

**GitHub Actions is free without limit on public repositories.** Private
repos get 2,000 minutes/month. A snapshot build takes ~30 seconds, so four
builds a day is ~1 hour/month — inside the *private* allowance, and free
outright on a public one. GitHub does this because public CI is how open
source works, and it doubles as the funnel for paid private-repo seats.

**GitHub Pages is free static hosting** — global CDN, TLS certificate,
custom domains. It costs GitHub close to nothing: static bytes from a CDN
edge are among the cheapest things on the internet, and it makes GitHub the
default home for project sites.

**Why the paid options cost money and this does not:** Fly.io, Render and
friends rent you a *running process* — a machine sitting there consuming
RAM whether or not anyone visits. That has a continuous cost, hence the
card on file. This design has no running process. GitHub runs a container
for 30 seconds, four times a day, then destroys it. Between builds, the
only thing serving you is a CDN handing out a 51 KB file.

The honest trade: **compute time for freshness.** You are not getting a free
server; you are getting no server. Prices are as fresh as the last build
rather than live. Ownership and subscription data barely move, so that half
loses nothing.

Free ceilings, for reference:

| Resource | Limit | Your usage |
|---|---|---|
| Actions (public repo) | unlimited | ~2 min/day |
| Actions (private repo) | 2,000 min/month | ~60 min/month |
| Pages bandwidth | 100 GB/month soft | a few MB/month |
| Pages site size | 1 GB | ~80 KB |

You are using well under 1% of anything.

---

## Setup

### 1. Create the repo

A **public** repo, because free Pages only publishes from public repos.
That is why the snapshot is encrypted — see below.

```powershell
gh repo create gamevault --public --source . --push
```

### 2. Pick a passphrase and add the secrets

```powershell
# something long; you will type it once per device
gh secret set SNAPSHOT_PASSPHRASE

gh secret set ITAD_API_KEY        # historical lows
gh secret set STEAM_API_KEY
gh secret set STEAM_ID
gh secret set ITCH_API_KEY        # optional
```

Which Game Pass tier you actually pay for is a *variable*, not a secret:

```powershell
gh variable set SUBSCRIPTIONS --body "pc"     # or ultimate / console / eaplay / none
gh variable set COUNTRY --body "US"
```

### 3. Epic and Amazon ownership (optional)

Those CLIs need a browser login, which CI cannot do — so log in **locally**
once, then upload the resulting token.

```powershell
.\.venv\Scripts\legendary auth
.\.venv\Scripts\nile auth --login

# upload the tokens
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$env:USERPROFILE\.config\legendary\user.json")) | gh secret set LEGENDARY_CONFIG
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$env:USERPROFILE\.config\nile\user.json")) | gh secret set NILE_CONFIG
```

Skip this and everything else still works — the build degrades per provider.

### 4. Enable Pages

Repo → Settings → Pages → Source: **GitHub Actions**.

### 5. Run it

Actions → *Build snapshot and publish* → **Run workflow**.

Your site lands at `https://<user>.github.io/gamevault/`.

### 6. Install on the iPhone

Safari → Share → **Add to Home Screen**. Enter the passphrase once.

---

## Encryption

The repo is public, so the snapshot is encrypted:

- **AES-256-GCM**, key derived by **PBKDF2-SHA256 at 600,000 iterations**
  (OWASP's current floor)
- fresh random salt and IV per build — the same passphrase never produces
  the same ciphertext twice
- GCM's auth tag means a tampered file fails loudly instead of decrypting
  to garbage

Implemented against `globalThis.crypto.subtle` — the *same* WebCrypto API in
Node 22 and in Safari — so the encrypt path in CI and the decrypt path on
your phone run identical code. Using `node:crypto` would have meant two
implementations that could silently drift, and the failure mode is "your
snapshot is permanently unreadable".

`snapshot-meta.json` is deliberately **not** encrypted. It holds only the
build time and three counts, so the app can show freshness before you
unlock. Verified to leak no titles.

The workflow **hard-fails** if `SNAPSHOT_PASSPHRASE` is unset, rather than
quietly publishing your library in the clear.

---

## What is in a snapshot

| Contents | Freshness |
|---|---|
| Ownership index (every store) | changes only when you buy something |
| Game Pass / EA Play / Cloud rosters | monthly-ish churn |
| Prices + all-time lows | **the volatile part** |
| Pre-computed deal verdicts | as above |

Priced titles = everything you own, plus `watchlist.txt`. Add anything you
are waiting to buy so the verdict is ready when a sale hits.

Every price in the UI is labelled with its age; anything over 12 hours is
flagged. A confidently-wrong stale price is worse than an obviously old one.

## When it updates

1. **Every 6 hours** (cron)
2. **Manually** — `workflow_dispatch`, which you can trigger **from the
   GitHub mobile app** while standing in a sale
3. **On push** when `watchlist.txt` changes

Cron on public repos is best-effort and can be delayed under load, and
GitHub disables schedules after 60 days of repo inactivity. The manual
trigger covers both.
