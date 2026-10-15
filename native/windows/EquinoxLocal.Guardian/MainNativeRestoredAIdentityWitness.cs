using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    // A future fixed, mutually authenticated A-identity selection action
    // MUST run this verifier BEFORE its own durable stage6 commit. It is
    // deliberately READ-ONLY: an A pointer alone is never rollback success.
    // Do not call the pre-selection gate once any pointer has begun to move.
    private static void RequireOwnedRestoredAIdentityWitness(
        OwnedWorkerClaim owner, string journalRoot, Process worker,
        FileStream lease, Stopwatch leaseAge, bool requireDurableStage6 = false)
    {
        InspectionPhase = requireDurableStage6
            ? "native-integrated-a-stage6-restart-readiness"
            : "native-integrated-a-selected-owner-lease";
        if (lease.SafeFileHandle.IsClosed || lease.SafeFileHandle.IsInvalid ||
            leaseAge.Elapsed >= TimeSpan.FromMinutes(20) || worker.HasExited ||
            worker.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks)
            throw new InvalidDataException("Selected A identities have no original OS writer/worker.");
        var actual = InspectOwnedNativeWorkerProcess(guardianHoldsJournalLease: true);
        var one = Convert.FromHexString(actual.Token);
        var two = Convert.FromHexString(owner.Token);
        try
        {
            if (actual.Pid != owner.Pid || actual.Ticks != owner.Ticks ||
                actual.TransactionId != owner.TransactionId ||
                !CryptographicOperations.FixedTimeEquals(one, two))
                throw new InvalidDataException("Selected A identities no longer belong to the original OS worker.");
        }
        finally { CryptographicOperations.ZeroMemory(one); CryptographicOperations.ZeroMemory(two); }
        var journalPath = Path.Combine(journalRoot, owner.TransactionId + ".json");
        var commitPath = Path.Combine(journalRoot, owner.TransactionId +
            (requireDurableStage6 ? ".rollback_native_restored.commit.json" : ".rollback_started.commit.json"));
        var journalSha = SHA256.HashData(File.ReadAllBytes(journalPath));
        using var record = ReadOwnedTransitionRecord(journalPath, 8192);
        using var marker = ReadOwnedTransitionRecord(commitPath, 4096);
        var expectedStage = requireDurableStage6 ? "rollback_native_restored" : "rollback_started";
        var expectedSequence = requireDurableStage6 ? 6 : 5;
        var state = record.RootElement;
        if (state.GetProperty("transactionId").GetString() != owner.TransactionId ||
            state.GetProperty("stage").GetString() != expectedStage ||
            state.GetProperty("sequence").GetInt32() != expectedSequence ||
            state.GetProperty("previousNative").GetProperty("kind").GetString() != "stable" ||
            marker.RootElement.GetProperty("transactionId").GetString() != owner.TransactionId ||
            marker.RootElement.GetProperty("stage").GetString() != expectedStage ||
            marker.RootElement.GetProperty("sequence").GetInt32() != expectedSequence ||
            marker.RootElement.GetProperty("guardianPid").GetInt32() != Environment.ProcessId ||
            marker.RootElement.GetProperty("journalSha256").GetString() != Convert.ToHexStringLower(journalSha))
            throw new InvalidDataException("Selected A identities require the original exact OS-owned stage5/stage6 SHA receipt.");
        var stableVersion = state.GetProperty("previousNative").GetProperty("version").GetString() ?? "";
        var aSha = state.GetProperty("currentSha").GetString() ?? "";
        var bSha = state.GetProperty("targetSha").GetString() ?? "";
        var target = state.GetProperty("target").GetString() ?? "";
        if (!VersionRegex().IsMatch(stableVersion) || !SourceShaPattern.IsMatch(aSha) ||
            !SourceShaPattern.IsMatch(bSha) || aSha == bSha ||
            target != (System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture switch
            {
                System.Runtime.InteropServices.Architecture.X64 => "win32-x64",
                System.Runtime.InteropServices.Architecture.Arm64 => "win32-arm64",
                _ => throw new PlatformNotSupportedException("Unsupported A source selection architecture."),
            }))
            throw new InvalidDataException("Selected A identity does not match original immutable transaction.");
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrWhiteSpace(local) || !Path.IsPathFullyQualified(local))
            throw new InvalidDataException("Selected A profile root is not canonical.");
        var install = Path.Combine(local, "Equinox Local");
        var txRoot = Path.Combine(install, "state", "main-update");
        var stable = Path.Combine(install, "releases", stableVersion);
        var bRelease = Path.Combine(txRoot, "native-store", target, bSha, "release");
        var program = Path.Combine(local, "Programs", "Equinox Local");
        var failedB = Path.Combine(Path.GetDirectoryName(program)!, ".equinox-shell-failed-" + owner.TransactionId);
        var backup = Path.Combine(Path.GetDirectoryName(program)!, ".equinox-shell-backup-" + owner.TransactionId);
        InspectionPhase = "native-integrated-a-selected-exact-slots";
        CompareNativeTrees(Path.Combine(stable, "runtime", "shell"), program);
        CompareNativeTrees(Path.Combine(bRelease, "runtime", "shell"), failedB);
        if (Directory.Exists(backup) || File.Exists(backup))
            throw new InvalidDataException("A selection still has a stranded A backup.");
        using (var running = FindExactRunningWpfOrNull(Path.Combine(program, "EquinoxLocal.exe")))
            if (running is not null)
                throw new InvalidDataException("A selection must finish before WPF relaunch.");
        RequireNormalDirectory(Path.Combine(txRoot, "sources", aSha));
        using (var stablePointer = ReadJson(Path.Combine(install, "current-version.json"), MaxPointerBytes))
        {
            RequireExactKeys(stablePointer.RootElement, ["schemaVersion", "version", "target"]);
            if (stablePointer.RootElement.GetProperty("schemaVersion").GetInt32() != 1 ||
                stablePointer.RootElement.GetProperty("version").GetString() != stableVersion ||
                stablePointer.RootElement.GetProperty("target").GetString() != target)
                throw new InvalidDataException("Selected A baseline has drifted from original signed Stable.");
        }
        InspectOwnedMainNativeMessaging(install, stable);
        var sourceFile = Path.Combine(txRoot, "current-source.conf");
        RequireNormalFile(sourceFile);
        if (new FileInfo(sourceFile).Length is < 15 or > 8192)
            throw new InvalidDataException("Selected A source pointer is outside bound.");
        var rows = File.ReadAllText(sourceFile).Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(line => line.TrimEnd('\r')).ToArray();
        if (rows.Length != 3 || rows[0] != "schemaVersion=1" ||
            !Compare.Equals(rows[1], "sourceRoot=" + Path.Combine(txRoot, "sources", aSha)) ||
            rows[2] != "sha=" + aSha)
            throw new InvalidDataException("A source pointer did not select the original SHA.");
        // Previous native identity is signed Stable, not an old Main slot.
        // An arbitrary/stale current-native.json is NOT an A selection.
        if (Directory.EnumerateFileSystemEntries(txRoot, "current-native.json", SearchOption.TopDirectoryOnly).Any())
            throw new InvalidDataException("Stable A selection retained or replaced the native Main pointer.");
        if (worker.HasExited ||
            worker.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks ||
            lease.SafeFileHandle.IsClosed || lease.SafeFileHandle.IsInvalid ||
            leaseAge.Elapsed >= TimeSpan.FromMinutes(20) ||
            !CryptographicOperations.FixedTimeEquals(journalSha, SHA256.HashData(File.ReadAllBytes(journalPath))))
            throw new InvalidDataException("Original Guardian OS lease or stage5 changed during A identity witness.");
        InspectionPhase = requireDurableStage6
            ? "native-integrated-a-stage6-source-native-nm-read-only"
            : "native-integrated-a-selected-witness-only-no-stage6";
    }
}
