param(
  [Parameter(Mandatory = $true)][string]$ShellPath,
  [Parameter(Mandatory = $true)][string]$NodePath
)

$ErrorActionPreference = 'Stop'
$port = 24891
$server = $null
$shell = $null
$root = Join-Path $env:RUNNER_TEMP ('equinox-cc-startup-' + [guid]::NewGuid().ToString('N'))
try {
  if (-not (Test-Path -LiteralPath $ShellPath -PathType Leaf)) { throw 'Compiled WPF shell missing.' }
  if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw 'Node test server missing.' }
  if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) {
    throw 'Control Center port is already in use before cold-start smoke.'
  }
  New-Item -ItemType Directory -Path $root -Force | Out-Null
  $serverFile = Join-Path $root 'server.cjs'
  [System.IO.File]::WriteAllText($serverFile, @'
const http = require('node:http');
http.createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end('<!doctype html><html><head><title>Equinox loopback readiness smoke</title></head><body><h1>Control Center ready</h1></body></html>');
}).listen(24891, '127.0.0.1');
'@, (New-Object System.Text.UTF8Encoding($false)))

  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $shell = Start-Process -FilePath $ShellPath -PassThru
  $element = $null
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 250
    $shell.Refresh()
    if ($shell.HasExited) { throw 'WPF shell exited while loopback server was unavailable.' }
    if ($shell.MainWindowHandle -ne [IntPtr]::Zero) {
      $element = [System.Windows.Automation.AutomationElement]::FromHandle($shell.MainWindowHandle)
      if ($null -ne $element) { break }
    }
  }
  if ($null -eq $element) { throw 'WPF Control Center window did not appear.' }

  $loading = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty, 'Starting Control Center…')
  $initiallyLoading = $false
  for ($i = 0; $i -lt 40; $i++) {
    if ($element.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $loading)) {
      $initiallyLoading = $true
      break
    }
    Start-Sleep -Milliseconds 250
  }
  if (-not $initiallyLoading) { throw 'Native loading screen was absent before local server startup.' }
  Write-Output 'EQUINOX_CC_COLD_START_LOADING_PASS'

  # Start the test HTTP server *after* WPF is already waiting for it.
  $server = Start-Process -FilePath $NodePath -ArgumentList ('"' + $serverFile + '"') -PassThru -WindowStyle Hidden
  $ready = $false
  for ($i = 0; $i -lt 80; $i++) {
    Start-Sleep -Milliseconds 250
    $shell.Refresh()
    if ($shell.HasExited) { throw 'WPF shell exited instead of reconnecting to loopback.' }
    if (-not (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)) { continue }
    if (-not $element.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $loading)) {
      $ready = $true
      break
    }
  }
  if (-not $ready) { throw 'Native loading screen did not disappear after loopback became ready.' }
  Write-Output 'EQUINOX_CC_COLD_START_AUTO_RECONNECT_PASS'
} finally {
  if ($shell -and -not $shell.HasExited) { Stop-Process -Id $shell.Id -Force -ErrorAction SilentlyContinue }
  if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue }
}
