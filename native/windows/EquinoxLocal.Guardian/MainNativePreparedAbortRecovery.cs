using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    private static bool OsProcessExists(int pid)
    {
        if (pid <= 0) throw new InvalidDataException("Native orphan recovery has an invalid OS PID.");
        try
        {
            using var process = Process.GetProcessById(pid);
            return !process.HasExited;
        }
        catch (ArgumentException) { return false; }
    }

    // An explicit *quarantine*, not an automatic rollback or lease reclaim.
    // The original lock remains a .writer-lock on disk and Main update stays
    // blocked; future operator-supervised recovery can consume this evidence.
    // A verified stable A binary tree and both dead owners are mandatory.
    private static void ReconcileNativePreparedAbortOrphan()
    {
        InspectionPhase = "native-prepared-abort-orphan-stable-baseline";
        InspectBaseline(allowActiveOrphanForReconciliation: true);
        InspectionPhase = "native-prepared-abort-orphan-journal";
        InspectOwnedNativeTransitionJournal(allowExactPreparedAbortOrphanLock: true);

        var install = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Equinox Local");
        var tx = Path.Combine(install, "state", "main-update");
        var root = Path.Combine(tx, "guardian-journal");
        RequireNormalDirectory(root);
        using var active = ReadOwnedTransitionRecord(Path.Combine(tx, "active.json"), 8192);
        var id = active.RootElement.GetProperty("transactionId").GetString() ?? "";
        if (!NativeTransactionPattern.IsMatch(id))
            throw new InvalidDataException("Orphan abort has no exact active transaction.");
        // Native A alone is not enough: the managed source pointer must
        // still identify exact transaction A, never an already-switched B.
        var originalSha = active.RootElement.GetProperty("currentSha").GetString() ?? "";
        if (!SourceShaPattern.IsMatch(originalSha))
            throw new InvalidDataException("Orphan abort original A source SHA is invalid.");
        var pointerPath = Path.Combine(tx, "current-source.conf");
        RequireNormalFile(pointerPath);
        var pointerSize = new FileInfo(pointerPath).Length;
        if (pointerSize is < 15 or > 8192)
            throw new InvalidDataException("Orphan abort source pointer exceeds its bound.");
        var pointerRows = File.ReadAllText(pointerPath).Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(line => line.TrimEnd('\r')).ToArray();
        if (pointerRows.Length != 3 || pointerRows[0] != "schemaVersion=1" ||
            pointerRows[1] != "sourceRoot=" + Path.Combine(tx, "sources", originalSha) ||
            pointerRows[2] != "sha=" + originalSha)
            throw new InvalidDataException("Orphan abort cannot quarantine after Main source pointer switched away from A.");
        var journalPath = Path.Combine(root, id + ".json");
        using var journal = ReadOwnedTransitionRecord(journalPath, 8192);
        if (journal.RootElement.GetProperty("stage").GetString() != "rollback_started" ||
            journal.RootElement.GetProperty("sequence").GetInt32() != 1 ||
            journal.RootElement.GetProperty("previousNative").GetProperty("kind").GetString() != "stable")
            throw new InvalidDataException("Orphan quarantine requires first prepared abort with Stable A unchanged.");
        var updatedDigest = SHA256.HashData(File.ReadAllBytes(journalPath));
        var lockPath = Path.Combine(root, "." + id + ".writer-lock");
        var quarantinedLock = Path.Combine(root, "." + id + ".quarantined.writer-lock");
        var recoveryPath = Path.Combine(root, id + ".orphan-quarantine.json");
        RequireNormalFile(lockPath);
        if (File.Exists(quarantinedLock) || File.Exists(recoveryPath))
            throw new InvalidDataException("Native prepared abort orphan already has reconciliation evidence.");

        InspectionPhase = "native-prepared-abort-orphan-owner-death";
        var lockBytes = File.ReadAllBytes(lockPath);
        if (lockBytes.Length is < 8 or > 512)
            throw new InvalidDataException("Native orphan lock is unbounded.");
        var lines = System.Text.Encoding.ASCII.GetString(lockBytes).Split('\n');
        if (lines.Length != 5 || lines[0] != "schemaVersion=1" || lines[1] != "transactionId=" + id ||
            !lines[2].StartsWith("workerPid=", StringComparison.Ordinal) ||
            !lines[3].StartsWith("guardianPid=", StringComparison.Ordinal) || lines[4] != "" ||
            !int.TryParse(lines[2]["workerPid=".Length..], NumberStyles.None, CultureInfo.InvariantCulture, out var workerPid) ||
            !int.TryParse(lines[3]["guardianPid=".Length..], NumberStyles.None, CultureInfo.InvariantCulture, out var guardianPid) ||
            workerPid <= 0 || guardianPid <= 0 || workerPid == guardianPid)
            throw new InvalidDataException("Native orphan lock does not contain the exact native worker and Guardian PIDs.");
        if (OsProcessExists(workerPid) || OsProcessExists(guardianPid))
            throw new InvalidDataException("Orphan quarantine refuses a still-live or reused Windows OS PID.");
        var handoff = Path.Combine(tx, "handoff", id + ".windows-worker.json");
        using var handoffDoc = ReadOwnedTransitionRecord(handoff, 8192);
        if (handoffDoc.RootElement.GetProperty("transactionId").GetString() != id ||
            handoffDoc.RootElement.GetProperty("pid").GetInt32() != workerPid)
            throw new InvalidDataException("Native orphan worker handoff conflicts with persistent lock ownership.");

        InspectionPhase = "native-prepared-abort-orphan-proof";
        using var authority = ReadOwnedTransitionRecord(Path.Combine(root, id + ".native-authority.json"), 8192);
        var auth = authority.RootElement;
        RequireExactKeys(auth, ["schemaVersion", "transactionId", "stage", "sequence", "workerPid", "guardianPid", "journalSha256"]);
        if (auth.GetProperty("schemaVersion").GetInt32() != 1 ||
            auth.GetProperty("transactionId").GetString() != id ||
            auth.GetProperty("stage").GetString() != "prepared" || auth.GetProperty("sequence").GetInt32() != 0 ||
            auth.GetProperty("workerPid").GetInt32() != workerPid ||
            auth.GetProperty("guardianPid").GetInt32() != guardianPid ||
            !DigestPattern.IsMatch(auth.GetProperty("journalSha256").GetString() ?? ""))
            throw new InvalidDataException("Orphan native authority sidecar has foreign worker or journal identity.");
        using var commit = ReadOwnedTransitionRecord(Path.Combine(root, id + ".abort-commit.json"), 8192);
        var done = commit.RootElement;
        RequireExactKeys(done, ["schemaVersion", "transactionId", "stage", "sequence", "guardianPid", "journalSha256"]);
        if (done.GetProperty("schemaVersion").GetInt32() != 1 ||
            done.GetProperty("transactionId").GetString() != id ||
            done.GetProperty("stage").GetString() != "rollback_started" ||
            done.GetProperty("sequence").GetInt32() != 1 ||
            done.GetProperty("guardianPid").GetInt32() != guardianPid ||
            !CryptographicOperations.FixedTimeEquals(
                System.Text.Encoding.ASCII.GetBytes(Convert.ToHexStringLower(updatedDigest)),
                System.Text.Encoding.ASCII.GetBytes(done.GetProperty("journalSha256").GetString() ?? "")))
            throw new InvalidDataException("Native abort commit proof does not match the exact durable journal.");

        InspectionPhase = "native-prepared-abort-orphan-write-quarantine";
        // Create-only evidence FIRST, write-through and fsync. A power loss
        // before renaming the original lock leaves a recorded partial attempt
        // and fails closed; neither mutation silently resumes or cleans state.
        using (var fd = new FileStream(recoveryPath, FileMode.CreateNew, FileAccess.Write,
            FileShare.None, 4096, FileOptions.WriteThrough))
        {
            using (var json = new Utf8JsonWriter(fd))
            {
                json.WriteStartObject();
                json.WriteNumber("schemaVersion", 1);
                json.WriteString("transactionId", id);
                json.WriteString("disposition", "quarantined-no-resume");
                json.WriteNumber("workerPid", workerPid);
                json.WriteNumber("guardianPid", guardianPid);
                json.WriteString("journalSha256", Convert.ToHexStringLower(updatedDigest));
                json.WriteEndObject();
                json.Flush();
            }
            fd.Flush(flushToDisk: true);
        }
        File.Move(lockPath, quarantinedLock);
        InspectionPhase = "native-prepared-abort-orphan-quarantined-still-blocked";
        // This explicitly retains a filename ending in .writer-lock: existing
        // Guardian audit MUST continue to refuse a new Main activation.
    }
}
