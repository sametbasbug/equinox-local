using System.Diagnostics;
using System.IO;

namespace EquinoxLocal.WindowsShell;

internal static class ManagedUpdateHandoff
{
    internal static int Launch(string version)
    {
        var release = WindowsManagedReleaseLocator.ResolveRelease(version);
        var nodePath = RequireNormalFile(Path.Combine(release.ReleaseDir, "runtime", "node", "bin", "node.exe"), "managed Node runtime");
        var helperPath = RequireNormalFile(Path.Combine(release.ReleaseDir, "equinox-local-update-helper.js"), "managed update helper");
        var startInfo = new ProcessStartInfo(nodePath)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = release.ReleaseDir,
        };
        startInfo.ArgumentList.Add(helperPath);
        startInfo.ArgumentList.Add("--activate");
        startInfo.ArgumentList.Add(version);
        startInfo.Environment.Clear();
        CopyEnvironment(startInfo, "USERPROFILE");
        CopyEnvironment(startInfo, "LOCALAPPDATA");
        CopyEnvironment(startInfo, "SystemRoot");
        CopyEnvironment(startInfo, "WINDIR");
        var systemRoot = Environment.GetEnvironmentVariable("SystemRoot");
        if (string.IsNullOrWhiteSpace(systemRoot)) throw new InvalidOperationException("SystemRoot is unavailable for the managed update handoff.");
        startInfo.Environment["PATH"] = $"{Path.Combine(systemRoot, "System32")};{systemRoot}";
        CopyEnvironment(startInfo, "TEMP");
        CopyEnvironment(startInfo, "TMP");
        if (release.InstallRoot is not null) startInfo.Environment["EQUINOX_LOCAL_INSTALL_ROOT"] = release.InstallRoot;
        startInfo.Environment["EQUINOX_LOCAL_RELEASE_DIR"] = release.ReleaseDir;
        using var process = Process.Start(startInfo) ?? throw new InvalidOperationException("Managed update helper did not start.");
        return process.Id;
    }

    private static string RequireNormalFile(string filePath, string label)
    {
        var fullPath = Path.GetFullPath(filePath);
        var info = new FileInfo(fullPath);
        if (!info.Exists || (info.Attributes & FileAttributes.ReparsePoint) != 0)
            throw new InvalidDataException($"Windows {label} is missing or unsafe.");
        return fullPath;
    }

    private static void CopyEnvironment(ProcessStartInfo startInfo, string name)
    {
        var value = Environment.GetEnvironmentVariable(name);
        if (!string.IsNullOrWhiteSpace(value)) startInfo.Environment[name] = value;
    }
}
