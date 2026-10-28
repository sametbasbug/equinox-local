using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Win32;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    // Explicit forensic recovery only. Never automatically remove an orphan:
    // PREPARED/0 alone does not prove WPF, active Main slot or Chrome NM were
    // untouched. This checks an original Stable A, creates durable quarantine
    // evidence, and deliberately leaves the blocking .signed-native.json.
    // Main->Main and clean A=null require their own independent baseline proof.
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

        InspectionPhase = "signed-native-orphan-stable-a-unchanged";
        using var descriptorDoc = ReadOwnedTransitionRecord(Path.Combine(root,
            "staging", id, "native-rollback", "native-recovery.json"), 8192);
        var previous = descriptorDoc.RootElement.GetProperty("previous");
        // Deliberately do not guess how to check an original signed Main A or
        // first-install A=null; they require separate validated baseline rules.
        RequireExactKeys(previous, ["kind", "version"]);
        if (previous.GetProperty("kind").GetString() != "stable")
            throw new InvalidDataException("Only an unchanged Stable A may be quarantined in this phase.");
        var version = previous.GetProperty("version").GetString() ?? "";
        if (!VersionRegex().IsMatch(version))
            throw new InvalidDataException("Original Stable A version is invalid.");
        var pointer = Path.Combine(root, "current-native.json");
        if (File.Exists(pointer) || Directory.Exists(pointer))
            throw new InvalidDataException("Native Main pointer was created before orphan recovery.");
        // Independently rehash the FULL installed original WPF tree and its
        // original numbered Stable pointer. No active B shell is accepted.
        InspectBaseline(allowActiveOrphanForReconciliation: true);
        var target = RuntimeInformation.ProcessArchitecture switch
        {
            Architecture.X64 => "win32-x64", Architecture.Arm64 => "win32-arm64",
            _ => throw new PlatformNotSupportedException("Unsupported native orphan host architecture"),
        };
        using (var stableDoc = ReadOwnedTransitionRecord(Path.Combine(install, "current-version.json"), 4096))
        {
            var p = stableDoc.RootElement;
            RequireExactKeys(p, ["schemaVersion", "target", "version"]);
            if (p.GetProperty("schemaVersion").GetInt32() != 1 ||
                p.GetProperty("target").GetString() != target ||
                p.GetProperty("version").GetString() != version)
                throw new InvalidDataException("Stable A pointer changed since admission.");
        }
        var nativeManifestPath = Path.Combine(install, "browser", "native-messaging", NativeMessagingHost + ".json");
        RequireNormalFile(nativeManifestPath);
        using (var registry = Registry.CurrentUser.OpenSubKey(NativeMessagingRegistrySubkey, writable: false))
        using (var manifestDoc = ReadOwnedTransitionRecord(nativeManifestPath, 16384))
        {
            if (registry is null || registry.GetValueKind("") != RegistryValueKind.String ||
                registry.GetValue("", null, RegistryValueOptions.DoNotExpandEnvironmentNames) is not string registered ||
                !Compare.Equals(Path.GetFullPath(registered), Path.GetFullPath(nativeManifestPath)))
                throw new InvalidDataException("Original Stable Chrome Native Messaging HKCU owner changed.");
            var manifest = manifestDoc.RootElement;
            RequireExactKeys(manifest, ["name", "description", "path", "type", "allowed_origins"]);
            if (manifest.GetProperty("name").GetString() != NativeMessagingHost ||
                manifest.GetProperty("description").GetString() != ExpectedBridgeDescription ||
                manifest.GetProperty("type").GetString() != "stdio" ||
                manifest.GetProperty("allowed_origins").GetArrayLength() != 1 ||
                manifest.GetProperty("allowed_origins")[0].GetString() != ExpectedChromeOrigin ||
                manifest.GetProperty("path").GetString() is not string launcher ||
                !Compare.Equals(Path.GetFullPath(launcher), Path.Combine(install, "releases", version,
                    "runtime", "browser", "equinox-browser-native-host.exe")))
                throw new InvalidDataException("Original Stable Chrome Native Messaging launcher changed.");
        }
        // Final process/pointer check BEFORE create-only fsynced evidence.
        if (OsProcessExists(workerPid) || OsProcessExists(guardianPid) ||
            File.Exists(pointer) || Directory.Exists(pointer))
            throw new InvalidDataException("Original owner or A pointer changed before quarantine.");
        InspectionPhase = "signed-native-orphan-write-durable-quarantine";
        // This is NOT abort success, permission to delete active.json or
        // authorization to start a new update. The original PREPARED/0 file
        // stays intact and continues to block new signed-native admissions.
        var body = JsonSerializer.SerializeToUtf8Bytes(new
        {
            schemaVersion = 1, kind = "signed-native", transactionId = id,
            disposition = "quarantined-no-resume", originalStage = "prepared", sequence = 0,
            journalSha256 = journalSha, previousKind = "stable", previousVersion = version,
            workerPid, guardianPid,
        });
        using var record = new FileStream(recoveryPath, FileMode.CreateNew, FileAccess.Write,
            FileShare.None, 4096, FileOptions.WriteThrough);
        record.Write(body);
        record.Flush(flushToDisk: true);
        InspectionPhase = "signed-native-orphan-quarantined-still-blocked";
    }
}
