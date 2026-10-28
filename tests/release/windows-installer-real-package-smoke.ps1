$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

# Real architecture-specific PACKAGE inspection + original signed Main-only
# installer fail-closed smoke. It does NOT claim that a test signer can mint
# the user's production Ed25519 selector or that signed B was installed.
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$Archive = $env:EQUINOX_WINDOWS_INSTALL_ARTIFACT
if ([string]::IsNullOrWhiteSpace($Archive) -or -not [IO.File]::Exists($Archive)) {
  throw 'Exact published Windows native archive is required.'
}
$Target = [string]$env:EQUINOX_WINDOWS_INSTALL_TARGET
$ExpectedSha = [string]$env:EQUINOX_WINDOWS_INSTALL_SHA256
$ExpectedBytes = [int64]$env:EQUINOX_WINDOWS_INSTALL_BYTES
$ExpectedSourceSha = [string]$env:EQUINOX_WINDOWS_INSTALL_SOURCE_SHA
$ExpectedVersion = [string]$env:EQUINOX_WINDOWS_INSTALL_VERSION
if ($Target -notin @('win32-x64','win32-arm64') -or
    $ExpectedSha -cnotmatch '^[a-f0-9]{64}$' -or
    $ExpectedSourceSha -cnotmatch '^[a-f0-9]{40}$' -or
    $ExpectedVersion -notmatch '^\d+\.\d+\.\d+$' -or
    $ExpectedBytes -lt 1) { throw 'Exact Windows Main native package metadata is missing.' }
if ((Get-Item -LiteralPath $Archive).Length -ne $ExpectedBytes -or
    (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ExpectedSha) {
  throw 'Original Windows native archive failed exact SHA256/byte verification.'
}
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$Zip = [IO.Compression.ZipFile]::OpenRead($Archive)
try {
  $Required = @(
    'release/release.json',
    'release/equinox-local-first-install.js',
    'release/scripts/install-equinox-local.ps1',
    'release/runtime/guardian/EquinoxLocalGuardian.exe'
  )
  foreach ($Name in $Required) {
    $Entry = $Zip.GetEntry($Name)
    if ($null -eq $Entry -or $Entry.Length -lt 1) { throw "Main Windows ZIP is missing $Name" }
  }
  $MetadataEntry = $Zip.GetEntry('release/release.json')
  $Reader = New-Object IO.StreamReader($MetadataEntry.Open(), (New-Object Text.UTF8Encoding($false, $true)))
  try { $Metadata = $Reader.ReadToEnd() | ConvertFrom-Json -ErrorAction Stop }
  finally { $Reader.Dispose() }
  if ($Metadata.schemaVersion -ne 1 -or
      $Metadata.sourceSha -cne $ExpectedSourceSha -or
      $Metadata.target -cne $Target -or
      $Metadata.version -cne $ExpectedVersion) {
    throw 'Main package release.json differs from the exact source SHA/target/version.'
  }
  $ScriptEntry = $Zip.GetEntry('release/scripts/install-equinox-local.ps1')
  $ScriptReader = New-Object IO.StreamReader($ScriptEntry.Open(), (New-Object Text.UTF8Encoding($false,$true)))
  try { $BundledInstaller = $ScriptReader.ReadToEnd() }
  finally { $ScriptReader.Dispose() }
  $PublicInstaller = [IO.File]::ReadAllText((Join-Path $Root 'scripts\install-equinox-local.ps1'))
  if ($BundledInstaller -cne $PublicInstaller) { throw 'Native Main archive does not contain the ONE original public PowerShell installer.' }
  if (-not $BundledInstaller.Contains('--install-main-fresh') -or
      $BundledInstaller.Contains('Read-BootstrapManifest')) {
    throw 'Original signed Main ZIP still contains a Stable-first installer.'
  }
  $Guardian = $Zip.GetEntry('release/runtime/guardian/EquinoxLocalGuardian.exe')
  $Stream = $Guardian.Open()
  try {
    $Head = New-Object byte[] 4096
    $Count = $Stream.Read($Head, 0, $Head.Length)
    if ($Count -lt 128 -or $Head[0] -ne 77 -or $Head[1] -ne 90) { throw 'Original native Guardian is not an executable PE image.' }
    $Offset = [BitConverter]::ToInt32($Head,60)
    if ($Offset -lt 64 -or $Offset -gt ($Count-6) -or
        $Head[$Offset] -ne 80 -or $Head[$Offset+1] -ne 69) {
      throw 'Original Windows Guardian PE header is malformed.'
    }
    $Machine = [BitConverter]::ToUInt16($Head,$Offset+4)
    $ExpectedMachine = if ($Target -ceq 'win32-arm64') { 0xAA64 } else { 0x8664 }
    if ($Machine -ne $ExpectedMachine) { throw 'Original Windows Guardian architecture does not match the package target.' }
  } finally { $Stream.Dispose() }
} finally { $Zip.Dispose() }

# Original Guardian installed-identity audit MUST refuse an executable that
# is merely copied out of a ZIP, even though its PE machine is correct.
$DisposableGuardian = Join-Path ([IO.Path]::GetTempPath()) ('equinox-main-audit-' + [Guid]::NewGuid().ToString('N') + '.exe')
try {
  $UntrustedArchive = [IO.Compression.ZipFile]::OpenRead($Archive)
  try {
    $Source = $UntrustedArchive.GetEntry('release/runtime/guardian/EquinoxLocalGuardian.exe').Open()
    try {
      $Sink = New-Object IO.FileStream($DisposableGuardian,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
      try { $Source.CopyTo($Sink) } finally { $Sink.Dispose() }
    } finally { $Source.Dispose() }
  } finally { $UntrustedArchive.Dispose() }
  $PreviousErrorPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & $DisposableGuardian --audit-installed-signed-main 2>$null | Out-Null
    $AuditExit = $LASTEXITCODE
  } finally { $ErrorActionPreference = $PreviousErrorPreference }
  if ($AuditExit -eq 0) { throw 'Original Windows Guardian accepted a foreign, uninstalled signed Main verifier.' }
} finally { Remove-Item -LiteralPath $DisposableGuardian -Force -ErrorAction SilentlyContinue }

& powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $Root 'tests\release\windows-installer-bootstrap-smoke.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Signed Main-only PowerShell fail-closed smoke failed.' }
Write-Output "Windows $Target real native ZIP metadata/installer/Guardian architecture PASSED; production-signed full install NOT asserted."
