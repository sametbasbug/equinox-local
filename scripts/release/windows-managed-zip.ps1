param(
  [Parameter(Mandatory=$true)][string]$SourceDirectory,
  [Parameter(Mandatory=$true)][string]$DestinationZip
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$source = [System.IO.Path]::GetFullPath($SourceDirectory)
if (-not [System.IO.Directory]::Exists($source)) { throw 'Managed ZIP source directory is missing.' }
$root = [System.IO.DirectoryInfo]::new($source)
if (($root.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Managed ZIP source root may not be a reparse point.' }
$destination = [System.IO.Path]::GetFullPath($DestinationZip)
if ([System.IO.File]::Exists($destination)) { throw 'Managed ZIP destination already exists.' }
[System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($destination)) | Out-Null
$fixedTime = [System.DateTimeOffset]::new(2000,1,1,0,0,0,[System.TimeSpan]::Zero)
$stream = [System.IO.File]::Open($destination,[System.IO.FileMode]::CreateNew,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None)
try {
  $zip = [System.IO.Compression.ZipArchive]::new($stream,[System.IO.Compression.ZipArchiveMode]::Create,$false,[System.Text.Encoding]::UTF8)
  try {
    $entry = $zip.CreateEntry('release/',[System.IO.Compression.CompressionLevel]::NoCompression)
    $entry.LastWriteTime = $fixedTime; $entry.ExternalAttributes = 0
    $items = Get-ChildItem -LiteralPath $source -Recurse -Force | Sort-Object { $_.FullName.Substring($source.Length).Replace('\\','/') }
    foreach ($item in $items) {
      if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Managed ZIP source contains a reparse point: $($item.FullName)" }
      $relative = $item.FullName.Substring($source.Length).TrimStart('\\','/').Replace('\\','/')
      if ([string]::IsNullOrWhiteSpace($relative)) { throw 'Managed ZIP source contains an invalid relative path.' }
      $name = 'release/' + $relative
      if ($item.PSIsContainer) {
        $entry = $zip.CreateEntry($name.TrimEnd('/') + '/',[System.IO.Compression.CompressionLevel]::NoCompression)
        $entry.LastWriteTime = $fixedTime; $entry.ExternalAttributes = 0
      } else {
        $entry = $zip.CreateEntry($name,[System.IO.Compression.CompressionLevel]::Fastest)
        $entry.LastWriteTime = $fixedTime; $entry.ExternalAttributes = 0
        $input = [System.IO.File]::Open($item.FullName,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::Read)
        try {
          $output = $entry.Open()
          try { $input.CopyTo($output) } finally { $output.Dispose() }
        } finally { $input.Dispose() }
      }
    }
  } finally { $zip.Dispose() }
} catch {
  $stream.Dispose()
  Remove-Item -LiteralPath $destination -Force -ErrorAction SilentlyContinue
  throw
} finally {
  if ($null -ne $stream) { $stream.Dispose() }
}
