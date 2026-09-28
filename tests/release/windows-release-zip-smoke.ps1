$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$Helper = Join-Path $RepoRoot 'src\equinox-local-windows-release-zip.ps1'
if (-not (Test-Path -LiteralPath $Helper -PathType Leaf)) { throw 'Windows release ZIP helper is missing.' }
$Root = Join-Path ([System.IO.Path]::GetTempPath()) ('equinox-windows-release-zip-smoke-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Root | Out-Null

function New-TestZip {
  param(
    [Parameter(Mandatory=$true)][string]$Path,
    [Parameter(Mandatory=$true)][object[]]$Entries
  )
  $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  try {
    $zip = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Create, $true)
    try {
      foreach ($item in $Entries) {
        $entry = $zip.CreateEntry([string]$item.Name, [System.IO.Compression.CompressionLevel]::NoCompression)
        if ($null -ne $item.ExternalAttributes) { $entry.ExternalAttributes = [int]$item.ExternalAttributes }
        if ($null -ne $item.Content) {
          $writer = New-Object System.IO.StreamWriter($entry.Open(), (New-Object System.Text.UTF8Encoding($false)))
          try { $writer.Write([string]$item.Content) } finally { $writer.Dispose() }
        }
      }
    } finally { $zip.Dispose() }
  } finally { $stream.Dispose() }
}

function Invoke-ReleaseZip {
  param(
    [Parameter(Mandatory=$true)][ValidateSet('Inspect','Extract')][string]$Mode,
    [Parameter(Mandatory=$true)][string]$Archive,
    [string]$Destination,
    [Parameter(Mandatory=$true)][bool]$ShouldPass,
    [string]$Label
  )
  $args = @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$Helper,'-Mode',$Mode,'-ArchivePath',$Archive)
  if ($Mode -eq 'Extract') { $args += @('-DestinationPath',$Destination) }
  $output = & powershell.exe @args 2>&1
  $exit = $LASTEXITCODE
  if ($ShouldPass -and $exit -ne 0) { throw "$Label unexpectedly failed: $($output -join ' ')" }
  if (-not $ShouldPass -and $exit -eq 0) { throw "$Label unexpectedly passed." }
  return @($output)
}

function Assert-RejectedEntry {
  param([Parameter(Mandatory=$true)][string]$Label,[Parameter(Mandatory=$true)][object[]]$Entries)
  $archive = Join-Path $Root ($Label + '.zip')
  New-TestZip -Path $archive -Entries $Entries
  Invoke-ReleaseZip -Mode Inspect -Archive $archive -ShouldPass $false -Label $Label | Out-Null
}

function Patch-OversizedCentralDirectoryLength {
  param([Parameter(Mandatory=$true)][string]$Path)
  [byte[]]$bytes = [System.IO.File]::ReadAllBytes($Path)
  $offset = -1
  for ($i = 0; $i -le $bytes.Length - 4; $i++) {
    if ($bytes[$i] -eq 0x50 -and $bytes[$i + 1] -eq 0x4b -and $bytes[$i + 2] -eq 0x01 -and $bytes[$i + 3] -eq 0x02) { $offset = $i; break }
  }
  if ($offset -lt 0) { throw 'Synthetic ZIP central-directory header was not found.' }
  [byte[]]$oversized = [System.BitConverter]::GetBytes([uint32]2147483649)
  [System.Array]::Copy($oversized, 0, $bytes, $offset + 24, 4)
  [System.IO.File]::WriteAllBytes($Path, $bytes)
}

try {
  $valid = Join-Path $Root 'valid.zip'
  New-TestZip -Path $valid -Entries @(
    @{ Name='release/'; Content=$null; ExternalAttributes=$null },
    @{ Name='release/server.js'; Content='server'; ExternalAttributes=$null },
    @{ Name='release/runtime/node/bin/node.exe'; Content='node'; ExternalAttributes=$null }
  )
  $inspect = (Invoke-ReleaseZip -Mode Inspect -Archive $valid -ShouldPass $true -Label 'valid inspect') -join "`n"
  $summary = $inspect | ConvertFrom-Json
  if ($summary.entryCount -ne 3 -or $summary.extractedBytes -ne 10) { throw 'Valid ZIP summary is incorrect.' }
  $destination = Join-Path $Root 'valid-extracted'
  Invoke-ReleaseZip -Mode Extract -Archive $valid -Destination $destination -ShouldPass $true -Label 'valid extract' | Out-Null
  if ((Get-Content -LiteralPath (Join-Path $destination 'release\server.js') -Raw) -ne 'server') { throw 'Valid ZIP server.js content drifted.' }
  if ((Get-Content -LiteralPath (Join-Path $destination 'release\runtime\node\bin\node.exe') -Raw) -ne 'node') { throw 'Valid ZIP node.exe content drifted.' }

  Assert-RejectedEntry -Label 'traversal' -Entries @(@{ Name='release/../escape.txt'; Content='x'; ExternalAttributes=$null })
  Assert-RejectedEntry -Label 'root-escape' -Entries @(@{ Name='outside.txt'; Content='x'; ExternalAttributes=$null })
  Assert-RejectedEntry -Label 'reserved-device' -Entries @(@{ Name='release/CON.txt'; Content='x'; ExternalAttributes=$null })
  Assert-RejectedEntry -Label 'trailing-dot' -Entries @(@{ Name='release/bad./file.txt'; Content='x'; ExternalAttributes=$null })
  Assert-RejectedEntry -Label 'trailing-space' -Entries @(@{ Name='release/bad /file.txt'; Content='x'; ExternalAttributes=$null })
  Assert-RejectedEntry -Label 'case-collision' -Entries @(
    @{ Name='release/a.txt'; Content='a'; ExternalAttributes=$null },
    @{ Name='release/A.txt'; Content='b'; ExternalAttributes=$null }
  )

  $symlinkAttributes = [System.BitConverter]::ToInt32([System.BitConverter]::GetBytes([uint32]0xA1FF0000), 0)
  Assert-RejectedEntry -Label 'symlink-metadata' -Entries @(@{ Name='release/link'; Content='target'; ExternalAttributes=$symlinkAttributes })
  Assert-RejectedEntry -Label 'reparse-metadata' -Entries @(@{ Name='release/reparse'; Content='x'; ExternalAttributes=0x400 })

  $oversized = Join-Path $Root 'oversized.zip'
  New-TestZip -Path $oversized -Entries @(@{ Name='release/huge.bin'; Content='x'; ExternalAttributes=$null })
  Patch-OversizedCentralDirectoryLength -Path $oversized
  Invoke-ReleaseZip -Mode Inspect -Archive $oversized -ShouldPass $false -Label 'oversized central directory' | Out-Null

  Write-Host 'Windows release ZIP acceptance passed: valid extract + traversal/root/reserved/ambiguous/collision/symlink/reparse/size guards.'
} finally {
  Remove-Item -LiteralPath $Root -Recurse -Force -ErrorAction SilentlyContinue
}
