<#
.SYNOPSIS
  One-time GameVault setup for a fresh Windows PC.

.DESCRIPTION
  Safe to re-run: it never overwrites an existing .env, and it rebuilds the
  Python venv only when legendary is missing or broken.

  The venv MUST be built on this machine. Python venvs are not relocatable --
  pyvenv.cfg records an absolute interpreter path, and the generated
  legendary.exe launcher has the venv's own python.exe baked into it. Copying
  a .venv from another PC produces an exe that silently points at a path that
  does not exist here.
#>
[CmdletBinding()]
param(
  [switch]$SkipEpic,      # skip the Python/legendary step entirely
  [switch]$NonInteractive # do not prompt for keys
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

function Say  ($m) { Write-Host $m -ForegroundColor Cyan }
function Good ($m) { Write-Host "  [ok]   $m" -ForegroundColor Green }
function Warn ($m) { Write-Host "  [warn] $m" -ForegroundColor Yellow }
function Bad  ($m) { Write-Host "  [X]    $m" -ForegroundColor Red }

Write-Host ''
Say '=== GameVault setup ==='
Write-Host ''

# --- 1. Node ---------------------------------------------------------------
Say '1. Node.js'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Bad 'Node.js not found. Install Node 20 or newer: https://nodejs.org/'
  Bad 'GameVault cannot run without it. Re-run this script afterwards.'
  exit 1
}
$nodeVer = (& node --version).TrimStart('v')
$major = [int]($nodeVer -split '\.')[0]
if ($major -lt 20) {
  Bad "Node $nodeVer is too old (need 20+, for built-in fetch). Upgrade: https://nodejs.org/"
  exit 1
}
Good "node $nodeVer at $($node.Source)"

# --- 2. Data directories ---------------------------------------------------
Say '2. Data directories'
foreach ($d in 'data', 'data\cache') {
  if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
}
Good 'data\ and data\cache\ ready'

# --- 3. .env ---------------------------------------------------------------
Say '3. Credentials file (.env)'
if (Test-Path '.env') {
  Good '.env already exists -- leaving it untouched'
} else {
  Copy-Item '.env.example' '.env'
  Good 'created .env from .env.example'
}

# Lock .env and the session store down to this user only. It holds API keys
# and (if you enable Ubisoft) an account password in plain text.
foreach ($secret in '.env', 'data\sessions.json') {
  if (Test-Path $secret) {
    try {
      $acl = Get-Acl $secret
      $acl.SetAccessRuleProtection($true, $false)   # drop inherited rules
      $acl.Access | ForEach-Object { [void]$acl.RemoveAccessRule($_) }
      $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        "$env:USERDOMAIN\$env:USERNAME", 'FullControl', 'Allow')
      $acl.SetAccessRule($rule)
      Set-Acl -Path $secret -AclObject $acl
      Good "$secret locked to $env:USERNAME only"
    } catch {
      Warn "could not tighten permissions on ${secret}: $($_.Exception.Message)"
    }
  }
}

# --- 4. Epic / legendary ---------------------------------------------------
Say '4. Epic + Amazon ownership (optional, via the legendary and nile CLIs)'
if ($SkipEpic) {
  Warn 'skipped by request (-SkipEpic)'
} else {
  $py = Get-Command python -ErrorAction SilentlyContinue
  if (-not $py) { $py = Get-Command py -ErrorAction SilentlyContinue }

  if (-not $py) {
    Warn 'Python not found -- skipping Epic and Amazon ownership.'
    Warn 'Everything else still works. To add them later: install Python 3.9+'
    Warn 'from https://python.org, then re-run this script.'
  } else {
    $legendary = Join-Path $root '.venv\Scripts\legendary.exe'
    $needBuild = $true

    if (Test-Path $legendary) {
      try {
        & $legendary --version *> $null
        if ($LASTEXITCODE -eq 0) { $needBuild = $false }
      } catch { $needBuild = $true }
      if ($needBuild) {
        Warn 'existing .venv is broken (likely copied from another machine) -- rebuilding'
        Remove-Item -Recurse -Force (Join-Path $root '.venv') -ErrorAction SilentlyContinue
      }
    }

    if ($needBuild) {
      Say '   creating virtual environment...'
      & $py.Source -m venv .venv
      if ($LASTEXITCODE -ne 0) { Bad 'venv creation failed'; exit 1 }
      Say '   installing legendary (Epic)...'
      & .\.venv\Scripts\python.exe -m pip install --quiet --upgrade pip
      & .\.venv\Scripts\pip.exe install --quiet legendary-gl
      if ($LASTEXITCODE -ne 0) { Bad 'legendary install failed'; exit 1 }
    }

    $ver = (& $legendary --version 2>$null | Select-Object -First 1)
    Good "legendary ready: $ver"

    $status = (& $legendary status --json 2>$null) | ConvertFrom-Json
    $acct = [string]$status.account
    if ($acct -and $acct -notmatch '^<.*>$') {
      Good "already logged in to Epic as $acct"
    } else {
      Warn 'not logged in to Epic yet.'
      Warn 'Run this ONCE (it opens a browser, and the token then persists):'
      Write-Host '     .\.venv\Scripts\legendary auth' -ForegroundColor White
    }

    # --- nile: Amazon Games / Prime Gaming ---------------------------------
    # Not on PyPI, so it installs straight from GitHub. Best-effort: a network
    # that blocks PyPI must not fail the whole setup over one provider.
    $nile = Join-Path $root '.venv\Scripts\nile.exe'
    $haveNile = $false
    if (Test-Path $nile) {
      try { & $nile --version *> $null; if ($LASTEXITCODE -eq 0) { $haveNile = $true } } catch {}
    }
    if (-not $haveNile) {
      Say '   installing nile (Amazon Games / Prime Gaming)...'
      & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'tools\Install-Nile.ps1') `
        -PipPath (Join-Path $root '.venv\Scripts\pip.exe') -Quiet 2>$null
      if ($LASTEXITCODE -eq 0 -and (Test-Path $nile)) { $haveNile = $true }
    }
    if ($haveNile) {
      Good 'nile ready (Amazon Games)'
      $nstat = (& $nile auth --status 2>$null | Where-Object { $_ -match '^\{' } | Select-Object -First 1)
      if ($nstat -and ($nstat | ConvertFrom-Json).LoggedIn) {
        Good "already logged in to Amazon as $(($nstat | ConvertFrom-Json).Username)"
      } else {
        Warn 'not logged in to Amazon yet. Run this ONCE:'
        Write-Host '     .\.venv\Scripts\nile auth --login' -ForegroundColor White
      }
    } else {
      Warn 'nile could not be installed (needs git + PyPI access).'
      Warn 'Amazon ownership will fall back to the Manual library.'
    }
  }
}

# --- 5. Keys ---------------------------------------------------------------
Write-Host ''
Say '5. API keys'
if ($NonInteractive) {
  Warn 'skipped by request (-NonInteractive). Edit .env by hand.'
} else {
  Write-Host '   Press Enter to skip any of these -- all are optional, and each'
  Write-Host '   one is a permanent key you paste once and never touch again.'
  Write-Host ''

  $envText = Get-Content '.env' -Raw

  function Set-EnvValue([string]$key, [string]$value) {
    $script:envText = $script:envText -replace "(?m)^$key=.*$", "$key=$value"
  }
  function Ask([string]$key, [string]$prompt, [string]$url, [switch]$Secret) {
    $existing = if ($script:envText -match "(?m)^$key=(.+)$") { $Matches[1].Trim() } else { '' }
    if ($existing) { Good "$key already set -- leaving it"; return }
    Write-Host "   $prompt"
    if ($url) { Write-Host "     get one at: $url" -ForegroundColor DarkGray }
    if ($Secret) {
      $sec = Read-Host "     $key" -AsSecureString
      $val = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
    } else {
      $val = Read-Host "     $key"
    }
    if ($val) { Set-EnvValue $key $val.Trim(); Good "$key saved" }
    else { Warn "$key skipped" }
  }

  Ask 'ITAD_API_KEY' 'IsThereAnyDeal -- the most useful key. Unlocks all-time-low prices.' 'https://isthereanydeal.com/apps/my/'
  Ask 'STEAM_API_KEY' 'Steam Web API key -- for "do I already own this on Steam".' 'https://steamcommunity.com/dev/apikey'
  Ask 'STEAM_ID' 'Your 64-bit SteamID (17 digits).' 'https://steamid.io/'
  Ask 'ITCH_API_KEY' 'itch.io API key -- for itch.io ownership.' 'https://itch.io/user/settings/api-keys'

  Set-Content -Path '.env' -Value $envText -NoNewline -Encoding UTF8
}

# --- 6. Verify -------------------------------------------------------------
Write-Host ''
Say '6. Verifying'
& node test\match.test.mjs *> $null
if ($LASTEXITCODE -eq 0) { Good 'title matcher: pass' } else { Bad 'title matcher: FAIL' }
& node test\deal.test.mjs *> $null
if ($LASTEXITCODE -eq 0) { Good 'deal scoring: pass' } else { Bad 'deal scoring: FAIL' }

Write-Host ''
Say '=== Done ==='
Write-Host ''
Write-Host '  Start it:      ' -NoNewline; Write-Host '.\start.cmd' -ForegroundColor White
Write-Host '  Or:            ' -NoNewline; Write-Host 'npm start' -ForegroundColor White
Write-Host '  Check config:  ' -NoNewline; Write-Host 'npm run doctor' -ForegroundColor White
Write-Host ''
Write-Host '  Then open http://localhost:8787 and click "Sync library" once.'
Write-Host ''
