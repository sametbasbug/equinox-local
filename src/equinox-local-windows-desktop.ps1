param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('AppList','AppLaunch','AppQuit','AppRelaunch','AppFocus','WindowFocus','WindowClose','WindowMinimize','WindowRestore','WindowMaximize','WindowMove','WindowResize','WindowSetBounds')]
  [string]$Mode,
  [string]$Name = '',
  [int]$TargetPid = 0,
  [string]$Hwnd = '',
  [switch]$Force,
  [int]$X = 0,
  [int]$Y = 0,
  [int]$Width = 0,
  [int]$Height = 0
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class EquinoxDesktopWin32 {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool ShowWindowAsync(IntPtr hWnd, int command);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
}
"@

function Write-Json($Value) {
  [Console]::Out.Write(($Value | ConvertTo-Json -Compress -Depth 5))
}

function Format-Hwnd([IntPtr]$Value) { return ('0x{0:X}' -f $Value.ToInt64()) }

function Parse-Hwnd([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return [IntPtr]::Zero }
  $trimmed = $Value.Trim()
  try {
    if ($trimmed.StartsWith('0x', [StringComparison]::OrdinalIgnoreCase)) {
      return [IntPtr]([Convert]::ToInt64($trimmed.Substring(2), 16))
    }
    return [IntPtr]([Convert]::ToInt64($trimmed, 10))
  } catch { throw 'Window handle must be decimal or 0x-prefixed hexadecimal text.' }
}

function Get-TargetProcesses {
  if ($TargetPid -gt 0) {
    $process = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
    if ($null -eq $process) { throw 'No running app matched the requested PID.' }
    return @($process)
  }
  if ([string]::IsNullOrWhiteSpace($Name)) { throw 'App name or PID is required.' }
  $needle = [System.IO.Path]::GetFileNameWithoutExtension($Name.Trim())
  $all = @(Get-Process -ErrorAction SilentlyContinue)
  $exact = @($all | Where-Object { $_.ProcessName -ieq $needle })
  if ($exact.Count -gt 0) { return $exact }
  $title = @($all | Where-Object { -not [string]::IsNullOrWhiteSpace($_.MainWindowTitle) -and $_.MainWindowTitle.IndexOf($Name, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
  if ($title.Count -gt 0) { return $title }
  throw 'No running app matched the requested name or window title.'
}

function Resolve-WindowHandle {
  $explicit = Parse-Hwnd $Hwnd
  if ($explicit -ne [IntPtr]::Zero) {
    if (-not [EquinoxDesktopWin32]::IsWindow($explicit)) { throw 'The requested HWND is no longer a valid window.' }
    return $explicit
  }
  $handles = @()
  foreach ($process in @(Get-TargetProcesses)) {
    $process.Refresh()
    if ($process.MainWindowHandle -ne [IntPtr]::Zero -and [EquinoxDesktopWin32]::IsWindow($process.MainWindowHandle)) { $handles += $process.MainWindowHandle }
  }
  $handles = @($handles | Select-Object -Unique)
  if ($handles.Count -eq 0) { throw 'The requested app has no main window.' }
  if ($handles.Count -gt 1) { throw 'Multiple app windows match; use list_windows and retry with an exact HWND.' }
  return [IntPtr]$handles[0]
}

function Get-WindowBounds([IntPtr]$Handle) {
  $rect = New-Object EquinoxDesktopWin32+RECT
  if (-not [EquinoxDesktopWin32]::GetWindowRect($Handle, [ref]$rect)) { throw 'Could not read the target window bounds.' }
  return [pscustomobject]@{ x = $rect.Left; y = $rect.Top; width = $rect.Right - $rect.Left; height = $rect.Bottom - $rect.Top }
}

function Focus-Window([IntPtr]$Handle) {
  if ([EquinoxDesktopWin32]::IsIconic($Handle)) { [void][EquinoxDesktopWin32]::ShowWindowAsync($Handle, 9) }
  else { [void][EquinoxDesktopWin32]::ShowWindowAsync($Handle, 5) }
  [void][EquinoxDesktopWin32]::BringWindowToTop($Handle)
  $requested = [EquinoxDesktopWin32]::SetForegroundWindow($Handle)
  Start-Sleep -Milliseconds 120
  $foreground = [EquinoxDesktopWin32]::GetForegroundWindow()
  if (-not $requested -or $foreground -ne $Handle) { throw 'Windows refused to foreground the requested window.' }
  return [pscustomobject]@{ ok = $true; action = 'focus'; window = (Format-Hwnd $Handle) }
}

function Start-App([string]$FileName) {
  if ([string]::IsNullOrWhiteSpace($FileName)) { throw 'App launch requires name.' }
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $FileName
  $startInfo.UseShellExecute = $true
  $process = [System.Diagnostics.Process]::Start($startInfo)
  if ($null -eq $process) { throw 'Windows did not return a launched process.' }
  return [pscustomobject]@{ ok = $true; action = 'launch'; name = $FileName; pid = $process.Id }
}

function Quit-Apps([bool]$ForceKill) {
  $targets = @(Get-TargetProcesses)
  $requested = 0
  foreach ($process in $targets) {
    try {
      if ($ForceKill) { $process.Kill(); $requested++ }
      elseif ($process.CloseMainWindow()) { $requested++ }
    } catch { throw ('Failed to quit app PID {0}: {1}' -f $process.Id, $_.Exception.Message) }
  }
  $stillRunning = @($targets | ForEach-Object { $_.Id })
  for ($attempt = 0; $attempt -lt 20 -and $stillRunning.Count -gt 0; $attempt++) {
    Start-Sleep -Milliseconds 100
    $remaining = @()
    foreach ($process in $targets) {
      try { $process.Refresh(); if (-not $process.HasExited) { $remaining += $process.Id } } catch {}
    }
    $stillRunning = $remaining
  }
  return [pscustomobject]@{ ok = $true; action = 'quit'; force = $ForceKill; requested = $requested; matched = $targets.Count; stillRunning = $stillRunning }
}

switch ($Mode) {
  'AppList' {
    $items = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Sort-Object ProcessName, Id | ForEach-Object {
      [pscustomobject]@{ name = $_.ProcessName; pid = $_.Id; title = $_.MainWindowTitle; window = (Format-Hwnd $_.MainWindowHandle) }
    })
    Write-Json ([pscustomobject]@{ apps = $items })
  }
  'AppLaunch' { Write-Json (Start-App $Name) }
  'AppQuit' { Write-Json (Quit-Apps $Force.IsPresent) }
  'AppRelaunch' {
    try { $quit = Quit-Apps $Force.IsPresent; if (@($quit.stillRunning).Count -gt 0) { throw 'App relaunch refused because the existing process did not exit.' } } catch { if ($_.Exception.Message -notmatch '^No running app matched') { throw } }
    $launched = Start-App $Name
    Write-Json ([pscustomobject]@{ ok = $true; action = 'relaunch'; name = $Name; pid = $launched.pid })
  }
  'AppFocus' { Write-Json (Focus-Window (Resolve-WindowHandle)) }
  'WindowFocus' { Write-Json (Focus-Window (Resolve-WindowHandle)) }
  'WindowClose' {
    $handle = Resolve-WindowHandle
    if (-not [EquinoxDesktopWin32]::PostMessage($handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)) { throw 'Could not post WM_CLOSE to the target window.' }
    Start-Sleep -Milliseconds 150
    Write-Json ([pscustomobject]@{ ok = $true; action = 'close'; window = (Format-Hwnd $handle); closed = (-not [EquinoxDesktopWin32]::IsWindow($handle)) })
  }
  'WindowMinimize' { $handle = Resolve-WindowHandle; [void][EquinoxDesktopWin32]::ShowWindowAsync($handle, 6); Start-Sleep -Milliseconds 100; Write-Json ([pscustomobject]@{ ok = $true; action = 'minimize'; window = (Format-Hwnd $handle); minimized = [EquinoxDesktopWin32]::IsIconic($handle) }) }
  'WindowRestore' { $handle = Resolve-WindowHandle; [void][EquinoxDesktopWin32]::ShowWindowAsync($handle, 9); Start-Sleep -Milliseconds 100; Write-Json ([pscustomobject]@{ ok = $true; action = 'restore'; window = (Format-Hwnd $handle); minimized = [EquinoxDesktopWin32]::IsIconic($handle); maximized = [EquinoxDesktopWin32]::IsZoomed($handle) }) }
  'WindowMaximize' { $handle = Resolve-WindowHandle; [void][EquinoxDesktopWin32]::ShowWindowAsync($handle, 3); Start-Sleep -Milliseconds 100; Write-Json ([pscustomobject]@{ ok = $true; action = 'maximize'; window = (Format-Hwnd $handle); maximized = [EquinoxDesktopWin32]::IsZoomed($handle) }) }
  'WindowMove' {
    $handle = Resolve-WindowHandle; $bounds = Get-WindowBounds $handle
    if (-not [EquinoxDesktopWin32]::SetWindowPos($handle, [IntPtr]::Zero, $X, $Y, $bounds.width, $bounds.height, 0x0015)) { throw 'Could not move the target window.' }
    Write-Json ([pscustomobject]@{ ok = $true; action = 'move'; window = (Format-Hwnd $handle); bounds = (Get-WindowBounds $handle) })
  }
  'WindowResize' {
    if ($Width -le 0 -or $Height -le 0) { throw 'Window resize requires positive width and height.' }
    $handle = Resolve-WindowHandle; $bounds = Get-WindowBounds $handle
    if (-not [EquinoxDesktopWin32]::SetWindowPos($handle, [IntPtr]::Zero, $bounds.x, $bounds.y, $Width, $Height, 0x0014)) { throw 'Could not resize the target window.' }
    Write-Json ([pscustomobject]@{ ok = $true; action = 'resize'; window = (Format-Hwnd $handle); bounds = (Get-WindowBounds $handle) })
  }
  'WindowSetBounds' {
    if ($Width -le 0 -or $Height -le 0) { throw 'Window set-bounds requires positive width and height.' }
    $handle = Resolve-WindowHandle
    if (-not [EquinoxDesktopWin32]::SetWindowPos($handle, [IntPtr]::Zero, $X, $Y, $Width, $Height, 0x0014)) { throw 'Could not set the target window bounds.' }
    Write-Json ([pscustomobject]@{ ok = $true; action = 'set-bounds'; window = (Format-Hwnd $handle); bounds = (Get-WindowBounds $handle) })
  }
}
