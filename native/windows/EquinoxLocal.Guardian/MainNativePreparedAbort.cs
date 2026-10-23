using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    // The FIRST narrowly permitted native-owned journal stage transition:
    // prepared/0 -> rollback_started/1 (no WPF/native B action is performed).
    // Never claim native_staged, switched, restarted, healthy or committed
    // without their independent OS-visible milestone evidence. This opt-in
    // pilot is not wired into production workers or installed Main upgrades.
    private static void WriteNativeJournalPreparedAbort(
        OwnedWorkerClaim owner, string journalPath, byte[] preparedBytes, byte[] expectedDigest)
    {
        InspectionPhase = "native-prepared-abort-preflight";
        if (preparedBytes.Length is < 2 or > 8192 ||
            !CryptographicOperations.FixedTimeEquals(SHA256.HashData(preparedBytes), expectedDigest))
            throw new InvalidDataException("Native abort cannot bind an invalid prepared generation.");
        using var doc = JsonDocument.Parse(preparedBytes);
        var state = doc.RootElement;
        RequireExactKeys(state, ["schemaVersion", "channel", "transactionId", "target", "currentSha", "targetSha",
            "receiptStartedAt", "previousNative", "targetRuntimeContractSha256", "stage", "sequence", "createdAt", "updatedAt"]);
        if (state.GetProperty("transactionId").GetString() != owner.TransactionId ||
            state.GetProperty("stage").GetString() != "prepared" ||
            state.GetProperty("sequence").GetInt32() != 0 ||
            state.GetProperty("schemaVersion").GetInt32() != 1 ||
            state.GetProperty("channel").GetString() != "main")
            throw new InvalidDataException("Native abort requires exact owned prepared sequence zero.");
        var at = DateTimeOffset.UtcNow.ToString(CanonicalUtcTime, CultureInfo.InvariantCulture);
        if (string.CompareOrdinal(at, state.GetProperty("updatedAt").GetString()) < 0)
            throw new InvalidDataException("Native prepared abort timestamp moved backwards.");
        var journalDir = Path.GetDirectoryName(journalPath) ?? throw new InvalidDataException("Native journal has no root.");
        var temp = Path.Combine(journalDir, "." + owner.TransactionId + ".json." +
            Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(8)) + ".tmp");
        InspectionPhase = "native-prepared-abort-create-durable-candidate";
        // Create-only, write-through same-volume staging. Its persistent name
        // is intentionally recognized by the Guardian journal recovery audit
        // after a crash, blocking automatic replay/overwrite.
        using (var file = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
        {
            using (var writer = new Utf8JsonWriter(file))
            {
                writer.WriteStartObject();
                foreach (var field in state.EnumerateObject())
                {
                    if (field.NameEquals("stage")) writer.WriteString("stage", "rollback_started");
                    else if (field.NameEquals("sequence")) writer.WriteNumber("sequence", 1);
                    else if (field.NameEquals("updatedAt")) writer.WriteString("updatedAt", at);
                    else field.WriteTo(writer);
                }
                writer.WriteEndObject();
                writer.Flush();
            }
            file.Flush(flushToDisk: true);
            if (file.Length > 8192)
                throw new InvalidDataException("Native prepared abort journal exceeded bound.");
        }
        InspectionPhase = "native-prepared-abort-compare-and-promote";
        RequireNormalFile(journalPath);
        var observed = File.ReadAllBytes(journalPath);
        if (!CryptographicOperations.FixedTimeEquals(expectedDigest, SHA256.HashData(observed)))
            throw new InvalidDataException("Native prepared journal changed before abort commit.");
        // Atomic same-volume rename. With the exclusive OS writer lease held,
        // no product writer can claim the journal concurrently. Never clean
        // leftover candidate/lease evidence automatically on failure.
        File.Move(temp, journalPath, overwrite: true);
        using var committed = ReadOwnedTransitionRecord(journalPath, 8192);
        if (committed.RootElement.GetProperty("transactionId").GetString() != owner.TransactionId ||
            committed.RootElement.GetProperty("stage").GetString() != "rollback_started" ||
            committed.RootElement.GetProperty("sequence").GetInt32() != 1)
            throw new InvalidDataException("Native journal prepared abort commit cannot be verified.");
        InspectionPhase = "native-prepared-abort-durable-commit-receipt";
        // A separate immutable completion marker lets a recovery auditor
        // distinguish a fully flushed journal from a partially interrupted
        // commit, without reading an OS-locked journal while Guardian lives.
        var marker = Path.Combine(journalDir, owner.TransactionId + ".abort-commit.json");
        using (var receipt = new FileStream(marker, FileMode.CreateNew, FileAccess.Write,
            FileShare.None, 4096, FileOptions.WriteThrough))
        {
            using (var json = new Utf8JsonWriter(receipt))
            {
                json.WriteStartObject();
                json.WriteNumber("schemaVersion", 1);
                json.WriteString("transactionId", owner.TransactionId);
                json.WriteString("stage", "rollback_started");
                json.WriteNumber("sequence", 1);
                json.WriteNumber("guardianPid", Environment.ProcessId);
                // Link the original prepared authority proof to the *exact*
                // post-abort journal generation in one durable native receipt.
                json.WriteString("preparedJournalSha256", Convert.ToHexStringLower(expectedDigest));
                json.WriteString("journalSha256", Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(journalPath))));
                json.WriteEndObject();
                json.Flush();
            }
            receipt.Flush(flushToDisk: true);
        }
        InspectionPhase = "native-prepared-abort-committed-under-lease";
    }
}
