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
}
