using System.Text.Json;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    // The ORIGINAL Guardian must independently authenticate the ROLLBACK A,
    // not only production-signed B, before creating any durable PREPARED
    // mutation-intent record. No Git/source receipt or guessed Stable
    // fallback may stand in for an already selected native Main A.
    // Nothing here shuts down WPF or changes the native/Chrome pointers.
    private static void InspectOriginalSignedNativePreviousABaseline(
        string transactionId, string bSha, string target, string contract)
    {
        InspectionPhase = "signed-native-previous-a-rollback-proof";
        var install = Path.Combine(Environment.GetFolderPath(
            Environment.SpecialFolder.LocalApplicationData), "Equinox Local");
        var root = Path.Combine(install, "state", "main-update");
        using var descriptorDoc = ReadOwnedTransitionRecord(Path.Combine(root,
            "staging", transactionId, "native-rollback", "native-recovery.json"), 8192);
        var descriptor = descriptorDoc.RootElement;
        RequireExactKeys(descriptor, ["schemaVersion", "channel", "targetSha", "target",
            "targetRuntimeContractSha256", "previous"]);
        if (descriptor.GetProperty("schemaVersion").GetInt32() != 1 ||
            descriptor.GetProperty("channel").GetString() != "main" ||
            descriptor.GetProperty("targetSha").GetString() != bSha ||
            descriptor.GetProperty("target").GetString() != target ||
            descriptor.GetProperty("targetRuntimeContractSha256").GetString() != contract)
            throw new InvalidDataException("Original previous A does not belong to signed B transaction.");
        var prior = descriptor.GetProperty("previous");
        var kind = prior.GetProperty("kind").GetString();
        var currentNative = Path.Combine(root, "current-native.json");
        string release;
        if (kind == "stable")
        {
            RequireExactKeys(prior, ["kind", "version"]);
            var version = prior.GetProperty("version").GetString() ?? "";
            if (!VersionRegex().IsMatch(version) ||
                File.Exists(currentNative) || Directory.Exists(currentNative))
                throw new InvalidDataException("Original Stable A was replaced by a Main native pointer.");
            // Original Stable baseline independently verifies its current
            // version/host and hashes the COMPLETE installed shell tree.
            InspectBaseline(allowActiveOrphanForReconciliation: true);
            using var stableDoc = ReadOwnedTransitionRecord(Path.Combine(
                install, "current-version.json"), 4096);
            var stable = stableDoc.RootElement;
            RequireExactKeys(stable, ["schemaVersion", "target", "version"]);
            if (stable.GetProperty("schemaVersion").GetInt32() != 1 ||
                stable.GetProperty("target").GetString() != target ||
                stable.GetProperty("version").GetString() != version)
                throw new InvalidDataException("Original Stable A changed after the signed B descriptor.");
            release = Path.Combine(install, "releases", version);
        }
        else if (kind == "main")
        {
            RequireExactKeys(prior, ["kind", "sourceSha", "target", "runtimeContractSha256"]);
            var aSha = prior.GetProperty("sourceSha").GetString() ?? "";
            var aContract = prior.GetProperty("runtimeContractSha256").GetString() ?? "";
            if (!SourceShaPattern.IsMatch(aSha) || aSha == bSha ||
                !DigestPattern.IsMatch(aContract) || prior.GetProperty("target").GetString() != target)
                throw new InvalidDataException("Prior native Main A is not distinct from B.");
            using var currentDoc = ReadOwnedTransitionRecord(currentNative, 8192);
            var current = currentDoc.RootElement;
            RequireExactKeys(current, ["schemaVersion", "channel", "sourceSha", "target", "runtimeContractSha256"]);
            if (current.GetProperty("schemaVersion").GetInt32() != 1 ||
                current.GetProperty("channel").GetString() != "main" ||
                current.GetProperty("sourceSha").GetString() != aSha ||
                current.GetProperty("target").GetString() != target ||
                current.GetProperty("runtimeContractSha256").GetString() != aContract)
                throw new InvalidDataException("Prior signed Main A pointer changed before prepare.");
            var payload = Path.Combine(root, "native-store", target, aSha);
            RequireNormalDirectory(payload);
            release = Path.Combine(payload, "release");
            RequireNormalDirectory(release);
            using var storeDoc = ReadOwnedTransitionRecord(Path.Combine(payload, "native-store.json"), 8192);
            var store = storeDoc.RootElement;
            RequireExactKeys(store, ["schemaVersion", "channel", "sourceSha", "target",
                "runtimeContractSha256", "artifactSha256", "artifactBytes", "payloadVersion", "releaseFingerprint"]);
            var signed = VerifyOriginalSignedNativeMainSelector(Path.Combine(payload,
                "signed-selector.json"), aSha, target);
            if (store.GetProperty("schemaVersion").GetInt32() != 1 ||
                store.GetProperty("channel").GetString() != "main" ||
                store.GetProperty("sourceSha").GetString() != aSha ||
                store.GetProperty("target").GetString() != target ||
                store.GetProperty("runtimeContractSha256").GetString() != aContract ||
                signed.Contract != aContract ||
                store.GetProperty("artifactSha256").GetString() != signed.ArtifactSha256 ||
                store.GetProperty("artifactBytes").GetInt64() != signed.ArtifactBytes ||
                store.GetProperty("payloadVersion").GetString() != signed.Version)
                throw new InvalidDataException("Previous Main A store is not original production-signed A.");
            using var releaseDoc = ReadOwnedTransitionRecord(Path.Combine(release, "release.json"), 16384);
            var metadata = releaseDoc.RootElement;
            if (metadata.GetProperty("schemaVersion").GetInt32() != 1 ||
                metadata.GetProperty("sourceSha").GetString() != aSha ||
                metadata.GetProperty("target").GetString() != target ||
                metadata.GetProperty("version").GetString() != signed.Version ||
                metadata.GetProperty("serverEntry").GetString() != "server.js")
                throw new InvalidDataException("Previous signed Main A release metadata is foreign.");
            var claim = store.GetProperty("releaseFingerprint");
            RequireExactKeys(claim, ["schemaVersion", "sha256", "entries", "bytes"]);
            var measured = FingerprintNativeMainRelease(release);
            if (claim.GetProperty("schemaVersion").GetInt32() != 1 ||
                claim.GetProperty("sha256").GetString() != measured.Sha256 ||
                claim.GetProperty("entries").GetInt64() != measured.Entries ||
                claim.GetProperty("bytes").GetInt64() != measured.Bytes)
                throw new InvalidDataException("Previous Main A full executable tree fingerprint was replaced.");
            InspectOriginalSignedWindowsArchive(Path.Combine(payload, "signed-artifact.zip"),
                release, signed.ArtifactSha256, signed.ArtifactBytes);
            // This is not the Git-mode InspectMainNativeIdentity: signed A
            // is admitted solely by the original production Ed25519 roots.
            CompareNativeTrees(Path.Combine(release, "runtime", "shell"), Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs", "Equinox Local"));
        }
        else throw new InvalidDataException("No previous Stable or signed Main A exists for rollback.");

        // Same HKCU Native Messaging registry + manifest and exact A-native
        // executable, not an arbitrary browser host or B launcher.
        InspectOwnedMainNativeMessaging(install, release);
        InspectionPhase = "signed-native-previous-a-fully-verified-no-mutation";
    }
}
