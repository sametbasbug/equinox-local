$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
# Use the actual public script's executable cleanup functions in a disposable
# Windows directory. Do NOT call its downloaded installer or touch this host.
$installer = Join-Path ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))) 'scripts\install-equinox-local.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($installer, [ref]$tokens, [ref]$errors)
if (@($errors).Count -ne 0) { throw 'Public signed Windows installer has a PowerShell syntax error.' }
$required = @('Test-ExistingEquinoxOwnedProcess','Stop-ExistingEquinoxExecutables','Get-NormalExistingEntry','Get-ExecutableReplacementPaths','Clear-ExistingEquinoxExecutables')
$functions = @($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]}, $true))
foreach ($name in $required) {
  $entry = @($functions | Where-Object Name -eq $name)
  if ($entry.Count -ne 1) { throw "Missing real installer cleanup implementation: $name" }
  Invoke-Expression $entry[0].Extent.Text
}
function Fail([string]$Reason) { throw $Reason }
# All process stop operations below are against a unique disposable fixture only.
function Assert-True([bool]$ok,[string]$message) { if (-not $ok) { throw $message } }
function Assert-ProcessClassification {
  $fakeRoot = 'C:\Users\fixture\AppData\Local\Equinox Local'
  $fakeProg = 'C:\Users\fixture\AppData\Local\Programs\Equinox Local'
  $managed = $fakeRoot + '\state\main-update'
  foreach ($owned in @(
    [pscustomobject]@{Name='equinox-browser-native-host.exe';ExecutablePath="$managed\native-store\win32-x64\old\release\runtime\browser\equinox-browser-native-host.exe";CommandLine='host'},
    [pscustomobject]@{Name='node.exe';ExecutablePath="$managed\native-store\win32-x64\old\release\runtime\node\bin\node.exe";CommandLine='node'},
    [pscustomobject]@{Name='node.exe';ExecutablePath='C:\Program Files\nodejs\node.exe';CommandLine=('"C:\Program Files\nodejs\node.exe" "' + $managed + '\sources\old\src\server.js"')},
    [pscustomobject]@{Name='powershell.exe';ExecutablePath='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe';CommandLine=('powershell.exe -NoProfile -File "' + $managed + '\sources\old\src\equinox-local-windows-job-object.ps1"')},
    [pscustomobject]@{Name='EquinoxLocal.exe';ExecutablePath="$fakeProg\EquinoxLocal.exe";CommandLine='WPF'}
  )) { Assert-True (Test-ExistingEquinoxOwnedProcess $owned $fakeRoot $fakeProg) "Missed an owned old runtime: $($owned.Name)" }
  foreach ($foreign in @(
    [pscustomobject]@{Name='powershell.exe';ExecutablePath='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe';CommandLine='powershell -File C:\Users\fixture\Documents\my-script.ps1'},
    [pscustomobject]@{Name='node.exe';ExecutablePath='C:\Program Files\nodejs\node.exe';CommandLine='node C:\Users\fixture\other\server.js'},
    [pscustomobject]@{Name='chrome.exe';ExecutablePath='C:\Program Files\Google\Chrome\Application\chrome.exe';CommandLine=('chrome --url="file:///' + $managed + '\sources\old\src\server.js"')},
    [pscustomobject]@{Name='pwsh.exe';ExecutablePath='C:\Program Files\PowerShell\7\pwsh.exe';CommandLine='pwsh -Command irm https://local.sametbasbug.dev/downloads/updates/install-equinox-local.ps1'},
    [pscustomobject]@{Name='node.exe';ExecutablePath="$fakeRoot\state\main-update-foreign\node.exe";CommandLine='node'},
    [pscustomobject]@{Name='node.exe';ExecutablePath='C:\Program Files\nodejs\node.exe';CommandLine=('node "' + $managed + '\sources\old\src\server.js.evil"')}
  )) { Assert-True (-not (Test-ExistingEquinoxOwnedProcess $foreign $fakeRoot $fakeProg)) "Foreign process falsely admitted: $($foreign.Name)" }
}
Assert-ProcessClassification

$fixture=Join-Path ([IO.Path]::GetTempPath()) ('equinox-reinstall-backup-' + [Guid]::NewGuid().ToString('N'))
$root=Join-Path $fixture 'Equinox Local'
$program=Join-Path $fixture 'Programs\Equinox Local'
function Put([string]$path,[string]$text) {
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path)) | Out-Null
  [IO.File]::WriteAllText($path,$text)
}
function Assert-TemporaryChromeRegistration {
  # Exercise the REAL functions against one disposable HKCU registration,
  # never the owner's connected Chrome/Equinox registration.
  $testName='dev.equinox.browser.fixture' + [Guid]::NewGuid().ToString('N')
  $subkey='Software\Google\Chrome\NativeMessagingHosts\' + $testName
  $parent='Software\Google\Chrome\NativeMessagingHosts'
  $manifest=Join-Path $root ('browser\native-messaging\' + $testName + '.json')
  $exe=Join-Path $root 'state\main-update\native-store\test\release\runtime\browser\equinox-browser-native-host.exe'
  $actualNames=@('Suspend-OldEquinoxChromeHost','Restore-OldEquinoxChromeHost')
  foreach ($name in $actualNames) {
    $entry=@($functions | Where-Object Name -eq $name)
    Assert-True ($entry.Count -eq 1) 'Missing Chrome suspend/restore function in real signed installer.'
    $source=$entry[0].Extent.Text.Replace('dev.equinox.browser',$testName)
    if ($name -eq 'Suspend-OldEquinoxChromeHost') {
      $source=$source.Replace('function Suspend-OldEquinoxChromeHost','function Suspend-DisposableChromeRegistration')
    } else {
      $source=$source.Replace('function Restore-OldEquinoxChromeHost','function Restore-DisposableChromeRegistration')
    }
    Invoke-Expression $source
  }
  function Assert-NormalFile([string]$Path,[long]$MinBytes,[long]$MaxBytes) {
    $stat=Get-Item -LiteralPath $Path -ErrorAction Stop
    Assert-True (-not $stat.PSIsContainer -and $stat.Length -ge $MinBytes -and $stat.Length -le $MaxBytes) 'Invalid disposable manifest file.'
  }
  try {
    Put $exe 'disposable launcher'
    Put $manifest (@{name=$testName;type='stdio';path=$exe;allowed_origins=@('chrome-extension://fixture/')}|ConvertTo-Json)
    $key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($subkey)
    try {$key.SetValue('', $manifest, [Microsoft.Win32.RegistryValueKind]::String)} finally {$key.Dispose()}
    $paused=Suspend-DisposableChromeRegistration $root
    Assert-True ($null -ne $paused) 'Did not suspend exact disposable owned Chrome host.'
    $read=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($subkey,$false)
    if($null -ne $read){$read.Dispose();throw 'Chrome host registration still exists while suspended.'}
    $foreign=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($subkey)
    try{$foreign.SetValue('', 'C:\foreign\host.json', [Microsoft.Win32.RegistryValueKind]::String)} finally{$foreign.Dispose()}
    $blocked=$false
    try{Restore-DisposableChromeRegistration $paused}catch{$blocked=$true}
    Assert-True $blocked 'Registry restore overwrote a foreign registrant.'
    $parentKey=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($parent,$true)
    try{$parentKey.DeleteSubKey($testName,$false)}finally{$parentKey.Dispose()}
    Restore-DisposableChromeRegistration $paused
    $read=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($subkey,$false)
    Assert-True ($null -ne $read) 'Failed to restore original host registration after unsuccessful install.'
    try{Assert-True ($read.GetValue('', $null) -ceq $manifest) 'Restored wrong exact manifest.'}
    finally {$read.Dispose()}
  } finally {
    $parentKey=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($parent,$true)
    if($null -ne $parentKey) {
      try{$parentKey.DeleteSubKey($testName,$false)}catch{}finally{$parentKey.Dispose()}
    }
  }
}

function Prepare-Old {
  Put (Join-Path $root 'releases\6.1.0\old.exe') 'old-release'
  Put (Join-Path $root 'runtime\old.exe') 'old-runtime'
  Put (Join-Path $root 'state\main-update\sources\broken-old\src\server.js') 'old-source'
  Put (Join-Path $root 'current-version.json') 'old-pointer'
  Put (Join-Path $program 'EquinoxLocal.exe') 'old-wpf'
  Put (Join-Path $root 'browser\native-messaging\dev.equinox.browser.json') 'old-host'
  Put (Join-Path $root 'state\config.json') 'user-config'
  Put (Join-Path $root 'secrets\runtime-key') 'user-secret'
  Put (Join-Path $root 'workspace\notes.txt') 'user-workspace'
  Put (Join-Path $root 'browser\profile-settings.txt') 'user-browser'
  Put (Join-Path $root 'tunnel\settings.txt') 'user-tunnel'
}
function Assert-Private {
  foreach ($item in @(
    @('state\config.json','user-config'),@('secrets\runtime-key','user-secret'),
    @('workspace\notes.txt','user-workspace'),
    @('browser\profile-settings.txt','user-browser'),@('tunnel\settings.txt','user-tunnel')
  )) { Assert-True ([IO.File]::ReadAllText((Join-Path $root $item[0])) -ceq $item[1]) 'Installer touched user data.' }
}
try {
  Assert-TemporaryChromeRegistration
  Prepare-Old
  Clear-ExistingEquinoxExecutables $root
  foreach ($entry in @(Get-ExecutableReplacementPaths $root)) {
    Assert-True (-not (Test-Path -LiteralPath $entry.Path)) ('Old executable survived: ' + $entry.Name)
  }
  Assert-Private
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $root '.equinox-signed-reinstall-backup'))) 'Old installer backup was retained.'
  # A retry does exactly the same fresh install cleanup, without an A/B phase.
  Put (Join-Path $root 'releases\6.2.0\new.exe') 'new-release'
  Clear-ExistingEquinoxExecutables $root
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $root 'releases\6.2.0'))) 'Retry did not retire executable cache.'
  Assert-Private
  Write-Output 'Real PowerShell reinstall PASS: direct clean, same-SHA retry, no rollback, user data unchanged.'
} finally { if ([IO.Directory]::Exists($fixture)) { Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction Stop } }
