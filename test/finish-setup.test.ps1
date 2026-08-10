<#
.SYNOPSIS
  Checks finish-setup.ps1 for problems that a syntax parse does not catch.

.DESCRIPTION
  A PowerShell script parses cleanly even when it calls a function defined
  further down the file - the failure only appears at run time, and only on
  the machine running it. That shipped once: Get-BrokenProviders was invoked
  nineteen lines before it was defined, and every syntax check passed.

  Run as part of `npm test`, so the same mistake cannot reach a user again.
#>
[CmdletBinding()]
param([string] $Path)

if (-not $Path) { $Path = Join-Path (Split-Path -Parent $PSScriptRoot) 'finish-setup.ps1' }

$fails = 0
function Ok($cond, $msg) {
    if ($cond) { Write-Host "  ok:   $msg" }
    else { Write-Host "  FAIL: $msg"; $script:fails++ }
}

Write-Host 'finish-setup.ps1 is syntactically valid'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
Ok ($errors.Count -eq 0) "parses without errors$(if ($errors.Count) { ': ' + $errors[0].Message })"
if ($errors.Count) { exit 1 }

# --- every function is defined before it is called --------------------------
Write-Host "`nEvery function is defined before the line that calls it"

$definitions = @{}
foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
    # Keep the FIRST definition; a later redefinition does not help an earlier call.
    if (-not $definitions.ContainsKey($fn.Name)) { $definitions[$fn.Name] = $fn.Extent.StartLineNumber }
}

# Calls made at script level, i.e. not inside a function body. A call inside a
# function is fine wherever it sits, because the body only runs once invoked.
$functionExtents = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true) |
    ForEach-Object { [pscustomobject]@{ Start = $_.Extent.StartLineNumber; End = $_.Extent.EndLineNumber } }

$violations = @()
foreach ($cmd in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true)) {
    $name = $cmd.GetCommandName()
    if (-not $name -or -not $definitions.ContainsKey($name)) { continue }
    $line = $cmd.Extent.StartLineNumber
    $insideFunction = $functionExtents | Where-Object { $line -ge $_.Start -and $line -le $_.End }
    if ($insideFunction) { continue }
    if ($line -lt $definitions[$name]) {
        $violations += "$name called at line $line but defined at line $($definitions[$name])"
    }
}
Ok ($violations.Count -eq 0) $(if ($violations.Count) { $violations -join '; ' } else { "$($definitions.Count) functions, all defined before use" })

# --- no native command has its stderr turned into a fatal error -------------
Write-Host "`nNative commands cannot be killed by harmless stderr output"
$src = Get-Content $Path -Raw
Ok ($src -notmatch "ErrorActionPreference\s*=\s*'Stop'") `
   "the script does not run under ErrorActionPreference = 'Stop' (pip writes notices to stderr)"

# --- interactive tools must own the console ---------------------------------
Write-Host "`nInteractive sign-in tools are not piped or captured"
# `$x = & node ...` captures the prompt into the value instead of showing it;
# a pipe buffers it. Either way the script looks frozen.
Ok ($src -notmatch '\$\w+\s*=\s*&\s*node\b') 'no assignment captures a node tool''s output'
Ok ($src -notmatch '&\s*node\b[^\r\n|]*\|') 'no node tool is piped'
Ok ($src -match 'Start-Process[^\r\n]*node') 'auth tools run via Start-Process, which gives them the console'

# --- secrets are trimmed ----------------------------------------------------
Write-Host "`nCredentials are trimmed before being stored"
Ok ($src -match '\$Value\s*=\s*\$Value\.Trim\(\)') `
   'Set-Secret trims (a stray CR makes undici reject the request outright)'

Write-Host ''
if ($fails) { Write-Host "$fails assertion(s) failed."; exit 1 }
Write-Host 'All finish-setup checks passed.'
