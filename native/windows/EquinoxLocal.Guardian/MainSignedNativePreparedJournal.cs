using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    // Phase ONE for the SAME original signed Guardian: a crash-DURABLE
    // PREPARED-only native journal. It is deliberately disjoint from the
    // Git journal and its mutation opcodes. The original WPF and Node worker
    // are NOT authorized to stop A, switch B or change NativeMessaging.
    //
    // Only the Guardian that is holding a live exclusive Windows kernel
    // owner lease, after full original Ed25519 ZIP/NTFS and fresh worker
    // HMAC proof, can CREATE this record. No generic retry/overwrite/reclaim.
    private static void PrepareSignedNativeJournalWithoutMutation()
    {
        InspectSignedNativeOwnerExclusiveLeaseWithoutGrant(
            PrepareSignedNativeJournalUnderOriginalLiveOwner);
    }

    private static string OriginalSignedJournalPath(string transactionRoot, string transactionId)
    {
        if (!NativeTransactionPattern.IsMatch(transactionId))
            throw new InvalidDataException("Original signed-native journal ID is invalid.");
        return Path.Combine(transactionRoot, "guardian-journal",
            transactionId + ".signed-native.json");
    }

    private static string HashOriginalBoundedSignedNativeFile(string filePath)
    {
        RequireNormalFile(filePath);
        using var file = new FileStream(filePath, FileMode.Open, FileAccess.Read,
            FileShare.Read, 8192, FileOptions.SequentialScan);
        if (file.Length is < 2 or > 8192)
            throw new InvalidDataException("Original signed-native journal evidence size is invalid.");
        return Convert.ToHexStringLower(SHA256.HashData(file));
    }

    private static void PrepareSignedNativeJournalUnderOriginalLiveOwner(
        string id, string sha, string target, string contract, int workerPid, string workerTicks)
    {
        InspectionPhase = "signed-native-prepared-journal-under-live-owner";
        if (!NativeTransactionPattern.IsMatch(id) || !SourceShaPattern.IsMatch(sha) ||
            !DigestPattern.IsMatch(contract) || workerPid < 1 ||
            !WorkerTicksPattern.IsMatch(workerTicks))
            throw new InvalidDataException("Original signed-native prepared journal identity is malformed.");

        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var root = Path.Combine(local, "Equinox Local", "state", "main-update");
        var journalRoot = Path.Combine(root, "guardian-journal");
        // Must already have been provisioned with the original product's
        // private state ACL; no silent new open-permission directory.
        RequireNormalDirectory(journalRoot);
        // A different abandoned signed-native prepared owner cannot be
        // made to disappear by starting a fresh transaction.
        foreach (var item in Directory.EnumerateFileSystemEntries(journalRoot))
        {
            if (Path.GetFileName(item).EndsWith(".signed-native.json",
                    StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException(
                    "Original signed-native prepared journal requires independent crash reconciliation.");
        }

        var receipt = Path.Combine(root, "receipts", id + ".signed-native.json");
        var descriptor = Path.Combine(root, "staging", id,
            "native-rollback", "native-recovery.json");
        var receiptSha = HashOriginalBoundedSignedNativeFile(receipt);
        var rollbackSha = HashOriginalBoundedSignedNativeFile(descriptor);
        // Genuine rollback A must be independently intact BEFORE creating
        // any crash-durable signed-native PREPARED marker. In particular,
        // previously selected signed Main A has no Git/stable fallback.
        InspectOriginalSignedNativePreviousABaseline(id, sha, target, contract);
        var journalPath = OriginalSignedJournalPath(root, id);
        // This executable is PublishTrimmed/PublishSingleFile: never use
        // reflection-based JsonSerializer for its crash-durable authority.
        // Explicit property order and field types are the versioned ABI.
        using var bodyBuffer = new MemoryStream(1024);
        using (var json = new Utf8JsonWriter(bodyBuffer))
        {
            json.WriteStartObject();
            json.WriteNumber("schemaVersion", 1);
            json.WriteString("channel", "main");
            json.WriteString("kind", "signed-native");
            json.WriteString("transactionId", id);
            json.WriteString("sourceSha", sha);
            json.WriteString("target", target);
            json.WriteString("runtimeContractSha256", contract);
            json.WriteString("stage", "prepared");
            json.WriteNumber("sequence", 0);
            json.WriteNumber("workerPid", workerPid);
            json.WriteString("workerStartTimeUtcTicks", workerTicks);
            json.WriteNumber("guardianPid", Environment.ProcessId);
            json.WriteString("guardianStartTimeUtcTicks", Process.GetCurrentProcess()
                .StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture));
            json.WriteString("receiptSha256", receiptSha);
            json.WriteString("rollbackDescriptorSha256", rollbackSha);
            json.WriteEndObject();
            json.Flush();
        }
        if (bodyBuffer.Length is < 128 or > 4096)
            throw new InvalidDataException("Original signed-native prepared record length is invalid.");
        // FileMode.CreateNew + FileShare.None with flush-to-disk: a crash
        // before an entire JSON write leaves a forensic orphan, NEVER an
        // automatically accepted journal. No token/key is written to disk.
        using var journal = new FileStream(journalPath, FileMode.CreateNew, FileAccess.Write,
            FileShare.None, 8192, FileOptions.WriteThrough);
        bodyBuffer.Position = 0;
        bodyBuffer.CopyTo(journal);
        journal.Flush(flushToDisk: true);

        using var worker = Process.GetProcessById(workerPid);
        if (worker.HasExited ||
            worker.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != workerTicks)
            throw new InvalidDataException(
                "Original signed-native worker exited after durable prepared record; explicit recovery is required.");
        InspectionPhase = "signed-native-prepared-durable-NO-mutation";
    }

    // Crash/restart INSPECTION only. It never promotes the prepared record
    // to a lease, clears active.json, or decides that B is healthy.
    private static void AuditSignedNativePreparedJournalWithoutGrant()
    {
        InspectionPhase = "signed-native-prepared-crash-audit";
        // Recompute the ORIGINAL production Ed25519 signature, retained
        // signed ZIP/extracted B and current exact A/rollback identity.
        InspectOwnedSignedNativeJournalWithoutGrant();
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var root = Path.Combine(local, "Equinox Local", "state", "main-update");
        using var activeDoc = ReadOwnedTransitionRecord(Path.Combine(root, "active.json"), 8192);
        var active = activeDoc.RootElement;
        RequireExactKeys(active, ["schemaVersion", "kind", "transactionId",
            "sourceSha", "target", "runtimeContractSha256"]);
        var id = active.GetProperty("transactionId").GetString() ?? "";
        var sha = active.GetProperty("sourceSha").GetString() ?? "";
        var target = active.GetProperty("target").GetString() ?? "";
        var contract = active.GetProperty("runtimeContractSha256").GetString() ?? "";
        if (active.GetProperty("schemaVersion").GetInt32() != 1 ||
            active.GetProperty("kind").GetString() != "signed-native" ||
            !NativeTransactionPattern.IsMatch(id) || !SourceShaPattern.IsMatch(sha) ||
            !DigestPattern.IsMatch(contract))
            throw new InvalidDataException("Signed-native prepared record has no original active owner.");
        var journalRoot = Path.Combine(root, "guardian-journal");
        RequireNormalDirectory(journalRoot);
        using var document = ReadOwnedTransitionRecord(
            OriginalSignedJournalPath(root, id), 4096);
        var j = document.RootElement;
        RequireExactKeys(j, ["schemaVersion", "channel", "kind", "transactionId",
            "sourceSha", "target", "runtimeContractSha256", "stage", "sequence",
            "workerPid", "workerStartTimeUtcTicks", "guardianPid", "guardianStartTimeUtcTicks",
            "receiptSha256", "rollbackDescriptorSha256"]);
        if (j.GetProperty("schemaVersion").GetInt32() != 1 ||
            j.GetProperty("channel").GetString() != "main" ||
            j.GetProperty("kind").GetString() != "signed-native" ||
            j.GetProperty("transactionId").GetString() != id ||
            j.GetProperty("sourceSha").GetString() != sha ||
            j.GetProperty("target").GetString() != target ||
            j.GetProperty("runtimeContractSha256").GetString() != contract ||
            j.GetProperty("stage").GetString() != "prepared" ||
            j.GetProperty("sequence").GetInt32() != 0 ||
            j.GetProperty("workerPid").GetInt32() < 1 ||
            !WorkerTicksPattern.IsMatch(j.GetProperty("workerStartTimeUtcTicks").GetString() ?? "") ||
            j.GetProperty("guardianPid").GetInt32() < 1 ||
            j.GetProperty("guardianPid").GetInt32() == j.GetProperty("workerPid").GetInt32() ||
            !WorkerTicksPattern.IsMatch(j.GetProperty("guardianStartTimeUtcTicks").GetString() ?? ""))
            throw new InvalidDataException("Original signed-native journal has an unknown stage/identity.");
        var receiptSha = HashOriginalBoundedSignedNativeFile(
            Path.Combine(root, "receipts", id + ".signed-native.json"));
        var rollbackSha = HashOriginalBoundedSignedNativeFile(
            Path.Combine(root, "staging", id, "native-rollback", "native-recovery.json"));
        if (j.GetProperty("receiptSha256").GetString() != receiptSha ||
            j.GetProperty("rollbackDescriptorSha256").GetString() != rollbackSha)
            throw new InvalidDataException("Signed-native prepared crash journal evidence was replaced.");
        // A claimed PREPARED success is never sufficient to reclaim the
        // orphan or to authorize an OS mutation. Recovery remains explicit.
        InspectionPhase = "signed-native-prepared-reconciled-read-only";
    }
}
