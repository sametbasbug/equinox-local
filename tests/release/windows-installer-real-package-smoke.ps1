$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$InstallerTemplate = Join-Path $Root 'scripts\install-equinox-local.ps1'
$HelperSource = Join-Path $Root 'src\equinox-local-windows-release-zip.ps1'
$Artifact = [string]$env:EQUINOX_WINDOWS_INSTALL_ARTIFACT
$NativeRegistryKey = 'Registry::HKEY_CURRENT_USER\Software\Google\Chrome\NativeMessagingHosts\dev.equinox.browser'
$Work = Join-Path ([IO.Path]::GetTempPath()) ('Equinox ARM64 Fresh Install Türk ' + [Guid]::NewGuid().ToString('N'))

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
$OriginalUserProfile = $env:USERPROFILE
$OriginalLocalAppData = $env:LOCALAPPDATA
$OriginalAppData = $env:APPDATA
$OriginalTemp = $env:TEMP
$OriginalTmp = $env:TMP
$ExpectedManifestPath = $null
$StableExe = $null

try {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Real Windows installer smoke requires Windows.' }
  if (-not [Environment]::Is64BitProcess -or $env:PROCESSOR_ARCHITECTURE -ne 'ARM64' -or -not [string]::IsNullOrWhiteSpace($env:PROCESSOR_ARCHITEW6432)) { throw 'Real Windows installer smoke requires native ARM64 Windows PowerShell.' }
  if ([string]::IsNullOrWhiteSpace($Artifact) -or -not [IO.Path]::IsPathRooted($Artifact) -or -not [IO.File]::Exists($Artifact)) { throw 'EQUINOX_WINDOWS_INSTALL_ARTIFACT must point to the real ARM64 managed ZIP.' }
  if (Test-Path -LiteralPath $NativeRegistryKey) { throw 'ARM64 fresh-install smoke requires an unowned Native Messaging registry key.' }

  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($Artifact)
  try {
    $entry = $zip.GetEntry('release/release.json')
    if ($null -eq $entry) { throw 'Managed ZIP is missing release/release.json.' }
    $reader = New-Object IO.StreamReader($entry.Open(), (New-Object Text.UTF8Encoding($false, $true)))
    try { $metadata = ($reader.ReadToEnd() | ConvertFrom-Json) } finally { $reader.Dispose() }
  } finally { $zip.Dispose() }
  if ($metadata.schemaVersion -ne 1 -or $metadata.target -cne 'win32-arm64' -or [string]::IsNullOrWhiteSpace($metadata.version)) { throw 'Managed ZIP metadata is not a win32-arm64 release.' }
  $Version = [string]$metadata.version
  if ($Version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') { throw 'Managed ZIP version is invalid.' }

  $helperBytes = (Get-Item -LiteralPath $HelperSource).Length
  $helperSha = (Get-FileHash -LiteralPath $HelperSource -Algorithm SHA256).Hash.ToLowerInvariant()
  $materialized = (Get-Content -LiteralPath $InstallerTemplate -Raw).Replace('__EQUINOX_ZIP_HELPER_SHA256__', $helperSha).Replace('__EQUINOX_ZIP_HELPER_BYTES__', [string]$helperBytes)
  if ($materialized.Contains('__EQUINOX_ZIP_HELPER_')) { throw 'Installer helper pins were not materialized.' }
  $Installer = Join-Path $Work 'install-equinox-local.materialized.ps1'
  [IO.File]::WriteAllText($Installer, $materialized, (New-Object Text.UTF8Encoding($false)))
  . $Installer
  Assert-True ((Get-NativeWindowsTarget) -ceq 'win32-arm64') 'Public installer did not select win32-arm64 on the native ARM64 runner.'

  $artifactBytes = (Get-Item -LiteralPath $Artifact).Length
  $artifactSha = (Get-FileHash -LiteralPath $Artifact -Algorithm SHA256).Hash.ToLowerInvariant()
  $Manifest = Join-Path $Work 'bootstrap-win32-arm64.txt'
  $manifestText = @('schemaVersion=1', 'channel=stable', 'target=win32-arm64', "version=$Version", "artifactUrl=https://local.sametbasbug.dev/downloads/updates/equinox-local-$Version-win32-arm64.zip", "artifactSha256=$artifactSha", "artifactBytes=$artifactBytes", '') -join "`n"
  [IO.File]::WriteAllText($Manifest, $manifestText, (New-Object Text.UTF8Encoding($false)))

  $UserHome = Join-Path $Work 'ARM Türk User Home'
  $LocalState = Join-Path $Work 'ARM Türk Local App Data'
  $RoamingState = Join-Path $Work 'ARM Türk Roaming App Data'
  $BootstrapTemp = Join-Path $Work 'ARM Türk Bootstrap Temp'
  foreach ($directory in @($UserHome, $LocalState, $RoamingState, $BootstrapTemp)) { [IO.Directory]::CreateDirectory($directory) | Out-Null }
  $env:USERPROFILE = $UserHome; $env:LOCALAPPDATA = $LocalState; $env:APPDATA = $RoamingState; $env:TEMP = $BootstrapTemp; $env:TMP = $BootstrapTemp

  function Save-BoundedHttpsFile([string]$Url, [string]$Destination, [long]$MaxBytes) {
    if ($Url.EndsWith('/bootstrap-win32-arm64.txt')) { Copy-Item -LiteralPath $script:Manifest -Destination $Destination; return }
    if ($Url.EndsWith('/equinox-local-windows-release-zip.ps1')) { Copy-Item -LiteralPath $script:HelperSource -Destination $Destination; return }
    if ($Url.EndsWith("/equinox-local-$script:Version-win32-arm64.zip")) { Copy-Item -LiteralPath $script:Artifact -Destination $Destination; return }
    throw "unexpected ARM64 fresh-install URL: $Url"
  }

  Invoke-EquinoxLocalInstall | Out-Host

  $InstallRoot = Join-Path $LocalState 'Equinox Local'
  $pointer = [IO.File]::ReadAllText((Join-Path $InstallRoot 'current-version.json'), (New-Object Text.UTF8Encoding($false, $true))) | ConvertFrom-Json
  Assert-True ($pointer.schemaVersion -eq 1) 'ARM64 current-version schema mismatch.'
  Assert-True ($pointer.target -ceq 'win32-arm64') 'ARM64 current-version target mismatch.'
  Assert-True ($pointer.version -ceq $Version) 'ARM64 current-version version mismatch.'
  $ReleaseDir = Join-Path (Join-Path $InstallRoot 'releases') $Version
  $StableExe = Join-Path $LocalState 'Programs\Equinox Local\EquinoxLocal.exe'
  Assert-True ([IO.File]::Exists($StableExe)) 'ARM64 stable EquinoxLocal.exe is missing after fresh install.'
  Assert-True ((Read-PeMachine $StableExe) -eq 0xAA64) 'ARM64 stable EquinoxLocal.exe has the wrong PE architecture.'

  $ExpectedManifestPath = Join-Path $InstallRoot 'browser\native-messaging\dev.equinox.browser.json'
  Assert-True ([IO.File]::Exists($ExpectedManifestPath)) 'ARM64 Native Messaging manifest is missing after fresh install.'
  $registeredManifest = [string](Get-Item -LiteralPath $NativeRegistryKey -ErrorAction Stop).GetValue('')
  Assert-True (Same-Path $registeredManifest $ExpectedManifestPath) 'ARM64 Native Messaging registry value does not own the expected manifest.'
  $nativeManifest = [IO.File]::ReadAllText($ExpectedManifestPath, (New-Object Text.UTF8Encoding($false, $true))) | ConvertFrom-Json
  $ExpectedLauncher = Join-Path $ReleaseDir 'runtime\browser\equinox-browser-native-host.exe'
  Assert-True (Same-Path ([string]$nativeManifest.path) $ExpectedLauncher) 'ARM64 Native Messaging manifest does not point at the promoted launcher.'
  Assert-True ((Read-PeMachine $ExpectedLauncher) -eq 0xAA64) 'Promoted Native Messaging launcher has the wrong PE architecture.'

  $status = (Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:24891/api/v1/status' -TimeoutSec 5).Content | ConvertFrom-Json
  Assert-True ($status.ok -eq $true) 'ARM64 Control Center status endpoint is not healthy after installer launch.'
  Assert-True ([string]$status.status.server.version -ceq $Version) 'ARM64 runtime version does not match the installed release.'
  $ownedShell = @(Get-CimInstance Win32_Process -Filter "Name='EquinoxLocal.exe'" -ErrorAction SilentlyContinue | Where-Object { -not [string]::IsNullOrWhiteSpace($_.ExecutablePath) -and (Same-Path $_.ExecutablePath $StableExe) })
  Assert-True ($ownedShell.Count -eq 1) 'ARM64 installer did not leave exactly one owned stable shell running.'
  Write-Output "Windows ARM64 real fresh-install acceptance passed: public installer selected win32-arm64, promoted $Version, registered Native Messaging, launched the ARM64 stable shell and served the matching runtime."
} finally {
  if (-not [string]::IsNullOrWhiteSpace($StableExe) -and [IO.File]::Exists($StableExe)) { Stop-OwnedShell $StableExe }
  if (Test-Path -LiteralPath $NativeRegistryKey) {
    try {
      $value = [string](Get-Item -LiteralPath $NativeRegistryKey -ErrorAction Stop).GetValue('')
      if (-not [string]::IsNullOrWhiteSpace($ExpectedManifestPath) -and (Same-Path $value $ExpectedManifestPath)) { Remove-Item -LiteralPath $NativeRegistryKey -Recurse -Force }
    } catch { Write-Warning $_.Exception.Message }
  }
  $env:USERPROFILE = $OriginalUserProfile; $env:LOCALAPPDATA = $OriginalLocalAppData; $env:APPDATA = $OriginalAppData; $env:TEMP = $OriginalTemp; $env:TMP = $OriginalTmp
  Remove-Item Function:\Save-BoundedHttpsFile -ErrorAction SilentlyContinue
  if ([IO.Directory]::Exists($Work)) { Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue }
}
