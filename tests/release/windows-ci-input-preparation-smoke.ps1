$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$helper = Join-Path $root '.github\actions\prepare-arm64-package\prepare-inputs.ps1'
$work = Join-Path ([IO.Path]::GetTempPath()) ('Equinox CI Input Türk ' + [Guid]::NewGuid().ToString('N'))
$bin = Join-Path $work 'bin'
$originalPath = $env:PATH
$originalWorkspace = $env:GITHUB_WORKSPACE
$originalLocation = Get-Location
$originalJobs = ((Get-Job | Select-Object -ExpandProperty Id | Sort-Object) -join ',')

try {
  [IO.Directory]::CreateDirectory($bin) | Out-Null
  $env:PATH = $bin + [IO.Path]::PathSeparator + $originalPath
  foreach ($case in @(
    @{ Name = 'success'; Npm = 0; Dotnet = 0; ExpectedSuccess = $true },
    @{ Name = 'npm failure'; Npm = 7; Dotnet = 0; ExpectedSuccess = $false },
    @{ Name = 'dotnet failure'; Npm = 0; Dotnet = 9; ExpectedSuccess = $false }
  )) {
    $workspace = Join-Path $work ($case.Name.Replace(' ', '-'))
    [IO.Directory]::CreateDirectory($workspace) | Out-Null
    $env:GITHUB_WORKSPACE = $workspace
    $npm = Join-Path $bin 'npm.cmd'
    $dotnet = Join-Path $bin 'dotnet.cmd'
    [IO.File]::WriteAllText($npm, "@echo off`r`necho npm>>`"%GITHUB_WORKSPACE%\npm.calls`"`r`nexit /b $($case.Npm)`r`n", [Text.Encoding]::ASCII)
    [IO.File]::WriteAllText($dotnet, "@echo off`r`necho dotnet>>`"%GITHUB_WORKSPACE%\dotnet.calls`"`r`nexit /b $($case.Dotnet)`r`n", [Text.Encoding]::ASCII)
    if ((Get-Command npm.cmd).Source -ne $npm -or (Get-Command dotnet).Source -ne $dotnet) { throw 'CI input smoke failed to isolate native command fixtures.' }

    $succeeded = $false
    try {
      & $helper | Out-Host
      $succeeded = $true
    } catch {
      if ($case.ExpectedSuccess) { throw }
      $message = $_.Exception.Message
      if ($case.Npm -ne 0 -and $message -notmatch 'Locked native npm installation') { throw }
      if ($case.Dotnet -ne 0 -and $message -notmatch 'dotnet') { throw }
      Write-Output ("Expected {0} was propagated: {1}" -f $case.Name, $message)
    }
    if ($succeeded -ne $case.ExpectedSuccess) { throw ("CI input preparation returned the wrong result for {0}." -f $case.Name) }
    if (-not (Test-Path -LiteralPath (Join-Path $workspace 'dotnet.calls'))) { throw 'Every case must execute the native shell command fixture.' }
    if ($case.Dotnet -eq 0 -and -not (Test-Path -LiteralPath (Join-Path $workspace 'npm.calls'))) { throw 'Success and npm failure must execute the npm command fixture.' }
    $remainingJobs = ((Get-Job | Select-Object -ExpandProperty Id | Sort-Object) -join ',')
    if ($remainingJobs -ne $originalJobs) { throw 'CI input preparation leaked a background job or removed an unrelated job.' }
  }
  Write-Output 'Native CI input preparation smoke passed: success, npm failure, dotnet failure and owned-job cleanup.'
} finally {
  $env:PATH = $originalPath
  $env:GITHUB_WORKSPACE = $originalWorkspace
  Set-Location -LiteralPath $originalLocation.Path
  if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
}
