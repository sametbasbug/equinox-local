using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace EquinoxLocal.WindowsShell;

internal sealed record WindowsRuntimeLocation(
    string NativeReleaseDir,
    string SourceRoot,
    string ServerPath,
    string BootstrapReleaseDir,
    string InstallRoot,
    bool ManagedSource);

internal static partial class WindowsManagedSourceRuntimeLocator
{
    private const long MaxStateBytes = 16 * 1024;
    private static readonly string Target = RuntimeInformation.ProcessArchitecture switch
    {
        Architecture.X64 => "win32-x64",
        Architecture.Arm64 => "win32-arm64",
        _ => throw new PlatformNotSupportedException($"Unsupported Windows architecture: {RuntimeInformation.ProcessArchitecture}."),
    };

    [GeneratedRegex(@"^[a-f0-9]{40}$", RegexOptions.CultureInvariant)]
    private static partial Regex ShaPattern();

    [GeneratedRegex(@"^[a-f0-9]{64}$", RegexOptions.CultureInvariant)]
    private static partial Regex DigestPattern();

    internal static WindowsRuntimeLocation Resolve()
    {
        var stable = WindowsManagedReleaseLocator.ResolveCurrentRelease();
        var installRoot = stable.InstallRoot
            ?? throw new InvalidDataException("Managed installation root is unavailable.");
        var transactionRoot = Path.GetFullPath(Path.Combine(installRoot, "state", "main-update"));
        var installStampPath = Path.Combine(transactionRoot, "install.json");
        if (!File.Exists(installStampPath))
        {
            return new WindowsRuntimeLocation(
                stable.ReleaseDir,
                stable.ReleaseDir,
                Path.Combine(stable.ReleaseDir, "server.js"),
                stable.ReleaseDir,
                installRoot,
                ManagedSource: false);
        }

        RequireNormalDirectory(transactionRoot, "Main update state directory");
        ValidateInstallStamp(installStampPath);

        var sourcePointerPath = Path.Combine(transactionRoot, "current-source.conf");
        var sourcePointer = ReadSourcePointer(sourcePointerPath);
        var sourcesRoot = Path.GetFullPath(Path.Combine(transactionRoot, "sources"));
        RequireNormalDirectory(sourcesRoot, "Main source store");
        var sourceRoot = Path.GetFullPath(sourcePointer.SourceRoot);
        var expectedSourceRoot = Path.GetFullPath(Path.Combine(sourcesRoot, sourcePointer.Sha));
        if (!string.Equals(sourceRoot, expectedSourceRoot, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Main source pointer escaped the canonical source store.");
        RequireNormalDirectory(sourceRoot, "Main source root");
        var serverPath = RequireNormalFile(Path.Combine(sourceRoot, "src", "server.js"), "Main source server");
        _ = RequireNormalFile(Path.Combine(sourceRoot, "package.json"), "Main source package metadata");
        RequireNormalDirectory(Path.Combine(sourceRoot, "node_modules"), "Main source node_modules");

        var nativeReleaseDir = stable.ReleaseDir;
        var nativePointerPath = Path.Combine(transactionRoot, "current-native.json");
        if (File.Exists(nativePointerPath))
            nativeReleaseDir = ResolveNativeRelease(transactionRoot, nativePointerPath);

        return new WindowsRuntimeLocation(
            nativeReleaseDir,
            sourceRoot,
            serverPath,
            stable.ReleaseDir,
            installRoot,
            ManagedSource: true);
    }

    private static string ResolveNativeRelease(string transactionRoot, string pointerPath)
    {
        var pointer = ReadJson(pointerPath, "Main native pointer");
        RequireExactProperties(pointer, ["schemaVersion", "channel", "sourceSha", "target", "runtimeContractSha256"], "Main native pointer");
        RequireInt(pointer, "schemaVersion", 1, "Main native pointer");
        RequireString(pointer, "channel", "main", "Main native pointer");
        RequireString(pointer, "target", Target, "Main native pointer");
        var sourceSha = RequireSha(pointer, "sourceSha", "Main native pointer");
        var runtimeContract = RequireDigest(pointer, "runtimeContractSha256", "Main native pointer");

        var payloadRoot = Path.GetFullPath(Path.Combine(transactionRoot, "native-store", Target, sourceSha));
        var expectedTargetRoot = Path.GetFullPath(Path.Combine(transactionRoot, "native-store", Target));
        if (!string.Equals(Path.GetDirectoryName(payloadRoot), expectedTargetRoot, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Main native payload escaped the canonical native store.");
        RequireNormalDirectory(payloadRoot, "Main native payload");

        var manifest = ReadJson(Path.Combine(payloadRoot, "native-store.json"), "Main native store manifest");
        RequireExactProperties(manifest, [
            "schemaVersion", "channel", "sourceSha", "target", "runtimeContractSha256",
            "artifactSha256", "artifactBytes", "payloadVersion", "releaseFingerprint"
        ], "Main native store manifest");
        RequireInt(manifest, "schemaVersion", 1, "Main native store manifest");
        RequireString(manifest, "channel", "main", "Main native store manifest");
        RequireString(manifest, "sourceSha", sourceSha, "Main native store manifest");
        RequireString(manifest, "target", Target, "Main native store manifest");
        RequireString(manifest, "runtimeContractSha256", runtimeContract, "Main native store manifest");

        var releaseDir = Path.GetFullPath(Path.Combine(payloadRoot, "release"));
        if (!string.Equals(Path.GetDirectoryName(releaseDir), payloadRoot, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Main native release escaped its payload root.");
        RequireNormalDirectory(releaseDir, "Main native release");
        return releaseDir;
    }

    private static (string SourceRoot, string Sha) ReadSourcePointer(string pointerPath)
    {
        var text = ReadText(pointerPath, "Main source pointer", 8 * 1024);
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var raw in text.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
        {
            var index = raw.IndexOf('=');
            if (index <= 0) throw new InvalidDataException("Main source pointer is malformed.");
            var key = raw[..index];
            var value = raw[(index + 1)..];
            if (key is not ("schemaVersion" or "sourceRoot" or "sha") || !values.TryAdd(key, value))
                throw new InvalidDataException("Main source pointer contains unsupported or duplicate fields.");
        }
        if (values.Count != 3 || values["schemaVersion"] != "1")
            throw new InvalidDataException("Main source pointer schema is invalid.");
        var sourceRoot = values["sourceRoot"];
        if (!Path.IsPathFullyQualified(sourceRoot) || sourceRoot.IndexOfAny(['\r', '\n', '\0']) >= 0)
            throw new InvalidDataException("Main source pointer sourceRoot is invalid.");
        var sha = values["sha"];
        if (!ShaPattern().IsMatch(sha)) throw new InvalidDataException("Main source pointer SHA is invalid.");
        return (Path.GetFullPath(sourceRoot), sha);
    }

    private static void ValidateInstallStamp(string stampPath)
    {
        var stamp = ReadJson(stampPath, "managed-source install stamp");
        RequireExactProperties(stamp, ["schemaVersion", "channel", "repository", "branch", "bootstrapSha"], "managed-source install stamp");
        RequireInt(stamp, "schemaVersion", 1, "managed-source install stamp");
        RequireString(stamp, "channel", "main", "managed-source install stamp");
        RequireString(stamp, "repository", "sametbasbug/equinox-local", "managed-source install stamp");
        RequireString(stamp, "branch", "main", "managed-source install stamp");
        _ = RequireSha(stamp, "bootstrapSha", "managed-source install stamp");
    }

    private static JsonElement ReadJson(string filePath, string label)
    {
        var text = ReadText(filePath, label, MaxStateBytes);
        using var document = JsonDocument.Parse(text);
        if (document.RootElement.ValueKind != JsonValueKind.Object)
            throw new InvalidDataException($"{label} must be a JSON object.");
        return document.RootElement.Clone();
    }

    private static string ReadText(string filePath, string label, long maxBytes)
    {
        var path = RequireNormalFile(filePath, label);
        var info = new FileInfo(path);
        if (info.Length is < 1 || info.Length > maxBytes)
            throw new InvalidDataException($"{label} has an invalid size.");
        return File.ReadAllText(path);
    }

    private static string RequireNormalFile(string filePath, string label)
    {
        var fullPath = Path.GetFullPath(filePath);
        var info = new FileInfo(fullPath);
        if (!info.Exists || (info.Attributes & FileAttributes.ReparsePoint) != 0)
            throw new InvalidDataException($"{label} is missing or unsafe.");
        return fullPath;
    }

    private static string RequireNormalDirectory(string directoryPath, string label)
    {
        var fullPath = Path.GetFullPath(directoryPath);
        var info = new DirectoryInfo(fullPath);
        if (!info.Exists || (info.Attributes & FileAttributes.ReparsePoint) != 0)
            throw new InvalidDataException($"{label} is missing or unsafe.");
        return fullPath;
    }

    private static void RequireExactProperties(JsonElement value, string[] expected, string label)
    {
        var actual = value.EnumerateObject().Select(property => property.Name).Order(StringComparer.Ordinal).ToArray();
        var wanted = expected.Order(StringComparer.Ordinal).ToArray();
        if (!actual.SequenceEqual(wanted, StringComparer.Ordinal))
            throw new InvalidDataException($"{label} contains missing or unsupported fields.");
    }

    private static void RequireInt(JsonElement value, string name, int expected, string label)
    {
        if (!value.TryGetProperty(name, out var property) || property.ValueKind != JsonValueKind.Number || property.GetInt32() != expected)
            throw new InvalidDataException($"{label} {name} is invalid.");
    }

    private static void RequireString(JsonElement value, string name, string expected, string label)
    {
        if (!value.TryGetProperty(name, out var property) || property.ValueKind != JsonValueKind.String
            || !string.Equals(property.GetString(), expected, StringComparison.Ordinal))
            throw new InvalidDataException($"{label} {name} is invalid.");
    }

    private static string RequireSha(JsonElement value, string name, string label)
    {
        if (!value.TryGetProperty(name, out var property) || property.ValueKind != JsonValueKind.String)
            throw new InvalidDataException($"{label} {name} is invalid.");
        var result = property.GetString();
        if (result is null || !ShaPattern().IsMatch(result))
            throw new InvalidDataException($"{label} {name} is invalid.");
        return result;
    }

    private static string RequireDigest(JsonElement value, string name, string label)
    {
        if (!value.TryGetProperty(name, out var property) || property.ValueKind != JsonValueKind.String)
            throw new InvalidDataException($"{label} {name} is invalid.");
        var result = property.GetString();
        if (result is null || !DigestPattern().IsMatch(result))
            throw new InvalidDataException($"{label} {name} is invalid.");
        return result;
    }
}
