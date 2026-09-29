$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$InstallerTemplate = Join-Path $Root 'scripts\install-equinox-local.ps1'
$HelperSource = Join-Path $Root 'src\equinox-local-windows-release-zip.ps1'
$Work = Join-Path ([IO.Path]::GetTempPath()) ('Equinox Bootstrap Türk User ' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($Work) | Out-Null

function Assert-True([bool]$Value, [string]$Message) { if (-not $Value) { throw $Message } }
function Expect-Failure([scriptblock]$Action, [string]$Pattern) {
  try { & $Action; throw 'Expected failure did not occur.' }
  catch { if ($_.Exception.Message -notmatch $Pattern) { throw } }
}

try {
  $helperBytes = (Get-Item -LiteralPath $HelperSource).Length
  $helperSha = (Get-FileHash -LiteralPath $HelperSource -Algorithm SHA256).Hash.ToLowerInvariant()
  $materialized = (Get-Content -LiteralPath $InstallerTemplate -Raw)
  $materialized = $materialized.Replace('__EQUINOX_ZIP_HELPER_SHA256__', $helperSha).Replace('__EQUINOX_ZIP_HELPER_BYTES__', [string]$helperBytes)
  Assert-True (-not $materialized.Contains('__EQUINOX_ZIP_HELPER_')) 'Installer helper pins were not materialized.'
  $Installer = Join-Path $Work 'install-equinox-local.materialized.ps1'
  [IO.File]::WriteAllText($Installer, $materialized, (New-Object Text.UTF8Encoding($false)))
  . $Installer

  $ArchiveRoot = Join-Path $Work 'archive source'
  $Release = Join-Path $ArchiveRoot 'release'
  $NodeDir = Join-Path $Release 'runtime\node\bin'
  [IO.Directory]::CreateDirectory($NodeDir) | Out-Null
  Copy-Item -LiteralPath (Get-Command node.exe).Source -Destination (Join-Path $NodeDir 'node.exe')
  $Stub = @'
const fs = require("node:fs");
const path = require("node:path");
const index = process.argv.indexOf("--staged-release");
if (index < 0 || !process.argv[index + 1]) process.exit(12);
const root = process.env.LOCALAPPDATA;
if (!root) process.exit(13);
fs.mkdirSync(root, { recursive: true });
const marker = path.join(root, "bootstrap-smoke.json");
let count = 0;
try { count = JSON.parse(fs.readFileSync(marker, "utf8")).count || 0; } catch {}
fs.writeFileSync(marker, JSON.stringify({ count: count + 1, release: process.argv[index + 1], leaked: Boolean(process.env.OPENAI_API_KEY) }));
process.stdout.write(JSON.stringify({ ok: true, count: count + 1 }));
'@
  [IO.File]::WriteAllText((Join-Path $Release 'equinox-local-first-install.js'), $Stub, (New-Object Text.UTF8Encoding($false)))
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $Artifact = Join-Path $Work 'equinox-local-9.8.7-win32-x64.zip'
  $zipStream = New-Object IO.FileStream($Artifact, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  $zip = New-Object IO.Compression.ZipArchive($zipStream, [IO.Compression.ZipArchiveMode]::Create, $false)
  try {
    foreach ($spec in @(
      @('release/runtime/node/bin/node.exe', (Join-Path $NodeDir 'node.exe')),
      @('release/equinox-local-first-install.js', (Join-Path $Release 'equinox-local-first-install.js'))
    )) {
      $entry = $zip.CreateEntry($spec[0], [IO.Compression.CompressionLevel]::Optimal)
      $entryStream = $entry.Open()
      $inputStream = [IO.File]::OpenRead($spec[1])
      try { $inputStream.CopyTo($entryStream) } finally { $inputStream.Dispose(); $entryStream.Dispose() }
    }
  } finally { $zip.Dispose(); $zipStream.Dispose() }
  $artifactBytes = (Get-Item -LiteralPath $Artifact).Length
  $artifactSha = (Get-FileHash -LiteralPath $Artifact -Algorithm SHA256).Hash.ToLowerInvariant()
  $Manifest = Join-Path $Work 'bootstrap-win32-x64.txt'
  $manifestText = @(
    'schemaVersion=1', 'channel=stable', 'target=win32-x64', 'version=9.8.7',
    'artifactUrl=https://local.sametbasbug.dev/downloads/updates/equinox-local-9.8.7-win32-x64.zip',
    "artifactSha256=$artifactSha", "artifactBytes=$artifactBytes", ''
  ) -join "`n"
  [IO.File]::WriteAllText($Manifest, $manifestText, (New-Object Text.UTF8Encoding($false)))

  $badManifest = Join-Path $Work 'bad-bootstrap.txt'
  [IO.File]::WriteAllText($badManifest, $manifestText.Replace('local.sametbasbug.dev', 'evil.example'), (New-Object Text.UTF8Encoding($false)))
  Expect-Failure { Read-BootstrapManifest $badManifest | Out-Null } 'artifact URL escaped'

  $OriginalLocalAppData = $env:LOCALAPPDATA
  $OriginalArch = $env:PROCESSOR_ARCHITECTURE
  $OriginalOpenAi = $env:OPENAI_API_KEY
  $LocalState = Join-Path $Work 'Türk User\Local App Data'
  [IO.Directory]::CreateDirectory($LocalState) | Out-Null
  $env:LOCALAPPDATA = $LocalState
  $env:PROCESSOR_ARCHITECTURE = 'AMD64'
  $env:OPENAI_API_KEY = 'must-not-leak'

  function Save-BoundedHttpsFile([string]$Url, [string]$Destination, [long]$MaxBytes) {
    if ($Url.EndsWith('/bootstrap-win32-x64.txt')) { Copy-Item -LiteralPath $script:Manifest -Destination $Destination; return }
    if ($Url.EndsWith('/equinox-local-windows-release-zip.ps1')) { Copy-Item -LiteralPath $script:HelperSource -Destination $Destination; return }
    if ($Url.EndsWith('/equinox-local-9.8.7-win32-x64.zip')) { Copy-Item -LiteralPath $script:Artifact -Destination $Destination; return }
    throw "unexpected bootstrap URL: $Url"
  }

  Invoke-EquinoxLocalInstall | Out-Null
  Invoke-EquinoxLocalInstall | Out-Null
  $marker = Get-Content -LiteralPath (Join-Path $LocalState 'bootstrap-smoke.json') -Raw | ConvertFrom-Json
  Assert-True ($marker.count -eq 2) 'Windows bootstrap retry did not reach the bundled first-install helper twice.'
  Assert-True (-not $marker.leaked) 'Windows bootstrap leaked provider credentials into bundled Node.'
  Assert-True ($marker.release -match 'Equinox Bootstrap Türk User') 'Windows bootstrap lost the spaced/non-ASCII staging path.'

  $corrupt = $manifestText.Replace("artifactSha256=$artifactSha", ('artifactSha256=' + ('0' * 64)))
  [IO.File]::WriteAllText($Manifest, $corrupt, (New-Object Text.UTF8Encoding($false)))
  Expect-Failure { Invoke-EquinoxLocalInstall | Out-Null } 'SHA-256 verification failed'

  Write-Output 'Windows PowerShell 5.1 bootstrap acceptance passed: fixed manifest + pinned helper + secure ZIP + clean Node + retry + corruption guards.'
} finally {
  if (Get-Variable OriginalLocalAppData -ErrorAction SilentlyContinue) { $env:LOCALAPPDATA = $OriginalLocalAppData }
  if (Get-Variable OriginalArch -ErrorAction SilentlyContinue) { $env:PROCESSOR_ARCHITECTURE = $OriginalArch }
  if (Get-Variable OriginalOpenAi -ErrorAction SilentlyContinue) { $env:OPENAI_API_KEY = $OriginalOpenAi }
  Remove-Item Function:\Save-BoundedHttpsFile -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue
}
