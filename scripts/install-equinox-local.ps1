param([switch]$EnrollExistingMain, [switch]$Help)
if ($Help) {
  Write-Output 'Usage: install-equinox-local.ps1 [-EnrollExistingMain] [-Help]'
  Write-Output 'Stable (default): latest numbered release.'
  Write-Output 'Main (explicit opt-in): enroll after Stable health; fresh or same-version matching installed provenance.'
  return
}
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$UpdateBase = 'https://local.sametbasbug.dev/downloads/updates'
$Target = $null
$MaxManifestBytes = 16384
$MaxArtifactBytes = 1073741824
$ZipHelperName = 'equinox-local-windows-release-zip.ps1'
$ZipHelperSha256 = '__EQUINOX_ZIP_HELPER_SHA256__'
$ZipHelperBytes = '__EQUINOX_ZIP_HELPER_BYTES__'

function Fail([string]$Message) { throw "Equinox Local installer: $Message" }
function Write-Info([string]$Message) { Write-Host "Equinox Local installer: $Message" }
function Get-Sha256([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Get-NativeWindowsTarget {
  if (-not [Environment]::Is64BitProcess) { Fail 'native 64-bit Windows PowerShell is required' }
  $processArchitecture = [string]$env:PROCESSOR_ARCHITECTURE
  $nativeArchitecture = [string]$env:PROCESSOR_ARCHITEW6432
  if (-not [string]::IsNullOrWhiteSpace($nativeArchitecture) -and $nativeArchitecture -cne $processArchitecture) {
    Fail 'native 64-bit Windows PowerShell is required'
  }
  switch ($processArchitecture.ToUpperInvariant()) {
    'AMD64' { return 'win32-x64' }
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
function Read-BootstrapManifest([string]$Path) {
  Assert-NormalFile $Path 1 $MaxManifestBytes | Out-Null
  $text = [IO.File]::ReadAllText($Path, (New-Object Text.UTF8Encoding($false, $true)))
  if ($text.Contains("`r")) { Fail 'bootstrap manifest contains unsupported line endings' }
  $allowed = @('schemaVersion','channel','target','version','artifactUrl','artifactSha256','artifactBytes')
  $values = @{}
  foreach ($line in ($text -split "`n")) {
    if ($line.Length -eq 0) { continue }
    $index = $line.IndexOf('=')
    if ($index -le 0) { Fail 'bootstrap manifest contains a malformed line' }
    $key = $line.Substring(0, $index); $value = $line.Substring($index + 1)
    if ($allowed -notcontains $key) { Fail "bootstrap manifest contains an unsupported field: $key" }
    if ($values.ContainsKey($key)) { Fail "bootstrap manifest repeats $key" }
    $values[$key] = $value
  }
  foreach ($key in $allowed) { if (-not $values.ContainsKey($key)) { Fail "bootstrap manifest is missing $key" } }
  if ($values.schemaVersion -ne '1' -or $values.channel -ne 'stable' -or $values.target -ne $Target) { Fail 'bootstrap manifest identity is invalid' }
  if ($values.version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') { Fail 'bootstrap manifest version is invalid' }
  if ($values.artifactSha256 -notmatch '^[a-f0-9]{64}$') { Fail 'bootstrap manifest SHA-256 is invalid' }
  [long]$bytes = 0
  if (-not [long]::TryParse($values.artifactBytes, [ref]$bytes) -or $bytes -lt 1 -or $bytes -gt $MaxArtifactBytes) { Fail 'bootstrap artifact size is invalid' }
  $expectedUrl = "$UpdateBase/equinox-local-$($values.version)-$Target.zip"
  if ($values.artifactUrl -cne $expectedUrl) { Fail 'bootstrap artifact URL escaped the pinned Equinox Local HTTPS path' }
  return [pscustomobject]@{ Version=$values.version; ArtifactUrl=$values.artifactUrl; ArtifactSha256=$values.artifactSha256; ArtifactBytes=$bytes }
}
function Invoke-CleanNode([string]$Node, [string]$FirstInstall, [string]$ReleaseDir) {
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $Node
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.Arguments = '"' + $FirstInstall.Replace('"','\"') + '" --staged-release "' + $ReleaseDir.Replace('"','\"') + '"'
  if ($EnrollExistingMain) { $psi.Arguments += ' --enroll-existing-main' }
  $psi.EnvironmentVariables.Clear()
  foreach ($name in @('SystemRoot','WINDIR','ComSpec','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA','USERNAME','USERDOMAIN','PATH','PATHEXT')) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if (-not [string]::IsNullOrWhiteSpace($value)) { $psi.EnvironmentVariables[$name] = $value }
  }
  $process = New-Object Diagnostics.Process
  $process.StartInfo = $psi
  if (-not $process.Start()) { Fail 'bundled Node first-install helper did not start' }
  $stdout = $process.StandardOutput.ReadToEnd(); $stderr = $process.StandardError.ReadToEnd(); $process.WaitForExit()
  if ($process.ExitCode -ne 0) { Fail ("managed first-install activation failed: " + ($stderr.Trim() -replace '[\r\n]+',' ')) }
  if (-not [string]::IsNullOrWhiteSpace($stdout)) { Write-Output $stdout.TrimEnd() }
}
function Invoke-EquinoxLocalInstall {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { Fail 'Windows is required' }
  $script:Target = Get-NativeWindowsTarget
  if ($ZipHelperSha256 -notmatch '^[a-f0-9]{64}$') { Fail 'installer ZIP helper pin is not materialized' }
  [long]$helperBytes = 0
  if (-not [long]::TryParse($ZipHelperBytes, [ref]$helperBytes) -or $helperBytes -lt 1 -or $helperBytes -gt 1048576) { Fail 'installer ZIP helper size pin is invalid' }
  $localAppData = $env:LOCALAPPDATA
  if ([string]::IsNullOrWhiteSpace($localAppData) -or -not [IO.Path]::IsPathRooted($localAppData)) { Fail 'trusted LOCALAPPDATA is required' }
  $installRoot = Join-Path $localAppData 'Equinox Local'
  $stagingRoot = Join-Path $installRoot 'staging'
  Assert-NormalDirectory $installRoot $true | Out-Null
  Assert-NormalDirectory $stagingRoot $true | Out-Null
  $tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('equinox-local-install-' + [Guid]::NewGuid().ToString('N'))
  $stage = Join-Path $stagingRoot ('bootstrap-' + [Guid]::NewGuid().ToString('N'))
  [IO.Directory]::CreateDirectory($tempRoot) | Out-Null
  try {
    $manifestPath = Join-Path $tempRoot 'bootstrap.txt'
    $artifactPath = Join-Path $tempRoot 'release.zip'
    $helperPath = Join-Path $tempRoot $ZipHelperName
    Write-Info "checking the stable $Target bootstrap manifest"
    Save-BoundedHttpsFile "$UpdateBase/bootstrap-$Target.txt" $manifestPath $MaxManifestBytes
    $manifest = Read-BootstrapManifest $manifestPath
    Write-Info 'downloading the verified ZIP helper'
    Save-BoundedHttpsFile "$UpdateBase/$ZipHelperName" $helperPath $helperBytes
    $helper = Assert-NormalFile $helperPath $helperBytes $helperBytes
    if ((Get-Sha256 $helperPath) -cne $ZipHelperSha256) { Fail 'ZIP helper SHA-256 verification failed' }
    Write-Info "downloading Equinox Local $($manifest.Version)"
    Save-BoundedHttpsFile $manifest.ArtifactUrl $artifactPath $manifest.ArtifactBytes
    Assert-NormalFile $artifactPath $manifest.ArtifactBytes $manifest.ArtifactBytes | Out-Null
    if ((Get-Sha256 $artifactPath) -cne $manifest.ArtifactSha256) { Fail 'downloaded release SHA-256 verification failed' }
    # Extract performs the same bounded central-directory validation before writing any entry,
    # so a separate Inspect pass would only scan the verified archive twice.
    $powerShellHost = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
    if ([string]::IsNullOrWhiteSpace($powerShellHost) -or -not [IO.File]::Exists($powerShellHost)) { Fail 'current PowerShell host executable is unavailable' }
    # Capture bounded diagnostic *classification*, not raw helper output.
    # Raw PowerShell exception text can include private user paths; never echo it.
    $extractionOutput = @(& $powerShellHost -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $helperPath -Mode Extract -ArchivePath $artifactPath -DestinationPath $stage 2>&1)
    $extractExitCode = $LASTEXITCODE
    if ($extractExitCode -ne 0) {
      $extractionText = (($extractionOutput | Out-String) -replace '[\r\n]+',' ')
      if ($extractionText.Length -gt 4096) { $extractionText = $extractionText.Substring($extractionText.Length - 4096) }
      if ($extractionText -match '(?i)UnauthorizedAccessException|access is denied|access to the path|access denied|virus|malware|threat|blocked by|antivirus') {
        Fail 'verified release ZIP extraction failed: Windows denied access to a file. Check your security product detection logs for blocked or removed files; do not disable protection'
      }
      if ($extractionText -match '(?i)IOException|could not find|not found|cannot find|does not exist|file is missing') {
        Fail 'verified release ZIP extraction failed: a staged file was unavailable. Check whether security software removed it during extraction, and verify disk and folder permissions'
      }
      Fail 'verified release ZIP extraction failed: the verified archive could not be unpacked. Check disk space, folder permissions and security-product detection logs before retrying'
    }
    $release = Join-Path $stage 'release'
    $node = Join-Path $release 'runtime\node\bin\node.exe'
    $firstInstall = Join-Path $release 'equinox-local-first-install.js'
    Assert-NormalFile $node 1 536870912 | Out-Null
    Assert-NormalFile $firstInstall 1 2097152 | Out-Null
    Write-Info 'installing the verified release'
    Invoke-CleanNode $node $firstInstall $release
    Write-Info 'done'
  } finally {
    if ([IO.Directory]::Exists($stage)) {
      $stageItem = Get-Item -LiteralPath $stage -Force -ErrorAction SilentlyContinue
      if ($null -ne $stageItem -and $stageItem.PSIsContainer -and (($stageItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0)) {
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
      }
    }
    if ([IO.Directory]::Exists($tempRoot)) { Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

if ($MyInvocation.InvocationName -ne '.') { Invoke-EquinoxLocalInstall }
