$ErrorActionPreference = 'Stop'

$gate = [Console]::In.ReadLine()
if ($gate -ne 'EQUINOX_GO') {
    [Console]::Error.WriteLine('Equinox Windows owned-process gate was not released.')
    exit 125
}

$encoded = [Environment]::GetEnvironmentVariable('EQUINOX_LOCAL_OWNED_PROCESS_SPEC')
if ([string]::IsNullOrWhiteSpace($encoded)) {
    [Console]::Error.WriteLine('Equinox Windows owned-process payload is missing.')
    exit 126
}

try {
    $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))
    $spec = $json | ConvertFrom-Json
    $command = [string]$spec.command
    $arguments = @($spec.args | ForEach-Object { [string]$_ })
    if ([string]::IsNullOrWhiteSpace($command)) { throw 'Owned process command is empty.' }
    # Legacy .cmd/.bat entrypoints (including npm.cmd) are interpreted by
    # PowerShell's native command dispatcher. ProcessStartInfo with
    # UseShellExecute=false cannot launch a batch file directly.
    $resolvedCommand = Get-Command -Name $command -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $resolvedCommand -and -not [string]::IsNullOrWhiteSpace($resolvedCommand.Source)) {
        $command = [string]$resolvedCommand.Source
    }
    $extension = [IO.Path]::GetExtension($command).ToLowerInvariant()
    if ($extension -eq '.cmd' -or $extension -eq '.bat') {
        & $command @arguments
        if ($null -eq $LASTEXITCODE) { exit 0 }
        exit [int]$LASTEXITCODE
    }

    # Windows PowerShell 5.1's native '& command @args' can discard embedded
    # double quotes from arguments (e.g. node -e JavaScript source). Launch
    # the exact argv through ProcessStartInfo instead of native PS quoting.
    function ConvertTo-WindowsArgument([string]$value) {
        if ($value.Length -eq 0) { return '""' }
        if ($value -notmatch '[\s"]') { return $value }
        $builder = New-Object System.Text.StringBuilder
        [void]$builder.Append('"')
        $slashes = 0
        foreach ($character in $value.ToCharArray()) {
            if ($character -eq '\') {
                $slashes++
                continue
            }
            if ($character -eq '"') {
                [void]$builder.Append(('\' * ($slashes * 2 + 1)))
                [void]$builder.Append('"')
                $slashes = 0
                continue
            }
            [void]$builder.Append(('\' * $slashes))
            $slashes = 0
            [void]$builder.Append($character)
        }
        [void]$builder.Append(('\' * ($slashes * 2)))
        [void]$builder.Append('"')
        return $builder.ToString()
    }

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $command
    $startInfo.Arguments = ($arguments | ForEach-Object { ConvertTo-WindowsArgument $_ }) -join ' '
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true

    $child = New-Object System.Diagnostics.Process
    $child.StartInfo = $startInfo
    try {
        if (-not $child.Start()) { throw 'Windows owned process could not be started.' }
        # Stream both pipes simultaneously to prevent deadlock with chatty tools
        # and preserve realtime stdout/stderr and native exit status.
        $stdoutTask = $child.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput())
        $stderrTask = $child.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())
        $child.WaitForExit()
        $stdoutTask.GetAwaiter().GetResult()
        $stderrTask.GetAwaiter().GetResult()
        exit [int]$child.ExitCode
    } finally {
        $child.Dispose()
    }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 127
}
