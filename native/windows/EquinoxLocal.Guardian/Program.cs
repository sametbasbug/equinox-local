using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace EquinoxLocal.Guardian;

/// <summary>
/// Independent, per-user native launcher. Deliberately supports the verified
/// Stable WPF baseline only in this migration stage. Native Main switching
/// requires the separately audited journal/slot protocol and is fail-closed.
/// No network access, arbitrary executable, generic command or server.
/// </summary>
internal static partial class Program
{
    private const int MaxPointerBytes = 4 * 1024;
    private const int MaxReleaseBytes = 16 * 1024;
    private const int MaxShellEntries = 4000;
    private const long MaxShellBytes = 450L * 1024 * 1024;
    private static readonly StringComparer Compare = StringComparer.OrdinalIgnoreCase;

    [GeneratedRegex(@"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$", RegexOptions.CultureInvariant)]
    private static partial Regex VersionRegex();

    private static int Main(string[] args)
    {
        try
        {
            if (args.Length > 1 || (args.Length == 1 && args[0] is not ("--inspect" or "--startup" or "--uninstall")))
                throw new InvalidOperationException("Unsupported Guardian argument.");
            var inspection = InspectBaseline();
            if (args.Length == 1 && args[0] == "--inspect") return 0;
            using var process = Launch(inspection.Executable, args.Length == 0 ? null : args[0]);
            return process.Id > 0 ? 0 : 70;
        }
        catch (Exception ex)
        {
            // Only the explicit inspection mode exposes bounded, static
            // validation errors to the disposable installed-host acceptance.
            // Never echo paths from OS exceptions or launch arguments.
            if (args.Length == 1 && args[0] == "--inspect")
            {
                var reason = ex is InvalidDataException or InvalidOperationException or PlatformNotSupportedException
                    ? ex.Message : ex.GetType().Name;
                if (reason.Length > 120) reason = reason[..120];
                Console.Error.WriteLine("Guardian inspection refused: " + reason);
            }
            else Debug.WriteLine("Equinox Local Guardian refused launch: " + ex.GetType().Name);
            return 70;
        }
    }

    private sealed record VerifiedBaseline(string Executable);

    private static VerifiedBaseline InspectBaseline()
    {
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrWhiteSpace(local) || !Path.IsPathFullyQualified(local))
            throw new InvalidDataException("Current-user LocalAppData is unavailable.");
        var installRoot = Path.GetFullPath(Path.Combine(local, "Equinox Local"));
        var programRoot = Path.GetFullPath(Path.Combine(local, "Programs", "Equinox Local"));
        var guardianDir = Path.Combine(installRoot, "runtime", "guardian");
        var guardianPath = Path.Combine(guardianDir, "EquinoxLocalGuardian.exe");
        var actual = Environment.ProcessPath ?? throw new InvalidDataException("Guardian executable path unavailable.");
        if (!Compare.Equals(Path.GetFullPath(actual), guardianPath))
            throw new InvalidDataException("Guardian is outside its per-user immutable executable location.");
        RequireNormalDirectory(installRoot);
        RequireNormalDirectory(Path.Combine(installRoot, "runtime"));
        RequireNormalDirectory(guardianDir);
        RequireNormalFile(guardianPath);

        var transactionRoot = Path.Combine(installRoot, "state", "main-update");
        var updateLock = Path.Combine(transactionRoot, "active.json");
        if (File.Exists(updateLock) || Directory.Exists(updateLock))
            throw new InvalidDataException("A Main update requires exact journal reconciliation before Guardian launch.");
        var nativePointer = Path.Combine(transactionRoot, "current-native.json");
        if (File.Exists(nativePointer) || Directory.Exists(nativePointer))
            throw new InvalidDataException("Main native switching is not activated for the Stable-only Guardian.");
        var handoffDir = Path.Combine(transactionRoot, "handoff");
        if (Directory.Exists(handoffDir))
        {
            RequireNormalDirectory(handoffDir);
            // Any detached-worker trace requires explicit ownership recovery.
            if (Directory.EnumerateFileSystemEntries(handoffDir, "*.windows-worker.json").Any())
                throw new InvalidDataException("Detached native update worker ownership remains unresolved.");
        }

        var target = RuntimeInformation.ProcessArchitecture switch
        {
            Architecture.X64 => "win32-x64",
            Architecture.Arm64 => "win32-arm64",
            _ => throw new PlatformNotSupportedException("Unsupported Windows Guardian CPU target."),
        };
        var pointerPath = Path.Combine(installRoot, "current-version.json");
        using var pointerDoc = ReadJson(pointerPath, MaxPointerBytes);
        var pointer = pointerDoc.RootElement;
        RequireExactKeys(pointer, ["schemaVersion", "target", "version"]);
        if (pointer.GetProperty("schemaVersion").GetInt32() != 1 || pointer.GetProperty("target").GetString() != target)
            throw new InvalidDataException("Managed Stable pointer architecture mismatch.");
        var version = pointer.GetProperty("version").GetString();
        if (version is null || !VersionRegex().IsMatch(version))
            throw new InvalidDataException("Managed Stable version is not a safe directory name.");
        var releasesRoot = Path.Combine(installRoot, "releases");
        var release = Path.Combine(releasesRoot, version);
        RequireNormalDirectory(releasesRoot);
        RequireNormalDirectory(release);
        using var metadataDoc = ReadJson(Path.Combine(release, "release.json"), MaxReleaseBytes);
        var metadata = metadataDoc.RootElement;
        if (metadata.ValueKind != JsonValueKind.Object ||
            metadata.GetProperty("schemaVersion").GetInt32() != 1 ||
            metadata.GetProperty("target").GetString() != target ||
            metadata.GetProperty("version").GetString() != version ||
            metadata.GetProperty("serverEntry").GetString() != "server.js")
            throw new InvalidDataException("Signed baseline release identity mismatch.");
        var sourceShell = Path.Combine(release, "runtime", "shell");
        RequireNormalDirectory(sourceShell);
        RequireNormalDirectory(programRoot);
        CompareNativeTrees(sourceShell, programRoot);
        var executable = Path.Combine(programRoot, "EquinoxLocal.exe");
        RequireNormalFile(executable);
        return new VerifiedBaseline(executable);
    }

    private static JsonDocument ReadJson(string path, int limit)
    {
        RequireNormalFile(path);
        var info = new FileInfo(path);
        if (info.Length is < 2 or > MaxReleaseBytes || info.Length > limit)
            throw new InvalidDataException("Bounded managed release metadata is invalid.");
        return JsonDocument.Parse(File.ReadAllBytes(path));
    }

    private static void RequireExactKeys(JsonElement element, string[] keys)
    {
        if (element.ValueKind != JsonValueKind.Object)
            throw new InvalidDataException("Managed release pointer is not an object.");
        var actual = element.EnumerateObject().Select(property => property.Name).Order(StringComparer.Ordinal).ToArray();
        if (!actual.SequenceEqual(keys.Order(StringComparer.Ordinal), StringComparer.Ordinal))
            throw new InvalidDataException("Managed release pointer contains unsupported keys.");
    }

    private static void RequireNormalDirectory(string path)
    {
        var info = new DirectoryInfo(path);
        if (!info.Exists || (info.Attributes & FileAttributes.ReparsePoint) != 0)
            throw new InvalidDataException("Managed directory is missing or a reparse point.");
    }

    private static void RequireNormalFile(string path)
    {
        var info = new FileInfo(path);
        if (!info.Exists || (info.Attributes & FileAttributes.ReparsePoint) != 0)
            throw new InvalidDataException("Managed executable or metadata is missing or a reparse point.");
    }

    private static void CompareNativeTrees(string releaseShell, string installedShell)
    {
        var expected = Snapshot(releaseShell, false);
        var actual = Snapshot(installedShell, true);
        if (expected.Count != actual.Count) throw new InvalidDataException("Installed WPF tree differs from signed Stable baseline.");
        foreach (var (key, digest) in expected)
        {
            if (!actual.TryGetValue(key, out var installedDigest) || !CryptographicOperations.FixedTimeEquals(digest, installedDigest))
                throw new InvalidDataException("Installed native file does not match signed Stable baseline.");
        }
    }

    private static Dictionary<string, byte[]> Snapshot(string root, bool ignoreWebViewCache)
    {
        var result = new Dictionary<string, byte[]>(Compare);
        var pending = new Stack<string>();
        pending.Push(root);
        long bytes = 0;
        var directories = 0;
        while (pending.Count != 0)
        {
            var directory = pending.Pop();
            if (++directories > MaxShellEntries)
                throw new InvalidDataException("Managed WPF native directory tree exceeds its supported bound.");
            RequireNormalDirectory(directory);
            foreach (var entry in Directory.EnumerateFileSystemEntries(directory))
            {
                var relative = Path.GetRelativePath(root, entry);
                var name = Path.GetFileName(entry);
                var attributes = File.GetAttributes(entry);
                if ((attributes & FileAttributes.ReparsePoint) != 0)
                    throw new InvalidDataException("A managed WPF tree contains a reparse point.");
                if ((attributes & FileAttributes.Directory) != 0)
                {
                    if (ignoreWebViewCache && name.Equals("EquinoxLocal.exe.WebView2", StringComparison.OrdinalIgnoreCase) && directory == root)
                        continue;
                    pending.Push(entry);
                }
                else
                {
                    var info = new FileInfo(entry);
                    bytes = checked(bytes + info.Length);
                    if (bytes > MaxShellBytes || result.Count >= MaxShellEntries)
                        throw new InvalidDataException("Managed WPF native tree exceeds its supported bound.");
                    using var stream = File.OpenRead(entry);
                    result.Add(relative, SHA256.HashData(stream));
                }
            }
        }
        if (!result.ContainsKey("EquinoxLocal.exe") || !result.ContainsKey("coreclr.dll"))
            throw new InvalidDataException("Managed native WPF executable tree is incomplete.");
        return result;
    }

    private static Process Launch(string executable, string? arg)
    {
        var info = new ProcessStartInfo(executable)
        {
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(executable)!,
        };
        if (arg is not null) info.ArgumentList.Add(arg);
        return Process.Start(info) ?? throw new IOException("Verified WPF application could not start.");
    }
}
