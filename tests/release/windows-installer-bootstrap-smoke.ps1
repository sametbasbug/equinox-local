$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

# This is an OFFLINE pre-install gate, not a claimed full signed Main launch.
# The real signed selector cannot be fabricated in CI: the signing key must
# remain outside this repository and outside a disposable test runner.
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$Installer = Join-Path $Root 'scripts\install-equinox-local.ps1'
$Contents = [IO.File]::ReadAllText($Installer)
if (-not $Contents.Contains('Invoke-VerifiedMainPreparation') -or
    -not $Contents.Contains('--install-main-fresh') -or
    $Contents.Contains('Read-BootstrapManifest') -or
    $Contents.Contains('__EQUINOX_ZIP_HELPER_')) {
  throw 'One public PowerShell installer does not exclusively select signed Main.'
}
. $Installer
$Target = Get-NativeWindowsTarget
if ($Target -notin @('win32-x64','win32-arm64')) { throw 'Native Windows Main target was not resolved.' }

# Fail the signed download BEFORE any old program file may be retired.
# An unsigned/unreachable Main must not trigger deletion of user settings.
$SavedLocalAppData = $env:LOCALAPPDATA
$SavedTemp = $env:TEMP
$SavedTmp = $env:TMP
$Scratch = Join-Path ([IO.Path]::GetTempPath()) ('Main Installer Türk ' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($Scratch) | Out-Null
try {
  $env:LOCALAPPDATA = Join-Path $Scratch 'Local AppData'
  $env:TEMP = Join-Path $Scratch 'Temp'
  $env:TMP = $env:TEMP
  [IO.Directory]::CreateDirectory($env:TEMP) | Out-Null
  $State = Join-Path $env:LOCALAPPDATA 'Equinox Local'
  [IO.Directory]::CreateDirectory($State) | Out-Null
  $Sentinel = Join-Path $State 'config.json'
  [IO.File]::WriteAllText($Sentinel, '{"user_settings":"preserve"}')
  function Save-BoundedHttpsFile([string]$Url,[string]$Destination,[long]$MaxBytes) {
    throw 'offline-signed-Main-unavailable'
  }
  $failedClosed = $false
  try { Invoke-EquinoxLocalInstall | Out-Null }
  catch {
    if ($_.Exception.Message -notmatch 'offline-signed-Main-unavailable') { throw }
    $failedClosed = $true
  }
  if (-not $failedClosed) { throw 'Unsigned Main downloaded without required authorization.' }
  if ([IO.File]::ReadAllText($Sentinel) -cne '{"user_settings":"preserve"}') {
    throw 'Failed signed Main preflight changed user settings.'
  }
  if ([IO.Directory]::Exists((Join-Path $State '.equinox-signed-reinstall-backup'))) {
    throw 'Failed signed Main preflight started executable replacement.'
  }
  Write-Output "Windows $Target signed Main-only installer preflight: PASS (full install NOT tested)."
} finally {
  $env:LOCALAPPDATA = $SavedLocalAppData
  $env:TEMP = $SavedTemp
  $env:TMP = $SavedTmp
  Remove-Item -LiteralPath $Scratch -Recurse -Force -ErrorAction SilentlyContinue
}
