<#
.SYNOPSIS
  GameVault one-click installer for a personal Windows PC.

.DESCRIPTION
  Does everything needed to go from "unzipped folder" to "icon on my desktop":
    1. checks Node
    2. installs the optional Epic (legendary) and Amazon (nile) clients
    3. walks you through each credential, opening the signup page for you
       and VALIDATING the key against the live service before saving it
    4. signs you in to Epic and Amazon
    5. generates icons and creates Desktop + Start Menu shortcuts
    6. optionally starts GameVault when you log in

  Safe to re-run. It never overwrites a key that already works, and every
  step is skippable.
#>
[CmdletBinding()]
param(
  [switch]$NoShortcuts,
  [switch]$NoPrompt,
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

function Head ($m) { Write-Host ''; Write-Host $m -ForegroundColor Cyan; Write-Host ('-' * $m.Length) -ForegroundColor DarkCyan }
function Good ($m) { Write-Host "  [ok]   $m" -ForegroundColor Green }
function Warn ($m) { Write-Host "  [--]   $m" -ForegroundColor Yellow }
function Bad  ($m) { Write-Host "  [X]    $m" -ForegroundColor Red }
function Note ($m) { Write-Host "         $m" -ForegroundColor DarkGray }

<#
  Run an external command without letting it abort the installer.

  $ErrorActionPreference='Stop' turns anything a native tool writes to stderr
  into a terminating NativeCommandError. pip does that routinely -- and an
  OPTIONAL component (legendary, nile) failing must never kill the install.
  Returns the exit code; callers decide what it means.
#>
function Invoke-Quiet {
  param([string]$Exe, [string[]]$Args)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $Exe @Args 2>&1 | Out-Null
    return $LASTEXITCODE
  } catch {
    return 1
  } finally {
    $ErrorActionPreference = $prev
  }
}

Write-Host ''
Write-Host '  GameVault' -ForegroundColor White
Write-Host '  Do I own it? Is it in a subscription? Is this a good price?' -ForegroundColor DarkGray

# ---------------------------------------------------------------- 1. Node ---
Head '1. Node.js'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Bad 'Node.js is not installed - GameVault cannot run without it.'
  Note 'Get the LTS installer from https://nodejs.org/ (takes about a minute),'
  Note 'then run this script again.'
  if (-not $NoPrompt) {
    $o = Read-Host '  Open the download page now? [Y/n]'
    if ($o -ne 'n') { Start-Process 'https://nodejs.org/en/download' }
  }
  exit 1
}
$nodeVer = (& node --version).TrimStart('v')
if ([int]($nodeVer -split '\.')[0] -lt 20) {
  Bad "Node $nodeVer is too old - GameVault needs 20 or newer (for built-in fetch)."
  if (-not $NoPrompt) {
    $o = Read-Host '  Open the download page now? [Y/n]'
    if ($o -ne 'n') { Start-Process 'https://nodejs.org/en/download' }
  }
  exit 1
}
Good "node $nodeVer"

foreach ($d in 'data', 'data\cache') {
  if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
}
if (-not (Test-Path '.env')) { Copy-Item '.env.example' '.env' }

# Lock the files that hold secrets to this user only.
# Idempotent: re-applying an already-correct ACL needs SeSecurityPrivilege
# (admin), so check first rather than failing noisily on every re-run.
foreach ($secret in '.env', 'data\sessions.json') {
  if (-not (Test-Path $secret)) { continue }
  try {
    $acl = Get-Acl $secret
    $me = "$env:USERDOMAIN\$env:USERNAME"
    $alreadyLocked = $acl.AreAccessRulesProtected -and
                     $acl.Access.Count -eq 1 -and
                     $acl.Access[0].IdentityReference.Value -eq $me
    if (-not $alreadyLocked) {
      $acl.SetAccessRuleProtection($true, $false)
      $acl.Access | ForEach-Object { [void]$acl.RemoveAccessRule($_) }
      $acl.SetAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
        $me, 'FullControl', 'Allow')))
      Set-Acl -Path $secret -AclObject $acl
    }
  } catch {
    Warn "could not restrict $secret to your user - check its permissions manually"
  }
}
Good 'folders and .env ready (locked to your user)'

# ------------------------------------------------------- 2. Game clients ---
Head '2. Optional game clients (Epic + Amazon ownership)'
$py = Get-Command python -ErrorAction SilentlyContinue
if (-not $py) { $py = Get-Command py -ErrorAction SilentlyContinue }

$legendary = Join-Path $root '.venv\Scripts\legendary.exe'
$nile      = Join-Path $root '.venv\Scripts\nile.exe'
$haveLeg = $false; $haveNile = $false

if (-not $py) {
  Warn 'Python not found - skipping Epic and Amazon ownership.'
  Note 'Everything else works. Install Python 3.9+ from python.org and re-run to add them.'
} else {
  # A venv copied from another machine is broken: pyvenv.cfg and the .exe
  # launchers both hard-code absolute paths. Detect and rebuild.
  $needBuild = $true
  if (Test-Path $legendary) {
    if ((Invoke-Quiet $legendary @('--version')) -eq 0) { $needBuild = $false }
    if ($needBuild) { Warn 'existing .venv is broken (copied from another PC) - rebuilding' }
  }
  if ($needBuild) {
    if (Test-Path '.venv') { Remove-Item -Recurse -Force '.venv' -ErrorAction SilentlyContinue }
    Write-Host '         creating Python environment...' -ForegroundColor DarkGray
    Invoke-Quiet $py.Source @('-m', 'venv', '.venv') | Out-Null
    Invoke-Quiet '.\.venv\Scripts\python.exe' @('-m', 'pip', 'install', '--quiet', '--upgrade', 'pip') | Out-Null
  }

  if (-not (Test-Path $legendary)) {
    Write-Host '         installing legendary (Epic)...' -ForegroundColor DarkGray
    Invoke-Quiet '.\.venv\Scripts\pip.exe' @('install', '--quiet', 'legendary-gl') | Out-Null
  }
  if (Test-Path $legendary) { $haveLeg = $true; Good 'legendary installed (Epic)' }
  else { Warn 'legendary could not be installed (needs PyPI access) - Epic ownership unavailable' }

  if (-not (Test-Path $nile)) {
    Write-Host '         installing nile (Amazon Games)...' -ForegroundColor DarkGray
    Invoke-Quiet 'powershell' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
                                (Join-Path $root 'tools\Install-Nile.ps1'),
                                '-PipPath', (Join-Path $root '.venv\Scripts\pip.exe'),
                                '-Quiet') | Out-Null
  }
  if (Test-Path $nile) { $haveNile = $true; Good 'nile installed (Amazon Games / Prime Gaming)' }
  else {
    Warn 'nile could not be installed (needs git + PyPI access)'
    Note 'Amazon ownership will fall back to the Manual library. Everything else is unaffected.'
  }
}

# ------------------------------------------------------ 3. Credentials -----
Head '3. Credentials'

$envText = Get-Content '.env' -Raw
function Get-EnvValue([string]$key) {
  if ($script:envText -match "(?m)^$key=(.*)$") { return $Matches[1].Trim() }
  return ''
}
function Set-EnvValue([string]$key, [string]$value) {
  if ($script:envText -match "(?m)^$key=") {
    $script:envText = $script:envText -replace "(?m)^$key=.*$", "$key=$value"
  } else {
    $script:envText = $script:envText.TrimEnd() + "`r`n$key=$value`r`n"
  }
}

# Validate a key against the live service BEFORE saving it. Finding out a key
# is wrong three weeks later, mid-sale, is the failure this avoids.
function Test-Credential([string]$kind, [string]$value, [string]$extra) {
  try {
    switch ($kind) {
      'itad' {
        $r = Invoke-RestMethod -Uri "https://api.isthereanydeal.com/games/search/v1?key=$value&title=hades&results=1" -TimeoutSec 20
        return @{ ok = $true; msg = "valid - found '$($r[0].title)'" }
      }
      'steam' {
        $r = Invoke-RestMethod -Uri "https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=$value&steamids=76561197960435530" -TimeoutSec 20
        if ($r.response) { return @{ ok = $true; msg = 'valid' } }
        return @{ ok = $false; msg = 'unexpected response' }
      }
      'steamid' {
        if ($value -notmatch '^\d{17}$') { return @{ ok = $false; msg = 'a SteamID64 is exactly 17 digits' } }
        $r = Invoke-RestMethod -Uri "https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=$extra&steamids=$value" -TimeoutSec 20
        $p = $r.response.players
        if (-not $p -or $p.Count -eq 0) { return @{ ok = $false; msg = 'no Steam profile with that ID' } }
        return @{ ok = $true; msg = "valid - $($p[0].personaname)" }
      }
      'itch' {
        $r = Invoke-RestMethod -Uri "https://itch.io/api/1/$value/me" -TimeoutSec 20
        if ($r.errors) { return @{ ok = $false; msg = ($r.errors -join ', ') } }
        return @{ ok = $true; msg = "valid - $($r.user.username)" }
      }
    }
  } catch {
    return @{ ok = $false; msg = $_.Exception.Message }
  }
  return @{ ok = $false; msg = 'unknown' }
}

function Ask-Credential {
  param(
    [string]$Key, [string]$Title, [string]$Why, [string]$Url,
    [string]$Kind, [string]$Extra
  )
  $existing = Get-EnvValue $Key
  if ($existing) {
    if ($Kind) {
      $t = Test-Credential $Kind $existing $Extra
      if ($t.ok) { Good "$Title - already set, $($t.msg)"; return $existing }
      Warn "$Title - the saved value no longer works ($($t.msg)). Let's replace it."
    } else { Good "$Title - already set"; return $existing }
  }

  Write-Host ''
  Write-Host "  $Title" -ForegroundColor White
  Note $Why
  if ($NoPrompt) { Warn 'skipped (-NoPrompt)'; return '' }

  if ($Url) {
    $o = Read-Host "  Open $Url to get one? [Y/n/s=skip]"
    if ($o -eq 's') { Warn 'skipped'; return '' }
    if ($o -ne 'n') { Start-Process $Url; Note 'Sign in, copy the value, then paste it below.' }
  }

  for ($try = 1; $try -le 3; $try++) {
    $val = (Read-Host "  Paste $Key (or press Enter to skip)").Trim()
    if (-not $val) { Warn 'skipped'; return '' }
    if (-not $Kind) { Set-EnvValue $Key $val; Good 'saved'; return $val }

    Write-Host '         checking...' -ForegroundColor DarkGray
    $t = Test-Credential $Kind $val $Extra
    if ($t.ok) { Set-EnvValue $Key $val; Good "saved - $($t.msg)"; return $val }
    Bad "that did not work: $($t.msg)"
    if ($try -lt 3) { Note 'Try again, or press Enter to skip.' }
  }
  Warn 'skipped after 3 attempts'
  return ''
}

Ask-Credential -Key 'ITAD_API_KEY' -Title 'IsThereAnyDeal (most useful key)' `
  -Why 'Unlocks all-time-low prices. Without it "good deal" is just % off list.' `
  -Url 'https://isthereanydeal.com/apps/my/' -Kind 'itad' | Out-Null

$steamKey = Ask-Credential -Key 'STEAM_API_KEY' -Title 'Steam Web API key' `
  -Why 'Lets GameVault see which games you already own on Steam.' `
  -Url 'https://steamcommunity.com/dev/apikey' -Kind 'steam'

if ($steamKey) {
  Ask-Credential -Key 'STEAM_ID' -Title 'Your SteamID64 (17 digits)' `
    -Why 'Which Steam account to read. steamid.io converts a profile URL for you.' `
    -Url 'https://steamid.io/' -Kind 'steamid' -Extra $steamKey | Out-Null
  Note 'Reminder: Steam > Profile > Edit > Privacy > "Game details" must be Public,'
  Note 'or Steam returns an empty library with no error.'
}

Ask-Credential -Key 'ITCH_API_KEY' -Title 'itch.io API key' `
  -Why 'Reads your itch.io library, including bundle keys.' `
  -Url 'https://itch.io/user/settings/api-keys' -Kind 'itch' | Out-Null

# Which Game Pass tier -- this one changes correctness, not just coverage.
if (-not (Get-EnvValue 'SUBSCRIPTIONS') -and -not $NoPrompt) {
  Write-Host ''
  Write-Host '  Game Pass / EA Play' -ForegroundColor White
  Note 'Tiers differ: Cyberpunk 2077 is on Console Game Pass but NOT PC.'
  Note 'Getting this right stops GameVault saying "included" for something you cannot play.'
  Note '  1) PC Game Pass    2) Ultimate    3) Console    4) EA Play only    5) none'
  $c = Read-Host '  Which do you have? [1-5, Enter to skip]'
  $plan = switch ($c) { '1' { 'pc' } '2' { 'ultimate' } '3' { 'console' } '4' { 'eaplay' } '5' { 'none' } default { '' } }
  if ($plan) { Set-EnvValue 'SUBSCRIPTIONS' $plan; Good "subscriptions = $plan" }
  else { Warn 'skipped - all tiers will be assumed, and results will say so' }
}

Set-Content -Path '.env' -Value $envText -NoNewline -Encoding UTF8

# ------------------------------------------------- 4. Store sign-ins -------
Head '4. Store sign-ins (one browser login each, then they persist)'

if ($haveLeg -and -not $NoPrompt) {
  $st = (& $legendary status --json 2>$null | ConvertFrom-Json)
  $acct = [string]$st.account
  if ($acct -and $acct -notmatch '^<.*>$') { Good "Epic - already signed in as $acct" }
  else {
    $o = Read-Host '  Sign in to Epic now? (opens a browser) [Y/n]'
    if ($o -ne 'n') {
      & $legendary auth
      $st2 = (& $legendary status --json 2>$null | ConvertFrom-Json)
      if ([string]$st2.account -notmatch '^<.*>$') { Good "Epic - signed in as $($st2.account)" }
      else { Warn 'Epic sign-in did not complete - run "npm run epic-auth" later' }
    }
  }
} elseif ($haveLeg) { Warn 'Epic - run "npm run epic-auth" to sign in' }

if ($haveNile -and -not $NoPrompt) {
  $ns = (& $nile auth --status 2>$null | Where-Object { $_ -match '^\{' } | Select-Object -First 1)
  if ($ns -and ($ns | ConvertFrom-Json).LoggedIn) {
    Good "Amazon - already signed in as $(($ns | ConvertFrom-Json).Username)"
  } else {
    $o = Read-Host '  Sign in to Amazon (Prime Gaming) now? [Y/n]'
    if ($o -ne 'n') {
      & $nile auth --login
      $ns2 = (& $nile auth --status 2>$null | Where-Object { $_ -match '^\{' } | Select-Object -First 1)
      if ($ns2 -and ($ns2 | ConvertFrom-Json).LoggedIn) { Good 'Amazon - signed in' }
      else { Warn 'Amazon sign-in did not complete - run "npm run amazon-auth" later' }
    }
  }
} elseif ($haveNile) { Warn 'Amazon - run "npm run amazon-auth" to sign in' }

# ---------------------------------------------------- 5. Shortcuts ---------
Head '5. Shortcuts'
Invoke-Quiet 'node' @('tools\make-icons.mjs') | Out-Null
$icon = Join-Path $root 'public\gamevault.ico'
if (Test-Path $icon) { Good 'icons generated' } else { Warn 'icon generation failed (shortcut will use the default)' }

if ($NoShortcuts) {
  Warn 'skipped by request (-NoShortcuts)'
} else {
  $launcher = Join-Path $root 'GameVault.vbs'
  $ws = New-Object -ComObject WScript.Shell

  function New-GvShortcut([string]$path) {
    $sc = $ws.CreateShortcut($path)
    $sc.TargetPath = 'wscript.exe'
    $sc.Arguments = "`"$launcher`""
    $sc.WorkingDirectory = $root
    $sc.Description = 'GameVault - do I own it, and is this a good price?'
    if (Test-Path $icon) { $sc.IconLocation = $icon }
    $sc.Save()
  }

  try {
    $desktop = [Environment]::GetFolderPath('Desktop')
    New-GvShortcut (Join-Path $desktop 'GameVault.lnk')
    Good "Desktop shortcut created"
  } catch { Warn "could not create the desktop shortcut: $($_.Exception.Message)" }

  try {
    $startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'GameVault.lnk'
    New-GvShortcut $startMenu
    Good 'Start Menu entry created (searchable as "GameVault")'
  } catch { Warn 'could not create the Start Menu entry' }

  if (-not $NoPrompt) {
    $o = Read-Host '  Start GameVault automatically when you log in? [y/N]'
    if ($o -eq 'y') {
      try {
        $startup = Join-Path ([Environment]::GetFolderPath('Startup')) 'GameVault.lnk'
        New-GvShortcut $startup
        Good 'will start on login'
      } catch { Warn 'could not add to startup' }
    }
  }
}

# ------------------------------------------------------- 6. Verify ---------
Head '6. Checking everything works'
if ((Invoke-Quiet 'node' @('test\match.test.mjs')) -eq 0) { Good 'title matching' } else { Bad 'title matching FAILED' }
if ((Invoke-Quiet 'node' @('test\deal.test.mjs'))  -eq 0) { Good 'deal scoring' }  else { Bad 'deal scoring FAILED' }

Write-Host ''
Write-Host '  Done.' -ForegroundColor Green
Write-Host ''
Write-Host '  Double-click the GameVault icon on your desktop.' -ForegroundColor White
Write-Host '  It opens your browser at http://localhost:8787' -ForegroundColor DarkGray
Write-Host ''
Write-Host '  First run: click "Sync library" once to pull in what you own.' -ForegroundColor DarkGray
Write-Host '  Any time:  run "npm run doctor" to see what is configured.' -ForegroundColor DarkGray
Write-Host ''

if (-not $NoPrompt) {
  $o = Read-Host '  Start GameVault now? [Y/n]'
  if ($o -ne 'n') { Start-Process 'wscript.exe' -ArgumentList "`"$root\GameVault.vbs`"" }
}
