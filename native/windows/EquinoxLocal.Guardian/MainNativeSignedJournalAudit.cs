using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.Json;
using EquinoxLocal.NativeShared;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    private static string ResolveSignedNativeBNodeForReadOnlyAudit(
        string transactionRoot, string transactionId, string target)
    {
        using var activeDoc = ReadOwnedTransitionRecord(Path.Combine(
            transactionRoot, "active.json"), 8192);
        var active = activeDoc.RootElement;
        RequireExactKeys(active, ["schemaVersion", "kind", "transactionId",
            "sourceSha", "target", "runtimeContractSha256"]);
        if (active.GetProperty("schemaVersion").GetInt32() != 1 ||
            active.GetProperty("kind").GetString() != "signed-native" ||
            active.GetProperty("transactionId").GetString() != transactionId ||
            active.GetProperty("target").GetString() != target)
            throw new InvalidDataException("Original signed-native worker does not own an exact transaction.");
        var sha = active.GetProperty("sourceSha").GetString() ?? "";
        var expected = MainSignedNativeWorkerContract.ForSignedNativeB(
            transactionId, sha, target, transactionRoot);
        MainSignedNativeWorkerContract.ValidateOriginalReleaseFiles(expected);
        return expected.NodePath;
    }

    // Separate READ-ONLY grammar for original production-signed, Git-free
    // Main records. NEVER call this from the original Git journal authority,
    // native journal lease, worker identity, shell quiesce or slot mutation.
    // Production Ed25519 is verified independently, but this read-only
    // audit remains insufficient for a native OS Guardian mutation grant.
    private static void InspectOwnedSignedNativeJournalWithoutGrant()
    {
        InspectionPhase = "signed-native-journal-owned-guardian";
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrWhiteSpace(local) || !Path.IsPathFullyQualified(local))
            throw new InvalidDataException("Original native audit has no Windows user profile.");
        var install = Path.Combine(local, "Equinox Local");
        var originalGuardian = Path.Combine(install, "runtime", "guardian", "EquinoxLocalGuardian.exe");
        if (!Compare.Equals(Path.GetFullPath(Environment.ProcessPath ?? ""), Path.GetFullPath(originalGuardian)))
            throw new InvalidDataException("Signed-native journal inspector is not the installed Guardian.");
        RequireNormalDirectory(install);
        RequireNormalDirectory(Path.Combine(install, "runtime"));
        RequireNormalDirectory(Path.Combine(install, "runtime", "guardian"));
        RequireNormalFile(originalGuardian);
        var tx = Path.Combine(install, "state", "main-update");
        RequireNormalDirectory(Path.Combine(install, "state"));
        RequireNormalDirectory(tx);

        using var ownerDoc = ReadOwnedTransitionRecord(Path.Combine(tx, "active.json"), 8192);
        var owner = ownerDoc.RootElement;
        RequireExactKeys(owner, ["schemaVersion", "kind", "transactionId",
            "sourceSha", "target", "runtimeContractSha256"]);
        var id = owner.GetProperty("transactionId").GetString() ?? "";
        var sha = owner.GetProperty("sourceSha").GetString() ?? "";
        var target = owner.GetProperty("target").GetString() ?? "";
        var contract = owner.GetProperty("runtimeContractSha256").GetString() ?? "";
        var hostTarget = RuntimeInformation.ProcessArchitecture switch
        {
            Architecture.X64 => "win32-x64", Architecture.Arm64 => "win32-arm64",
            _ => throw new PlatformNotSupportedException("Signed-native Guardian audit target is unsupported."),
        };
        if (owner.GetProperty("schemaVersion").GetInt32() != 1 ||
            owner.GetProperty("kind").GetString() != "signed-native" ||
            !NativeTransactionPattern.IsMatch(id) || !SourceShaPattern.IsMatch(sha) ||
            target != hostTarget || !DigestPattern.IsMatch(contract))
            throw new InvalidDataException("Signed-native active owner is not an exact target SHA.");
        var expected = MainSignedNativeWorkerContract.ForSignedNativeB(id, sha, target, tx);
        // Pin the SAME kernel file IDs for B-owned Node.exe and worker.js
        // throughout original Ed25519 ZIP and extracted B verification.
        // FileShare.Read denies write/rename while the independent Guardian
        // hashes B, not merely a pathname that could have changed.
        using var pinnedB = MainSignedNativeWorkerContract.PinExactBExecutables(expected);

        InspectionPhase = "signed-native-journal-receipt";
        var receipts = Path.Combine(tx, "receipts");
        RequireNormalDirectory(receipts);
        using var receiptDoc = ReadOwnedTransitionRecord(Path.Combine(receipts,
            id + ".signed-native.json"), 8192);
        var receipt = receiptDoc.RootElement;
        RequireExactKeys(receipt, ["schemaVersion", "kind", "transactionId",
            "sourceSha", "target", "runtimeContractSha256", "status"]);
        if (receipt.GetProperty("schemaVersion").GetInt32() != 1 ||
            receipt.GetProperty("kind").GetString() != "signed-native" ||
            receipt.GetProperty("transactionId").GetString() != id ||
            receipt.GetProperty("sourceSha").GetString() != sha ||
            receipt.GetProperty("target").GetString() != target ||
            receipt.GetProperty("runtimeContractSha256").GetString() != contract ||
            receipt.GetProperty("status").GetString() is not ("admitted" or "activating"))
            throw new InvalidDataException("Signed-native receipt is not in a pre-terminal worker stage.");

        InspectionPhase = "signed-native-journal-immutable-rollback";
        var staging = Path.Combine(tx, "staging", id, "native-rollback");
        RequireNormalDirectory(Path.Combine(tx, "staging"));
        RequireNormalDirectory(Path.Combine(tx, "staging", id));
        RequireNormalDirectory(staging);
        using var descriptorDoc = ReadOwnedTransitionRecord(Path.Combine(
            staging, "native-recovery.json"), 8192);
        var descriptor = descriptorDoc.RootElement;
        RequireExactKeys(descriptor, ["schemaVersion", "channel", "targetSha",
            "target", "targetRuntimeContractSha256", "previous"]);
        if (descriptor.GetProperty("schemaVersion").GetInt32() != 1 ||
            descriptor.GetProperty("channel").GetString() != "main" ||
            descriptor.GetProperty("targetSha").GetString() != sha ||
            descriptor.GetProperty("target").GetString() != target ||
            descriptor.GetProperty("targetRuntimeContractSha256").GetString() != contract)
            throw new InvalidDataException("Signed-native rollback descriptor does not match immutable B.");
        var prior = descriptor.GetProperty("previous");
        var priorKind = prior.GetProperty("kind").GetString();
        if (priorKind == "stable")
        {
            RequireExactKeys(prior, ["kind", "version"]);
            var version = prior.GetProperty("version").GetString() ?? "";
            if (!VersionRegex().IsMatch(version))
                throw new InvalidDataException("Original signed-native Stable A version is invalid.");
            var stable = Path.Combine(install, "releases", version);
            RequireNormalDirectory(Path.Combine(install, "releases"));
            RequireNormalDirectory(stable);
            RequireNormalFile(Path.Combine(stable, "release.json"));
            using var stableDoc = ReadOwnedTransitionRecord(Path.Combine(
                install, "current-version.json"), 4096);
            var currentStable = stableDoc.RootElement;
            RequireExactKeys(currentStable, ["schemaVersion", "target", "version"]);
            if (currentStable.GetProperty("schemaVersion").GetInt32() != 1 ||
                currentStable.GetProperty("target").GetString() != target ||
                currentStable.GetProperty("version").GetString() != version)
                throw new InvalidDataException("Signed-native Stable A differs from the owned installed pointer.");
            // The signed-native B must not be confused with an old A from
            // an ambient source-tree receipt or a malformed Main pointer.
            var activeNative = Path.Combine(tx, "current-native.json");
            if (File.Exists(activeNative) || Directory.Exists(activeNative) ||
                Directory.EnumerateFileSystemEntries(tx, "current-native.json").Any())
                throw new InvalidDataException("Signed-native Stable A conflicts with an existing native pointer.");
        }
        else if (priorKind == "main")
        {
            RequireExactKeys(prior, ["kind", "sourceSha", "target", "runtimeContractSha256"]);
            var a = prior.GetProperty("sourceSha").GetString() ?? "";
            var aTarget = prior.GetProperty("target").GetString() ?? "";
            var aContract = prior.GetProperty("runtimeContractSha256").GetString() ?? "";
            if (!SourceShaPattern.IsMatch(a) || a == sha || aTarget != target ||
                !DigestPattern.IsMatch(aContract))
                throw new InvalidDataException("Signed-native previous A is not a distinct original SHA.");
            using var currentDoc = ReadOwnedTransitionRecord(Path.Combine(
                tx, "current-native.json"), 8192);
            var current = currentDoc.RootElement;
            RequireExactKeys(current, ["schemaVersion", "channel", "sourceSha",
                "target", "runtimeContractSha256"]);
            var expectedA = Path.Combine(tx, "native-store", target, a, "release");
            if (current.GetProperty("schemaVersion").GetInt32() != 1 ||
                current.GetProperty("channel").GetString() != "main" ||
                current.GetProperty("sourceSha").GetString() != a ||
                current.GetProperty("target").GetString() != target ||
                current.GetProperty("runtimeContractSha256").GetString() != aContract)
                throw new InvalidDataException("Signed-native previous A does not match committed native pointer.");
            RequireNormalDirectory(Path.Combine(tx, "native-store", target, a));
            RequireNormalDirectory(expectedA);
        }
        else throw new InvalidDataException("Signed-native Windows A must be original Stable or Main.");

        InspectionPhase = "signed-native-journal-immutable-store";
        var payload = Path.GetDirectoryName(expected.ReleaseDir)!;
        using var storeDoc = ReadOwnedTransitionRecord(Path.Combine(payload, "native-store.json"), 8192);
        var store = storeDoc.RootElement;
        RequireExactKeys(store, ["schemaVersion", "channel", "sourceSha", "target",
            "runtimeContractSha256", "artifactSha256", "artifactBytes",
            "payloadVersion", "releaseFingerprint"]);
        var fingerprint = store.GetProperty("releaseFingerprint");
        RequireExactKeys(fingerprint, ["schemaVersion", "sha256", "entries", "bytes"]);
        if (store.GetProperty("schemaVersion").GetInt32() != 1 ||
            store.GetProperty("channel").GetString() != "main" ||
            store.GetProperty("sourceSha").GetString() != sha ||
            store.GetProperty("target").GetString() != target ||
            store.GetProperty("runtimeContractSha256").GetString() != contract ||
            !DigestPattern.IsMatch(store.GetProperty("artifactSha256").GetString() ?? "") ||
            store.GetProperty("artifactBytes").GetInt64() < 1 ||
            !VersionRegex().IsMatch(store.GetProperty("payloadVersion").GetString() ?? "") ||
            fingerprint.GetProperty("schemaVersion").GetInt32() != 1 ||
            !DigestPattern.IsMatch(fingerprint.GetProperty("sha256").GetString() ?? "") ||
            fingerprint.GetProperty("entries").GetInt32() < 1 ||
            fingerprint.GetProperty("bytes").GetInt64() < 1)
            throw new InvalidDataException("Signed-native B stored manifest has inconsistent structural identity.");

        // Verify the exact original production-root Ed25519 canonical
        // four-target payload independently inside the signed Guardian.
        // The immutable signed selector is NOT a user-supplied trust root.
        var signed = VerifyOriginalSignedNativeMainSelector(Path.Combine(
            payload, "signed-selector.json"), sha, target);
        if (signed.Contract != contract ||
            signed.ArtifactSha256 != store.GetProperty("artifactSha256").GetString() ||
            signed.ArtifactBytes != store.GetProperty("artifactBytes").GetInt64() ||
            signed.Version != store.GetProperty("payloadVersion").GetString())
            throw new InvalidDataException(
                "Original production Ed25519 Main B differs from its native-store contract.");

        // B's release metadata must identify that same full signed SHA,
        // version, native target and fixed server entry; an arbitrary store
        // manifest alone cannot confer a loadable product identity.
        using var releaseDoc = ReadOwnedTransitionRecord(Path.Combine(
            expected.ReleaseDir, "release.json"), 16 * 1024);
        var metadata = releaseDoc.RootElement;
        if (metadata.ValueKind != JsonValueKind.Object ||
            metadata.GetProperty("schemaVersion").GetInt32() != 1 ||
            metadata.GetProperty("sourceSha").GetString() != sha ||
            metadata.GetProperty("target").GetString() != target ||
            metadata.GetProperty("version").GetString() != signed.Version ||
            metadata.GetProperty("serverEntry").GetString() != "server.js")
            throw new InvalidDataException(
                "Original production-signed native B release metadata does not identify the admitted SHA.");

        // The signed artifact digest identifies the archive; the native
        // store fingerprint identifies the actual EXTRACTED B executable
        // tree. Both must match, using the existing original Guardian
        // full-tree hashing algorithm, not just a structurally valid claim.
        var measured = FingerprintNativeMainRelease(expected.ReleaseDir);
        if (measured.Sha256 != fingerprint.GetProperty("sha256").GetString() ||
            measured.Entries != fingerprint.GetProperty("entries").GetInt32() ||
            measured.Bytes != fingerprint.GetProperty("bytes").GetInt64())
            throw new InvalidDataException(
                "Original signed Main B full executable release fingerprint differs from immutable store.");

        // Unlike a mutable native-store fingerprint, these exact ZIP
        // compressed bytes are authenticated by the ORIGINAL production
        // Ed25519 pointer. Compare every decompressed release entry before
        // WPF could ever execute B; no separate new updater or signer.
        InspectOriginalSignedWindowsArchive(
            Path.Combine(payload, "signed-artifact.zip"), expected.ReleaseDir,
            signed.ArtifactSha256, signed.ArtifactBytes);

        // Full SHA, Ed25519 signature, extracted release fingerprint and
        // structural journal STILL do NOT prove an independent Guardian
        // OS HMAC/journal authority or healthy B.
        // Existing original WPF Git mutation lane remains DENIED to native.
        InspectionPhase = "signed-native-ed25519-verified-journal-read-only-incomplete";
    }
}
