param(
  [Parameter(Mandatory = $true)]
  [string]$WinappPath,
  [Parameter(Mandatory = $true)]
  [string]$FixturePath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$winapp = [System.IO.Path]::GetFullPath($WinappPath)
if (-not (Test-Path -LiteralPath $winapp -PathType Leaf)) {
  throw "Packaged winapp executable not found: $winapp"
}

$version = (& $winapp --version 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $version -notmatch '0\.7\.1') {
  throw "Packaged winapp version probe failed: $version"
}

$bytes = [System.IO.File]::ReadAllBytes($winapp)
$peOffset = [BitConverter]::ToInt32($bytes, 0x3c)
$machine = [BitConverter]::ToUInt16($bytes, $peOffset + 4)
$architecture = [System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString()
$expectedMachine = if ($architecture -eq 'Arm64') { 0xAA64 } elseif ($architecture -eq 'X64') { 0x8664 } else { throw "Unsupported CI process architecture: $architecture" }
if ($machine -ne $expectedMachine) {
  throw ("Packaged winapp architecture mismatch: process={0} machine=0x{1:X4} expected=0x{2:X4}" -f $architecture, $machine, $expectedMachine)
}

$root = Join-Path $env:RUNNER_TEMP ("equinox-winapp-smoke-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root -Force | Out-Null
$screenshotPath = Join-Path $root 'fixture.png'
$fixtureExecutable = [System.IO.Path]::GetFullPath($FixturePath)
if (-not (Test-Path -LiteralPath $fixtureExecutable -PathType Leaf)) {
  throw "Native winapp smoke fixture not found: $fixtureExecutable"
}
$fixture = Start-Process -FilePath $fixtureExecutable -PassThru
try {
  $ready = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    $list = (& $winapp ui list-windows -a $fixture.Id --json 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -eq 0 -and $list -match 'Equinox Winapp Smoke') { $ready = $true; break }
    if ($fixture.HasExited) { throw ("Controlled WinForms fixture exited before discovery: exit={0}" -f $fixture.ExitCode) }
    Start-Sleep -Milliseconds 250
  }
  if (-not $ready) { throw 'winapp could not discover the controlled WinForms fixture window.' }

  $inspect = (& $winapp ui inspect -a $fixture.Id --depth 5 --json 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $inspect -notmatch 'SmokeText' -or $inspect -notmatch 'SmokeButton') {
    throw "winapp inspect did not expose the controlled UIA fixture: $inspect"
  }

  & $winapp ui set-value SmokeText 'Equinox Windows Desktop' -a $fixture.Id --json | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'winapp set-value failed against the controlled fixture.' }

  $valueRaw = (& $winapp ui get-value SmokeText -a $fixture.Id --json 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) { throw "winapp get-value failed: $valueRaw" }
  $value = $valueRaw | ConvertFrom-Json
  if ($value.text -ne 'Equinox Windows Desktop') { throw "winapp value roundtrip mismatch: $valueRaw" }

  & $winapp ui invoke SmokeButton -a $fixture.Id --json | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'winapp invoke failed against the controlled fixture.' }
  & $winapp ui wait-for SmokeStatus -a $fixture.Id --property Name --value Clicked --timeout 5000 --json | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'winapp did not observe the UI mutation produced by invoke.' }

  $capture = (& $winapp ui screenshot -a $fixture.Id --output $screenshotPath --json 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $screenshotPath -PathType Leaf)) {
    throw "winapp screenshot failed against the controlled fixture: $capture"
  }
  if ((Get-Item -LiteralPath $screenshotPath).Length -lt 128) { throw 'winapp screenshot output is unexpectedly empty.' }

  Write-Output ("WINDOWS_WINAPP_SMOKE_PASS architecture={0} machine=0x{1:X4} version={2}" -f $architecture, $machine, $version)
}
finally {
  if ($null -ne $fixture -and -not $fixture.HasExited) { Stop-Process -Id $fixture.Id -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
