param(
  [Parameter(Mandatory = $true)]
  [string]$WinappPath,
  [Parameter(Mandatory = $true)]
  [string]$FixturePath,
  [Parameter(Mandatory = $true)]
  [string]$ClipboardHelperPath
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
$fixture = Start-Process -FilePath $fixtureExecutable -PassThru
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
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool ShowWindowAsync(IntPtr hWnd, int command);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@
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
      if ($targetThread -ne $foregroundThread) {
        $attachedTargetForeground = [EquinoxWinappSmokeForeground]::AttachThreadInput($targetThread, $foregroundThread, $true)
      }
      $showResult = [EquinoxWinappSmokeForeground]::ShowWindowAsync($target, 9)
      $bringResult = [EquinoxWinappSmokeForeground]::BringWindowToTop($target)
      $setResult = [EquinoxWinappSmokeForeground]::SetForegroundWindow($target)
      Start-Sleep -Milliseconds 250
      $after = [EquinoxWinappSmokeForeground]::GetForegroundWindow()
      [uint32]$afterProcess = 0
      $afterThread = if ($after -eq [IntPtr]::Zero) { 0 } else { [EquinoxWinappSmokeForeground]::GetWindowThreadProcessId($after, [ref]$afterProcess) }
      $success = $after -eq $target
      Write-Host ("WINDOWS_WINAPP_FOREGROUND_RECOVERY result={0} target=0x{1:X} before=0x{2:X} after=0x{3:X} target_thread={4} foreground_thread={5} after_thread={6} current_thread={7} target_pid={8} foreground_pid={9} after_pid={10} attach_target_foreground={11} show={12} bring={13} set={14}" -f $success, $target.ToInt64(), $foreground.ToInt64(), $after.ToInt64(), $targetThread, $foregroundThread, $afterThread, $currentThread, $targetProcess, $foregroundProcess, $afterProcess, $attachedTargetForeground, $showResult, $bringResult, $setResult)
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

  Write-Output ("WINDOWS_WINAPP_SMOKE_PASS architecture={0} machine=0x{1:X4} version={2}" -f $architecture, $machine, $version)
}
finally {
  if ($null -ne $fixture -and -not $fixture.HasExited) { Stop-Process -Id $fixture.Id -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
