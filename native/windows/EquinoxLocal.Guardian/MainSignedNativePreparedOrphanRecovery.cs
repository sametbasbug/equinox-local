using System.Security.Cryptography;
using System.Text.Json;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    // Explicit forensic recovery only. Never automatically remove an orphan:
    // PREPARED/0 alone does not prove WPF, active Main slot or Chrome NM were
    // untouched. This checks original Stable or production-signed Main A,
    // writes durable quarantine evidence, and keeps .signed-native.json.
    // Clean A=null first install requires independent baseline proof.
    private static void ReconcileSignedNativePreparedOrphanWithoutResuming()
    {
        InspectionPhase = "signed-native-orphan-exclusive-recovery";
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var install = Path.Combine(local, "Equinox Local");
        var root = Path.Combine(install, "state", "main-update");
        var journalRoot = Path.Combine(root, "guardian-journal");
        RequireNormalDirectory(journalRoot);
        using var activeDoc = ReadOwnedTransitionRecord(Path.Combine(root, "active.json"), 8192);
        var active = activeDoc.RootElement;
        RequireExactKeys(active, ["schemaVersion", "kind", "transactionId", "sourceSha", "target", "runtimeContractSha256"]);
        var id = active.GetProperty("transactionId").GetString() ?? "";
        if (active.GetProperty("schemaVersion").GetInt32() != 1 ||
            active.GetProperty("kind").GetString() != "signed-native" ||
            !NativeTransactionPattern.IsMatch(id))
            throw new InvalidDataException("Signed-native orphan requires exact original active ownership.");
        var journalPath = OriginalSignedJournalPath(root, id);
        RequireNormalFile(journalPath);
        using var pinnedJournal = new FileStream(journalPath, FileMode.Open, FileAccess.Read,
            FileShare.Read, 8192, FileOptions.SequentialScan);
        if (pinnedJournal.Length is < 128 or > 4096)
            throw new InvalidDataException("Signed-native orphan prepared bytes are incomplete or oversized.");
        using var doc = JsonDocument.Parse(pinnedJournal);
        var journal = doc.RootElement;
        RequireExactKeys(journal, ["schemaVersion", "channel", "kind", "transactionId",
            "sourceSha", "target", "runtimeContractSha256", "stage", "sequence",
            "workerPid", "workerStartTimeUtcTicks", "guardianPid", "guardianStartTimeUtcTicks",
            "receiptSha256", "rollbackDescriptorSha256"]);
        if (journal.GetProperty("schemaVersion").GetInt32() != 1 ||
            journal.GetProperty("channel").GetString() != "main" ||
            journal.GetProperty("kind").GetString() != "signed-native" ||
            journal.GetProperty("transactionId").GetString() != id ||
            journal.GetProperty("stage").GetString() != "prepared" ||
            journal.GetProperty("sequence").GetInt32() != 0)
            throw new InvalidDataException("Signed-native orphan is not original PREPARED/0.");
        var workerPid = journal.GetProperty("workerPid").GetInt32();
        var guardianPid = journal.GetProperty("guardianPid").GetInt32();
        if (workerPid < 1 || guardianPid < 1 || workerPid == guardianPid ||
            !WorkerTicksPattern.IsMatch(journal.GetProperty("workerStartTimeUtcTicks").GetString() ?? "") ||
            !WorkerTicksPattern.IsMatch(journal.GetProperty("guardianStartTimeUtcTicks").GetString() ?? ""))
            throw new InvalidDataException("Signed-native orphan owner birth/PID is invalid.");
        var recoveryName = id + ".signed-native-orphan-quarantine.json";
        var recoveryPath = Path.Combine(journalRoot, recoveryName);
        if (File.Exists(recoveryPath) || Directory.Exists(recoveryPath))
            throw new InvalidDataException("Signed-native orphan already has recovery evidence.");
        // One exact forensic journal, no competing Git authority, no partial
        // native transition/other temp file; any ambiguity stays blocked.
        foreach (var entry in Directory.EnumerateFileSystemEntries(journalRoot))
        {
            var name = Path.GetFileName(entry);
            if (name == Path.GetFileName(journalPath)) continue;
            if (name.EndsWith(".signed-native.json", StringComparison.OrdinalIgnoreCase) ||
                name.EndsWith(".writer-lock", StringComparison.OrdinalIgnoreCase) ||
                name.EndsWith(".guardian-session-lock", StringComparison.OrdinalIgnoreCase) ||
                name.EndsWith(".tmp", StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("A competing native OS journal or uncommitted stage blocks orphan quarantine.");
        }
        var leasePath = Path.Combine(journalRoot, "." + id + ".signed-native-recovery.lock");
        using var lease = new FileStream(leasePath, FileMode.CreateNew, FileAccess.ReadWrite,
            FileShare.None, 4096, FileOptions.DeleteOnClose | FileOptions.WriteThrough);
        lease.WriteByte(1);
        lease.Flush(flushToDisk: true);

        InspectionPhase = "signed-native-orphan-owners-dead";
        // A reused PID is conservatively treated as live, never as proof the
        // old worker/Guardian is absent. Do not kill either process.
        if (OsProcessExists(workerPid) || OsProcessExists(guardianPid))
            throw new InvalidDataException("Original signed-native owner PID is still live or has been reused.");
        var handoffPath = Path.Combine(root, "handoff", id + ".windows-worker.json");
        using (var handoffDoc = ReadOwnedTransitionRecord(handoffPath, 8192))
        {
            var handoff = handoffDoc.RootElement;
            RequireExactKeys(handoff, ["schemaVersion", "transactionId", "pid", "startTimeUtcTicks", "token", "nodePath"]);
            if (handoff.GetProperty("schemaVersion").GetInt32() != 1 ||
                handoff.GetProperty("transactionId").GetString() != id ||
                handoff.GetProperty("pid").GetInt32() != workerPid ||
                handoff.GetProperty("startTimeUtcTicks").GetString() !=
                    journal.GetProperty("workerStartTimeUtcTicks").GetString())
                throw new InvalidDataException("Original dead worker handoff has a foreign kernel identity.");
        }

        InspectionPhase = "signed-native-orphan-original-signed-b";
        // Full original production Ed25519 selector, retained ZIP and each
        // extracted B byte; exact A rollback descriptor and receipt hashes.
        // pinnedJournal excludes a concurrent journal write during the audit.
        AuditSignedNativePreparedJournalWithoutGrant();
        pinnedJournal.Position = 0;
        var journalSha = Convert.ToHexStringLower(SHA256.HashData(pinnedJournal));

        InspectionPhase = "signed-native-orphan-original-a-unchanged";
        using var descriptorDoc = ReadOwnedTransitionRecord(Path.Combine(root,
            "staging", id, "native-rollback", "native-recovery.json"), 8192);
        var previous = descriptorDoc.RootElement.GetProperty("previous");
        var previousKind = previous.GetProperty("kind").GetString() ?? "";
        string previousIdentity;
        if (previousKind == "stable")
        {
            RequireExactKeys(previous, ["kind", "version"]);
            previousIdentity = previous.GetProperty("version").GetString() ?? "";
            if (!VersionRegex().IsMatch(previousIdentity))
                throw new InvalidDataException("Signed-native orphan Stable A version is malformed.");
        }
        else if (previousKind == "main")
        {
            RequireExactKeys(previous, ["kind", "sourceSha", "target", "runtimeContractSha256"]);
            previousIdentity = previous.GetProperty("sourceSha").GetString() ?? "";
            if (!SourceShaPattern.IsMatch(previousIdentity))
                throw new InvalidDataException("Signed-native orphan Main A SHA is malformed.");
        }
        else throw new InvalidDataException("Signed-native orphan needs an original Stable or signed Main A.");

        // Independently verify SAME original signed B and the complete
        // current rollback A: full installed WPF tree, Ed25519/archive for
        // native Main A, exact current A pointer and HKCU Chrome NM launcher.
        // No Git identity or numbered Stable fallback is accepted for Main A.
        InspectOriginalSignedNativePreviousABaseline(id,
            active.GetProperty("sourceSha").GetString() ?? "",
            active.GetProperty("target").GetString() ?? "",
            active.GetProperty("runtimeContractSha256").GetString() ?? "");

        // One more independent owner check after hashing both A and B.
        // The original prepared journal/active marker remain blocking even
        // when new durable quarantine is successfully persisted.
        if (OsProcessExists(workerPid) || OsProcessExists(guardianPid))
            throw new InvalidDataException("Original OS owner changed before forensic quarantine.");
        pinnedJournal.Position = 0;
        if (!CryptographicOperations.FixedTimeEquals(
            SHA256.HashData(pinnedJournal), Convert.FromHexString(journalSha)))
            throw new InvalidDataException("Signed-native journal changed before forensic quarantine.");
        InspectionPhase = "signed-native-orphan-write-durable-quarantine";
        // This is NOT abort success, permission to delete active.json or
        // authorization to start a new update. The original PREPARED/0 file
        // stays intact and continues to block new signed-native admissions.
        using var record = new FileStream(recoveryPath, FileMode.CreateNew, FileAccess.Write,
            FileShare.None, 4096, FileOptions.WriteThrough);
        // Trim-safe fixed schema, no reflection or runtime serializer rooting.
        using (var json = new Utf8JsonWriter(record))
        {
            json.WriteStartObject();
            json.WriteNumber("schemaVersion", 1);
            json.WriteString("kind", "signed-native");
            json.WriteString("transactionId", id);
            json.WriteString("disposition", "quarantined-no-resume");
            json.WriteString("originalStage", "prepared");
            json.WriteNumber("sequence", 0);
            json.WriteString("journalSha256", journalSha);
            json.WriteString("previousKind", previousKind);
            json.WriteString("previousIdentity", previousIdentity);
            json.WriteNumber("workerPid", workerPid);
            json.WriteNumber("guardianPid", guardianPid);
            json.WriteEndObject();
            json.Flush();
        }
        record.Flush(flushToDisk: true);
        InspectionPhase = "signed-native-orphan-quarantined-still-blocked";
    }
}
