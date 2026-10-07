using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;

namespace EquinoxLocal.WindowsShell;

internal sealed class RuntimeSupervisor : IAsyncDisposable
{
    private const int MaxAutomaticRestarts = 3;
    private const int MaxGateDiagnosticChars = 1_200;
    private static readonly TimeSpan ExitTimeout = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan[] RecoveryDelays = [TimeSpan.FromMilliseconds(250), TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(2)];

    private readonly Func<WindowsRuntimeLocation> _runtimeResolver;
    private readonly SemaphoreSlim _lifecycle = new(1, 1);
    private WindowsJobObjectLease? _jobObject;
    private Process? _gate;
    private int? _gatePid;
    private bool _desiredRunning;
    private bool _stopping;
    private bool _disposed;
    private int _automaticRestarts;
    private int _generation;

    internal RuntimeSupervisor(string releaseDir)
    {
        if (string.IsNullOrWhiteSpace(releaseDir) || !Path.IsPathFullyQualified(releaseDir))
            throw new ArgumentException("Runtime release directory must be absolute.", nameof(releaseDir));
        var fixedRelease = Path.GetFullPath(releaseDir);
        var installRoot = Environment.GetEnvironmentVariable("EQUINOX_LOCAL_INSTALL_ROOT");
        var resolvedInstallRoot = string.IsNullOrWhiteSpace(installRoot) ? Path.GetDirectoryName(Path.GetDirectoryName(fixedRelease))! : Path.GetFullPath(installRoot);
        _runtimeResolver = () => new WindowsRuntimeLocation(
            fixedRelease,
            fixedRelease,
            Path.Combine(fixedRelease, "server.js"),
            fixedRelease,
            resolvedInstallRoot,
            ManagedSource: false);
    }

    private RuntimeSupervisor(Func<WindowsRuntimeLocation> runtimeResolver) => _runtimeResolver = runtimeResolver;

    internal static RuntimeSupervisor? TryCreateFromEnvironmentOrManagedInstall()
    {
        var releaseDir = Environment.GetEnvironmentVariable("EQUINOX_LOCAL_RELEASE_DIR");
        if (!string.IsNullOrWhiteSpace(releaseDir)) return new RuntimeSupervisor(releaseDir);
        if (!WindowsManagedReleaseLocator.HasCurrentPointer()) return null;
        return new RuntimeSupervisor(WindowsManagedSourceRuntimeLocator.Resolve);
    }

    internal int? RuntimeProcessId
    {
        get
        {
            var gate = _gate;
            var pid = _gatePid;
            if (gate is null || pid is null) return null;
            try { return gate.HasExited ? null : pid; }
            catch (InvalidOperationException) { return null; }
        }
    }
    internal bool DesiredRunning => _desiredRunning;

    internal async Task StartAsync(CancellationToken cancellationToken = default)
    {
        ThrowIfDisposed();
        await _lifecycle.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            _desiredRunning = true;
            _stopping = false;
            _automaticRestarts = 0;
            if (_gate is { HasExited: false }) return;
            await StartCoreAsync(cancellationToken).ConfigureAwait(false);
        }
        finally { _lifecycle.Release(); }
    }

    internal async Task RestartAsync(CancellationToken cancellationToken = default)
    {
        ThrowIfDisposed();
        await _lifecycle.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            _desiredRunning = true;
            _stopping = true;
            await StopCoreAsync(cancellationToken).ConfigureAwait(false);
            _stopping = false;
            _automaticRestarts = 0;
            await StartCoreAsync(cancellationToken).ConfigureAwait(false);
        }
        finally { _stopping = false; _lifecycle.Release(); }
    }

    internal async Task StopAsync(CancellationToken cancellationToken = default)
    {
        if (_disposed) return;
        await _lifecycle.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            _desiredRunning = false;
            _stopping = true;
            await StopCoreAsync(cancellationToken).ConfigureAwait(false);
        }
        finally { _stopping = false; _lifecycle.Release(); }
    }

    private async Task StartCoreAsync(CancellationToken cancellationToken)
    {
        var location = _runtimeResolver();
        var nativeReleaseDir = location.NativeReleaseDir;
        var sourceRoot = location.SourceRoot;
        var nodePath = Path.Combine(nativeReleaseDir, "runtime", "node", "bin", "node.exe");
        var serverPath = location.ServerPath;
        var processGatePath = Path.Combine(nativeReleaseDir, "equinox-local-windows-process-gate.ps1");
        ValidateReleaseFiles(nodePath, serverPath, processGatePath);
        _jobObject?.Dispose();
        _jobObject = WindowsJobObjectLease.Create();
        WindowsShellDiagnostics.RecordRuntimeState("runtime-start-phase", "job-created");

        var payload = Convert.ToBase64String(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { command = nodePath, args = new[] { serverPath } })));
        var startInfo = PowerShellStartInfo(processGatePath);
        startInfo.WorkingDirectory = sourceRoot;
        startInfo.Environment["EQUINOX_LOCAL_OWNED_PROCESS_SPEC"] = payload;
        startInfo.Environment["EQUINOX_LOCAL_RELEASE_DIR"] = location.BootstrapReleaseDir;
        startInfo.Environment["EQUINOX_LOCAL_INSTALL_ROOT"] = location.InstallRoot;
        startInfo.Environment["EQUINOX_LOCAL_SUPERVISOR_MODE"] = "local-only";
        var gate = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
        var gateStderr = new StringBuilder();
        var gateStderrSync = new object();
        gate.ErrorDataReceived += (_, eventArgs) => AppendGateDiagnostic(gateStderr, gateStderrSync, eventArgs.Data);
        if (!gate.Start()) throw new InvalidOperationException("Windows runtime process gate did not start.");
        var gatePid = gate.Id;
        gate.BeginOutputReadLine();
        gate.BeginErrorReadLine();
        _gate = gate;
        _gatePid = gatePid;
        WindowsShellDiagnostics.RecordRuntimeState("runtime-start-phase", "gate-started");
        var generation = ++_generation;
        gate.Exited += (_, _) => OnGateExited(generation, gate, gateStderr, gateStderrSync);
        try
        {
            WindowsShellDiagnostics.RecordRuntimeState("runtime-start-phase", "assign-started");
            _jobObject.Assign(gate);
            WindowsShellDiagnostics.RecordRuntimeState("runtime-start-phase", "assigned");
            await gate.StandardInput.WriteLineAsync("EQUINOX_GO").ConfigureAwait(false);
            await gate.StandardInput.FlushAsync(cancellationToken).ConfigureAwait(false);
            // Keep the gate stdin pipe open for the child runtime. server.js treats stdin EOF as
            // an ownership shutdown signal; closing this writer here made GUI-hosted Windows
            // runtimes shut down cleanly immediately after startup. Job Object termination still
            // owns stop/restart and closes the process tree without relying on stdin EOF.
            WindowsShellDiagnostics.RecordRuntimeState("runtime-start-phase", "gate-released");
        }
        catch
        {
            await StopCoreAsync(CancellationToken.None).ConfigureAwait(false);
            throw;
        }
    }

    private void OnGateExited(int generation, Process gate, StringBuilder gateStderr, object gateStderrSync)
    {
        if (_disposed || _stopping || !_desiredRunning || generation != _generation) return;
        // The Exited event already proves the gate process is signaled. Do not call synchronous
        // WaitForExit() here while async stdout/stderr drains are active: that can block the event
        // callback and prevent bounded crash recovery from ever being scheduled.
        var exitCode = -1;
        try { if (gate.HasExited) exitCode = gate.ExitCode; }
        catch (InvalidOperationException) { }
        var stderr = ReadGateDiagnostic(gateStderr, gateStderrSync);
        var detail = string.IsNullOrWhiteSpace(stderr) ? $"exit={exitCode}" : $"exit={exitCode}; stderr={stderr}";
        WindowsShellDiagnostics.RecordRuntimeState("runtime-gate-exit", detail);
        _ = RecoverAsync(generation);
    }

    private static void AppendGateDiagnostic(StringBuilder builder, object sync, string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return;
        var clean = new StringBuilder(Math.Min(value.Length, MaxGateDiagnosticChars));
        foreach (var character in value)
        {
            if (clean.Length >= MaxGateDiagnosticChars) break;
            clean.Append(char.IsControl(character) ? ' ' : character);
        }
        var line = clean.ToString().Trim();
        if (line.Length == 0) return;
        lock (sync)
        {
            if (builder.Length > 0) builder.Append(" | ");
            builder.Append(line);
            if (builder.Length > MaxGateDiagnosticChars) builder.Remove(0, builder.Length - MaxGateDiagnosticChars);
        }
    }

    private static string ReadGateDiagnostic(StringBuilder builder, object sync)
    {
        lock (sync) return builder.ToString().Trim();
    }

    private async Task RecoverAsync(int generation)
    {
        await _lifecycle.WaitAsync().ConfigureAwait(false);
        try
        {
            if (_disposed || _stopping || !_desiredRunning || generation != _generation) return;
            if (_automaticRestarts >= MaxAutomaticRestarts)
            {
                _desiredRunning = false;
                await StopCoreAsync(CancellationToken.None).ConfigureAwait(false);
                return;
            }
            var delay = RecoveryDelays[_automaticRestarts++];
            await StopCoreAsync(CancellationToken.None).ConfigureAwait(false);
            await Task.Delay(delay).ConfigureAwait(false);
            if (_desiredRunning && !_disposed) await StartCoreAsync(CancellationToken.None).ConfigureAwait(false);
        }
        catch
        {
            if (_automaticRestarts >= MaxAutomaticRestarts) _desiredRunning = false;
        }
        finally { _lifecycle.Release(); }
    }

    private async Task StopCoreAsync(CancellationToken cancellationToken)
    {
        _generation++;
        var gate = _gate;
        _gate = null;
        _gatePid = null;
        var jobObject = _jobObject;
        _jobObject = null;
        if (jobObject is not null)
        {
            try { jobObject.Terminate(143); }
            catch { }
            finally { jobObject.Dispose(); }
        }
        if (gate is null) return;
        try
        {
            if (!gate.HasExited) await gate.WaitForExitAsync(cancellationToken).WaitAsync(ExitTimeout, cancellationToken).ConfigureAwait(false);
        }
        catch { }
        finally { gate.Dispose(); }
    }

    private static ProcessStartInfo PowerShellStartInfo(string scriptPath, bool redirectOutput = true) => new()
    {
        FileName = "powershell.exe",
        UseShellExecute = false,
        CreateNoWindow = true,
        RedirectStandardInput = true,
        RedirectStandardOutput = redirectOutput,
        RedirectStandardError = true,
        Arguments = $"-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"{scriptPath}\"",
    };

    private static void ValidateReleaseFiles(params string[] files)
    {
        foreach (var file in files)
            if (!File.Exists(file)) throw new FileNotFoundException("Windows runtime release is incomplete.", file);
    }

    private void ThrowIfDisposed() => ObjectDisposedException.ThrowIf(_disposed, this);

    public async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        await StopAsync().ConfigureAwait(false);
        _disposed = true;
        _lifecycle.Dispose();
    }
}
