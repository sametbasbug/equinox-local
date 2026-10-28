param([switch]$Help)
if ($Help) {
  Write-Output 'Usage: install-equinox-local.ps1'
  Write-Output 'Downloads the latest production-signed Main and reinstalls only program files.'
  Write-Output 'User settings/data are preserved; installed versions are not compared.'
  return
}
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$Target = $null
$MaxArtifactBytes = 1073741824
$MainVerifyUrl = 'https://local.sametbasbug.dev/downloads/updates/install-main-verify.mjs'
$MainVerifySha256 = '7af08a6b6ad4ff0223024d338b1260c7aba7af77f61d8e3398cd950b1dd397c9'
$MainVerifyBytes = 9464
$MainNodeVersion = '26.12.1'

function Fail([string]$Message) { throw "Equinox Local installer: $Message" }
function Write-Info([string]$Message) { Write-Host "Equinox Local installer: $Message" }
function Get-Sha256([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Get-NativeWindowsTarget {
  if (-not [Environment]::Is64BitProcess) { Fail 'native 64-bit Windows PowerShell is required' }
  $processArchitecture = [string]$env:PROCESSOR_ARCHITECTURE
  $nativeArchitecture = [string]$env:PROCESSOR_ARCHITEW6432
  if ([string]::IsNullOrWhiteSpace($processArchitecture)) {
    # Managed child processes may deliberately remove nonessential OS env vars.
    $processArchitecture = [string][System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture
    $nativeArchitecture = [string][System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
  }
  if (-not [string]::IsNullOrWhiteSpace($nativeArchitecture) -and $nativeArchitecture -cne $processArchitecture) {
    Fail 'native 64-bit Windows PowerShell is required'
  }
  switch ($processArchitecture.ToUpperInvariant()) {
    'AMD64' { return 'win32-x64' }
    'X64' { return 'win32-x64' }
    'ARM64' { return 'win32-arm64' }
    default { Fail "unsupported Windows architecture: $processArchitecture" }
  }
}
function Assert-NormalFile([string]$Path, [long]$MinBytes, [long]$MaxBytes) {
  if (-not [IO.File]::Exists($Path)) { Fail "required file is missing: $Path" }
  $item = Get-Item -LiteralPath $Path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.PSIsContainer) { Fail "unsafe file: $Path" }
  if ($item.Length -lt $MinBytes -or $item.Length -gt $MaxBytes) { Fail "file size is outside the allowed range: $Path" }
  return $item
}
function Assert-NormalDirectory([string]$Path, [bool]$Create) {
  if ($Create) { [IO.Directory]::CreateDirectory($Path) | Out-Null }
  if (-not [IO.Directory]::Exists($Path)) { Fail "required directory is missing: $Path" }
  $item = Get-Item -LiteralPath $Path -Force
  if (-not $item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { Fail "unsafe managed directory: $Path" }
  return $item
}
function Save-BoundedHttpsFile([string]$Url, [string]$Destination, [long]$MaxBytes) {
  $uri = [Uri]$Url
  if ($uri.Scheme -ne 'https') { Fail 'HTTPS is required' }
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $request = [Net.HttpWebRequest]::Create($uri)
  $request.AllowAutoRedirect = $false
  $request.Timeout = 30000
  $request.ReadWriteTimeout = 30000
  $request.UserAgent = 'EquinoxLocalBootstrap/1'
  $response = $request.GetResponse()
  try {
    if ([int]$response.StatusCode -lt 200 -or [int]$response.StatusCode -ge 300) { Fail "download returned HTTP $([int]$response.StatusCode)" }
    if ($response.ContentLength -gt $MaxBytes) { Fail 'download exceeds the allowed size' }
    $input = $response.GetResponseStream()
    $output = New-Object IO.FileStream($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
      $buffer = New-Object byte[] 65536
      [long]$total = 0
      while (($read = $input.Read($buffer, 0, $buffer.Length)) -gt 0) {
        $total += $read
        if ($total -gt $MaxBytes) { Fail 'download exceeds the allowed size' }
        $output.Write($buffer, 0, $read)
      }
      $output.Flush()
    } finally { $output.Dispose(); $input.Dispose() }
  } finally { $response.Dispose() }
}
function Invoke-PinnedMainNode([string]$Executable, [string[]]$Parameters) {
  $blocked = @('NODE_OPTIONS','NODE_PATH','NODE_EXTRA_CA_CERTS','NODE_TLS_REJECT_UNAUTHORIZED','NODE_USE_ENV_PROXY','NODE_DEBUG')
  $original = @{}
  foreach ($name in $blocked) {
    $original[$name] = [Environment]::GetEnvironmentVariable($name,'Process')
    [Environment]::SetEnvironmentVariable($name,$null,'Process')
  }
  try {
    $result = @(& $Executable @Parameters)
    if ($LASTEXITCODE -ne 0) { Fail 'verified Main Node admission failed' }
    return $result
  } finally {
    foreach ($name in $blocked) {
      [Environment]::SetEnvironmentVariable($name,$original[$name],'Process')
    }
  }
}
# The original production-signed Main ZIP verifier shared with the macOS
# external installer. HTTPS alone is never a signature trust root.
function Invoke-VerifiedMainPreparation([string]$PrivateTemp) {
  $nodeBytes = [long]0
  $nodeSha = ''
  switch ($Target) {
    'win32-arm64' { $nodeBytes = 37275911; $nodeSha = '34567581ee63967b37afb6b7a0cc63a2d550a43d5d838adb75982d7e356f2e2c' }
    'win32-x64' { $nodeBytes = 41901456; $nodeSha = 'b3efd5c70cba3308ed46e7e699a9b8aac075bbc6b027fcb39c84c31acc25e2b4' }
    default { Fail 'unsupported Main verification architecture' }
  }
  $architecture = if ($Target -ceq 'win32-arm64') { 'arm64' } else { 'x64' }
  $nodeBase = 'node-v' + $MainNodeVersion + '-win-' + $architecture
  $nodeZip = Join-Path $PrivateTemp 'pinned-node.zip'
  $nodeStage = Join-Path $PrivateTemp 'node'
  $source = Join-Path $PrivateTemp 'install-main-verify.mjs'
  $verifiedArchive = Join-Path $PrivateTemp 'main-native.zip'
  Write-Info 'checking pinned shared Main verification code'
  Save-BoundedHttpsFile $MainVerifyUrl $source $MainVerifyBytes
  Assert-NormalFile $source $MainVerifyBytes $MainVerifyBytes | Out-Null
  if ((Get-Sha256 $source) -cne $MainVerifySha256) { Fail 'Main verifier code digest is invalid' }
  $nodeUrl = 'https://nodejs.org/dist/v' + $MainNodeVersion + '/' + $nodeBase + '.zip'
  Write-Info "checking pinned Node $MainNodeVersion ($Target)"
  Save-BoundedHttpsFile $nodeUrl $nodeZip $nodeBytes
  Assert-NormalFile $nodeZip $nodeBytes $nodeBytes | Out-Null
  if ((Get-Sha256 $nodeZip) -cne $nodeSha) { Fail 'pinned Node SHA-256 is invalid' }
  [IO.Directory]::CreateDirectory($nodeStage) | Out-Null
  # Windows ships native bsdtar; avoid slow PowerShell ZIP expansion and PATH discovery.
  $nativeTar = Join-Path $env:WINDIR 'System32\tar.exe'
  Assert-NormalFile $nativeTar 1 5000000 | Out-Null
  $tarOutput = @(& $nativeTar '-xf' $nodeZip '-C' $nodeStage 2>&1)
  if ($LASTEXITCODE -ne 0) { Fail 'verified pinned Node ZIP extraction failed' }
  $node = Join-Path (Join-Path $nodeStage $nodeBase) 'node.exe'
  Assert-NormalFile $node 1 200000000 | Out-Null
  # HTTPS/download/Node/content verification precede all execution.
  $receipt = @(Invoke-PinnedMainNode $node @($source, '--target', $Target, '--output', $verifiedArchive, '--pointer-output', (Join-Path $PrivateTemp 'main-signed-pointer.json')))
  Assert-NormalFile $verifiedArchive 1 $MaxArtifactBytes | Out-Null
  if ($receipt.Count -ne 1) { Fail 'signed Main verifier produced an unexpected receipt' }
  try { $parsed = $receipt[0] | ConvertFrom-Json -ErrorAction Stop }
  catch { Fail 'signed Main verification receipt is invalid' }
  if ($parsed.target -cne $Target -or $parsed.sourceSha -notmatch '^[a-f0-9]{40}$' -or
      $parsed.version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' -or
      $parsed.artifactSha256 -cne (Get-Sha256 $verifiedArchive) -or
      [long]$parsed.artifactBytes -ne (Get-Item -LiteralPath $verifiedArchive).Length) {
    Fail 'signed Main archive receipt mismatch'
  }
  $mainExtracted = Join-Path $PrivateTemp 'main-extracted'
  [IO.Directory]::CreateDirectory($mainExtracted) | Out-Null
  $nativeOutput = @(& $nativeTar '-xf' $verifiedArchive '-C' $mainExtracted 2>&1)
  if ($LASTEXITCODE -ne 0) { Fail 'verified Main ZIP candidate could not be unpacked' }
  $candidate = Join-Path $mainExtracted 'release'
  Assert-NormalDirectory $candidate $false | Out-Null
  $inspector = Join-Path $candidate 'equinox-local-first-install.js'
  Assert-NormalFile $inspector 1 2097152 | Out-Null
  $admitted = @(Invoke-PinnedMainNode $node @($inspector, '--inspect-signed-main', '--staged-release', $candidate, '--source-sha', ([string]$parsed.sourceSha), '--version', ([string]$parsed.version), '--target', $Target, '--signed-pointer-file', (Join-Path $PrivateTemp 'main-signed-pointer.json')))
  if ($admitted.Count -ne 1) { Fail 'Main native candidate exact source SHA admission failed' }
  try { $matched = $admitted[0] | ConvertFrom-Json -ErrorAction Stop }
  catch { Fail 'Main native candidate admission receipt is invalid' }
  if ($matched.status -cne 'admitted' -or $matched.sourceSha -cne $parsed.sourceSha -or
      $matched.version -cne $parsed.version -or $matched.target -cne $Target -or
      $matched.runtimeContractSha256 -cne $parsed.runtimeContractSha256 -or
      $matched.artifactSha256 -cne $parsed.artifactSha256 -or
      [long]$matched.artifactBytes -ne [long]$parsed.artifactBytes) {
    Fail 'Main native candidate admission changed the signed identity'
  }
  Write-Output $receipt[0]
}

# This is a one-shot replacement of product EXECUTABLES, not an update of
# the prior source. Preserve config, secrets, workspace, tunnel, downloads and
# browser personal state in place. Retire only exact product-owned executable
# roots and selectors. The backup is a single bounded transaction, never an
# accumulation of historical release ZIPs or copied files.
# Ownership includes product scripts executed by system PowerShell and native
# messaging helpers, not just executables whose own path is under installRoot.
function Test-ExistingEquinoxOwnedProcess($Process, [string]$InstallRoot, [string]$ProgramRoot) {
  $executable = ([string]$Process.ExecutablePath).Replace('/', '\')
  if ([string]::IsNullOrWhiteSpace($executable)) { return $false }
  $full = [IO.Path]::GetFullPath($executable)
  $app = [IO.Path]::GetFullPath((Join-Path $ProgramRoot 'EquinoxLocal.exe'))
  if ([string]::Equals($full, $app, [StringComparison]::OrdinalIgnoreCase)) { return $true }
  foreach ($root in @('releases','runtime','state\main-update')) {
    $prefix = [IO.Path]::GetFullPath((Join-Path $InstallRoot $root)).TrimEnd('\') + '\'
    if ($full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  # Stock Windows PowerShell 5.1 or an external Node/Git executable can run
  # an exact product-owned entrypoint without itself residing in the product.
  $name = [string]$Process.Name
  if ($name -notin @('node.exe','powershell.exe','pwsh.exe','git.exe')) { return $false }
  $args = ([string]$Process.CommandLine).Replace('/', '\')
  $managedRoot = [IO.Path]::GetFullPath((Join-Path $InstallRoot 'state\main-update')).TrimEnd('\') + '\'
  $pattern = [regex]::Escape($managedRoot) + '[^"\r\n]+\.(?:js|mjs|ps1|git)(?:"|\s|$)'
  return [regex]::IsMatch($args,$pattern,[Text.RegularExpressions.RegexOptions]::IgnoreCase)
}
# Chrome can restart its still-registered OLD Native Messaging host after the
# previous WPF shuts down. Its old executable then pins the immutable Main
# directory even while the new independently signed installer is ready.
# Temporarily hide ONLY the verified, exclusively product-owned HKCU Chrome
# host registration while retiring the old runtime. On failed installation
# restore the same registration AFTER old executable rollback. The admitted
# new release re-registers its own host on successful activation.
function Suspend-OldEquinoxChromeHost([string]$InstallRoot) {
  $subkey = 'Software\Google\Chrome\NativeMessagingHosts\dev.equinox.browser'
  $parent = 'Software\Google\Chrome\NativeMessagingHosts'
  $manifest = [IO.Path]::GetFullPath((Join-Path $InstallRoot 'browser\native-messaging\dev.equinox.browser.json'))
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($subkey, $false)
  if ($null -eq $key) { return $null }
  try {
    if ($key.SubKeyCount -ne 0 -or $key.ValueCount -ne 1 -or
        $key.GetValueKind('') -ne [Microsoft.Win32.RegistryValueKind]::String -or
        -not [string]::Equals([string]$key.GetValue('', $null), $manifest, [StringComparison]::OrdinalIgnoreCase)) {
      Fail 'existing Chrome Native Messaging registration is not exclusively owned by Equinox Local'
    }
  } finally { $key.Dispose() }
  Assert-NormalFile $manifest 1 16384 | Out-Null
  $record = Get-Content -LiteralPath $manifest -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
  $launcher = [IO.Path]::GetFullPath([string]$record.path)
  $allowedRoots = @('state\main-update', 'releases') | ForEach-Object {
    [IO.Path]::GetFullPath((Join-Path $InstallRoot $_)).TrimEnd('\') + '\'
  }
  $ownedLauncher = $false
  foreach ($prefix in $allowedRoots) {
    if ($launcher.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { $ownedLauncher = $true }
  }
  if ($record.name -cne 'dev.equinox.browser' -or $record.type -cne 'stdio' -or
      @($record.allowed_origins).Count -ne 1 -or
      [string]::IsNullOrWhiteSpace([string]$record.path) -or
      -not [IO.Path]::IsPathRooted([string]$record.path) -or
      -not $ownedLauncher -or
      -not $launcher.EndsWith('\runtime\browser\equinox-browser-native-host.exe', [StringComparison]::OrdinalIgnoreCase)) {
    Fail 'old Chrome Native Messaging manifest does not identify a product-owned Main launcher'
  }
  $registry = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($parent, $true)
  if ($null -eq $registry) { Fail 'Chrome Native Messaging registry parent is inaccessible' }
  try {
    $registry.DeleteSubKey('dev.equinox.browser', $false)
  } finally { $registry.Dispose() }
  return [pscustomobject]@{ Subkey=$subkey; Manifest=$manifest }
}
function Restore-OldEquinoxChromeHost($Suspended) {
  if ($null -eq $Suspended) { return }
  # Never leave the old installation without its browser bridge after a
  # failed reinstall. Refuse to overwrite a foreign registrant.
  Assert-NormalFile $Suspended.Manifest 1 16384 | Out-Null
  $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($Suspended.Subkey)
  if ($null -eq $key) { Fail 'old Chrome Native Messaging registration could not be restored' }
  try {
    $value = $key.GetValue('', $null)
    if ($null -ne $value -and -not [string]::Equals([string]$value, [string]$Suspended.Manifest, [StringComparison]::OrdinalIgnoreCase)) {
      Fail 'Chrome Native Messaging registration changed ownership during reinstall'
    }
    $key.SetValue('', [string]$Suspended.Manifest, [Microsoft.Win32.RegistryValueKind]::String)
  } finally { $key.Dispose() }
}

function Stop-ExistingEquinoxExecutables([string]$InstallRoot, [string]$ProgramRoot) {
  # Shut down the verified old WPF process TREE before stopping individual
  # children. Stop-Process on only the root leaves detached old Node/job
  # helpers running, and those processes can keep the previous native-store
  # executable directory alive throughout the rename transaction.
  $app = [IO.Path]::GetFullPath((Join-Path $ProgramRoot 'EquinoxLocal.exe'))
  $systemKill = Join-Path ([Environment]::SystemDirectory) 'taskkill.exe'
  $oldShells = @(Get-CimInstance Win32_Process -Filter "Name='EquinoxLocal.exe'" -ErrorAction Stop | Where-Object {
    [string]::Equals([string]$_.ExecutablePath, $app, [StringComparison]::OrdinalIgnoreCase)
  })
  foreach ($shell in $oldShells) {
    $still = Get-CimInstance Win32_Process -Filter ("ProcessId=" + [int]$shell.ProcessId) -ErrorAction Stop
    if ($null -eq $still -or $still.CreationDate -ne $shell.CreationDate -or
        -not [string]::Equals([string]$still.ExecutablePath,$app,[StringComparison]::OrdinalIgnoreCase)) { continue }
    # taskkill /T terminates only descendants of this exact, revalidated
    # signed product WPF root, never all instances of a process by name.
    & $systemKill /PID ([string]$shell.ProcessId) /T /F 2>$null | Out-Null
  }
  # The old supervisor may relaunch children while exiting, and Chrome may
  # still hold a Native Messaging host. Re-query exact OS identities until no
  # owned processes remain; never terminate a same-PID foreign replacement.
  for ($attempt = 0; $attempt -lt 24; $attempt++) {
    $owned = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
      Test-ExistingEquinoxOwnedProcess $_ $InstallRoot $ProgramRoot
    })
    if ($owned.Count -eq 0) { return }
    foreach ($item in $owned) {
      $live = Get-CimInstance Win32_Process -Filter ("ProcessId=" + [int]$item.ProcessId) -ErrorAction Stop
      if ($null -eq $live -or $live.CreationDate -ne $item.CreationDate -or
          -not (Test-ExistingEquinoxOwnedProcess $live $InstallRoot $ProgramRoot)) { continue }
      try { Stop-Process -Id ([int]$item.ProcessId) -Force -ErrorAction Stop }
      catch {
        $still = Get-CimInstance Win32_Process -Filter ("ProcessId=" + [int]$item.ProcessId) -ErrorAction Stop
        if ($null -ne $still -and $still.CreationDate -eq $item.CreationDate -and
            (Test-ExistingEquinoxOwnedProcess $still $InstallRoot $ProgramRoot)) { throw }
      }
    }
    Start-Sleep -Milliseconds 400
  }
  $remains=@(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
    Test-ExistingEquinoxOwnedProcess $_ $InstallRoot $ProgramRoot
  } | ForEach-Object { "$($_.Name):$($_.ProcessId)" })
  Fail ('old Equinox Local processes still hold the runtime: ' + ($remains -join ', '))
}

function Get-ExecutableReplacementPaths([string]$InstallRoot) {
  $localRoot = [IO.Path]::GetDirectoryName($InstallRoot)
  return @(
    [pscustomobject]@{ Name='releases'; Path=(Join-Path $InstallRoot 'releases') },
    [pscustomobject]@{ Name='runtime'; Path=(Join-Path $InstallRoot 'runtime') },
    [pscustomobject]@{ Name='main-update'; Path=(Join-Path $InstallRoot 'state\main-update') },
    [pscustomobject]@{ Name='current-version'; Path=(Join-Path $InstallRoot 'current-version.json') },
    [pscustomobject]@{ Name='program'; Path=(Join-Path $localRoot 'Programs\Equinox Local') },
    [pscustomobject]@{ Name='native-messaging'; Path=(Join-Path $InstallRoot 'browser\native-messaging\dev.equinox.browser.json') }
  )
}
function Get-NormalExistingEntry([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  if ($null -ne $item -and (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
    Fail 'existing managed executable entry is a symbolic link or junction; refusing replacement'
  }
  return $item
}
function Begin-ExecutableReplacement([string]$InstallRoot) {
  $backup = Join-Path $InstallRoot '.equinox-signed-reinstall-backup'
  # An interrupted previous reinstall may have left ONLY retired product
  # executables behind. Never require an older version for retry: authenticate
  # the newest signed Main first, then discard the fixed owned backup.
  $existingBackup = Get-NormalExistingEntry $backup
  if ($null -ne $existingBackup) {
    if (-not $existingBackup.PSIsContainer) { Fail 'interrupted executable backup is not a directory' }
    $allowed = @('releases','runtime','main-update','current-version','program','native-messaging','failed-new')
    foreach ($child in @(Get-ChildItem -LiteralPath $backup -Force)) {
      if ($child.Name -cnotin $allowed -or (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
        Fail 'interrupted executable backup has an unexpected entry'
      }
    }
    Stop-ExistingEquinoxExecutables $InstallRoot (Join-Path ([IO.Path]::GetDirectoryName($InstallRoot)) 'Programs\Equinox Local')
    Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction Stop
  }
  $entries = @(Get-ExecutableReplacementPaths $InstallRoot)
  $present = @($entries | Where-Object { $null -ne (Get-NormalExistingEntry $_.Path) })
  if ($present.Count -eq 0) { return $null }
  Stop-ExistingEquinoxExecutables $InstallRoot (Join-Path ([IO.Path]::GetDirectoryName($InstallRoot)) 'Programs\Equinox Local')
  [IO.Directory]::CreateDirectory($backup) | Out-Null
  $transaction = [pscustomobject]@{ Backup=$backup; Entries=$entries }
  try {
    foreach ($entry in $present) {
      $source = [string]$entry.Path
      $destination = Join-Path $backup ([string]$entry.Name)
      for ($moveAttempt=0; $moveAttempt -lt 10; $moveAttempt++) {
        try {
          if ([IO.Directory]::Exists($source)) { [IO.Directory]::Move($source, $destination) }
          elseif ([IO.File]::Exists($source)) { [IO.File]::Move($source, $destination) }
          else { Fail 'existing executable disappeared during signed reinstall' }
          break
        } catch [UnauthorizedAccessException], [IO.IOException] {
          if ($moveAttempt -eq 9) { throw }
          # Chrome Native Messaging or old runtime helpers may exit just
          # after the first process snapshot. Retry only this verified owned
          # entry and re-check old process identities before each retry.
          Stop-ExistingEquinoxExecutables $InstallRoot (Join-Path ([IO.Path]::GetDirectoryName($InstallRoot)) 'Programs\Equinox Local')
          Start-Sleep -Milliseconds 300
        }
      }
    }
  } catch {
    Restore-ExecutableReplacement $transaction
    throw
  }
  return $transaction
}
function Restore-ExecutableReplacement($Transaction) {
  if ($null -eq $Transaction) { return }
  $failed = Join-Path $Transaction.Backup 'failed-new'
  foreach ($entry in $Transaction.Entries) {
    $old = Join-Path $Transaction.Backup ([string]$entry.Name)
    $existing = Get-NormalExistingEntry $old
    $installed = Get-NormalExistingEntry ([string]$entry.Path)
    # A failed attempt may have been unable to move a locked old directory.
    # Never quarantine that still-original directory unless its exact backup
    # actually exists. This also makes an early move failure reversible.
    if ($null -eq $existing) { continue }
    if ($null -ne $installed) {
      [IO.Directory]::CreateDirectory($failed) | Out-Null
      $quarantine = Join-Path $failed ([string]$entry.Name)
      if ($installed.PSIsContainer) { [IO.Directory]::Move($installed.FullName, $quarantine) }
      else { [IO.File]::Move($installed.FullName, $quarantine) }
    }
    if ($null -ne $existing) {
      if ($existing.PSIsContainer) { [IO.Directory]::Move($old, [string]$entry.Path) }
      else { [IO.File]::Move($old, [string]$entry.Path) }
    }
  }
  # Only after original owned paths have been fully restored is deletion safe.
  Remove-Item -LiteralPath $Transaction.Backup -Recurse -Force -ErrorAction Stop
}
function Complete-ExecutableReplacement($Transaction) {
  if ($null -ne $Transaction) {
    # The bundled installer already verified exact NEW version and HEALTHY.
    # Never keep successful historical executable archives on the user's disk.
    # Retired managed Git child processes can briefly retain an NTFS handle
    # (notably commit-graph-chain) after the NEW runtime is healthy. Retry
    # only this exact product-owned temporary backup, not any user folders.
    for ($attempt=0; $attempt -lt 20; $attempt++) {
      try {
        if ([IO.Directory]::Exists($Transaction.Backup)) { Remove-Item -LiteralPath $Transaction.Backup -Recurse -Force -ErrorAction Stop }
        return
      } catch {
        if ($attempt -eq 19) { throw }
        Start-Sleep -Milliseconds 500
      }
    }
  }
}

function Invoke-EquinoxLocalInstall {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { Fail 'Windows is required' }
  $script:Target = Get-NativeWindowsTarget
  $localAppData = $env:LOCALAPPDATA
  if ([string]::IsNullOrWhiteSpace($localAppData) -or -not [IO.Path]::IsPathRooted($localAppData)) { Fail 'trusted LOCALAPPDATA is required' }
  $installRoot = Join-Path $localAppData 'Equinox Local'
  $stagingRoot = Join-Path $installRoot 'staging'
  Assert-NormalDirectory $installRoot $true | Out-Null
  Assert-NormalDirectory $stagingRoot $true | Out-Null
  $tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('equinox-local-install-' + [Guid]::NewGuid().ToString('N'))
  [IO.Directory]::CreateDirectory($tempRoot) | Out-Null
  try {
    # The SAME fully signed Main ZIP for fresh install, reinstall and update.
    $freshReceipt = @(Invoke-VerifiedMainPreparation $tempRoot)
    if ($freshReceipt.Count -ne 1) { Fail 'signed Main verifier did not return one receipt' }
    try { $main = $freshReceipt[0] | ConvertFrom-Json -ErrorAction Stop }
    catch { Fail 'signed Main verification receipt is malformed' }
    if ($main.sourceSha -notmatch '^[a-f0-9]{40}$' -or $main.target -cne $Target -or
        $main.version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') {
      Fail 'production Main selector source SHA, target or version is invalid'
    }
    $mainArch = if ($Target -ceq 'win32-arm64') { 'arm64' } else { 'x64' }
    $mainNode = Join-Path (Join-Path (Join-Path $tempRoot 'node') ('node-v' + $MainNodeVersion + '-win-' + $mainArch)) 'node.exe'
    $mainInstaller = Join-Path (Join-Path $tempRoot 'main-extracted') 'release\equinox-local-first-install.js'
    $mainArchive = Join-Path $tempRoot 'main-native.zip'
    $mainSelector = Join-Path $tempRoot 'main-signed-pointer.json'
    Assert-NormalFile $mainNode 1 200000000 | Out-Null
    Assert-NormalFile $mainInstaller 1 2097152 | Out-Null
    Assert-NormalFile $mainArchive 1 $MaxArtifactBytes | Out-Null
    Assert-NormalFile $mainSelector 200 16384 | Out-Null
    # Existing product-owned executable replacement already stops WPF,
    # clears old software paths, and preserves state/config/workspace.
    $suspendedHost = Suspend-OldEquinoxChromeHost $installRoot
    try { $oldExecutables = Begin-ExecutableReplacement $installRoot }
    catch { Restore-OldEquinoxChromeHost $suspendedHost; throw }
    try {
      $freshResult = @(Invoke-PinnedMainNode $mainNode @($mainInstaller,
        '--install-main-fresh', '--signed-pointer-file', $mainSelector,
        '--archive', $mainArchive))
      if ($freshResult.Count -ne 1) { Fail 'signed Main has no verified completion receipt' }
      try { $installed = $freshResult[0] | ConvertFrom-Json -ErrorAction Stop }
      catch { Fail 'signed Main completion receipt is invalid' }
      if ($installed.status -cne 'installed' -or $installed.channel -cne 'main' -or
          $installed.sourceSha -cne $main.sourceSha -or
          $installed.version -cne $main.version -or $installed.target -cne $Target) {
        Fail 'running Main release does not match its exact signed source SHA'
      }
      Write-Output $freshResult[0]
      Write-Info 'signed Main is installed and healthy'
    } finally {
      # No rollback to a prior version; repeat this installer for repair.
      Complete-ExecutableReplacement $oldExecutables
    }
    return
  } finally {
    if ([IO.Directory]::Exists($tempRoot)) { Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

if ($MyInvocation.InvocationName -ne '.') { Invoke-EquinoxLocalInstall }
