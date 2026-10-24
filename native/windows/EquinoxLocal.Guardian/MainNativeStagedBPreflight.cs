using System.Runtime.InteropServices;
using System.Text.Json;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    // READ-ONLY B candidate inspection. It cannot authenticate a signed B
    // source, authorize a journal milestone, replace the running shell, or
    // commit current-native.json. A future native OS stage owner must add
    // source-signature/worker/lease proofs before making ANY mutation.
    private static void InspectOwnedStagedBNativeCandidate()
    {
        InspectionPhase = "native-b-staging-readonly-original-main-a";
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrWhiteSpace(local) || !Path.IsPathFullyQualified(local))
            throw new InvalidDataException("Staged B native user root is unavailable.");
        var tx = Path.Combine(local, "Equinox Local", "state", "main-update");
        var journalRoot = Path.Combine(tx, "guardian-journal");
        RequireNormalDirectory(journalRoot);
        // This rejects an orphan writer, mismatched active receipt and every
        // nonprepared journal state. A native B stage must not race any owner.
        InspectOwnedNativeTransitionJournal();
        using var active = ReadOwnedTransitionRecord(Path.Combine(tx, "active.json"), 8192);
        var id = active.RootElement.GetProperty("transactionId").GetString() ?? "";
        if (!NativeTransactionPattern.IsMatch(id))
            throw new InvalidDataException("Staged B transaction identity is not canonical.");
        using var doc = ReadOwnedTransitionRecord(Path.Combine(journalRoot, id + ".json"), 8192);
        var journal = doc.RootElement;
        var previous = journal.GetProperty("previousNative");
        if (journal.GetProperty("stage").GetString() != "prepared" ||
            journal.GetProperty("sequence").GetInt32() != 0 ||
            previous.GetProperty("kind").GetString() != "main")
            throw new InvalidDataException("B candidate preflight requires unchanged original managed Main A.");
        // This checks the actual installed old A source Git tree, native A
        // fingerprint and currently registered Browser Native Messaging.
        InspectMainNativeIdentity(allowExactActiveMainTransaction: true);
        var target = RuntimeInformation.ProcessArchitecture switch
        {
            Architecture.X64 => "win32-x64",
            Architecture.Arm64 => "win32-arm64",
            _ => throw new PlatformNotSupportedException("Unsupported staged B native architecture."),
        };
        var bSha = journal.GetProperty("targetSha").GetString() ?? "";
        var contract = journal.GetProperty("targetRuntimeContractSha256").GetString() ?? "";
        if (!SourceShaPattern.IsMatch(bSha) || !DigestPattern.IsMatch(contract) ||
            journal.GetProperty("target").GetString() != target ||
            active.RootElement.GetProperty("targetSha").GetString() != bSha ||
            active.RootElement.GetProperty("currentSha").GetString() == bSha)
            throw new InvalidDataException("Staged B target differs from the original prepared owner.");
        var store = Path.Combine(tx, "native-store");
        var platform = Path.Combine(store, target);
        var payload = Path.Combine(platform, bSha);
        var release = Path.Combine(payload, "release");
        foreach (var directory in new[] { store, platform, payload, release,
            Path.Combine(release, "runtime"), Path.Combine(release, "runtime", "shell"),
            Path.Combine(release, "runtime", "browser"), Path.Combine(release, "runtime", "node"),
            Path.Combine(release, "runtime", "node", "bin") })
            RequireNormalDirectory(directory);
        using var manifestDoc = ReadOwnedTransitionRecord(Path.Combine(payload, "native-store.json"), 8192);
        var manifest = manifestDoc.RootElement;
        RequireExactKeys(manifest, ["schemaVersion", "channel", "sourceSha", "target",
            "runtimeContractSha256", "artifactSha256", "artifactBytes", "payloadVersion", "releaseFingerprint"]);
        var version = manifest.GetProperty("payloadVersion").GetString() ?? "";
        if (manifest.GetProperty("schemaVersion").GetInt32() != 1 ||
            manifest.GetProperty("channel").GetString() != "main" ||
            manifest.GetProperty("sourceSha").GetString() != bSha ||
            manifest.GetProperty("target").GetString() != target ||
            manifest.GetProperty("runtimeContractSha256").GetString() != contract ||
            !DigestPattern.IsMatch(manifest.GetProperty("artifactSha256").GetString() ?? "") ||
            manifest.GetProperty("artifactBytes").GetInt64() is < 1 or > 1_073_741_824 ||
            !VersionRegex().IsMatch(version))
            throw new InvalidDataException("Staged B native manifest is not the exact prepared target.");
        using var releaseDoc = ReadOwnedTransitionRecord(Path.Combine(release, "release.json"), 16384);
        var metadata = releaseDoc.RootElement;
        if (metadata.GetProperty("schemaVersion").GetInt32() != 1 ||
            metadata.GetProperty("target").GetString() != target ||
            metadata.GetProperty("version").GetString() != version ||
            metadata.GetProperty("serverEntry").GetString() != "server.js")
            throw new InvalidDataException("Staged B release metadata differs from its immutable candidate.");
        foreach (var file in new[] { Path.Combine(release, "runtime", "shell", "EquinoxLocal.exe"),
            Path.Combine(release, "runtime", "browser", "equinox-browser-native-host.exe"),
            Path.Combine(release, "runtime", "node", "bin", "node.exe") })
            RequireNormalFile(file);
        var fingerprint = manifest.GetProperty("releaseFingerprint");
        RequireExactKeys(fingerprint, ["schemaVersion", "sha256", "entries", "bytes"]);
        if (fingerprint.GetProperty("schemaVersion").GetInt32() != 1 ||
            !DigestPattern.IsMatch(fingerprint.GetProperty("sha256").GetString() ?? ""))
            throw new InvalidDataException("Staged B fingerprint claim is malformed.");
        InspectionPhase = "native-b-staging-complete-sha256-readonly";
        var measured = FingerprintNativeMainRelease(release);
        if (fingerprint.GetProperty("sha256").GetString() != measured.Sha256 ||
            fingerprint.GetProperty("entries").GetInt64() != measured.Entries ||
            fingerprint.GetProperty("bytes").GetInt64() != measured.Bytes)
            throw new InvalidDataException("Staged B complete native fingerprint differs from source-addressed manifest.");
        // No persisted sidecar and no journal advance, shutdown, slot mutation,
        // registry write, pointer creation or process launch in this mode.
        InspectionPhase = "native-b-candidate-audited-no-stage-authorization";
    }
}
