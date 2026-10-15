using System.Runtime.InteropServices;
using System.Security.Cryptography;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    // READ-ONLY crash inventory, including deliberate tests which remove
    // the final Q commit AFTER killing the original kernel Guardian. Every
    // branch refuses writer reclamation / action replay (exit 70). A complete
    // receipt is an observation, NEVER permission to GC or restart anything.
    private sealed record FailedBOrphanEvidence(
        string TransactionId, int WorkerPid, int GuardianPid,
        string Stage8Sha256, string FailedBSourceSha, string Phase);

    private static void AuditOwnedFailedBRetirementOrphanReadOnly()
    {
        var observation = InspectOwnedFailedBRetirementOrphanReadOnly();
        InspectionPhase = observation.Phase;
        throw new InvalidDataException("Original Guardian B crash inventory never grants update, replay or deletion.");
    }

    // Returns independently observed evidence ONLY to the explicit offline
    // quarantine command. Every ordinary CLI audit still refuses (exit 70).
    private static FailedBOrphanEvidence InspectOwnedFailedBRetirementOrphanReadOnly()
    {
        InspectionPhase = "native-retire-b-offline-original-guardian-no-writer";
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrWhiteSpace(local) || !Path.IsPathFullyQualified(local))
            throw new InvalidDataException("B retirement offline profile is unavailable.");
        var install = Path.Combine(local, "Equinox Local");
        var owned = Path.Combine(install, "runtime", "guardian", "EquinoxLocalGuardian.exe");
        if (!Compare.Equals(Path.GetFullPath(Environment.ProcessPath ?? ""), Path.GetFullPath(owned)))
            throw new InvalidDataException("Offline B inspector is not the original product-owned binary.");
        RequireNormalFile(owned);
        var tx = Path.Combine(install, "state", "main-update");
        var journalRoot = Path.Combine(tx, "guardian-journal");
        RequireNormalDirectory(tx);
        RequireNormalDirectory(journalRoot);
        using var active = ReadOwnedTransitionRecord(Path.Combine(tx, "active.json"), 8192);
        var activeId = active.RootElement.GetProperty("transactionId").GetString() ?? "";
        if (!NativeTransactionPattern.IsMatch(activeId) ||
            active.RootElement.GetProperty("channel").GetString() != "main")
            throw new InvalidDataException("Offline Q inventory has no exact active Main transaction.");
        var recordPath = Path.Combine(journalRoot, activeId + ".json");
        RequireNormalFile(recordPath);
        var bytes = File.ReadAllBytes(recordPath);
        if (bytes.Length is < 2 or > 8192) throw new InvalidDataException("Offline Q journal size invalid.");
        var stage8Sha = Convert.ToHexStringLower(SHA256.HashData(bytes));
        using var journal = ReadOwnedTransitionRecord(recordPath, 8192);
        var state = journal.RootElement;
        var failedSha = state.GetProperty("targetSha").GetString() ?? "";
        var oldSha = state.GetProperty("currentSha").GetString() ?? "";
        var target = RuntimeInformation.ProcessArchitecture switch
        {
            Architecture.X64 => "win32-x64", Architecture.Arm64 => "win32-arm64",
            _ => throw new PlatformNotSupportedException("Unsupported offline B architecture."),
        };
        if (state.GetProperty("transactionId").GetString() != activeId ||
            state.GetProperty("stage").GetString() != "rolled_back" ||
            state.GetProperty("sequence").GetInt32() != 8 ||
            state.GetProperty("target").GetString() != target ||
            !SourceShaPattern.IsMatch(failedSha) || !SourceShaPattern.IsMatch(oldSha) ||
            oldSha == failedSha ||
            active.RootElement.GetProperty("currentSha").GetString() != oldSha ||
            active.RootElement.GetProperty("targetSha").GetString() != failedSha ||
            state.GetProperty("previousNative").GetProperty("kind").GetString() != "stable" ||
            !VersionRegex().IsMatch(state.GetProperty("previousNative").GetProperty("version").GetString() ?? ""))
            throw new InvalidDataException("Offline failed B inventory lacks exact terminal signed A/B identity.");
        using var stage6 = ReadOwnedTransitionRecord(Path.Combine(journalRoot,
            activeId + ".rollback_native_restored.commit.json"), 4096);
        using var stage7 = ReadOwnedTransitionRecord(Path.Combine(journalRoot,
            activeId + ".rollback_healthy.commit.json"), 4096);
        using var stage8 = ReadOwnedTransitionRecord(Path.Combine(journalRoot,
            activeId + ".rolled_back.commit.json"), 4096);
        var guardianPid = stage8.RootElement.GetProperty("guardianPid").GetInt32();
        if (guardianPid < 1 ||
            stage8.RootElement.GetProperty("transactionId").GetString() != activeId ||
            stage8.RootElement.GetProperty("stage").GetString() != "rolled_back" ||
            stage8.RootElement.GetProperty("sequence").GetInt32() != 8 ||
            stage8.RootElement.GetProperty("journalSha256").GetString() != stage8Sha ||
            stage6.RootElement.GetProperty("guardianPid").GetInt32() != guardianPid ||
            stage7.RootElement.GetProperty("guardianPid").GetInt32() != guardianPid ||
            !System.Text.RegularExpressions.Regex.IsMatch(stage6.RootElement.GetProperty("journalSha256").GetString() ?? "", "^[a-f0-9]{64}$") ||
            !System.Text.RegularExpressions.Regex.IsMatch(stage7.RootElement.GetProperty("journalSha256").GetString() ?? "", "^[a-f0-9]{64}$"))
            throw new InvalidDataException("Offline B inventory lacks first Guardian stage6/7/8 SHA/PID ancestry.");
        // Offline observation still hashes the signed Stable A on disk
        // rather than trusting a terminal stage label as physical evidence.
        var stableVersion = state.GetProperty("previousNative").GetProperty("version").GetString() ?? "";
        var stable = Path.Combine(install, "releases", stableVersion);
        using (var pointer = ReadJson(Path.Combine(install, "current-version.json"), MaxPointerBytes))
            if (pointer.RootElement.GetProperty("schemaVersion").GetInt32() != 1 ||
                pointer.RootElement.GetProperty("target").GetString() != target ||
                pointer.RootElement.GetProperty("version").GetString() != stableVersion)
                throw new InvalidDataException("Offline B inventory lost signed Stable A release baseline.");
        CompareNativeTrees(Path.Combine(stable, "runtime", "shell"),
            Path.Combine(local, "Programs", "Equinox Local"));
        InspectOwnedMainNativeMessaging(install, stable);
        var programParent = Path.Combine(local, "Programs");
        var quarantine = Path.Combine(programParent, ".equinox-shell-failed-" + activeId);
        var retired = Path.Combine(programParent, ".equinox-shell-retired-" + activeId);
        var candidate = Path.Combine(tx, "native-store", target, failedSha, "release", "runtime", "shell");
        var qPresent = Directory.Exists(quarantine);
        var rPresent = Directory.Exists(retired);
        if (File.Exists(quarantine) || File.Exists(retired) || qPresent == rPresent)
            throw new InvalidDataException("Offline failed B inventory is ambiguous or missing.");
        CompareNativeTrees(candidate, qPresent ? quarantine : retired);
        var intentPath = Path.Combine(journalRoot, activeId + ".failed-b-retire.intent.json");
        var commitPath = Path.Combine(journalRoot, activeId + ".failed-b-retired.commit.json");
        if (Directory.Exists(intentPath) || Directory.Exists(commitPath))
            throw new InvalidDataException("Offline failed B record is not an ordinary file.");
        if (!File.Exists(intentPath))
        {
            InspectionPhase = "native-retire-b-orphan-stage8-before-q-intent";
            throw new InvalidDataException("No original Q intent: terminal stage8 alone grants no cleanup.");
        }
        using var intent = ReadOwnedTransitionRecord(intentPath, 4096);
        var i = intent.RootElement;
        RequireExactKeys(i, ["schemaVersion", "transactionId", "disposition", "guardianPid",
            "workerPid", "stage8JournalSha256", "failedBSourceSha"]);
        if (i.GetProperty("schemaVersion").GetInt32() != 1 ||
            i.GetProperty("transactionId").GetString() != activeId ||
            i.GetProperty("disposition").GetString() != "failed-b-retire-intent-no-delete" ||
            i.GetProperty("guardianPid").GetInt32() != guardianPid ||
            i.GetProperty("workerPid").GetInt32() < 1 ||
            i.GetProperty("stage8JournalSha256").GetString() != stage8Sha ||
            i.GetProperty("failedBSourceSha").GetString() != failedSha)
            throw new InvalidDataException("Offline failed B intent differs from its signed transaction.");
        if (!File.Exists(commitPath))
        {
            InspectionPhase = qPresent
                ? "native-retire-b-orphan-intent-before-rename-no-replay"
                : "native-retire-b-orphan-after-rename-before-commit-no-replay";
            return new FailedBOrphanEvidence(activeId, i.GetProperty("workerPid").GetInt32(), guardianPid,
                stage8Sha, failedSha, InspectionPhase);
        }
        using var commit = ReadOwnedTransitionRecord(commitPath, 4096);
        var c = commit.RootElement;
        RequireExactKeys(c, ["schemaVersion", "transactionId", "disposition", "guardianPid",
            "stage8JournalSha256", "failedBSourceSha", "intentSha256"]);
        if (qPresent || c.GetProperty("schemaVersion").GetInt32() != 1 ||
            c.GetProperty("transactionId").GetString() != activeId ||
            c.GetProperty("disposition").GetString() != "failed-b-retired-still-on-disk-no-delete" ||
            c.GetProperty("guardianPid").GetInt32() != guardianPid ||
            c.GetProperty("stage8JournalSha256").GetString() != stage8Sha ||
            c.GetProperty("failedBSourceSha").GetString() != failedSha ||
            c.GetProperty("intentSha256").GetString() !=
                Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(intentPath))))
            throw new InvalidDataException("Offline failed B commit is missing exact original Guardian evidence.");
        InspectionPhase = "native-retire-b-offline-complete-but-no-writer-or-gc";
        return new FailedBOrphanEvidence(activeId, i.GetProperty("workerPid").GetInt32(), guardianPid,
            stage8Sha, failedSha, InspectionPhase);
    }
}
