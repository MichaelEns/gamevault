# GameVault

At sale time, two questions matter: **do I already have this?** and **is this
actually a good price?** GameVault answers both in one search, across Steam,
Epic, GOG, itch.io, Ubisoft, Game Pass and EA Play.

```
Hades                    [INCLUDED]   $24.99 @ steam
    Playable at no extra cost via PC Game Pass, Console Game Pass.

Cyberpunk 2077           [INCLUDED]   $17.99 @ steam
    Playable at no extra cost via Console Game Pass.
```

That first line is the whole point: the store is happy to sell you Hades for
$24.99 while it sits in a subscription you already pay for.

## Quick start

### Install on a personal Windows PC

```powershell
# 1. unzip anywhere
# 2. right-click install.ps1  ->  Run with PowerShell
```

`install.ps1` does the whole thing:

- checks Node (and points you at the download if it is missing or too old)
- installs the optional Epic (`legendary`) and Amazon (`nile`) clients
- walks you through each credential — **opening the signup page for you** and
  **validating the key against the live service before saving it**, so a typo
  is caught now rather than three weeks later mid-sale
- signs you in to Epic and Amazon (one browser login each, then they persist)
- generates icons and creates **Desktop + Start Menu shortcuts**
- optionally starts GameVault when you log in

It is safe to re-run: a key that still works is never overwritten, and every
step is skippable.

The shortcut runs `GameVault.vbs`, which starts the server **with no console
window**, waits until it is actually answering, then opens your browser. Click
it twice and you get one server, not two — it reuses a running instance.

### On your iPhone (or any phone)

Once it is deployed somewhere with HTTPS (see [DEPLOY.md](DEPLOY.md)):

1. Open the site in **Safari**
2. Share → **Add to Home Screen**

You get a real app icon, no browser chrome, and the shell is cached so it
opens instantly. Prices and ownership are **never** cached — a stale "on sale"
or "you own this" is worse than no answer — so those always come live.

The layout is built for one-handed use at a store page: 44px touch targets,
safe-area insets for the notch and home indicator, 16px inputs (anything
smaller makes iOS zoom on focus), and it follows your light/dark setting.

⚠️ iOS only offers "Add to Home Screen" over **HTTPS**. Fly.io gives you that
for free; a plain `http://` LAN address will not work.

### Local, without the installer

```powershell
npm start                   # -> http://localhost:8787
```

No password needed: it binds to loopback, so only this machine can reach it.

### Cloud — one instance, reachable from every device

See **[DEPLOY.md](DEPLOY.md)**. Short version:

```powershell
fly launch --no-deploy --copy-config
fly volumes create gamevault_data --size 1
fly secrets set GAMEVAULT_PASSWORD='...' ITAD_API_KEY='...' STEAM_API_KEY='...' STEAM_ID='...'
fly deploy
```

Or `docker compose up -d` behind a reverse proxy.

⚠️ Once it is reachable beyond localhost it **requires a password** — the app
refuses to start on `0.0.0.0` without one, because the alternative is silently
publishing your library and a sync button to the internet. Sessions last 30
days and survive redeploys, so you sign in about once per browser.

### Moving it to another PC

```powershell
npm run package             # -> gamevault-portable.zip on your Desktop
```

The zip deliberately contains **no credentials** — not your `.env`, not login
tokens, not your library. You enter keys once during install, on that machine.

It also excludes `.venv\`, because a Python virtualenv is **not portable**:
`pyvenv.cfg` records an absolute interpreter path and the generated
`legendary.exe` has the venv's own `python.exe` baked into it. Copying one from
another machine yields an exe pointing at a directory that does not exist.
`install.ps1` rebuilds it in about a minute.

Nothing here touches work systems or work credentials — every service
(Steam, Epic, GOG, itch.io, Ubisoft, Amazon, ITAD) is a personal account.

### Requirements on the target PC

- **Node 20+** — required (built-in `fetch`). <https://nodejs.org/>
- **Python 3.9+** — *optional*, only for Epic and Amazon ownership. The
  installer skips them gracefully and everything else still works.

No `npm install`. There are no runtime dependencies; it is plain Node.

## Logging in once, not constantly

| Credential | Stored in | Lifetime |
|---|---|---|
| ITAD / Steam / itch.io keys | `.env` | permanent — paste once, never expires |
| Epic session | legendary's own store (`~/.config/legendary`) | OAuth token, auto-refreshes on use |
| Ubisoft session ticket | `data/sessions.json` | cached and reused until it expires (~2h), then silently renewed |
| Your game library | `data/library.json` | until you click *Sync* again |

So after setup you never log in again in normal use. The Ubisoft password is
only re-sent when the cached ticket actually expires — re-authenticating on
every sync is the behaviour most likely to trip an account-security challenge.

`setup.ps1` restricts `.env` and `data/sessions.json` to your Windows user
only (inheritance off, single ACL entry), since they hold API keys and — if you
enable Ubisoft — an account password in plain text.

Run **`npm run doctor`** any time to see exactly what is configured, what is
missing, and the URL to fix each gap.

## What works without any credentials

| Capability | Needs a key? |
|---|---|
| Steam / GOG search + live prices | no |
| **Game Pass access** (PC, Console) — 522 / 627 titles | no |
| **EA Play access** — 95 titles | no |

Subscription access is a *catalog* question, not an account question: if the
game is in the roster for your tier, you can play it. That is why it needs no
login at all.

## Optional keys, in order of value

**1. IsThereAnyDeal — the single highest-value key.**
Free from <https://isthereanydeal.com/apps/my/>. Without it there is no price
history, so "is it a good deal" degrades to "what percent off is it", which is
a much weaker signal — publishers inflate list prices, and −75% means nothing
if the game hit −85% twice last year. ITAD also supplies Epic, Ubisoft, EA,
Fanatical and ~40 other stores' prices in one call.

**2. Steam ownership.** Free key from <https://steamcommunity.com/dev/apikey>,
plus your 64-bit `STEAM_ID`.
⚠️ Steam → Profile → Edit → Privacy → **Game details must be Public**, or Steam
returns an empty library with no error. GameVault detects this and tells you,
rather than silently reporting that you own nothing.

**3. itch.io ownership.** Key from <https://itch.io/user/settings/api-keys>.
The only store here with a first-class, documented, officially-supported
ownership API. Handles large bundle libraries via pagination.

**4. Epic ownership.** Uses the [legendary](https://github.com/derrod/legendary)
CLI, already installed into `.venv`:
```powershell
.venv\Scripts\legendary auth
```
legendary holds its own OAuth token, so GameVault never sees Epic credentials.

**5. Ubisoft ownership — unofficial, read this first.**
Ubisoft publishes no ownership API, so this drives the private endpoints the
Ubisoft Connect client uses. It needs your **actual account password** in
`.env`, and it **cannot work if 2FA is enabled** — there is no non-interactive
path through 2FA. Most Ubisoft games are also sold on Steam, so Steam ownership
usually covers the same ground. It fails loudly rather than silently.

## Store coverage, honestly

| Store | Prices | Ownership |
|---|---|---|
| Steam | direct API | ✅ API key |
| GOG | direct API | — |
| **Nintendo eShop** | **direct API** | 📝 manual |
| itch.io | via key | ✅ official API |
| Epic | via ITAD | ✅ legendary CLI |
| **Amazon Games / Prime Gaming** | — | ✅ **nile CLI** |
| Ubisoft | via ITAD | ⚠️ unofficial, no 2FA |
| Game Pass / EA Play / Cloud | n/a | ✅ catalog, no auth |
| EA (Origin) | via ITAD | ❌ none |
| **Amazon Luna** | — | ❌ none (see below) |

Five things worth knowing:

- **Epic's storefront GraphQL is behind a Cloudflare bot challenge.** It answers
  a single cold request and then starts returning challenge pages, so it is not
  a dependable price source. Epic prices therefore come through ITAD, and Epic
  *ownership* through legendary. Both are more reliable than scraping Epic.
- **Origin is shut down.** Not deprecated — its own API returns
  `404 — Origin has shut down`. EA ownership has no public path; EA Play
  *access* does, via the Game Pass catalog.
- **Nintendo prices work, ownership does not.** The eShop search and price
  APIs are public and need no key. There is no purchase-history API, and the
  only unofficial route runs through the Switch Online app auth flow, which
  requires a third-party token-minting service — not something to route a
  personal Nintendo account through. eShop ownership is manual.
  *(nsuids are region-specific: an ID from the European search returns
  `not_found` from the US price API, so the US index is used for US pricing.)*
- **Prime Gaming ownership works** via [nile](https://github.com/imLinguin/nile),
  the Amazon equivalent of legendary. It speaks Amazon's real entitlement
  protocol and holds its own OAuth token, so GameVault never sees your Amazon
  credentials. Run `.venv\Scripts\nile auth --login` once.
  **But most Prime offers are delivered as GOG or Epic keys**, so much of your
  Prime library is already covered by those providers — nile adds the Amazon
  Games launcher titles.
- **Amazon Luna has no usable API.** Luna is the cloud-streaming service, and
  it is a genuinely different product from Amazon Games. Its web client calls
  hosts under `*.xcorp.amazon.com`, which are Amazon-internal and do not
  resolve publicly; the one reachable endpoint
  (`proxy-prod.tempo.digital.a2z.com`) is an AWS Coral service that answers
  `<UnknownOperationException/>` without proprietary operation headers. If you
  play something via Luna+, add it under **Manual library**.

## Subscriptions (access)

Access is a *catalog* question, not an account question — if a game is in the
roster for your tier, you can play it — so none of this needs a login.

| Service | Titles | Auto-checked |
|---|---:|---|
| PC Game Pass | 522 | ✅ |
| Console Game Pass | 627 | ✅ |
| Xbox Cloud Gaming | 568 | ✅ |
| EA Play | 95 | ✅ |

⚠️ **Set `SUBSCRIPTIONS` in `.env`.** Tiers differ, and the difference is
expensive. Cyberpunk 2077 is on Console Game Pass and Xbox Cloud Gaming but
**not** PC Game Pass — so telling a PC-only subscriber it is "included" would
make them skip a purchase for a game they cannot launch. Same failure
direction as a false ownership claim.

```
SUBSCRIPTIONS=pc          # PC Game Pass (+ EA Play)
SUBSCRIPTIONS=ultimate    # everything
SUBSCRIPTIONS=console
SUBSCRIPTIONS=none
```

Unset means "assume you have everything", and the UI warns when that
assumption is actually affecting a result. Titles on a tier you do not hold
are still shown — as `Console Game Pass · not your plan` — because it is
useful information, just not a reason to skip buying.

### Services that are *not* auto-checked

| Service | Why not |
|---|---|
| **PlayStation Plus** (Extra/Premium) | store GraphQL only accepts whitelisted persisted queries; no public catalog endpoint |
| **Ubisoft+** | catalog is server-rendered HTML behind bot protection |
| **Apple Arcade / Netflix Games** | mobile-only catalogs; not titles you would buy on a PC sale |
| **Amazon Luna** | no reachable public catalog API |
| **Nintendo Switch Online** | retro library, no public roster endpoint |

If you subscribe to any of these, list the handful of titles you actually care
about under **Manual library** instead.

### Key-reseller subscriptions need nothing

**Humble Choice, Fanatical, Green Man Gaming, Blizzard/Battle.net** deliver
*Steam keys*. Once redeemed, those games appear in your Steam library, so
Steam ownership sync already covers them — nothing extra to configure. ITAD
also prices all of them (plus Microsoft Store), so they show up as buying
options automatically.

## Manual library

For the stores above with no ownership API. Click **Manual library**, paste
one title per line, save. They then behave exactly like API-synced ownership —
same normalisation, same matching, same `owned` verdict that outranks price.

The paste handling is deliberately forgiving (bullets, `1.`, `2)`, blank
lines, comma lists all work) because the realistic input is a copy-paste from
a store page. Duplicates collapse; sequels do not — `Hades` and `Hades II`
stay separate entries.

Also available as `POST /api/manual` with `{store, titles}` if you would
rather script it.

## How the verdict is decided

Ranked, best first. Ownership and subscription access always outrank price:

| Verdict | Meaning |
|---|---|
| `owned` | already in your library — do not buy |
| `included` | free via Game Pass / EA Play |
| `best-ever` | cheaper than it has ever been |
| `matches-low` / `near-low` | at or within 10% of the all-time low |
| `good` | within 25% of the all-time low |
| `meh` | 25–60% above the all-time low |
| `wait` | far above the all-time low — it has been much cheaper |

The historical low dominates deliberately. A worked example from the test
suite: a game at **75% off** ($29.99 down from $119.99) whose all-time low is
$11.99 is scored **`wait`**, not "good" — the headline discount is a trap.

## Correctness

Title matching is the load-bearing part: "do I own it" is only as good as
recognising that Steam's `Hades`, Epic's `Hades` and the Microsoft Store's
`Hades - Windows` are one game — while never collapsing `Hades` into `Hades II`.

It is deliberately conservative, because a false positive tells you that you
own something you do not.

```powershell
npm test              # matcher + deal scoring (30+ assertions)
npm run verify-subs   # check subscription claims against the live roster
npm run probe hades   # hit the real storefronts
```

The suite explicitly pins the dangerous cases: `Hades` ≠ `Hades II`,
`Portal` ≠ `Portal 2`, `Final Fantasy VII` ≠ `Final Fantasy VIII`, and
soundtracks/DLC never count as owning the base game.

## API

| Route | Purpose |
|---|---|
| `GET /api/search?q=hades` | the main query |
| `GET /api/status` | which providers are configured, and why not |
| `POST /api/sync` | refresh owned libraries |
| `GET /api/library` | the merged library |
| `GET /api/manual` | manually-entered ownership |
| `POST /api/manual` | set a store's manual titles (`{store, titles}`) |
| `GET /api/subscriptions` | roster sizes |

## Commands

| Command | Purpose |
|---|---|
| `npm start` | run the app |
| `npm run install-app` | guided install: keys, sign-ins, shortcuts |
| `npm run doctor` | what is configured / missing, and how to fix it |
| `npm run package` | build a credential-free zip for another PC |
| `npm run icons` | regenerate the app icons |
| `npm test` | matcher, deal scoring, auth, manual, subscriptions, Amazon, merge |
| `npm run test:e2e` | auth gate against a real server |
| `npm run probe hades` | hit the real storefronts |
| `npm run epic-auth` / `npm run amazon-auth` | sign in to Epic / Amazon |

## Notes

- Responses are disk-cached with per-type TTLs. This is not a nicety: Steam's
  storefront API cuts you off around 200 requests / 5 minutes.
- One dead storefront degrades that store only; the UI reports which sources
  failed instead of quietly showing partial data as if it were complete.
- Secrets live in `.env`, which is gitignored and ACL-restricted to your user.
- All paths resolve from the project root, not the working directory, so a
  desktop shortcut or scheduled task works the same as running from the folder.
