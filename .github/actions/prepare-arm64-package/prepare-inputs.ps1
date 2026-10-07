$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

$root = [string]$env:GITHUB_WORKSPACE
if ([string]::IsNullOrWhiteSpace($root) -or -not [IO.Path]::IsPathRooted($root) -or -not (Test-Path -LiteralPath $root -PathType Container)) {
  throw 'Native ARM64 CI preparation requires the checked-out GitHub workspace.'
}
Set-Location -LiteralPath $root
$npmCommand = (Get-Command npm.cmd -ErrorAction Stop).Source
$runnerTemp = [string]$env:RUNNER_TEMP
if ([string]::IsNullOrWhiteSpace($runnerTemp) -or -not [IO.Path]::IsPathRooted($runnerTemp)) {
  throw 'Native ARM64 CI preparation requires an absolute RUNNER_TEMP.'
}
$publishDir = Join-Path $runnerTemp 'windows-shell\win-arm64'
$binDir = (Join-Path $runnerTemp 'windows-shell-bin\win-arm64') + [IO.Path]::DirectorySeparatorChar
$objDir = (Join-Path $runnerTemp 'windows-shell-obj\win-arm64') + [IO.Path]::DirectorySeparatorChar
foreach ($candidate in @($publishDir, $binDir, $objDir)) {
  $relative = [IO.Path]::GetRelativePath($root, $candidate)
  if (-not $relative.StartsWith('..' + [IO.Path]::DirectorySeparatorChar) -and $relative -ne '..') { throw 'Native ARM64 CI shell outputs must stay outside the source checkout.' }
}

# npm writes node_modules; the native WPF project reads only its own sources,
# pinned NuGet packages and application artwork. These inputs are independent.
$cacheHit = ([string]$env:EQUINOX_NODE_MODULES_CACHE_HIT) -ceq 'true'
$installJob = Start-Job -ArgumentList $root, $npmCommand, $cacheHit -ScriptBlock {
  param([string]$Workspace, [string]$NpmCommand, [bool]$CacheHit)
  $ErrorActionPreference = 'Stop'
  $PSNativeCommandUseErrorActionPreference = $true
  Set-Location -LiteralPath $Workspace
  if ($CacheHit) {
    if (-not (Test-Path -LiteralPath (Join-Path $Workspace 'node_modules\.package-lock.json') -PathType Leaf)) { throw 'Cached node_modules is missing its npm lock marker.' }
    & $NpmCommand ls --omit=dev --depth=0
    if ($LASTEXITCODE -ne 0) { throw "Cached target-native dependency graph failed npm validation with exit code $LASTEXITCODE." }
    return
  }
  & $NpmCommand ci --prefer-offline --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "Locked native npm installation failed with exit code $LASTEXITCODE." }
}

try {
  dotnet publish native/windows/EquinoxLocal.WindowsShell/EquinoxLocal.WindowsShell.csproj --configuration Release --runtime win-arm64 --self-contained true -p:Platform=ARM64 -p:BaseOutputPath="$binDir" -p:BaseIntermediateOutputPath="$objDir" --output "$publishDir"
  if ($LASTEXITCODE -ne 0) { throw "Native ARM64 shell publication failed with exit code $LASTEXITCODE." }

  $null = Wait-Job -Job $installJob
  if ($installJob.State -ne 'Completed') {
    Receive-Job -Job $installJob -ErrorAction Continue
    throw 'Locked native npm installation did not complete successfully.'
  }
  Receive-Job -Job $installJob -ErrorAction Stop
  $nodePtyRoot = Join-Path $root 'node_modules\node-pty'
  $nodePtyBuild = Join-Path $nodePtyRoot 'build'
  if (Test-Path -LiteralPath $nodePtyBuild) { Remove-Item -LiteralPath $nodePtyBuild -Recurse -Force }
  foreach ($required in @('prebuilds\win32-arm64\conpty.node', 'prebuilds\win32-arm64\conpty_console_list.node')) {
    if (-not (Test-Path -LiteralPath (Join-Path $nodePtyRoot $required) -PathType Leaf)) { throw "ARM64 node-pty prebuild is missing: $required" }
  }
} finally {
  # Only this preparation step's own job is stopped or removed.
  Stop-Job -Job $installJob -ErrorAction SilentlyContinue
  Remove-Job -Job $installJob -ErrorAction SilentlyContinue
}
