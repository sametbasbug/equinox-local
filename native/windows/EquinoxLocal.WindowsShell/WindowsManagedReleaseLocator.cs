using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace EquinoxLocal.WindowsShell;

internal sealed record WindowsReleaseLocation(string ReleaseDir, string? InstallRoot);

internal static partial class WindowsManagedReleaseLocator
{
    private static readonly string Target = RuntimeInformation.ProcessArchitecture switch
    {
        Architecture.X64 => "win32-x64",
        Architecture.Arm64 => "win32-arm64",
        _ => throw new PlatformNotSupportedException($"Unsupported Windows architecture: {RuntimeInformation.ProcessArchitecture}."),
    };
    private const long MaxPointerBytes = 4 * 1024;
    private const long MaxReleaseMetadataBytes = 16 * 1024;

    [GeneratedRegex(@"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$", RegexOptions.CultureInvariant)]
    private static partial Regex VersionPattern();

    internal static bool HasCurrentPointer()
    {
        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrWhiteSpace(localAppData)) return false;
        return File.Exists(Path.Combine(localAppData, "Equinox Local", "current-version.json"));
    }

    internal static WindowsReleaseLocation ResolveCurrentRelease()
    {
        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrWhiteSpace(localAppData))
            throw new InvalidDataException("LocalAppData is unavailable for the managed Equinox Local installation.");

        var installRoot = Path.GetFullPath(Path.Combine(localAppData, "Equinox Local"));
        var releasesRoot = Path.GetFullPath(Path.Combine(installRoot, "releases"));
        var pointerPath = Path.Combine(installRoot, "current-version.json");
        RejectReparsePoint(pointerPath, "current-version pointer");
        var pointerInfo = new FileInfo(pointerPath);
        if (!pointerInfo.Exists || pointerInfo.Length is < 1 or > MaxPointerBytes)
            throw new InvalidDataException("Managed current-version pointer has an invalid size.");

        using var pointerDocument = JsonDocument.Parse(File.ReadAllBytes(pointerPath));
        var pointer = pointerDocument.RootElement;
        RequireExactProperties(pointer, ["schemaVersion", "target", "version"], "current-version pointer");
        if (pointer.GetProperty("schemaVersion").GetInt32() != 1)
            throw new InvalidDataException("Unsupported current-version pointer schema.");
        if (!string.Equals(pointer.GetProperty("target").GetString(), Target, StringComparison.Ordinal))
            throw new InvalidDataException($"Managed current-version pointer target does not match {Target}.");
        var version = pointer.GetProperty("version").GetString();
        if (version is null || !VersionPattern().IsMatch(version))
            throw new InvalidDataException("Managed current-version pointer contains an invalid version.");

        return ResolveRelease(version, installRoot, releasesRoot);
    }

    internal static WindowsReleaseLocation ResolveRelease(string version)
    {
        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrWhiteSpace(localAppData))
            throw new InvalidDataException("LocalAppData is unavailable for the managed Equinox Local installation.");
        var installRoot = Path.GetFullPath(Path.Combine(localAppData, "Equinox Local"));
        var releasesRoot = Path.GetFullPath(Path.Combine(installRoot, "releases"));
        return ResolveRelease(version, installRoot, releasesRoot);
    }

    private static WindowsReleaseLocation ResolveRelease(string version, string installRoot, string releasesRoot)
    {
        if (!VersionPattern().IsMatch(version))
            throw new InvalidDataException("Managed Windows release version is invalid.");
        var releaseDir = Path.GetFullPath(Path.Combine(releasesRoot, version));
        if (!string.Equals(Path.GetDirectoryName(releaseDir), releasesRoot, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Managed release escaped the releases root.");
        RejectReparsePoint(releaseDir, "release directory");
        if (!Directory.Exists(releaseDir)) throw new InvalidDataException("Managed release directory is missing.");

        var releaseMetadataPath = Path.Combine(releaseDir, "release.json");
        RejectReparsePoint(releaseMetadataPath, "release metadata");
        var metadataInfo = new FileInfo(releaseMetadataPath);
        if (!metadataInfo.Exists || metadataInfo.Length is < 1 or > MaxReleaseMetadataBytes)
            throw new InvalidDataException("Managed release metadata has an invalid size.");
        using var metadataDocument = JsonDocument.Parse(File.ReadAllBytes(releaseMetadataPath));
        var metadata = metadataDocument.RootElement;
        if (metadata.ValueKind != JsonValueKind.Object
            || metadata.GetProperty("schemaVersion").GetInt32() != 1
            || !string.Equals(metadata.GetProperty("version").GetString(), version, StringComparison.Ordinal)
            || !string.Equals(metadata.GetProperty("target").GetString(), Target, StringComparison.Ordinal)
            || !string.Equals(metadata.GetProperty("serverEntry").GetString(), "server.js", StringComparison.Ordinal))
            throw new InvalidDataException("Managed release metadata does not match the requested Windows release.");

        return new WindowsReleaseLocation(releaseDir, installRoot);
    }

    private static void RequireExactProperties(JsonElement value, string[] expected, string label)
    {
        if (value.ValueKind != JsonValueKind.Object) throw new InvalidDataException($"Managed {label} must be a JSON object.");
        var actual = value.EnumerateObject().Select(property => property.Name).Order(StringComparer.Ordinal).ToArray();
        var wanted = expected.Order(StringComparer.Ordinal).ToArray();
        if (!actual.SequenceEqual(wanted, StringComparer.Ordinal))
            throw new InvalidDataException($"Managed {label} contains missing or unsupported fields.");
    }

    private static void RejectReparsePoint(string path, string label)
    {
        if (!File.Exists(path) && !Directory.Exists(path)) return;
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            throw new InvalidDataException($"Managed {label} must not be a reparse point.");
    }
}
