$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

[Console]::Out.Write(([char]27).ToString() + '[0m')
[Console]::Out.Flush()

$gate = [Console]::In.ReadLine()
if ($gate -ne 'EQUINOX_GO') {
    [Console]::Error.WriteLine('Equinox Windows PTY gate was not released.')
    exit 125
}

$encoded = [Environment]::GetEnvironmentVariable('EQUINOX_LOCAL_OWNED_PTY_SPEC')
if ([string]::IsNullOrWhiteSpace($encoded)) {
    [Console]::Error.WriteLine('Equinox Windows PTY payload is missing.')
    exit 126
}

try {
    $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))
    $spec = $json | ConvertFrom-Json
    $command = [string]$spec.command
    $arguments = @($spec.args | ForEach-Object { [string]$_ })
    if ([string]::IsNullOrWhiteSpace($command)) { throw 'PTY shell command is empty.' }
    $leaf = [IO.Path]::GetFileName($command).ToLowerInvariant()
    if ($leaf -ne 'powershell.exe' -and $leaf -ne 'pwsh.exe') { throw 'Unsupported Windows interactive shell.' }
    $readyMarker = [Environment]::GetEnvironmentVariable('EQUINOX_LOCAL_PTY_READY_MARKER')
    if ([string]::IsNullOrWhiteSpace($readyMarker)) { throw 'PTY readiness marker is missing.' }
    # The outer -NoExit -File invocation stays interactive after this
    # script returns. Native invocation of a second PowerShell can silently
    # fail in installed Windows and flash a console window on the desktop.
    if ($arguments.Count -ne 2 -or $arguments[0] -ne '-NoLogo' -or $arguments[1] -ne '-NoProfile') {
        throw 'Unsupported Windows PTY shell flags.'
    }
    [Console]::Out.WriteLine($readyMarker)
    [Console]::Out.Flush()
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 127
}
