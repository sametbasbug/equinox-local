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
    # Exercise the public installer DEFAULT. Main enrollment must no longer
    # require a legacy explicit switch or a second installation command.
    Assert-True (-not $EnrollExistingMain) 'Windows public installer acceptance requires an unselected legacy Main switch.'
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

  # Exercise the real independent Guardian binary on a disposable hosted runner
  # without changing Start Menu, Installed Apps, autostart or the running WPF.
  $GuardianFromRelease = Join-Path $ReleaseDir 'runtime\guardian\EquinoxLocalGuardian.exe'
  Assert-True ([IO.File]::Exists($GuardianFromRelease)) 'Windows package is missing the independent Guardian executable.'
  Assert-True ((Read-PeMachine $GuardianFromRelease) -eq $FixtureExpectedMachine) 'Independent Guardian CPU target is wrong.'
  # The product installer, not the test, now provisions this independent
  # executable. Registration still intentionally points to the existing WPF.
  $GuardianInstallDir = Join-Path $OwnedInstallRoot 'runtime\guardian'
  $GuardianExe = Join-Path $GuardianInstallDir 'EquinoxLocalGuardian.exe'
  Assert-True ([IO.File]::Exists($GuardianExe)) 'Windows installer did not provision the independent Guardian.'
  Assert-True ((Get-FileHash -LiteralPath $GuardianExe -Algorithm SHA256).Hash -ceq (Get-FileHash -LiteralPath $GuardianFromRelease -Algorithm SHA256).Hash) 'Installed Guardian differs from the verified release bytes.'
  # A native WinExe is a GUI-subsystem executable. Windows PowerShell's `&`
  # operator may return immediately without waiting or updating LASTEXITCODE.
  # Explicitly wait for the process handle rather than making a false pass/fail.
  function Invoke-GuardianCheck([string]$Argument) {
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $GuardianExe
    $start.Arguments = $Argument
    $start.UseShellExecute = $false
    $start.RedirectStandardError = $true
    $process = [System.Diagnostics.Process]::Start($start)
    if ($null -eq $process) { throw 'Independent Windows Guardian process could not launch.' }
    try {
      if (-not $process.WaitForExit(30000)) {
        $process.Kill()
        throw 'Independent Windows Guardian exceeded its 30-second inspection limit.'
      }
      $diagnostic = $process.StandardError.ReadToEnd().Trim()
      if (($Argument -ceq '--inspect' -or $Argument -ceq '--audit-native-identity' -or $Argument -ceq '--audit-native-journal') -and $process.ExitCode -ne 0) {
        Write-Host ('Windows Guardian inspection diagnosis: ' + $diagnostic)
      }
      return [int]$process.ExitCode
    } finally { $process.Dispose() }
  }
  Assert-True ((Invoke-GuardianCheck '--inspect') -eq 0) 'Independent Windows Guardian rejected an intact, installed signed Stable WPF baseline.'
  Assert-True ((Invoke-GuardianCheck '--unsupported-argument') -eq 70) 'Independent Windows Guardian accepted an unsupported argument.'
  $FakeMainLock = Join-Path $OwnedInstallRoot 'state\main-update\active.json'
  if ([IO.File]::Exists($FakeMainLock)) { throw 'Unexpected live Main update lock in disposable Guardian acceptance.' }
  try {
    [IO.File]::WriteAllText($FakeMainLock, 'unowned-test-lock')
    Assert-True ((Invoke-GuardianCheck '--inspect') -eq 70) 'Independent Windows Guardian did not fail closed on an unresolved Main update lock.'
  } finally { Remove-Item -LiteralPath $FakeMainLock -Force -ErrorAction SilentlyContinue }
  Write-Output "Windows $FixtureTarget independent native Guardian installed-host positive/negative admission PASSED."


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
  if ($env:EQUINOX_WINDOWS_STABLE_BRIDGE_ACCEPTANCE -ceq 'true') {
    if ($env:GITHUB_ACTIONS -cne 'true') { throw 'Native Stable bridge acceptance requires a disposable hosted runner.' }
    & node (Join-Path $Root 'tests/release/smoke-stable-main-bridge-windows.mjs') $InstallRoot $ReleaseDir $FixtureVersion $FixtureSourceSha
    if ($LASTEXITCODE -ne 0) { throw 'Real Windows WPF Stable-to-Main bridge recovery acceptance failed.' }
  }
  $ManagedSourceRoot = Join-Path $InstallRoot ("state\main-update\sources\$FixtureSourceSha")
  Assert-True ([IO.File]::Exists((Join-Path $ManagedSourceRoot 'src\server.js'))) 'Windows managed-source checkout is missing the exact source server.'
  # A disposable hosted Windows checkout must be clean under the same pinned
  # Git and sanitized environment as the independent Guardian. Emit counts
  # only, never filenames or private paths, to distinguish genuine mutations
  # from inherited Git configuration drift.
  $OwnedGitStatusExe = Join-Path $InstallRoot ("runtime\toolchain\git\2.53.0-4\$FixtureTarget\cmd\git.exe")
  Assert-True ([IO.File]::Exists($OwnedGitStatusExe)) 'Main Git status diagnostic is missing the product-owned Git.'
  $SavedGitEnvironment = @{}
  foreach ($entry in @(Get-ChildItem Env: | Where-Object { $_.Name -like 'GIT_*' })) {
    $SavedGitEnvironment[$entry.Name] = $entry.Value
    [Environment]::SetEnvironmentVariable($entry.Name, $null, 'Process')
  }
  try {
    $env:GIT_OPTIONAL_LOCKS = '0'; $env:GIT_TERMINAL_PROMPT = '0'; $env:GIT_CONFIG_NOSYSTEM = '1'
    $GitStatusStopwatch = [Diagnostics.Stopwatch]::StartNew()
    $OwnedGitStatus = @(& $OwnedGitStatusExe -c core.autocrlf=true -c core.fsmonitor=false -C $ManagedSourceRoot status --porcelain=v1 --untracked-files=normal)
    $OwnedGitStatusCode = $LASTEXITCODE
    $GitStatusStopwatch.Stop()
    $GitStatusLength = ([string]::Join([Environment]::NewLine, [string[]]$OwnedGitStatus)).Length
    $GitUntrackedCount = @($OwnedGitStatus | Where-Object { $_ -match '^\?\?' }).Count
    Write-Output ("Hosted Main Git status preflight: code={0}; lines={1}; chars={2}; untracked={3}; trackedChanges={4}; elapsedMs={5}" -f $OwnedGitStatusCode, $OwnedGitStatus.Count, $GitStatusLength, $GitUntrackedCount, ($OwnedGitStatus.Count - $GitUntrackedCount), $GitStatusStopwatch.ElapsedMilliseconds)
  } finally {
    foreach ($key in @('GIT_OPTIONAL_LOCKS','GIT_TERMINAL_PROMPT','GIT_CONFIG_NOSYSTEM')) { [Environment]::SetEnvironmentVariable($key,$null,'Process') }
    foreach ($entry in $SavedGitEnvironment.GetEnumerator()) { [Environment]::SetEnvironmentVariable($entry.Key,$entry.Value,'Process') }
  }
  Assert-True ($OwnedGitStatusCode -eq 0) 'Hosted product Git status preflight failed.'

  # The optional native Main audit is deliberately NOT a launcher or a release
  # authority: it binds pointer/store claims and hashes the installed shell,
  # but Git HEAD, full payload fingerprint and Native Messaging still need
  # independent attestation before activation. All fixtures stay on CI hosts.
  Assert-True ((Invoke-GuardianCheck '--audit-native-identity') -eq 70) 'Guardian native audit accepted a missing native pointer.'
  $NativeTxRoot = Join-Path $OwnedInstallRoot 'state\main-update'
  $NativeStoreProbe = Join-Path $NativeTxRoot ("native-store\$FixtureTarget\$FixtureSourceSha")
  $NativeReleaseProbe = Join-Path $NativeStoreProbe 'release'
  $NativePointerProbe = Join-Path $NativeTxRoot 'current-native.json'
  if ((Test-Path -LiteralPath $NativeStoreProbe) -or (Test-Path -LiteralPath $NativePointerProbe)) {
    throw 'Disposable Guardian Main identity test requires clean native state.'
  }
  $NativeMessagingOriginalBytes = $null
  $NativeMessagingOriginalOwner = $null
  try {
    $NativeRuntimeProbe = Join-Path $NativeReleaseProbe 'runtime'
    [IO.Directory]::CreateDirectory($NativeRuntimeProbe) | Out-Null
    Copy-Item -LiteralPath (Join-Path $ReleaseDir 'runtime\shell') -Destination (Join-Path $NativeRuntimeProbe 'shell') -Recurse -ErrorAction Stop
    # Main Native Messaging must be SHA-selected, not silently borrowed from
    # the previous Stable release. The hosted test temporarily binds its
    # disposable registry-owned manifest to the exact native slot.
    $NativeBrowserRuntime = Join-Path $ReleaseDir 'runtime\browser'
    Assert-True ([IO.File]::Exists((Join-Path $NativeBrowserRuntime 'equinox-browser-native-host.exe'))) 'Native Main identity test requires the signed release browser launcher.'
    Copy-Item -LiteralPath $NativeBrowserRuntime -Destination (Join-Path $NativeRuntimeProbe 'browser') -Recurse -ErrorAction Stop
    Copy-Item -LiteralPath (Join-Path $ReleaseDir 'release.json') -Destination (Join-Path $NativeReleaseProbe 'release.json') -ErrorAction Stop
    $NativeContract = 'b' * 64
    $OwnedFingerprintNode = Join-Path $InstallRoot ("runtime\toolchain\node\26.11.1\$FixtureTarget\node.exe")
    Assert-True ([IO.File]::Exists($OwnedFingerprintNode)) 'Native Main fingerprint fixture requires the owned Node executable.'
    $NativeFingerprintJson = & $OwnedFingerprintNode (Join-Path $Root 'tests/release/guardian-native-fingerprint-fixture.mjs') $NativeReleaseProbe
    if ($LASTEXITCODE -ne 0) { throw 'Canonical JS native release fingerprint fixture refused the disposable Main slot.' }
    $NativeFingerprint = $NativeFingerprintJson | ConvertFrom-Json
    Assert-True ([string]$NativeFingerprint.sha256 -cmatch '^[a-f0-9]{64}$') 'Canonical native Main fingerprint fixture is invalid.'
    $NativeManifestProbe = [ordered]@{
      schemaVersion=1; channel='main'; sourceSha=$FixtureSourceSha; target=$FixtureTarget;
      runtimeContractSha256=$NativeContract; artifactSha256=('d' * 64); artifactBytes=1024;
      payloadVersion=$FixtureVersion; releaseFingerprint=$NativeFingerprint
    }
    [IO.File]::WriteAllText((Join-Path $NativeStoreProbe 'native-store.json'), ($NativeManifestProbe | ConvertTo-Json -Depth 5))
    $NativePointerProbeValue = [ordered]@{schemaVersion=1;channel='main';sourceSha=$FixtureSourceSha;target=$FixtureTarget;runtimeContractSha256=$NativeContract}
    [IO.File]::WriteAllText($NativePointerProbe, ($NativePointerProbeValue | ConvertTo-Json -Depth 3))
    $NativeMessagingOriginalBytes = [IO.File]::ReadAllBytes($ExpectedManifestPath)
    $NativeMessagingOriginalOwner = [string](Get-Item -LiteralPath $NativeRegistryKey -ErrorAction Stop).GetValue('')
    $NativeMessagingProbe = [ordered]@{
      name='dev.equinox.browser'; description='Equinox Browser native messaging bridge';
      path=(Join-Path $NativeRuntimeProbe 'browser\equinox-browser-native-host.exe'); type='stdio';
      allowed_origins=@('chrome-extension://npdneefcobilfkjlihghjgjnknenhfoj/')
    }
    [IO.File]::WriteAllText($ExpectedManifestPath, ($NativeMessagingProbe | ConvertTo-Json -Depth 5))
    Assert-True ((Invoke-GuardianCheck '--audit-native-identity') -eq 0) 'Guardian did not authenticate exact Main native release, Git and Native Messaging identities.'
    $NativeMessagingProbe.allowed_origins = @('chrome-extension://kdjmfldngbfaillaamoinegmogfkhdfn/')
    [IO.File]::WriteAllText($ExpectedManifestPath, ($NativeMessagingProbe | ConvertTo-Json -Depth 5))
    Assert-True ((Invoke-GuardianCheck '--audit-native-identity') -eq 70) 'Guardian accepted a foreign or legacy extension ID.'
    $NativeMessagingProbe.allowed_origins = @('chrome-extension://npdneefcobilfkjlihghjgjnknenhfoj/')
    $NativeMessagingProbe.path = (Join-Path $ReleaseDir 'runtime\browser\equinox-browser-native-host.exe')
    [IO.File]::WriteAllText($ExpectedManifestPath, ($NativeMessagingProbe | ConvertTo-Json -Depth 5))
    Assert-True ((Invoke-GuardianCheck '--audit-native-identity') -eq 70) 'Guardian accepted the old Stable Native Messaging launcher instead of the selected Main native slot.'
    $NativeMessagingProbe.path = (Join-Path $NativeRuntimeProbe 'browser\equinox-browser-native-host.exe')
    [IO.File]::WriteAllText($ExpectedManifestPath, ($NativeMessagingProbe | ConvertTo-Json -Depth 5))
    $NativeMessagingRegistry = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Google\Chrome\NativeMessagingHosts\dev.equinox.browser', $true)
    if ($null -eq $NativeMessagingRegistry) { throw 'Hosted Native Messaging registry ownership fixture cannot open its exact key.' }
    try {
      $NativeMessagingRegistry.SetValue('', (Join-Path $Work 'foreign-native-host.json'), [Microsoft.Win32.RegistryValueKind]::String)
      Assert-True ((Invoke-GuardianCheck '--audit-native-identity') -eq 70) 'Guardian accepted a foreign Chrome Native Messaging registry owner.'
    } finally {
      $NativeMessagingRegistry.SetValue('', $NativeMessagingOriginalOwner, [Microsoft.Win32.RegistryValueKind]::String)
      $NativeMessagingRegistry.Dispose()
    }
    Assert-True ((Invoke-GuardianCheck '--audit-native-identity') -eq 0) 'Guardian refused the restored exact Native Messaging registration.'
    # Remaining native fingerprint/Git tests must run with the exact Main
    # Native Messaging registration. Restore the signed Stable registration
    # only after the whole synthetic native pointer fixture is removed.
    # A source SHA claim is not enough: the pinned product-owned Git must
    # independently find a clean checkout of exactly that commit and branch.
    $DirtyGitProbe = Join-Path $ManagedSourceRoot 'equinox-guardian-untracked-audit-probe.txt'
    if (Test-Path -LiteralPath $DirtyGitProbe) { throw 'Hosted Main Git identity probe path was already occupied.' }
    try {
      [IO.File]::WriteAllText($DirtyGitProbe, 'disposable Guardian read-only Git check')
      Assert-True ((Invoke-GuardianCheck '--audit-native-identity') -eq 70) 'Guardian accepted a dirty Main Git checkout.'
    } finally { Remove-Item -LiteralPath $DirtyGitProbe -Force -ErrorAction SilentlyContinue }
    Assert-True ((Invoke-GuardianCheck '--audit-native-identity') -eq 0) 'Guardian refused the restored clean Main Git checkout.'
    # A syntactically plausible forged manifest must not override measured bytes.
    $NativeManifestProbe.releaseFingerprint.sha256 = 'e' * 64
    [IO.File]::WriteAllText((Join-Path $NativeStoreProbe 'native-store.json'), ($NativeManifestProbe | ConvertTo-Json -Depth 5))
    Assert-True ((Invoke-GuardianCheck '--audit-native-identity') -eq 70) 'Guardian trusted a forged complete native-store fingerprint.'
    $NativeManifestProbe.releaseFingerprint.sha256 = $NativeFingerprint.sha256
    [IO.File]::WriteAllText((Join-Path $NativeStoreProbe 'native-store.json'), ($NativeManifestProbe | ConvertTo-Json -Depth 5))
    # Even preserving the original manifest is insufficient after release drift.
    $NativeReleaseJson = Join-Path $NativeReleaseProbe 'release.json'
    $OriginalNativeRelease = [IO.File]::ReadAllBytes($NativeReleaseJson)
    try {
      $MutatedNativeRelease = [byte[]]$OriginalNativeRelease.Clone()
      $MutatedNativeRelease[0] = [byte]($MutatedNativeRelease[0] -bxor 1)
      [IO.File]::WriteAllBytes($NativeReleaseJson, $MutatedNativeRelease)
      Assert-True ((Invoke-GuardianCheck '--audit-native-identity') -eq 70) 'Guardian trusted a mutated immutable native payload.'
    } finally { [IO.File]::WriteAllBytes($NativeReleaseJson, $OriginalNativeRelease) }
    Assert-True ((Invoke-GuardianCheck '--inspect') -eq 70) 'Stable-only Guardian must never launch a native Main pointer by accident.'
    $NativePointerProbeValue.sourceSha = 'a' * 40
    [IO.File]::WriteAllText($NativePointerProbe, ($NativePointerProbeValue | ConvertTo-Json -Depth 3))
    Assert-True ((Invoke-GuardianCheck '--audit-native-identity') -eq 70) 'Guardian trusted the wrong native Main source SHA.'
    $NativePointerProbeValue.sourceSha = $FixtureSourceSha
    [IO.File]::WriteAllText($NativePointerProbe, ($NativePointerProbeValue | ConvertTo-Json -Depth 3))
    $NativeActiveProbe = Join-Path $NativeTxRoot 'active.json'
    try {
      [IO.File]::WriteAllText($NativeActiveProbe, 'fail-closed-test-lock')
      Assert-True ((Invoke-GuardianCheck '--audit-native-identity') -eq 70) 'Guardian audited an unresolved native Main transaction.'
    } finally { Remove-Item -LiteralPath $NativeActiveProbe -Force -ErrorAction SilentlyContinue }
  } finally {
    # Restore independently registered Stable Native Messaging bytes before
    # the fixture is removed, even if any native identity test fails.
    if ($null -ne $NativeMessagingOriginalBytes) {
      [IO.File]::WriteAllBytes($ExpectedManifestPath, $NativeMessagingOriginalBytes)
    }
    if (-not [string]::IsNullOrWhiteSpace($NativeMessagingOriginalOwner)) {
      $RestoreNativeMessagingRegistry = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Google\Chrome\NativeMessagingHosts\dev.equinox.browser', $true)
      if ($null -eq $RestoreNativeMessagingRegistry) { throw 'Hosted Native Messaging registry restore could not open its exact owned key.' }
      try { $RestoreNativeMessagingRegistry.SetValue('', $NativeMessagingOriginalOwner, [Microsoft.Win32.RegistryValueKind]::String) }
      finally { $RestoreNativeMessagingRegistry.Dispose() }
    }
    Remove-Item -LiteralPath $NativePointerProbe -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $NativeStoreProbe -Recurse -Force -ErrorAction SilentlyContinue
  }
  Write-Output "Windows $FixtureTarget Guardian native Main identity audit positive/negative hosted acceptance PASSED."
  # Independently inspect the exact 3-part durable Main transaction
  # ownership without activating Main, recovering a lock or changing WPF.
  Assert-True ((Invoke-GuardianCheck '--audit-native-journal') -eq 70) 'Guardian accepted a journal with no owning active receipt.'
  $JournalId = 'main-' + ('3' * 32)
  $JournalCurrent = $FixtureSourceSha
  $JournalTarget = $(if ($JournalCurrent -ceq ('b' * 40)) { 'c' * 40 } else { 'b' * 40 })
  $JournalStart = '2026-10-11T18:00:00.000Z'
  $JournalLock = Join-Path $NativeTxRoot 'active.json'
  $JournalReceiptDir = Join-Path $NativeTxRoot 'receipts'
  $JournalDataDir = Join-Path $NativeTxRoot 'guardian-journal'
  $JournalReceipt = Join-Path $JournalReceiptDir ("$JournalId.json")
  $JournalData = Join-Path $JournalDataDir ("$JournalId.json")
  $JournalGuard = Join-Path $JournalDataDir (".$JournalId.writer-lock")
  if ((Test-Path -LiteralPath $JournalLock) -or (Test-Path -LiteralPath $JournalReceipt) -or (Test-Path -LiteralPath $JournalData)) {
    throw 'Hosted native journal test requires an unoccupied transaction identity.'
  }
  [IO.Directory]::CreateDirectory($JournalReceiptDir) | Out-Null
  [IO.Directory]::CreateDirectory($JournalDataDir) | Out-Null
  $JournalMarker = [ordered]@{schemaVersion=1;transactionId=$JournalId;channel='main';currentSha=$JournalCurrent;targetSha=$JournalTarget;startedAt=$JournalStart}
  $JournalReceiptValue = [ordered]@{
    schemaVersion=1;transactionId=$JournalId;channel='main';status='promoting';stage='ready_to_switch';
    currentSha=$JournalCurrent;targetSha=$JournalTarget;rollbackSha=$JournalCurrent;
    rollbackSourceRoot=$ManagedSourceRoot;targetSourceRoot=$null;startedAt=$JournalStart;
    updatedAt=$JournalStart;lastError=$null
  }
  $JournalValue = [ordered]@{
    schemaVersion=1;channel='main';transactionId=$JournalId;target=$FixtureTarget;
    currentSha=$JournalCurrent;targetSha=$JournalTarget;receiptStartedAt=$JournalStart;
    previousNative=[ordered]@{kind='stable';version=$FixtureVersion};
    targetRuntimeContractSha256=('f' * 64);stage='prepared';sequence=0;
    createdAt=$JournalStart;updatedAt=$JournalStart
  }
  try {
    [IO.File]::WriteAllText($JournalLock, ($JournalMarker | ConvertTo-Json -Depth 5))
    [IO.File]::WriteAllText($JournalReceipt, ($JournalReceiptValue | ConvertTo-Json -Depth 5))
    [IO.File]::WriteAllText($JournalData, ($JournalValue | ConvertTo-Json -Depth 5))
    Assert-True ((Invoke-GuardianCheck '--audit-native-journal') -eq 0) 'Guardian refused an exact structurally owned in-progress journal.'
    # The owning process must be a REAL product-owned Node with matching PID,
    # full UTC creation ticks and native executable. A reused PID or forged
    # executable must never authorize any resume. The disposable Node runs no
    # updater or user payload and is killed/removed even if assertions fail.
    Assert-True ((Invoke-GuardianCheck '--audit-native-worker') -eq 70) 'Guardian accepted absent native worker ownership.'
    $WorkerNode = Join-Path $ReleaseDir 'runtime\node\bin\node.exe'
    Assert-True ([IO.File]::Exists($WorkerNode)) 'Native worker OS identity test requires release-owned Node.'
    $WorkerHandoff = Join-Path $NativeTxRoot 'handoff'
    [IO.Directory]::CreateDirectory($WorkerHandoff) | Out-Null
    $WorkerRecordPath = Join-Path $WorkerHandoff ("$JournalId.windows-worker.json")
    if (Test-Path -LiteralPath $WorkerRecordPath) { throw 'Hosted worker identity test requires unoccupied ownership.' }
    $WorkerProcess = $null
    try {
      $WorkerStartInfo = [Diagnostics.ProcessStartInfo]::new($WorkerNode)
      $WorkerStartInfo.UseShellExecute = $false
      $WorkerStartInfo.CreateNoWindow = $true
      # Hosted real installer smoke uses Windows PowerShell 5.1 / .NET Framework,
      # whose ProcessStartInfo does not expose ArgumentList. Fixed test-only
      # script content contains no external/user-controlled command arguments.
      $WorkerStartInfo.Arguments = '-e "setInterval(function(){},10000)"'
      $WorkerProcess = [Diagnostics.Process]::Start($WorkerStartInfo)
      if ($null -eq $WorkerProcess) { throw 'Unable to start ephemeral owned Node process for Guardian audit.' }
      $WorkerRecord = [ordered]@{
        schemaVersion=1;transactionId=$JournalId;pid=$WorkerProcess.Id;
        startTimeUtcTicks=$WorkerProcess.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture);
        token=('e' * 64);nodePath=$WorkerNode
      }
      [IO.File]::WriteAllText($WorkerRecordPath,($WorkerRecord | ConvertTo-Json -Depth 4))
      # The hosted x64/ARM64 OS process acceptance also exercises independent
      # per-process Windows SessionId equality; this fixture does not pretend
      # that a second foreign Windows session was created.
      Assert-True ($WorkerProcess.SessionId -eq ([Diagnostics.Process]::GetCurrentProcess()).SessionId) 'Disposable worker did not start in the runner Guardian OS session.'
      Assert-True ((Invoke-GuardianCheck '--audit-native-worker') -eq 0) 'Guardian refused live product-owned Node PID/start time/executable/SID/logon-LUID/session proof.'
      $WorkerRecord.startTimeUtcTicks = ([long]::Parse($WorkerRecord.startTimeUtcTicks) - 1).ToString([Globalization.CultureInfo]::InvariantCulture)
      [IO.File]::WriteAllText($WorkerRecordPath,($WorkerRecord | ConvertTo-Json -Depth 4))
      Assert-True ((Invoke-GuardianCheck '--audit-native-worker') -eq 70) 'Guardian accepted a replayed or reused native worker PID with wrong creation time.'
      $WorkerRecord.startTimeUtcTicks = $WorkerProcess.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
      $WorkerRecord.nodePath = Join-Path $Work 'foreign-node.exe'
      [IO.File]::WriteAllText($WorkerRecordPath,($WorkerRecord | ConvertTo-Json -Depth 4))
      Assert-True ((Invoke-GuardianCheck '--audit-native-worker') -eq 70) 'Guardian accepted a foreign native worker Node executable.'
      $WorkerRecord.nodePath = $WorkerNode
      $WorkerRecord.token = 'invalid'
      [IO.File]::WriteAllText($WorkerRecordPath,($WorkerRecord | ConvertTo-Json -Depth 4))
      Assert-True ((Invoke-GuardianCheck '--audit-native-worker') -eq 70) 'Guardian accepted an invalid worker owner token.'
      $WorkerRecord.token = ('e' * 64)
      [IO.File]::WriteAllText($WorkerRecordPath,($WorkerRecord | ConvertTo-Json -Depth 4))
      Assert-True ((Invoke-GuardianCheck '--audit-native-worker') -eq 0) 'Guardian refused restored live OS process identity.'
    } finally {
      if ($null -ne $WorkerProcess) {
        # .NET Framework under Windows PowerShell 5.1 has Kill() but not
        # Kill(entireProcessTree); this fixture starts no child processes.
        try { if (-not $WorkerProcess.HasExited) { $WorkerProcess.Kill() } } catch {}
        try { $WorkerProcess.WaitForExit(5000) | Out-Null } catch {}
        $WorkerProcess.Dispose()
      }
      Remove-Item -LiteralPath $WorkerRecordPath -Force -ErrorAction SilentlyContinue
    }
    Assert-True ((Invoke-GuardianCheck '--audit-native-worker') -eq 70) 'Guardian accepted an exited/unowned native worker after cleanup.'
    Assert-True ((Invoke-GuardianCheck '--inspect') -eq 70) 'Stable Guardian must not start while the journal owns an active Main lock.'
    $JournalReceiptValue.targetSha = $(if ($JournalTarget -ceq ('c' * 40)) { 'd' * 40 } else { 'c' * 40 })
    [IO.File]::WriteAllText($JournalReceipt, ($JournalReceiptValue | ConvertTo-Json -Depth 5))
    Assert-True ((Invoke-GuardianCheck '--audit-native-journal') -eq 70) 'Guardian admitted a receipt with foreign target source SHA.'
    $JournalReceiptValue.targetSha = $JournalTarget
    [IO.File]::WriteAllText($JournalReceipt, ($JournalReceiptValue | ConvertTo-Json -Depth 5))
    $JournalValue.sequence = 4
    [IO.File]::WriteAllText($JournalData, ($JournalValue | ConvertTo-Json -Depth 5))
    Assert-True ((Invoke-GuardianCheck '--audit-native-journal') -eq 70) 'Guardian trusted an impossible journal stage generation.'
    $JournalValue.sequence = 0
    [IO.File]::WriteAllText($JournalData, ($JournalValue | ConvertTo-Json -Depth 5))
    [IO.File]::WriteAllText($JournalGuard, 'foreign persistent writer')
    try { Assert-True ((Invoke-GuardianCheck '--audit-native-journal') -eq 70) 'Guardian reclaimed a persistent journal writer lock.' }
    finally { Remove-Item -LiteralPath $JournalGuard -Force -ErrorAction SilentlyContinue }
    $JournalValue.stage = 'committed'; $JournalValue.sequence = 6
    [IO.File]::WriteAllText($JournalData, ($JournalValue | ConvertTo-Json -Depth 5))
    Assert-True ((Invoke-GuardianCheck '--audit-native-journal') -eq 70) 'Guardian accepted claimed terminal success with an active lock.'
    $JournalValue.stage = 'prepared'; $JournalValue.sequence = 0
    [IO.File]::WriteAllText($JournalData, ($JournalValue | ConvertTo-Json -Depth 5))
    Assert-True ((Invoke-GuardianCheck '--audit-native-journal') -eq 0) 'Guardian refused restored structurally owned in-progress journal.'
  } finally {
    Remove-Item -LiteralPath $JournalGuard,$JournalData,$JournalReceipt,$JournalLock -Force -ErrorAction SilentlyContinue
  }
  Assert-True ((Invoke-GuardianCheck '--audit-native-journal') -eq 70) 'Guardian accepted an orphan journal after its owning active receipt disappeared.'
  Write-Output "Windows $FixtureTarget Guardian native journal ownership audit positive/negative hosted acceptance PASSED."
  $OwnedGit = Join-Path $InstallRoot ("runtime\toolchain\git\2.53.0-4\$FixtureTarget\cmd\git.exe")
  $OwnedNode = Join-Path $InstallRoot ("runtime\toolchain\node\26.11.1\$FixtureTarget\node.exe")
  $OwnedNpm = Join-Path $InstallRoot ("runtime\toolchain\node\26.11.1\$FixtureTarget\node_modules\npm\bin\npm-cli.js")
  foreach ($owned in @($OwnedGit,$OwnedNode,$OwnedNpm)) { Assert-True ([IO.File]::Exists($owned)) ("Product-owned toolchain file is missing: $owned") }
  Assert-True ((& $OwnedGit --version) -match '^git version 2\.53\.0\b') 'Product-owned Git version mismatch.'
  Assert-True ((& $OwnedNode --version) -ceq 'v26.11.1') 'Product-owned Node version mismatch.'
  # End-to-end actual NTFS A/B switch and failed-B rollback against exact
  # architecture-specific installed WPF PE bytes in an isolated temp root.
  # NEVER mutate the host's real installed program root or Native Messaging.
  # Match the REAL WPF detached-worker ABI: its owned Node lives in the
  # current signed Stable release, not the independent build toolchain.
  $StableWorkerNode = Join-Path $ReleaseDir 'runtime\node\bin\node.exe'
  Assert-True ([IO.File]::Exists($StableWorkerNode)) 'Stable-owned detached worker Node is missing.'
  & $StableWorkerNode (Join-Path $Root 'tests/release/windows-native-ab-installed-smoke.mjs') $ReleaseDir $FixtureTarget
  if ($LASTEXITCODE -ne 0) { throw 'Windows actual native shell A/B switch/rollback smoke failed.' }
  Assert-True ((& $OwnedNode $OwnedNpm --version) -match '^\d+\.\d+\.\d+$') 'Product-owned npm CLI did not execute.'
  # Exercise the actual packaged CLI with a throwaway offline profile.
  & $OwnedNode (Join-Path $Root 'tests/release/windows-tunnel-offline-init-smoke.mjs') $ManagedSourceRoot $ReleaseDir
  if ($LASTEXITCODE -ne 0) { throw 'Windows real bundled tunnel-client offline init acceptance failed.' }
  # A real installed Windows app must be discoverable and uninstallable by OS UI.
  $AppsKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Equinox Local'
  $AppsRegistration = Get-ItemProperty -LiteralPath $AppsKey -ErrorAction Stop
  Assert-True ($AppsRegistration.EquinoxLocalManagedInstall -eq 1) 'Windows Installed Apps ownership marker is missing.'
  Assert-True ([string]$AppsRegistration.DisplayName -ceq 'Equinox Local') 'Windows Installed Apps display name is incorrect.'
  Assert-True ([string]$AppsRegistration.DisplayVersion -ceq $FixtureVersion) 'Windows Installed Apps version is incorrect.'
  Assert-True (Same-Path ([string]$AppsRegistration.InstallLocation) $OwnedProgramRoot) 'Windows Installed Apps program root does not match.'
  Assert-True ([string]$AppsRegistration.UninstallString -ceq ('"' + $StableExe + '" --uninstall')) 'Windows Installed Apps uninstaller command does not target the native app.'
  $StartMenuPrograms = [Environment]::GetFolderPath([Environment+SpecialFolder]::Programs)
  Assert-True (-not [string]::IsNullOrWhiteSpace($StartMenuPrograms)) 'Current-user Start Menu programs directory is unavailable.'
  $StartMenuShortcut = Join-Path $StartMenuPrograms 'Equinox Local.lnk'
  Assert-True ([IO.File]::Exists($StartMenuShortcut)) 'Equinox Local Start Menu shortcut was not registered.'
  $ShellCom = New-Object -ComObject WScript.Shell
  try { $ShortcutCom = $ShellCom.CreateShortcut($StartMenuShortcut); Assert-True (Same-Path ([string]$ShortcutCom.TargetPath) $StableExe) 'Start Menu shortcut points at the wrong binary.' }
  finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($ShellCom) }
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
  # Execute the real shipped registry+shortcut cleanup after verifying
  # their ownership, without deleting the healthy runtime or user data.
  & $OwnedNode (Join-Path $Root 'tests/release/windows-installed-app-registration-cleanup.mjs') $ManagedSourceRoot $OwnedProgramRoot
  if ($LASTEXITCODE -ne 0) { throw 'Managed Windows shell registration cleanup failed.' }
  Assert-True (-not (Test-Path -LiteralPath $AppsKey)) 'Uninstall integration did not remove the owned Installed Apps entry.'
  Assert-True (-not [IO.File]::Exists($StartMenuShortcut)) 'Uninstall integration did not remove the owned Start Menu shortcut.'
  Write-Output "Windows $FixtureTarget real fresh-install managed-source acceptance passed: public installer promoted $FixtureVersion at $FixtureSourceSha and served the exact managed source runtime."
} finally {
  if (-not [string]::IsNullOrWhiteSpace($StableExe) -and [IO.File]::Exists($StableExe)) { Stop-OwnedShell $StableExe }
  if (Test-Path -LiteralPath $NativeRegistryKey) {
    try {
      $value = [string](Get-Item -LiteralPath $NativeRegistryKey -ErrorAction Stop).GetValue('')
      if (-not [string]::IsNullOrWhiteSpace($ExpectedManifestPath) -and (Same-Path $value $ExpectedManifestPath)) { Remove-Item -LiteralPath $NativeRegistryKey -Recurse -Force }
    } catch { Write-Warning $_.Exception.Message }
  }
  # The acceptance job intentionally removes only registration entries that
  # still identify its own exact managed test instance.
  $AppsKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Equinox Local'
  if (Test-Path -LiteralPath $AppsKey) {
    $ownedApps = Get-ItemProperty -LiteralPath $AppsKey -ErrorAction SilentlyContinue
    if ($null -ne $ownedApps -and $ownedApps.EquinoxLocalManagedInstall -eq 1 -and
        -not [string]::IsNullOrWhiteSpace($StableExe) -and
        [string]$ownedApps.UninstallString -ceq ('"' + $StableExe + '" --uninstall')) {
      Remove-Item -LiteralPath $AppsKey -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  $startPrograms = [Environment]::GetFolderPath([Environment+SpecialFolder]::Programs)
  if (-not [string]::IsNullOrWhiteSpace($startPrograms)) {
    $shortcutPath = Join-Path $startPrograms 'Equinox Local.lnk'
    if ([IO.File]::Exists($shortcutPath)) {
      try {
        $shellCom = New-Object -ComObject WScript.Shell
        try { $shortcut = $shellCom.CreateShortcut($shortcutPath); $linked = [string]$shortcut.TargetPath }
        finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shellCom) }
        if (-not [string]::IsNullOrWhiteSpace($StableExe) -and (Same-Path $linked $StableExe)) { Remove-Item -LiteralPath $shortcutPath -Force -ErrorAction SilentlyContinue }
      } catch { Write-Warning 'Could not clean the owned Start Menu test shortcut.' }
    }
  }
  if (-not [string]::IsNullOrWhiteSpace($OwnedInstallRoot) -and [IO.Directory]::Exists($OwnedInstallRoot)) { Remove-Item -LiteralPath $OwnedInstallRoot -Recurse -Force -ErrorAction SilentlyContinue }
  if (-not [string]::IsNullOrWhiteSpace($OwnedProgramRoot) -and [IO.Directory]::Exists($OwnedProgramRoot)) { Remove-Item -LiteralPath $OwnedProgramRoot -Recurse -Force -ErrorAction SilentlyContinue }
  $env:LOCALAPPDATA = $OriginalLocalAppData; $env:TEMP = $OriginalTemp; $env:TMP = $OriginalTmp
  Remove-Item Function:\Save-BoundedHttpsFile -ErrorAction SilentlyContinue
  if ([IO.Directory]::Exists($Work)) { Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue }
}
