<#
.SYNOPSIS
  Package GameVault for transfer to another PC.

.DESCRIPTION
  Produces a zip containing the app and nothing else.

  Deliberately EXCLUDED:
    .env               your API keys and any stored password
    data\sessions.json live login tokens
    data\library.json  your game library (personal, and rebuilt in one click)
    data\cache\        stale prices
    .venv\             NOT portable -- pyvenv.cfg and legendary.exe both bake
                       in absolute paths from the machine that built them.
                       setup.ps1 rebuilds it in about a minute.

  So the zip is safe to email yourself, drop on a USB stick, or sync via
  cloud storage without leaking credentials.
#>
[CmdletBinding()]
param([string]$OutFile)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

if (-not $OutFile) {
  $OutFile = Join-Path ([Environment]::GetFolderPath('Desktop')) 'gamevault-portable.zip'
}

$staging = Join-Path $env:TEMP ("gv-pkg-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $staging | Out-Null

$include = @(
  'lib', 'public', 'test', 'tools', 'site', '.github',
  'server.mjs', 'package.json', 'README.md', 'DEPLOY.md', 'FREE-HOSTING.md', 'watchlist.txt',
  '.env.example', '.gitignore', '.dockerignore',
  'install.ps1', 'setup.ps1', 'start.cmd', 'package.ps1', 'GameVault.vbs',
  'Dockerfile', 'docker-compose.yml', 'fly.toml'
)

foreach ($item in $include) {
  if (Test-Path $item) {
    Copy-Item $item -Destination $staging -Recurse -Force
  }
}

# Paranoia: assert nothing sensitive rode along.
$leaks = @()
foreach ($bad in '.env', 'data', '.venv', 'node_modules') {
  $p = Join-Path $staging $bad
  if (Test-Path $p) { $leaks += $bad }
}
# A built snapshot is generated output, not source. It is encrypted, but it
# is still YOUR library and it is rebuilt on first run anyway -- .gitignore
# covers git, not this zip, so it has to be removed explicitly.
foreach ($built in 'site\snapshot.json', 'site\snapshot-meta.json') {
  $p = Join-Path $staging $built
  if (Test-Path $p) { Remove-Item $p -Force }
}
if ($leaks.Count) {
  Remove-Item -Recurse -Force $staging
  throw "Refusing to package: these should never be included -> $($leaks -join ', ')"
}

if (Test-Path $OutFile) { Remove-Item $OutFile -Force }
Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $OutFile -CompressionLevel Optimal
Remove-Item -Recurse -Force $staging

$kb = [math]::Round((Get-Item $OutFile).Length / 1KB, 1)
Write-Host ''
Write-Host "Packaged: $OutFile  ($kb KB)" -ForegroundColor Green
Write-Host ''
Write-Host 'On the home PC:' -ForegroundColor Cyan
Write-Host '  1. Unzip anywhere (e.g. C:\gamevault)'
Write-Host '  2. Right-click install.ps1 -> Run with PowerShell'
Write-Host '     (it walks you through keys and makes a desktop shortcut)'
Write-Host '  3. Double-click the GameVault icon'
Write-Host ''
Write-Host 'No credentials are in this zip -- you enter them once during install.' -ForegroundColor DarkGray
Write-Host ''
