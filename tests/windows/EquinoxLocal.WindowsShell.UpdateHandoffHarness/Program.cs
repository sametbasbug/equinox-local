using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using EquinoxLocal.WindowsShell;

internal static class Program
{
    private const string Version = "99.98.97";

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string? name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsProcessInJob(IntPtr process, IntPtr job, [MarshalAs(UnmanagedType.Bool)] out bool result);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    public static async Task<int> Main()
    {
        var nodeSource = Environment.GetEnvironmentVariable("EQUINOX_TEST_NODE_EXE");
        if (string.IsNullOrWhiteSpace(nodeSource) || !File.Exists(nodeSource))
            throw new InvalidOperationException("EQUINOX_TEST_NODE_EXE must point to the real Windows node.exe.");

        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrWhiteSpace(localAppData)) throw new InvalidOperationException("LocalAppData is unavailable.");
        var installRoot = Path.Combine(localAppData, "Equinox Local");
        var releaseDir = Path.Combine(installRoot, "releases", Version);
        var markerPath = Path.Combine(releaseDir, "handoff-marker.json");
        if (Directory.Exists(releaseDir)) Directory.Delete(releaseDir, recursive: true);

        Process? runtime = null;
        Process? helper = null;
        var runtimeJob = IntPtr.Zero;
        var oldSecret = Environment.GetEnvironmentVariable("OPENAI_API_KEY");
        try
        {
            Directory.CreateDirectory(Path.Combine(releaseDir, "runtime", "node", "bin"));
            File.Copy(nodeSource, Path.Combine(releaseDir, "runtime", "node", "bin", "node.exe"));
            File.WriteAllText(Path.Combine(releaseDir, "release.json"), JsonSerializer.Serialize(new
            {
                schemaVersion = 1,
                version = Version,
                target = "win32-x64",
                serverEntry = "server.js",
            }));
            File.WriteAllText(Path.Combine(releaseDir, "equinox-local-update-helper.js"), """
const fs = require('node:fs');
const path = require('node:path');
const marker = path.join(process.cwd(), 'handoff-marker.json');
fs.writeFileSync(marker, JSON.stringify({
  pid: process.pid,
  cwd: process.cwd(),
  secretPresent: Object.prototype.hasOwnProperty.call(process.env, 'OPENAI_API_KEY'),
  releaseDir: process.env.EQUINOX_LOCAL_RELEASE_DIR || null,
  installRoot: process.env.EQUINOX_LOCAL_INSTALL_ROOT || null,
  pathValue: process.env.PATH || null,
}));
setTimeout(() => {}, 30000);
""");

            runtime = Process.Start(new ProcessStartInfo("cmd.exe", "/d /s /c ping -n 30 127.0.0.1 >NUL")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
            }) ?? throw new InvalidOperationException("Runtime fixture did not start.");
            runtimeJob = CreateJobObject(IntPtr.Zero, null);
            if (runtimeJob == IntPtr.Zero) throw new InvalidOperationException($"CreateJobObject failed: {Marshal.GetLastWin32Error()}");
            if (!AssignProcessToJobObject(runtimeJob, runtime.Handle))
                throw new InvalidOperationException($"AssignProcessToJobObject failed: {Marshal.GetLastWin32Error()}");
            if (!IsProcessInJob(runtime.Handle, runtimeJob, out var runtimeOwned) || !runtimeOwned)
                throw new InvalidOperationException("Runtime fixture is not owned by its Job Object.");

            Environment.SetEnvironmentVariable("OPENAI_API_KEY", "must-not-leak");
            var helperPid = ManagedUpdateHandoff.Launch(Version);
            helper = Process.GetProcessById(helperPid);
            if (!IsProcessInJob(helper.Handle, runtimeJob, out var helperInRuntimeJob))
                throw new InvalidOperationException($"IsProcessInJob failed: {Marshal.GetLastWin32Error()}");
            if (helperInRuntimeJob) throw new InvalidOperationException("Managed update helper inherited runtime Job Object ownership.");

            for (var attempt = 0; attempt < 50 && !File.Exists(markerPath); attempt += 1)
                await Task.Delay(100);
            if (!File.Exists(markerPath)) throw new InvalidOperationException("Managed update helper did not execute the marker fixture.");
            using var marker = JsonDocument.Parse(File.ReadAllBytes(markerPath));
            var root = marker.RootElement;
            if (root.GetProperty("pid").GetInt32() != helperPid) throw new InvalidOperationException("Marker PID mismatch.");
            if (!string.Equals(Path.GetFullPath(root.GetProperty("cwd").GetString()!), Path.GetFullPath(releaseDir), StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Managed update helper working directory mismatch.");
            if (root.GetProperty("secretPresent").GetBoolean()) throw new InvalidOperationException("Provider credential leaked into update helper.");
            if (!string.Equals(root.GetProperty("releaseDir").GetString(), releaseDir, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Managed update helper release environment mismatch.");
            if (!string.Equals(root.GetProperty("installRoot").GetString(), installRoot, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Managed update helper install environment mismatch.");
            var pathValue = root.GetProperty("pathValue").GetString() ?? "";
            var systemRoot = Environment.GetEnvironmentVariable("SystemRoot") ?? "";
            if (!pathValue.Contains(Path.Combine(systemRoot, "System32"), StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Managed update helper PATH does not contain bounded System32.");

            Console.WriteLine("Windows shell-owned update handoff acceptance passed: real node helper executed outside runtime Job Object with clean environment.");
            return 0;
        }
        finally
        {
            Environment.SetEnvironmentVariable("OPENAI_API_KEY", oldSecret);
            try { if (helper is { HasExited: false }) helper.Kill(entireProcessTree: true); } catch { }
            try { if (runtime is { HasExited: false }) runtime.Kill(entireProcessTree: true); } catch { }
            helper?.Dispose();
            runtime?.Dispose();
            if (runtimeJob != IntPtr.Zero) CloseHandle(runtimeJob);
            try { if (Directory.Exists(releaseDir)) Directory.Delete(releaseDir, recursive: true); } catch { }
        }
    }
}
