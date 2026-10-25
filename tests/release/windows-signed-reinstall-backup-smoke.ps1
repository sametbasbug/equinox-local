$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
# Use the actual public script's production backup functions in a disposable
# Windows directory. Do NOT call its downloaded installer or touch this host.
$installer = Join-Path ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))) 'scripts\install-equinox-local.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($installer, [ref]$tokens, [ref]$errors)
if (@($errors).Count -ne 0) { throw 'Public signed Windows installer has a PowerShell syntax error.' }
$required = @('Get-NormalExistingEntry','Get-ExecutableReplacementPaths','Begin-ExecutableReplacement','Restore-ExecutableReplacement','Complete-ExecutableReplacement')
$functions = @($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]}, $true))
foreach ($name in $required) {
  $entry = @($functions | Where-Object Name -eq $name)
  if ($entry.Count -ne 1) { throw "Missing real installer backup implementation: $name" }
  Invoke-Expression $entry[0].Extent.Text
}
function Fail([string]$Reason) { throw $Reason }
# No live applications live in this fixture; stop is independently exercised
# on actual installed Windows product smoke, never against this host profile.
function Stop-ExistingEquinoxExecutables([string]$InstallRoot, [string]$ProgramRoot) { }
function Assert-True([bool]$ok,[string]$message) { if (-not $ok) { throw $message } }
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('equinox-reinstall-backup-' + [Guid]::NewGuid().ToString('N'))
$root=Join-Path $fixture 'Equinox Local'
$program=Join-Path $fixture 'Programs\Equinox Local'
function Put([string]$path,[string]$text) {
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path)) | Out-Null
  [IO.File]::WriteAllText($path,$text)
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
  Prepare-Old
  $first=Begin-ExecutableReplacement $root
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
} finally { if ([IO.Directory]::Exists($fixture)) { [IO.Directory]::Delete($fixture,$true) } }
