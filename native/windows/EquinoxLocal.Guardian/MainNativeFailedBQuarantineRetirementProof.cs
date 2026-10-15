using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    // Under the original live kernel writer ONLY, retire failed-B to an
    // exact transaction-scoped tombstone on the same NTFS volume. DO NOT
    // delete anything here. Two write-through markers and the atomic rename
    // make interrupted states observable but NEVER self-authorizing:
    // missing final commit or a dead Guardian means fail-closed recovery.
    private static void RetireOwnedFailedBQuarantineWithoutDeletion(
        OwnedWorkerClaim owner, string journalRoot, Process worker,
        FileStream lease, Stopwatch leaseAge, byte[] stage8Sha)
    {
        var journalPath = Path.Combine(journalRoot, owner.TransactionId + ".json");
        var intentPath = Path.Combine(journalRoot, owner.TransactionId + ".failed-b-retire.intent.json");
        var commitPath = Path.Combine(journalRoot, owner.TransactionId + ".failed-b-retired.commit.json");
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var programParent = Path.Combine(local, "Programs");
        var program = Path.Combine(programParent, "Equinox Local");
        var quarantine = Path.Combine(programParent, ".equinox-shell-failed-" + owner.TransactionId);
        var retired = Path.Combine(programParent, ".equinox-shell-retired-" + owner.TransactionId);
        var backup = Path.Combine(programParent, ".equinox-shell-backup-" + owner.TransactionId);
        RequireNormalDirectory(programParent);
        RequireNormalDirectory(program);
        RequireNormalDirectory(quarantine);
        if (Directory.Exists(retired) || File.Exists(retired) ||
            Directory.Exists(backup) || File.Exists(backup) ||
            File.Exists(intentPath) || File.Exists(commitPath))
            throw new InvalidDataException("Failed B retirement must be the first exact original-Guardian operation.");
        RequireOwnedRestoredATerminalReadiness(owner, journalRoot, worker, lease, leaseAge,
            requireTerminalStage8: true);
        var stage8Hex = Convert.ToHexStringLower(stage8Sha);
        using var journal = ReadOwnedTransitionRecord(journalPath, 8192);
        var failedSha = journal.RootElement.GetProperty("targetSha").GetString() ?? "";
        var target = journal.RootElement.GetProperty("target").GetString() ?? "";
        if (!SourceShaPattern.IsMatch(failedSha) || target is not ("win32-x64" or "win32-arm64") ||
            !CryptographicOperations.FixedTimeEquals(stage8Sha, SHA256.HashData(File.ReadAllBytes(journalPath))))
            throw new InvalidDataException("Failed B quarantine retirement is not bound to exact stage8.");
        var candidate = Path.Combine(local, "Equinox Local", "state", "main-update",
            "native-store", target, failedSha, "release", "runtime", "shell");
        CompareNativeTrees(candidate, quarantine);
        InspectionPhase = "native-integrated-a-retire-b-write-through-intent";
        // Durably seal original Guardian + transaction + exact stage8 and B
        // SHA BEFORE rename. No accidental double-grant across interruption.
        using (var fd = new FileStream(intentPath, FileMode.CreateNew, FileAccess.Write,
            FileShare.None, 4096, FileOptions.WriteThrough))
        {
            using (var writer = new Utf8JsonWriter(fd))
            {
                writer.WriteStartObject();
                writer.WriteNumber("schemaVersion", 1);
                writer.WriteString("transactionId", owner.TransactionId);
                writer.WriteString("disposition", "failed-b-retire-intent-no-delete");
                writer.WriteNumber("guardianPid", Environment.ProcessId);
                writer.WriteNumber("workerPid", owner.Pid);
                writer.WriteString("stage8JournalSha256", stage8Hex);
                writer.WriteString("failedBSourceSha", failedSha);
                writer.WriteEndObject();
                writer.Flush();
            }
            fd.Flush(flushToDisk: true);
        }
        // RECHECK original kernel owner, pointer/NM and full B SHA just
        // before the single same-parent atomic NTFS directory rename.
        RequireOwnedRestoredATerminalReadiness(owner, journalRoot, worker, lease, leaseAge,
            requireTerminalStage8: true);
        CompareNativeTrees(candidate, quarantine);
        if (Directory.Exists(retired) || File.Exists(retired))
            throw new InvalidDataException("Concurrent failed-B retirement destination appeared.");
        InspectionPhase = "native-integrated-a-retire-b-atomic-rename-no-delete";
        Directory.Move(quarantine, retired);
        InspectionPhase = "native-integrated-a-retire-b-post-rename-full-sha";
        RequireOwnedRestoredATerminalReadiness(owner, journalRoot, worker, lease, leaseAge,
            requireTerminalStage8: true, requireRetiredFailedB: true);
        if (!CryptographicOperations.FixedTimeEquals(stage8Sha, SHA256.HashData(File.ReadAllBytes(journalPath))) ||
            lease.SafeFileHandle.IsClosed || lease.SafeFileHandle.IsInvalid || worker.HasExited ||
            leaseAge.Elapsed >= TimeSpan.FromMinutes(20) ||
            worker.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks)
            throw new InvalidDataException("Original OS owner or stage8 changed after B retirement rename.");
        InspectionPhase = "native-integrated-a-retire-b-durable-no-delete-commit";
        using (var fd = new FileStream(commitPath, FileMode.CreateNew, FileAccess.Write,
            FileShare.None, 4096, FileOptions.WriteThrough))
        {
            using (var writer = new Utf8JsonWriter(fd))
            {
                writer.WriteStartObject();
                writer.WriteNumber("schemaVersion", 1);
                writer.WriteString("transactionId", owner.TransactionId);
                writer.WriteString("disposition", "failed-b-retired-still-on-disk-no-delete");
                writer.WriteNumber("guardianPid", Environment.ProcessId);
                writer.WriteString("stage8JournalSha256", stage8Hex);
                writer.WriteString("failedBSourceSha", failedSha);
                writer.WriteString("intentSha256", Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(intentPath))));
                writer.WriteEndObject();
                writer.Flush();
            }
            fd.Flush(flushToDisk: true);
        }
        using var receipt = ReadOwnedTransitionRecord(commitPath, 4096);
        if (receipt.RootElement.GetProperty("schemaVersion").GetInt32() != 1 ||
            receipt.RootElement.GetProperty("transactionId").GetString() != owner.TransactionId ||
            receipt.RootElement.GetProperty("disposition").GetString() != "failed-b-retired-still-on-disk-no-delete" ||
            receipt.RootElement.GetProperty("guardianPid").GetInt32() != Environment.ProcessId ||
            receipt.RootElement.GetProperty("stage8JournalSha256").GetString() != stage8Hex ||
            receipt.RootElement.GetProperty("failedBSourceSha").GetString() != failedSha ||
            receipt.RootElement.GetProperty("intentSha256").GetString() !=
                Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(intentPath))))
            throw new InvalidDataException("Original Guardian failed-B retired marker not durable or exact.");
        RequireOwnedRestoredATerminalReadiness(owner, journalRoot, worker, lease, leaseAge,
            requireTerminalStage8: true, requireRetiredFailedB: true);
        InspectionPhase = "native-integrated-a-retired-b-complete-no-delete";
    }
}
