# Disposable GitHub-hosted runner ONLY. Crash genuine target B server processes
# after the real Main source pointer switches, without changing admitted bytes.
# Never kill the product shell, detached updater worker, or source A.
param(
  [Parameter(Mandatory=$true)][string]$PointerPath,
  [Parameter(Mandatory=$true)][string]$TargetSha,
  [Parameter(Mandatory=$true)][string]$OwnedNodePath,
  [Parameter(Mandatory=$true)][string]$MarkerPath,
  [Parameter(Mandatory=$true)][string]$ReadyPath,
  [Parameter(Mandatory=$true)][string]$StopPath
)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_OS -cne 'Windows' -or $env:CI -cne 'true') { throw 'Native crash injection is allowed on disposable GitHub Windows runners only.' }
if ($TargetSha -cnotmatch '^[a-f0-9]{40}$' -or -not [IO.Path]::IsPathRooted($PointerPath) -or -not [IO.Path]::IsPathRooted($OwnedNodePath)) { throw 'Native crash target identity is invalid.' }
$canonicalExe = [IO.Path]::GetFullPath($OwnedNodePath)
[IO.File]::WriteAllText($ReadyPath, 'ready')
$seenTarget = $false
$deadline = [DateTime]::UtcNow.AddMinutes(5)
while ([DateTime]::UtcNow -lt $deadline -and -not [IO.File]::Exists($StopPath)) {
  $pointer = ''
  try { $pointer = [IO.File]::ReadAllText($PointerPath) } catch { }
  $targetActive = $pointer -match ('(?m)^sha=' + $TargetSha + '\r?$')
  if ($targetActive) { $seenTarget = $true }
  if ($targetActive) {
    # Query only native product Node processes whose *command line* includes
    # actual B checkout's server.js. The detached worker's own JS is excluded.
    $processes = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue)
    foreach ($process in $processes) {
      $cmd = [string]$process.CommandLine
      if ($cmd -notmatch [regex]::Escape($TargetSha) -or $cmd -notmatch '[/\\]server\.js(?:\s|"|$)') { continue }
      if ([string]::IsNullOrWhiteSpace($process.ExecutablePath) -or [IO.Path]::GetFullPath($process.ExecutablePath) -ine $canonicalExe) { continue }
      try {
        Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction Stop
        [IO.File]::AppendAllText($MarkerPath, ('killed-b-server:' + [string]$process.ProcessId + "`n"))
      } catch { }
    }
  }
  if ($seenTarget -and $pointer -match '(?m)^sha=[a-f0-9]{40}\r?$' -and -not $targetActive) { break }
  Start-Sleep -Milliseconds 70
}
