using System.Diagnostics;
using System.IO;

namespace EquinoxLocal.WindowsShell;

internal static class ManagedUninstallHandoff
{
    internal static int Launch(string mode)
    {
        if (!string.Equals(mode, "preserve-user-data", StringComparison.Ordinal)
            && !string.Equals(mode, "remove-user-data", StringComparison.Ordinal))
            throw new InvalidDataException("Managed uninstall mode is invalid.");

        var release = WindowsManagedReleaseLocator.ResolveCurrentRelease();
        var nodePath = RequireNormalFile(Path.Combine(release.ReleaseDir, "runtime", "node", "bin", "node.exe"), "managed Node runtime");
        var helperPath = RequireNormalFile(Path.Combine(release.ReleaseDir, "equinox-local-uninstall-helper.js"), "managed uninstall helper");
        var startup = new StartupRegistration();
        var startupBefore = startup.Read();
        if (startupBefore.State == StartupRegistrationState.Foreign)
            throw new InvalidDataException("Windows startup registration is foreign; refusing managed uninstall.");

        var startInfo = new ProcessStartInfo(nodePath) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = release.ReleaseDir };
        startInfo.ArgumentList.Add(helperPath);
        startInfo.ArgumentList.Add("--uninstall");
        startInfo.ArgumentList.Add($"--{mode}");
        startInfo.Environment.Clear();
        foreach (var name in new[] { "USERPROFILE", "LOCALAPPDATA", "SystemRoot", "WINDIR", "TEMP", "TMP" }) CopyEnvironment(startInfo, name);
        var systemRoot = Environment.GetEnvironmentVariable("SystemRoot");
        if (string.IsNullOrWhiteSpace(systemRoot)) throw new InvalidOperationException("SystemRoot is unavailable for the managed uninstall handoff.");
        startInfo.Environment["PATH"] = $"{Path.Combine(systemRoot, "System32")};{systemRoot}";
        if (release.InstallRoot is null) throw new InvalidDataException("Managed uninstall install root is unavailable.");
        startInfo.Environment["EQUINOX_LOCAL_INSTALL_ROOT"] = release.InstallRoot;
        startInfo.Environment["EQUINOX_LOCAL_RELEASE_DIR"] = release.ReleaseDir;
        startInfo.Environment["EQUINOX_LOCAL_UNINSTALL_SHELL_PID"] = Environment.ProcessId.ToString(System.Globalization.CultureInfo.InvariantCulture);

        startInfo.Environment["EQUINOX_LOCAL_EXPECTED_STARTUP_COMMAND"] = startup.ExpectedCommand;
        using var process = Process.Start(startInfo) ?? throw new InvalidOperationException("Managed uninstall helper did not start.");
        return process.Id;
    }

    private static string RequireNormalFile(string filePath, string label)
    {
        var fullPath = Path.GetFullPath(filePath);
        var info = new FileInfo(fullPath);
        if (!info.Exists || (info.Attributes & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException($"Windows {label} is missing or unsafe.");
        return fullPath;
    }

    private static void CopyEnvironment(ProcessStartInfo startInfo, string name)
    {
        var value = Environment.GetEnvironmentVariable(name);
        if (!string.IsNullOrWhiteSpace(value)) startInfo.Environment[name] = value;
    }
}
