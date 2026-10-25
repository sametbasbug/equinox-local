using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    // First forward Main milestone owned by the independently authenticated
    // Guardian lease: prepared/0 -> native_staged/1. Verify the COMPLETE
    // immutable B before writing anything. NEVER touch the installed A shell,
    // HKCU Native Messaging registration, active pointer or running WPF.
    private static void WriteNativeJournalStagedB(
        OwnedWorkerClaim owner, string journalPath, byte[] preparedBytes, byte[] expectedDigest)
    {
        InspectionPhase = "native-stage-b-prepared";
        if (preparedBytes.Length is < 2 or > 8192 ||
            !CryptographicOperations.FixedTimeEquals(SHA256.HashData(preparedBytes), expectedDigest))
            throw new InvalidDataException("Native B staging requires one exact prepared generation.");
        using var doc = JsonDocument.Parse(preparedBytes);
        var journal = doc.RootElement;
        RequireExactKeys(journal, ["schemaVersion", "channel", "transactionId", "target", "currentSha",
            "targetSha", "receiptStartedAt", "previousNative", "targetRuntimeContractSha256",
            "stage", "sequence", "createdAt", "updatedAt"]);
        var sourceSha = journal.GetProperty("targetSha").GetString() ?? "";
        var contract = journal.GetProperty("targetRuntimeContractSha256").GetString() ?? "";
        var target = RuntimeInformation.ProcessArchitecture switch
        {
            Architecture.X64 => "win32-x64",
            Architecture.Arm64 => "win32-arm64",
            _ => throw new PlatformNotSupportedException("Unsupported B staging architecture."),
        };
        if (journal.GetProperty("schemaVersion").GetInt32() != 1 ||
            journal.GetProperty("channel").GetString() != "main" ||
            journal.GetProperty("transactionId").GetString() != owner.TransactionId ||
            journal.GetProperty("target").GetString() != target ||
            journal.GetProperty("stage").GetString() != "prepared" ||
            journal.GetProperty("sequence").GetInt32() != 0 ||
            !SourceShaPattern.IsMatch(sourceSha) || !DigestPattern.IsMatch(contract))
            throw new InvalidDataException("Native B staging has a foreign transaction or generation.");

        var measured = InspectExactImmutableNativeBPayload(owner, journal);
        InspectionPhase = "native-stage-b-authenticated-commit";
        var now = DateTimeOffset.UtcNow.ToString(CanonicalUtcTime, CultureInfo.InvariantCulture);
        if (string.CompareOrdinal(now, journal.GetProperty("updatedAt").GetString()) < 0)
            throw new InvalidDataException("Native B stage timestamp moved backwards.");
        var root = Path.GetDirectoryName(journalPath) ?? throw new InvalidDataException("Native journal root is unavailable.");
        var temp = Path.Combine(root, "." + owner.TransactionId + ".json." +
            Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(8)) + ".tmp");
        using (var fd = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
        {
            using (var writer = new Utf8JsonWriter(fd))
            {
                writer.WriteStartObject();
                foreach (var field in journal.EnumerateObject())
                {
                    if (field.NameEquals("stage")) writer.WriteString("stage", "native_staged");
                    else if (field.NameEquals("sequence")) writer.WriteNumber("sequence", 1);
                    else if (field.NameEquals("updatedAt")) writer.WriteString("updatedAt", now);
                    else field.WriteTo(writer);
                }
                writer.WriteEndObject();
                writer.Flush();
            }
            fd.Flush(flushToDisk: true);
            if (fd.Length > 8192) throw new InvalidDataException("Native B staged journal is unbounded.");
        }

        // The existing exclusive Guardian owner lease is held for this write.
        // Any conflict leaves the candidate and writer lock for reconciliation.
        using (var old = ReadOwnedTransitionRecord(journalPath, 8192))
        {
            if (old.RootElement.GetProperty("stage").GetString() != "prepared" ||
                old.RootElement.GetProperty("sequence").GetInt32() != 0)
                throw new InvalidDataException("Native B staging no longer owns prepared/0.");
        }
        using (var pinned = new FileStream(journalPath, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            if (!CryptographicOperations.FixedTimeEquals(SHA256.HashData(pinned), expectedDigest))
                throw new InvalidDataException("Native B staging prepared journal changed before commit.");
        }
        InspectionPhase = "native-stage-b-atomic-commit";
        File.Move(temp, journalPath, overwrite: true);
        // Pin the actually published B-stage generation across receipt
        // verification and commit marker, never hash a second pathname read.
        using var stagedHandle = new FileStream(journalPath, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (stagedHandle.Length is < 2 or > 8192)
            throw new InvalidDataException("Native staged generation is unbounded.");
        using var committed = JsonDocument.Parse(stagedHandle);
        if (committed.RootElement.GetProperty("transactionId").GetString() != owner.TransactionId ||
            committed.RootElement.GetProperty("stage").GetString() != "native_staged" ||
            committed.RootElement.GetProperty("sequence").GetInt32() != 1)
            throw new InvalidDataException("Native B journal milestone is not durable.");
        stagedHandle.Position = 0;
        var stagedDigest = SHA256.HashData(stagedHandle);
        var marker = Path.Combine(root, owner.TransactionId + ".stage-b-commit.json");
        using var receipt = new FileStream(marker, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough);
        using (var writer = new Utf8JsonWriter(receipt))
        {
            writer.WriteStartObject();
            writer.WriteNumber("schemaVersion", 1);
            writer.WriteString("transactionId", owner.TransactionId);
            writer.WriteString("stage", "native_staged");
            writer.WriteNumber("sequence", 1);
            writer.WriteNumber("guardianPid", Environment.ProcessId);
            writer.WriteString("preparedJournalSha256", Convert.ToHexStringLower(expectedDigest));
            writer.WriteString("journalSha256", Convert.ToHexStringLower(stagedDigest));
            writer.WriteString("nativeBFingerprintSha256", measured.Sha256);
            writer.WriteEndObject();
            writer.Flush();
        }
        receipt.Flush(flushToDisk: true);
        InspectionPhase = "native-stage-b-committed-under-lease";
    }
    // Common read-only FULL immutable B provenance gate. Both the legacy
    // prepared-stage writer and the original signed continuous Guardian OS
    // session MUST validate the exact same product-owned Git SHA, native
    // manifest, release fingerprint and full native payload before A exits.
    private static (string Sha256, long Entries, long Bytes) InspectExactImmutableNativeBPayload(
        OwnedWorkerClaim owner, JsonElement journal)
    {
        var sourceSha = journal.GetProperty("targetSha").GetString() ?? "";
        var contract = journal.GetProperty("targetRuntimeContractSha256").GetString() ?? "";
        var target = RuntimeInformation.ProcessArchitecture switch
        {
            Architecture.X64 => "win32-x64", Architecture.Arm64 => "win32-arm64",
            _ => throw new PlatformNotSupportedException("Unsupported B staging architecture."),
        };
        var stage = journal.GetProperty("stage").GetString();
        var sequence = journal.GetProperty("sequence").GetInt32();
        if (journal.GetProperty("schemaVersion").GetInt32() != 1 ||
            journal.GetProperty("channel").GetString() != "main" ||
            journal.GetProperty("transactionId").GetString() != owner.TransactionId ||
            journal.GetProperty("target").GetString() != target ||
            !((stage == "prepared" && sequence == 0) ||
              (stage == "native_staged" && sequence == 1)) ||
            !SourceShaPattern.IsMatch(sourceSha) || !DigestPattern.IsMatch(contract))
            throw new InvalidDataException("Original Guardian immutable native B identity is invalid.");
        InspectionPhase = "native-stage-b-exact-source";
        var install = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Equinox Local");
        var tx = Path.Combine(install, "state", "main-update");
        var source = Path.Combine(tx, "sources", sourceSha);
        RequireNormalDirectory(source);
        InspectOwnedMainGit(install, target, source, sourceSha);

        InspectionPhase = "native-stage-b-manifest";
        var nativeRoot = Path.Combine(tx, "native-store", target, sourceSha);
        RequireNormalDirectory(nativeRoot);
        using var manifestDoc = ReadOwnedTransitionRecord(Path.Combine(nativeRoot, "native-store.json"), 8192);
        var manifest = manifestDoc.RootElement;
        RequireExactKeys(manifest, ["schemaVersion", "channel", "sourceSha", "target", "runtimeContractSha256",
            "artifactSha256", "artifactBytes", "payloadVersion", "releaseFingerprint"]);
        var payloadVersion = manifest.GetProperty("payloadVersion").GetString() ?? "";
        if (manifest.GetProperty("schemaVersion").GetInt32() != 1 ||
            manifest.GetProperty("channel").GetString() != "main" ||
            manifest.GetProperty("sourceSha").GetString() != sourceSha ||
            manifest.GetProperty("target").GetString() != target ||
            manifest.GetProperty("runtimeContractSha256").GetString() != contract ||
            !DigestPattern.IsMatch(manifest.GetProperty("artifactSha256").GetString() ?? "") ||
            manifest.GetProperty("artifactBytes").GetInt64() is < 1 or > 1_073_741_824 ||
            !VersionRegex().IsMatch(payloadVersion))
            throw new InvalidDataException("Native B manifest does not bind the immutable SHA and runtime contract.");
        var fingerprint = manifest.GetProperty("releaseFingerprint");
        RequireExactKeys(fingerprint, ["schemaVersion", "sha256", "entries", "bytes"]);
        if (fingerprint.GetProperty("schemaVersion").GetInt32() != 1 ||
            !DigestPattern.IsMatch(fingerprint.GetProperty("sha256").GetString() ?? "") ||
            fingerprint.GetProperty("entries").GetInt64() < 1 ||
            fingerprint.GetProperty("bytes").GetInt64() < 1)
            throw new InvalidDataException("Native B fingerprint claim is incomplete.");
        var release = Path.Combine(nativeRoot, "release");
        RequireNormalDirectory(release);
        using var releaseDoc = ReadOwnedTransitionRecord(Path.Combine(release, "release.json"), 16384);
        var metadata = releaseDoc.RootElement;
        if (metadata.GetProperty("schemaVersion").GetInt32() != 1 ||
            metadata.GetProperty("sourceSha").GetString() != sourceSha ||
            metadata.GetProperty("target").GetString() != target ||
            metadata.GetProperty("version").GetString() != payloadVersion ||
            metadata.GetProperty("serverEntry").GetString() != "server.js")
            throw new InvalidDataException("Native B release metadata is inconsistent.");
        RequireNormalFile(Path.Combine(release, "runtime", "node", "bin", "node.exe"));
        RequireNormalFile(Path.Combine(release, "runtime", "shell", "EquinoxLocal.exe"));
        RequireNormalFile(Path.Combine(release, "runtime", "browser", "equinox-browser-native-host.exe"));

        InspectionPhase = "native-stage-b-full-fingerprint";
        var measured = FingerprintNativeMainRelease(release);
        if (measured.Sha256 != fingerprint.GetProperty("sha256").GetString() ||
            measured.Entries != fingerprint.GetProperty("entries").GetInt64() ||
            measured.Bytes != fingerprint.GetProperty("bytes").GetInt64())
            throw new InvalidDataException("Native B release bytes differ from the exact immutable fingerprint.");

        return (measured.Sha256, measured.Entries, measured.Bytes);
    }

}
