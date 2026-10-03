param(
  [Parameter(Mandatory = $true)][ValidateSet('Get','Set','Clear')][string]$Mode,
  [string]$InputPath = ''
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
$MaxClipboardBytes = 262144
function Invoke-ClipboardOperation {
  param([Parameter(Mandatory = $true)][scriptblock]$Operation)
  $lastError = $null
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    try { return & $Operation } catch { $lastError = $_.Exception; if ($attempt -lt 19) { Start-Sleep -Milliseconds 50 } }
  }
  throw $lastError
}
switch ($Mode) {
  'Get' {
    $text = Invoke-ClipboardOperation {
      if ([System.Windows.Forms.Clipboard]::ContainsText([System.Windows.Forms.TextDataFormat]::UnicodeText)) { [System.Windows.Forms.Clipboard]::GetText([System.Windows.Forms.TextDataFormat]::UnicodeText) } else { '' }
    }
    if ([System.Text.Encoding]::UTF8.GetByteCount($text) -gt $MaxClipboardBytes) { throw 'Clipboard text exceeds the bounded output limit.' }
    [Console]::Out.Write($text)
  }
  'Set' {
    if ([string]::IsNullOrWhiteSpace($InputPath)) { throw 'Set mode requires InputPath.' }
    $resolved = [System.IO.Path]::GetFullPath($InputPath)
    if (-not [System.IO.File]::Exists($resolved)) { throw 'Clipboard input file does not exist.' }
    if ((New-Object System.IO.FileInfo($resolved)).Length -gt $MaxClipboardBytes) { throw 'Clipboard input file exceeds the bounded input limit.' }
    $text = [System.IO.File]::ReadAllText($resolved, (New-Object System.Text.UTF8Encoding($false, $true)))
    if ([System.Text.Encoding]::UTF8.GetByteCount($text) -gt $MaxClipboardBytes) { throw 'Clipboard text exceeds the bounded input limit.' }
    Invoke-ClipboardOperation { if ($text.Length -eq 0) { [System.Windows.Forms.Clipboard]::Clear() } else { [System.Windows.Forms.Clipboard]::SetText($text, [System.Windows.Forms.TextDataFormat]::UnicodeText) } } | Out-Null
  }
  'Clear' { Invoke-ClipboardOperation { [System.Windows.Forms.Clipboard]::Clear() } | Out-Null }
}
