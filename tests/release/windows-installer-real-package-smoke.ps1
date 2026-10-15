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
  $JournalStart = '2026-10-11T18:00:00.000Z'
  $JournalSources = Join-Path $NativeTxRoot 'sources'
  $JournalRollbackRoot = Join-Path $JournalSources $JournalCurrent
  [IO.Directory]::CreateDirectory($JournalRollbackRoot) | Out-Null
  # Create a REAL clean pinned-Git source B, unlike a dummy all-b SHA.
  # Guardian must still attest the EXACT product Main worker argv path. A
  # hosted-only wrapper at that path re-exports the ORIGINAL product worker,
  # preserving server.js imports, and runs a distinct witness ONLY when the
  # hosted worker process itself invokes this file with its test-only env.
  if ($env:GITHUB_ACTIONS -cne 'true') { throw 'Integrated native B startup requires disposable hosted GitHub Actions.' }
  $WitnessScript = Join-Path $Root 'tests\release\owned-windows-worker-proof.mjs'
  $JournalCandidateRoot = Join-Path $Work 'ephemeral-clean-main-B'
  & $OwnedGitStatusExe -c core.autocrlf=true -c core.fsmonitor=false clone --quiet --branch main $ManagedSourceRoot $JournalCandidateRoot
  Assert-True ($LASTEXITCODE -eq 0) 'Product-owned Git could not clone clean disposable Main B source.'
  & $OwnedGitStatusExe -C $JournalCandidateRoot remote set-url origin 'https://github.com/sametbasbug/equinox-local.git'
  Assert-True ($LASTEXITCODE -eq 0) 'Disposable B origin cannot bind canonical product repository.'
  $WorkerProduction = Join-Path $JournalCandidateRoot 'src\equinox-local-main-update-worker.js'
  $WorkerProductionCopy = Join-Path $JournalCandidateRoot 'src\equinox-native-ab-ci-original-worker.js'
  $WorkerCandidateScript = Join-Path $JournalCandidateRoot 'src\equinox-native-ab-ci-worker-witness.mjs'
  Assert-True ([IO.File]::Exists($WorkerProduction)) 'The original Main worker module must exist before wrapping.'
  [IO.File]::Copy($WorkerProduction, $WorkerProductionCopy, $false)
  [IO.File]::Copy($WitnessScript, $WorkerCandidateScript, $false)
  $WorkerFacade = @'
import { fileURLToPath } from 'node:url';
import path from 'node:path';
export * from './equinox-native-ab-ci-original-worker.js';
if (process.env.GITHUB_ACTIONS === 'true' &&
    process.env.EQUINOX_LOCAL_TEST_WORKER_TX?.startsWith('main-') &&
    process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await import('./equinox-native-ab-ci-worker-witness.mjs');
}
'@
  [IO.File]::WriteAllText($WorkerProduction, $WorkerFacade, (New-Object Text.UTF8Encoding($false)))
  & $OwnedGitStatusExe -C $JournalCandidateRoot add -- 'src/equinox-local-main-update-worker.js' 'src/equinox-native-ab-ci-original-worker.js' 'src/equinox-native-ab-ci-worker-witness.mjs'
  Assert-True ($LASTEXITCODE -eq 0) 'Hosted-only B source wrapper and witness were not staged.'
  & $OwnedGitStatusExe -c user.name='Equinox CI Fixture' -c user.email='fixture@example.invalid' -c core.autocrlf=true -C $JournalCandidateRoot commit --quiet -m 'test: ephemeral Windows native Main B restart witness'
  Assert-True ($LASTEXITCODE -eq 0) 'Disposable B Git source witness was not committed.'
  $JournalTarget = [string](& $OwnedGitStatusExe -C $JournalCandidateRoot rev-parse HEAD)
  Assert-True ($LASTEXITCODE -eq 0 -and $JournalTarget -cmatch '^[a-f0-9]{40}$' -and $JournalTarget -cne $JournalCurrent) 'Disposable B source Git SHA is not distinct and canonical.'
  $JournalTargetRoot = Join-Path $JournalSources $JournalTarget
  # Hosted Git for Windows marks the ephemeral .git checkout as unmovable;
  # even Directory.Move can be denied by the runner filesystem. Copy ONLY
  # into our own fresh fixture source slot and never delete/rewrite the
  # verified .git source. Robocopy is native to supported Windows runners,
  # runs only here in CI (not on a user's managed source/update path), and
  # uses COPY:DAT to avoid inheriting foreign source ACLs.
  & robocopy.exe $JournalCandidateRoot $JournalTargetRoot /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
  $BFixtureCopyResult = $LASTEXITCODE
  Assert-True ($BFixtureCopyResult -ge 0 -and $BFixtureCopyResult -le 7) 'Hosted disposable Git B clone could not be copied without mutation.'
  $WorkerTestSourceDir = Join-Path $JournalTargetRoot 'src'
  $WorkerTestScript = Join-Path $WorkerTestSourceDir 'equinox-local-main-update-worker.js'
  Assert-True ([IO.File]::Exists($WorkerTestScript)) 'Exact immutable B worker witness source is missing.'
  $CopiedSourceSha = [string](& $OwnedGitStatusExe -C $JournalTargetRoot rev-parse HEAD)
  Assert-True ($LASTEXITCODE -eq 0 -and $CopiedSourceSha -ceq $JournalTarget) 'Copied native B Git checkout HEAD differs from admitted exact SHA.'
  $JournalBSourceStatus = @(& $OwnedGitStatusExe -c core.autocrlf=true -c core.fsmonitor=false -C $JournalTargetRoot status --porcelain=v1 --untracked-files=normal)
  Assert-True ($LASTEXITCODE -eq 0 -and $JournalBSourceStatus.Count -eq 0) 'Disposable Main B checkout is not clean under pinned product Git.'
  # Real managed-source B must satisfy the SAME native WPF runtime locator
  # as installed users: it requires a normal, prebuilt node_modules tree.
  # B differs from A only by its committed fixture worker witness; require
  # exact package.json + lockfile identity before seeding product dependencies.
  $SeedFixtureScript = Join-Path $Root 'tests/release/windows-seed-native-b-source-fixture.mjs'
  Assert-True ([IO.File]::Exists($SeedFixtureScript)) 'Product hosted B dependency seed fixture is unavailable.'
  $SeedProductNode = Join-Path $ReleaseDir 'runtime\node\bin\node.exe'
  Assert-True ([IO.File]::Exists($SeedProductNode)) 'Product Stable-owned Node executable is unavailable for exact B dependency seed.'
  & $SeedProductNode $SeedFixtureScript $JournalTargetRoot $ManagedSourceRoot
  Assert-True ($LASTEXITCODE -eq 0 -and [IO.Directory]::Exists((Join-Path $JournalTargetRoot 'node_modules'))) 'Disposable B dependency seed differs from exact prebuilt A package identity.'
  $JournalBSourceStatus = @(& $OwnedGitStatusExe -c core.autocrlf=true -c core.fsmonitor=false -C $JournalTargetRoot status --porcelain=v1 --untracked-files=normal)
  Assert-True ($LASTEXITCODE -eq 0 -and $JournalBSourceStatus.Count -eq 0) 'Disposable B dependency seed changed its tracked Git identity.'
  Write-Output 'Hosted immutable Main source B checkout independently committed and validated.'
  $JournalLock = Join-Path $NativeTxRoot 'active.json'
  $JournalReceiptDir = Join-Path $NativeTxRoot 'receipts'
  $JournalDataDir = Join-Path $NativeTxRoot 'guardian-journal'
  $JournalReceipt = Join-Path $JournalReceiptDir ("$JournalId.json")
  $JournalData = Join-Path $JournalDataDir ("$JournalId.json")
  $JournalGuard = Join-Path $JournalDataDir (".$JournalId.writer-lock")
  $JournalAuthority = Join-Path $JournalDataDir ("$JournalId.native-authority.json")
  $JournalAuthorityTrigger = Join-Path $Work 'start-journal-authority-client.trigger'
  $JournalAbortTrigger = Join-Path $Work 'start-journal-abort-client.trigger'
  $JournalShellTrigger = Join-Path $Work 'start-wpf-quiesce-client.trigger'
  $JournalIntegratedTrigger = Join-Path $Work 'start-integrated-native-ab-client.trigger'
  $JournalIntegratedDiagnostic = Join-Path $Work 'integrated-ab-worker-diagnostic.log'
  $JournalGuardianSpawnTrigger = Join-Path $Work 'start-fixed-guardian-from-original-worker.trigger'
  $JournalGuardianPidReceipt = Join-Path $Work 'worker-owned-guardian-os-pid.receipt'
  $JournalNativeStagedCommit = Join-Path $JournalDataDir ("$JournalId.native_staged.commit.json")
  $JournalShellStoppedCommit = Join-Path $JournalDataDir ("$JournalId.shell_stopped.commit.json")
  $JournalSwitchedCommit = Join-Path $JournalDataDir ("$JournalId.switched.commit.json")
  $JournalRestartedCommit = Join-Path $JournalDataDir ("$JournalId.restarted.commit.json")
  $JournalRestartedReceipt = Join-Path $JournalDataDir ("$JournalId.wpf-b-restarted.json")
  $JournalBRestartTrigger = Join-Path $Work 'start-integrated-native-b-restart.trigger'
  $JournalNegativeBTrigger = Join-Path $Work 'start-native-negative-b-rollback.trigger'
  $JournalNegativeBReceipt = Join-Path $Work 'native-negative-b-owner-attested.json'
  $JournalPhysicalRestoreTrigger = Join-Path $Work 'start-original-guardian-physical-a-restore.trigger'
  $JournalPhysicalRestoreReceipt = Join-Path $Work 'original-guardian-physical-a-restored.json'
  $JournalStableSelectionTrigger = Join-Path $Work 'start-original-guardian-select-stable-a.trigger'
  $JournalStableSelectionReceipt = Join-Path $Work 'original-guardian-a-identity-selected.json'
  $JournalRelaunchATrigger = Join-Path $Work 'start-original-guardian-relaunch-stable-a.trigger'
  $JournalRelaunchAReceipt = Join-Path $Work 'original-guardian-wpf-a-relaunched.json'
  $JournalRelaunchACommit = Join-Path $JournalDataDir ("$JournalId.wpf-a-restarted.json")
  $JournalHealthATrigger = Join-Path $Work 'start-original-guardian-health-stable-a.trigger'
  $JournalHealthAReceipt = Join-Path $Work 'original-guardian-four-a-health.json'
  $JournalHealthyACommit = Join-Path $JournalDataDir ("$JournalId.rollback_healthy.commit.json")
  $JournalTerminalATrigger = Join-Path $Work 'start-original-guardian-terminal-stable-a.trigger'
  $JournalTerminalAReceipt = Join-Path $Work 'original-guardian-terminal-a.json'
  $JournalTerminalACommit = Join-Path $JournalDataDir ("$JournalId.rolled_back.commit.json")
  $JournalRollbackStartCommit = Join-Path $JournalDataDir ("$JournalId.rollback_started.commit.json")
  $JournalNativeRestoredCommit = Join-Path $JournalDataDir ("$JournalId.rollback_native_restored.commit.json")
  $JournalIntegratedB = Join-Path $NativeTxRoot ("native-store\$FixtureTarget\$JournalTarget")
  $JournalShellQuiesced = Join-Path $JournalDataDir ("$JournalId.stable-shell-quiesce.json")
  $JournalAbortCommit = Join-Path $JournalDataDir ("$JournalId.abort-commit.json")
  $JournalQuarantinedLock = Join-Path $JournalDataDir (".$JournalId.quarantined.writer-lock")
  $JournalQuarantineReceipt = Join-Path $JournalDataDir ("$JournalId.orphan-quarantine.json")
  if ((Test-Path -LiteralPath $JournalLock) -or (Test-Path -LiteralPath $JournalReceipt) -or (Test-Path -LiteralPath $JournalData)) {
    throw 'Hosted native journal test requires an unoccupied transaction identity.'
  }
  [IO.Directory]::CreateDirectory($JournalReceiptDir) | Out-Null
  [IO.Directory]::CreateDirectory($JournalDataDir) | Out-Null
  $JournalMarker = [ordered]@{schemaVersion=1;transactionId=$JournalId;channel='main';currentSha=$JournalCurrent;targetSha=$JournalTarget;startedAt=$JournalStart}
  $JournalReceiptValue = [ordered]@{
    schemaVersion=1;transactionId=$JournalId;channel='main';status='promoting';stage='ready_to_switch';
    currentSha=$JournalCurrent;targetSha=$JournalTarget;rollbackSha=$JournalCurrent;
    rollbackSourceRoot=$JournalRollbackRoot;targetSourceRoot=$JournalTargetRoot;startedAt=$JournalStart;
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
    Assert-True ((Invoke-GuardianCheck '--audit-native-worker-ipc') -eq 70) 'Guardian accepted absent native worker IPC owner.'
    Assert-True ((Invoke-GuardianCheck '--audit-native-worker-argv') -eq 70) 'Guardian accepted absent native worker OS argv ownership.'
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
      Assert-True ([IO.File]::Exists($WorkerTestScript)) 'Exact disposable Main worker argv witness is missing.'
      $WorkerStartInfo.Arguments = '"' + $WorkerTestScript + '" --transaction-id ' + $JournalId +
        ' --source-root "' + $JournalRollbackRoot + '" --transaction-root "' + $NativeTxRoot + '"'
      $WorkerStartInfo.EnvironmentVariables['EQUINOX_LOCAL_TEST_PROOF_MODULE'] = Join-Path $Root 'src\equinox-local-windows-main-worker-proof.js'
      $WorkerStartInfo.EnvironmentVariables['EQUINOX_LOCAL_TEST_WORKER_TX'] = $JournalId
      $WorkerStartInfo.EnvironmentVariables['EQUINOX_LOCAL_MAIN_WORKER_TOKEN'] = ('e' * 64)
      $WorkerStartInfo.EnvironmentVariables['EQUINOX_LOCAL_TEST_JOURNAL_CLIENT_MODULE'] = Join-Path $Root 'src\equinox-local-windows-native-journal-authority-client.js'
      $WorkerStartInfo.EnvironmentVariables['EQUINOX_LOCAL_TEST_JOURNAL_TX_ROOT'] = $NativeTxRoot
      $WorkerStartInfo.EnvironmentVariables['EQUINOX_LOCAL_TEST_JOURNAL_TRIGGER'] = $JournalAuthorityTrigger
      $WorkerStartInfo.EnvironmentVariables['EQUINOX_LOCAL_TEST_JOURNAL_ABORT_TRIGGER'] = $JournalAbortTrigger
      $WorkerStartInfo.EnvironmentVariables['EQUINOX_LOCAL_TEST_WPF_QUIESCE_TRIGGER'] = $JournalShellTrigger
      $WorkerStartInfo.EnvironmentVariables['EQUINOX_LOCAL_TEST_INTEGRATED_AB_TRIGGER'] = $JournalIntegratedTrigger
      $WorkerStartInfo.EnvironmentVariables['EQUINOX_LOCAL_TEST_GUARDIAN_SPAWN_TRIGGER'] = $JournalGuardianSpawnTrigger
      $WorkerStartInfo.EnvironmentVariables['EQUINOX_LOCAL_TEST_GUARDIAN_PID_RECEIPT'] = $JournalGuardianPidReceipt
      $WorkerStartInfo.EnvironmentVariables['EQUINOX_LOCAL_TEST_GUARDIAN_LAUNCH_MODULE'] = Join-Path $Root 'src\equinox-local-windows-native-guardian-launch.js'
      $WorkerStartInfo.EnvironmentVariables['EQUINOX_LOCAL_TEST_GUARDIAN_STABLE_VERSION'] = $FixtureVersion
      $WorkerStartInfo.EnvironmentVariables['EQUINOX_LOCAL_TEST_GUARDIAN_TARGET'] = $FixtureTarget
      $WorkerStartInfo.EnvironmentVariables['EQUINOX_LOCAL_TEST_AB_CURRENT_SHA'] = $JournalCurrent
      $WorkerStartInfo.EnvironmentVariables['EQUINOX_LOCAL_TEST_AB_CLIENT_MODULE'] = Join-Path $Root 'src\equinox-local-windows-native-ab-owner-client.js'
      $WorkerStartInfo.EnvironmentVariables['EQUINOX_LOCAL_TEST_AB_DIAGNOSTIC_FILE'] = $JournalIntegratedDiagnostic
      $WorkerStartInfo.EnvironmentVariables['EQUINOX_LOCAL_TEST_AB_RESTART_TRIGGER'] = $JournalBRestartTrigger
      $WorkerStartInfo.EnvironmentVariables['EQUINOX_LOCAL_TEST_AB_RESTART_MODULE'] = Join-Path $Root 'src\equinox-local-windows-native-ab-restart-client.js'
      $WorkerStartInfo.EnvironmentVariables['EQUINOX_LOCAL_TEST_AB_NEGATIVE_B_TRIGGER'] = $JournalNegativeBTrigger
      $WorkerStartInfo.EnvironmentVariables['EQUINOX_LOCAL_TEST_AB_NEGATIVE_B_RECEIPT'] = $JournalNegativeBReceipt
      $WorkerStartInfo.EnvironmentVariables['EQUINOX_LOCAL_TEST_AB_PHYSICAL_RESTORE_TRIGGER'] = $JournalPhysicalRestoreTrigger
      $WorkerStartInfo.EnvironmentVariables['EQUINOX_LOCAL_TEST_AB_PHYSICAL_RESTORE_RECEIPT'] = $JournalPhysicalRestoreReceipt
      $WorkerStartInfo.EnvironmentVariables['EQUINOX_LOCAL_TEST_AB_PHYSICAL_RESTORE_MODULE'] = Join-Path $Root 'src\equinox-local-windows-native-ab-physical-restore-client.js'
      $WorkerStartInfo.EnvironmentVariables['EQUINOX_LOCAL_TEST_AB_SELECT_STABLE_TRIGGER'] = $JournalStableSelectionTrigger
      $WorkerStartInfo.EnvironmentVariables['EQUINOX_LOCAL_TEST_AB_SELECT_STABLE_RECEIPT'] = $JournalStableSelectionReceipt
      $WorkerStartInfo.EnvironmentVariables['EQUINOX_LOCAL_TEST_AB_SELECT_STABLE_MODULE'] = Join-Path $Root 'src\equinox-local-windows-native-ab-stable-a-selection-client.js'
      $WorkerStartInfo.EnvironmentVariables['EQUINOX_LOCAL_TEST_AB_RELAUNCH_STABLE_TRIGGER'] = $JournalRelaunchATrigger
      $WorkerStartInfo.EnvironmentVariables['EQUINOX_LOCAL_TEST_AB_RELAUNCH_STABLE_RECEIPT'] = $JournalRelaunchAReceipt
      $WorkerStartInfo.EnvironmentVariables['EQUINOX_LOCAL_TEST_AB_RELAUNCH_STABLE_MODULE'] = Join-Path $Root 'src\equinox-local-windows-native-ab-stable-a-relaunch-client.js'
      $WorkerStartInfo.EnvironmentVariables['EQUINOX_LOCAL_TEST_AB_HEALTH_STABLE_TRIGGER'] = $JournalHealthATrigger
      $WorkerStartInfo.EnvironmentVariables['EQUINOX_LOCAL_TEST_AB_HEALTH_STABLE_RECEIPT'] = $JournalHealthAReceipt
      $WorkerStartInfo.EnvironmentVariables['EQUINOX_LOCAL_TEST_AB_HEALTH_STABLE_MODULE'] = Join-Path $Root 'src\equinox-local-windows-native-ab-stable-a-health-client.js'
      $WorkerStartInfo.EnvironmentVariables['EQUINOX_LOCAL_TEST_AB_TERMINAL_STABLE_TRIGGER'] = $JournalTerminalATrigger
      $WorkerStartInfo.EnvironmentVariables['EQUINOX_LOCAL_TEST_AB_TERMINAL_STABLE_RECEIPT'] = $JournalTerminalAReceipt
      $WorkerStartInfo.EnvironmentVariables['EQUINOX_LOCAL_TEST_AB_TERMINAL_STABLE_MODULE'] = Join-Path $Root 'src\equinox-local-windows-native-ab-stable-a-terminal-client.js'
      $WorkerStartInfo.EnvironmentVariables['EQUINOX_LOCAL_TEST_AB_ROLLBACK_MODULE'] = Join-Path $Root 'src\equinox-local-windows-native-ab-rollback-client.js'
      $WorkerStartInfo.EnvironmentVariables['EQUINOX_LOCAL_TEST_AB_EVIDENCE_MODULE'] = Join-Path $Root 'src\equinox-local-windows-native-guardian-evidence.js'
      $WorkerStartInfo.EnvironmentVariables['EQUINOX_LOCAL_TEST_AB_OWNER_VERIFIER_MODULE'] = Join-Path $Root 'src\equinox-local-windows-native-rollback-owner-verifier.js'
      $WorkerStartInfo.EnvironmentVariables['EQUINOX_LOCAL_TEST_AB_STARTED_AT'] = $JournalStart
      $WorkerStartInfo.EnvironmentVariables['EQUINOX_LOCAL_TEST_AB_TARGET_SHA'] = $JournalTarget
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
      Assert-True ((Invoke-GuardianCheck '--audit-native-worker-argv') -eq 0) 'Guardian refused exact OS-retrieved product worker command line.'
      $JournalReceiptValue.targetSourceRoot = Join-Path $Work 'foreign-source'
      [IO.File]::WriteAllText($JournalReceipt,($JournalReceiptValue | ConvertTo-Json -Depth 5))
      Assert-True ((Invoke-GuardianCheck '--audit-native-worker-argv') -eq 70) 'Guardian accepted a foreign target source directory claim.'
      $JournalReceiptValue.targetSourceRoot = $JournalTargetRoot
      [IO.File]::WriteAllText($JournalReceipt,($JournalReceiptValue | ConvertTo-Json -Depth 5))
      Assert-True ((Invoke-GuardianCheck '--audit-native-worker-argv') -eq 0) 'Guardian refused restored exact worker argument owner.'
      # IPC endpoint starts asynchronously inside the real installed Node.
      # Retry only the positive fixture handshake; deny on all other failures.
      $WitnessReady = $false
      for ($WitnessAttempt=0; $WitnessAttempt -lt 10; $WitnessAttempt++) {
        if ((Invoke-GuardianCheck '--audit-native-worker-ipc') -eq 0) { $WitnessReady = $true; break }
        Start-Sleep -Milliseconds 150
      }
      Assert-True $WitnessReady 'Guardian refused OS PID-bound nonce/HMAC proof from live owned Node.'
      $WorkerRecord.token = ('d' * 64)
      [IO.File]::WriteAllText($WorkerRecordPath,($WorkerRecord | ConvertTo-Json -Depth 4))
      Assert-True ((Invoke-GuardianCheck '--audit-native-worker-ipc') -eq 70) 'Guardian accepted another token for a live OS pipe peer.'
      $WorkerRecord.token = ('e' * 64)
      [IO.File]::WriteAllText($WorkerRecordPath,($WorkerRecord | ConvertTo-Json -Depth 4))
      Assert-True ((Invoke-GuardianCheck '--audit-native-worker-ipc') -eq 0) 'Guardian refused restored live native owner IPC token.'
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
      $LeaseProcess = $null
      try {
        $LeaseStart = [Diagnostics.ProcessStartInfo]::new($GuardianExe)
        $LeaseStart.Arguments = '--hold-native-journal-lease'
        $LeaseStart.UseShellExecute = $false
        $LeaseStart.CreateNoWindow = $true
        $LeaseProcess = [Diagnostics.Process]::Start($LeaseStart)
        Assert-True ($null -ne $LeaseProcess) 'Independent Windows Guardian journal lease owner could not launch.'
        $LeaseEstablished = $false
        for ($LeaseAttempt=0; $LeaseAttempt -lt 35; $LeaseAttempt++) {
          if ([IO.File]::Exists($JournalGuard) -and -not $LeaseProcess.HasExited) { $LeaseEstablished = $true; break }
          Start-Sleep -Milliseconds 120
        }
        Assert-True $LeaseEstablished 'Independent native Guardian failed to persist an exclusive journal lease.'
        $OutsideWriterAdmitted = $false
        try {
          $ForeignWriter = [IO.File]::Open($JournalGuard, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::ReadWrite)
          $ForeignWriter.Dispose()
          $OutsideWriterAdmitted = $true
        } catch [IO.IOException] { }
        Assert-True (-not $OutsideWriterAdmitted) 'Native OS journal lease allowed a concurrent foreign writer.'
        Assert-True ((Invoke-GuardianCheck '--audit-native-journal') -eq 70) 'Native journal audit ignored the independently owned live writer lease.'
        Assert-True ((Invoke-GuardianCheck '--hold-native-journal-lease') -eq 70) 'Independent Guardian silently reclaimed another live native journal lease.'
        $LeaseProcess.Kill()
        Assert-True ($LeaseProcess.WaitForExit(5000)) 'Native lease owner did not exit after forced powercut fixture.'
        Assert-True ([IO.File]::Exists($JournalGuard)) 'Native guardian crash erased the durable writer lease marker.'
        Assert-True ((Invoke-GuardianCheck '--audit-native-journal') -eq 70) 'Journal admitted a stale lease after independent owner crash.'
        Assert-True ((Invoke-GuardianCheck '--hold-native-journal-lease') -eq 70) 'Guardian automatically reclaimed an orphan native lease.'
      } finally {
        if ($null -ne $LeaseProcess) {
          try { if (-not $LeaseProcess.HasExited) { $LeaseProcess.Kill() } } catch {}
          try { $LeaseProcess.WaitForExit(5000) | Out-Null } catch {}
          $LeaseProcess.Dispose()
        }
        # Explicit disposal is only for this disposable test fixture; real
        # installations MUST reconcile the journal and owning Main receipt.
        Remove-Item -LiteralPath $JournalGuard -Force -ErrorAction SilentlyContinue
      }
      Assert-True ((Invoke-GuardianCheck '--audit-native-journal') -eq 0) 'Native journal did not recover after explicit disposable fixture reconciliation.'
      # New Guardian authority mode is a real separate native process, not
      # a JS journal writer. The exact Node PID answers its 256-bit challenge,
      # and ONLY the native owner persists the prepared journal digest proof.
      $AuthorityProcess = $null
      try {
        $AuthorityStart = [Diagnostics.ProcessStartInfo]::new($GuardianExe)
        $AuthorityStart.Arguments = '--hold-native-journal-authority'
        $AuthorityStart.UseShellExecute = $false
        $AuthorityStart.CreateNoWindow = $true
        $AuthorityStart.RedirectStandardError = $true
        $AuthorityProcess = [Diagnostics.Process]::Start($AuthorityStart)
        Assert-True ($null -ne $AuthorityProcess) 'Independent native journal authority failed to launch.'
        [IO.File]::WriteAllText($JournalAuthorityTrigger, 'fixed-test-only-trigger')
        $AuthorityDurable = $false
        for ($AuthorityAttempt=0; $AuthorityAttempt -lt 80; $AuthorityAttempt++) {
          if ([IO.File]::Exists($JournalAuthority) -and -not $AuthorityProcess.HasExited) { $AuthorityDurable = $true; break }
          if ($AuthorityProcess.HasExited) { break }
          Start-Sleep -Milliseconds 110
        }
        if (-not $AuthorityDurable -and $AuthorityProcess.HasExited) {
          Write-Output ('Hosted native authority diagnostic: ' + $AuthorityProcess.StandardError.ReadToEnd())
        }
        Assert-True $AuthorityDurable 'Native Guardian refused the real worker kernel PID-bound nonce/HMAC journal authority proof.'
        Assert-True ((Invoke-GuardianCheck '--hold-native-journal-authority') -eq 70) 'Duplicate native authority owner silently replaced a live owner.'
        $AuthorityProcess.Kill()
        Assert-True ($AuthorityProcess.WaitForExit(5000)) 'Guardian authority process did not terminate under powercut fixture.'
        Assert-True ([IO.File]::Exists($JournalGuard) -and [IO.File]::Exists($JournalAuthority)) 'Guardian authority powercut lost durable native evidence.'
        $AuthorityRecord = ConvertFrom-Json ([IO.File]::ReadAllText($JournalAuthority))
        Assert-True ($AuthorityRecord.transactionId -ceq $JournalId -and
          $AuthorityRecord.stage -ceq 'prepared' -and $AuthorityRecord.sequence -eq 0 -and
          $AuthorityRecord.workerPid -eq $WorkerProcess.Id -and
          $AuthorityRecord.guardianPid -eq $AuthorityProcess.Id) 'Native authority durable record has foreign process or journal identity.'
        $ExpectedDigest = (Get-FileHash -LiteralPath $JournalData -Algorithm SHA256).Hash.ToLowerInvariant()
        Assert-True ($AuthorityRecord.journalSha256 -ceq $ExpectedDigest) 'Native authority durable record does not bind the exact journal bytes.'
        Assert-True ($JournalValue.stage -ceq 'prepared' -and $JournalValue.sequence -eq 0) 'Native authority proof incorrectly advanced the Main update stage.'
        Assert-True ((Invoke-GuardianCheck '--hold-native-journal-authority') -eq 70) 'Guardian silently replayed an orphan authority proof.'
      } finally {
        if ($null -ne $AuthorityProcess) {
          try { if (-not $AuthorityProcess.HasExited) { $AuthorityProcess.Kill() } } catch {}
          try { $AuthorityProcess.WaitForExit(5000) | Out-Null } catch {}
          $AuthorityProcess.Dispose()
        }
        Remove-Item -LiteralPath $JournalGuard -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $JournalAuthority -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $JournalAuthorityTrigger -Force -ErrorAction SilentlyContinue
      }
      Assert-True ((Invoke-GuardianCheck '--audit-native-journal') -eq 0) 'Native journal authority disposable fixture reconciliation failed.'
      # Real installed WPF native pilot: independently authenticated Guardian
      # locates the exact Stable GUI OS PID, verifies owner SID/logon/session,
      # verifies the live named-pipe server PID, requests graceful exit via
      # the EXISTING shell IPC, and persists a non-activating OS exit proof.
      # Restore the disposable hosted runner WPF before later Main assertions.
      $ShellGuardian = $null
      try {
        $StableOwners = @(Get-CimInstance Win32_Process -Filter "Name='EquinoxLocal.exe'" -ErrorAction SilentlyContinue |
          Where-Object { -not [string]::IsNullOrWhiteSpace($_.ExecutablePath) -and (Same-Path $_.ExecutablePath $StableExe) })
        Assert-True ($StableOwners.Count -eq 1) 'Native WPF quiesce requires exactly one genuine installed Stable shell.'
        $OriginalShellPid = [int]$StableOwners[0].ProcessId
        $ShellStart = [Diagnostics.ProcessStartInfo]::new($GuardianExe)
        $ShellStart.Arguments = '--hold-native-stable-shell-quiesce'
        $ShellStart.UseShellExecute = $false
        $ShellStart.CreateNoWindow = $true
        $ShellStart.RedirectStandardError = $true
        $ShellGuardian = [Diagnostics.Process]::Start($ShellStart)
        Assert-True ($null -ne $ShellGuardian) 'Native WPF quiesce Guardian could not start.'
        [IO.File]::WriteAllText($JournalShellTrigger, 'disposable-test-only')
        $ShellQuiesced = $false
        for ($ShellTry=0; $ShellTry -lt 140; $ShellTry++) {
          if ([IO.File]::Exists($JournalShellQuiesced) -and -not $ShellGuardian.HasExited) { $ShellQuiesced = $true; break }
          if ($ShellGuardian.HasExited) { break }
          Start-Sleep -Milliseconds 120
        }
        if (-not $ShellQuiesced -and $ShellGuardian.HasExited) {
          Write-Output ('Native WPF quiesce diagnostic: ' + $ShellGuardian.StandardError.ReadToEnd())
        }
        Assert-True $ShellQuiesced 'Native Guardian did not prove actual owned WPF graceful shutdown.'
        Assert-True ((Invoke-GuardianCheck '--hold-native-stable-shell-quiesce') -eq 70) 'Second Guardian admitted concurrent WPF shutdown.'
        $ShellGuardian.Kill()
        Assert-True ($ShellGuardian.WaitForExit(5000)) 'WPF quiesce owner did not exit under forced-death fixture.'
        $ShellRecord = ConvertFrom-Json ([IO.File]::ReadAllText($JournalShellQuiesced))
        Assert-True ($ShellRecord.transactionId -ceq $JournalId -and
          $ShellRecord.disposition -ceq 'stable-shell-quiesced-only' -and
          $ShellRecord.shellPid -eq $OriginalShellPid -and
          $ShellRecord.guardianPid -eq $ShellGuardian.Id -and
          $ShellRecord.preparedJournalSha256 -ceq ((Get-FileHash -LiteralPath $JournalData -Algorithm SHA256).Hash.ToLowerInvariant())) 'Native WPF graceful-exit proof is not exact process/journal evidence.'
        $StillOwned = @(Get-CimInstance Win32_Process -Filter "Name='EquinoxLocal.exe'" -ErrorAction SilentlyContinue |
          Where-Object { -not [string]::IsNullOrWhiteSpace($_.ExecutablePath) -and (Same-Path $_.ExecutablePath $StableExe) })
        Assert-True ($StillOwned.Count -eq 0) 'Native quiesce did not actually stop the installed WPF shell.'
        Assert-True ((Invoke-GuardianCheck '--audit-native-journal') -eq 70) 'Native shell exit proof silently resumed Main despite stale owner lease.'
      } finally {
        if ($null -ne $ShellGuardian) {
          try { if (-not $ShellGuardian.HasExited) { $ShellGuardian.Kill() } } catch {}
          try { $ShellGuardian.WaitForExit(5000) | Out-Null } catch {}
          $ShellGuardian.Dispose()
        }
        Remove-Item -LiteralPath $JournalGuard,$JournalAuthority,$JournalShellQuiesced,$JournalShellTrigger -Force -ErrorAction SilentlyContinue
        $ShellRestart = [Diagnostics.ProcessStartInfo]::new($StableExe)
        $ShellRestart.UseShellExecute = $false
        $ShellRestart.CreateNoWindow = $true
        [Diagnostics.Process]::Start($ShellRestart) | Out-Null
        $ShellReturned = $false
        for ($ShellRestartTry=0; $ShellRestartTry -lt 120; $ShellRestartTry++) {
          $RunningOwned = @(Get-CimInstance Win32_Process -Filter "Name='EquinoxLocal.exe'" -ErrorAction SilentlyContinue |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_.ExecutablePath) -and (Same-Path $_.ExecutablePath $StableExe) })
          if ($RunningOwned.Count -eq 1) { $ShellReturned = $true; break }
          Start-Sleep -Milliseconds 200
        }
        Assert-True $ShellReturned 'Hosted real stable WPF shell did not restart after native Guardian quiesce.'
      }
      Assert-True ((Invoke-GuardianCheck '--audit-native-journal') -eq 0) 'WPF quiesce fixture did not restore exact journal ownership.'
      # Integrated native-owner path. Unlike isolated WPF proof tests, this
      # single Guardian process independently fingerprints the *exact B* PE
      # payload, gracefully stops the real installed WPF, and advances two
      # durable journal generations while retaining the exclusive OS lease.
      # No production B launch/swap is enabled by this admission fixture.
      $IntegratedGuardian = $null
      $OriginalIntegratedNativeManifest = [IO.File]::ReadAllBytes($ExpectedManifestPath)
      $IntegratedSourcePointerPath = Join-Path $NativeTxRoot 'current-source.conf'
      $IntegratedNativePointerPath = Join-Path $NativeTxRoot 'current-native.json'
      $OriginalIntegratedSourcePointer = [IO.File]::ReadAllBytes($IntegratedSourcePointerPath)
      $OriginalIntegratedNativePointer = if ([IO.File]::Exists($IntegratedNativePointerPath)) { [IO.File]::ReadAllBytes($IntegratedNativePointerPath) } else { $null }
      try {
        $StagedBRelease = Join-Path $JournalIntegratedB 'release'
        $StagedBRuntime = Join-Path $StagedBRelease 'runtime'
        # A real native B release contains the product Node runtime, gate,
        # supervisor JS, server entry and every native WPF/Browser component.
        # Earlier disposable fixtures copied ONLY shell+browser, therefore
        # the genuine B WPF launched but its backend raised
        # FileNotFoundException for B runtime/node/bin/node.exe.
        # Copy the complete already-installed signed Stable release ONLY in
        # this hosted test profile, then add a distinct test-only native B PE
        # marker before the immutable full-tree fingerprint is generated.
        & robocopy.exe $ReleaseDir $StagedBRelease /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
        $BReleaseCopyResult = $LASTEXITCODE
        Assert-True ($BReleaseCopyResult -ge 0 -and $BReleaseCopyResult -le 7) 'Disposable native B full release copy failed.'
        Assert-True ([IO.File]::Exists((Join-Path $StagedBRuntime 'node\bin\node.exe'))) 'Native B release is missing real owned Node runtime.'
        Assert-True ([IO.File]::Exists((Join-Path $StagedBRelease 'equinox-local-windows-runtime-gate.mjs'))) 'Native B release is missing runtime gate.'
        Assert-True ([IO.File]::Exists((Join-Path $StagedBRelease 'equinox-local-windows-runtime-supervisor.js'))) 'Native B release is missing Node runtime supervisor.'
        Assert-True ([IO.File]::Exists((Join-Path $StagedBRelease 'server.js'))) 'Native B release is missing managed server bootstrap.'
        Assert-True ([IO.File]::Exists((Join-Path $StagedBRuntime 'shell\EquinoxLocal.exe'))) 'Native B release is missing Windows WPF shell.'
        Assert-True ([IO.File]::Exists((Join-Path $StagedBRuntime 'browser\equinox-browser-native-host.exe'))) 'Native B release is missing Chrome Native Messaging launcher.'
        # Distinct test-only PE tree marker makes B physically observable;
        # the full native fingerprint includes this marker before admission.
        [IO.File]::WriteAllText((Join-Path $StagedBRuntime 'shell\native-b-ci-only.marker'), 'native-b-test-fixture')
        $IntegratedFingerprintJson = & $OwnedFingerprintNode (Join-Path $Root 'tests/release/guardian-native-fingerprint-fixture.mjs') $StagedBRelease
        Assert-True ($LASTEXITCODE -eq 0) 'Integrated native B fingerprint fixture failed to inspect exact PE bytes.'
        $IntegratedFingerprint = $IntegratedFingerprintJson | ConvertFrom-Json
        $StagedBManifest = [ordered]@{
          schemaVersion=1;channel='main';sourceSha=$JournalTarget;target=$FixtureTarget;
          runtimeContractSha256=('f' * 64);artifactSha256=('d' * 64);artifactBytes=1024;
          payloadVersion=$FixtureVersion;releaseFingerprint=$IntegratedFingerprint
        }
        [IO.File]::WriteAllText((Join-Path $JournalIntegratedB 'native-store.json'), ($StagedBManifest | ConvertTo-Json -Depth 5))
        # Real product-owned detached Node now launches the independently
        # provisioned native Guardian, NOT hosted PowerShell. Native OS PID,
        # argv, logon LUID, pipe peer proof and lock admission remain in the
        # immutable guardian; worker-side spawn is NOT mutation permission.
        [IO.File]::WriteAllText($JournalGuardianSpawnTrigger, 'disposable-worker-fixed-native-guardian')
        $GuardianPidConfirmed = $false
        for ($GuardianSpawnAttempt=0; $GuardianSpawnAttempt -lt 175; $GuardianSpawnAttempt++) {
          if ([IO.File]::Exists($JournalGuardianPidReceipt)) { $GuardianPidConfirmed = $true; break }
          if ($WorkerProcess.HasExited) { break }
          Start-Sleep -Milliseconds 80
        }
        if (-not $GuardianPidConfirmed -and [IO.File]::Exists($JournalIntegratedDiagnostic)) {
          Write-Output ('Worker-owned native Guardian launch diagnostic: ' + [IO.File]::ReadAllText($JournalIntegratedDiagnostic))
        }
        Assert-True $GuardianPidConfirmed 'Product-owned detached Main worker did not start the fixed native Guardian.'
        $OwnedGuardianPidText = [IO.File]::ReadAllText($JournalGuardianPidReceipt).Trim()
        Assert-True ($OwnedGuardianPidText -cmatch '^[1-9][0-9]{0,9}$') 'Worker Guardian OS PID receipt is malformed.'
        $IntegratedGuardian = [Diagnostics.Process]::GetProcessById([int]$OwnedGuardianPidText)
        Assert-True (-not $IntegratedGuardian.HasExited) 'Worker-spawned fixed native Guardian exited before its OS owner was admitted.'
        Assert-True ((Same-Path $IntegratedGuardian.MainModule.FileName $GuardianExe)) 'Worker-spawned Guardian OS process executable is outside the exact provisioned path.'
        [IO.File]::WriteAllText($JournalIntegratedTrigger, 'disposable-ephemeral-worker')
        $IntegratedCommitted = $false
        $IntegratedBackup = Join-Path (Split-Path -Parent $StableExe | Split-Path -Parent) ('.equinox-shell-backup-' + $JournalId)
        $IntegratedBMarker = Join-Path (Split-Path -Parent $StableExe) 'native-b-ci-only.marker'
        for ($IntegratedAttempt=0; $IntegratedAttempt -lt 600; $IntegratedAttempt++) {
          if ([IO.File]::Exists($JournalSwitchedCommit) -and
              [IO.Directory]::Exists($IntegratedBackup) -and [IO.File]::Exists($IntegratedBMarker) -and
              -not $IntegratedGuardian.HasExited) { $IntegratedCommitted = $true; break }
          if ($IntegratedGuardian.HasExited) { break }
          Start-Sleep -Milliseconds 120
        }
        if (-not $IntegratedCommitted -and $IntegratedGuardian.HasExited) {
          Write-Output 'Worker-launched independent Guardian exited before switched/3, OS PID retained for forensic check.'
          if (Test-Path -LiteralPath $JournalIntegratedDiagnostic) { Write-Output ('Integrated native worker: ' + [IO.File]::ReadAllText($JournalIntegratedDiagnostic)) }
        }
        Assert-True $IntegratedCommitted 'Independent Guardian could not verify B native slot and Native Messaging owner with durable switched journal.'
        Assert-True ((Invoke-GuardianCheck '--hold-native-integrated-ab') -eq 70) 'Second native integrated supervisor stole OS-held journal lease.'
        # Exercise the TRUE source/native selection crash window, using the
        # clean independent committed B Git checkout and exact B PE fingerprint.
        # Only this disposable runner modifies its private pointers; nothing
        # here invokes the physical user's Windows updater.
        $SelectedBSourcePointer = @('schemaVersion=1',"sourceRoot=$JournalTargetRoot","sha=$JournalTarget",'') -join "`n"
        [IO.File]::WriteAllText($IntegratedSourcePointerPath,$SelectedBSourcePointer, (New-Object Text.UTF8Encoding($false)))
        $SelectedBNativePointer = [ordered]@{schemaVersion=1;channel='main';sourceSha=$JournalTarget;target=$FixtureTarget;runtimeContractSha256=('f'*64)}
        [IO.File]::WriteAllText($IntegratedNativePointerPath,($SelectedBNativePointer | ConvertTo-Json -Depth 3), (New-Object Text.UTF8Encoding($false)))
        [IO.File]::WriteAllText($JournalBRestartTrigger,'authorize-disposable-exact-b-wpf')
        $RealBWpfRestarted = $false
        for ($RestartAttempt=0; $RestartAttempt -lt 450; $RestartAttempt++) {
          if ([IO.File]::Exists($JournalRestartedCommit) -and [IO.File]::Exists($JournalRestartedReceipt) -and -not $IntegratedGuardian.HasExited) { $RealBWpfRestarted = $true; break }
          if ($IntegratedGuardian.HasExited) { break }
          Start-Sleep -Milliseconds 120
        }
        if (-not $RealBWpfRestarted -and $IntegratedGuardian.HasExited) {
          Write-Output ('Independent Guardian B restart failed phase: ' + $IntegratedGuardian.StandardError.ReadToEnd())
          if ([IO.File]::Exists($JournalIntegratedDiagnostic)) { Write-Output ('OS-owned B worker diagnostic: ' + [IO.File]::ReadAllText($JournalIntegratedDiagnostic)) }
        }
        Assert-True $RealBWpfRestarted 'Actual Guardian-owned B WPF process did not reach independently attested restarted/4.'
        # Existence is not publication: the independent native Guardian
        # creates its milestone with FileShare.None and flushes it BEFORE
        # releasing the handle. Never race that in-progress write. The
        # bounded retry only waits for the SAME exact evidence, not weaker
        # proof or a rewritten/borrowed journal generation.
        $RestartEvidenceReadable = $false
        $RestartEvidenceLastError = 'native-file-still-owned'
        for ($EvidenceAttempt=0; $EvidenceAttempt -lt 75; $EvidenceAttempt++) {
          try {
            $BRestartWitness = ConvertFrom-Json -ErrorAction Stop -InputObject ([IO.File]::ReadAllText($JournalRestartedReceipt))
            $BRestartJournal = ConvertFrom-Json -ErrorAction Stop -InputObject ([IO.File]::ReadAllText($JournalData))
            $BRestartCommit = ConvertFrom-Json -ErrorAction Stop -InputObject ([IO.File]::ReadAllText($JournalRestartedCommit))
            $RestartEvidenceReadable = $true
            break
          } catch {
            $RestartEvidenceLastError = $_.Exception.GetType().Name
            if ($IntegratedGuardian.HasExited) { break }
            Start-Sleep -Milliseconds 80
          }
        }
        Assert-True $RestartEvidenceReadable ("Guardian B restarted/4 commit was not durably readable after bounded publish wait: " + $RestartEvidenceLastError)
        $BRunningProcesses = @(Get-CimInstance Win32_Process -Filter "Name='EquinoxLocal.exe'" -ErrorAction SilentlyContinue |
          Where-Object { -not [string]::IsNullOrWhiteSpace($_.ExecutablePath) -and (Same-Path $_.ExecutablePath $StableExe) })
        Assert-True ($BRestartWitness.transactionId -ceq $JournalId -and $BRestartWitness.sourceSha -ceq $JournalTarget -and
          $BRestartWitness.guardianPid -eq $IntegratedGuardian.Id -and $BRestartWitness.runtimeContractSha256 -ceq ('f'*64) -and
          $BRestartCommit.stage -ceq 'restarted' -and $BRestartCommit.sequence -eq 4 -and
          $BRestartJournal.stage -ceq 'restarted' -and $BRestartJournal.sequence -eq 4 -and
          $BRestartCommit.journalSha256 -ceq ((Get-FileHash -LiteralPath $JournalData -Algorithm SHA256).Hash.ToLowerInvariant()) -and
          $BRunningProcesses.Count -eq 1 -and $BRunningProcesses[0].ProcessId -eq $BRestartWitness.shellPid) 'Real Windows B WPF OS PID + exact native restarted/4 journal proof failed.'
        # A WPF PID is not proof its Node backend booted from source B.
        # Require FOUR consecutive independently fetched loopback responses
        # with the exact immutable B managed-source SHA while the same WPF B
        # PID, the native B pointer and native messaging owner remain stable.
        # Hosted CI cannot require a connected real Chrome profile/tunnel,
        # so this proves backend SOURCE B identity, not full Browser health.
        $BBackendConsecutive = 0
        $BBackendSamples = 0
        $BBackendLastState = 'no-response'
        $BBackendLastPhase = 'not-started'
        $BBackendLastException = 'none'
        $BBackendHttpOk = $false
        $BBackendSourceMatch = $false
        $BBackendNativeMatch = $false
        $BBackendManifestMatch = $false
        $BBackendRegistryMatch = $false
        for ($BBackendAttempt=0; $BBackendAttempt -lt 75; $BBackendAttempt++) {
          if ($IntegratedGuardian.HasExited) { break }
          $BRunningNow = @(Get-CimInstance Win32_Process -Filter "Name='EquinoxLocal.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.ProcessId -eq $BRestartWitness.shellPid -and (Same-Path $_.ExecutablePath $StableExe) })
          if ($BRunningNow.Count -ne 1) { $BBackendLastState = 'wpf-exited'; break }
          try {
            $BBackendLastPhase = 'http-status'
            $BBackendStatus = (Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:24891/api/v1/status' -TimeoutSec 3).Content | ConvertFrom-Json
            $BBackendHttpOk = ($BBackendStatus.ok -eq $true)
            $BBackendLastState = [string]$BBackendStatus.status.installation.kind
            $BBackendSourceMatch = ($BBackendLastState -ceq 'managed-source' -and
              $BBackendStatus.status.installation.sourceSha -ceq $JournalTarget)
            $BBackendLastPhase = 'native-pointer'
            $BNativeCurrent = [IO.File]::ReadAllText($IntegratedNativePointerPath) | ConvertFrom-Json
            $BBackendNativeMatch = ($BNativeCurrent.sourceSha -ceq $JournalTarget)
            $BBackendLastPhase = 'native-messaging'
            $BManifestCurrent = [IO.File]::ReadAllText($ExpectedManifestPath) | ConvertFrom-Json
            $BExpectedLauncher = Join-Path $StagedBRelease 'runtime\browser\equinox-browser-native-host.exe'
            $BBackendManifestMatch = (Same-Path $BManifestCurrent.path $BExpectedLauncher)
            $BManifestRegistry = [string](Get-Item -LiteralPath $NativeRegistryKey -ErrorAction Stop).GetValue('')
            $BBackendRegistryMatch = (Same-Path $BManifestRegistry $ExpectedManifestPath)
            if ($BBackendHttpOk -and $BBackendSourceMatch -and $BBackendNativeMatch -and
                $BBackendManifestMatch -and $BBackendRegistryMatch) {
              $BBackendConsecutive++
              $BBackendSamples++
            } else { $BBackendConsecutive = 0 }
          } catch {
            $BBackendConsecutive = 0
            # Only bounded error CLASS and prior phase: never log exception
            # messages, URLs, private paths, tokens or registry values.
            $BBackendLastException = $_.Exception.GetType().Name
            $BBackendLastState = 'probe-exception'
          }
          if ($BBackendConsecutive -ge 4) { break }
          Start-Sleep -Milliseconds 500
        }
        Write-Output ("Hosted B Control Center identity: consecutive={0}; samples={1}; lastKind={2}; phase={3}; exceptionClass={4}; httpOk={5}; sourceMatch={6}; nativeMatch={7}; manifestMatch={8}; registryMatch={9}" -f
          $BBackendConsecutive,$BBackendSamples,$BBackendLastState,$BBackendLastPhase,$BBackendLastException,
          $BBackendHttpOk,$BBackendSourceMatch,$BBackendNativeMatch,$BBackendManifestMatch,$BBackendRegistryMatch)
        if ($BBackendConsecutive -lt 4) {
          # Product WPF already emits diagnostics to its OWN per-user log.
          # Expose only the most recent bounded operation/error CLASS on
          # disposable CI, never the full exception message or owned paths.
          $BHostedWpfLog = Join-Path $OwnedInstallRoot 'logs\windows-shell-runtime.log'
          if ([IO.File]::Exists($BHostedWpfLog)) {
            # The OS-owned Windows shell writes bounded lifecycle events.
          # Reveal ONLY stable operation names, error CLASS, numeric exit
          # codes and fixed known runtime phases. Never emit raw diagnostic
          # contents, which may include credentials or local machine paths.
          $BHostedErrors = @([IO.File]::ReadAllLines($BHostedWpfLog) | Select-Object -Last 40 | ForEach-Object {
              $fields = $_ -split ' ', 3
              if ($fields.Count -ge 2 -and $fields[1] -cmatch '^[a-zA-Z0-9_-]{1,80}$') {
                $operation = $fields[1]
                $classification = 'none'
                if ($fields.Count -eq 3) {
                  $detail = $fields[2]
                  if ($detail -match '^([a-zA-Z][a-zA-Z0-9]{0,99}(?:Exception|Error)):') {
                    $classification = $Matches[1]
                  } elseif ($operation -ceq 'runtime-gate-exit' -and $detail -match '^exit=(-?[0-9]{1,5})') {
                    $classification = 'exit-' + $Matches[1]
                    if ($detail -match 'state=runtime-start-failed; reason=(runtime-location|platform-contract|os-ENOENT|os-ENOTDIR|os-EACCES|os-EPERM|os-EISDIR|os-EINVAL|os-EMFILE|js-TypeError|js-SyntaxError|js-RangeError|js-ReferenceError|js-AggregateError|unspecified)') {
                      $classification += '-supervisor-' + $Matches[1]
                      if ($detail -match 'state=runtime-start-failed; reason=[a-zA-Z0-9-]+; phase=(entry|platform|paths|identity|transport-read|local-child|tunnel-prepare|tunnel-child)') {
                        $classification += '-phase-' + $Matches[1]
                      }
                    }
                    foreach ($indicator in @('ERR_MODULE_NOT_FOUND','MODULE_NOT_FOUND','EADDRINUSE','ENOENT','EACCES','EPERM','SyntaxError','TypeError')) {
                      if ($detail.Contains($indicator)) { $classification += '-' + $indicator; break }
                    }
                  } elseif ($operation -ceq 'runtime-start-phase') {
                    foreach ($phase in @('job-created','gate-started','assign-started','assigned','gate-released','child-started')) {
                      if ($detail -ceq $phase) { $classification = $phase; break }
                    }
                  } elseif ($operation -ceq 'runtime-discovery') {
                    if ($detail -match 'supervisor=True') { $classification = 'supervisor-present' }
                    elseif ($detail -match 'supervisor=False') { $classification = 'supervisor-missing' }
                  }
                }
                '{0}:{1}' -f $operation,$classification
              }
            })
            Write-Output ('Hosted B native WPF bounded lifecycle classifications: ' + ($BHostedErrors -join ','))
          }
        }
        Assert-True ($BBackendConsecutive -ge 4) 'Guardian B WPF is running but real Control Center/Native Messaging does not report sustained exact B source identity.'
        # Native Guardian itself must rehash the retained A WPF tree AFTER B
        # really starts and emit create-only proof bound to restarted/4.
        # This is only A recovery readiness, never rollback/commit authority.
        $RetainedAProofPath = Join-Path $JournalDataDir ("$JournalId.retained-a.json")
        $RetainedADeadline = [DateTime]::UtcNow.AddSeconds(8)
        while (-not (Test-Path -LiteralPath $RetainedAProofPath) -and [DateTime]::UtcNow -lt $RetainedADeadline) {
          Start-Sleep -Milliseconds 100
        }
        Assert-True (Test-Path -LiteralPath $RetainedAProofPath) 'Native Guardian did not independently prove intact retained Stable A after B WPF restart.'
        $RetainedAProof = ConvertFrom-Json ([IO.File]::ReadAllText($RetainedAProofPath))
        Assert-True ($RetainedAProof.schemaVersion -eq 1 -and
          $RetainedAProof.transactionId -ceq $JournalId -and
          $RetainedAProof.disposition -ceq 'retained-a-verified-no-restore-authority' -and
          $RetainedAProof.stableVersion -ceq $FixtureVersion -and
          $RetainedAProof.journalSequence -eq 4 -and
          $RetainedAProof.workerPid -eq $WorkerProcess.Id -and
          $RetainedAProof.guardianPid -eq $IntegratedGuardian.Id -and
          $RetainedAProof.journalSha256 -ceq ((Get-FileHash -LiteralPath $JournalData -Algorithm SHA256).Hash.ToLowerInvariant())) 'Native Guardian retained A proof did not bind exact Stable version, live owners and restarted B journal SHA.'
        Write-Output "Windows $FixtureTarget Guardian independently verified retained Stable A WPF backup after real B restart (no restore authority)."
        Write-Output "Windows $FixtureTarget real Guardian-owned B WPF process, restarted/4 AND four consecutive B backend identity samples PASSED (Browser/tunnel sustained health NOT YET certified)."
        # Second hosted-only negative-B checkpoint: terminate only the exact
        # Guardian-receipted disposable B WPF PID and its owned child tree.
        # Never do this in production or against arbitrary user processes.
        $ActualBProcess = [Diagnostics.Process]::GetProcessById([int]$BRestartWitness.shellPid)
        Assert-True (-not $ActualBProcess.HasExited -and
          $ActualBProcess.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture) -ceq $BRestartWitness.shellStartTimeUtcTicks -and
          (Same-Path $ActualBProcess.MainModule.FileName $StableExe)) 'Hosted negative B crash refused unverified WPF PID/creation time/path.'
        $TaskKill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
        Assert-True ([IO.File]::Exists($TaskKill)) 'Hosted Windows lacks its OS-owned bounded process-tree terminator.'
        & $TaskKill /PID ([string]$BRestartWitness.shellPid) /T /F | Out-Null
        Assert-True ($LASTEXITCODE -eq 0) 'Hosted negative B could not stop exact disposable WPF process tree.'
        Assert-True ($ActualBProcess.WaitForExit(8000)) 'Original B WPF did not exit after hosted-only crash.'
        $ActualBProcess.Dispose()
        # Original worker remains live, original Guardian retains the SAME
        # exclusive OS writer lease. Only it may advance rollback_started/5;
        # independent read-only pinned Auditor proves original kernel PID,
        # logon, OS sharing lock and nonce/HMAC afterwards.
        [IO.File]::WriteAllText($JournalNegativeBTrigger, 'hosted-exact-b-exited')
        $RollbackProofReady = $false
        for ($RBAttempt = 0; $RBAttempt -lt 340; $RBAttempt++) {
          if ([IO.File]::Exists($JournalNegativeBReceipt) -and
              [IO.File]::Exists($JournalRollbackStartCommit) -and
              -not $IntegratedGuardian.HasExited -and -not $WorkerProcess.HasExited) {
            $RollbackProofReady = $true
            break
          }
          if ($IntegratedGuardian.HasExited -or $WorkerProcess.HasExited) { break }
          Start-Sleep -Milliseconds 125
        }
        if (-not $RollbackProofReady -and [IO.File]::Exists($JournalIntegratedDiagnostic)) {
          Write-Output ('Hosted OS-owned negative-B diagnostic: ' + [IO.File]::ReadAllText($JournalIntegratedDiagnostic))
        }
        Assert-True $RollbackProofReady 'Original Guardian failed to authorize and independently attest read-only rollback_started/5 after real B WPF death.'
        $NegativeBReceipt = ConvertFrom-Json ([IO.File]::ReadAllText($JournalNegativeBReceipt))
        $RollbackRecord = ConvertFrom-Json ([IO.File]::ReadAllText($JournalData))
        $RollbackCommit = ConvertFrom-Json ([IO.File]::ReadAllText($JournalRollbackStartCommit))
        Assert-True ($NegativeBReceipt.osLeaseAttested -eq $true -and
          $NegativeBReceipt.physicalARestored -eq $false -and
          $NegativeBReceipt.transactionId -ceq $JournalId -and
          $NegativeBReceipt.sourceSha -ceq $JournalTarget -and
          $NegativeBReceipt.stage -ceq 'rollback_started' -and $NegativeBReceipt.sequence -eq 5 -and
          $NegativeBReceipt.guardianPid -eq $IntegratedGuardian.Id -and
          $RollbackRecord.stage -ceq 'rollback_started' -and $RollbackRecord.sequence -eq 5 -and
          $RollbackCommit.guardianPid -eq $IntegratedGuardian.Id -and
          $RollbackCommit.journalSha256 -ceq ((Get-FileHash -LiteralPath $JournalData -Algorithm SHA256).Hash.ToLowerInvariant())) 'Host stage5 original Guardian OS-held lease/nonce/HMAC proof is not exact.'
        Assert-True ((Test-Path -LiteralPath $IntegratedBackup) -and (Test-Path -LiteralPath $IntegratedBMarker)) 'Read-only stage5 OS proof silently mutated retained A or B slot.'
        Write-Output "Windows $FixtureTarget original Guardian negative-B rollback_started/5 and live OS lease/HMAC READ-ONLY audit PASSED; A still retained, no restore."
        # HOSTED-ONLY independent physical A confirmation; the worker uses
        # its exact original Guardian OS witness and the fixed mutual HMAC
        # action under the SAME original kernel-held writer lease. This MUST
        # never be used for unattended user Main rollback until A pointers,
        # Native Messaging, WPF A and four health checks are also complete.
        [IO.File]::WriteAllText($JournalPhysicalRestoreTrigger, 'hosted-only-negative-B-approved')
        $PhysicalARestoreProof = $false
        for ($PhysicalTry = 0; $PhysicalTry -lt 330; $PhysicalTry++) {
          if ([IO.File]::Exists($JournalPhysicalRestoreReceipt) -and
              -not $IntegratedGuardian.HasExited -and -not $WorkerProcess.HasExited) {
            $PhysicalARestoreProof = $true
            break
          }
          if ($IntegratedGuardian.HasExited -or $WorkerProcess.HasExited) { break }
          Start-Sleep -Milliseconds 125
        }
        if (-not $PhysicalARestoreProof -and [IO.File]::Exists($JournalIntegratedDiagnostic)) {
          Write-Output ('Hosted original Guardian physical A diagnostic: ' + [IO.File]::ReadAllText($JournalIntegratedDiagnostic))
        }
        Assert-True $PhysicalARestoreProof 'Live original Guardian did not attest installed physical A after hosted negative B.'
        $PhysicalReceipt = ConvertFrom-Json ([IO.File]::ReadAllText($JournalPhysicalRestoreReceipt))
        $FailedBQuarantine = Join-Path (Split-Path -Parent $OwnedProgramRoot) ('.equinox-shell-failed-' + $JournalId)
        $BackupAfterRestore = Join-Path (Split-Path -Parent $OwnedProgramRoot) ('.equinox-shell-backup-' + $JournalId)
        $OriginalAExe = Join-Path $ReleaseDir 'runtime\shell\EquinoxLocal.exe'
        Assert-True ($PhysicalReceipt.transactionId -ceq $JournalId -and
          $PhysicalReceipt.stage -ceq 'physical_a_restored_pending_native_and_source_commit' -and
          $PhysicalReceipt.guardianPid -eq $IntegratedGuardian.Id -and
          [IO.File]::Exists($StableExe) -and [IO.File]::Exists($OriginalAExe) -and
          ((Get-FileHash -LiteralPath $StableExe -Algorithm SHA256).Hash -ceq (Get-FileHash -LiteralPath $OriginalAExe -Algorithm SHA256).Hash) -and
          [IO.File]::Exists((Join-Path $FailedBQuarantine 'native-b-ci-only.marker')) -and
          -not [IO.Directory]::Exists($BackupAfterRestore)) 'Physical A restore lacks exact A/B files or original owner proof.'
        $StillStage5 = ConvertFrom-Json ([IO.File]::ReadAllText($JournalData))
        Assert-True ($StillStage5.stage -ceq 'rollback_started' -and $StillStage5.sequence -eq 5 -and
          $RollbackCommit.journalSha256 -ceq ((Get-FileHash -LiteralPath $JournalData -Algorithm SHA256).Hash.ToLowerInvariant()) -and
          [IO.File]::ReadAllText($IntegratedSourcePointerPath) -ceq $SelectedBSourcePointer) 'Physical A must not fabricate stage6 or prematurely claim A source selection.'
        Write-Output "Windows $FixtureTarget original Guardian OS-authorized physical A restore PASSED; quarantined B retained, stage5 unchanged, A pointer/health NOT YET committed."
        # Start ONLY the original Windows worker's second fixed S request,
        # under SAME still-held Guardian writer lease. No production updater
        # imports this hosted fixture or promotes rollback stage6.
        [IO.File]::WriteAllText($JournalStableSelectionTrigger, 'hosted-original-guardian-select-a-after-physical-restore')
        $StableSelectionConfirmed = $false
        for ($SelectTry=0; $SelectTry -lt 330; $SelectTry++) {
          if ([IO.File]::Exists($JournalStableSelectionReceipt) -and
              -not $IntegratedGuardian.HasExited -and -not $WorkerProcess.HasExited) {
            $StableSelectionConfirmed = $true
            break
          }
          if ($IntegratedGuardian.HasExited -or $WorkerProcess.HasExited) { break }
          Start-Sleep -Milliseconds 125
        }
        if (-not $StableSelectionConfirmed -and [IO.File]::Exists($JournalIntegratedDiagnostic)) {
          Write-Output ('Hosted OS-owned A source/native/NM selection diagnostic: ' + [IO.File]::ReadAllText($JournalIntegratedDiagnostic))
        }
        Assert-True $StableSelectionConfirmed 'Original Guardian failed to confirm OS-HMAC authorized A source/native/NM selection.'
        $StableSelectionReceipt = ConvertFrom-Json ([IO.File]::ReadAllText($JournalStableSelectionReceipt))
        $ExactStableSourceRoot = Join-Path $NativeTxRoot ("sources\$JournalCurrent")
        $ExactStableSourcePointer = @('schemaVersion=1',"sourceRoot=$ExactStableSourceRoot","sha=$JournalCurrent",'') -join "`n"
        $ExpectedStableBrowserLauncher = Join-Path $ReleaseDir 'runtime\browser\equinox-browser-native-host.exe'
        $SelectedARegistryOwner = [string](Get-Item -LiteralPath $NativeRegistryKey -ErrorAction Stop).GetValue('')
        $SelectedAManifest = [IO.File]::ReadAllText($ExpectedManifestPath) | ConvertFrom-Json
        $AfterStableSelection = ConvertFrom-Json ([IO.File]::ReadAllText($JournalData))
        Assert-True ([IO.File]::Exists($JournalNativeRestoredCommit)) 'Original Guardian did not persist durable stage6 marker.'
        $NativeRestoredCommit = ConvertFrom-Json ([IO.File]::ReadAllText($JournalNativeRestoredCommit))
        Assert-True ($StableSelectionReceipt.transactionId -ceq $JournalId -and
          $StableSelectionReceipt.stage -ceq 'rollback_native_restored' -and
          $StableSelectionReceipt.guardianPid -eq $IntegratedGuardian.Id -and
          [IO.File]::ReadAllText($IntegratedSourcePointerPath) -ceq $ExactStableSourcePointer -and
          -not [IO.File]::Exists($IntegratedNativePointerPath) -and
          (Same-Path $SelectedARegistryOwner $ExpectedManifestPath) -and
          (Same-Path $SelectedAManifest.path $ExpectedStableBrowserLauncher) -and
          [IO.File]::Exists($StableExe) -and
          ((Get-FileHash -LiteralPath $StableExe -Algorithm SHA256).Hash -ceq (Get-FileHash -LiteralPath $OriginalAExe -Algorithm SHA256).Hash) -and
          [IO.File]::Exists((Join-Path $FailedBQuarantine 'native-b-ci-only.marker')) -and
          $AfterStableSelection.stage -ceq 'rollback_native_restored' -and $AfterStableSelection.sequence -eq 6 -and
          $NativeRestoredCommit.schemaVersion -eq 1 -and
          $NativeRestoredCommit.transactionId -ceq $JournalId -and
          $NativeRestoredCommit.stage -ceq 'rollback_native_restored' -and $NativeRestoredCommit.sequence -eq 6 -and
          $NativeRestoredCommit.guardianPid -eq $IntegratedGuardian.Id -and
          $NativeRestoredCommit.journalSha256 -ceq ((Get-FileHash -LiteralPath $JournalData -Algorithm SHA256).Hash.ToLowerInvariant())) 'Original Guardian failed exact A identities or durable restored-A stage6 SHA/PID receipt.'
        # Physically recovered Stable A is NOT WPF/backend A health.
        Write-Output "Windows $FixtureTarget original Guardian OS-authorized Stable A source/native/NM selection and durable rollback_native_restored/6 PASSED; A WPF health NOT YET committed."
        # Fixed hosted-only original worker L grant: real native Guardian
        # launches exactly Stable A WPF, attests OS SID/logon/PID/birth and
        # existing signed WPF Reopen pipe. NO backend health is claimed.
        [IO.File]::WriteAllText($JournalRelaunchATrigger,'ci-only-original-guardian-relaunch-after-stage6')
        $AReopened = $false
        for ($ReopenTry=0; $ReopenTry -lt 500; $ReopenTry++) {
          if ([IO.File]::Exists($JournalRelaunchAReceipt) -and
              -not $IntegratedGuardian.HasExited -and -not $WorkerProcess.HasExited) {
            $AReopened = $true
            break
          }
          if ($IntegratedGuardian.HasExited -or $WorkerProcess.HasExited) { break }
          Start-Sleep -Milliseconds 125
        }
        if (-not $AReopened -and [IO.File]::Exists($JournalIntegratedDiagnostic)) {
          Write-Output ('Original Guardian native A WPF relaunch diagnostic: ' + [IO.File]::ReadAllText($JournalIntegratedDiagnostic))
        }
        Assert-True $AReopened 'Original Guardian never confirmed original Stable A native WPF PID.'
        $RelaunchAReceipt = ConvertFrom-Json ([IO.File]::ReadAllText($JournalRelaunchAReceipt))
        Assert-True ([IO.File]::Exists($JournalRelaunchACommit)) 'Original Guardian missing write-through WPF A restart receipt.'
        $WpfAProof = ConvertFrom-Json ([IO.File]::ReadAllText($JournalRelaunchACommit))
        $AProcess = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $WpfAProof.shellPid) -ErrorAction SilentlyContinue
        $AfterWpfRestart = ConvertFrom-Json ([IO.File]::ReadAllText($JournalData))
        Assert-True ($RelaunchAReceipt.transactionId -ceq $JournalId -and
          $RelaunchAReceipt.stage -ceq 'wpf_a_restarted_health_pending' -and
          $RelaunchAReceipt.guardianPid -eq $IntegratedGuardian.Id -and
          $RelaunchAReceipt.shellPid -eq $WpfAProof.shellPid -and
          $WpfAProof.schemaVersion -eq 1 -and
          $WpfAProof.transactionId -ceq $JournalId -and
          $WpfAProof.sourceSha -ceq $JournalCurrent -and
          $WpfAProof.stableVersion -ceq $FixtureVersion -and
          $WpfAProof.guardianPid -eq $IntegratedGuardian.Id -and
          $WpfAProof.stage6JournalSha256 -ceq $NativeRestoredCommit.journalSha256 -and
          $WpfAProof.shellPid -gt 0 -and
          $null -ne $AProcess -and (Same-Path $AProcess.ExecutablePath $StableExe) -and
          $AfterWpfRestart.stage -ceq 'rollback_native_restored' -and $AfterWpfRestart.sequence -eq 6) 'Original Guardian WPF A relaunch lost exact PID/Stable identity or prematurely marked A healthy.'
        Write-Output "Windows $FixtureTarget original Guardian authenticated Stable A native WPF relaunch OS PID/reopen pipe PASSED; stage6 preserved, A backend four-health NOT YET committed."
        [IO.File]::WriteAllText($JournalHealthATrigger,'hosted-original-guardian-four-independent-a-samples')
        $FourHealthyA = $false
        for ($HealthyTry=0; $HealthyTry -lt 900; $HealthyTry++) {
          if ([IO.File]::Exists($JournalHealthAReceipt) -and
              -not $IntegratedGuardian.HasExited -and -not $WorkerProcess.HasExited) {
            $FourHealthyA = $true
            break
          }
          if ($IntegratedGuardian.HasExited -or $WorkerProcess.HasExited) { break }
          Start-Sleep -Milliseconds 125
        }
        if (-not $FourHealthyA -and [IO.File]::Exists($JournalIntegratedDiagnostic)) {
          Write-Output ('Hosted original A four-health diagnostic: ' + [IO.File]::ReadAllText($JournalIntegratedDiagnostic))
        }
        Assert-True $FourHealthyA 'Original Guardian did not prove four independently healthy A backend/source/NM samples.'
        Assert-True ([IO.File]::Exists($JournalHealthyACommit)) 'Original Guardian stage7 SHA/PID health marker missing.'
        $AHealthReceipt = ConvertFrom-Json ([IO.File]::ReadAllText($JournalHealthAReceipt))
        $AStage7 = ConvertFrom-Json ([IO.File]::ReadAllText($JournalData))
        $AStage7Commit = ConvertFrom-Json ([IO.File]::ReadAllText($JournalHealthyACommit))
        $AStillWpf = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $WpfAProof.shellPid) -ErrorAction SilentlyContinue
        Assert-True ($AHealthReceipt.transactionId -ceq $JournalId -and
          $AHealthReceipt.stage -ceq 'rollback_healthy' -and $AHealthReceipt.sequence -eq 7 -and
          $AHealthReceipt.guardianPid -eq $IntegratedGuardian.Id -and
          $AHealthReceipt.shellPid -eq $WpfAProof.shellPid -and
          $AStage7.stage -ceq 'rollback_healthy' -and $AStage7.sequence -eq 7 -and
          $AStage7Commit.transactionId -ceq $JournalId -and
          $AStage7Commit.stage -ceq 'rollback_healthy' -and $AStage7Commit.sequence -eq 7 -and
          $AStage7Commit.guardianPid -eq $IntegratedGuardian.Id -and
          $AStage7Commit.journalSha256 -ceq ((Get-FileHash -LiteralPath $JournalData -Algorithm SHA256).Hash.ToLowerInvariant()) -and
          $null -ne $AStillWpf -and (Same-Path $AStillWpf.ExecutablePath $StableExe) -and
          [IO.File]::ReadAllText($IntegratedSourcePointerPath) -ceq $ExactStableSourcePointer -and
          -not [IO.File]::Exists($IntegratedNativePointerPath) -and
          (Same-Path $SelectedAManifest.path $ExpectedStableBrowserLauncher) -and
          [IO.File]::Exists((Join-Path $FailedBQuarantine 'native-b-ci-only.marker'))) 'Original Guardian stage7 lacks four A-health OS identity, SHA marker or retained B quarantine.'
        Write-Output "Windows $FixtureTarget original Guardian FOUR consecutive Stable A backend/source/native/NM health and durable rollback_healthy/7 PASSED; terminal rolled_back/8 NOT YET committed."
        # The original worker alone may ask original Guardian to durably
        # finalize stage8 after stage7 SHA/PID, stage6 WPF birth and intact B.
        [IO.File]::WriteAllText($JournalTerminalATrigger, 'hosted-original-guardian-terminal-after-stage7')
        $TerminalAConfirmed = $false
        for ($TerminalTry=0; $TerminalTry -lt 460; $TerminalTry++) {
          if ([IO.File]::Exists($JournalTerminalAReceipt) -and
              -not $IntegratedGuardian.HasExited -and -not $WorkerProcess.HasExited) {
            $TerminalAConfirmed = $true
            break
          }
          if ($IntegratedGuardian.HasExited -or $WorkerProcess.HasExited) { break }
          Start-Sleep -Milliseconds 125
        }
        if (-not $TerminalAConfirmed -and [IO.File]::Exists($JournalIntegratedDiagnostic)) {
          Write-Output ('Original Guardian terminal stage8 diagnostic: ' + [IO.File]::ReadAllText($JournalIntegratedDiagnostic))
        }
        Assert-True $TerminalAConfirmed 'Original OS Guardian did not certify terminal rolled_back/8.'
        Assert-True ([IO.File]::Exists($JournalTerminalACommit)) 'Original Guardian missing terminal stage8 SHA/PID commit marker.'
        $ATerminalReceipt = ConvertFrom-Json ([IO.File]::ReadAllText($JournalTerminalAReceipt))
        $ATerminalRecord = ConvertFrom-Json ([IO.File]::ReadAllText($JournalData))
        $ATerminalCommit = ConvertFrom-Json ([IO.File]::ReadAllText($JournalTerminalACommit))
        $ATerminalWpf = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $WpfAProof.shellPid) -ErrorAction SilentlyContinue
        Assert-True ($ATerminalReceipt.transactionId -ceq $JournalId -and
          $ATerminalReceipt.stage -ceq 'rolled_back' -and $ATerminalReceipt.sequence -eq 8 -and
          $ATerminalReceipt.failedBQuarantineRetained -eq $true -and
          $ATerminalReceipt.guardianPid -eq $IntegratedGuardian.Id -and
          $ATerminalRecord.stage -ceq 'rolled_back' -and $ATerminalRecord.sequence -eq 8 -and
          $ATerminalCommit.schemaVersion -eq 1 -and $ATerminalCommit.transactionId -ceq $JournalId -and
          $ATerminalCommit.stage -ceq 'rolled_back' -and $ATerminalCommit.sequence -eq 8 -and
          $ATerminalCommit.guardianPid -eq $IntegratedGuardian.Id -and
          $ATerminalCommit.journalSha256 -ceq ((Get-FileHash -LiteralPath $JournalData -Algorithm SHA256).Hash.ToLowerInvariant()) -and
          $AStage7Commit.guardianPid -eq $ATerminalCommit.guardianPid -and
          $NativeRestoredCommit.guardianPid -eq $ATerminalCommit.guardianPid -and
          $WpfAProof.guardianPid -eq $ATerminalCommit.guardianPid -and
          $null -ne $ATerminalWpf -and (Same-Path $ATerminalWpf.ExecutablePath $StableExe) -and
          (Same-Path $SelectedAManifest.path $ExpectedStableBrowserLauncher) -and
          [IO.File]::ReadAllText($IntegratedSourcePointerPath) -ceq $ExactStableSourcePointer -and
          -not [IO.File]::Exists($IntegratedNativePointerPath) -and
          [IO.File]::Exists((Join-Path $FailedBQuarantine 'native-b-ci-only.marker'))) 'Terminal stage8 allowed stale Guardian or changed A/B identity, failed quarantine or forged SHA/PID.'
        Write-Output "Windows $FixtureTarget original Guardian OS/HMAC durable terminal rolled_back/8 SHA/PID PASSED; failed B SHA quarantine RETAINED, cleanup NOT YET authorized."
        # Disposable fixture teardown only. Subsequent orphan journal audit
        # must see no remaining A WPF, even after original Guardian death.
        Stop-OwnedShell $StableExe
        $IntegratedGuardian.Kill()
        Assert-True ($IntegratedGuardian.WaitForExit(5000)) 'Native supervisor force-kill did not stop its Windows process.'
        # A durable stage5 receipt is NOT authority after the original
        # OS owner dies. The exact installed read-only auditor must refuse
        # the now-dead named-pipe SERVER PID / released exclusive lease.
        Assert-True ((Invoke-GuardianCheck '--audit-native-rollback-owner') -eq 70) 'Dead Guardian replayed a stale stage5 owner receipt as live OS restore authority.'
        Write-Output "Windows $FixtureTarget original Guardian post-death stage5 OS owner replay REFUSED."
        $IntegratedRecord = ConvertFrom-Json ([IO.File]::ReadAllText($JournalData))
        $NativeStagedReceipt = ConvertFrom-Json ([IO.File]::ReadAllText($JournalNativeStagedCommit))
        $ShellStoppedReceipt = ConvertFrom-Json ([IO.File]::ReadAllText($JournalShellStoppedCommit))
        $SwitchedReceipt = ConvertFrom-Json ([IO.File]::ReadAllText($JournalSwitchedCommit))
        Assert-True ($IntegratedRecord.stage -ceq 'rolled_back' -and $IntegratedRecord.sequence -eq 8 -and
          $NativeStagedReceipt.stage -ceq 'native_staged' -and $NativeStagedReceipt.sequence -eq 1 -and
          $ShellStoppedReceipt.stage -ceq 'shell_stopped' -and $ShellStoppedReceipt.sequence -eq 2 -and
          $ShellStoppedReceipt.guardianPid -eq $IntegratedGuardian.Id -and
          $SwitchedReceipt.stage -ceq 'switched' -and $SwitchedReceipt.sequence -eq 3 -and
          $SwitchedReceipt.guardianPid -eq $IntegratedGuardian.Id -and
          $SwitchedReceipt.stage -ceq 'switched' -and
          $BRestartCommit.journalSha256 -ceq $RetainedAProof.journalSha256) 'Native Guardian journal stage sequence/receipts differ from physically observed milestones.'
        $StoppedWpf = @(Get-CimInstance Win32_Process -Filter "Name='EquinoxLocal.exe'" -ErrorAction SilentlyContinue |
          Where-Object { -not [string]::IsNullOrWhiteSpace($_.ExecutablePath) -and (Same-Path $_.ExecutablePath $StableExe) })
        Assert-True ($StoppedWpf.Count -eq 0) 'Hosted negative-B crash left a WPF process running after OS health-rejection proof.'
        Assert-True ((Test-Path -LiteralPath $FailedBQuarantine) -and -not (Test-Path -LiteralPath $IntegratedBackup) -and (Test-Path -LiteralPath $StableExe)) 'Real Windows physical A restore did not quarantine B and reinstall old Stable A.'
        Assert-True ((Invoke-GuardianCheck '--audit-native-journal') -eq 70) 'Native integrated supervisor allowed orphan writer-lock replay.'
      } finally {
        if ($null -ne $IntegratedGuardian) {
          try { if (-not $IntegratedGuardian.HasExited) { $IntegratedGuardian.Kill() } } catch {}
          try { $IntegratedGuardian.WaitForExit(5000) | Out-Null } catch {}
          $IntegratedGuardian.Dispose()
        }
        # Stop the exact hosted WPF B before any physical A restoration.
        if ($null -ne $StableExe) { Stop-OwnedShell $StableExe }
        # Restore real A source/native pointers even if the Guardian fails.
        [IO.File]::WriteAllBytes($IntegratedSourcePointerPath,$OriginalIntegratedSourcePointer)
        if ($null -ne $OriginalIntegratedNativePointer) { [IO.File]::WriteAllBytes($IntegratedNativePointerPath,$OriginalIntegratedNativePointer) }
        elseif ([IO.File]::Exists($IntegratedNativePointerPath)) { Remove-Item -LiteralPath $IntegratedNativePointerPath -Force -ErrorAction Stop }
        # THIS IS DISPOSABLE HOSTED CI ONLY: regardless of partial B swap or
        # Guardian crash, restore and independently preserve the real A shell
        # before any later installer tests. Never do this in user production.
        $ExpectedABBackup = Join-Path (Split-Path -Parent $OwnedProgramRoot) ('.equinox-shell-backup-' + $JournalId)
        $FailedABQuarantine = Join-Path (Split-Path -Parent $OwnedProgramRoot) ('.equinox-shell-failed-' + $JournalId)
        if (Test-Path -LiteralPath $ExpectedABBackup) {
          if (Test-Path -LiteralPath $OwnedProgramRoot) {
            Move-Item -LiteralPath $OwnedProgramRoot -Destination $FailedABQuarantine -ErrorAction Stop
          }
          Move-Item -LiteralPath $ExpectedABBackup -Destination $OwnedProgramRoot -ErrorAction Stop
          Assert-True ([IO.File]::Exists($StableExe)) 'Old Stable A executable was not restored after integrated native A/B swap.'
        }
        # Physical A already present is allowed only after the original
        # guardian produced its exact installed A/quarantined B evidence.
        # ALWAYS remove disposable failed B before restarting Stable A; this
        # deletion is test fixture teardown, NEVER automatic production GC.
        if (Test-Path -LiteralPath $FailedABQuarantine) { Remove-Item -LiteralPath $FailedABQuarantine -Recurse -Force -ErrorAction Stop }
        # Hosted test-only registry and manifest rollback happens before
        # restarting Stable A. Production always requires independent health.
        [IO.File]::WriteAllBytes($ExpectedManifestPath, $OriginalIntegratedNativeManifest)
        Remove-Item -LiteralPath $JournalGuard,$JournalAuthority,$JournalShellQuiesced,$JournalIntegratedTrigger,$JournalGuardianSpawnTrigger,$JournalGuardianPidReceipt,$JournalBRestartTrigger,$JournalRestartedReceipt,$JournalNativeStagedCommit,$JournalShellStoppedCommit,$JournalSwitchedCommit,$JournalRestartedCommit,$JournalRollbackStartCommit,$JournalNegativeBTrigger,$JournalNegativeBReceipt,$JournalPhysicalRestoreTrigger,$JournalPhysicalRestoreReceipt,$JournalStableSelectionTrigger,$JournalStableSelectionReceipt,$JournalRelaunchATrigger,$JournalRelaunchAReceipt,$JournalHealthATrigger,$JournalHealthAReceipt,$JournalTerminalATrigger,$JournalTerminalAReceipt -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $JournalIntegratedB -Recurse -Force -ErrorAction SilentlyContinue
        [IO.File]::WriteAllText($JournalData, ($JournalValue | ConvertTo-Json -Depth 5))
        $IntegratedWpfRestart = [Diagnostics.ProcessStartInfo]::new($StableExe)
        $IntegratedWpfRestart.UseShellExecute = $false
        $IntegratedWpfRestart.CreateNoWindow = $true
        [Diagnostics.Process]::Start($IntegratedWpfRestart) | Out-Null
        $IntegratedAReady = $false
        for ($IntegratedRetry=0; $IntegratedRetry -lt 120; $IntegratedRetry++) {
          $WpfOwners = @(Get-CimInstance Win32_Process -Filter "Name='EquinoxLocal.exe'" -ErrorAction SilentlyContinue |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_.ExecutablePath) -and (Same-Path $_.ExecutablePath $StableExe) })
          if ($WpfOwners.Count -eq 1) { $IntegratedAReady = $true; break }
          Start-Sleep -Milliseconds 200
        }
        Assert-True $IntegratedAReady 'Hosted Stable A WPF did not recover after forced integrated supervisor kill.'
      }
      Assert-True ((Invoke-GuardianCheck '--audit-native-journal') -eq 0) 'Hosted integrated native supervisor fixture did not restore prepared journal.'
      # First permitted REAL native journal stage mutation: prepared/0 to
      # rollback_started/1 only. The installed Guardian itself persists the
      # exact journal bytes under its own OS-exclusive writer lease; WPF and
      # Native Messaging must remain untouched. This is a disposable fixture.
      $AbortOwner = $null
      try {
        $AbortStart = [Diagnostics.ProcessStartInfo]::new($GuardianExe)
        $AbortStart.Arguments = '--hold-native-prepared-abort'
        $AbortStart.UseShellExecute = $false
        $AbortStart.CreateNoWindow = $true
        $AbortStart.RedirectStandardError = $true
        $AbortOwner = [Diagnostics.Process]::Start($AbortStart)
        Assert-True ($null -ne $AbortOwner) 'Independent native journal abort writer did not start.'
        [IO.File]::WriteAllText($JournalAbortTrigger, 'disposable-test-only')
        $AbortCommitted = $false
        for ($AbortAttempt=0; $AbortAttempt -lt 80; $AbortAttempt++) {
          if ([IO.File]::Exists($JournalAbortCommit) -and -not $AbortOwner.HasExited) { $AbortCommitted = $true; break }
          if ($AbortOwner.HasExited) { break }
          Start-Sleep -Milliseconds 110
        }
        if (-not $AbortCommitted -and $AbortOwner.HasExited) {
          Write-Output ('Native abort writer diagnostic: ' + $AbortOwner.StandardError.ReadToEnd())
        }
        Assert-True $AbortCommitted 'Native prepared abort writer did not flush its independent commit receipt.'
        $AbortOwner.Kill()
        Assert-True ($AbortOwner.WaitForExit(5000)) 'Native journal abort owner did not stop under crash fixture.'
        Assert-True ([IO.File]::Exists($JournalGuard) -and [IO.File]::Exists($JournalAuthority) -and
          [IO.File]::Exists($JournalAbortCommit)) 'Native abort writer crash lost durable ownership or commit evidence.'
        $AbortReceipt = ConvertFrom-Json ([IO.File]::ReadAllText($JournalAbortCommit))
        $ActualAbortDigest = (Get-FileHash -LiteralPath $JournalData -Algorithm SHA256).Hash.ToLowerInvariant()
        Assert-True ($AbortReceipt.transactionId -ceq $JournalId -and $AbortReceipt.stage -ceq 'rollback_started' -and
          $AbortReceipt.sequence -eq 1 -and $AbortReceipt.guardianPid -eq $AbortOwner.Id -and
          $AbortReceipt.journalSha256 -ceq $ActualAbortDigest) 'Durable native abort commit receipt does not bind exact updated bytes.'
        $AbortData = ConvertFrom-Json ([IO.File]::ReadAllText($JournalData))
        Assert-True ($AbortData.stage -ceq 'rollback_started' -and $AbortData.sequence -eq 1 -and
          $AbortData.transactionId -ceq $JournalId -and $AbortData.currentSha -ceq $JournalCurrent -and
          $AbortData.targetSha -ceq $JournalTarget) 'Independent native journal writer failed exact prepared-to-abort stage transition.'
        Assert-True ((Invoke-GuardianCheck '--audit-native-journal') -eq 70) 'Native journal stage writer orphan lock was auto-replayed.'
        Assert-True ((Invoke-GuardianCheck '--hold-native-prepared-abort') -eq 70) 'Native writer accepted duplicate prepared abort after owner crash.'
        Assert-True ((Invoke-GuardianCheck '--reconcile-native-prepared-abort') -eq 70) 'Orphan recovery admitted a still-live detached worker.'
        $WorkerProcess.Kill()
        Assert-True ($WorkerProcess.WaitForExit(5000)) 'Detached worker did not terminate before offline orphan recovery.'
        # Both OS PIDs are genuinely gone, previous Stable A shell bytes have
        # not changed, and the independent native commit SHA is still exact.
        $CommitBackup = [IO.File]::ReadAllBytes($JournalAbortCommit)
        try {
          $WrongCommit = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString($CommitBackup))
          $WrongCommit.journalSha256 = ('b' * 64)
          [IO.File]::WriteAllText($JournalAbortCommit, ($WrongCommit | ConvertTo-Json -Depth 4))
          Assert-True ((Invoke-GuardianCheck '--reconcile-native-prepared-abort') -eq 70) 'Orphan recovery accepted forged native abort commit SHA.'
        } finally { [IO.File]::WriteAllBytes($JournalAbortCommit, $CommitBackup) }
        Assert-True ((Invoke-GuardianCheck '--reconcile-native-prepared-abort') -eq 0) 'Native Guardian refused exact offline prepared abort orphan quarantine.'
        Assert-True ((Test-Path -LiteralPath $JournalQuarantinedLock) -and
          (Test-Path -LiteralPath $JournalQuarantineReceipt) -and
          -not (Test-Path -LiteralPath $JournalGuard)) 'Offline native orphan proof did not preserve a quarantine writer lock.'
        $QuarantineValue = ConvertFrom-Json ([IO.File]::ReadAllText($JournalQuarantineReceipt))
        Assert-True ($QuarantineValue.transactionId -ceq $JournalId -and
          $QuarantineValue.disposition -ceq 'quarantined-no-resume' -and
          $QuarantineValue.workerPid -eq $WorkerProcess.Id -and
          $QuarantineValue.guardianPid -eq $AbortOwner.Id -and
          $QuarantineValue.journalSha256 -ceq $ActualAbortDigest) 'Native orphan recovery receipt identity or journal digest is foreign.'
        Assert-True ((Invoke-GuardianCheck '--audit-native-journal') -eq 70) 'Quarantined native writer lock incorrectly allowed Main replay.'
        Assert-True ((Invoke-GuardianCheck '--reconcile-native-prepared-abort') -eq 70) 'Orphan quarantine could be re-executed or replayed.'
      } finally {
        if ($null -ne $AbortOwner) {
          try { if (-not $AbortOwner.HasExited) { $AbortOwner.Kill() } } catch {}
          try { $AbortOwner.WaitForExit(5000) | Out-Null } catch {}
          $AbortOwner.Dispose()
        }
        # Only disposable CI fixture permits forced journal restoration.
        Remove-Item -LiteralPath $JournalGuard,$JournalAuthority,$JournalAbortCommit,$JournalAbortTrigger,$JournalQuarantinedLock,$JournalQuarantineReceipt -Force -ErrorAction SilentlyContinue
        [IO.File]::WriteAllText($JournalData, ($JournalValue | ConvertTo-Json -Depth 5))
      }
      Assert-True ((Invoke-GuardianCheck '--audit-native-journal') -eq 0) 'Disposable native abort test could not restore prepared journal for subsequent negative cases.'
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
    Assert-True ((Invoke-GuardianCheck '--audit-native-worker-ipc') -eq 70) 'Guardian accepted an exited native owner proof endpoint.'
    Assert-True ((Invoke-GuardianCheck '--audit-native-worker-argv') -eq 70) 'Guardian accepted argv for an exited/unowned native worker.'
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
