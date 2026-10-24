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
  # This CI-only lane still performs a real fresh install followed by repair;
  # the separate full installer lane retains all Guardian security-negative
  # and native A/B rollback acceptance on another disposable hosted runner.
  $RepairOnly = ($env:EQUINOX_WINDOWS_INSTALLER_REPAIR_ONLY -ceq 'true')
  if ($RepairOnly -and ($env:GITHUB_ACTIONS -cne 'true' -or $env:EQUINOX_WINDOWS_SAME_VERSION_REPAIR -cne 'true')) {
    throw 'Repair-only acceptance requires a disposable GitHub-hosted Windows runner and genuine same-version repair.'
  }

  $GuardianAuditOnly = ($env:EQUINOX_WINDOWS_GUARDIAN_AUDIT_ONLY -ceq 'true')
  $GuardianAuditElsewhere = ($env:EQUINOX_WINDOWS_GUARDIAN_AUDIT_IN_PARALLEL -ceq 'true')
  if (($GuardianAuditOnly -or $GuardianAuditElsewhere) -and
      ($env:GITHUB_ACTIONS -cne 'true' -or $RepairOnly -or
       $env:EQUINOX_WINDOWS_SAME_VERSION_REPAIR -ceq 'true' -or
       ($GuardianAuditOnly -and $GuardianAuditElsewhere) -or
       [string]::IsNullOrWhiteSpace($env:EQUINOX_WINDOWS_INSTALL_SHA256))) {
    throw 'Separate real installed Guardian journal audit requires a current-product, exact-package disposable GitHub Windows runner.'
  }

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
    # This specialized acceptance exercises the optional legacy Main bridge.
    # The PUBLIC installer default remains Stable; no automatic enrollment.
    $EnrollExistingMain = $true
    $InstallCallStarted = [DateTimeOffset]::UtcNow
    Invoke-EquinoxLocalInstall | Out-Host
    $InstallCallCompleted = [DateTimeOffset]::UtcNow
    $EnrollExistingMain = $false
    if ($env:GITHUB_ACTIONS -ceq 'true') {
      # Never print native diagnostic details, filesystem paths or arbitrary
      # runtime log content. Report only this fixed set of WPF startup phase
      # names and bounded relative elapsed times from the actual installer.
      $AllowedPhase = @(
        'shell-startup:primary-acquired',
        'shell-startup:main-window-created',
        'runtime-start-phase:job-created',
        'runtime-start-phase:gate-started',
        'runtime-start-phase:assign-started',
        'runtime-start-phase:assigned',
        'runtime-start-phase:gate-released',
        'runtime-start-phase:child-started'
      )
      Write-Output ("Hosted first-install timing: target={0}; totalSeconds={1:F1}" -f $FixtureTarget, ($InstallCallCompleted - $InstallCallStarted).TotalSeconds)
      $ShellLogPath = Join-Path $OwnedInstallRoot 'logs\windows-shell-runtime.log'
      if ([IO.File]::Exists($ShellLogPath)) {
        # Fixed max diagnostic bytes; only exact phase values from the fixed
        # allowlist can reach public Actions logs. Never print source lines.
        $ShellLogFile = Get-Item -LiteralPath $ShellLogPath -Force
        if ($ShellLogFile.Length -gt 65536 -or ($ShellLogFile.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
          Write-Output 'Hosted first-install WPF timing log unavailable (bounded integrity check).'
        } else {
        foreach ($ShellLine in [IO.File]::ReadAllLines($ShellLogPath)) {
          if ($ShellLine -cmatch '^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?\+\d\d:\d\d) (shell-startup|runtime-start-phase) ([a-z-]+)$') {
            $PhaseName = "$($Matches[2]):$($Matches[3])"
            if ($PhaseName -cnotin $AllowedPhase) { continue }
            $PhaseInstant = [DateTimeOffset]::MinValue
            if (-not [DateTimeOffset]::TryParse($Matches[1], [ref]$PhaseInstant)) { continue }
            $Seconds = ($PhaseInstant - $InstallCallStarted).TotalSeconds
            if ($Seconds -ge 0 -and $Seconds -le 600) {
              Write-Output ("Hosted first-install WPF phase: {0}; elapsedSeconds={1:F1}" -f $PhaseName, $Seconds)
            }
          }
        }
        }
      }
    }
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

  # Vintage A packages have no independent Guardian. The real installed
  # old-Main -> new-Main acceptance must test the actual updater instead of
  # requiring test-only future Guardian components in an already shipped A.
  $SkipLegacyGuardianFixture = ($env:GITHUB_ACTIONS -ceq 'true' -and -not [string]::IsNullOrWhiteSpace($env:EQUINOX_WINDOWS_MAIN_ACCEPT_TARGET_SHA))
  $NativeABInPackage = ($env:EQUINOX_WINDOWS_NATIVE_AB_IN_PACKAGE -ceq 'true')
  if ($NativeABInPackage -and ($env:GITHUB_ACTIONS -cne 'true' -or $SkipLegacyGuardianFixture -or $RepairOnly)) {
    throw 'Native A/B package-lane ownership requires a current-product full installer running in GitHub CI.'
  }
  $HistoricRepair = ($env:EQUINOX_WINDOWS_LEGACY_REINSTALL_ACCEPTANCE -ceq 'true')
  $AcceptedOldHistoricMain = ($FixtureSourceSha -ceq '8dbe965d28e76026123ce8de34d8f1aa27c10465' -and $SkipLegacyGuardianFixture)
  $AcceptedOldSigned610 = ($FixtureSourceSha -ceq 'e85790a99e8e05ccf9997279d174b452793d6097' -and -not $SkipLegacyGuardianFixture)
  $AcceptedOldSigned612 = ($env:EQUINOX_WINDOWS_SIGNED_612_REINSTALL_ACCEPTANCE -ceq 'true' -and
    $FixtureVersion -ceq '6.1.2' -and
    $FixtureSourceSha -ceq '66786207350cc809b44fc5c376eba8912b35fa47' -and
    -not $SkipLegacyGuardianFixture)
  if ($HistoricRepair -and ($env:GITHUB_ACTIONS -cne 'true' -or
      (-not $AcceptedOldHistoricMain -and -not $AcceptedOldSigned610 -and -not $AcceptedOldSigned612) -or
      ($env:EQUINOX_WINDOWS_SIGNED_612_REINSTALL_ACCEPTANCE -ceq 'true' -and -not $AcceptedOldSigned612))) {
    throw 'Historical signed Stable repair requires exact approved old A on disposable Windows.'
  }
  # Exact published signed 6.1.2 contains its OWN older pinned runtime.
  # Do not require B's current Node/Git paths inside already installed A.
  $OldProductGitVersion = if ($AcceptedOldSigned612) { '2.53.0-4' } else { '2.56.0-1' }
  $OldProductNodeVersion = if ($AcceptedOldSigned612) { '26.12.0' } else { '26.12.1' }
  if (-not $SkipLegacyGuardianFixture) {
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
  # Run the EXACT packaged architecture-specific Win32 witness, not a
  # synthetic JS mock or a helper from ambient PATH.
  $NativeWpfWitness = Join-Path $ReleaseDir 'runtime\job\equinox-local-job-object-helper.exe'
  Assert-True ([IO.File]::Exists($NativeWpfWitness)) 'Native WPF witness executable is absent from signed release.'
  Assert-True ((Read-PeMachine $NativeWpfWitness) -eq $FixtureExpectedMachine) 'Native WPF witness PE architecture differs from WPF.'
  function Invoke-NativeWpfWitness([string]$ExpectedPid, [string]$ExpectedBirthTicks) {
    # Windows GUI subsystem executables may return early from PowerShell `&`.
    $start = [Diagnostics.ProcessStartInfo]::new($NativeWpfWitness)
    # powershell.exe runs on Windows PowerShell 5.1 / .NET Framework. Its
    # ProcessStartInfo has Arguments, not the newer ArgumentList collection.
    $start.Arguments = '--inspect-owned-wpf'
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    # The legacy .NET Framework API is EnvironmentVariables; Environment
    # is a .NET Core-only member on these hosted powershell.exe lanes.
    $start.EnvironmentVariables.Clear()
    foreach ($key in @('SystemRoot','WINDIR','USERPROFILE')) {
      $value = [Environment]::GetEnvironmentVariable($key)
      if (-not [string]::IsNullOrWhiteSpace($value)) { $start.EnvironmentVariables[$key] = $value }
    }
    $start.EnvironmentVariables['EQUINOX_LOCAL_CHECK_WPF_PID'] = $ExpectedPid
    $start.EnvironmentVariables['EQUINOX_LOCAL_CHECK_WPF_TICKS'] = $ExpectedBirthTicks
    $process = [Diagnostics.Process]::Start($start)
    if ($null -eq $process) { throw 'Native WPF witness could not start.' }
    try {
      if (-not $process.WaitForExit(5000)) {
        $process.Kill()
        throw 'Native WPF witness exceeded the bounded five-second deadline.'
      }
      if ($process.ExitCode -ne 0) { throw 'Native WPF witness rejected its inspection mode.' }
      $result = $process.StandardOutput.ReadToEnd().Trim()
      if ($result -cnotin @('running','missing','mismatch','unknown')) {
        throw 'Native WPF witness returned an unsupported bounded status.'
      }
      return $result
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


  } # Guardian-only fixture is irrelevant to a previously signed installed A.

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
  $OwnedGitStatusExe = Join-Path $InstallRoot ("runtime\toolchain\git\$OldProductGitVersion\$FixtureTarget\cmd\git.exe")
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

  if (-not $SkipLegacyGuardianFixture -and -not $RepairOnly -and -not $GuardianAuditElsewhere) {
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
    $OwnedFingerprintNode = Join-Path $InstallRoot ("runtime\toolchain\node\$OldProductNodeVersion\$FixtureTarget\node.exe")
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
  # Test-only canonical A/B checkout shapes; the disposable B script
  # starts a witness rather than performing a real update.
  $JournalSources = Join-Path $NativeTxRoot 'sources'
  $JournalRollbackRoot = Join-Path $JournalSources $JournalCurrent
  $JournalTargetRoot = Join-Path $JournalSources $JournalTarget
  $WorkerTestSourceDir = Join-Path $JournalTargetRoot 'src'
  [IO.Directory]::CreateDirectory($JournalRollbackRoot) | Out-Null
  [IO.Directory]::CreateDirectory($WorkerTestSourceDir) | Out-Null
  $WorkerTestScript = Join-Path $WorkerTestSourceDir 'equinox-local-main-update-worker.js'
  $WitnessScript = Join-Path $Root 'tests\release\owned-windows-worker-proof.mjs'
  [IO.File]::Copy($WitnessScript, $WorkerTestScript)
  [IO.File]::WriteAllText((Join-Path $JournalTargetRoot 'package.json'), '{"type":"module"}')
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
                $AuthorityKeys = if ($AcceptedOldSigned612) {
          @('schemaVersion','transactionId','stage','sequence','workerPid','guardianPid','journalSha256')
        } else {
          @('schemaVersion','transactionId','stage','sequence','workerPid','workerStartTimeUtcTicks','guardianPid','journalSha256','handoffSha256')
        }
        Assert-True ((@($AuthorityKeys | Sort-Object) -join ',') -ceq
          (@($AuthorityRecord.PSObject.Properties.Name | Sort-Object) -join ',')) 'Native authority record fields differ from the exact published A or current schema.'
        Assert-True ($AuthorityRecord.transactionId -ceq $JournalId -and
          $AuthorityRecord.stage -ceq 'prepared' -and $AuthorityRecord.sequence -eq 0 -and
          $AuthorityRecord.workerPid -eq $WorkerProcess.Id -and
          $AuthorityRecord.guardianPid -eq $AuthorityProcess.Id) 'Native authority durable record has foreign worker or journal identity.'
        if (-not $AcceptedOldSigned612) {
          Assert-True ($AuthorityRecord.workerStartTimeUtcTicks -ceq $WorkerRecord.startTimeUtcTicks -and
            $AuthorityRecord.handoffSha256 -ceq (Get-FileHash -LiteralPath $WorkerRecordPath -Algorithm SHA256).Hash.ToLowerInvariant()) 'Current Guardian authority lacks exact worker birth time and handoff hash.'
        }
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
        $RealWpf = [Diagnostics.Process]::GetProcessById($OriginalShellPid)
        try {
          $RealWpfTicks = $RealWpf.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
        } finally { $RealWpf.Dispose() }
        Assert-True ((Invoke-NativeWpfWitness ([string]$OriginalShellPid) $RealWpfTicks) -ceq 'running') 'OS native helper refused the genuine installed WPF owner.'
        $WrongWpfTicks = ([long]::Parse($RealWpfTicks) - 1).ToString([Globalization.CultureInfo]::InvariantCulture)
        Assert-True ((Invoke-NativeWpfWitness ([string]$OriginalShellPid) $WrongWpfTicks) -ceq 'mismatch') 'OS native helper accepted a forged WPF birth time.'
        Assert-True ((Invoke-NativeWpfWitness ([string]$WorkerProcess.Id) $WorkerRecord.startTimeUtcTicks) -ceq 'mismatch') 'OS native helper accepted the native worker Node as WPF.'
        Assert-True ((Invoke-NativeWpfWitness '' $RealWpfTicks) -ceq 'unknown') 'OS native helper accepted an empty WPF PID.'
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
        $QuiesceKeys = if ($AcceptedOldSigned612) {
          @('schemaVersion','transactionId','disposition','shellPid','shellStartTimeUtcTicks','guardianPid','preparedJournalSha256')
        } else {
          @('schemaVersion','transactionId','disposition','shellPid','shellStartTimeUtcTicks','workerPid','workerStartTimeUtcTicks','guardianPid','preparedJournalSha256')
        }
        Assert-True ((@($QuiesceKeys | Sort-Object) -join ',') -ceq
          (@($ShellRecord.PSObject.Properties.Name | Sort-Object) -join ',')) 'Native quiesce evidence fields differ from the exact published A or current schema.'
        Assert-True ($ShellRecord.transactionId -ceq $JournalId -and
          $ShellRecord.disposition -ceq 'stable-shell-quiesced-only' -and
          $ShellRecord.shellPid -eq $OriginalShellPid -and
          $ShellRecord.shellStartTimeUtcTicks -ceq $RealWpfTicks -and
          $ShellRecord.guardianPid -eq $ShellGuardian.Id -and
          $ShellRecord.preparedJournalSha256 -ceq ((Get-FileHash -LiteralPath $JournalData -Algorithm SHA256).Hash.ToLowerInvariant())) 'Native WPF graceful-exit proof is not exact shell/journal evidence.'
        if (-not $AcceptedOldSigned612) {
          Assert-True ($ShellRecord.workerPid -eq $WorkerProcess.Id -and
            $ShellRecord.workerStartTimeUtcTicks -ceq $WorkerRecord.startTimeUtcTicks) 'Current Guardian quiesce evidence lost worker process identity.'
        }'
        $StillOwned = @(Get-CimInstance Win32_Process -Filter "Name='EquinoxLocal.exe'" -ErrorAction SilentlyContinue |
          Where-Object { -not [string]::IsNullOrWhiteSpace($_.ExecutablePath) -and (Same-Path $_.ExecutablePath $StableExe) })
        Assert-True ($StillOwned.Count -eq 0) 'Native quiesce did not actually stop the installed WPF shell.'
        Assert-True ((Invoke-NativeWpfWitness ([string]$OriginalShellPid) $RealWpfTicks) -cne 'running') 'OS native helper accepted a terminated WPF owner.'
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
          $AbortReceipt.preparedJournalSha256 -ceq $AuthorityRecord.journalSha256 -and
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
        # The same PID may be reused after an OS process exits. A stale or
        # deliberately forged worker creation time in ANY persistent native
        # authority layer must fail before quarantine or journal advancement.
        $OriginalLock = [IO.File]::ReadAllText($JournalGuard)
        try {
          $ForgedLock = $OriginalLock.Replace('workerStartTimeUtcTicks=' + $WorkerRecord.startTimeUtcTicks,
            'workerStartTimeUtcTicks=' + ([long]::Parse($WorkerRecord.startTimeUtcTicks) - 1))
          Assert-True ($ForgedLock -cne $OriginalLock) 'Orphan writer lease did not contain the OS worker birth identity.'
          [IO.File]::WriteAllText($JournalGuard, $ForgedLock)
          Assert-True ((Invoke-GuardianCheck '--reconcile-native-prepared-abort') -eq 70) 'Orphan recovery accepted forged worker creation time in the native writer lease.'
        } finally { [IO.File]::WriteAllText($JournalGuard, $OriginalLock) }
        $OriginalHandoff = [IO.File]::ReadAllBytes($WorkerRecordPath)
        try {
          $ForgedWorker = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString($OriginalHandoff))
          $ForgedWorker.token = ('a' * 64)
          [IO.File]::WriteAllText($WorkerRecordPath, ($ForgedWorker | ConvertTo-Json -Depth 4))
          Assert-True ((Invoke-GuardianCheck '--reconcile-native-prepared-abort') -eq 70) 'Orphan recovery accepted a changed authenticated worker handoff token.'
        } finally { [IO.File]::WriteAllBytes($WorkerRecordPath, $OriginalHandoff) }
        $OriginalAuthority = [IO.File]::ReadAllBytes($JournalAuthority)
        try {
          $ForgedAuthority = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString($OriginalAuthority))
          if ($AcceptedOldSigned612) {
            # Signed v6.1.2 authority record has no durable worker birth time;
            # verify its actually supported exact worker PID instead.
            $ForgedAuthority.workerPid = [int]$WorkerRecord.pid + 1
          } else {
            $ForgedAuthority.workerStartTimeUtcTicks = ([long]::Parse($WorkerRecord.startTimeUtcTicks) - 1).ToString([Globalization.CultureInfo]::InvariantCulture)
          }
          [IO.File]::WriteAllText($JournalAuthority, ($ForgedAuthority | ConvertTo-Json -Depth 4))
          Assert-True ((Invoke-GuardianCheck '--reconcile-native-prepared-abort') -eq 70) 'Orphan recovery accepted a forged native authority worker identity.'
        } finally { [IO.File]::WriteAllBytes($JournalAuthority, $OriginalAuthority) }
        $CommitBackup = [IO.File]::ReadAllBytes($JournalAbortCommit)
        try {
          $WrongPreparedLink = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString($CommitBackup))
          $WrongPreparedLink.preparedJournalSha256 = ('c' * 64)
          [IO.File]::WriteAllText($JournalAbortCommit, ($WrongPreparedLink | ConvertTo-Json -Depth 4))
          Assert-True ((Invoke-GuardianCheck '--reconcile-native-prepared-abort') -eq 70) 'Orphan recovery accepted an abort commit forged to an unrelated prepared journal.'
        } finally { [IO.File]::WriteAllBytes($JournalAbortCommit, $CommitBackup) }
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
  if ($GuardianAuditOnly) {
    # The full real installer lane independently checks WPF, Node, native
    # messaging and user state. On this isolated runner the complete Guardian
    # negative audit has passed; always run the enclosing finally cleanup.
    Write-Output "Windows $FixtureTarget separately installed Guardian-only security acceptance PASSED."
    return
  }
  } # End old Guardian fixture: no mock Guardian in real old-installed upgrade.
  # An old, signed A installed the toolchain PINNED BY A (e.g. Node 26.10.0),
  # not the Node pinned by the latest hosted test harness. Read only the
  # exact already-verified A source file; never use ambient PATH fallback.
  $NodeVersion = $OldProductNodeVersion
  if ($SkipLegacyGuardianFixture) {
    $VersionSource = [IO.File]::ReadAllText((Join-Path $ManagedSourceRoot 'src\equinox-local-runtime-versions.js'))
    $PinnedNode = [regex]::Match($VersionSource, 'export const EQUINOX_LOCAL_NODE_VERSION = "(\d+\.\d+\.\d+)";')
    Assert-True ($PinnedNode.Success) 'Vintage A signed source has no pinned native Node version.'
    $NodeVersion = $PinnedNode.Groups[1].Value
  }
  $OwnedGit = Join-Path $InstallRoot ("runtime\toolchain\git\$OldProductGitVersion\$FixtureTarget\cmd\git.exe")
  $OwnedNode = Join-Path $InstallRoot ("runtime\toolchain\node\$NodeVersion\$FixtureTarget\node.exe")
  $OwnedNpm = Join-Path $InstallRoot ("runtime\toolchain\node\$NodeVersion\$FixtureTarget\node_modules\npm\bin\npm-cli.js")
  foreach ($owned in @($OwnedGit,$OwnedNode,$OwnedNpm)) { Assert-True ([IO.File]::Exists($owned)) ("Product-owned toolchain file is missing: $owned") }
  Assert-True ((& $OwnedGit --version) -match ('^git version ' + [regex]::Escape(($OldProductGitVersion -split '-')[0]) + '\b')) 'Product-owned old A Git version mismatch.'
  Assert-True ((& $OwnedNode --version) -ceq ('v' + $NodeVersion)) 'Product-owned Node version mismatch.'
  # End-to-end actual NTFS A/B switch and failed-B rollback against exact
  # architecture-specific installed WPF PE bytes in an isolated temp root.
  # NEVER mutate the host's real installed program root or Native Messaging.
  # Match the REAL WPF detached-worker ABI: its owned Node lives in the
  # current signed Stable release, not the independent build toolchain.
  $StableWorkerNode = Join-Path $ReleaseDir 'runtime\node\bin\node.exe'
  Assert-True ([IO.File]::Exists($StableWorkerNode)) 'Stable-owned detached worker Node is missing.'
  if (-not $RepairOnly -and -not $NativeABInPackage) {
    & $StableWorkerNode (Join-Path $Root 'tests/release/windows-native-ab-installed-smoke.mjs') $ReleaseDir $FixtureTarget
    if ($LASTEXITCODE -ne 0) { throw 'Windows actual native shell A/B switch/rollback smoke failed.' }
  } elseif ($NativeABInPackage) {
    Write-Output 'Exact native WPF A/B acceptance is required in the independent package lane; Guardian and real installed-host checks remain here.'
  } else {
    Write-Output 'Native A/B and Guardian negative cases are covered by the separate full installer lane.'
  }
  Assert-True ((& $OwnedNode $OwnedNpm --version) -match '^\d+\.\d+\.\d+$') 'Product-owned npm CLI did not execute.'
  # Exercise the actual packaged CLI with a throwaway offline profile.
  if (-not $SkipLegacyGuardianFixture) {
    # This modern runtime-module fixture cannot be imported from old signed
    # A sources that predate its module. Test the actual A->B update instead.
    & $OwnedNode (Join-Path $Root 'tests/release/windows-tunnel-offline-init-smoke.mjs') $ManagedSourceRoot $ReleaseDir
    if ($LASTEXITCODE -ne 0) { throw 'Windows real bundled tunnel-client offline init acceptance failed.' }
  }
  # A real installed Windows app must be discoverable and uninstallable by OS UI.
  $AppsKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Equinox Local'
  if (-not $SkipLegacyGuardianFixture) {
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
  } # Windows Installed Apps / Start Menu registration arrived after vintage A.
  $ownedShell = @(Get-CimInstance Win32_Process -Filter "Name='EquinoxLocal.exe'" -ErrorAction SilentlyContinue | Where-Object { -not [string]::IsNullOrWhiteSpace($_.ExecutablePath) -and (Same-Path $_.ExecutablePath $StableExe) })
  Assert-True ($ownedShell.Count -eq 1) 'Windows installer did not leave exactly one owned stable shell running.'
  if ($env:EQUINOX_WINDOWS_MAIN_ACCEPT_TARGET_SHA -and -not $HistoricRepair) {
    if ($env:GITHUB_ACTIONS -cne 'true' -or [string]$env:EQUINOX_WINDOWS_MAIN_ACCEPT_TARGET_SHA -cnotmatch '^[a-f0-9]{40}$') { throw 'Real installed Windows Main acceptance requires an isolated hosted runner and an exact target SHA.' }
    if ($env:EQUINOX_WINDOWS_MAIN_ACCEPT_TARGET_SHA -ceq $FixtureSourceSha) { throw 'Installed Main acceptance target must differ from A.' }
    # Preserve the ACTUAL settings config as well as independent user-owned
    # state/browser records across full executable/runtime replacement.
    $UserSettingsPath = Join-Path $InstallRoot 'state\config.json'
    Assert-True ([IO.File]::Exists($UserSettingsPath)) 'Old installed A user config is missing.'
    $UserConfigShaBefore = (Get-FileHash -LiteralPath $UserSettingsPath -Algorithm SHA256).Hash
    $UserProofPath = Join-Path $InstallRoot 'state\ci-user-persistent-proof.txt'
    $BrowserProofPath = Join-Path $InstallRoot 'browser\ci-user-browser-proof.txt'
    [IO.File]::WriteAllText($UserProofPath,'old-version-private-setting')
    [IO.File]::WriteAllText($BrowserProofPath,'old-version-browser-preference')
    & node (Join-Path $Root 'tests/release/smoke-main-upgrade-windows.mjs') $InstallRoot $FixtureSourceSha $env:EQUINOX_WINDOWS_MAIN_ACCEPT_TARGET_SHA
    Assert-True ((Get-FileHash -LiteralPath $UserSettingsPath -Algorithm SHA256).Hash -ceq $UserConfigShaBefore) 'Real installed Main upgrade changed user config.'
    Assert-True ([IO.File]::ReadAllText($UserProofPath) -ceq 'old-version-private-setting') 'Real Main upgrade lost user settings.'
    Assert-True ([IO.File]::ReadAllText($BrowserProofPath) -ceq 'old-version-browser-preference') 'Real Main upgrade lost user browser data.'
    if ($LASTEXITCODE -ne 0) { throw "Real installed Windows Main update smoke exited with code $LASTEXITCODE" }
    # The source and WPF are real installed native OS state, not mocked.
    # A successful Main update must select B's newly installed native host.
    $afterShell = @(Get-CimInstance Win32_Process -Filter "Name='EquinoxLocal.exe'" -ErrorAction SilentlyContinue | Where-Object { -not [string]::IsNullOrWhiteSpace($_.ExecutablePath) -and (Same-Path $_.ExecutablePath $StableExe) })
    Assert-True ($afterShell.Count -eq 1) 'Real Main update did not preserve exactly one healthy native stable shell process.'
    $afterRegistry = [string](Get-Item -LiteralPath $NativeRegistryKey -ErrorAction Stop).GetValue('')
    Assert-True (Same-Path $afterRegistry $ExpectedManifestPath) 'Native Messaging registry identity changed during source-only Main update.'
    $afterManifest = [IO.File]::ReadAllText($ExpectedManifestPath, (New-Object Text.UTF8Encoding($false, $true))) | ConvertFrom-Json
    $AfterExpectedLauncher = if ($env:EQUINOX_WINDOWS_MAIN_ACCEPT_SCENARIO -ceq 'target-crash') {
      $ExpectedLauncher # Failed B must restore old A Native Messaging.
    } else {
      Join-Path $InstallRoot ("state\main-update\native-store\$FixtureTarget\$env:EQUINOX_WINDOWS_MAIN_ACCEPT_TARGET_SHA\release\runtime\browser\equinox-browser-native-host.exe")
    }
    Assert-True (Same-Path ([string]$afterManifest.path) $AfterExpectedLauncher) 'Updated Native Messaging manifest did not select exact B or restore A on failure.'
    Assert-True ([IO.File]::Exists($AfterExpectedLauncher)) 'Updated Native Messaging executable was not installed.'
    Write-Output "Real Windows $FixtureTarget installed Main A-to-B native shell and Native Messaging acceptance PASSED."
  }
  # Execute the real shipped registry+shortcut cleanup after verifying
  # their ownership, without deleting the healthy runtime or user data.
  if (-not $SkipLegacyGuardianFixture) {
    # Uninstall integration is separately admitted for old native A packages.
    # This modern helper is not in the vintage A source checkout.
    & $OwnedNode (Join-Path $Root 'tests/release/windows-installed-app-registration-cleanup.mjs') $ManagedSourceRoot $OwnedProgramRoot
    if ($LASTEXITCODE -ne 0) { throw 'Managed Windows shell registration cleanup failed.' }
    Assert-True (-not (Test-Path -LiteralPath $AppsKey)) 'Uninstall integration did not remove the owned Installed Apps entry.'
    Assert-True (-not [IO.File]::Exists($StartMenuShortcut)) 'Uninstall integration did not remove the owned Start Menu shortcut.'
  }
  if ($env:EQUINOX_WINDOWS_SAME_VERSION_REPAIR -ceq 'true') {
    if ($env:GITHUB_ACTIONS -cne 'true' -or $SkipLegacyGuardianFixture) { throw 'Same-version native repair acceptance requires a disposable current-product Windows runner.' }
    $oldPointer = Join-Path $InstallRoot 'state\main-update\current-native.json'
    Assert-True (-not [IO.File]::Exists($oldPointer)) 'Fresh source-only Main enrollment unexpectedly created a native-store pointer.'
    $beforeManifest = [IO.File]::ReadAllText($ExpectedManifestPath) | ConvertFrom-Json
    Assert-True (Same-Path ([string]$beforeManifest.path) $ExpectedLauncher) 'Initially enrolled Main is not using its numbered native launcher.'
    $config = Join-Path $InstallRoot 'state\config.json'
    Assert-True ([IO.File]::Exists($config)) 'Installed Main user settings are missing before repair.'
    $userFiles = @($config)
    foreach ($entry in @('secrets\openai-runtime-key', 'workspace\ci-same-version-repair-proof.txt', 'browser\ci-same-version-browser-proof.txt', 'tunnel\ci-same-version-tunnel-proof.txt')) {
      $proof = Join-Path $InstallRoot $entry
      [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($proof)) | Out-Null
      if (-not [IO.File]::Exists($proof)) { [IO.File]::WriteAllText($proof, 'fixture-user-state-preserve') }
      $userFiles += $proof
    }
    $beforeHashes = @{}
    foreach ($file in $userFiles) {
      Assert-True ([IO.File]::Exists($file)) "Same-version repair user proof is missing: $file"
      $beforeHashes[$file] = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
    }
    $EnrollExistingMain = $false
    Invoke-EquinoxLocalInstall | Out-Host
    $afterStatus = (Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:24891/api/v1/status' -TimeoutSec 8).Content | ConvertFrom-Json
    Assert-True ($afterStatus.ok -eq $true -and $afterStatus.status.health.state -ceq 'HEALTHY') 'Same-version signed Stable repair did not launch a healthy runtime.'
    Assert-True ([string]$afterStatus.status.server.version -ceq $FixtureVersion) 'Same-version signed Stable repair reported another version.'
    Assert-True ([string]$afterStatus.status.installation.kind -ceq 'managed') 'Same-version repair falsely left old Main active.'
    Assert-True (-not [IO.File]::Exists((Join-Path $InstallRoot 'state\main-update\install.json'))) 'Same-version repair kept the Main enrollment stamp.'
    $stableManifest = [IO.File]::ReadAllText($ExpectedManifestPath) | ConvertFrom-Json
    Assert-True (Same-Path ([string]$stableManifest.path) $ExpectedLauncher) 'Same-version Stable Native Messaging was not switched to signed Stable launcher.'
    Assert-True (Same-Path ([string](Get-Item -LiteralPath $NativeRegistryKey).GetValue('')) $ExpectedManifestPath) 'Native Messaging HKCU registration changed during repair.'
    foreach ($file in $userFiles) { Assert-True ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ceq $beforeHashes[$file]) "Same-version Stable repair changed user data: $file" }
    $running = @(Get-CimInstance Win32_Process -Filter "Name='EquinoxLocal.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -and (Same-Path $_.ExecutablePath $StableExe) })
    Assert-True ($running.Count -eq 1) 'Same-version Stable repair did not leave exactly one running native WPF shell.'
    Write-Output "Windows $FixtureTarget real same-version Main-to-Stable reinstall: WPF/Native Messaging/credentials preservation PASSED."
  }
  if ($HistoricRepair) {
    # Published signed old A Guardian bytes must survive a deliberately failed B.
    $OldGuardian = Join-Path $InstallRoot 'runtime\guardian\EquinoxLocalGuardian.exe'
    $OldGuardianSha = $null
    $OldGuardianFileId = $null
    if ($AcceptedOldSigned612) {
      Assert-True ([IO.File]::Exists($OldGuardian)) 'Published 6.1.2 Guardian is missing.'
      $OldGuardianSha = (Get-FileHash -LiteralPath $OldGuardian -Algorithm SHA256).Hash
      $identity = [string]::Join(' ', [string[]]@(& fsutil.exe file queryfileid $OldGuardian))
      if ($LASTEXITCODE -ne 0 -or $identity -notmatch '0x[0-9a-fA-F]{16,32}') { throw 'Signed 6.1.2 Guardian original NTFS file identity could not be attested.' }
      $OldGuardianFileId = $Matches[0].ToLowerInvariant()
    }
    $CandidateZip = [string]$env:EQUINOX_WINDOWS_LEGACY_STABLE_ARTIFACT
    Assert-True ([IO.File]::Exists($CandidateZip)) 'Historical repair candidate ZIP missing.'
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $CandidateArchive = [IO.Compression.ZipFile]::OpenRead($CandidateZip)
    try {
      $CandidateEntry = $CandidateArchive.GetEntry('release/release.json')
      Assert-True ($null -ne $CandidateEntry -and $CandidateEntry.Length -lt 16384) 'New candidate metadata missing.'
      $reader = New-Object IO.StreamReader($CandidateEntry.Open(), (New-Object Text.UTF8Encoding($false,$true)))
      try { $CandidateMetadata = $reader.ReadToEnd() | ConvertFrom-Json }
      finally { $reader.Dispose() }
    } finally { $CandidateArchive.Dispose() }
    $BVersion = [string]$CandidateMetadata.version
    Assert-True ($CandidateMetadata.target -ceq $FixtureTarget -and
      $CandidateMetadata.sourceSha -cmatch '^[a-f0-9]{40}$' -and
      $CandidateMetadata.sourceSha -cne $FixtureSourceSha -and
      $BVersion -cmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' -and
      ([version]$BVersion -gt [version]$FixtureVersion)) 'Historical B candidate must be a different current source release.'
    $UserFiles = @((Join-Path $InstallRoot 'state\config.json'))
    foreach ($entry in @('secrets\openai-runtime-key','browser\historic-user-profile.txt','tunnel\historic-user-profile.txt','workspace\historic-owned-project.txt')) {
      $item = Join-Path $InstallRoot $entry
      [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($item)) | Out-Null
      if (-not [IO.File]::Exists($item)) { [IO.File]::WriteAllText($item, 'previous-version-private-user-data-fixture') }
      $UserFiles += $item
    }
    $UserHashes = @{}
    foreach ($item in $UserFiles) {
      Assert-True ([IO.File]::Exists($item)) "Historical old Main user proof missing: $item"
      $UserHashes[$item] = (Get-FileHash -LiteralPath $item -Algorithm SHA256).Hash
    }
    $OldMainStampPath = Join-Path $InstallRoot 'state\main-update\install.json'
    Assert-True ([IO.File]::Exists($OldMainStampPath)) 'Old Main enrollment stamp missing.'
    $OldManifestText = [IO.File]::ReadAllText($ExpectedManifestPath)
    $OldLauncher = ([IO.File]::ReadAllText($ExpectedManifestPath) | ConvertFrom-Json).path
    Assert-True (Same-Path $OldLauncher $ExpectedLauncher) 'Old Main Native Messaging launcher was not exactly owned.'
    $StagingB = Join-Path $InstallRoot 'staging\historic-repair-negative'
    [IO.Directory]::CreateDirectory($StagingB) | Out-Null
    Expand-Archive -LiteralPath $CandidateZip -DestinationPath $StagingB -Force
    $BRelease = Join-Path $StagingB 'release'
    Assert-True ([IO.File]::Exists((Join-Path $BRelease 'release.json'))) 'Historical B staged release missing.'
    & $OwnedNode (Join-Path $Root 'tests/release/windows-legacy-stable-health-rollback.mjs') $BRelease $InstallRoot $FixtureSourceSha $BVersion
    if ($LASTEXITCODE -ne 0) { throw "Historic $FixtureTarget real B-to-A health-failure rollback failed with $LASTEXITCODE." }
    if ($AcceptedOldSigned612) {
      Assert-True ([IO.File]::Exists($OldGuardian)) 'Original old A Guardian missing after forced B rollback.'
      Assert-True ((Get-FileHash -LiteralPath $OldGuardian -Algorithm SHA256).Hash -ceq $OldGuardianSha) 'Original signed A Guardian bytes changed during rollback.'
      $restoredIdentity = [string]::Join(' ', [string[]]@(& fsutil.exe file queryfileid $OldGuardian))
      if ($LASTEXITCODE -ne 0 -or $restoredIdentity -notmatch '0x[0-9a-fA-F]{16,32}' -or $Matches[0].ToLowerInvariant() -cne $OldGuardianFileId) {
        throw 'Original signed A Guardian kernel NTFS file identity was not preserved during B rollback.'
      }
    }
    foreach ($item in $UserFiles) {
      Assert-True ((Get-FileHash -LiteralPath $item -Algorithm SHA256).Hash -ceq $UserHashes[$item]) "Historic forced rollback changed private user state: $item"
    }
    # Real classic public PowerShell entrypoint, with only its HTTPS fixture
    # switched to the separate exact B ZIP/metadata. Never mutate live URLs.
    $script:Artifact = $CandidateZip
    $script:FixtureVersion = $BVersion
    $BArtifactSha = (Get-FileHash -LiteralPath $CandidateZip -Algorithm SHA256).Hash.ToLowerInvariant()
    $BArtifactBytes = (Get-Item -LiteralPath $CandidateZip).Length
    $BManifestText = @('schemaVersion=1', 'channel=stable', "target=$FixtureTarget", "version=$BVersion",
      "artifactUrl=https://local.sametbasbug.dev/downloads/updates/equinox-local-$BVersion-$FixtureTarget.zip",
      "artifactSha256=$BArtifactSha", "artifactBytes=$BArtifactBytes", '') -join "`n"
    [IO.File]::WriteAllText($Manifest, $BManifestText, (New-Object Text.UTF8Encoding($false)))
    $EnrollExistingMain = $false
    Invoke-EquinoxLocalInstall | Out-Host
    $status = (Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:24891/api/v1/status' -TimeoutSec 10).Content | ConvertFrom-Json
    Assert-True ($status.ok -eq $true -and $status.status.health.state -ceq 'HEALTHY' -and
      $status.status.server.version -ceq $BVersion -and
      $status.status.installation.kind -ceq 'managed') 'Actual PowerShell historical Stable reinstall did not run a HEALTHY Stable.'
    Assert-True (-not [IO.File]::Exists($OldMainStampPath)) 'Classic Stable reinstall silently kept old Main enrollment.'
    $BCurrent = [IO.File]::ReadAllText((Join-Path $InstallRoot 'current-version.json')) | ConvertFrom-Json
    Assert-True ($BCurrent.version -ceq $BVersion) 'Windows current pointer did not select new Stable B.'
    # A successful replacement must not leave a chain of obsolete numbered
    # native runtimes behind. The installed B owns one version directory.
    $versionDirectories = @([IO.Directory]::GetDirectories((Join-Path $InstallRoot 'releases')) |
      ForEach-Object { [IO.Path]::GetFileName($_) } |
      Where-Object { $_ -cmatch '^\d+\.\d+\.\d+$' })
    Assert-True ($versionDirectories.Count -eq 1 -and $versionDirectories[0] -ceq $BVersion) 'Real classic Windows reinstall retained obsolete large Stable versions.'
    $AfterLauncher = ([IO.File]::ReadAllText($ExpectedManifestPath) | ConvertFrom-Json).path
    $ExpectedBLauncher = Join-Path $InstallRoot ("releases\$BVersion\runtime\browser\equinox-browser-native-host.exe")
    Assert-True (Same-Path ([string]$AfterLauncher) $ExpectedBLauncher) 'Native Messaging host was not switched to new Stable B.'
    Assert-True (Same-Path ([string](Get-Item -LiteralPath $NativeRegistryKey).GetValue('')) $ExpectedManifestPath) 'Chrome HKCU registration lost its exact ownership.'
    foreach ($item in $UserFiles) {
      Assert-True ((Get-FileHash -LiteralPath $item -Algorithm SHA256).Hash -ceq $UserHashes[$item]) "Historic Stable reinstall changed private user state: $item"
    }
    $shells = @(Get-CimInstance Win32_Process -Filter "Name='EquinoxLocal.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.ExecutablePath -and (Same-Path $_.ExecutablePath $StableExe) })
    Assert-True ($shells.Count -eq 1) 'New Stable did not leave exactly one real running native WPF shell.'
    Write-Output "Real Windows $FixtureTarget installed old-to-new native Stable PowerShell reinstall, forced native rollback, Native Messaging, WPF, zero obsolete releases and user-data preservation PASSED."
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
