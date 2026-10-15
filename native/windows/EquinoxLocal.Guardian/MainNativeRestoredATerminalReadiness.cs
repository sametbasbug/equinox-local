using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    // Terminal rollback is intentionally NOT implemented by this gate.
    // A different, fixed original-Guardian action may use its READ-ONLY
    // evidence before any future rollback_healthy/7 -> rolled_back/8.
    // Original owner, durable stage7, original stage6 and WPF birth must all
    // agree; a stage7 label alone never grants terminal writer authority.
    private static void RequireOwnedRestoredATerminalReadiness(
        OwnedWorkerClaim owner, string journalRoot, Process worker,
        FileStream lease, Stopwatch leaseAge)
    {
        InspectionPhase = "native-integrated-a-terminal-readiness-original-os-writer";
        if (lease.SafeFileHandle.IsClosed || lease.SafeFileHandle.IsInvalid ||
            leaseAge.Elapsed >= TimeSpan.FromMinutes(20) || worker.HasExited ||
            worker.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks)
            throw new InvalidDataException("Terminal A readiness lost its original kernel lease or worker.");
        var observed = InspectOwnedNativeWorkerProcess(guardianHoldsJournalLease: true);
        InspectOwnedNativeWorkerOsArguments(guardianHoldsJournalLease: true);
        var expectedToken = Convert.FromHexString(owner.Token);
        var observedToken = Convert.FromHexString(observed.Token);
        try
        {
            if (observed.Pid != owner.Pid || observed.Ticks != owner.Ticks ||
                observed.TransactionId != owner.TransactionId ||
                !CryptographicOperations.FixedTimeEquals(expectedToken, observedToken))
                throw new InvalidDataException("Original terminal worker SID/logon/OS token drifted.");
        }
        finally { CryptographicOperations.ZeroMemory(expectedToken); CryptographicOperations.ZeroMemory(observedToken); }
        var journalPath = Path.Combine(journalRoot, owner.TransactionId + ".json");
        var stage7Path = Path.Combine(journalRoot, owner.TransactionId + ".rollback_healthy.commit.json");
        var stage6Path = Path.Combine(journalRoot, owner.TransactionId + ".rollback_native_restored.commit.json");
        var stage7Sha = SHA256.HashData(File.ReadAllBytes(journalPath));
        using var stage7 = ReadOwnedTransitionRecord(journalPath, 8192);
        using var marker7 = ReadOwnedTransitionRecord(stage7Path, 4096);
        using var marker6 = ReadOwnedTransitionRecord(stage6Path, 4096);
        var stage = stage7.RootElement;
        if (stage.GetProperty("transactionId").GetString() != owner.TransactionId ||
            stage.GetProperty("stage").GetString() != "rollback_healthy" ||
            stage.GetProperty("sequence").GetInt32() != 7 ||
            stage.GetProperty("previousNative").GetProperty("kind").GetString() != "stable" ||
            marker7.RootElement.GetProperty("schemaVersion").GetInt32() != 1 ||
            marker7.RootElement.GetProperty("transactionId").GetString() != owner.TransactionId ||
            marker7.RootElement.GetProperty("stage").GetString() != "rollback_healthy" ||
            marker7.RootElement.GetProperty("sequence").GetInt32() != 7 ||
            marker7.RootElement.GetProperty("guardianPid").GetInt32() != Environment.ProcessId ||
            marker7.RootElement.GetProperty("journalSha256").GetString() != Convert.ToHexStringLower(stage7Sha) ||
            marker6.RootElement.GetProperty("schemaVersion").GetInt32() != 1 ||
            marker6.RootElement.GetProperty("transactionId").GetString() != owner.TransactionId ||
            marker6.RootElement.GetProperty("stage").GetString() != "rollback_native_restored" ||
            marker6.RootElement.GetProperty("sequence").GetInt32() != 6 ||
            marker6.RootElement.GetProperty("guardianPid").GetInt32() != Environment.ProcessId)
            throw new InvalidDataException("Terminal A readiness requires both original Guardian stage6 and stage7 SHA receipts.");
        var version = stage.GetProperty("previousNative").GetProperty("version").GetString() ?? "";
        var oldSha = stage.GetProperty("currentSha").GetString() ?? "";
        var failedSha = stage.GetProperty("targetSha").GetString() ?? "";
        var target = stage.GetProperty("target").GetString() ?? "";
        if (!VersionRegex().IsMatch(version) || !SourceShaPattern.IsMatch(oldSha) ||
            !SourceShaPattern.IsMatch(failedSha) || oldSha == failedSha ||
            target != (System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture switch
            {
                System.Runtime.InteropServices.Architecture.X64 => "win32-x64",
                System.Runtime.InteropServices.Architecture.Arm64 => "win32-arm64",
                _ => throw new PlatformNotSupportedException("Unsupported terminal A architecture."),
            }))
            throw new InvalidDataException("Terminal A identity does not match the original signed source contract.");
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrWhiteSpace(local) || !Path.IsPathFullyQualified(local))
            throw new InvalidDataException("Original A terminal profile root is not canonical.");
        var install = Path.Combine(local, "Equinox Local");
        var transactionRoot = Path.Combine(install, "state", "main-update");
        var stable = Path.Combine(install, "releases", version);
        var candidateB = Path.Combine(transactionRoot, "native-store", target, failedSha, "release");
        var active = Path.Combine(local, "Programs", "Equinox Local");
        var quarantine = Path.Combine(Path.GetDirectoryName(active)!, ".equinox-shell-failed-" + owner.TransactionId);
        var backup = Path.Combine(Path.GetDirectoryName(active)!, ".equinox-shell-backup-" + owner.TransactionId);
        InspectionPhase = "native-integrated-a-terminal-readiness-retained-b-and-stable-a";
        CompareNativeTrees(Path.Combine(stable, "runtime", "shell"), active);
        CompareNativeTrees(Path.Combine(candidateB, "runtime", "shell"), quarantine);
        if (Directory.Exists(backup) || File.Exists(backup))
            throw new InvalidDataException("Original A backup remains after physical terminal recovery.");
        RequireNormalDirectory(Path.Combine(transactionRoot, "sources", oldSha));
        using (var stableStamp = ReadJson(Path.Combine(install, "current-version.json"), MaxPointerBytes))
        {
            RequireExactKeys(stableStamp.RootElement, ["schemaVersion", "version", "target"]);
            if (stableStamp.RootElement.GetProperty("schemaVersion").GetInt32() != 1 ||
                stableStamp.RootElement.GetProperty("version").GetString() != version ||
                stableStamp.RootElement.GetProperty("target").GetString() != target)
                throw new InvalidDataException("Stable A original release baseline changed during rollback.");
        }
        InspectOwnedMainNativeMessaging(install, stable);
        var sourcePath = Path.Combine(transactionRoot, "current-source.conf");
        RequireNormalFile(sourcePath);
        if (new FileInfo(sourcePath).Length is < 15 or > 8192)
            throw new InvalidDataException("Terminal A source pointer is unbounded.");
        var rows = File.ReadAllText(sourcePath).Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(line => line.TrimEnd('\r')).ToArray();
        if (rows.Length != 3 || rows[0] != "schemaVersion=1" ||
            !Compare.Equals(rows[1], "sourceRoot=" + Path.Combine(transactionRoot, "sources", oldSha)) ||
            rows[2] != "sha=" + oldSha)
            throw new InvalidDataException("Terminal A source pointer does not select original signed Stable SHA.");
        if (Directory.EnumerateFileSystemEntries(transactionRoot, "current-native.json", SearchOption.TopDirectoryOnly).Any())
            throw new InvalidDataException("Terminal Stable A still has a Main B native pointer.");
        // The original WPF attestation belongs to stage6, NOT stage7. Do
        // not accept a freshly forged stage7 WPF birth receipt as a shortcut.
        var oldStageShaHex = marker6.RootElement.GetProperty("journalSha256").GetString() ?? "";
        if (!System.Text.RegularExpressions.Regex.IsMatch(oldStageShaHex, "^[a-f0-9]{64}$"))
            throw new InvalidDataException("Original Guardian stage6 digest is not SHA256.");
        var oldStageSha = Convert.FromHexString(oldStageShaHex);
        RequireOriginalGuardianRestoredAWpfReceipt(owner, journalRoot, worker, lease, leaseAge, active, oldStageSha);
        if (!CryptographicOperations.FixedTimeEquals(stage7Sha, SHA256.HashData(File.ReadAllBytes(journalPath))) ||
            lease.SafeFileHandle.IsClosed || lease.SafeFileHandle.IsInvalid || worker.HasExited ||
            leaseAge.Elapsed >= TimeSpan.FromMinutes(20) ||
            worker.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks)
            throw new InvalidDataException("Original stage7 or kernel worker changed during terminal-readiness witness.");
        InspectionPhase = "native-integrated-a-terminal-readiness-read-only-no-stage8";
    }
}
