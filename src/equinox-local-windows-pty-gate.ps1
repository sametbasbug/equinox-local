$ErrorActionPreference = 'Stop'

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
    & $command @arguments
    if ($null -eq $LASTEXITCODE) { exit 0 }
    exit [int]$LASTEXITCODE
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 127
}
