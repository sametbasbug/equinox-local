using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Principal;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    // Deliberately read-only, NOT a quiesceOwnedB implementation or a new
    // Guardian CLI command. The existing worker HMAC and lease authorize only
    // prepared Stable A, NOT rollback_started B. No B shutdown is permitted
    // until an independent rollback-stage native owner authenticates it.
    private static void InspectOwnedMainBRollbackPreflight(string transactionId, string sourceSha)
    {
        InspectionPhase = "native-b-rollback-preflight";
        if (!NativeTransactionPattern.IsMatch(transactionId) || !SourceShaPattern.IsMatch(sourceSha))
            throw new InvalidDataException("Native B rollback lacks exact transaction/source identity.");
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrWhiteSpace(local) || !Path.IsPathFullyQualified(local))
            throw new InvalidDataException("Native B rollback current-user install root is unavailable.");
        var install = Path.Combine(local, "Equinox Local");
        var tx = Path.Combine(install, "state", "main-update");
        var journalRoot = Path.Combine(tx, "guardian-journal");
        var store = Path.Combine(tx, "native-store");
        var platform = RuntimeInformation.ProcessArchitecture switch
        {
            Architecture.X64 => "win32-x64",
            Architecture.Arm64 => "win32-arm64",
            _ => throw new PlatformNotSupportedException("Unsupported Windows B rollback CPU target."),
        };
        var targetStore = Path.Combine(store, platform);
        var payload = Path.Combine(targetStore, sourceSha);
        var nativeRelease = Path.Combine(payload, "release");
        var sourceShell = Path.Combine(nativeRelease, "runtime", "shell");
        var programRoot = Path.Combine(local, "Programs", "Equinox Local");
        foreach (var directory in new[] { install, Path.Combine(install, "state"), tx,
            journalRoot, store, targetStore, payload, nativeRelease,
            Path.Combine(nativeRelease, "runtime"), sourceShell, programRoot })
            RequireNormalDirectory(directory);
        var installedExe = Path.Combine(programRoot, "EquinoxLocal.exe");
        RequireNormalFile(installedExe);
        using var activeDoc = ReadOwnedTransitionRecord(Path.Combine(tx, "active.json"), 8192);
        var active = activeDoc.RootElement;
        RequireExactKeys(active, ["schemaVersion", "transactionId", "channel", "currentSha", "targetSha", "startedAt"]);
        if (active.GetProperty("schemaVersion").GetInt32() != 1 ||
            active.GetProperty("channel").GetString() != "main" ||
            active.GetProperty("transactionId").GetString() != transactionId ||
            active.GetProperty("targetSha").GetString() != sourceSha)
            throw new InvalidDataException("Native B rollback differs from the active Main transaction.");
        using var journalDoc = ReadOwnedTransitionRecord(Path.Combine(journalRoot, transactionId + ".json"), 8192);
        var journal = journalDoc.RootElement;
        RequireExactKeys(journal, ["schemaVersion", "channel", "transactionId", "target", "currentSha", "targetSha",
            "receiptStartedAt", "previousNative", "targetRuntimeContractSha256", "stage", "sequence", "createdAt", "updatedAt"]);
        if (journal.GetProperty("schemaVersion").GetInt32() != 1 ||
            journal.GetProperty("channel").GetString() != "main" ||
            journal.GetProperty("transactionId").GetString() != transactionId ||
            journal.GetProperty("target").GetString() != platform ||
            journal.GetProperty("targetSha").GetString() != sourceSha ||
            journal.GetProperty("currentSha").GetString() != active.GetProperty("currentSha").GetString() ||
            journal.GetProperty("receiptStartedAt").GetString() != active.GetProperty("startedAt").GetString() ||
            journal.GetProperty("stage").GetString() != "rollback_started" ||
            journal.GetProperty("sequence").GetInt32() is < 1 or > 6)
            throw new InvalidDataException("Native B rollback journal is not independently authorized for physical restoration.");
        // Both the B source tree and the currently installed shell must match
        // the same immutable SHA-addressed native release before inspecting WPF.
        CompareNativeTrees(sourceShell, programRoot);
        using var shell = FindSingleOwnedStableShell(installedExe);
        var pid = shell.Id;
        var ticks = shell.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture);
        if (shell.HasExited || shell.SessionId != Process.GetCurrentProcess().SessionId ||
            !OpenProcessToken(shell.Handle, TokenQuery, out var shellToken))
            throw new InvalidDataException("Native B rollback WPF process is not an independently inspected owner.");
        using (shellToken)
        using (var shellIdentity = new WindowsIdentity(shellToken.DangerousGetHandle()))
        using (var guardianIdentity = WindowsIdentity.GetCurrent())
        {
            if (shellIdentity.User is null || guardianIdentity.User is null ||
                !shellIdentity.User.Equals(guardianIdentity.User) ||
                ReadWindowsLogonAuthenticationId(shellToken) != ReadWindowsLogonAuthenticationId(guardianIdentity.AccessToken))
                throw new InvalidDataException("Native B rollback WPF SID or logon differs from the Guardian.");
        }
        if (shell.HasExited || shell.Id != pid ||
            shell.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != ticks)
            throw new InvalidDataException("Native B rollback WPF PID or OS creation time changed during inspection.");
        CompareNativeTrees(sourceShell, programRoot);
        InspectionPhase = "native-b-rollback-preflight-only-no-shutdown";
    }
}
