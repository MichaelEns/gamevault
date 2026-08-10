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

# Deliberately NOT 'Stop'.
#
# Under 'Stop', ANY native command that writes to stderr raises a terminating
# NativeCommandError - even when it succeeded. pip does this routinely for its
# "a new release of pip is available" notice, which killed this script at the
# very first store. Errors that actually matter are checked explicitly below,
# via exit codes and by testing for the files each step is supposed to produce.
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

function Head($t) { Write-Host "`n$t" -ForegroundColor Cyan; Write-Host ('-' * $t.Length) -ForegroundColor DarkGray }
function Good($t) { Write-Host "  [ok]   $t" -ForegroundColor Green }
function Warn($t) { Write-Host "  [warn] $t" -ForegroundColor Yellow }
function Info($t) { Write-Host "  $t" -ForegroundColor Gray }
function Bad ($t) { Write-Host "  [fail] $t" -ForegroundColor Red }

# Records what worked, so the end of a long run says something useful rather
# than leaving you to scroll back through it.
$script:Results = [ordered]@{}
function Record($name, $state, $detail = '') { $script:Results[$name] = @{ state = $state; detail = $detail } }

<#
.SYNOPSIS
  Run a native command without its stderr being treated as failure.
.DESCRIPTION
  Returns $true when the command exits 0. Output is captured and returned via
  -OutVariable-style reference so a caller can inspect it when it matters.
#>
function Invoke-Native {
    param(
        [Parameter(Mandatory)][string] $Exe,
        [string[]] $Arguments = @(),
        [switch] $Show,
        [ref] $Output
    )
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $captured = & $Exe @Arguments 2>&1
        if ($Output) { $Output.Value = $captured }
        if ($Show) { $captured | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray } }
        return ($LASTEXITCODE -eq 0)
    } catch {
        if ($Output) { $Output.Value = $_.Exception.Message }
        return $false
    } finally {
        $ErrorActionPreference = $prev
    }
}

<#
.SYNOPSIS
  Run one setup step in isolation.
.DESCRIPTION
  A failure in one store must never prevent the others from being attempted.
  Previously an error in the very first step ended the whole run, which is the
  worst possible behaviour for a script whose entire purpose is to get through
  several independent sign-ins in one sitting.
#>
function Step {
    param([string] $Name, [scriptblock] $Body)
    try {
        & $Body
    } catch {
        Bad "$Name failed: $($_.Exception.Message)"
        Info 'Continuing with the remaining stores.'
        Record $Name 'failed' $_.Exception.Message
    }
}

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
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $Value | gh secret set $Name --repo $Repo 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { Good "$Name saved to GitHub"; return $true }
        Bad "$Name could not be saved (gh exit $LASTEXITCODE)"
        return $false
    } finally { $ErrorActionPreference = $prev }
}

# Store clients write their token to different places depending on version and
# platform, so look rather than assume - a missing config is otherwise reported
# as "sign-in did not complete" when in fact it did.
function Find-ClientConfig {
    param([string] $Client)
    foreach ($c in @(
        (Join-Path $env:USERPROFILE ".config\$Client\user.json"),
        (Join-Path $env:LOCALAPPDATA "$Client\user.json"),
        (Join-Path $env:APPDATA "$Client\user.json"),
        (Join-Path $env:LOCALAPPDATA "$Client\$Client\user.json")
    )) { if (Test-Path $c) { return $c } }
    return $null
}

# Ensures the Python virtualenv the Epic and Amazon clients live in.
function Get-VenvPip {
    $pip = Join-Path $root '.venv\Scripts\pip.exe'
    if (Test-Path $pip) { return $pip }
    if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
        Warn 'Python is not installed, so Epic and Prime Gaming must be skipped.'
        Info 'Install it from https://python.org (tick "Add to PATH"), then re-run.'
        return $null
    }
    Info 'Creating a Python virtualenv for the store clients...'
    Invoke-Native 'python' @('-m', 'venv', (Join-Path $root '.venv')) | Out-Null
    if (Test-Path $pip) { return $pip }
    Warn 'Could not create the virtualenv.'
    return $null
}

# --- node dependencies -----------------------------------------------------
Head 'Installing project dependencies'
Push-Location $root
try {
    if (Invoke-Native 'npm' @('install', '--no-audit', '--no-fund')) {
        Good 'npm packages installed'
    } else {
        Warn 'npm install reported a problem; continuing anyway'
    }
} finally { Pop-Location }

# --- Epic ------------------------------------------------------------------
if (& $want 'epic') {
    Head 'Epic Games'
    Step 'Epic' {
        if ((Have 'LEGENDARY_CONFIG') -and -not $Only) {
            Info 'Already configured - skipping. Use -Only epic to redo it.'
            Record 'Epic' 'skipped' 'already configured'
            return
        }
        $venvPip = Get-VenvPip
        if (-not $venvPip) { Record 'Epic' 'skipped' 'no Python'; return }

        Info 'Installing legendary (the Epic client)...'
        Invoke-Native $venvPip @('install', '--quiet', 'legendary-gl') | Out-Null

        $legendary = Join-Path $root '.venv\Scripts\legendary.exe'
        if (-not (Test-Path $legendary)) {
            Warn 'legendary could not be installed - check network access to PyPI.'
            Record 'Epic' 'failed' 'legendary install'
            return
        }

        Info 'A browser window will open. Sign in to Epic, then paste the code shown.'
        & $legendary auth

        $cfg = Find-ClientConfig 'legendary'
        if (-not $cfg) {
            Warn 'legendary wrote no user.json - the sign-in did not complete.'
            Record 'Epic' 'failed' 'no token written'
            return
        }
        $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($cfg))
        if (Set-Secret 'LEGENDARY_CONFIG' $b64) { Record 'Epic' 'done' } else { Record 'Epic' 'failed' 'secret not saved' }
    }
}

# --- Amazon Prime Gaming ---------------------------------------------------
if (& $want 'amazon') {
    Head 'Amazon Prime Gaming'
    Step 'Prime Gaming' {
        if ((Have 'NILE_CONFIG') -and -not $Only) {
            Info 'Already configured - skipping. Use -Only amazon to redo it.'
            Record 'Prime Gaming' 'skipped' 'already configured'
            return
        }
        $venvPip = Get-VenvPip
        if (-not $venvPip) { Record 'Prime Gaming' 'skipped' 'no Python'; return }

        # nile cannot be pip-installed from its git URL: the repo has a flat
        # layout where assets/ is discovered as a package alongside nile, and
        # setuptools refuses the ambiguity. This helper applies the fix. It is
        # NOT a Windows-only problem - it fails identically on Linux.
        Info 'Installing nile (the Amazon client)...'
        Invoke-Native 'powershell' @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass',
            '-File', (Join-Path $root 'tools\Install-Nile.ps1'),
            '-PipPath', $venvPip, '-Quiet'
        ) | Out-Null

        $nile = Join-Path $root '.venv\Scripts\nile.exe'
        if (-not (Test-Path $nile)) {
            Warn 'nile could not be installed - it needs git and PyPI access.'
            Record 'Prime Gaming' 'failed' 'nile install'
            return
        }

        Info 'A browser window will open. Sign in to Amazon.'
        & $nile auth --login

        $cfg = Find-ClientConfig 'nile'
        if (-not $cfg) {
            Warn 'nile wrote no user.json - the sign-in did not complete.'
            Record 'Prime Gaming' 'failed' 'no token written'
            return
        }
        $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($cfg))
        if (Set-Secret 'NILE_CONFIG' $b64) { Record 'Prime Gaming' 'done' } else { Record 'Prime Gaming' 'failed' 'secret not saved' }
    }
}

<#
.SYNOPSIS
  Run an interactive auth tool and capture the credential it prints.
.DESCRIPTION
  Each tool ends by printing a heading and then the value on its own line.
  Scraping stdout is unavoidable here because the tools are interactive, but
  the value is validated before use: too short, or containing whitespace, means
  the heading was matched but the value was not, and saving that would store
  a broken secret that fails silently at the next build.
#>
function Invoke-AuthTool {
    param(
        [Parameter(Mandatory)][string] $Script,
        [Parameter(Mandatory)][string] $Marker,
        [Parameter(Mandatory)][string] $SecretName
    )
    Push-Location $root
    try {
        $prev = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        # Not redirected: these tools prompt, so the user must see them live.
        $out = & node $Script 2>&1 | Tee-Object -Variable shown
        $ErrorActionPreference = $prev

        $lines = @($out | ForEach-Object { $_.ToString() })
        $idx = -1
        for ($i = 0; $i -lt $lines.Count; $i++) {
            if ($lines[$i] -match [regex]::Escape($Marker)) { $idx = $i; break }
        }
        if ($idx -lt 0) { Warn 'The sign-in did not complete.'; return $null }

        $value = $null
        for ($i = $idx + 1; $i -lt $lines.Count; $i++) {
            $candidate = $lines[$i].Trim()
            if ($candidate) { $value = $candidate; break }
        }
        if (-not $value -or $value.Length -lt 20 -or $value -match '\s') {
            Warn "Could not read a usable $SecretName from the output."
            return $null
        }
        return $value
    } finally { Pop-Location }
}

# --- Ubisoft ---------------------------------------------------------------
if (& $want 'ubisoft') {
    Head 'Ubisoft Connect'
    Step 'Ubisoft' {
        if ((Have 'UBISOFT_REMEMBER_TICKET') -and -not $Only) {
            Info 'Already configured - skipping. Use -Only ubisoft to redo it.'
            Record 'Ubisoft' 'skipped' 'already configured'
            return
        }
        Info 'You will be asked for your password and a 2FA code.'
        Info 'The password is used once here and never stored.'

        $ticket = Invoke-AuthTool 'tools/ubisoft-auth.mjs' 'UBISOFT_REMEMBER_TICKET secret' 'ticket'
        if (-not $ticket) { Record 'Ubisoft' 'failed' 'no ticket'; return }

        if (Set-Secret 'UBISOFT_REMEMBER_TICKET' $ticket) {
            Record 'Ubisoft' 'done'
            # The password is now redundant, and a revocable ticket is strictly
            # better than a stored account password.
            if (Have 'UBISOFT_PASSWORD') {
                Invoke-Native 'gh' @('secret', 'delete', 'UBISOFT_PASSWORD', '--repo', $Repo) | Out-Null
                Invoke-Native 'gh' @('secret', 'delete', 'UBISOFT_EMAIL', '--repo', $Repo) | Out-Null
                Good 'Removed UBISOFT_EMAIL / UBISOFT_PASSWORD - the ticket replaces them'
            }
        } else { Record 'Ubisoft' 'failed' 'secret not saved' }
    }
}

# --- EA --------------------------------------------------------------------
if (& $want 'ea') {
    Head 'EA (formerly Origin)'
    Step 'EA' {
        if ((Have 'EA_REMID') -and -not $Only) {
            Info 'Already configured - skipping. Use -Only ea to redo it.'
            Record 'EA' 'skipped' 'already configured'
            return
        }
        Info 'Origin shut down, but its libraries moved to the EA app on the same account.'
        Info 'You will be asked for the remid cookie from a signed-in browser.'

        $remid = Invoke-AuthTool 'tools/ea-auth.mjs' 'EA_REMID secret' 'cookie'
        if (-not $remid) { Record 'EA' 'failed' 'no cookie'; return }
        if (Set-Secret 'EA_REMID' $remid) { Record 'EA' 'done' } else { Record 'EA' 'failed' 'secret not saved' }
    }
}

# --- Humble Bundle ---------------------------------------------------------
if (& $want 'humble') {
    Head 'Humble Bundle'
    Step 'Humble' {
        if ((Have 'HUMBLE_SESSION') -and -not $Only) {
            Info 'Already configured - skipping. Use -Only humble to redo it.'
            Record 'Humble' 'skipped' 'already configured'
            return
        }
        Info 'Redeemed Steam keys are already covered by the Steam sync.'
        Info 'The point of this is UNREDEEMED keys: games you bought that appear'
        Info 'in no library at all, which is exactly when you would rebuy them.'
        Info 'You will be asked for the _simpleauth_sess cookie from a signed-in browser.'

        $sess = Invoke-AuthTool 'tools/humble-auth.mjs' 'HUMBLE_SESSION secret' 'cookie'
        if (-not $sess) { Record 'Humble' 'failed' 'no cookie'; return }
        if (Set-Secret 'HUMBLE_SESSION' $sess) { Record 'Humble' 'done' } else { Record 'Humble' 'failed' 'secret not saved' }
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
    Record 'Nintendo' 'manual' 'see instructions above'
}

# --- summary ---------------------------------------------------------------
Head 'Summary'
if ($script:Results.Count) {
    foreach ($k in $script:Results.Keys) {
        $r = $script:Results[$k]
        switch ($r.state) {
            'done'    { Good  "$k connected" }
            'skipped' { Info  "$k - $($r.detail)" }
            'manual'  { Info  "$k - $($r.detail)" }
            default   { Warn  "$k - $($r.detail)" }
        }
    }
} else { Info 'Nothing attempted.' }

$failed = @($script:Results.Values | Where-Object { $_.state -eq 'failed' })
if ($failed.Count) {
    Info ''
    Info 'Re-run just the ones that failed, for example:'
    Info '  .\finish-setup.ps1 -Only ubisoft,ea'
}

# --- rebuild ---------------------------------------------------------------
$connected = @($script:Results.Values | Where-Object { $_.state -eq 'done' })
if (-not $NoRebuild -and $connected.Count) {
    Head 'Rebuilding your snapshot'
    if (Invoke-Native 'gh' @('workflow', 'run', 'snapshot.yml', '--repo', $Repo, '--ref', 'main')) {
        Good 'Rebuild started'
        Info "Watch it: gh run watch --repo $Repo"
    } else {
        Warn 'Could not start a rebuild - trigger it from the Actions tab.'
    }
} elseif (-not $NoRebuild) {
    Info ''
    Info 'Nothing new was connected, so no rebuild was started.'
}

Head 'Done'
Info 'Open https://michaelens.github.io/gamevault/ and press Refresh.'
Info 'The Sources panel shows what each store contributed.'
