<#
.SYNOPSIS
  Finishes GameVault setup: signs in to the stores that need a browser, and
  pushes the resulting credentials straight into GitHub Actions secrets.

.DESCRIPTION
  Four stores cannot be authenticated by the cloud build, each for its own
  reason, and all four need a machine you can log in from:

    Epic          no public library API; borrows a real client's login
    Prime Gaming  same, via nile
    Ubisoft       2FA cannot be cleared by a scheduled build
    EA            login has bot protection; needs a browser cookie
    Nintendo      no purchase API at all; play records need pruning by hand

  This is safe to re-run. It checks what is already configured and only asks
  for what is missing, so a failure part-way through costs you nothing.

  Nothing is written to disk except the store clients' own token files, and
  no credential is echoed. Values go straight to GitHub via `gh secret set`.

.EXAMPLE
  .\finish-setup.ps1

.EXAMPLE
  .\finish-setup.ps1 -Only ubisoft,ea
#>
[CmdletBinding()]
param(
    [ValidateSet('epic', 'amazon', 'ubisoft', 'ea', 'humble', 'nintendo')]
    [string[]] $Only,

    [string] $Repo = 'MichaelEns/gamevault',

    # Skip the final rebuild.
    [switch] $NoRebuild
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

function Head($t) { Write-Host "`n$t" -ForegroundColor Cyan; Write-Host ('-' * $t.Length) -ForegroundColor DarkGray }
function Good($t) { Write-Host "  [ok]   $t" -ForegroundColor Green }
function Warn($t) { Write-Host "  [warn] $t" -ForegroundColor Yellow }
function Info($t) { Write-Host "  $t" -ForegroundColor Gray }
function Bad ($t) { Write-Host "  [fail] $t" -ForegroundColor Red }

$want = { param($n) (-not $Only) -or ($Only -contains $n) }

# --- prerequisites ---------------------------------------------------------
Head 'Checking prerequisites'

foreach ($cmd in @('node', 'git', 'gh')) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        Bad "$cmd is not installed or not on PATH."
        switch ($cmd) {
            'node' { Info 'Install from https://nodejs.org (LTS is fine).' }
            'git'  { Info 'Install from https://git-scm.com/download/win' }
            'gh'   { Info 'Install from https://cli.github.com' }
        }
        exit 1
    }
}
Good 'node, git and gh are present'

# gh must be signed in as the account that owns the repo. Being *listed* is not
# enough - the wrong account can be the active one, which is the failure that
# looks like a broken link, since GitHub returns 404 rather than 403 for a repo
# your token cannot see. So the access probe is the authority here, not the
# account list.
$owner = $Repo.Split('/')[0]
$known = @()
try {
    $known = (gh auth status 2>&1 | Select-String -Pattern 'Logged in to github.com account (\S+)').Matches |
             ForEach-Object { $_.Groups[1].Value }
} catch { }

function Test-RepoAccess { 
    $null = gh api "repos/$Repo" --jq '.full_name' 2>&1
    return $LASTEXITCODE -eq 0
}

if (-not (Test-RepoAccess)) {
    if ($known -contains $owner) {
        Warn "Signed in, but $owner is not the active account. Switching."
        gh auth switch --user $owner 2>&1 | Out-Null
    }
    if (-not (Test-RepoAccess)) {
        Warn "Cannot reach $Repo. Signing in."
        gh auth login
    }
}

if (-not (Test-RepoAccess)) {
    Bad "Still cannot read $Repo."
    Info 'GitHub returns 404 rather than 403 when a token cannot see a repo,'
    Info "so this usually means the active account is not $owner. Try:"
    Info "  gh auth switch --user $owner"
    exit 1
}
Good "GitHub access to $Repo confirmed"

# --- what is already done? -------------------------------------------------
Head 'Checking what is already configured'

$existing = @{}
try {
    (gh secret list --repo $Repo --json name --jq '.[].name' 2>$null) | ForEach-Object { $existing[$_] = $true }
} catch { }

function Have($name) { return $existing.ContainsKey($name) }

foreach ($s in @('STEAM_API_KEY', 'STEAM_ID', 'ITAD_API_KEY', 'ITCH_API_KEY',
                 'LEGENDARY_CONFIG', 'NILE_CONFIG', 'UBISOFT_REMEMBER_TICKET',
                 'EA_REMID', 'HUMBLE_SESSION', 'MANUAL_LIBRARY')) {
    if (Have $s) { Good "$s is set" } else { Info "$s is not set" }
}

function Set-Secret {
    param([string] $Name, [string] $Value)
    if (-not $Value) { Warn "$Name - nothing to save"; return $false }
    $Value | gh secret set $Name --repo $Repo 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { Good "$Name saved to GitHub"; return $true }
    Bad "$Name could not be saved"
    return $false
}

# --- node dependencies -----------------------------------------------------
Head 'Installing project dependencies'
Push-Location $root
try {
    npm install --no-audit --no-fund 2>&1 | Select-Object -Last 1 | Out-Null
    Good 'npm packages installed'
} catch {
    Warn "npm install reported a problem: $($_.Exception.Message)"
} finally { Pop-Location }

# --- Epic ------------------------------------------------------------------
if (& $want 'epic') {
    Head 'Epic Games'
    if ((Have 'LEGENDARY_CONFIG') -and -not $Only) {
        Info 'Already configured - skipping. Use -Only epic to redo it.'
    } else {
        $venvPip = Join-Path $root '.venv\Scripts\pip.exe'
        if (-not (Test-Path $venvPip)) {
            Info 'Creating a Python virtualenv for the store clients...'
            python -m venv (Join-Path $root '.venv') 2>&1 | Out-Null
        }
        if (Test-Path $venvPip) {
            & $venvPip install --quiet legendary-gl 2>&1 | Out-Null
            $legendary = Join-Path $root '.venv\Scripts\legendary.exe'
            if (Test-Path $legendary) {
                Info 'A browser window will open. Sign in to Epic, then paste the code shown.'
                & $legendary auth
                $cfg = Join-Path $env:USERPROFILE '.config\legendary\user.json'
                if (-not (Test-Path $cfg)) { $cfg = Join-Path $env:LOCALAPPDATA 'legendary\user.json' }
                if (Test-Path $cfg) {
                    $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($cfg))
                    Set-Secret 'LEGENDARY_CONFIG' $b64 | Out-Null
                } else { Warn 'legendary did not write a user.json - sign-in may not have completed' }
            } else { Warn 'legendary could not be installed' }
        } else { Warn 'Python is required for Epic and Prime Gaming (https://python.org)' }
    }
}

# --- Amazon Prime Gaming ---------------------------------------------------
if (& $want 'amazon') {
    Head 'Amazon Prime Gaming'
    if ((Have 'NILE_CONFIG') -and -not $Only) {
        Info 'Already configured - skipping. Use -Only amazon to redo it.'
    } else {
        $venvPip = Join-Path $root '.venv\Scripts\pip.exe'
        if (Test-Path $venvPip) {
            # nile cannot be pip-installed from git directly: its repo has a
            # flat layout where assets/ is mistaken for a package. This helper
            # applies the fix. It is NOT a Windows-only problem.
            & powershell -NoProfile -ExecutionPolicy Bypass `
                -File (Join-Path $root 'tools\Install-Nile.ps1') -PipPath $venvPip -Quiet
            $nile = Join-Path $root '.venv\Scripts\nile.exe'
            if (Test-Path $nile) {
                Info 'A browser window will open. Sign in to Amazon.'
                & $nile auth --login
                $cfg = Join-Path $env:USERPROFILE '.config\nile\user.json'
                if (-not (Test-Path $cfg)) { $cfg = Join-Path $env:LOCALAPPDATA 'nile\user.json' }
                if (Test-Path $cfg) {
                    $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($cfg))
                    Set-Secret 'NILE_CONFIG' $b64 | Out-Null
                } else { Warn 'nile did not write a user.json - sign-in may not have completed' }
            } else { Warn 'nile could not be installed' }
        }
    }
}

# --- Ubisoft ---------------------------------------------------------------
if (& $want 'ubisoft') {
    Head 'Ubisoft Connect'
    if ((Have 'UBISOFT_REMEMBER_TICKET') -and -not $Only) {
        Info 'Already configured - skipping. Use -Only ubisoft to redo it.'
    } else {
        Info 'You will be asked for your password and a 2FA code.'
        Info 'The password is used once here and never stored.'
        Push-Location $root
        try {
            $out = & node tools/ubisoft-auth.mjs 2>&1
            $out | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
            # The tool prints the ticket on its own line after a known heading.
            $idx = ($out | Select-String -Pattern 'UBISOFT_REMEMBER_TICKET secret').LineNumber
            if ($idx) {
                $ticket = ($out[$idx..($out.Count - 1)] | Where-Object { $_ -match '\S' } | Select-Object -First 1).ToString().Trim()
                if ($ticket -and $ticket.Length -gt 20) {
                    if (Set-Secret 'UBISOFT_REMEMBER_TICKET' $ticket) {
                        # The password is now redundant, and a stored password
                        # is worse than a revocable ticket.
                        if (Have 'UBISOFT_PASSWORD') {
                            gh secret delete UBISOFT_PASSWORD --repo $Repo 2>&1 | Out-Null
                            gh secret delete UBISOFT_EMAIL --repo $Repo 2>&1 | Out-Null
                            Good 'Removed UBISOFT_EMAIL / UBISOFT_PASSWORD - the ticket replaces them'
                        }
                    }
                } else { Warn 'Could not read the ticket from the output' }
            }
        } finally { Pop-Location }
    }
}

# --- EA --------------------------------------------------------------------
if (& $want 'ea') {
    Head 'EA (formerly Origin)'
    if ((Have 'EA_REMID') -and -not $Only) {
        Info 'Already configured - skipping. Use -Only ea to redo it.'
    } else {
        Info 'Origin shut down, but its libraries moved to the EA app on the same account.'
        Info 'You will be asked for the `remid` cookie from a signed-in browser.'
        Push-Location $root
        try {
            $out = & node tools/ea-auth.mjs 2>&1
            $out | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
            $idx = ($out | Select-String -Pattern 'EA_REMID secret').LineNumber
            if ($idx) {
                $remid = ($out[$idx..($out.Count - 1)] | Where-Object { $_ -match '\S' } | Select-Object -First 1).ToString().Trim()
                if ($remid -and $remid.Length -gt 20) { Set-Secret 'EA_REMID' $remid | Out-Null }
                else { Warn 'Could not read the cookie from the output' }
            }
        } finally { Pop-Location }
    }
}

# --- Humble Bundle ---------------------------------------------------------
if (& $want 'humble') {
    Head 'Humble Bundle'
    if ((Have 'HUMBLE_SESSION') -and -not $Only) {
        Info 'Already configured - skipping. Use -Only humble to redo it.'
    } else {
        Info 'Redeemed Steam keys are already covered by the Steam sync.'
        Info 'The point of this is UNREDEEMED keys: games you bought that appear'
        Info 'in no library at all, which is exactly when you would rebuy them.'
        Info 'You will be asked for the _simpleauth_sess cookie from a signed-in browser.'
        Push-Location $root
        try {
            $out = & node tools/humble-auth.mjs 2>&1
            $out | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
            $idx = ($out | Select-String -Pattern 'HUMBLE_SESSION secret').LineNumber
            if ($idx) {
                $sess = ($out[$idx..($out.Count - 1)] | Where-Object { $_ -match '\S' } | Select-Object -First 1).ToString().Trim()
                if ($sess -and $sess.Length -gt 20) { Set-Secret 'HUMBLE_SESSION' $sess | Out-Null }
                else { Warn 'Could not read the cookie from the output' }
            }
        } finally { Pop-Location }
    }
}

# --- Nintendo --------------------------------------------------------------
if (& $want 'nintendo') {
    Head 'Nintendo'
    Info 'Nintendo publishes no purchase API. The closest signal is play time,'
    Info 'from the Parental Controls app - which includes demos, borrowed'
    Info 'cartridges and the NSO classics library, so the list needs pruning.'
    Info ''
    Info 'Run these yourself when you have a few minutes:'
    Info '  npm install --global nxapi'
    Info '  nxapi pctl auth'
    Info '  nxapi pctl dump-summaries ./nintendo-data'
    Info '  npm run nintendo-import ./nintendo-data'
    Info ''
    Info 'That prints a MANUAL_LIBRARY value; save it with:'
    Info "  gh secret set MANUAL_LIBRARY --repo $Repo"
}

# --- rebuild ---------------------------------------------------------------
if (-not $NoRebuild) {
    Head 'Rebuilding your snapshot'
    gh workflow run snapshot.yml --repo $Repo --ref main 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Good 'Rebuild started'
        Info "Watch it: gh run watch --repo $Repo"
        Info 'Then press Refresh in the app.'
    } else {
        Warn 'Could not start a rebuild - trigger it from the Actions tab.'
    }
}

Head 'Done'
Info 'Open https://michaelens.github.io/gamevault/ and press Refresh.'
Info 'The Sources panel shows what each store contributed.'
