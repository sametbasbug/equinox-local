using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    private static readonly Regex NativeTransactionPattern = new("^main-[a-f0-9]{32}$", RegexOptions.CultureInvariant);
    private const string CanonicalUtcTime = "yyyy-MM-dd'T'HH:mm:ss.fff'Z'";

    private static bool ValidNativeJournalTime(string? value) =>
        value is not null && DateTimeOffset.TryParseExact(value, CanonicalUtcTime,
            CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out _);

    private static JsonDocument ReadOwnedTransitionRecord(string file, int limit)
    {
        InspectionPhase = "native-journal-bounded-read";
        RequireNormalFile(file);
        // Verify the byte bound and parse using the SAME read-only Windows
        // handle. A separate FileInfo.Length + File.ReadAllBytes pathname read
        // could observe a replaced or expanded record after the size check.
        // Read sharing excludes competing write/delete opens while parsing.
        using var handle = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (handle.Length is < 2 or > 65536 || handle.Length > limit)
            throw new InvalidDataException("Owned transition record exceeds its strict size bound.");
        return JsonDocument.Parse(handle);
    }

    private static void InspectOwnedNativeTransitionJournal(bool allowExactPreparedAbortOrphanLock = false)
    {
        InspectionPhase = "native-journal-owner";
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrWhiteSpace(local) || !Path.IsPathFullyQualified(local))
            throw new InvalidDataException("Native journal user root is unavailable.");
        var install = Path.Combine(local, "Equinox Local");
        var guardianDir = Path.Combine(install, "runtime", "guardian");
        var ownedGuardian = Path.Combine(guardianDir, "EquinoxLocalGuardian.exe");
        if (!Compare.Equals(Path.GetFullPath(Environment.ProcessPath ?? ""), Path.GetFullPath(ownedGuardian)))
            throw new InvalidDataException("Native journal inspector is not the owned Guardian.");
        RequireNormalDirectory(install);
        RequireNormalDirectory(Path.Combine(install, "runtime"));
        RequireNormalDirectory(guardianDir);
        RequireNormalFile(ownedGuardian);
        var tx = Path.Combine(install, "state", "main-update");
        RequireNormalDirectory(Path.Combine(install, "state"));
        RequireNormalDirectory(tx);
        var target = RuntimeInformation.ProcessArchitecture switch
        {
            Architecture.X64 => "win32-x64",
            Architecture.Arm64 => "win32-arm64",
            _ => throw new PlatformNotSupportedException("Unsupported native journal architecture."),
        };

        InspectionPhase = "native-journal-active-owner";
        using var lockDoc = ReadOwnedTransitionRecord(Path.Combine(tx, "active.json"), 8192);
        var marker = lockDoc.RootElement;
        RequireExactKeys(marker, ["schemaVersion", "transactionId", "channel", "currentSha", "targetSha", "startedAt"]);
        var id = marker.GetProperty("transactionId").GetString() ?? "";
        var oldSha = marker.GetProperty("currentSha").GetString() ?? "";
        var newSha = marker.GetProperty("targetSha").GetString() ?? "";
        var startedAt = marker.GetProperty("startedAt").GetString();
        if (marker.GetProperty("schemaVersion").GetInt32() != 1 ||
            marker.GetProperty("channel").GetString() != "main" ||
            !NativeTransactionPattern.IsMatch(id) || !SourceShaPattern.IsMatch(oldSha) ||
            !SourceShaPattern.IsMatch(newSha) || oldSha == newSha ||
            !ValidNativeJournalTime(startedAt))
            throw new InvalidDataException("Native journal owning Main transaction marker is invalid.");

        InspectionPhase = "native-journal-receipt-owner";
        var receiptDir = Path.Combine(tx, "receipts");
        RequireNormalDirectory(receiptDir);
        using var receiptDoc = ReadOwnedTransitionRecord(Path.Combine(receiptDir, id + ".json"), 65536);
        var receipt = receiptDoc.RootElement;
        RequireExactKeys(receipt, ["schemaVersion", "transactionId", "channel", "status", "stage", "currentSha", "targetSha",
            "rollbackSha", "rollbackSourceRoot", "targetSourceRoot", "startedAt", "updatedAt", "lastError"]);
        var status = receipt.GetProperty("status").GetString() ?? "";
        if (receipt.GetProperty("schemaVersion").GetInt32() != 1 ||
            receipt.GetProperty("channel").GetString() != "main" ||
            receipt.GetProperty("transactionId").GetString() != id ||
            receipt.GetProperty("currentSha").GetString() != oldSha ||
            receipt.GetProperty("targetSha").GetString() != newSha ||
            receipt.GetProperty("rollbackSha").GetString() != oldSha ||
            receipt.GetProperty("startedAt").GetString() != startedAt ||
            !ValidNativeJournalTime(receipt.GetProperty("updatedAt").GetString()) ||
            status is not ("promoting" or "verifying") ||
            receipt.GetProperty("lastError").ValueKind is not (JsonValueKind.Null or JsonValueKind.String))
            throw new InvalidDataException("Native journal receipt does not match its active Main owner.");
        var receiptStage = receipt.GetProperty("stage").GetString();
        if (!(status == "promoting" && (receiptStage is "ready_to_switch" or "native_rollback_ready" or "native_switched")) &&
            !(status == "verifying" && (receiptStage is "source_switched" or "rollback_source_restored" or "rollback_native_restored")))
            throw new InvalidDataException("Main receipt status and stage cannot own native journal progress.");

        InspectionPhase = "native-journal-writer-ownership";
        var journalDir = Path.Combine(tx, "guardian-journal");
        RequireNormalDirectory(journalDir);
        // Never reclaim an interrupted writer; an external trusted supervisor
        // must prove its death and reconcile the durable receipt independently.
        foreach (var entry in Directory.EnumerateFileSystemEntries(journalDir))
        {
            var name = Path.GetFileName(entry);
            if ((name.EndsWith(".writer-lock", StringComparison.OrdinalIgnoreCase) &&
                 !(allowExactPreparedAbortOrphanLock && name == "." + id + ".writer-lock")) ||
                name.StartsWith("." + id + ".json.", StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Unreconciled native journal writer or staging file blocks audit.");
        }
        using var journalDoc = ReadOwnedTransitionRecord(Path.Combine(journalDir, id + ".json"), 8192);
        var journal = journalDoc.RootElement;
        RequireExactKeys(journal, ["schemaVersion", "channel", "transactionId", "target", "currentSha", "targetSha",
            "receiptStartedAt", "previousNative", "targetRuntimeContractSha256", "stage", "sequence", "createdAt", "updatedAt"]);
        var stage = journal.GetProperty("stage").GetString() ?? "";
        var sequence = journal.GetProperty("sequence").GetInt32();
        if (stage is "committed" or "rolled_back")
            throw new InvalidDataException("Terminal journal stage with active Main lock is unproven.");
        var allowedSequence = stage switch
        {
            "prepared" => (0, 0), "native_staged" => (1, 1), "shell_stopped" => (2, 2),
            "switched" => (3, 3), "restarted" => (4, 4), "healthy" => (5, 5),
            "rollback_started" => (1, 6), "rollback_native_restored" => (2, 7),
            "rollback_healthy" => (3, 8), _ => (-1, -1),
        };
        // A journal claiming terminal success/rollback while still owning an
        // active Main lock is never sufficient proof to launch or resume.
        if (allowedSequence.Item1 < 0 || sequence < allowedSequence.Item1 || sequence > allowedSequence.Item2 ||
            journal.GetProperty("schemaVersion").GetInt32() != 1 ||
            journal.GetProperty("channel").GetString() != "main" ||
            journal.GetProperty("transactionId").GetString() != id ||
            journal.GetProperty("target").GetString() != target ||
            journal.GetProperty("currentSha").GetString() != oldSha ||
            journal.GetProperty("targetSha").GetString() != newSha ||
            journal.GetProperty("receiptStartedAt").GetString() != startedAt ||
            !DigestPattern.IsMatch(journal.GetProperty("targetRuntimeContractSha256").GetString() ?? "") ||
            !ValidNativeJournalTime(journal.GetProperty("createdAt").GetString()) ||
            !ValidNativeJournalTime(journal.GetProperty("updatedAt").GetString()))
            throw new InvalidDataException("Native transition journal differs from exact active receipt identity or stage.");
        var journalCreated = journal.GetProperty("createdAt").GetString();
        var journalUpdated = journal.GetProperty("updatedAt").GetString();
        if (string.CompareOrdinal(journalUpdated, journalCreated) < 0 ||
            string.CompareOrdinal(receipt.GetProperty("updatedAt").GetString(), startedAt) < 0)
            throw new InvalidDataException("Native journal or receipt time regressed.");
        var nativeA = journal.GetProperty("previousNative");
        var nativeKind = nativeA.GetProperty("kind").GetString();
        if (nativeKind == "stable")
        {
            RequireExactKeys(nativeA, ["kind", "version"]);
            if (!VersionRegex().IsMatch(nativeA.GetProperty("version").GetString() ?? ""))
                throw new InvalidDataException("Previous Stable native identity is invalid.");
        }
        else if (nativeKind == "main")
        {
            RequireExactKeys(nativeA, ["kind", "sourceSha", "runtimeContractSha256"]);
            if (nativeA.GetProperty("sourceSha").GetString() != oldSha ||
                !DigestPattern.IsMatch(nativeA.GetProperty("runtimeContractSha256").GetString() ?? ""))
                throw new InvalidDataException("Previous Main native identity changed from original A.");
        }
        else throw new InvalidDataException("Previous native A identity is missing.");
        InspectionPhase = "native-journal-structural-audit-complete";
        // A 0 exit code here only means the three records are structurally
        // consistent. It does NOT authorize slot swap, replay, WPF restart,
        // terminal success, or recovery of a killed writer.
    }
}
