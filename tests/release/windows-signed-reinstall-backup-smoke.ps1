$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
# Use the actual public script's production backup functions in a disposable
# Windows directory. Do NOT call its downloaded installer or touch this host.
$installer = Join-Path ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))) 'scripts\install-equinox-local.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($installer, [ref]$tokens, [ref]$errors)
if (@($errors).Count -ne 0) { throw 'Public signed Windows installer has a PowerShell syntax error.' }
$required = @('Test-ExistingEquinoxOwnedProcess','Stop-ExistingEquinoxExecutables','Get-NormalExistingEntry','Get-ExecutableReplacementPaths','Begin-ExecutableReplacement','Restore-ExecutableReplacement','Complete-ExecutableReplacement')
$functions = @($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]}, $true))
foreach ($name in $required) {
  $entry = @($functions | Where-Object Name -eq $name)
  if ($entry.Count -ne 1) { throw "Missing real installer backup implementation: $name" }
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
  Put (Join-Path $root 'releases\6.1.0\old.exe') 'old-signed-release'
  Put (Join-Path $root 'runtime\guardian\guardian.exe') 'old-guardian'
  Put (Join-Path $root 'state\main-update\sources\broken-old\src\server.js') 'broken-old-source-no-git'
  $readOnly = Join-Path $root 'state\main-update\sources\broken-old\.git\objects\info\commit-graphs\commit-graph-chain'
  Put $readOnly 'old-read-only-git-commit-graph'
  [IO.File]::SetAttributes($readOnly, [IO.FileAttributes]::ReadOnly)
  Put (Join-Path $root 'current-version.json') 'bad-stale-pointer'
  Put (Join-Path $program 'EquinoxLocal.exe') 'old-wpf'
  Put (Join-Path $root 'browser\native-messaging\dev.equinox.browser.json') 'old-host'
  Put (Join-Path $root 'state\config.json') 'user-config-do-not-touch'
  Put (Join-Path $root 'secrets\runtime-key') 'user-secret-do-not-touch'
  Put (Join-Path $root 'workspace\notes.txt') 'user-workspace-do-not-touch'
  Put (Join-Path $root 'browser\profile-settings.txt') 'user-browser-do-not-touch'
  Put (Join-Path $root 'tunnel\settings.txt') 'user-tunnel-do-not-touch'
}
function Assert-Private {
  foreach ($row in @(
    @('state\config.json','user-config-do-not-touch'),
    @('secrets\runtime-key','user-secret-do-not-touch'),
    @('workspace\notes.txt','user-workspace-do-not-touch'),
    @('browser\profile-settings.txt','user-browser-do-not-touch'),
    @('tunnel\settings.txt','user-tunnel-do-not-touch')
  )) { Assert-True (([IO.File]::ReadAllText((Join-Path $root $row[0])) -ceq $row[1])) 'Installer modified user-owned data.' }
}
try {
  Assert-TemporaryChromeRegistration
  Prepare-Old
  # Reproduce the user's lock: stock Windows PowerShell runs an old Main
  # script from the managed source tree despite powershell.exe living in
  # System32, not under the product install root. The real installer must
  # terminate this exact owned helper before moving main-update.
  $ownedScript=Join-Path $root 'state\main-update\sources\broken-old\src\fixture-owned.ps1'
  Put $ownedScript 'Start-Sleep -Seconds 120'
  $systemPowerShell=Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $ownedProcess=Start-Process -FilePath $systemPowerShell -ArgumentList ('-NoProfile -NonInteractive -File "' + $ownedScript + '"') -PassThru -WindowStyle Hidden
  try {
    $seen=$false
    for ($poll=0; $poll -lt 25; $poll++) {
      $cim=Get-CimInstance Win32_Process -Filter ('ProcessId=' + $ownedProcess.Id)
      if ($null -ne $cim -and (Test-ExistingEquinoxOwnedProcess $cim $root $program)) { $seen=$true; break }
      Start-Sleep -Milliseconds 80
    }
    Assert-True $seen 'Disposable managed PowerShell process did not start or match exact owner.'
    # A foreign non-share-delete file handle can block a rename even when
    # all owned processes are gone. Refuse without quarantining the untouched
    # original tree or retaining a partial backup.
    $locked=Join-Path $root 'state\main-update\sources\broken-old\src\server.js'
    $held=[IO.File]::Open($locked,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    $blockedByLock=$false
    try { Begin-ExecutableReplacement $root | Out-Null } catch { $blockedByLock=$true }
    finally { $held.Dispose() }
    Assert-True $blockedByLock 'Locked old Main folder unexpectedly moved.'
    Assert-True ([IO.File]::Exists($locked)) 'Locked old Main source was incorrectly quarantined during rollback.'
    Assert-True (-not [IO.Directory]::Exists((Join-Path $root '.equinox-signed-reinstall-backup'))) 'Aborted move retained an empty transaction backup.'
    $first=Begin-ExecutableReplacement $root
    Assert-True ($null -eq (Get-CimInstance Win32_Process -Filter ('ProcessId=' + $ownedProcess.Id))) 'Old managed PowerShell child remains alive after installer retirement.'
  } finally { if (-not $ownedProcess.HasExited) { Stop-Process -Id $ownedProcess.Id -Force -ErrorAction SilentlyContinue } }

  Assert-True ($null -ne $first) 'Historic signed runtime was not parked.'
  Assert-True (-not [IO.File]::Exists((Join-Path $root 'current-version.json'))) 'Stale version pointer survived initial reset.'
  Assert-True (-not [IO.Directory]::Exists((Join-Path $root 'state\main-update'))) 'Broken old source survived reset.'
  Assert-Private
  $blocked=$false
  try { Begin-ExecutableReplacement $root | Out-Null } catch { $blocked=$true }
  Assert-True $blocked 'A second attempt created a second backup.'
  Put (Join-Path $root 'releases\6.2.0\new.exe') 'new-signed-release'
  Put (Join-Path $program 'EquinoxLocal.exe') 'new-wpf'
  Complete-ExecutableReplacement $first
  Assert-True (-not [IO.Directory]::Exists($first.Backup)) 'Successful reinstall retained old executable archive.'
  Assert-True ([IO.File]::Exists((Join-Path $root 'releases\6.2.0\new.exe'))) 'Successful install removed new release.'
  Assert-Private
  # A failed candidate must be quarantined and the EXACT old executable
  # directories returned; no accumulation after successful rollback either.
  [IO.Directory]::Delete((Join-Path $root 'releases'),$true)
  [IO.Directory]::Delete($program,$true)
  Prepare-Old
  $second=Begin-ExecutableReplacement $root
  Put (Join-Path $root 'releases\6.2.0\new.exe') 'failed-new-release'
  Put (Join-Path $program 'EquinoxLocal.exe') 'failed-new-wpf'
  Restore-ExecutableReplacement $second
  Assert-True (-not [IO.Directory]::Exists($second.Backup)) 'Successful rollback retained a backup archive.'
  Assert-True ([IO.File]::ReadAllText((Join-Path $program 'EquinoxLocal.exe')) -ceq 'old-wpf') 'Rollback did not restore old WPF.'
  Assert-True ([IO.File]::ReadAllText((Join-Path $root 'current-version.json')) -ceq 'bad-stale-pointer') 'Rollback altered stale old pointer.'
  Assert-True (-not [IO.File]::Exists((Join-Path $root 'releases\6.2.0\new.exe'))) 'Failed candidate leaked into active releases.'
  Assert-Private
  Write-Output 'Real PowerShell backup functions PASS: prior broken source ignored, one backup, successful cleanup, failure restoration and unchanged user settings.'
} finally { if ([IO.Directory]::Exists($fixture)) { Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction Stop } }
