$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

$root = [string]$env:GITHUB_WORKSPACE
if ([string]::IsNullOrWhiteSpace($root) -or -not [IO.Path]::IsPathRooted($root) -or -not (Test-Path -LiteralPath $root -PathType Container)) {
  throw 'Native ARM64 CI preparation requires the checked-out GitHub workspace.'
}
Set-Location -LiteralPath $root
$npmCommand = (Get-Command npm.cmd -ErrorAction Stop).Source
$cacheHit = ([string]$env:EQUINOX_NODE_MODULES_CACHE_HIT) -ceq 'true'
if ($cacheHit) {
  if (-not (Test-Path -LiteralPath (Join-Path $root 'node_modules\.package-lock.json') -PathType Leaf)) { throw 'Cached node_modules is missing its npm lock marker.' }
  & $npmCommand ls --omit=dev --depth=0
  if ($LASTEXITCODE -ne 0) { throw "Cached target-native dependency graph failed npm validation with exit code $LASTEXITCODE." }
  if (-not (Test-Path -LiteralPath (Join-Path $root 'node_modules\@napi-rs\canvas-win32-arm64-msvc') -PathType Container)) { throw 'Cached dependency graph is not Windows ARM64.' }
  if (Test-Path -LiteralPath (Join-Path $root 'node_modules\@napi-rs\canvas-win32-x64-msvc')) { throw 'Cached dependency graph contains Windows x64 native canvas.' }
} else {
  # Electron is packaged by the common builder; no WPF publication job remains.
  & $npmCommand ci --prefer-offline --no-audit --no-fund --os=win32 --cpu=arm64
  if ($LASTEXITCODE -ne 0) { throw "Locked native npm installation failed with exit code $LASTEXITCODE." }
}
