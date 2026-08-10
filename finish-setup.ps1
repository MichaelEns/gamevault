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
Get-BrokenProviders

$existing = @{}
try {
    (gh secret list --repo $Repo --json name --jq '.[].name' 2>$null) | ForEach-Object { $existing[$_] = $true }
} catch { }

function Have($name) { return $existing.ContainsKey($name) }

<#
.SYNOPSIS
  Which providers actually produced data in the most recent build.
.DESCRIPTION
  A secret existing is not the same as a secret working, and treating them as
  equivalent is what let a broken Ubisoft ticket sit behind "Already
  configured - skipping" indefinitely. The build log is the only place that
  records whether a credential actually did anything.
#>
$script:BrokenProviders = @{}
function Get-BrokenProviders {
    $runId = $null
    $out = $null
    if (Invoke-Native 'gh' @('run', 'list', '--repo', $Repo, '--workflow', 'snapshot.yml',
                             '--limit', '1', '--json', 'databaseId',
                             '--jq', '.[0].databaseId') -Output ([ref]$out)) {
        $runId = ($out | Select-Object -Last 1)
    }
    if (-not $runId) { return }
    $log = $null
    if (-not (Invoke-Native 'gh' @('run', 'view', "$runId", '--repo', $Repo, '--log') -Output ([ref]$log))) { return }
    foreach ($line in $log) {
        $m = [regex]::Match([string]$line, '^\s*(\w+)\s+FAILED:\s*(.+)$')
        if ($m.Success) {
            $script:BrokenProviders[$m.Groups[1].Value.ToLower()] = $m.Groups[2].Value.Trim()
        }
    }
}

# True when the credential exists AND the last build got data from it.
function Working($secretName, $provider) {
    if (-not (Have $secretName)) { return $false }
    return -not $script:BrokenProviders.ContainsKey($provider.ToLower())
}

foreach ($s in @('STEAM_API_KEY', 'STEAM_ID', 'ITAD_API_KEY', 'ITCH_API_KEY',
                 'LEGENDARY_CONFIG', 'NILE_CONFIG', 'UBISOFT_REMEMBER_TICKET',
                 'EA_REMID', 'HUMBLE_SESSION', 'MANUAL_LIBRARY')) {
    if (-not (Have $s)) { Info "$s is not set"; continue }
    $prov = @{ 'LEGENDARY_CONFIG'='epic'; 'NILE_CONFIG'='amazon'; 'UBISOFT_REMEMBER_TICKET'='ubisoft';
                'EA_REMID'='ea'; 'HUMBLE_SESSION'='humble'; 'STEAM_API_KEY'='steam'; 'ITCH_API_KEY'='itch' }[$s]
    if ($prov -and $script:BrokenProviders.ContainsKey($prov)) {
        Warn "$s is set but the last build FAILED: $($script:BrokenProviders[$prov])"
    } else { Good "$s is set" }
}

function Set-Secret {
    param([string] $Name, [string] $Value)
    if (-not $Value) { Warn "$Name - nothing to save"; return $false }
    # Trailing whitespace in a secret is not cosmetic. A credential used as an
    # HTTP header with a stray CR makes undici reject the request before it is
    # sent, which surfaced once as an unexplained "fetch failed".
    $Value = $Value.Trim()
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $Value | gh secret set $Name --repo $Repo 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { Good "$Name saved to GitHub"; return $true }
        Bad "$Name could not be saved (gh exit $LASTEXITCODE)"
        return $false
    } finally { $ErrorActionPreference = $prev }
}

# Saves whatever an auth tool returned: one value, or several named ones.
function Save-AuthResult {
    param($Result, [string] $DefaultName)
    if (-not $Result) { return $false }
    if ($Result -is [string]) { return (Set-Secret $DefaultName $Result) }
    $allOk = $true
    foreach ($p in $Result.PSObject.Properties) {
        if (-not (Set-Secret $p.Name ([string]$p.Value))) { $allOk = $false }
    }
    return $allOk
}

# Store clients write their token to different places depending on version and
# platform, so look rather than assume - a missing config is otherwise reported
# as "sign-in did not complete" when in fact it did.
# Store clients do not keep a single, stably-named credential file.
#
# nile migrated user.json to user.enc (AES, with the key derived from the
# Amazon account id held in a separate plaintext file), so copying one file
# captures either the ciphertext or the key but never both. legendary spreads
# state across several files too, and both use platformdirs, whose layout
# varies by platform and version.
#
# Archiving the whole configuration directory sidesteps all of that: whatever
# the client wrote, in whatever files, comes along.
function Get-ClientConfigDir {
    param([string] $Client)

    # Ask the client itself where it keeps things, rather than guessing.
    if ($Client -eq 'nile') {
        $py = Join-Path $root '.venv\Scripts\python.exe'
        if (Test-Path $py) {
            $out = $null
            if (Invoke-Native $py @('-c', 'from nile.constants import CONFIG_PATH; print(CONFIG_PATH)') -Output ([ref]$out)) {
                $p = ($out | Select-Object -Last 1).ToString().Trim()
                if ($p -and (Test-Path $p)) { return $p }
            }
        }
    }

    foreach ($c in @(
        (Join-Path $env:USERPROFILE ".config\$Client"),
        (Join-Path $env:APPDATA $Client),
        (Join-Path $env:LOCALAPPDATA $Client),
        (Join-Path $env:LOCALAPPDATA "$Client\$Client")
    )) {
        # A directory that exists but holds no credential is not a hit: nile
        # creates its folder for the SDK before any sign-in happens.
        if (Test-Path $c) {
            $hasCreds = Get-ChildItem $c -File -ErrorAction SilentlyContinue |
                        Where-Object { $_.Name -match '^(user|users|current_user)\.(json|enc)$' -or $_.Name -eq 'user.json' }
            if ($hasCreds) { return $c }
        }
    }
    return $null
}

# Packs a client's configuration directory into one base64 blob for a secret.
function Get-ConfigArchive {
    param([string] $Dir)
    $zip = Join-Path ([System.IO.Path]::GetTempPath()) ("gv-cfg-" + [guid]::NewGuid().ToString('N') + '.zip')
    try {
        # Exclude bulk that is not credentials: nile ships ~3MB of SDK DLLs and
        # legendary caches manifests, neither of which belongs in a secret.
        $staging = Join-Path ([System.IO.Path]::GetTempPath()) ("gv-stage-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $staging -Force | Out-Null
        Get-ChildItem $Dir -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Length -lt 512KB } |
            ForEach-Object { Copy-Item $_.FullName $staging -Force -ErrorAction SilentlyContinue }
        if (-not (Get-ChildItem $staging -File)) { return $null }
        Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zip -Force
        return [Convert]::ToBase64String([IO.File]::ReadAllBytes($zip))
    } finally {
        Remove-Item $zip -Force -ErrorAction SilentlyContinue
        Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
    }
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
        if ((Working 'LEGENDARY_CONFIG' 'epic') -and -not $Only) {
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

        $dir = Get-ClientConfigDir 'legendary'
        if (-not $dir) {
            Warn 'legendary stored no credentials - the sign-in did not complete.'
            Record 'Epic' 'failed' 'no token written'
            return
        }
        Info "Found legendary config at $dir"
        $b64 = Get-ConfigArchive $dir
        if (-not $b64) { Warn 'Nothing to archive.'; Record 'Epic' 'failed' 'empty config'; return }
        if (Set-Secret 'LEGENDARY_CONFIG' $b64) { Record 'Epic' 'done' } else { Record 'Epic' 'failed' 'secret not saved' }
    }
}

# --- Amazon Prime Gaming ---------------------------------------------------
if (& $want 'amazon') {
    Head 'Amazon Prime Gaming'
    Step 'Prime Gaming' {
        if ((Working 'NILE_CONFIG' 'amazon') -and -not $Only) {
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

        $dir = Get-ClientConfigDir 'nile'
        if (-not $dir) {
            Warn 'nile stored no credentials - the sign-in did not complete.'
            Record 'Prime Gaming' 'failed' 'no token written'
            return
        }
        Info "Found nile config at $dir"
        $b64 = Get-ConfigArchive $dir
        if (-not $b64) { Warn 'Nothing to archive.'; Record 'Prime Gaming' 'failed' 'empty config'; return }
        if (Set-Secret 'NILE_CONFIG' $b64) { Record 'Prime Gaming' 'done' } else { Record 'Prime Gaming' 'failed' 'secret not saved' }
    }
}

<#
.SYNOPSIS
  Run an interactive auth tool and collect the credential it produces.
.DESCRIPTION
  The tool's output is NOT piped or captured. Piping it - even through
  Tee-Object - buffers the stream, so the tool's prompts never reach the
  screen and the script looks frozen while it silently waits for input that
  the user has no way to know is expected.

  The credential therefore comes back through a file rather than by scraping
  stdout, which is also sturdier: no marker matching, no blank-line hunting,
  and no risk of storing a heading as if it were a secret.
#>
function Invoke-AuthTool {
    param(
        [Parameter(Mandatory)][string] $Script,
        [Parameter(Mandatory)][string] $SecretName
    )
    $outFile = Join-Path ([System.IO.Path]::GetTempPath()) ("gv-" + [guid]::NewGuid().ToString('N') + '.txt')
    Push-Location $root
    try {
        # Start-Process -NoNewWindow hands node the REAL console.
        #
        # Neither `& node ...` nor a pipe works here. The caller assigns this
        # function's result ($x = Invoke-AuthTool ...), and assignment captures
        # everything the function writes to the success stream - which includes
        # anything a native command inside it prints. So the prompt was being
        # swallowed into the return value rather than shown, and the script sat
        # waiting for input the user could not see. Removing the earlier pipe
        # fixed only half of that.
        #
        # With the child owning the console, its prompts appear immediately,
        # its input works, and nothing it prints can leak into the result.
        $proc = Start-Process -FilePath 'node' `
                              -ArgumentList (@($Script, '--out', $outFile)) `
                              -NoNewWindow -Wait -PassThru
        if ($proc.ExitCode -ne 0) {
            Warn "The sign-in tool exited with code $($proc.ExitCode)."
            return $null
        }
        if (-not (Test-Path $outFile)) {
            Warn "The sign-in did not complete, so no $SecretName was produced."
            return $null
        }
        $value = (Get-Content $outFile -Raw).Trim()
        if (-not $value) {
            Warn "The sign-in produced no $SecretName."
            return $null
        }
        # A tool may return several secrets as a JSON object (EA needs both
        # remid and sid; storing one without the other reproduces the very
        # failure the pair was meant to fix).
        if ($value.StartsWith('{')) {
            try { return ($value | ConvertFrom-Json) } catch { /* fall through */ }
        }
        if ($value.Length -lt 20) {
            Warn "The $SecretName looked wrong (too short), so it was not saved."
            return $null
        }
        return $value
    } finally {
        Remove-Item $outFile -Force -ErrorAction SilentlyContinue
        Pop-Location
    }
}

# --- Ubisoft ---------------------------------------------------------------
if (& $want 'ubisoft') {
    Head 'Ubisoft Connect'
    Step 'Ubisoft' {
        if ((Working 'UBISOFT_REMEMBER_TICKET' 'ubisoft') -and -not $Only) {
            Info 'Already configured - skipping. Use -Only ubisoft to redo it.'
            Record 'Ubisoft' 'skipped' 'already configured'
            return
        }
        Info 'You will be asked for your password and a 2FA code.'
        Info 'The password is used once here and never stored.'

        $ticket = Invoke-AuthTool 'tools/ubisoft-auth.mjs' 'ticket'
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
        if ((Working 'EA_REMID' 'ea') -and -not $Only) {
            Info 'Already configured - skipping. Use -Only ea to redo it.'
            Record 'EA' 'skipped' 'already configured'
            return
        }
        Info 'Origin shut down, but its libraries moved to the EA app on the same account.'
        Info 'You will be asked for the remid cookie from a signed-in browser.'

        $remid = Invoke-AuthTool 'tools/ea-auth.mjs' 'cookie'
        if (-not $remid) { Record 'EA' 'failed' 'no cookie'; return }
        if (Save-AuthResult $remid 'EA_REMID') { Record 'EA' 'done' } else { Record 'EA' 'failed' 'secret not saved' }
    }
}

# --- Humble Bundle ---------------------------------------------------------
if (& $want 'humble') {
    Head 'Humble Bundle'
    Step 'Humble' {
        if ((Working 'HUMBLE_SESSION' 'humble') -and -not $Only) {
            Info 'Already configured - skipping. Use -Only humble to redo it.'
            Record 'Humble' 'skipped' 'already configured'
            return
        }
        Info 'Redeemed Steam keys are already covered by the Steam sync.'
        Info 'The point of this is UNREDEEMED keys: games you bought that appear'
        Info 'in no library at all, which is exactly when you would rebuy them.'
        Info 'You will be asked for the _simpleauth_sess cookie from a signed-in browser.'

        $sess = Invoke-AuthTool 'tools/humble-auth.mjs' 'cookie'
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
