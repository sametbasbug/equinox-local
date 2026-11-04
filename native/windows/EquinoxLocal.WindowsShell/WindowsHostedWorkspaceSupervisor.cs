using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace EquinoxLocal.WindowsShell;

// An opt-in UI child of the existing WPF tray. Node/Control Center are still
// exclusively owned by RuntimeSupervisor and its DIFFERENT Job Object.
// No installer is invoked here; only an already-signed installed Main UI can run.
internal sealed partial class WindowsHostedWorkspaceSupervisor : IAsyncDisposable
{
    private const string ReadyMarker = "EQUINOX_WORKSPACE_UI_STARTED";
    private readonly SemaphoreSlim _lifecycle = new(1, 1);
    private WindowsJobObjectLease? _job;
    private Process? _gate;
    private string? _exe;
    private bool _disposed;

    [GeneratedRegex("^[a-f0-9]{40}$", RegexOptions.CultureInvariant)]
    private static partial Regex SourceShaPattern();

    // Menu discovery only. A normal Start Menu/login launch cannot inherit
    // an installer-time opt-in flag. OpenAsync still requires the independent
    // original Guardian audit, signed inspector and private NTFS ACL checks.
    internal static bool HasInstalledUi()
    {
        try
        {
            var state = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Equinox Local", "state", "main-update");
            using var pointer = JsonDocument.Parse(ReadSelectedPointer(Path.Combine(state, "current-native.json")));
            var selected = pointer.RootElement;
            var target = RuntimeInformation.ProcessArchitecture switch
            {
                Architecture.X64 => "win32-x64",
                Architecture.Arm64 => "win32-arm64",
                _ => "",
            };
            var sha = selected.GetProperty("sourceSha").GetString();
            if (selected.GetProperty("target").GetString() != target ||
                string.IsNullOrEmpty(target) || sha is null || !SourceShaPattern().IsMatch(sha))
                return false;
            var executable = new FileInfo(Path.Combine(state, "electron-ui", target, sha, "electron.exe"));
            return executable.Exists && (executable.Attributes & FileAttributes.ReparsePoint) == 0;
        }
        catch { return false; }
    }

    private sealed record SignedUi(string Target, string SourceSha, string SourceEntrypoint,
        string InstalledPath, string ExecutablePath);

    internal async Task OpenAsync()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        await _lifecycle.WaitAsync().ConfigureAwait(false);
        try
        {
            if (_gate is { HasExited: false })
            {
                FocusVerifiedWindow();
                return;
            }
            await StopCoreAsync().ConfigureAwait(false);
            // The resolver uses the ORIGINAL installed WPF/Guardian signed
            // Main audit; legacy/non-Main source installs cannot launch UI.
            var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            var install = Path.GetFullPath(Path.Combine(local, "Equinox Local"));
            var state = Path.GetFullPath(Path.Combine(install, "state", "main-update"));
            var currentPath = Path.Combine(state, "current-native.json");
            if (File.Exists(Path.Combine(state, "install.json")))
                throw new InvalidDataException("Workspace UI requires the original fully installed signed-native Main, not source mode.");
            var currentBefore = ReadSelectedPointer(currentPath);
            // In direct signed-native mode Resolve() invokes the ORIGINAL
            // independent Guardian --audit-installed-signed-main BEFORE any
            // product-owned Node or JavaScript inspector can execute.
            var location = await Task.Run(WindowsManagedSourceRuntimeLocator.Resolve).ConfigureAwait(false);
            var node = RequireNormalFile(Path.Combine(location.NativeReleaseDir,
                "runtime", "node", "bin", "node.exe"));
            var inspector = RequireNormalFile(Path.Combine(location.NativeReleaseDir,
                "scripts", "release", "inspect-installed-electron-windows.mjs"));
            var gateScript = RequireNormalFile(Path.Combine(location.NativeReleaseDir,
                "equinox-local-windows-runtime-gate.mjs"));
            var selected = await RunInspectorAsync(node, inspector, location.NativeReleaseDir).ConfigureAwait(false);
            var architecture = RuntimeInformation.ProcessArchitecture switch
            {
                Architecture.X64 => "win32-x64",
                Architecture.Arm64 => "win32-arm64",
                _ => throw new PlatformNotSupportedException("Unsupported native UI architecture."),
            };
            var sha = selected.SourceSha;
            var expectedStore = Path.GetFullPath(Path.Combine(state, "native-store", architecture, sha, "release"));
            var expectedUi = Path.GetFullPath(Path.Combine(state, "electron-ui", architecture, sha));
            var expectedExe = Path.GetFullPath(Path.Combine(expectedUi, "electron.exe"));
            var expectedSource = Path.GetFullPath(Path.Combine(expectedStore, "desktop", "electron", "main.cjs"));
            if (!SourceShaPattern().IsMatch(sha) || selected.Target != architecture ||
                !Path.GetFullPath(location.NativeReleaseDir).Equals(expectedStore, StringComparison.OrdinalIgnoreCase) ||
                !selected.InstalledPath.Equals(expectedUi, StringComparison.OrdinalIgnoreCase) ||
                !selected.ExecutablePath.Equals(expectedExe, StringComparison.OrdinalIgnoreCase) ||
                !selected.SourceEntrypoint.Equals(expectedSource, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Windows signed Workspace UI inspector returned a different native Main identity.");
            if (!string.Equals(currentBefore, ReadSelectedPointer(currentPath), StringComparison.Ordinal) ||
                File.Exists(Path.Combine(state, "active.json")) ||
                File.Exists(Path.Combine(state, "electron-ui", architecture, ".activation.lock")))
                throw new InvalidDataException("Native Main selection changed during Workspace UI inspection.");

            // User-level managed UI directories must not allow other ordinary
            // users to replace the fully authenticated executable between
            // inspection and process creation. SYSTEM and Administrators are
            // trusted OS principals; all other writable ACL grants fail shut.
            RequirePrivateUiDirectories(state, expectedUi);
            RequireNormalFile(selected.ExecutablePath);
            RequireNormalFile(selected.SourceEntrypoint);
            _job = WindowsJobObjectLease.Create();
            try
            {
                // The original signed Node gate will not spawn electron.exe
                // until the WPF owner assigns the gate to this UI-only Job.
                var payload = Convert.ToBase64String(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(
                    new { command = selected.ExecutablePath, args = new[] { selected.SourceEntrypoint } })));
                var start = new ProcessStartInfo(node)
                {
                    WorkingDirectory = location.NativeReleaseDir,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardInput = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                };
                start.ArgumentList.Add(gateScript);
                SetMinimalHostedEnvironment(start);
                start.Environment["EQUINOX_LOCAL_OWNED_PROCESS_SPEC"] = payload;
                start.Environment["EQUINOX_LOCAL_OWNED_PROCESS_READY_MARKER"] = ReadyMarker;
                start.Environment["EQUINOX_DESKTOP_HOSTED_UI"] = "1";
                start.Environment["EQUINOX_DESKTOP_PREVIEW_PORT"] = "24891";
                // The direct parent of electron.exe is the signed Node gate,
                // NOT WPF. Job ownership is the Windows lifetime contract.
                var process = new Process { StartInfo = start, EnableRaisingEvents = true };
                var ready = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
                process.OutputDataReceived += (_, e) =>
                {
                    if (e.Data == ReadyMarker) ready.TrySetResult(true);
                };
                process.ErrorDataReceived += (_, _) => { }; // Never log private Chromium stderr.
                process.Exited += (_, _) => ready.TrySetException(new InvalidOperationException(
                    "The signed Windows UI gate exited before the child started."));
                if (!process.Start()) throw new InvalidOperationException("The signed Windows UI gate did not start.");
                _gate = process;
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                // CRITICAL: assign BEFORE releasing the child's execution.
                _job.Assign(process);
                await process.StandardInput.WriteLineAsync("EQUINOX_GO").ConfigureAwait(false);
                await process.StandardInput.FlushAsync().ConfigureAwait(false);
                await ready.Task.WaitAsync(TimeSpan.FromSeconds(20)).ConfigureAwait(false);
                _exe = expectedExe;
            }
            catch
            {
                await StopCoreAsync().ConfigureAwait(false);
                throw;
            }
        }
        finally { _lifecycle.Release(); }
    }

    // The native WPF owner may carry unrelated user/agent/helper environment
    // values. Neither the signed one-shot inspector nor its UI-only child
    // needs them. Retain only Windows profile and system runtime essentials.
    private static void SetMinimalHostedEnvironment(ProcessStartInfo start)
    {
        var systemRoot = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        if (string.IsNullOrWhiteSpace(systemRoot) || !Path.IsPathFullyQualified(systemRoot) ||
            !Directory.Exists(systemRoot))
            throw new InvalidDataException("Windows system runtime root is unavailable for the hosted UI.");
        start.Environment.Clear();
        foreach (var name in new[] { "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP" })
        {
            var value = Environment.GetEnvironmentVariable(name);
            if (!string.IsNullOrWhiteSpace(value)) start.Environment[name] = value;
        }
        start.Environment["SystemRoot"] = systemRoot;
        start.Environment["WINDIR"] = systemRoot;
        start.Environment["PATH"] = string.Join(Path.PathSeparator,
            [Path.Combine(systemRoot, "System32"), systemRoot]);
        start.Environment["ComSpec"] = Path.Combine(systemRoot, "System32", "cmd.exe");
    }

    private static async Task<SignedUi> RunInspectorAsync(string node, string inspector, string cwd)
    {
        var start = new ProcessStartInfo(node)
        {
            WorkingDirectory = cwd, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true,
        };
        start.ArgumentList.Add(inspector);
        start.ArgumentList.Add("--inspect-installed-ui");
        SetMinimalHostedEnvironment(start);
        using var process = Process.Start(start) ?? throw new InvalidOperationException(
            "Signed Windows Workspace inspector could not start.");
        try
        {
            var output = process.StandardOutput.ReadToEndAsync();
            var ignoredStderr = process.StandardError.ReadToEndAsync();
            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromMinutes(3)).ConfigureAwait(false);
            var json = await output.ConfigureAwait(false);
            _ = await ignoredStderr.ConfigureAwait(false);
            if (process.ExitCode != 0 || json.Length is < 60 or > 8_192)
                throw new InvalidDataException("Installed Windows Workspace source verification was rejected.");
            var fields = JsonSerializer.Deserialize<SignedUi>(json,
                new JsonSerializerOptions(JsonSerializerDefaults.Web));
            if (fields is null || string.IsNullOrWhiteSpace(fields.ExecutablePath))
                throw new InvalidDataException("Windows signed Workspace inspector returned malformed paths.");
            return fields;
        }
        catch
        {
            try { if (!process.HasExited) process.Kill(entireProcessTree: true); } catch { }
            throw;
        }
    }

    private static string ReadSelectedPointer(string path)
    {
        var info = new FileInfo(path);
        if (!info.Exists || info.Length is < 20 or > 8_192 ||
            (info.Attributes & FileAttributes.ReparsePoint) != 0)
            throw new InvalidDataException("No normal signed Main native pointer is installed.");
        return File.ReadAllText(path);
    }

    private static string RequireNormalFile(string path)
    {
        var absolute = Path.GetFullPath(path);
        var info = new FileInfo(absolute);
        if (!info.Exists || (info.Attributes & FileAttributes.ReparsePoint) != 0)
            throw new InvalidDataException("Signed Main Workspace executable is missing or unsafe.");
        return absolute;
    }

    private static void RequirePrivateUiDirectories(string state, string selectedUi)
    {
        var sid = WindowsIdentity.GetCurrent().User ??
            throw new InvalidDataException("Current Windows user identity is unavailable.");
        var architectureRoot = Path.GetDirectoryName(selectedUi) ?? throw new InvalidDataException(
            "Signed Windows UI target directory is missing.");
        var workspaceRoot = Path.GetDirectoryName(architectureRoot) ?? throw new InvalidDataException(
            "Signed Windows UI root directory is missing.");
        foreach (var directory in new[] { state, workspaceRoot, architectureRoot, selectedUi })
        {
            var info = new DirectoryInfo(directory);
            if (!info.Exists || (info.Attributes & FileAttributes.ReparsePoint) != 0)
                throw new InvalidDataException("Windows UI directory contains a reparse point or is missing.");
            var acl = info.GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access);
            if (acl.GetOwner(typeof(SecurityIdentifier)) is not SecurityIdentifier owner || !owner.Equals(sid))
                throw new InvalidDataException("Windows UI directory is not owned by the installing user.");
            foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, true, typeof(SecurityIdentifier)))
            {
                if (rule.AccessControlType != AccessControlType.Allow ||
                    rule.IdentityReference is not SecurityIdentifier permitted) continue;
                var privileged = permitted.Equals(sid) ||
                    permitted.IsWellKnown(WellKnownSidType.LocalSystemSid) ||
                    permitted.IsWellKnown(WellKnownSidType.BuiltinAdministratorsSid) ||
                    permitted.IsWellKnown(WellKnownSidType.CreatorOwnerSid);
                var writable = (rule.FileSystemRights & (
                    FileSystemRights.WriteData | FileSystemRights.CreateDirectories |
                    FileSystemRights.AppendData | FileSystemRights.Delete |
                    FileSystemRights.DeleteSubdirectoriesAndFiles | FileSystemRights.ChangePermissions |
                    FileSystemRights.TakeOwnership)) != 0;
                if (!privileged && writable)
                    throw new InvalidDataException("Windows UI directory grants unsafe write access to another principal.");
            }
        }
    }

    private void FocusVerifiedWindow()
    {
        if (_exe is null) return;
        foreach (var process in Process.GetProcessesByName("electron"))
        {
            using (process)
            {
                try
                {
                    if (process.MainWindowHandle == IntPtr.Zero ||
                        !string.Equals(process.MainModule?.FileName, _exe, StringComparison.OrdinalIgnoreCase))
                        continue;
                    _ = ShowWindow(process.MainWindowHandle, 9); // SW_RESTORE
                    _ = SetForegroundWindow(process.MainWindowHandle);
                    return;
                }
                catch (System.ComponentModel.Win32Exception) { }
                catch (InvalidOperationException) { }
            }
        }
    }

    internal async Task StopAsync()
    {
        await _lifecycle.WaitAsync().ConfigureAwait(false);
        try { await StopCoreAsync().ConfigureAwait(false); }
        finally { _lifecycle.Release(); }
    }

    private async Task StopCoreAsync()
    {
        var job = _job;
        _job = null;
        _exe = null;
        if (job is not null)
        {
            try { job.Terminate(143); } catch { }
            finally { job.Dispose(); }
        }
        var gate = _gate;
        _gate = null;
        if (gate is null) return;
        try
        {
            if (!gate.HasExited) await gate.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5)).ConfigureAwait(false);
        }
        catch { }
        finally { gate.Dispose(); }
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        await StopAsync().ConfigureAwait(false);
        _disposed = true;
        _lifecycle.Dispose();
    }

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ShowWindow(IntPtr hwnd, int showCommand);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetForegroundWindow(IntPtr hwnd);
}
