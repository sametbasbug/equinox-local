param(
  [Parameter(Mandatory=$true)][ValidateSet('win32-x64','win32-arm64')][string]$ExpectedTarget
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
. (Join-Path $Root 'scripts\install-equinox-local.ps1')

if ($PSVersionTable.PSVersion.Major -ne 5) { throw "Windows PowerShell 5.1 is required; got $($PSVersionTable.PSVersion)." }
$actual = Get-NativeWindowsTarget
if ($actual -cne $ExpectedTarget) { throw "Windows PowerShell native target mismatch: expected=$ExpectedTarget actual=$actual" }
Write-Output "Windows PowerShell 5.1 native target acceptance passed: $actual"
