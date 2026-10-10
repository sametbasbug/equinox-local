# Read-only Windows tunnel recovery triage.
# Deliberately never reads or prints the Tunnel ID, Runtime API key, process
# command lines, raw logs, profile YAML or untrusted diagnostics.
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'PowerShell 7 or later is required.' }

$root = Join-Path $env:LOCALAPPDATA 'Equinox Local'
$log = Join-Path $root 'logs\windows-shell-runtime.log'
$phases = @()
$gateExits = 0
$runtimeErrors = 0
if (Test-Path -LiteralPath $log -PathType Leaf) {
  foreach ($line in @(Get-Content -LiteralPath $log -Tail 160 -ErrorAction Stop)) {
    if ($line -match ' runtime-start-phase (job-created|gate-started|assign-started|assigned|gate-released|child-started)(?:\s|$)') {
      $phases += $Matches[1]
    }
    elseif ($line -match ' runtime-gate-exit (?:exit=(-?[0-9]+))') { $gateExits++ }
    elseif ($line -match ' runtime-(restart|start) ') { $runtimeErrors++ }
  }
}

$portListening = $false
try { $portListening = @(
  Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 24891 -State Listen -ErrorAction Stop
).Count -gt 0 } catch { $portListening = $false }


# Classify startup barriers without reading any private values. Use the
# installed, version-pinned helper to verify ACLs; do not repair anything.
$pointer = Join-Path $root 'current-version.json'
$version = $null
try {
  if ((Get-Item -LiteralPath $pointer -Force -ErrorAction Stop).Length -le 4096) {
    $candidate = (Get-Content -LiteralPath $pointer -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop).version
    if ($candidate -is [string] -and $candidate -match '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') { $version = $candidate }
  }
} catch { }
$release = if ($version) { Join-Path (Join-Path $root 'releases') $version } else { $null }
$privateHelper = if ($release) { Join-Path $release 'equinox-local-windows-private-state.ps1' } else { $null }
$helperPresent = [bool]($privateHelper -and (Test-Path -LiteralPath $privateHelper -PathType Leaf))
$secretFile = Join-Path $root 'secrets\openai-runtime-key'
$profileDirectory = Join-Path $root 'tunnel-profile'
function Test-PrivateStateAcl([string]$Target, [string]$Type) {
  if (-not $script:helperPresent) { return 'helper-missing' }
  if (-not (Test-Path -LiteralPath $Target)) { return 'missing' }
  try {
    $nativePowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $result = & $nativePowerShell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script:privateHelper -Action verify -Target $Target -Type $Type 2>$null
    if ($LASTEXITCODE -ne 0) { return 'helper-execution-failed' }
    $parsed = $result | ConvertFrom-Json -ErrorAction Stop
    if ($parsed.safe -eq $true) { return 'safe' }
    if ($parsed.reason -is [string] -and $parsed.reason -match '^[a-z-]{1,48}$') { return 'unsafe-' + $parsed.reason }
    return 'unsafe-other'
  } catch { return 'helper-execution-failed' }
}
$profileFilesExist = $false
try {
  $profileFilesExist = @(Get-ChildItem -LiteralPath $profileDirectory -File -ErrorAction Stop |
    Where-Object { $_.Extension -in @('.yaml', '.yml') }).Count -gt 0
} catch { }

[pscustomobject]@{
  ShellRunning = @(Get-Process -Name 'EquinoxLocal' -ErrorAction SilentlyContinue).Count -gt 0
  TunnelClientRunning = @(Get-Process -Name 'tunnel-client' -ErrorAction SilentlyContinue).Count -gt 0
  NodeProcessCount = @(Get-Process -Name 'node' -ErrorAction SilentlyContinue).Count
  LocalControlCenterListening = $portListening
  TransportConfigExists = Test-Path -LiteralPath (Join-Path $root 'transport.json') -PathType Leaf
  RuntimeKeyFileExists = Test-Path -LiteralPath (Join-Path $root 'secrets\openai-runtime-key') -PathType Leaf
  TunnelProfileDirectoryExists = Test-Path -LiteralPath (Join-Path $root 'tunnel-profile') -PathType Container
  ShellLogExists = Test-Path -LiteralPath $log -PathType Leaf
  LastShellPhase = if ($phases.Count -gt 0) { $phases[-1] } else { 'none' }
  RecentGateExitCount = $gateExits
  RecentRuntimeErrorCount = $runtimeErrors
  InstalledVersion = if ($version) { $version } else { 'unavailable' }
  TunnelClientExeExists = [bool]($release -and (Test-Path -LiteralPath (Join-Path $release 'runtime\tunnel\tunnel-client.exe') -PathType Leaf))
  RuntimeNodeExeExists = [bool]($release -and (Test-Path -LiteralPath (Join-Path $release 'runtime\node\bin\node.exe') -PathType Leaf))
  PrivateAclHelperExists = $helperPresent
  RuntimeKeyAcl = Test-PrivateStateAcl $secretFile 'file'
  TunnelProfileAcl = Test-PrivateStateAcl $profileDirectory 'directory'
  TunnelProfileYamlPresent = $profileFilesExist
}
