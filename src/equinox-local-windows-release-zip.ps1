param(
  [Parameter(Mandatory=$true)][ValidateSet('Inspect','Extract')][string]$Mode,
  [Parameter(Mandatory=$true)][string]$ArchivePath,
  [string]$DestinationPath,
  [string]$ExpectedRoot = 'release'
)
$ErrorActionPreference = 'Stop'
$HostedZipTiming = ($env:EQUINOX_HOSTED_PHASE_TIMING -ceq '1')
$HostedZipClock = [Diagnostics.Stopwatch]::StartNew()
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$MaxEntries = 20000
[long]$MaxBytes = 2147483648
$MaxName = 500
$Reserved = '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$'

# PowerShell 5.1 runs these .NET ZipArchive checks directly, without compiling
# custom C# source on every installed-machine ZIP extraction.
function Assert-SafeSegment([string]$Segment) {
  if (-not $Segment -or $Segment -ceq '.' -or $Segment -ceq '..') { throw 'ZIP contains an unsafe path segment.' }
  if ($Segment.EndsWith(' ') -or $Segment.EndsWith('.')) { throw 'ZIP contains a Windows-ambiguous path segment.' }
  if ([Regex]::IsMatch($Segment, $Reserved, ([Text.RegularExpressions.RegexOptions]::IgnoreCase -bor [Text.RegularExpressions.RegexOptions]::CultureInvariant))) {
    throw 'ZIP contains a reserved Windows device path.'
  }
  foreach ($char in $Segment.ToCharArray()) {
    if ([int]$char -lt 32 -or '<>:"\|?*'.Contains([string]$char)) { throw 'ZIP contains an unsupported Windows path character.' }
  }
}

function Get-CheckedEntries([IO.Compression.ZipArchive]$Zip, [string]$Root) {
  if (-not $Root -or $Root.Contains('/') -or $Root.Contains('\')) { throw 'ZIP expected root is invalid.' }
  Assert-SafeSegment $Root
  $items = [Collections.Generic.List[object]]::new()
  $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  [long]$bytes = 0
  foreach ($entry in $Zip.Entries) {
    if ($items.Count -ge $MaxEntries) { throw 'ZIP entry count exceeds the allowed bound.' }
    [string]$raw = $entry.FullName
    if (-not $raw -or $raw.Length -gt $MaxName -or $raw.IndexOf([char]0) -ge 0 -or $raw.Contains('\')) {
      throw 'ZIP contains an invalid entry name.'
    }
    $directory = $raw.EndsWith('/', [StringComparison]::Ordinal)
    $name = if ($directory) { $raw.Substring(0, $raw.Length - 1) } else { $raw }
    if (-not $name -or $name.StartsWith('/', [StringComparison]::Ordinal)) { throw 'ZIP entries must be relative paths.' }
    [string[]]$parts = $name.Split([char]'/')
    if ($parts.Length -eq 0 -or -not [string]::Equals($parts[0], $Root, [StringComparison]::Ordinal)) {
      throw 'ZIP escaped the expected archive root.'
    }
    foreach ($part in $parts) { Assert-SafeSegment $part }
    $key = [string]::Join('/', $parts)
    if (-not $seen.Add($key)) { throw 'ZIP contains a case-insensitive duplicate path.' }
    $external = [int]$entry.ExternalAttributes
    $unixType = ($external -shr 16) -band 0xF000
    $dos = $external -band 0xFFFF
    if (($dos -band 0x400) -ne 0 -or $unixType -eq 0xA000) { throw 'ZIP contains a symlink or reparse-point entry.' }
    if ($directory) {
      if ($entry.Length -ne 0 -or ($unixType -ne 0 -and $unixType -ne 0x4000)) { throw 'ZIP directory metadata is invalid.' }
    } else {
      if ($unixType -ne 0 -and $unixType -ne 0x8000) { throw 'ZIP contains an unsupported filesystem entry type.' }
      if ($entry.Length -lt 0 -or $entry.Length -gt ($MaxBytes - $bytes)) { throw 'ZIP exceeds the extracted size limit.' }
      $bytes += $entry.Length
    }
    $items.Add([pscustomobject]@{ Entry=$entry; Name=$key; Directory=$directory })
  }
  if ($items.Count -eq 0) { throw 'ZIP is empty.' }
  return @{ Items=$items; Bytes=$bytes }
}

function Assert-NormalDirectory([string]$Directory) {
  $attributes = [IO.File]::GetAttributes($Directory)
  if (($attributes -band [IO.FileAttributes]::Directory) -eq 0 -or ($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Extraction directory is not a normal directory.'
  }
}

function Assert-ExtractedTree([string]$Directory, [hashtable]$Counters) {
  Assert-NormalDirectory $Directory
  foreach ($entry in [IO.Directory]::GetFileSystemEntries($Directory)) {
    $Counters.Count += 1
    if ($Counters.Count -gt $MaxEntries) { throw 'Extracted ZIP contains too many entries.' }
    $attributes = [IO.File]::GetAttributes($entry)
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Extracted ZIP contains a reparse point.' }
    if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) {
      Assert-ExtractedTree $entry $Counters
    } else {
      [long]$length = ([IO.FileInfo]::new($entry)).Length
      if ($length -gt ($MaxBytes - $Counters.Bytes)) { throw 'Extracted ZIP exceeds the size limit.' }
      $Counters.Bytes += $length
    }
  }
}

$archive = [IO.Path]::GetFullPath($ArchivePath)
if (-not [IO.File]::Exists($archive)) { throw 'Windows release ZIP is missing.' }
$stream = [IO.File]::Open($archive, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try {
  $zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Read, $false)
  try {
    $checked = Get-CheckedEntries $zip $ExpectedRoot
    if ($Mode -eq 'Extract') {
      if ([string]::IsNullOrWhiteSpace($DestinationPath)) { throw 'DestinationPath is required for extraction.' }
      $destination = [IO.Path]::GetFullPath($DestinationPath)
      if ([IO.Directory]::Exists($destination) -or [IO.File]::Exists($destination)) { throw 'Extraction destination must not already exist.' }
      [IO.Directory]::CreateDirectory($destination) | Out-Null
      Assert-NormalDirectory $destination
      try {
        # The full central-directory allowlist above runs before any file
        # writes. ExtractToDirectory is .NET's native bulk extractor, avoiding
        # the PowerShell per-entry invocation overhead. A newly created owned
        # destination plus post-extract reparse/size audit remain required.
        # Use the SAME preflight-validated, open ZipArchive handle for bulk
        # extraction; never reopen a potentially swapped archive on disk.
        [IO.Compression.ZipFileExtensions]::ExtractToDirectory($zip, $destination)
        $counters = @{ Count=0; Bytes=[long]0 }
        Assert-ExtractedTree $destination $counters
        if ($counters.Bytes -ne $checked.Bytes) { throw 'Extracted ZIP byte count drifted from central-directory metadata.' }
      } catch {
        try { [IO.Directory]::Delete($destination, $true) } catch {}
        throw
      }
      if ($HostedZipTiming) {
        Write-Output ("Hosted ZIP phase: extract; durationSeconds={0:F1}" -f $HostedZipClock.Elapsed.TotalSeconds)
      }
    }
    Write-Output ('{"entryCount":' + $checked.Items.Count + ',"extractedBytes":' + $checked.Bytes + '}')
  } finally { $zip.Dispose() }
} finally { $stream.Dispose() }
