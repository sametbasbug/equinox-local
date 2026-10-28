using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace EquinoxLocal.WindowsShell;

/// <summary>Current-user Start menu / Installed Apps integration for the verified managed shell.</summary>
internal static class WindowsShellRegistration
{
    internal const string UninstallRegistryPath = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Equinox Local";
    private const string OwnershipMarker = "EquinoxLocalManagedInstall";
    private const string ShortcutFileName = "Equinox Local.lnk";

    internal static string ActiveDisplayVersion(WindowsRuntimeLocation active)
    {
        if (!active.ManagedSource)
        {
            // A full signed native Main install uses an immutable SHA path;
            // the manual display version comes from its already-audited B.
            if (Path.GetFileName(active.NativeReleaseDir) == "release" &&
                System.Text.RegularExpressions.Regex.IsMatch(
                    Path.GetFileName(Path.GetDirectoryName(active.NativeReleaseDir) ?? ""),
                    @"^[a-f0-9]{40}$"))
            {
                var metadata = System.Text.Json.JsonDocument.Parse(File.ReadAllText(
                    Path.Combine(active.NativeReleaseDir, "release.json"))).RootElement;
                var version = metadata.GetProperty("version").GetString() ?? "";
                if (!System.Text.RegularExpressions.Regex.IsMatch(version,
                    @"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$"))
                    throw new InvalidDataException("Signed Main display version is invalid.");
                return version;
            }
            var stable = Path.GetFileName(active.NativeReleaseDir);
            if (!System.Text.RegularExpressions.Regex.IsMatch(stable, @"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$"))
                throw new InvalidDataException("Stable display version is invalid.");
            return stable;
        }
        // Installed Apps must describe the running Git-verified Main source,
        // not its historical numbered Stable bootstrap or a reused native A.
        var versionFile = Path.Combine(active.SourceRoot, "src", "equinox-local-version.js");
        var info = new FileInfo(versionFile);
        if (!info.Exists || (info.Attributes & FileAttributes.ReparsePoint) != 0 ||
            info.Length is < 25 or > 1024)
            throw new InvalidDataException("Main source version declaration is unavailable or unsafe.");
        var declaration = File.ReadAllText(versionFile);
        var match = System.Text.RegularExpressions.Regex.Match(declaration,
            @"(?m)^export const EQUINOX_LOCAL_VERSION = ""((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))"";\r?$");
        if (!match.Success || System.Text.RegularExpressions.Regex.Matches(declaration, "EQUINOX_LOCAL_VERSION").Count != 1)
            throw new InvalidDataException("Main source version declaration is ambiguous.");
        return match.Groups[1].Value;
    }

    internal static void EnsureForActiveManagedShell()
    {
        var active = WindowsManagedSourceRuntimeLocator.Resolve();
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var expectedExe = Path.GetFullPath(Path.Combine(local, "Programs", "Equinox Local", "EquinoxLocal.exe"));
        var actualExe = Environment.ProcessPath ?? throw new InvalidDataException("Native shell executable path is unavailable.");
        if (!string.Equals(Path.GetFullPath(actualExe), expectedExe, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Cannot register an unmanaged or foreign Windows shell.");
        var executable = new FileInfo(expectedExe);
        if (!executable.Exists || (executable.Attributes & FileAttributes.ReparsePoint) != 0)
            throw new InvalidDataException("Managed Windows shell must be a normal installed executable.");

        var version = ActiveDisplayVersion(active);

        // The ARP record can be repaired on subsequent launches, but never
        // replace another product's registration under the same subkey.
        using (var existing = Registry.CurrentUser.OpenSubKey(UninstallRegistryPath, false))
        {
            if (existing is not null &&
                (existing.GetValue(OwnershipMarker) is not int marker || marker != 1 ||
                 !string.Equals(existing.GetValue("InstallLocation") as string, Path.GetDirectoryName(expectedExe), StringComparison.OrdinalIgnoreCase)))
                throw new InvalidDataException("Installed Apps registration is not owned by Equinox Local.");
        }
        using (var key = Registry.CurrentUser.CreateSubKey(UninstallRegistryPath, true)
            ?? throw new IOException("Could not register Equinox Local in Installed Apps."))
        {
            key.SetValue(OwnershipMarker, 1, RegistryValueKind.DWord);
            key.SetValue("DisplayName", "Equinox Local", RegistryValueKind.String);
            key.SetValue("DisplayVersion", version, RegistryValueKind.String);
            key.SetValue("Publisher", "Equinox Project", RegistryValueKind.String);
            key.SetValue("InstallLocation", Path.GetDirectoryName(expectedExe)!, RegistryValueKind.String);
            key.SetValue("DisplayIcon", expectedExe + ",0", RegistryValueKind.String);
            key.SetValue("UninstallString", $"\"{expectedExe}\" --uninstall", RegistryValueKind.String);
            key.SetValue("NoModify", 1, RegistryValueKind.DWord);
            key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
        }

        var programs = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
        if (string.IsNullOrWhiteSpace(programs)) throw new IOException("Current-user Start Menu is unavailable.");
        var shortcutPath = Path.Combine(programs, ShortcutFileName);
        if (File.Exists(shortcutPath) && (File.GetAttributes(shortcutPath) & FileAttributes.ReparsePoint) != 0)
            throw new InvalidDataException("Start Menu shortcut is a reparse point.");
        var shellType = Type.GetTypeFromProgID("WScript.Shell") ?? throw new IOException("Windows shortcut service unavailable.");
        dynamic shell = Activator.CreateInstance(shellType) ?? throw new IOException("Windows shortcut service could not start.");
        object? shortcutObject = null;
        try
        {
            dynamic shortcut = shell.CreateShortcut(shortcutPath);
            shortcutObject = shortcut;
            var existingTarget = File.Exists(shortcutPath) ? (string?)shortcut.TargetPath : null;
            if (!string.IsNullOrWhiteSpace(existingTarget) && !string.Equals(Path.GetFullPath(existingTarget), expectedExe, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("An unrelated Start Menu shortcut already uses the Equinox Local name.");
            shortcut.TargetPath = expectedExe;
            shortcut.WorkingDirectory = Path.GetDirectoryName(expectedExe)!;
            shortcut.IconLocation = expectedExe + ",0";
            shortcut.Description = "Open Equinox Local Control Center";
            shortcut.Save();
        }
        finally
        {
            if (shortcutObject is not null && Marshal.IsComObject(shortcutObject)) Marshal.FinalReleaseComObject(shortcutObject);
            if (Marshal.IsComObject(shell)) Marshal.FinalReleaseComObject(shell);
        }
    }
}
