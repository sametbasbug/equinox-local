using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    // EXPLICIT operator-initiated quarantine of the original dead writer
    // marker, NOT a new OS writer, Main replay, B deletion or repair. The
    // quarantined filename STILL ENDS with '.writer-lock', so every normal
    // Main native admission remains blocked until a different authenticated
    // offline reconciliation procedure is developed and separately tested.
    private static void QuarantineOwnedFailedBRetirementOrphanWithoutReplay()
    {
        InspectionPhase = "native-retire-b-quarantine-read-only-evidence";
        var proof = InspectOwnedFailedBRetirementOrphanReadOnly();
        if (proof.Phase is not (
                "native-retire-b-orphan-intent-before-rename-no-replay" or
                "native-retire-b-orphan-after-rename-before-commit-no-replay" or
                "native-retire-b-offline-complete-but-no-writer-or-gc"))
            throw new InvalidDataException("Original B retirement has no recognized offline orphan disposition.");
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var tx = Path.Combine(local, "Equinox Local", "state", "main-update");
        var journalRoot = Path.Combine(tx, "guardian-journal");
        var sourcePointer = Path.Combine(tx, "current-source.conf");
        RequireNormalFile(sourcePointer);
        if (new FileInfo(sourcePointer).Length is < 15 or > 8192)
            throw new InvalidDataException("Offline B quarantine source pointer is unbounded.");
        using var journal = ReadOwnedTransitionRecord(Path.Combine(journalRoot, proof.TransactionId + ".json"), 8192);
        var sha = journal.RootElement.GetProperty("currentSha").GetString() ?? "";
        if (!SourceShaPattern.IsMatch(sha))
            throw new InvalidDataException("Offline B quarantine original A source SHA is invalid.");
        var rows = File.ReadAllText(sourcePointer).Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(row => row.TrimEnd('\r')).ToArray();
        if (rows.Length != 3 || rows[0] != "schemaVersion=1" ||
            rows[1] != "sourceRoot=" + Path.Combine(tx, "sources", sha) ||
            rows[2] != "sha=" + sha)
            throw new InvalidDataException("Offline B quarantine source pointer no longer selects signed Stable A.");
        RequireNormalDirectory(Path.Combine(tx, "sources", sha));
        var nativePointer = Path.Combine(tx, "current-native.json");
        if (File.Exists(nativePointer) || Directory.Exists(nativePointer))
            throw new InvalidDataException("Offline B quarantine still selects a Main native runtime.");

        var lockPath = Path.Combine(journalRoot, "." + proof.TransactionId + ".writer-lock");
        var quarantineLock = Path.Combine(journalRoot, "." + proof.TransactionId + ".quarantined.writer-lock");
        var receiptPath = Path.Combine(journalRoot, proof.TransactionId + ".failed-b-orphan-quarantine.json");
        RequireNormalDirectory(journalRoot);
        RequireNormalFile(lockPath);
        if (File.Exists(quarantineLock) || Directory.Exists(quarantineLock) ||
            File.Exists(receiptPath) || Directory.Exists(receiptPath))
            throw new InvalidDataException("Original B orphan lock has already been reconciled or has foreign recovery evidence.");
        foreach (var entry in Directory.EnumerateFileSystemEntries(journalRoot, "*.writer-lock"))
            if (Path.GetFileName(entry) != Path.GetFileName(lockPath))
                throw new InvalidDataException("Another native OS writer or retired lock makes B quarantine ambiguous.");
        // Win32 exclusive OPEN of the ORIGINAL lock proves no process still
        // owns its first FileShare.None handle. Never recreate a lock.
        byte[] lockBytes;
        InspectionPhase = "native-retire-b-quarantine-exclusive-original-lock";
        using (var lockFile = new FileStream(lockPath, FileMode.Open, FileAccess.Read,
            FileShare.None, 512, FileOptions.None))
        {
            if (lockFile.Length is < 8 or > 512)
                throw new InvalidDataException("Original first OS writer marker exceeds bound.");
            lockBytes = new byte[(int)lockFile.Length];
            lockFile.ReadExactly(lockBytes);
        }
        var lines = Encoding.ASCII.GetString(lockBytes).Split('\n');
        if (lines.Length != 5 || lines[0] != "schemaVersion=1" ||
            lines[1] != "transactionId=" + proof.TransactionId ||
            lines[2] != "workerPid=" + proof.WorkerPid.ToString(CultureInfo.InvariantCulture) ||
            lines[3] != "guardianPid=" + proof.GuardianPid.ToString(CultureInfo.InvariantCulture) ||
            lines[4] != "")
            throw new InvalidDataException("Offline orphan lock does not match the original worker/Guardian kernel owners.");
        InspectionPhase = "native-retire-b-quarantine-both-original-os-owners-dead";
        if (OsProcessExists(proof.WorkerPid) || OsProcessExists(proof.GuardianPid))
            throw new InvalidDataException("A claimed original Windows OS process is still live or its PID has been reused.");
        var handoffPath = Path.Combine(tx, "handoff", proof.TransactionId + ".windows-worker.json");
        using var handoff = ReadOwnedTransitionRecord(handoffPath, 8192);
        if (handoff.RootElement.GetProperty("schemaVersion").GetInt32() != 1 ||
            handoff.RootElement.GetProperty("transactionId").GetString() != proof.TransactionId ||
            handoff.RootElement.GetProperty("pid").GetInt32() != proof.WorkerPid ||
            !WorkerTicksPattern.IsMatch(handoff.RootElement.GetProperty("startTimeUtcTicks").GetString() ?? ""))
            throw new InvalidDataException("Offline worker birth identity differs from original signed Main handoff.");

        // Record explicit quarantine BEFORE moving the original lock. A crash
        // between receipt and rename remains visibly incomplete and refuses
        // a second automatic action; neither state allows Main startup.
        // Revalidate the same signed A/B and Q crash phase immediately
        // before sealing a one-shot, crash-visible operator quarantine.
        var again = InspectOwnedFailedBRetirementOrphanReadOnly();
        if (again != proof)
            throw new InvalidDataException("Original failed B crash evidence drifted before quarantine.");
        InspectionPhase = "native-retire-b-quarantine-write-through-no-replay-receipt";
        using (var fd = new FileStream(receiptPath, FileMode.CreateNew, FileAccess.Write,
            FileShare.None, 4096, FileOptions.WriteThrough))
        {
            using (var json = new Utf8JsonWriter(fd))
            {
                json.WriteStartObject();
                json.WriteNumber("schemaVersion", 1);
                json.WriteString("transactionId", proof.TransactionId);
                json.WriteString("disposition", "dead-first-guardian-writer-quarantined-no-replay-no-delete");
                json.WriteNumber("workerPid", proof.WorkerPid);
                json.WriteNumber("guardianPid", proof.GuardianPid);
                json.WriteString("stage8JournalSha256", proof.Stage8Sha256);
                json.WriteString("failedBSourceSha", proof.FailedBSourceSha);
                json.WriteString("observedPhase", proof.Phase);
                json.WriteString("originalWriterLockSha256", Convert.ToHexStringLower(SHA256.HashData(lockBytes)));
                json.WriteEndObject();
                json.Flush();
            }
            fd.Flush(flushToDisk: true);
        }
        InspectionPhase = "native-retire-b-quarantine-retire-dead-lock-still-blocking";
        if (OsProcessExists(proof.WorkerPid) || OsProcessExists(proof.GuardianPid) ||
            !CryptographicOperations.FixedTimeEquals(SHA256.HashData(lockBytes),
                SHA256.HashData(File.ReadAllBytes(lockPath))))
            throw new InvalidDataException("Original dead writer marker or Windows kernel PID changed before quarantine.");
        File.Move(lockPath, quarantineLock);
        RequireNormalFile(quarantineLock);
        if (!CryptographicOperations.FixedTimeEquals(SHA256.HashData(lockBytes),
            SHA256.HashData(File.ReadAllBytes(quarantineLock))))
            throw new InvalidDataException("Native quarantine lock differs from the original writer evidence.");
        // Re-observe every source/SHA before returning quarantine-only
        // success. NEVER accept the quarantined marker as a new OS writer.
        if (InspectOwnedFailedBRetirementOrphanReadOnly() != proof)
            throw new InvalidDataException("Signed A/B orphan state changed during dead-writer quarantine.");
        // ALWAYS retain a *.writer-lock marker; generic --audit-native-journal
        // must CONTINUE returning 70. This command never claims recovery.
        InspectionPhase = "native-retire-b-quarantined-lock-retained-main-still-blocked";
    }
}
