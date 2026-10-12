using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    // Read-only structural proof, not an authorization to launch a Main shell.
    // Full JS-style native-store fingerprint, product Git HEAD and receipt
    // reconciliation must join this boundary before any Main activation.
    private static readonly Regex SourceShaPattern = new("^[a-f0-9]{40}$", RegexOptions.CultureInvariant);
    private static readonly Regex DigestPattern = new("^[a-f0-9]{64}$", RegexOptions.CultureInvariant);

    private static void InspectMainNativeIdentity(string? exactOwnedTransactionId = null)
    {
        InspectionPhase = "native-owner";
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrWhiteSpace(local) || !Path.IsPathFullyQualified(local))
            throw new InvalidDataException("Main native auditor current-user directory unavailable.");
        var install = Path.Combine(local, "Equinox Local");
        var guardianPath = Path.Combine(install, "runtime", "guardian", "EquinoxLocalGuardian.exe");
        if (!Compare.Equals(Path.GetFullPath(Environment.ProcessPath ?? ""), Path.GetFullPath(guardianPath)))
            throw new InvalidDataException("Main native auditor is not the owned Guardian executable.");
        RequireNormalDirectory(install);
        RequireNormalDirectory(Path.Combine(install, "runtime"));
        RequireNormalDirectory(Path.Combine(install, "runtime", "guardian"));
        RequireNormalFile(guardianPath);

        var tx = Path.Combine(install, "state", "main-update");
        RequireNormalDirectory(Path.Combine(install, "state"));
        RequireNormalDirectory(tx);
        InspectionPhase = "native-transaction-boundary";
        var activePath = Path.Combine(tx, "active.json");
        var active = File.Exists(activePath) || Directory.Exists(activePath);
        var handoff = Path.Combine(tx, "handoff");
        if (exactOwnedTransactionId is null)
        {
            // Public/standalone audit never accepts an active Main owner.
            if (active) throw new InvalidDataException("Unreconciled native Main transaction blocks audit.");
            if (Directory.Exists(handoff))
            {
                RequireNormalDirectory(handoff);
                if (Directory.EnumerateFileSystemEntries(handoff, "*.windows-worker.json").Any())
                    throw new InvalidDataException("Detached Main worker ownership blocks audit.");
            }
        }
        else
        {
            // Only the original live OS-attested worker in the SAME Guardian
            // that already owns its exclusive writer lease can opt into an
            // active-transaction B audit. Never expose this through argv.
            if (!exactOwnedTransactionId.StartsWith("main-", StringComparison.Ordinal) ||
                exactOwnedTransactionId.Length != 37 ||
                !Regex.IsMatch(exactOwnedTransactionId[5..], "^[a-f0-9]{32}$", RegexOptions.CultureInvariant) || !active)
                throw new InvalidDataException("Native B audit lacks an exact active transaction identity.");
            using var markerDoc = ReadOwnedTransitionRecord(activePath, 8192);
            using var receiptDoc = ReadOwnedTransitionRecord(
                Path.Combine(tx, "receipts", exactOwnedTransactionId + ".json"), 65536);
            using var journalDoc = ReadOwnedTransitionRecord(
                Path.Combine(tx, "guardian-journal", exactOwnedTransactionId + ".json"), 8192);
            var marker = markerDoc.RootElement;
            var receipt = receiptDoc.RootElement;
            var journal = journalDoc.RootElement;
            if (marker.GetProperty("transactionId").GetString() != exactOwnedTransactionId ||
                receipt.GetProperty("transactionId").GetString() != exactOwnedTransactionId ||
                journal.GetProperty("transactionId").GetString() != exactOwnedTransactionId ||
                journal.GetProperty("stage").GetString() != "switched" ||
                journal.GetProperty("sequence").GetInt32() != 3 ||
                marker.GetProperty("targetSha").GetString() != journal.GetProperty("targetSha").GetString() ||
                receipt.GetProperty("targetSha").GetString() != journal.GetProperty("targetSha").GetString())
                throw new InvalidDataException("Native B audit active receipt/journal ownership is not exact.");
            var live = InspectOwnedNativeWorkerProcess();
            if (live.TransactionId != exactOwnedTransactionId)
                throw new InvalidDataException("Native B audit worker PID is not the original transaction owner.");
            RequireNormalDirectory(handoff);
            if (Directory.EnumerateFileSystemEntries(handoff, "*.windows-worker.json").Count() != 1)
                throw new InvalidDataException("Native B audit has a foreign detached worker alongside its OS owner.");
        }
        var target = RuntimeInformation.ProcessArchitecture switch
        {
            Architecture.X64 => "win32-x64",
            Architecture.Arm64 => "win32-arm64",
            _ => throw new PlatformNotSupportedException("Unsupported native Main architecture."),
        };

        InspectionPhase = "native-source-pointer";
        var sourcePointer = Path.Combine(tx, "current-source.conf");
        RequireNormalFile(sourcePointer);
        if (new FileInfo(sourcePointer).Length is < 15 or > 8192)
            throw new InvalidDataException("Main source pointer is outside its bound.");
        var rows = File.ReadAllText(sourcePointer).Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(row => row.TrimEnd('\r')).ToArray();
        if (rows.Length != 3 || rows[0] != "schemaVersion=1" ||
            !rows[1].StartsWith("sourceRoot=", StringComparison.Ordinal) ||
            !rows[2].StartsWith("sha=", StringComparison.Ordinal))
            throw new InvalidDataException("Main source pointer structure differs from product schema.");
        var sourceSha = rows[2][4..];
        if (!SourceShaPattern.IsMatch(sourceSha)) throw new InvalidDataException("Main source pointer SHA is invalid.");
        var expectedSource = Path.Combine(tx, "sources", sourceSha);
        var storedSource = rows[1]["sourceRoot=".Length..];
        if (!Compare.Equals(storedSource, expectedSource))
            throw new InvalidDataException("Main source pointer escaped its immutable checkout slot.");
        RequireNormalDirectory(Path.Combine(tx, "sources"));
        RequireNormalDirectory(expectedSource);
        // Verify the exact checkout with product-owned Git; no ambient Git or
        // source-supplied executable may influence this native audit.
        InspectOwnedMainGit(install, target, expectedSource, sourceSha);

        InspectionPhase = "native-pointer-identity";
        using var pointerDoc = ReadJson(Path.Combine(tx, "current-native.json"), 8192);
        var pointer = pointerDoc.RootElement;
        RequireExactKeys(pointer, ["schemaVersion", "channel", "sourceSha", "target", "runtimeContractSha256"]);
        var contractSha = pointer.GetProperty("runtimeContractSha256").GetString() ?? "";
        if (pointer.GetProperty("schemaVersion").GetInt32() != 1 ||
            pointer.GetProperty("channel").GetString() != "main" ||
            pointer.GetProperty("sourceSha").GetString() != sourceSha ||
            pointer.GetProperty("target").GetString() != target ||
            !DigestPattern.IsMatch(contractSha))
            throw new InvalidDataException("Native pointer does not bind exact Main source and host.");

        InspectionPhase = "native-store-identity";
        var store = Path.Combine(tx, "native-store");
        var targetRoot = Path.Combine(store, target);
        var nativeRoot = Path.Combine(targetRoot, sourceSha);
        RequireNormalDirectory(store);
        RequireNormalDirectory(targetRoot);
        RequireNormalDirectory(nativeRoot);
        using var manifestDoc = ReadJson(Path.Combine(nativeRoot, "native-store.json"), 8192);
        var manifest = manifestDoc.RootElement;
        RequireExactKeys(manifest, ["schemaVersion", "channel", "sourceSha", "target", "runtimeContractSha256",
            "artifactSha256", "artifactBytes", "payloadVersion", "releaseFingerprint"]);
        var artifactSha = manifest.GetProperty("artifactSha256").GetString() ?? "";
        var artifactBytes = manifest.GetProperty("artifactBytes").GetInt64();
        var payloadVersion = manifest.GetProperty("payloadVersion").GetString() ?? "";
        if (manifest.GetProperty("schemaVersion").GetInt32() != 1 ||
            manifest.GetProperty("channel").GetString() != "main" ||
            manifest.GetProperty("sourceSha").GetString() != sourceSha ||
            manifest.GetProperty("target").GetString() != target ||
            manifest.GetProperty("runtimeContractSha256").GetString() != contractSha ||
            !DigestPattern.IsMatch(artifactSha) || artifactBytes is < 1 or > 1_073_741_824 ||
            !VersionRegex().IsMatch(payloadVersion))
            throw new InvalidDataException("Native store manifest and pointer identities differ.");
        var fingerprint = manifest.GetProperty("releaseFingerprint");
        RequireExactKeys(fingerprint, ["schemaVersion", "sha256", "entries", "bytes"]);
        if (fingerprint.GetProperty("schemaVersion").GetInt32() != 1 ||
            !DigestPattern.IsMatch(fingerprint.GetProperty("sha256").GetString() ?? "") ||
            fingerprint.GetProperty("entries").GetInt64() < 1 ||
            fingerprint.GetProperty("bytes").GetInt64() < 1)
            throw new InvalidDataException("Native store release fingerprint claim is malformed.");

        InspectionPhase = "native-release-identity";
        var release = Path.Combine(nativeRoot, "release");
        RequireNormalDirectory(release);
        using var releaseDoc = ReadJson(Path.Combine(release, "release.json"), 16384);
        var metadata = releaseDoc.RootElement;
        if (metadata.ValueKind != JsonValueKind.Object ||
            metadata.GetProperty("schemaVersion").GetInt32() != 1 ||
            metadata.GetProperty("target").GetString() != target ||
            metadata.GetProperty("version").GetString() != payloadVersion ||
            metadata.GetProperty("serverEntry").GetString() != "server.js")
            throw new InvalidDataException("Immutable native Main release identity mismatch.");
        InspectionPhase = "native-full-fingerprint";
        var claimSha = fingerprint.GetProperty("sha256").GetString() ?? "";
        var claimEntries = fingerprint.GetProperty("entries").GetInt64();
        var claimBytes = fingerprint.GetProperty("bytes").GetInt64();
        var measured = FingerprintNativeMainRelease(release);
        if (measured.Entries != claimEntries)
            throw new InvalidDataException("Native Main fingerprint entry count differs from stored manifest.");
        if (measured.Bytes != claimBytes)
            throw new InvalidDataException("Native Main fingerprint byte count differs from stored manifest.");
        if (measured.Sha256 != claimSha)
            throw new InvalidDataException("Native Main complete fingerprint digest differs from stored manifest.");
        InspectionPhase = "native-shell-hash";
        var immutableShell = Path.Combine(release, "runtime", "shell");
        var activeProgram = Path.Combine(local, "Programs", "Equinox Local");
        RequireNormalDirectory(Path.Combine(release, "runtime"));
        RequireNormalDirectory(immutableShell);
        RequireNormalDirectory(activeProgram);
        CompareNativeTrees(immutableShell, activeProgram);
        InspectOwnedMainNativeMessaging(install, release);
        // Do NOT launch or claim successful admission: the authenticated
        // journal, native transition worker and rollback still need proof.
        InspectionPhase = "native-structural-audit-complete";
    }
}
