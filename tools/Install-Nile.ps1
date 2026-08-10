<#
.SYNOPSIS
  Installs nile (the unofficial Amazon Games client) into a virtualenv.

.DESCRIPTION
  nile cannot be pip-installed straight from its git URL. Its repository uses a
  flat layout in which `assets/` is discovered as a top-level package alongside
  `nile`, and modern setuptools refuses to guess between them:

      error: Multiple top-level packages discovered in a flat-layout
      discovered packages -- ['assets', 'nile', 'nile.api', ...]

  This is NOT a platform limitation. nile declares Windows support and its
  dependencies are all cross-platform; the same install fails identically on
  Linux with current setuptools. The failure merely looked platform-specific
  because it was the only place anyone hit it.

  The fix is to clone the repository and tell setuptools which packages are
  real before installing.

.PARAMETER PipPath
  Path to the pip executable of the target virtualenv.

.PARAMETER Quiet
  Suppress pip output.
#>
param(
    [Parameter(Mandatory = $true)][string] $PipPath,
    [switch] $Quiet
)

$ErrorActionPreference = 'Continue'

if (-not (Test-Path $PipPath)) {
    Write-Error "pip not found at $PipPath"
    exit 1
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Error 'git is required to install nile'
    exit 1
}

$work = Join-Path ([System.IO.Path]::GetTempPath()) ("nile-src-" + [guid]::NewGuid().ToString('N').Substring(0, 8))

try {
    $cloneArgs = @('clone', '--depth', '1', 'https://github.com/imLinguin/nile.git', $work)
    if ($Quiet) { $cloneArgs += '--quiet' }
    & git @cloneArgs 2>&1 | Out-Null
    if (-not (Test-Path (Join-Path $work 'pyproject.toml'))) {
        Write-Error 'nile clone failed'
        exit 1
    }

    # Name the real packages so `assets/` is no longer a candidate.
    $marker = '[tool.setuptools.packages.find]'
    $pyproject = Join-Path $work 'pyproject.toml'
    if (-not ((Get-Content $pyproject -Raw) -match [regex]::Escape($marker))) {
        Add-Content -Path $pyproject -Value "`n$marker`ninclude = [`"nile*`"]`n"
    }

    $pipArgs = @('install', $work)
    if ($Quiet) { $pipArgs += '--quiet' }
    & $PipPath @pipArgs 2>&1 | ForEach-Object { if (-not $Quiet) { $_ } }
    exit $LASTEXITCODE
}
finally {
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
