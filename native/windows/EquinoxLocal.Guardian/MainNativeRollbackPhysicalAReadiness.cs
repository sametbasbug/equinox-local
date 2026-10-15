using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Runtime.InteropServices;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    // A post-stage5, original-Guardian-only READINESS gate. The prior B
    // rejection admitted rollback_start, but does not license arbitrary
    // subsequent filesystem mutation: recheck physical slots, selected B,
    // WPF exit, OS owner and the SAME writer handle AFTER the durable stage.
    // This method grants NO physical A action, stage6, pointer change, WPF
    // restart, lock reclamation or terminal completion.
    private static void RequireOwnedPhysicalARestoreReadiness(
        OwnedWorkerClaim owner, string journalRoot, Process worker,
        FileStream lease, Stopwatch leaseAge)
    {
        InspectionPhase = "native-integrated-a-physical-readiness-owner";
        if (lease.SafeFileHandle.IsClosed || lease.SafeFileHandle.IsInvalid ||
            worker.HasExited ||
            worker.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks ||
            leaseAge.Elapsed >= TimeSpan.FromMinutes(20))
            throw new InvalidDataException("Original Guardian OS lease or worker expired before A physical readiness.");
        var pinned = InspectOwnedNativeWorkerProcess(guardianHoldsJournalLease: true);
        var observedToken = Convert.FromHexString(pinned.Token);
        var originalToken = Convert.FromHexString(owner.Token);
        try
        {
            if (pinned.TransactionId != owner.TransactionId || pinned.Pid != owner.Pid ||
                pinned.Ticks != owner.Ticks ||
                !CryptographicOperations.FixedTimeEquals(observedToken, originalToken))
                throw new InvalidDataException("A physical readiness lost original OS worker identity.");
        }
        finally
        {
            CryptographicOperations.ZeroMemory(observedToken);
            CryptographicOperations.ZeroMemory(originalToken);
        }

        var journalPath = Path.Combine(journalRoot, owner.TransactionId + ".json");
        var commitPath = Path.Combine(journalRoot, owner.TransactionId + ".rollback_started.commit.json");
        var before = SHA256.HashData(File.ReadAllBytes(journalPath));
        using var journal = ReadOwnedTransitionRecord(journalPath, 8192);
        using var commit = ReadOwnedTransitionRecord(commitPath, 4096);
        var stage = journal.RootElement;
        var marker = commit.RootElement;
        var previous = stage.GetProperty("previousNative");
        var version = previous.GetProperty("version").GetString() ?? "";
        var target = stage.GetProperty("target").GetString() ?? "";
        var sourceSha = stage.GetProperty("targetSha").GetString() ?? "";
        if (stage.GetProperty("transactionId").GetString() != owner.TransactionId ||
            stage.GetProperty("stage").GetString() != "rollback_started" || stage.GetProperty("sequence").GetInt32() != 5 ||
            previous.GetProperty("kind").GetString() != "stable" || !VersionRegex().IsMatch(version) ||
            !SourceShaPattern.IsMatch(sourceSha) ||
            target != (RuntimeInformation.ProcessArchitecture switch
            {
                Architecture.X64 => "win32-x64", Architecture.Arm64 => "win32-arm64",
                _ => throw new PlatformNotSupportedException("Unsupported A restoration architecture."),
            }) ||
            marker.GetProperty("transactionId").GetString() != owner.TransactionId ||
            marker.GetProperty("stage").GetString() != "rollback_started" ||
            marker.GetProperty("sequence").GetInt32() != 5 ||
            marker.GetProperty("guardianPid").GetInt32() != Environment.ProcessId ||
            marker.GetProperty("journalSha256").GetString() != Convert.ToHexStringLower(before))
            throw new InvalidDataException("A physical readiness requires this original Guardian's durable stage5.");

        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrWhiteSpace(local) || !Path.IsPathFullyQualified(local))
            throw new InvalidDataException("A readiness has no canonical Windows profile root.");
        var install = Path.Combine(local, "Equinox Local");
        var txRoot = Path.Combine(install, "state", "main-update");
        var program = Path.Combine(local, "Programs", "Equinox Local");
        var backup = Path.Combine(Path.GetDirectoryName(program)!, ".equinox-shell-backup-" + owner.TransactionId);
        var priorShell = Path.Combine(install, "releases", version, "runtime", "shell");
        var bRelease = Path.Combine(txRoot, "native-store", target, sourceSha, "release");
        InspectionPhase = "native-integrated-a-physical-readiness-exact-slots";
        CompareNativeTrees(priorShell, backup);
        CompareNativeTrees(Path.Combine(bRelease, "runtime", "shell"), program);
        using (var active = FindExactRunningWpfOrNull(Path.Combine(program, "EquinoxLocal.exe")))
        {
            if (active is not null)
                throw new InvalidDataException("A physical readiness refuses a new running WPF after B exit.");
        }
        InspectOwnedMainNativeMessaging(install, bRelease);
        // Journal stage5 must still select B before any independently
        // permitted future A restore. A premature A pointer is a dangerous
        // cross-version state, NOT readiness.
        var sourcePointer = Path.Combine(txRoot, "current-source.conf");
        RequireNormalFile(sourcePointer);
        if (new FileInfo(sourcePointer).Length is < 15 or > 8192)
            throw new InvalidDataException("A readiness source pointer is unbounded.");
        var lines = File.ReadAllText(sourcePointer).Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(line => line.TrimEnd('\r')).ToArray();
        if (lines.Length != 3 || lines[0] != "schemaVersion=1" ||
            !Compare.Equals(lines[1], "sourceRoot=" + Path.Combine(txRoot, "sources", sourceSha)) ||
            lines[2] != "sha=" + sourceSha)
            throw new InvalidDataException("A readiness source pointer drifted from B.");
        using var nativePointer = ReadOwnedTransitionRecord(Path.Combine(txRoot, "current-native.json"), 8192);
        var selected = nativePointer.RootElement;
        RequireExactKeys(selected, ["schemaVersion", "channel", "sourceSha", "target", "runtimeContractSha256"]);
        if (selected.GetProperty("schemaVersion").GetInt32() != 1 ||
            selected.GetProperty("channel").GetString() != "main" ||
            selected.GetProperty("sourceSha").GetString() != sourceSha ||
            selected.GetProperty("target").GetString() != target ||
            selected.GetProperty("runtimeContractSha256").GetString() != stage.GetProperty("targetRuntimeContractSha256").GetString())
            throw new InvalidDataException("A readiness native pointer drifted from B.");
        if (lease.SafeFileHandle.IsClosed || lease.SafeFileHandle.IsInvalid ||
            worker.HasExited || worker.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks ||
            leaseAge.Elapsed >= TimeSpan.FromMinutes(20) ||
            !CryptographicOperations.FixedTimeEquals(before, SHA256.HashData(File.ReadAllBytes(journalPath))))
            throw new InvalidDataException("A physical readiness lost the original stage5 or OS owner.");
        InspectionPhase = "native-integrated-a-physical-readiness-only-no-restore";
    }
}
