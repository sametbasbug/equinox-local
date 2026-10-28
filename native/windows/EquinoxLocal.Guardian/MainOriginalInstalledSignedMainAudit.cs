using System.Runtime.InteropServices;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    // Read-only proof for the one-shot Main installer. The installer has
    // already replaced old product executables; there is no A/B handoff,
    // journal or rollback transaction to authorize at Windows WPF startup.
    private static void InspectOriginalInstalledSignedMain()
    {
        InspectionPhase = "installed-main-signed-release";
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var install = Path.Combine(local, "Equinox Local");
        var ownedGuardian = Path.Combine(install, "runtime", "guardian", "EquinoxLocalGuardian.exe");
        if (!Compare.Equals(Path.GetFullPath(Environment.ProcessPath ?? ""), Path.GetFullPath(ownedGuardian)))
            throw new InvalidDataException("Installed Main audit must use the original installed Guardian.");
        RequireNormalDirectory(install);
        RequireNormalFile(ownedGuardian);
        var root = Path.Combine(install, "state", "main-update");
        RequireNormalDirectory(root);
        if (Directory.EnumerateFileSystemEntries(root, "active.json", SearchOption.TopDirectoryOnly).Any())
            throw new InvalidDataException("Main executable replacement cannot boot with an active transaction.");
        var target = RuntimeInformation.ProcessArchitecture switch
        {
            Architecture.X64 => "win32-x64",
            Architecture.Arm64 => "win32-arm64",
            _ => throw new PlatformNotSupportedException("Main native host architecture is unsupported."),
        };
        using var pointerDoc = ReadOwnedTransitionRecord(Path.Combine(root, "current-native.json"), 8192);
        var pointer = pointerDoc.RootElement;
        RequireExactKeys(pointer, ["schemaVersion", "channel", "sourceSha", "target", "runtimeContractSha256"]);
        var sha = pointer.GetProperty("sourceSha").GetString() ?? "";
        var contract = pointer.GetProperty("runtimeContractSha256").GetString() ?? "";
        if (pointer.GetProperty("schemaVersion").GetInt32() != 1 ||
            pointer.GetProperty("channel").GetString() != "main" ||
            !SourceShaPattern.IsMatch(sha) ||
            pointer.GetProperty("target").GetString() != target ||
            !DigestPattern.IsMatch(contract))
            throw new InvalidDataException("Signed Main native pointer does not match this Windows host.");
        var store = Path.Combine(root, "native-store", target, sha);
        RequireNormalDirectory(store);
        var release = Path.Combine(store, "release");
        RequireNormalDirectory(release);
        using var storeDoc = ReadOwnedTransitionRecord(Path.Combine(store, "native-store.json"), 8192);
        var manifest = storeDoc.RootElement;
        RequireExactKeys(manifest, ["schemaVersion", "channel", "sourceSha", "target", "runtimeContractSha256",
            "artifactSha256", "artifactBytes", "payloadVersion", "releaseFingerprint"]);
        var signed = VerifyOriginalSignedNativeMainSelector(Path.Combine(store, "signed-selector.json"), sha, target);
        if (manifest.GetProperty("schemaVersion").GetInt32() != 1 ||
            manifest.GetProperty("channel").GetString() != "main" ||
            manifest.GetProperty("sourceSha").GetString() != sha ||
            manifest.GetProperty("target").GetString() != target ||
            manifest.GetProperty("runtimeContractSha256").GetString() != contract ||
            signed.Contract != contract ||
            manifest.GetProperty("artifactSha256").GetString() != signed.ArtifactSha256 ||
            manifest.GetProperty("artifactBytes").GetInt64() != signed.ArtifactBytes ||
            manifest.GetProperty("payloadVersion").GetString() != signed.Version)
            throw new InvalidDataException("Signed Main store does not match the production Ed25519 receipt.");
        using var releaseDoc = ReadOwnedTransitionRecord(Path.Combine(release, "release.json"), 16384);
        var metadata = releaseDoc.RootElement;
        if (metadata.GetProperty("schemaVersion").GetInt32() != 1 ||
            metadata.GetProperty("sourceSha").GetString() != sha ||
            metadata.GetProperty("target").GetString() != target ||
            metadata.GetProperty("version").GetString() != signed.Version ||
            metadata.GetProperty("serverEntry").GetString() != "server.js")
            throw new InvalidDataException("Signed Main release metadata differs from production SHA.");
        var claim = manifest.GetProperty("releaseFingerprint");
        RequireExactKeys(claim, ["schemaVersion", "sha256", "entries", "bytes"]);
        var measured = FingerprintNativeMainRelease(release);
        if (claim.GetProperty("schemaVersion").GetInt32() != 1 ||
            claim.GetProperty("sha256").GetString() != measured.Sha256 ||
            claim.GetProperty("entries").GetInt32() != measured.Entries ||
            claim.GetProperty("bytes").GetInt64() != measured.Bytes)
            throw new InvalidDataException("Installed Main files differ from their signed store fingerprint.");
        InspectOriginalSignedWindowsArchive(Path.Combine(store, "signed-artifact.zip"),
            release, signed.ArtifactSha256, signed.ArtifactBytes);
        InspectionPhase = "installed-main-production-signed-exact-files";
    }
}
