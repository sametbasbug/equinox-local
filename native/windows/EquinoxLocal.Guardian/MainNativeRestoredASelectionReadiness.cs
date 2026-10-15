using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    // Post-physical-restore, pre-pointer-selection READ-ONLY admission.
    // Unlike the pre-stage5 readiness gate, the live WPF must now be Stable
    // A and the failed B must be in the exact SHA-owned quarantine. The old
    // source/native/Chrome Native Messaging owner is still B by design.
    // This check authorizes NO file/registry/journal writes or restart.
    private static void RequireOwnedRestoredASelectionReadiness(
        OwnedWorkerClaim owner, string journalRoot, Process worker,
        FileStream lease, Stopwatch leaseAge)
    {
        InspectionPhase = "native-integrated-a-selection-readiness-os-owner";
        if (lease.SafeFileHandle.IsClosed || lease.SafeFileHandle.IsInvalid ||
            leaseAge.Elapsed >= TimeSpan.FromMinutes(20) || worker.HasExited ||
            worker.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks)
            throw new InvalidDataException("Restored A selection has no original live OS writer/worker.");
        var live = InspectOwnedNativeWorkerProcess(guardianHoldsJournalLease: true);
        var left = Convert.FromHexString(live.Token);
        var right = Convert.FromHexString(owner.Token);
        try
        {
            if (live.TransactionId != owner.TransactionId || live.Pid != owner.Pid || live.Ticks != owner.Ticks ||
                !CryptographicOperations.FixedTimeEquals(left, right))
                throw new InvalidDataException("Restored A selection worker OS identity drifted.");
        }
        finally { CryptographicOperations.ZeroMemory(left); CryptographicOperations.ZeroMemory(right); }
        var journalPath = Path.Combine(journalRoot, owner.TransactionId + ".json");
        var markerPath = Path.Combine(journalRoot, owner.TransactionId + ".rollback_started.commit.json");
        var before = SHA256.HashData(File.ReadAllBytes(journalPath));
        using var journal = ReadOwnedTransitionRecord(journalPath, 8192);
        using var marker = ReadOwnedTransitionRecord(markerPath, 4096);
        var stage = journal.RootElement;
        if (stage.GetProperty("transactionId").GetString() != owner.TransactionId ||
            stage.GetProperty("stage").GetString() != "rollback_started" ||
            stage.GetProperty("sequence").GetInt32() != 5 ||
            stage.GetProperty("previousNative").GetProperty("kind").GetString() != "stable" ||
            marker.RootElement.GetProperty("transactionId").GetString() != owner.TransactionId ||
            marker.RootElement.GetProperty("stage").GetString() != "rollback_started" ||
            marker.RootElement.GetProperty("sequence").GetInt32() != 5 ||
            marker.RootElement.GetProperty("guardianPid").GetInt32() != Environment.ProcessId ||
            marker.RootElement.GetProperty("journalSha256").GetString() != Convert.ToHexStringLower(before))
            throw new InvalidDataException("Restored A selection requires the original Guardian's durable stage5 SHA.");
        var version = stage.GetProperty("previousNative").GetProperty("version").GetString() ?? "";
        var sourceA = stage.GetProperty("currentSha").GetString() ?? "";
        var sourceB = stage.GetProperty("targetSha").GetString() ?? "";
        var target = stage.GetProperty("target").GetString() ?? "";
        if (!VersionRegex().IsMatch(version) || !SourceShaPattern.IsMatch(sourceA) ||
            !SourceShaPattern.IsMatch(sourceB) || sourceA == sourceB ||
            target != (System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture switch
            {
                System.Runtime.InteropServices.Architecture.X64 => "win32-x64",
                System.Runtime.InteropServices.Architecture.Arm64 => "win32-arm64",
                _ => throw new PlatformNotSupportedException("Unsupported restored A architecture."),
            }))
            throw new InvalidDataException("Restored A selection has a foreign release/source identity.");
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var install = Path.Combine(local, "Equinox Local");
        var txRoot = Path.Combine(install, "state", "main-update");
        var stable = Path.Combine(install, "releases", version);
        var bRelease = Path.Combine(txRoot, "native-store", target, sourceB, "release");
        var active = Path.Combine(local, "Programs", "Equinox Local");
        var backup = Path.Combine(Path.GetDirectoryName(active)!, ".equinox-shell-backup-" + owner.TransactionId);
        var quarantine = Path.Combine(Path.GetDirectoryName(active)!, ".equinox-shell-failed-" + owner.TransactionId);
        InspectionPhase = "native-integrated-a-selection-readiness-exact-physical-slots";
        CompareNativeTrees(Path.Combine(stable, "runtime", "shell"), active);
        CompareNativeTrees(Path.Combine(bRelease, "runtime", "shell"), quarantine);
        if (Directory.Exists(backup) || File.Exists(backup))
            throw new InvalidDataException("Restored A selection still has an old A backup path.");
        using (var wpf = FindExactRunningWpfOrNull(Path.Combine(active, "EquinoxLocal.exe")))
            if (wpf is not null)
                throw new InvalidDataException("Restored A selection cannot follow premature WPF startup.");
        RequireNormalDirectory(Path.Combine(txRoot, "sources", sourceA));
        RequireNormalDirectory(Path.Combine(txRoot, "sources", sourceB));
        using (var stablePointer = ReadJson(Path.Combine(install, "current-version.json"), MaxPointerBytes))
        {
            RequireExactKeys(stablePointer.RootElement, ["schemaVersion", "version", "target"]);
            if (stablePointer.RootElement.GetProperty("schemaVersion").GetInt32() != 1 ||
                stablePointer.RootElement.GetProperty("version").GetString() != version ||
                stablePointer.RootElement.GetProperty("target").GetString() != target)
                throw new InvalidDataException("Restored A selection baseline is not the original Stable release.");
        }
        // Still-selected B is an explicit prerequisite for A source/native/NM
        // transition. Drift to A or a third party before a fixed OS grant is
        // NOT proof that rollback already succeeded.
        InspectOwnedMainNativeMessaging(install, bRelease);
        var sourcePath = Path.Combine(txRoot, "current-source.conf");
        RequireNormalFile(sourcePath);
        if (new FileInfo(sourcePath).Length is < 15 or > 8192)
            throw new InvalidDataException("Restored A selection source pointer is unbounded.");
        var rows = File.ReadAllText(sourcePath).Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(line => line.TrimEnd('\r')).ToArray();
        if (rows.Length != 3 || rows[0] != "schemaVersion=1" ||
            !Compare.Equals(rows[1], "sourceRoot=" + Path.Combine(txRoot, "sources", sourceB)) ||
            rows[2] != "sha=" + sourceB)
            throw new InvalidDataException("Restored A selection no longer starts from exact B source.");
        using var native = ReadOwnedTransitionRecord(Path.Combine(txRoot, "current-native.json"), 8192);
        var selected = native.RootElement;
        RequireExactKeys(selected, ["schemaVersion", "channel", "sourceSha", "target", "runtimeContractSha256"]);
        if (selected.GetProperty("schemaVersion").GetInt32() != 1 ||
            selected.GetProperty("channel").GetString() != "main" ||
            selected.GetProperty("sourceSha").GetString() != sourceB ||
            selected.GetProperty("target").GetString() != target ||
            selected.GetProperty("runtimeContractSha256").GetString() !=
                stage.GetProperty("targetRuntimeContractSha256").GetString())
            throw new InvalidDataException("Restored A selection no longer starts from exact B native pointer.");
        if (lease.SafeFileHandle.IsClosed || lease.SafeFileHandle.IsInvalid ||
            leaseAge.Elapsed >= TimeSpan.FromMinutes(20) || worker.HasExited ||
            worker.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks ||
            !CryptographicOperations.FixedTimeEquals(before, SHA256.HashData(File.ReadAllBytes(journalPath))))
            throw new InvalidDataException("Restored A selection lost original live journal/OS authority.");
        InspectionPhase = "native-integrated-a-selection-readiness-no-mutation";
    }
}
