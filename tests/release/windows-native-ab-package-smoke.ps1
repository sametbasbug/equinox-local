param(
  [Parameter(Mandatory=$true)][string]$ArtifactPath,
  [Parameter(Mandatory=$true)][ValidateSet('win32-x64','win32-arm64')][string]$Target,
  [string]$ExpectedSha256 = ''
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

# The full Windows installer lane still owns all physical installation,
# Guardian negative/admission and Native Messaging verification. This
# independent package lane owns ONLY the disposable exact-WPF A/B rollback
# fixture, so it can overlap the real installer without sharing OS state.
if ($env:GITHUB_ACTIONS -cne 'true') { throw 'Native package A/B offload is restricted to GitHub CI.' }
if (-not [IO.Path]::IsPathRooted($ArtifactPath) -or -not [IO.File]::Exists($ArtifactPath)) {
  throw 'Native A/B acceptance requires an existing absolute managed ZIP path.'
}
if ($ExpectedSha256 -ne '') {
  if ($ExpectedSha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'Native A/B expected digest is malformed.' }
  $actualSha = (Get-FileHash -LiteralPath $ArtifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualSha -cne $ExpectedSha256) { throw 'Native A/B package SHA256 differs from its producer.' }
}

$fixture = Join-Path $env:RUNNER_TEMP ('equinox-native-ab-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($fixture) | Out-Null
try {
  & tar.exe -xf $ArtifactPath -C $fixture 'release/release.json' 'release/runtime/job' 'release/runtime/shell' 'release/runtime/node/bin/node.exe'
  if ($LASTEXITCODE -ne 0) { throw 'Failed to extract the exact signed candidate WPF/job payload from the managed ZIP.' }
  $releaseDir = Join-Path $fixture 'release'
  $metadata = Get-Content -LiteralPath (Join-Path $releaseDir 'release.json') -Raw | ConvertFrom-Json
  if ($metadata.target -cne $Target -or [string]$metadata.sourceSha -cne $env:GITHUB_SHA -or
      [string]$metadata.version -cnotmatch '^[0-9]+\.[0-9]+\.[0-9]+$') {
    throw 'Native A/B smoke cannot admit a package from another target, version or commit.'
  }
  # The native journal verifier derives Stable A's identity from its
  # version-named release directory, just as the real installer does. Keep
  # this identity check strict while staging the unpacked package accordingly.
  $versionedReleaseDir = Join-Path $fixture ([string]$metadata.version)
  Move-Item -LiteralPath $releaseDir -Destination $versionedReleaseDir
  $releaseDir = $versionedReleaseDir
  foreach ($expected in @('runtime/shell/EquinoxLocal.exe','runtime/job/equinox-local-job-object-helper.exe','runtime/job/owned-process-gate-v1.marker')) {
    if (-not [IO.File]::Exists((Join-Path $releaseDir $expected))) { throw "Native A/B candidate is missing $expected" }
  }
  # Worker journal admission intentionally requires the verified release's
  # PRODUCT-OWNED Node, not the GitHub runner Node on ambient PATH.
  $ownedNode = Join-Path $releaseDir 'runtime/node/bin/node.exe'
  if (-not [IO.File]::Exists($ownedNode)) { throw 'Native A/B acceptance is missing product-owned Node.' }
  & $ownedNode (Join-Path $PSScriptRoot 'windows-native-ab-installed-smoke.mjs') $releaseDir $Target
  if ($LASTEXITCODE -ne 0) { throw 'Windows exact native WPF A/B rollback acceptance failed.' }
  Write-Output "Windows $Target package-lane exact PE A/B rollback acceptance PASSED."
} finally {
  if ([IO.Directory]::Exists($fixture)) { Remove-Item -LiteralPath $fixture -Recurse -Force }
}
