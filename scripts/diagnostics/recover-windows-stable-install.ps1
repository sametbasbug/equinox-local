# Explicit, fail-closed recovery for an owned Windows Stable install when both
# the in-app updater and the registered uninstaller are stuck. Windows PS 5.1+.
# Defaults to an audit; -Reset quarantines (does not delete) both owned roots.
param([switch]$Reset)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

function Refuse([string]$why) { throw "Equinox Local recovery refused: $why" }
function SamePath([string]$left, [string]$right) {
  if ([string]::IsNullOrWhiteSpace($left) -or [string]::IsNullOrWhiteSpace($right)) { return $false }
  try { return [string]::Equals([IO.Path]::GetFullPath($left).TrimEnd('\'), [IO.Path]::GetFullPath($right).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase) }
  catch { return $false }
}
function Normal([string]$name, [bool]$directory) {
  if (-not (Test-Path -LiteralPath $name)) { Refuse 'an expected owned path is missing' }
  $item = Get-Item -LiteralPath $name -Force -ErrorAction Stop
  if (([bool]$item.PSIsContainer) -ne $directory -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    Refuse 'an owned path is not a normal file or directory'
  }
  return $item
}
function JsonBounded([string]$name, [long]$maximum) {
  $item = Normal $name $false
  if ($item.Length -lt 1 -or $item.Length -gt $maximum) { Refuse 'an owned metadata file has an invalid length' }
  try { return Get-Content -LiteralPath $name -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop }
  catch { Refuse 'an owned metadata file cannot be parsed' }
}
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { Refuse 'Windows is required' }
$local = $env:LOCALAPPDATA
if ([string]::IsNullOrWhiteSpace($local) -or -not [IO.Path]::IsPathRooted($local)) { Refuse 'LOCALAPPDATA is invalid' }
$root = Join-Path $local 'Equinox Local'
$programRoot = Join-Path (Join-Path $local 'Programs') 'Equinox Local'
$exe = Join-Path $programRoot 'EquinoxLocal.exe'
$pointer = Join-Path $root 'current-version.json'
$manifest = Join-Path $root 'browser\native-messaging\dev.equinox.browser.json'
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Equinox Local'
$hostKey = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\dev.equinox.browser'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'Equinox Local.lnk'

Normal $root $true | Out-Null
Normal $programRoot $true | Out-Null
Normal $exe $false | Out-Null
$active = JsonBounded $pointer 4096
if ($active.schemaVersion -ne 1 -or $active.target -notin @('win32-x64','win32-arm64') -or
    $active.version -isnot [string] -or $active.version -notmatch '^\d+\.\d+\.\d+$' -or
    @($active.PSObject.Properties.Name).Count -ne 3) { Refuse 'the active release pointer is not a recognized managed Stable pointer' }
$releaseRoot = Join-Path (Join-Path $root 'releases') $active.version
$release = JsonBounded (Join-Path $releaseRoot 'release.json') 16384
if ($release.schemaVersion -ne 1 -or $release.version -cne $active.version -or $release.target -cne $active.target -or $release.serverEntry -cne 'server.js') {
  Refuse 'active release identity is inconsistent'
}
$registration = Get-ItemProperty -LiteralPath $uninstallKey -ErrorAction SilentlyContinue
if ($null -eq $registration -or $registration.EquinoxLocalManagedInstall -ne 1 -or
    $registration.DisplayName -cne 'Equinox Local' -or $registration.Publisher -cne 'Equinox Project' -or
    -not (SamePath $registration.InstallLocation $programRoot) -or
    $registration.UninstallString -cne ('"' + $exe + '" --uninstall')) { Refuse 'Installed Apps ownership could not be verified' }
if (@(Get-ChildItem -LiteralPath $uninstallKey -ErrorAction Stop).Count -ne 0) { Refuse 'Installed Apps registration contains foreign child keys' }

$hostRegistered = $false
if (Test-Path -LiteralPath $hostKey) {
  $hostPath = (Get-Item -LiteralPath $hostKey -ErrorAction Stop).GetValue('')
  if (-not (SamePath ([string]$hostPath) $manifest)) { Refuse 'Chrome Native Messaging registration has foreign ownership' }
  if (@(Get-ChildItem -LiteralPath $hostKey -ErrorAction Stop).Count -ne 0) { Refuse 'Chrome Native Messaging registration has child keys' }
  $hostRegistered = $true
}
if (Test-Path -LiteralPath $manifest) {
  $nativeHost = JsonBounded $manifest 16384
  if ($nativeHost.name -cne 'dev.equinox.browser' -or $nativeHost.type -cne 'stdio' -or
      @($nativeHost.allowed_origins).Count -ne 1 -or
      $nativeHost.allowed_origins[0] -cne 'chrome-extension://npdneefcobilfkjlihghjgjnknenhfoj/' -or
      $nativeHost.path -isnot [string]) { Refuse 'Chrome Native Messaging manifest is not the owned Equinox Browser manifest' }
  $matchedLauncher = $false
  foreach ($v in @($active.version, '6.0.2') | Select-Object -Unique) {
    if (SamePath $nativeHost.path (Join-Path (Join-Path (Join-Path $root 'releases') $v) 'runtime\browser\equinox-browser-native-host.exe')) { $matchedLauncher = $true }
  }
  if (-not $matchedLauncher) { Refuse 'Chrome Native Messaging launcher is foreign' }
} elseif ($hostRegistered) { Refuse 'Chrome Native Messaging registry points to a missing manifest; investigate before reset' }

$startupEntry = Get-ItemProperty -LiteralPath $runKey -Name 'Equinox Local' -ErrorAction SilentlyContinue
$startup = if ($null -ne $startupEntry) { $startupEntry.'Equinox Local' } else { $null }
if ($null -ne $startup -and $startup -cne ('"' + $exe + '" --startup')) { Refuse 'Windows startup entry belongs to another command' }
if (Test-Path -LiteralPath $shortcut) {
  Normal $shortcut $false | Out-Null
  $com = New-Object -ComObject WScript.Shell
  try { if (-not (SamePath ([string]$com.CreateShortcut($shortcut).TargetPath) $exe)) { Refuse 'Start Menu shortcut has foreign ownership' } }
  finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($com) }
}
$running = @(Get-Process -Name 'EquinoxLocal' -ErrorAction SilentlyContinue)
foreach ($process in $running) {
  $processPath = $null
  try { $processPath = $process.Path } catch { Refuse 'cannot verify the running Windows shell executable' }
  if (-not (SamePath $processPath $exe)) { Refuse 'an EquinoxLocal process belongs to another installation' }
}
$updateStatus = 'none'
$updateStatePath = Join-Path $root 'update-state.json'
if (Test-Path -LiteralPath $updateStatePath) {
  $updateState = JsonBounded $updateStatePath 16384
  if ($updateState.status -is [string]) { $updateStatus = $updateState.status }
}
Write-Output "Equinox Local owned Stable audit: version=$($active.version); update=$updateStatus; running=$($running.Count); nativeHost=$hostRegistered"
if (-not $Reset) { Write-Output 'Audit only: no changes. Pass -Reset to quarantine both owned installation directories and remove validated per-user registrations.'; return }

# No global node.exe / Git / Windows service cleanup: only our verified shell.
foreach ($process in $running) { Stop-Process -Id $process.Id -Force -ErrorAction Stop }
foreach ($process in $running) {
  try { Wait-Process -Id $process.Id -Timeout 20 -ErrorAction Stop }
  catch { if (Get-Process -Id $process.Id -ErrorAction SilentlyContinue) { Refuse 'native shell process did not exit' } }
}
$stamp = [DateTime]::UtcNow.ToString('yyyyMMddHHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8)
$programBackup = "Equinox Local.recovery-$stamp"
$dataBackup = "Equinox Local.recovery-$stamp"
Rename-Item -LiteralPath $programRoot -NewName $programBackup -ErrorAction Stop
try { Rename-Item -LiteralPath $root -NewName $dataBackup -ErrorAction Stop }
catch {
  Rename-Item -LiteralPath (Join-Path (Join-Path $local 'Programs') $programBackup) -NewName 'Equinox Local' -ErrorAction Stop
  throw
}
# Both source directories were quarantined successfully; no unverified path is removed.
if ($null -ne $startup) { Remove-ItemProperty -LiteralPath $runKey -Name 'Equinox Local' -ErrorAction Stop }
if ($hostRegistered) { Remove-Item -LiteralPath $hostKey -ErrorAction Stop }
Remove-Item -LiteralPath $uninstallKey -ErrorAction Stop
if (Test-Path -LiteralPath $shortcut) { Remove-Item -LiteralPath $shortcut -ErrorAction Stop }
Write-Output 'Recovery reset succeeded. Previous Equinox Local directories were quarantined (not deleted). Run the official signed Stable first installer now.'
