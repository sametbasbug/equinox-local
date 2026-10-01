using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;

namespace EquinoxLocal.WindowsShell;

internal sealed class RuntimeSupervisor : IAsyncDisposable
{
    private const int MaxAutomaticRestarts = 3;
    private static readonly TimeSpan ProtocolTimeout = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan ExitTimeout = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan[] RecoveryDelays = [TimeSpan.FromMilliseconds(250), TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(2)];

    private readonly Func<WindowsReleaseLocation> _releaseResolver;
    private readonly SemaphoreSlim _lifecycle = new(1, 1);
    private readonly SemaphoreSlim _protocol = new(1, 1);
    private Process? _jobHelper;
    private Process? _gate;
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
        _releaseResolver = () => new WindowsReleaseLocation(fixedRelease, string.IsNullOrWhiteSpace(installRoot) ? null : Path.GetFullPath(installRoot));
    }

    private RuntimeSupervisor(Func<WindowsReleaseLocation> releaseResolver) => _releaseResolver = releaseResolver;

    internal static RuntimeSupervisor? TryCreateFromEnvironmentOrManagedInstall()
    {
        var releaseDir = Environment.GetEnvironmentVariable("EQUINOX_LOCAL_RELEASE_DIR");
        if (!string.IsNullOrWhiteSpace(releaseDir)) return new RuntimeSupervisor(releaseDir);
        if (!WindowsManagedReleaseLocator.HasCurrentPointer()) return null;
        return new RuntimeSupervisor(WindowsManagedReleaseLocator.ResolveCurrentRelease);
    }

    internal int? RuntimeProcessId => _gate is { HasExited: false } process ? process.Id : null;
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
        var location = _releaseResolver();
        var releaseDir = location.ReleaseDir;
        var nodePath = Path.Combine(releaseDir, "runtime", "node", "bin", "node.exe");
        var serverPath = Path.Combine(releaseDir, "server.js");
        var jobHelperPath = Path.Combine(releaseDir, "equinox-local-windows-job-object.ps1");
        var processGatePath = Path.Combine(releaseDir, "equinox-local-windows-process-gate.ps1");
        ValidateReleaseFiles(nodePath, serverPath, jobHelperPath, processGatePath);
        await CloseJobHelperAsync(CancellationToken.None).ConfigureAwait(false);
        _jobHelper = StartPowerShell(jobHelperPath, redirectOutput: true);
        var ready = await ReadReplyAsync(_jobHelper, "ready", cancellationToken).ConfigureAwait(false);
        if (!ready.GetProperty("ok").GetBoolean() || !ready.GetProperty("ready").GetBoolean())
            throw new InvalidOperationException("Windows Job Object helper did not become ready.");

        var payload = Convert.ToBase64String(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { command = nodePath, args = new[] { serverPath } })));
        var startInfo = PowerShellStartInfo(processGatePath);
        startInfo.Environment["EQUINOX_LOCAL_OWNED_PROCESS_SPEC"] = payload;
        startInfo.Environment["EQUINOX_LOCAL_RELEASE_DIR"] = releaseDir;
        if (!string.IsNullOrWhiteSpace(location.InstallRoot)) startInfo.Environment["EQUINOX_LOCAL_INSTALL_ROOT"] = location.InstallRoot;
        startInfo.Environment["EQUINOX_LOCAL_SUPERVISOR_MODE"] = "local-only";
        var gate = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
        if (!gate.Start()) throw new InvalidOperationException("Windows runtime process gate did not start.");
        gate.BeginOutputReadLine();
        gate.BeginErrorReadLine();
        _gate = gate;
        var generation = ++_generation;
        gate.Exited += (_, _) => OnGateExited(generation);
        try
        {
            await SendRequestAsync("assign", new Dictionary<string, object?> { ["pid"] = gate.Id }, cancellationToken).ConfigureAwait(false);
            await gate.StandardInput.WriteLineAsync("EQUINOX_GO").ConfigureAwait(false);
            await gate.StandardInput.FlushAsync(cancellationToken).ConfigureAwait(false);
            gate.StandardInput.Close();
        }
        catch
        {
            await StopCoreAsync(CancellationToken.None).ConfigureAwait(false);
            throw;
        }
    }

    private void OnGateExited(int generation)
    {
        if (_disposed || _stopping || !_desiredRunning || generation != _generation) return;
        _ = RecoverAsync(generation);
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
        if (_jobHelper is { HasExited: false })
        {
            try { await SendRequestAsync("terminate", new Dictionary<string, object?> { ["exitCode"] = 143 }, cancellationToken).ConfigureAwait(false); }
            catch { }
        }
        await CloseJobHelperAsync(cancellationToken).ConfigureAwait(false);
        if (gate is null) return;
        try
        {
            if (!gate.HasExited) await gate.WaitForExitAsync(cancellationToken).WaitAsync(ExitTimeout, cancellationToken).ConfigureAwait(false);
        }
        catch { }
        finally { gate.Dispose(); }
    }

    private async Task CloseJobHelperAsync(CancellationToken cancellationToken)
    {
        var helper = _jobHelper;
        _jobHelper = null;
        if (helper is null) return;
        try
        {
            if (!helper.HasExited) await SendRequestAsync(helper, "close", new Dictionary<string, object?>(), cancellationToken).ConfigureAwait(false);
        }
        catch { }
        try
        {
            if (!helper.HasExited) await helper.WaitForExitAsync(cancellationToken).WaitAsync(ExitTimeout, cancellationToken).ConfigureAwait(false);
        }
        catch
        {
            try { if (!helper.HasExited) helper.Kill(); } catch { }
        }
        helper.Dispose();
    }

    private Task<JsonElement> SendRequestAsync(string operation, Dictionary<string, object?> payload, CancellationToken cancellationToken) =>
        SendRequestAsync(_jobHelper ?? throw new InvalidOperationException("Windows Job Object helper is unavailable."), operation, payload, cancellationToken);

    private async Task<JsonElement> SendRequestAsync(Process helper, string operation, Dictionary<string, object?> payload, CancellationToken cancellationToken)
    {
        await _protocol.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            var id = Guid.NewGuid().ToString("D");
            payload["id"] = id;
            payload["op"] = operation;
            await helper.StandardInput.WriteLineAsync(JsonSerializer.Serialize(payload)).ConfigureAwait(false);
            await helper.StandardInput.FlushAsync(cancellationToken).ConfigureAwait(false);
            var response = await ReadReplyAsync(helper, operation, cancellationToken).ConfigureAwait(false);
            if (response.GetProperty("id").GetString() != id || !response.GetProperty("ok").GetBoolean())
                throw new InvalidOperationException("Windows Job Object helper rejected the lifecycle request.");
            return response;
        }
        finally { _protocol.Release(); }
    }

    private static async Task<JsonElement> ReadReplyAsync(Process helper, string phase, CancellationToken cancellationToken)
    {
        string? line;
        try
        {
            line = await helper.StandardOutput.ReadLineAsync(cancellationToken).AsTask().WaitAsync(ProtocolTimeout, cancellationToken).ConfigureAwait(false);
        }
        catch (TimeoutException error)
        {
            throw new TimeoutException($"Windows Job Object helper {phase} reply timed out after {(int)ProtocolTimeout.TotalSeconds} seconds.", error);
        }
        if (string.IsNullOrWhiteSpace(line)) throw new InvalidOperationException("Windows Job Object helper closed its protocol stream.");
        using var document = JsonDocument.Parse(line);
        return document.RootElement.Clone();
    }

    private static Process StartPowerShell(string scriptPath, bool redirectOutput)
    {
        var process = new Process { StartInfo = PowerShellStartInfo(scriptPath, redirectOutput) };
        if (!process.Start()) throw new InvalidOperationException("Windows lifecycle helper did not start.");
        return process;
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
        _protocol.Dispose();
    }
}
