param(
  [Parameter(Mandatory = $true)]
  [string]$WinappPath,
  [Parameter(Mandatory = $true)]
  [string]$FixturePath,
  [Parameter(Mandatory = $true)]
  [string]$ClipboardHelperPath,
  [Parameter(Mandatory = $true)]
  [string]$DesktopHelperPath
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
$clipboardHelper = [System.IO.Path]::GetFullPath($ClipboardHelperPath)
if (-not (Test-Path -LiteralPath $clipboardHelper -PathType Leaf)) {
  throw "Packaged clipboard helper not found: $clipboardHelper"
}
$desktopHelper = [System.IO.Path]::GetFullPath($DesktopHelperPath)
if (-not (Test-Path -LiteralPath $desktopHelper -PathType Leaf)) {
  throw "Packaged desktop lifecycle helper not found: $desktopHelper"
}
function Invoke-DesktopHelperCaptured {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $output = (& powershell.exe -NoLogo -NoProfile -NonInteractive -Sta -ExecutionPolicy Bypass -File $desktopHelper @Arguments 2>&1 | Out-String).Trim()
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($exitCode -ne 0) { throw "Windows desktop lifecycle helper failed: $output" }
  try { return $output | ConvertFrom-Json } catch { throw "Windows desktop lifecycle helper returned invalid JSON: $output" }
}
$fixture = $null
$associationProcess = $null
$associationToken = ([guid]::NewGuid().ToString('N'))
$associationExtension = '.equinoxopen' + $associationToken
$associationProgId = 'EquinoxLocal.WinappOpenSmoke.' + $associationToken
$classesRoot = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Classes', $true)
if ($null -eq $classesRoot) { throw 'Could not open HKCU Software\Classes for the controlled app-open smoke.' }
try {
  if ($null -ne $classesRoot.OpenSubKey($associationExtension) -or $null -ne $classesRoot.OpenSubKey($associationProgId)) { throw 'Controlled app-open association unexpectedly already exists.' }
  $extensionKey = $classesRoot.CreateSubKey($associationExtension)
  try { $extensionKey.SetValue('', $associationProgId, [Microsoft.Win32.RegistryValueKind]::String) } finally { $extensionKey.Dispose() }
  $commandKey = $classesRoot.CreateSubKey(($associationProgId + '\shell\open\command'))
  try { $commandKey.SetValue('', ('"{0}" "%1"' -f $fixtureExecutable), [Microsoft.Win32.RegistryValueKind]::String) } finally { $commandKey.Dispose() }
  $associationFile = Join-Path $root ('Equinox Association Open' + $associationExtension)
  Set-Content -LiteralPath $associationFile -Value 'Equinox shell association smoke' -Encoding UTF8
  $opened = Invoke-DesktopHelperCaptured -Arguments @('-Mode', 'AppOpen', '-Name', $associationFile)
  if (-not $opened.ok -or $opened.action -ne 'open' -or [int]$opened.pid -le 0) { throw 'Windows desktop app open did not launch the controlled file association.' }
  $associationProcess = Get-Process -Id ([int]$opened.pid) -ErrorAction Stop
  if ($associationProcess.ProcessName -ne 'EquinoxLocal.WinappSmokeFixture') { throw 'Windows desktop app open launched an unexpected process.' }
  Write-Output ("WINDOWS_DESKTOP_APP_OPEN_SMOKE_PASS architecture={0}" -f $architecture)
} finally {
  if ($null -ne $associationProcess -and -not $associationProcess.HasExited) { Stop-Process -Id $associationProcess.Id -Force -ErrorAction SilentlyContinue }
  try { $classesRoot.DeleteSubKeyTree($associationExtension, $false) } catch {}
  try { $classesRoot.DeleteSubKeyTree($associationProgId, $false) } catch {}
  $classesRoot.Dispose()
}
$launch = Invoke-DesktopHelperCaptured -Arguments @('-Mode', 'AppLaunch', '-Name', $fixtureExecutable)
if ([int]$launch.pid -le 0) { throw 'Windows desktop lifecycle helper did not return a launched fixture PID.' }
$fixture = Get-Process -Id ([int]$launch.pid) -ErrorAction Stop
try {
  function Invoke-WinappCaptured {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    $previousErrorActionPreference = $ErrorActionPreference
    try {
      # Windows PowerShell 5.1 promotes native stderr to NativeCommandError when the
      # script uses ErrorActionPreference=Stop. These probes intentionally need the
      # real winapp exit code/output so expected environment failures can be classified.
      $ErrorActionPreference = 'Continue'
      $output = (& $winapp @Arguments 2>&1 | Out-String).Trim()
      $exitCode = $LASTEXITCODE
      return [pscustomobject]@{ Output = $output; ExitCode = $exitCode }
    } finally {
      $ErrorActionPreference = $previousErrorActionPreference
    }
  }
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class EquinoxWinappSmokeForeground {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool ShowWindowAsync(IntPtr hWnd, int command);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr GetThreadDesktop(uint threadId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool GetUserObjectInformation(IntPtr handle, int index, System.Text.StringBuilder info, uint length, out uint needed);
    [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
    [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }
    [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION U; }
    [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint inputCount, INPUT[] inputs, int inputSize);
    public static uint SendAltPulse() {
        const uint INPUT_KEYBOARD = 1;
        const ushort VK_MENU = 0x12;
        const uint KEYEVENTF_KEYUP = 0x0002;
        var inputs = new INPUT[2];
        inputs[0].type = INPUT_KEYBOARD;
        inputs[0].U.ki.wVk = VK_MENU;
        inputs[1].type = INPUT_KEYBOARD;
        inputs[1].U.ki.wVk = VK_MENU;
        inputs[1].U.ki.dwFlags = KEYEVENTF_KEYUP;
        return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    }
    public static string GetDesktopName(uint threadId) {
        IntPtr desktop = GetThreadDesktop(threadId);
        if (desktop == IntPtr.Zero) return "<unavailable:" + Marshal.GetLastWin32Error() + ">";
        var buffer = new System.Text.StringBuilder(256);
        uint needed;
        if (!GetUserObjectInformation(desktop, 2, buffer, 512, out needed)) return "<unavailable:" + Marshal.GetLastWin32Error() + ">";
        return buffer.ToString();
    }
}
"@
  $script:controlledForegroundEvidence = $null
  function Test-ProtectedHostedForegroundCeiling {
    param([Parameter(Mandatory = $true)][string]$FocusOutput)
    $evidence = $script:controlledForegroundEvidence
    if ($architecture -ne 'Arm64' -or $null -eq $evidence) { return $false }
    if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') { return $false }
    if ($FocusOutput -notmatch '"code"\s*:\s*"foreground_not_target"') { return $false }
    return (
      -not $evidence.Success -and
      $evidence.TargetPid -eq $fixture.Id -and
      $evidence.TargetProcess -eq 'EquinoxLocal.WinappSmokeFixture' -and
      $evidence.ForegroundProcess -eq 'WWAHost' -and
      $evidence.CurrentProcess -eq 'powershell' -and
      $evidence.TargetSession -ge 0 -and
      $evidence.TargetSession -eq $evidence.ForegroundSession -and
      $evidence.TargetSession -eq $evidence.CurrentSession -and
      $evidence.TargetDesktop -eq 'Default' -and
      $evidence.CurrentDesktop -eq 'Default' -and
      $evidence.ForegroundDesktop -eq '<unavailable:5>' -and
      -not $evidence.AttachedTargetForeground -and
      $evidence.AttachError -eq 5 -and
      $evidence.ShowResult -and
      $evidence.BringResult -and
      -not $evidence.SetResult -and
      $evidence.AltInputCount -eq 2 -and
      $evidence.AltInputError -eq 0 -and
      -not $evidence.SetAfterAltResult -and
      $evidence.AfterPid -eq $evidence.ForegroundPid -and
      $evidence.AfterThread -eq $evidence.ForegroundThread -and
      $evidence.AfterHandle -eq $evidence.ForegroundHandle
    )
  }
  function Set-ControlledFixtureForeground {
    $fixture.Refresh()
    $target = $fixture.MainWindowHandle
    if ($target -eq [IntPtr]::Zero) { throw 'Controlled WinForms fixture has no main window handle for foreground recovery.' }
    $foreground = [EquinoxWinappSmokeForeground]::GetForegroundWindow()
    if ($foreground -eq [IntPtr]::Zero) {
      Write-Host 'WINDOWS_WINAPP_FOREGROUND_RECOVERY result=no_foreground_window'
      return $false
    }

    [uint32]$targetProcess = 0
    [uint32]$foregroundProcess = 0
    $targetThread = [EquinoxWinappSmokeForeground]::GetWindowThreadProcessId($target, [ref]$targetProcess)
    $foregroundThread = [EquinoxWinappSmokeForeground]::GetWindowThreadProcessId($foreground, [ref]$foregroundProcess)
    $currentThread = [EquinoxWinappSmokeForeground]::GetCurrentThreadId()
    if ($targetThread -eq 0 -or $foregroundThread -eq 0) {
      Write-Host ("WINDOWS_WINAPP_FOREGROUND_RECOVERY result=missing_thread target=0x{0:X} foreground=0x{1:X} target_thread={2} foreground_thread={3} current_thread={4} target_pid={5} foreground_pid={6}" -f $target.ToInt64(), $foreground.ToInt64(), $targetThread, $foregroundThread, $currentThread, $targetProcess, $foregroundProcess)
      return $false
    }

    # Attach the two GUI input queues directly. Attaching the PowerShell caller thread
    # is insufficient on hosted ARM64 runners because that thread may not own a GUI
    # message queue. This remains bounded to the exact controlled fixture HWND.
    $attachedTargetForeground = $false
    try {
      $attachError = 0
      if ($targetThread -ne $foregroundThread) {
        $attachedTargetForeground = [EquinoxWinappSmokeForeground]::AttachThreadInput($targetThread, $foregroundThread, $true)
        if (-not $attachedTargetForeground) { $attachError = [Runtime.InteropServices.Marshal]::GetLastWin32Error() }
      }
      $targetDesktop = [EquinoxWinappSmokeForeground]::GetDesktopName($targetThread)
      $foregroundDesktop = [EquinoxWinappSmokeForeground]::GetDesktopName($foregroundThread)
      $currentDesktop = [EquinoxWinappSmokeForeground]::GetDesktopName($currentThread)
      $targetInfo = Get-Process -Id ([int]$targetProcess) -ErrorAction SilentlyContinue
      $foregroundInfo = Get-Process -Id ([int]$foregroundProcess) -ErrorAction SilentlyContinue
      $currentInfo = Get-Process -Id $PID -ErrorAction SilentlyContinue
      $targetSession = if ($null -eq $targetInfo) { -1 } else { $targetInfo.SessionId }
      $foregroundSession = if ($null -eq $foregroundInfo) { -1 } else { $foregroundInfo.SessionId }
      $currentSession = if ($null -eq $currentInfo) { -1 } else { $currentInfo.SessionId }
      $targetName = if ($null -eq $targetInfo) { '<missing>' } else { $targetInfo.ProcessName }
      $foregroundName = if ($null -eq $foregroundInfo) { '<missing>' } else { $foregroundInfo.ProcessName }
      $currentName = if ($null -eq $currentInfo) { '<missing>' } else { $currentInfo.ProcessName }
      $showResult = [EquinoxWinappSmokeForeground]::ShowWindowAsync($target, 9)
      $bringResult = [EquinoxWinappSmokeForeground]::BringWindowToTop($target)
      $setResult = [EquinoxWinappSmokeForeground]::SetForegroundWindow($target)
      $altInputCount = 0
      $altInputError = 0
      $setAfterAltResult = $false
      if ($architecture -eq 'Arm64' -and -not $setResult) {
        # Test-only exact-fixture recovery: an ALT key transition releases Windows'
        # foreground lock without bypassing winapp's product-side safety checks.
        $altInputCount = [EquinoxWinappSmokeForeground]::SendAltPulse()
        if ($altInputCount -ne 2) { $altInputError = [Runtime.InteropServices.Marshal]::GetLastWin32Error() }
        Start-Sleep -Milliseconds 75
        if ($altInputCount -eq 2) {
          [void][EquinoxWinappSmokeForeground]::BringWindowToTop($target)
          $setAfterAltResult = [EquinoxWinappSmokeForeground]::SetForegroundWindow($target)
        }
      }
      Start-Sleep -Milliseconds 250
      $after = [EquinoxWinappSmokeForeground]::GetForegroundWindow()
      [uint32]$afterProcess = 0
      $afterThread = if ($after -eq [IntPtr]::Zero) { 0 } else { [EquinoxWinappSmokeForeground]::GetWindowThreadProcessId($after, [ref]$afterProcess) }
      $success = $after -eq $target
      $script:controlledForegroundEvidence = [pscustomobject]@{
        Success = $success
        ForegroundHandle = [Int64]$foreground.ToInt64()
        AfterHandle = [Int64]$after.ToInt64()
        TargetPid = [int]$targetProcess
        ForegroundPid = [int]$foregroundProcess
        AfterPid = [int]$afterProcess
        TargetThread = [uint32]$targetThread
        ForegroundThread = [uint32]$foregroundThread
        AfterThread = [uint32]$afterThread
        TargetProcess = $targetName
        ForegroundProcess = $foregroundName
        CurrentProcess = $currentName
        TargetSession = [int]$targetSession
        ForegroundSession = [int]$foregroundSession
        CurrentSession = [int]$currentSession
        TargetDesktop = $targetDesktop
        ForegroundDesktop = $foregroundDesktop
        CurrentDesktop = $currentDesktop
        AttachedTargetForeground = [bool]$attachedTargetForeground
        AttachError = [int]$attachError
        ShowResult = [bool]$showResult
        BringResult = [bool]$bringResult
        SetResult = [bool]$setResult
        AltInputCount = [uint32]$altInputCount
        AltInputError = [int]$altInputError
        SetAfterAltResult = [bool]$setAfterAltResult
      }
      Write-Host ("WINDOWS_WINAPP_FOREGROUND_RECOVERY result={0} target=0x{1:X} before=0x{2:X} after=0x{3:X} target_thread={4} foreground_thread={5} after_thread={6} current_thread={7} target_pid={8} foreground_pid={9} after_pid={10} target_process={11} foreground_process={12} current_process={13} target_session={14} foreground_session={15} current_session={16} target_desktop={17} foreground_desktop={18} current_desktop={19} attach_target_foreground={20} attach_error={21} show={22} bring={23} set={24} alt_input_count={25} alt_input_error={26} set_after_alt={27}" -f $success, $target.ToInt64(), $foreground.ToInt64(), $after.ToInt64(), $targetThread, $foregroundThread, $afterThread, $currentThread, $targetProcess, $foregroundProcess, $afterProcess, $targetName, $foregroundName, $currentName, $targetSession, $foregroundSession, $currentSession, $targetDesktop, $foregroundDesktop, $currentDesktop, $attachedTargetForeground, $attachError, $showResult, $bringResult, $setResult, $altInputCount, $altInputError, $setAfterAltResult)
      return $success
    } finally {
      if ($attachedTargetForeground) { [void][EquinoxWinappSmokeForeground]::AttachThreadInput($targetThread, $foregroundThread, $false) }
    }
  }
  $ready = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    $list = (& $winapp ui list-windows -a $fixture.Id --json 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -eq 0 -and $list -match 'Equinox Winapp Smoke') { $ready = $true; break }
    if ($fixture.HasExited) { throw ("Controlled WinForms fixture exited before discovery: exit={0}" -f $fixture.ExitCode) }
    Start-Sleep -Milliseconds 250
  }
  if (-not $ready) { throw 'winapp could not discover the controlled WinForms fixture window.' }

  $appList = Invoke-DesktopHelperCaptured -Arguments @('-Mode', 'AppList')
  if (@($appList.apps | Where-Object { [int]$_.pid -eq $fixture.Id }).Count -ne 1) { throw 'Windows desktop lifecycle app list did not include the launched fixture.' }
  $fixture.Refresh()
  if ($fixture.MainWindowHandle -eq [IntPtr]::Zero) { throw 'Controlled fixture has no HWND for lifecycle acceptance.' }
  $fixtureHwnd = ('0x{0:X}' -f $fixture.MainWindowHandle.ToInt64())

  $minimized = Invoke-DesktopHelperCaptured -Arguments @('-Mode', 'WindowMinimize', '-Hwnd', $fixtureHwnd)
  if (-not [bool]$minimized.minimized) { throw 'Windows desktop lifecycle minimize did not iconify the fixture.' }
  $restored = Invoke-DesktopHelperCaptured -Arguments @('-Mode', 'WindowRestore', '-Hwnd', $fixtureHwnd)
  if ([bool]$restored.minimized -or [bool]$restored.maximized) { throw 'Windows desktop lifecycle restore did not return the fixture to normal state.' }
  $maximized = Invoke-DesktopHelperCaptured -Arguments @('-Mode', 'WindowMaximize', '-Hwnd', $fixtureHwnd)
  if (-not [bool]$maximized.maximized) { throw 'Windows desktop lifecycle maximize did not maximize the fixture.' }
  $restored = Invoke-DesktopHelperCaptured -Arguments @('-Mode', 'WindowRestore', '-Hwnd', $fixtureHwnd)
  if ([bool]$restored.minimized -or [bool]$restored.maximized) { throw 'Windows desktop lifecycle restore after maximize did not return to normal state.' }

  $bounded = Invoke-DesktopHelperCaptured -Arguments @('-Mode', 'WindowSetBounds', '-Hwnd', $fixtureHwnd, '-X', '80', '-Y', '90', '-Width', '640', '-Height', '420')
  if ([int]$bounded.bounds.x -ne 80 -or [int]$bounded.bounds.y -ne 90 -or [int]$bounded.bounds.width -ne 640 -or [int]$bounded.bounds.height -ne 420) { throw 'Windows desktop lifecycle set-bounds roundtrip mismatch.' }
  $moved = Invoke-DesktopHelperCaptured -Arguments @('-Mode', 'WindowMove', '-Hwnd', $fixtureHwnd, '-X', '120', '-Y', '130')
  if ([int]$moved.bounds.x -ne 120 -or [int]$moved.bounds.y -ne 130) { throw 'Windows desktop lifecycle move roundtrip mismatch.' }
  $resized = Invoke-DesktopHelperCaptured -Arguments @('-Mode', 'WindowResize', '-Hwnd', $fixtureHwnd, '-Width', '700', '-Height', '460')
  if ([int]$resized.bounds.width -ne 700 -or [int]$resized.bounds.height -ne 460) { throw 'Windows desktop lifecycle resize roundtrip mismatch.' }

  $inspect = (& $winapp ui inspect -a $fixture.Id --depth 5 --json 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $inspect -notmatch 'SmokeText' -or $inspect -notmatch 'SmokePasteText' -or $inspect -notmatch 'SmokeButton') {
    throw "winapp inspect did not expose the controlled UIA fixture: $inspect"
  }

  & $winapp ui set-value SmokeText 'Equinox Windows Desktop' -a $fixture.Id --json | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'winapp set-value failed against the controlled fixture.' }

  $valueRaw = (& $winapp ui get-value SmokeText -a $fixture.Id --json 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) { throw "winapp get-value failed: $valueRaw" }
  $value = $valueRaw | ConvertFrom-Json
  if ($value.text -ne 'Equinox Windows Desktop') { throw "winapp value roundtrip mismatch: $valueRaw" }

  $clipboardInput = Join-Path $root 'clipboard.txt'
  [System.IO.File]::WriteAllText($clipboardInput, 'Equinox Clipboard Paste', (New-Object System.Text.UTF8Encoding($false)))
  & powershell.exe -NoLogo -NoProfile -NonInteractive -Sta -ExecutionPolicy Bypass -File $clipboardHelper -Mode Set -InputPath $clipboardInput
  if ($LASTEXITCODE -ne 0) { throw 'Windows clipboard helper set failed.' }
  $clipboardRead = (& powershell.exe -NoLogo -NoProfile -NonInteractive -Sta -ExecutionPolicy Bypass -File $clipboardHelper -Mode Get 2>&1 | Out-String).TrimEnd()
  if ($LASTEXITCODE -ne 0 -or $clipboardRead -ne 'Equinox Clipboard Paste') { throw "Windows clipboard helper roundtrip failed: $clipboardRead" }
  $pasteInputSkipped = $false
  $focusProbe = Invoke-WinappCaptured -Arguments @('ui', 'focus', 'SmokePasteText', '-a', [string]$fixture.Id, '--json')
  if ($focusProbe.ExitCode -ne 0 -and $focusProbe.Output -match 'foreground_not_target') {
    if (Set-ControlledFixtureForeground) {
      $focusProbe = Invoke-WinappCaptured -Arguments @('ui', 'focus', 'SmokePasteText', '-a', [string]$fixture.Id, '--json')
    }
  }
  if ($focusProbe.ExitCode -ne 0) {
    if ($architecture -eq 'Arm64' -and $focusProbe.Output -match 'no_interactive_desktop') {
      $pasteInputSkipped = $true
      Write-Output 'WINDOWS_WINAPP_PASTE_INPUT_SKIPPED architecture=Arm64 reason=no_interactive_desktop'
    } elseif (Test-ProtectedHostedForegroundCeiling -FocusOutput $focusProbe.Output) {
      $pasteInputSkipped = $true
      Write-Output 'WINDOWS_WINAPP_PASTE_INPUT_SKIPPED architecture=Arm64 reason=hosted_runner_protected_wwahost'
    } else {
      throw "winapp could not foreground/focus the controlled paste target: $($focusProbe.Output)"
    }
  }
  if (-not $pasteInputSkipped) {
    $pasteProbe = Invoke-WinappCaptured -Arguments @('ui', 'send-keys', 'ctrl+v', '-a', [string]$fixture.Id, '--target', 'SmokePasteText', '--via', 'send-input', '--json')
    if ($pasteProbe.ExitCode -ne 0) {
      if ($architecture -eq 'Arm64' -and $pasteProbe.Output -match 'no_interactive_desktop') {
        $pasteInputSkipped = $true
        Write-Output 'WINDOWS_WINAPP_PASTE_INPUT_SKIPPED architecture=Arm64 reason=no_interactive_desktop'
      } else {
        throw "winapp clipboard paste input failed against the controlled fixture: $($pasteProbe.Output)"
      }
    }
  }
  if (-not $pasteInputSkipped) {
    $pasteRaw = (& $winapp ui get-value SmokePasteText -a $fixture.Id --json 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw "winapp clipboard paste readback failed: $pasteRaw" }
    $pasteValue = $pasteRaw | ConvertFrom-Json
    if ($pasteValue.text -ne 'Equinox Clipboard Paste') { throw "winapp clipboard paste mismatch: $pasteRaw" }
  }
  & powershell.exe -NoLogo -NoProfile -NonInteractive -Sta -ExecutionPolicy Bypass -File $clipboardHelper -Mode Clear
  if ($LASTEXITCODE -ne 0) { throw 'Windows clipboard helper clear failed.' }

  & $winapp ui invoke SmokeButton -a $fixture.Id --json | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'winapp invoke failed against the controlled fixture.' }
  & $winapp ui wait-for SmokeStatus -a $fixture.Id --property Name --value Clicked --timeout 5000 --json | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'winapp did not observe the UI mutation produced by invoke.' }

  $capture = (& $winapp ui screenshot -a $fixture.Id --output $screenshotPath --json 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $screenshotPath -PathType Leaf)) {
    throw "winapp screenshot failed against the controlled fixture: $capture"
  }
  if ((Get-Item -LiteralPath $screenshotPath).Length -lt 128) { throw 'winapp screenshot output is unexpectedly empty.' }

  $oldFixtureId = $fixture.Id
  $relaunched = Invoke-DesktopHelperCaptured -Arguments @('-Mode', 'AppRelaunch', '-Name', $fixtureExecutable)
  if ([int]$relaunched.pid -le 0 -or [int]$relaunched.pid -eq $oldFixtureId) { throw 'Windows desktop lifecycle relaunch did not return a fresh fixture PID.' }
  $fixture = Get-Process -Id ([int]$relaunched.pid) -ErrorAction Stop
  $relaunchReady = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    $fixture.Refresh()
    if ($fixture.MainWindowHandle -ne [IntPtr]::Zero) { $relaunchReady = $true; break }
    if ($fixture.HasExited) { throw 'Relaunched fixture exited before creating a window.' }
    Start-Sleep -Milliseconds 100
  }
  if (-not $relaunchReady) { throw 'Relaunched fixture did not create a window.' }
  $relaunchHwnd = ('0x{0:X}' -f $fixture.MainWindowHandle.ToInt64())
  [void](Invoke-DesktopHelperCaptured -Arguments @('-Mode', 'WindowClose', '-Hwnd', $relaunchHwnd))
  for ($attempt = 0; $attempt -lt 30 -and -not $fixture.HasExited; $attempt++) { Start-Sleep -Milliseconds 100; $fixture.Refresh() }
  if (-not $fixture.HasExited) { throw 'Windows desktop lifecycle window close did not exit the fixture.' }

  $quitLaunch = Invoke-DesktopHelperCaptured -Arguments @('-Mode', 'AppLaunch', '-Name', $fixtureExecutable)
  $fixture = Get-Process -Id ([int]$quitLaunch.pid) -ErrorAction Stop
  $quitReady = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    $fixture.Refresh()
    if ($fixture.MainWindowHandle -ne [IntPtr]::Zero) { $quitReady = $true; break }
    if ($fixture.HasExited) { throw 'Quit fixture exited before creating a window.' }
    Start-Sleep -Milliseconds 100
  }
  if (-not $quitReady) { throw 'Quit fixture did not create a window.' }
  $quit = Invoke-DesktopHelperCaptured -Arguments @('-Mode', 'AppQuit', '-TargetPid', [string]$fixture.Id)
  if (@($quit.stillRunning).Count -ne 0) { throw 'Windows desktop lifecycle graceful app quit left the fixture running.' }
  $fixture.Refresh()
  if (-not $fixture.HasExited) { throw 'Windows desktop lifecycle app quit did not exit the fixture.' }

  Write-Output ("WINDOWS_DESKTOP_LIFECYCLE_SMOKE_PASS architecture={0}" -f $architecture)
  Write-Output ("WINDOWS_WINAPP_SMOKE_PASS architecture={0} machine=0x{1:X4} version={2}" -f $architecture, $machine, $version)
}
finally {
  if ($null -ne $fixture -and -not $fixture.HasExited) { Stop-Process -Id $fixture.Id -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
