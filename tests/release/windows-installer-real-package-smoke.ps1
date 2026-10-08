$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$InstallerTemplate = Join-Path $Root 'scripts\install-equinox-local.ps1'
$HelperSource = Join-Path $Root 'src\equinox-local-windows-release-zip.ps1'
$Artifact = [string]$env:EQUINOX_WINDOWS_INSTALL_ARTIFACT
$NativeRegistryKey = 'Registry::HKEY_CURRENT_USER\Software\Google\Chrome\NativeMessagingHosts\dev.equinox.browser'
$Work = Join-Path ([IO.Path]::GetTempPath()) ('Equinox Windows Fresh Install Türk ' + [Guid]::NewGuid().ToString('N'))

function Assert-True([bool]$Value, [string]$Message) { if (-not $Value) { throw $Message } }
function Same-Path([string]$Left, [string]$Right) {
  if ([string]::IsNullOrWhiteSpace($Left) -or [string]::IsNullOrWhiteSpace($Right)) { return $false }
  return [IO.Path]::GetFullPath($Left).TrimEnd('\').ToLowerInvariant() -ceq [IO.Path]::GetFullPath($Right).TrimEnd('\').ToLowerInvariant()
}
function Read-PeMachine([string]$Path) {
  $bytes = [IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -lt 256) { throw "PE file is too small: $Path" }
  $offset = [BitConverter]::ToInt32($bytes, 0x3c)
  if ($offset -lt 0 -or ($offset + 6) -gt $bytes.Length) { throw "PE header is invalid: $Path" }
  if ([Text.Encoding]::ASCII.GetString($bytes, $offset, 4) -cne "PE`0`0") { throw "PE signature is invalid: $Path" }
  return [BitConverter]::ToUInt16($bytes, $offset + 4)
}
function Stop-OwnedShell([string]$StableExe) {
  $owned = @(Get-CimInstance Win32_Process -Filter "Name='EquinoxLocal.exe'" -ErrorAction SilentlyContinue | Where-Object {
    -not [string]::IsNullOrWhiteSpace($_.ExecutablePath) -and (Same-Path $_.ExecutablePath $StableExe)
  })
  foreach ($process in $owned) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 750
}

[IO.Directory]::CreateDirectory($Work) | Out-Null
$OriginalLocalAppData = $env:LOCALAPPDATA
$OriginalTemp = $env:TEMP
$OriginalTmp = $env:TMP
$OwnedInstallRoot = $null
$OwnedProgramRoot = $null
$ExpectedManifestPath = $null
$StableExe = $null

try {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Real Windows installer smoke requires Windows.' }
  if (-not [Environment]::Is64BitProcess -or -not [string]::IsNullOrWhiteSpace($env:PROCESSOR_ARCHITEW6432)) { throw 'Real Windows installer smoke requires native 64-bit Windows PowerShell.' }
  if ([string]::IsNullOrWhiteSpace($Artifact) -or -not [IO.Path]::IsPathRooted($Artifact) -or -not [IO.File]::Exists($Artifact)) { throw 'EQUINOX_WINDOWS_INSTALL_ARTIFACT must point to the real native managed ZIP.' }
  if (Test-Path -LiteralPath $NativeRegistryKey) { throw 'Fresh-install smoke requires an unowned Native Messaging registry key.' }

  $fixtureMetadata = @(
    [string]$env:EQUINOX_WINDOWS_INSTALL_TARGET,
    [string]$env:EQUINOX_WINDOWS_INSTALL_VERSION,
    [string]$env:EQUINOX_WINDOWS_INSTALL_SOURCE_SHA,
    [string]$env:EQUINOX_WINDOWS_INSTALL_SHA256,
    [string]$env:EQUINOX_WINDOWS_INSTALL_BYTES
  )
  $useVerifiedMetadata = -not [string]::IsNullOrWhiteSpace($fixtureMetadata[0])
  if ($useVerifiedMetadata -and @($fixtureMetadata | Where-Object { [string]::IsNullOrWhiteSpace($_) }).Count -ne 0) { throw 'Verified installer fixture metadata is incomplete.' }
  if ($useVerifiedMetadata) {
    $FixtureTarget = $fixtureMetadata[0]
    $FixtureVersion = $fixtureMetadata[1]
    $FixtureSourceSha = $fixtureMetadata[2]
    $artifactSha = $fixtureMetadata[3]
    $artifactBytes = [int64]$fixtureMetadata[4]
  } else {
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($Artifact)
    try {
      $entry = $zip.GetEntry('release/release.json')
      if ($null -eq $entry) { throw 'Managed ZIP is missing release/release.json.' }
      $reader = New-Object IO.StreamReader($entry.Open(), (New-Object Text.UTF8Encoding($false, $true)))
      try { $metadata = ($reader.ReadToEnd() | ConvertFrom-Json) } finally { $reader.Dispose() }
    } finally { $zip.Dispose() }
    if ($metadata.schemaVersion -ne 1 -or [string]::IsNullOrWhiteSpace($metadata.target) -or [string]::IsNullOrWhiteSpace($metadata.version)) { throw 'Managed ZIP metadata is invalid.' }
    $FixtureTarget = [string]$metadata.target
    $FixtureVersion = [string]$metadata.version
    $FixtureSourceSha = [string]$metadata.sourceSha
    $artifactBytes = (Get-Item -LiteralPath $Artifact).Length
    $artifactSha = (Get-FileHash -LiteralPath $Artifact -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  if ($FixtureTarget -notin @('win32-x64','win32-arm64')) { throw 'Managed ZIP target is unsupported.' }
  if ($FixtureSourceSha -cnotmatch '^[a-f0-9]{40}$') { throw 'Managed ZIP sourceSha is invalid.' }
  if ($FixtureVersion -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') { throw 'Managed ZIP version is invalid.' }
  if ($artifactSha -cnotmatch '^[a-f0-9]{64}$' -or $artifactBytes -lt 1 -or (Get-Item -LiteralPath $Artifact).Length -ne $artifactBytes) { throw 'Managed ZIP verified identity is invalid.' }
  $FixtureExpectedMachine = if ($FixtureTarget -ceq 'win32-arm64') { 0xAA64 } else { 0x8664 }

  $helperBytes = (Get-Item -LiteralPath $HelperSource).Length
  $helperSha = (Get-FileHash -LiteralPath $HelperSource -Algorithm SHA256).Hash.ToLowerInvariant()
  $materialized = (Get-Content -LiteralPath $InstallerTemplate -Raw).Replace('__EQUINOX_ZIP_HELPER_SHA256__', $helperSha).Replace('__EQUINOX_ZIP_HELPER_BYTES__', [string]$helperBytes)
  if ($materialized.Contains('__EQUINOX_ZIP_HELPER_')) { throw 'Installer helper pins were not materialized.' }
  $Installer = Join-Path $Work 'install-equinox-local.materialized.ps1'
  [IO.File]::WriteAllText($Installer, $materialized, (New-Object Text.UTF8Encoding($false)))
  . $Installer
  Assert-True ((Get-NativeWindowsTarget) -ceq $FixtureTarget) "Public installer did not select $FixtureTarget on the native runner."

  $Manifest = Join-Path $Work ("bootstrap-$FixtureTarget.txt")
  $manifestText = @('schemaVersion=1', 'channel=stable', "target=$FixtureTarget", "version=$FixtureVersion", "artifactUrl=https://local.sametbasbug.dev/downloads/updates/equinox-local-$FixtureVersion-$FixtureTarget.zip", "artifactSha256=$artifactSha", "artifactBytes=$artifactBytes", '') -join "`n"
  [IO.File]::WriteAllText($Manifest, $manifestText, (New-Object Text.UTF8Encoding($false)))

  $KnownLocalAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
  if ([string]::IsNullOrWhiteSpace($KnownLocalAppData) -or -not [IO.Path]::IsPathRooted($KnownLocalAppData)) { throw 'Windows Known Folder LocalApplicationData is unavailable.' }
  $OwnedInstallRoot = Join-Path $KnownLocalAppData 'Equinox Local'
  $OwnedProgramRoot = Join-Path $KnownLocalAppData 'Programs\Equinox Local'
  if ([IO.Directory]::Exists($OwnedInstallRoot) -or [IO.File]::Exists($OwnedInstallRoot)) { throw 'Fresh-install smoke requires an unused real per-user Equinox Local install root.' }
  if ([IO.Directory]::Exists($OwnedProgramRoot) -or [IO.File]::Exists($OwnedProgramRoot)) { throw 'Fresh-install smoke requires an unused real per-user stable program root.' }

  $BootstrapTemp = Join-Path $Work 'Windows Türk Bootstrap Temp'
  [IO.Directory]::CreateDirectory($BootstrapTemp) | Out-Null
  # The real WPF shell resolves LocalApplicationData through the Windows Known Folder API.
  # Keep the installer on that same real per-user root; only TEMP/TMP stay isolated.
  $env:LOCALAPPDATA = $KnownLocalAppData; $env:TEMP = $BootstrapTemp; $env:TMP = $BootstrapTemp

  function Save-BoundedHttpsFile([string]$Url, [string]$Destination, [long]$MaxBytes) {
    if ($Url.EndsWith("/bootstrap-$script:FixtureTarget.txt")) { Copy-Item -LiteralPath $script:Manifest -Destination $Destination; return }
    if ($Url.EndsWith('/equinox-local-windows-release-zip.ps1')) { Copy-Item -LiteralPath $script:HelperSource -Destination $Destination; return }
    if ($Url.EndsWith("/equinox-local-$script:FixtureVersion-$script:FixtureTarget.zip")) {
      try { New-Item -ItemType HardLink -Path $Destination -Target $script:Artifact -ErrorAction Stop | Out-Null }
      catch { Copy-Item -LiteralPath $script:Artifact -Destination $Destination }
      return
    }
    throw "unexpected Windows fresh-install URL: $Url"
  }

  try {
    # This smoke intentionally accepts Main onboarding, not default Stable.
    $EnrollExistingMain = $true
    Invoke-EquinoxLocalInstall | Out-Host
  } catch {
    $diagnosticLog = Join-Path $OwnedInstallRoot 'logs\windows-shell-runtime.log'
    $stableCandidate = Join-Path $OwnedProgramRoot 'EquinoxLocal.exe'
    $ownedCount = 0
    if ([IO.File]::Exists($stableCandidate)) {
      $ownedCount = @((Get-CimInstance Win32_Process -Filter "Name='EquinoxLocal.exe'" -ErrorAction SilentlyContinue | Where-Object { -not [string]::IsNullOrWhiteSpace($_.ExecutablePath) -and (Same-Path $_.ExecutablePath $stableCandidate) })).Count
    }
    Write-Output ("Windows fresh-install diagnostic: pointer={0}; stableExe={1}; ownedShellCount={2}; runtimeLog={3}" -f [IO.File]::Exists((Join-Path $OwnedInstallRoot 'current-version.json')), [IO.File]::Exists($stableCandidate), $ownedCount, [IO.File]::Exists($diagnosticLog))
    if ([IO.File]::Exists($diagnosticLog)) {
      $tail = [IO.File]::ReadAllText($diagnosticLog, (New-Object Text.UTF8Encoding($false, $true)))
      if ($tail.Length -gt 4000) { $tail = $tail.Substring($tail.Length - 4000) }
      Write-Output ("Windows fresh-install runtime diagnostic tail: " + $tail.Replace("`r", ' ').Replace("`n", ' '))
    }
    throw
  }

  $InstallRoot = $OwnedInstallRoot
  $pointer = [IO.File]::ReadAllText((Join-Path $InstallRoot 'current-version.json'), (New-Object Text.UTF8Encoding($false, $true))) | ConvertFrom-Json
  Assert-True ($pointer.schemaVersion -eq 1) 'Windows current-version schema mismatch.'
  Assert-True ($pointer.target -ceq $FixtureTarget) 'Windows current-version target mismatch.'
  Assert-True ($pointer.version -ceq $FixtureVersion) 'Windows current-version version mismatch.'
  $ReleaseDir = Join-Path (Join-Path $InstallRoot 'releases') $FixtureVersion
  $StableExe = Join-Path $OwnedProgramRoot 'EquinoxLocal.exe'
  Assert-True ([IO.File]::Exists($StableExe)) 'Windows stable EquinoxLocal.exe is missing after fresh install.'
  Assert-True ((Read-PeMachine $StableExe) -eq $FixtureExpectedMachine) 'Windows stable EquinoxLocal.exe has the wrong PE architecture.'

  $ExpectedManifestPath = Join-Path $InstallRoot 'browser\native-messaging\dev.equinox.browser.json'
  Assert-True ([IO.File]::Exists($ExpectedManifestPath)) 'Windows Native Messaging manifest is missing after fresh install.'
  $registeredManifest = [string](Get-Item -LiteralPath $NativeRegistryKey -ErrorAction Stop).GetValue('')
  Assert-True (Same-Path $registeredManifest $ExpectedManifestPath) 'Windows Native Messaging registry value does not own the expected manifest.'
  $nativeManifest = [IO.File]::ReadAllText($ExpectedManifestPath, (New-Object Text.UTF8Encoding($false, $true))) | ConvertFrom-Json
  $ExpectedLauncher = Join-Path $ReleaseDir 'runtime\browser\equinox-browser-native-host.exe'
  Assert-True (Same-Path ([string]$nativeManifest.path) $ExpectedLauncher) 'Windows Native Messaging manifest does not point at the promoted launcher.'
  Assert-True ((Read-PeMachine $ExpectedLauncher) -eq $FixtureExpectedMachine) 'Promoted Native Messaging launcher has the wrong PE architecture.'

  $status = (Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:24891/api/v1/status' -TimeoutSec 5).Content | ConvertFrom-Json
  Assert-True ($status.ok -eq $true) 'Windows Control Center status endpoint is not healthy after installer launch.'
  Assert-True ([string]$status.status.server.version -ceq $FixtureVersion) 'Windows runtime version does not match the installed release.'
  Assert-True ([string]$status.status.installation.kind -ceq 'managed-source') 'Windows fresh install did not enter managed-source mode.'
  Assert-True ([string]$status.status.installation.sourceSha -ceq $FixtureSourceSha) 'Windows managed-source runtime SHA does not match release sourceSha.'
  $ManagedSourceRoot = Join-Path $InstallRoot ("state\main-update\sources\$FixtureSourceSha")
  Assert-True ([IO.File]::Exists((Join-Path $ManagedSourceRoot 'src\server.js'))) 'Windows managed-source checkout is missing the exact source server.'
  $OwnedGit = Join-Path $InstallRoot ("runtime\toolchain\git\2.53.0-4\$FixtureTarget\cmd\git.exe")
  $OwnedNode = Join-Path $InstallRoot ("runtime\toolchain\node\26.11.1\$FixtureTarget\node.exe")
  $OwnedNpm = Join-Path $InstallRoot ("runtime\toolchain\node\26.11.1\$FixtureTarget\node_modules\npm\bin\npm-cli.js")
  foreach ($owned in @($OwnedGit,$OwnedNode,$OwnedNpm)) { Assert-True ([IO.File]::Exists($owned)) ("Product-owned toolchain file is missing: $owned") }
  Assert-True ((& $OwnedGit --version) -match '^git version 2\.53\.0\b') 'Product-owned Git version mismatch.'
  Assert-True ((& $OwnedNode --version) -ceq 'v26.11.1') 'Product-owned Node version mismatch.'
  Assert-True ((& $OwnedNode $OwnedNpm --version) -match '^\d+\.\d+\.\d+$') 'Product-owned npm CLI did not execute.'
  $ownedShell = @(Get-CimInstance Win32_Process -Filter "Name='EquinoxLocal.exe'" -ErrorAction SilentlyContinue | Where-Object { -not [string]::IsNullOrWhiteSpace($_.ExecutablePath) -and (Same-Path $_.ExecutablePath $StableExe) })
  Assert-True ($ownedShell.Count -eq 1) 'Windows installer did not leave exactly one owned stable shell running.'
  if ($env:EQUINOX_WINDOWS_MAIN_ACCEPT_TARGET_SHA) {
    if ($env:GITHUB_ACTIONS -cne 'true' -or [string]$env:EQUINOX_WINDOWS_MAIN_ACCEPT_TARGET_SHA -cnotmatch '^[a-f0-9]{40}$') { throw 'Real installed Windows Main acceptance requires an isolated hosted runner and an exact target SHA.' }
    if ($env:EQUINOX_WINDOWS_MAIN_ACCEPT_TARGET_SHA -ceq $FixtureSourceSha) { throw 'Installed Main acceptance target must differ from A.' }
    & node (Join-Path $Root 'tests/release/smoke-main-upgrade-windows.mjs') $InstallRoot $FixtureSourceSha $env:EQUINOX_WINDOWS_MAIN_ACCEPT_TARGET_SHA
    if ($LASTEXITCODE -ne 0) { throw "Real installed Windows Main update smoke exited with code $LASTEXITCODE" }
    # This shell and Native Messaging are real native OS state, not mocked
    # transaction callbacks. reuse_native MUST preserve their ownership.
    $afterShell = @(Get-CimInstance Win32_Process -Filter "Name='EquinoxLocal.exe'" -ErrorAction SilentlyContinue | Where-Object { -not [string]::IsNullOrWhiteSpace($_.ExecutablePath) -and (Same-Path $_.ExecutablePath $StableExe) })
    Assert-True ($afterShell.Count -eq 1) 'Real Main update did not preserve exactly one healthy native stable shell process.'
    $afterRegistry = [string](Get-Item -LiteralPath $NativeRegistryKey -ErrorAction Stop).GetValue('')
    Assert-True (Same-Path $afterRegistry $ExpectedManifestPath) 'Native Messaging registry identity changed during source-only Main update.'
    $afterManifest = [IO.File]::ReadAllText($ExpectedManifestPath, (New-Object Text.UTF8Encoding($false, $true))) | ConvertFrom-Json
    Assert-True (Same-Path ([string]$afterManifest.path) $ExpectedLauncher) 'Native Messaging executable identity changed during source-only Main update.'
    Write-Output "Real Windows $FixtureTarget installed Main A-to-B native shell and Native Messaging acceptance PASSED."
  }
  Write-Output "Windows $FixtureTarget real fresh-install managed-source acceptance passed: public installer promoted $FixtureVersion at $FixtureSourceSha and served the exact managed source runtime."
} finally {
  if (-not [string]::IsNullOrWhiteSpace($StableExe) -and [IO.File]::Exists($StableExe)) { Stop-OwnedShell $StableExe }
  if (Test-Path -LiteralPath $NativeRegistryKey) {
    try {
      $value = [string](Get-Item -LiteralPath $NativeRegistryKey -ErrorAction Stop).GetValue('')
      if (-not [string]::IsNullOrWhiteSpace($ExpectedManifestPath) -and (Same-Path $value $ExpectedManifestPath)) { Remove-Item -LiteralPath $NativeRegistryKey -Recurse -Force }
    } catch { Write-Warning $_.Exception.Message }
  }
  if (-not [string]::IsNullOrWhiteSpace($OwnedInstallRoot) -and [IO.Directory]::Exists($OwnedInstallRoot)) { Remove-Item -LiteralPath $OwnedInstallRoot -Recurse -Force -ErrorAction SilentlyContinue }
  if (-not [string]::IsNullOrWhiteSpace($OwnedProgramRoot) -and [IO.Directory]::Exists($OwnedProgramRoot)) { Remove-Item -LiteralPath $OwnedProgramRoot -Recurse -Force -ErrorAction SilentlyContinue }
  $env:LOCALAPPDATA = $OriginalLocalAppData; $env:TEMP = $OriginalTemp; $env:TMP = $OriginalTmp
  Remove-Item Function:\Save-BoundedHttpsFile -ErrorAction SilentlyContinue
  if ([IO.Directory]::Exists($Work)) { Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue }
}
