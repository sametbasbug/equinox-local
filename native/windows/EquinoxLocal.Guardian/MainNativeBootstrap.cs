using System.Text.Json;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    // One exact runtime for the WPF handoff and independently audited Guardian
    // worker. A committed Main native store replaces the original numbered
    // Stable bootstrap; requiring releases/<old> would prevent safe GC.
    private static string ResolveOwnedMainWorkerNodePath(string install, string target)
    {
        var main = Path.Combine(install, "state", "main-update");
        var pointerPath = Path.Combine(main, "current-native.json");
        if (File.Exists(pointerPath))
        {
            InspectionPhase = "main-worker-active-native-pointer";
            RequireNormalDirectory(main);
            using var document = ReadJson(pointerPath, 8192);
            var pointer = document.RootElement;
            RequireExactKeys(pointer, ["schemaVersion", "channel", "sourceSha", "target", "runtimeContractSha256"]);
            var sha = pointer.GetProperty("sourceSha").GetString() ?? "";
            var contract = pointer.GetProperty("runtimeContractSha256").GetString() ?? "";
            if (pointer.GetProperty("schemaVersion").GetInt32() != 1 ||
                pointer.GetProperty("channel").GetString() != "main" ||
                pointer.GetProperty("target").GetString() != target ||
                !SourceShaPattern.IsMatch(sha) || !DigestPattern.IsMatch(contract))
                throw new InvalidDataException("Main worker native pointer does not belong to the active signed source.");

            var store = Path.Combine(main, "native-store");
            var arch = Path.Combine(store, target);
            var payload = Path.Combine(arch, sha);
            RequireNormalDirectory(store);
            RequireNormalDirectory(arch);
            RequireNormalDirectory(payload);
            using var manifestDoc = ReadJson(Path.Combine(payload, "native-store.json"), 8192);
            var manifest = manifestDoc.RootElement;
            RequireExactKeys(manifest, ["schemaVersion", "channel", "sourceSha", "target",
                "runtimeContractSha256", "artifactSha256", "artifactBytes",
                "payloadVersion", "releaseFingerprint"]);
            if (manifest.GetProperty("schemaVersion").GetInt32() != 1 ||
                manifest.GetProperty("channel").GetString() != "main" ||
                manifest.GetProperty("sourceSha").GetString() != sha ||
                manifest.GetProperty("target").GetString() != target ||
                manifest.GetProperty("runtimeContractSha256").GetString() != contract)
                throw new InvalidDataException("Main worker native payload identity does not match its active pointer.");
            var native = Path.Combine(payload, "release");
            RequireNormalDirectory(native);
            RequireNormalDirectory(Path.Combine(native, "runtime"));
            RequireNormalDirectory(Path.Combine(native, "runtime", "node"));
            RequireNormalDirectory(Path.Combine(native, "runtime", "node", "bin"));
            var node = Path.Combine(native, "runtime", "node", "bin", "node.exe");
            RequireNormalFile(node);
            return node;
        }

        // Only first-install/Main-before-native-commit can legitimately use
        // the numbered Stable bootstrap. Do not fall back when a Main native
        // pointer exists but is malformed, missing or foreign.
        InspectionPhase = "main-worker-stable-bootstrap";
        using var stablePointer = ReadJson(Path.Combine(install, "current-version.json"), MaxPointerBytes);
        var stable = stablePointer.RootElement;
        RequireExactKeys(stable, ["schemaVersion", "version", "target"]);
        if (stable.GetProperty("schemaVersion").GetInt32() != 1 ||
            stable.GetProperty("target").GetString() != target)
            throw new InvalidDataException("Native worker baseline pointer target has drifted.");
        var version = stable.GetProperty("version").GetString() ?? "";
        if (!VersionRegex().IsMatch(version))
            throw new InvalidDataException("Native worker baseline version is not canonical.");
        var releases = Path.Combine(install, "releases");
        var release = Path.Combine(releases, version);
        RequireNormalDirectory(releases);
        RequireNormalDirectory(release);
        var stableRuntime = Path.Combine(release, "runtime");
        RequireNormalDirectory(stableRuntime);
        RequireNormalDirectory(Path.Combine(stableRuntime, "node"));
        RequireNormalDirectory(Path.Combine(stableRuntime, "node", "bin"));
        var oldNode = Path.Combine(stableRuntime, "node", "bin", "node.exe");
        RequireNormalFile(oldNode);
        return oldNode;
    }
}
