$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

$root = [string]$env:GITHUB_WORKSPACE
if ([string]::IsNullOrWhiteSpace($root) -or -not [IO.Path]::IsPathRooted($root) -or -not (Test-Path -LiteralPath $root -PathType Container)) {
  throw 'Native ARM64 CI preparation requires the checked-out GitHub workspace.'
}
Set-Location -LiteralPath $root
$npmCommand = (Get-Command npm.cmd -ErrorAction Stop).Source

# npm writes node_modules; the native WPF project reads only its own sources,
# pinned NuGet packages and application artwork. These inputs are independent.
$installJob = Start-Job -ArgumentList $root, $npmCommand -ScriptBlock {
  param([string]$Workspace, [string]$NpmCommand)
  $ErrorActionPreference = 'Stop'
  $PSNativeCommandUseErrorActionPreference = $true
  Set-Location -LiteralPath $Workspace
  & $NpmCommand ci --prefer-offline --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "Locked native npm installation failed with exit code $LASTEXITCODE." }
}

try {
  dotnet publish native/windows/EquinoxLocal.WindowsShell/EquinoxLocal.WindowsShell.csproj --configuration Release --runtime win-arm64 --self-contained true -p:Platform=ARM64 --output artifacts/windows-shell/win-arm64
  if ($LASTEXITCODE -ne 0) { throw "Native ARM64 shell publication failed with exit code $LASTEXITCODE." }

  $null = Wait-Job -Job $installJob
  if ($installJob.State -ne 'Completed') {
    Receive-Job -Job $installJob -ErrorAction Continue
    throw 'Locked native npm installation did not complete successfully.'
  }
  Receive-Job -Job $installJob -ErrorAction Stop
} finally {
  # Only this preparation step's own job is stopped or removed.
  Stop-Job -Job $installJob -ErrorAction SilentlyContinue
  Remove-Job -Job $installJob -ErrorAction SilentlyContinue
}
