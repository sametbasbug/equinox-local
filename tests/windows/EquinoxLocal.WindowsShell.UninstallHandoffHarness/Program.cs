using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using EquinoxLocal.WindowsShell;

internal static class Program
{
    private const string Version = "99.98.96";

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
        var target = RuntimeInformation.ProcessArchitecture switch
        {
            Architecture.X64 => "win32-x64",
            Architecture.Arm64 => "win32-arm64",
            _ => throw new PlatformNotSupportedException($"Unsupported uninstall handoff harness architecture: {RuntimeInformation.ProcessArchitecture}"),
        };

        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrWhiteSpace(localAppData)) throw new InvalidOperationException("LocalAppData is unavailable.");
        var installRoot = Path.Combine(localAppData, "Equinox Local");
        var releasesRoot = Path.Combine(installRoot, "releases");
        var releaseDir = Path.Combine(releasesRoot, Version);
        var currentPointer = Path.Combine(installRoot, "current-version.json");
        var markerPath = Path.Combine(releaseDir, "uninstall-handoff-marker.json");
        if (File.Exists(installRoot) || (Directory.Exists(installRoot) && !ContainsOnlyEmptyDirectories(installRoot)))
            throw new InvalidOperationException($"Uninstall handoff harness refuses non-empty or reparse-point per-user Equinox Local state; residue={DescribeInstallRootResidue(installRoot)}.");

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
                target,
                serverEntry = "server.js",
            }));
            File.WriteAllText(currentPointer, JsonSerializer.Serialize(new { schemaVersion = 1, target, version = Version }));
            File.WriteAllText(Path.Combine(releaseDir, "equinox-local-uninstall-helper.js"), """
const fs = require('node:fs');
const path = require('node:path');
const marker = path.join(process.cwd(), 'uninstall-handoff-marker.json');
fs.writeFileSync(marker, JSON.stringify({
  pid: process.pid,
  cwd: process.cwd(),
  argv: process.argv.slice(2),
  secretPresent: Object.prototype.hasOwnProperty.call(process.env, 'OPENAI_API_KEY'),
  releaseDir: process.env.EQUINOX_LOCAL_RELEASE_DIR || null,
  installRoot: process.env.EQUINOX_LOCAL_INSTALL_ROOT || null,
  shellPid: process.env.EQUINOX_LOCAL_UNINSTALL_SHELL_PID || null,
  startupCommand: process.env.EQUINOX_LOCAL_EXPECTED_STARTUP_COMMAND || null,
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
            var helperPid = ManagedUninstallHandoff.Launch("preserve-user-data");
            helper = Process.GetProcessById(helperPid);
            if (!IsProcessInJob(helper.Handle, runtimeJob, out var helperInRuntimeJob))
                throw new InvalidOperationException($"IsProcessInJob failed: {Marshal.GetLastWin32Error()}");
            if (helperInRuntimeJob) throw new InvalidOperationException("Managed uninstall helper inherited runtime Job Object ownership.");

            for (var attempt = 0; attempt < 50 && !File.Exists(markerPath); attempt += 1)
                await Task.Delay(100);
            if (!File.Exists(markerPath)) throw new InvalidOperationException("Managed uninstall helper did not execute the marker fixture.");
            using var marker = JsonDocument.Parse(File.ReadAllBytes(markerPath));
            var root = marker.RootElement;
            if (root.GetProperty("pid").GetInt32() != helperPid) throw new InvalidOperationException("Marker PID mismatch.");
            if (!string.Equals(Path.GetFullPath(root.GetProperty("cwd").GetString()!), Path.GetFullPath(releaseDir), StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Managed uninstall helper working directory mismatch.");
            if (root.GetProperty("secretPresent").GetBoolean()) throw new InvalidOperationException("Provider credential leaked into uninstall helper.");
            if (!string.Equals(root.GetProperty("releaseDir").GetString(), releaseDir, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Managed uninstall helper release environment mismatch.");
            if (!string.Equals(root.GetProperty("installRoot").GetString(), installRoot, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Managed uninstall helper install environment mismatch.");
            if (!string.Equals(root.GetProperty("shellPid").GetString(), Environment.ProcessId.ToString(), StringComparison.Ordinal))
                throw new InvalidOperationException("Managed uninstall helper shell PID mismatch.");
            if (string.IsNullOrWhiteSpace(root.GetProperty("startupCommand").GetString()))
                throw new InvalidOperationException("Managed uninstall helper expected startup ownership is missing.");
            var argv = root.GetProperty("argv").EnumerateArray().Select(value => value.GetString()).ToArray();
            if (argv.Length != 2 || argv[0] != "--uninstall" || argv[1] != "--preserve-user-data")
                throw new InvalidOperationException("Managed uninstall helper data policy arguments are invalid.");
            var pathValue = root.GetProperty("pathValue").GetString() ?? "";
            var systemRoot = Environment.GetEnvironmentVariable("SystemRoot") ?? "";
            if (!pathValue.Contains(Path.Combine(systemRoot, "System32"), StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Managed uninstall helper PATH does not contain bounded System32.");

            Console.WriteLine($"Windows {target} shell-owned uninstall handoff acceptance passed: real node helper executed outside runtime Job Object with clean environment and exact data policy.");
            return 0;
        }
        finally
        {
            Environment.SetEnvironmentVariable("OPENAI_API_KEY", oldSecret);
            try
            {
                if (helper is { HasExited: false }) helper.Kill(entireProcessTree: true);
                helper?.WaitForExit(5_000);
            }
            catch { }
            try
            {
                if (runtime is { HasExited: false }) runtime.Kill(entireProcessTree: true);
                runtime?.WaitForExit(5_000);
            }
            catch { }
            helper?.Dispose();
            runtime?.Dispose();
            if (runtimeJob != IntPtr.Zero) CloseHandle(runtimeJob);
            try { if (Directory.Exists(releaseDir)) Directory.Delete(releaseDir, recursive: true); } catch { }
            try { PruneEmptyDirectories(installRoot); } catch { }
        }
    }


    private static string DescribeInstallRootResidue(string root)
    {
        if (File.Exists(root)) return "file:root";
        if (!Directory.Exists(root)) return "missing";
        var entries = new List<string>();
        Walk(new DirectoryInfo(root), 0);
        return entries.Count == 0 ? "empty" : string.Join(",", entries);

        void Walk(DirectoryInfo directory, int depth)
        {
            if (depth > 3 || entries.Count >= 16) return;
            foreach (var entry in directory.EnumerateFileSystemInfos().OrderBy(item => item.Name, StringComparer.OrdinalIgnoreCase))
            {
                if (entries.Count >= 16) break;
                var relative = Path.GetRelativePath(root, entry.FullName).Replace('\\', '/');
                var safe = new string(relative.Select(ch => char.IsLetterOrDigit(ch) || ch is '.' or '-' or '_' or '/' ? ch : '?').Take(120).ToArray());
                var reparse = (entry.Attributes & FileAttributes.ReparsePoint) != 0;
                var kind = reparse ? "reparse" : entry is DirectoryInfo ? "dir" : "file";
                entries.Add($"{kind}:{safe}");
                if (!reparse && entry is DirectoryInfo child && depth < 3) Walk(child, depth + 1);
            }
        }
    }

    private static bool ContainsOnlyEmptyDirectories(string root)
    {
        var info = new DirectoryInfo(root);
        if ((info.Attributes & FileAttributes.ReparsePoint) != 0) return false;
        foreach (var entry in info.EnumerateFileSystemInfos())
        {
            if ((entry.Attributes & FileAttributes.ReparsePoint) != 0 || entry is not DirectoryInfo directory) return false;
            if (!ContainsOnlyEmptyDirectories(directory.FullName)) return false;
        }
        return true;
    }

    private static void PruneEmptyDirectories(string root)
    {
        if (!Directory.Exists(root)) return;
        var info = new DirectoryInfo(root);
        if ((info.Attributes & FileAttributes.ReparsePoint) != 0) return;
        foreach (var directory in info.EnumerateDirectories().ToArray()) PruneEmptyDirectories(directory.FullName);
        if (!info.EnumerateFileSystemInfos().Any()) info.Delete();
    }
}
