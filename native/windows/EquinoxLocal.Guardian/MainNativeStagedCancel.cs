using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using Microsoft.Win32;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    // Opt-in, same-owner pre-switch abort. This is the ONLY rollback stage
    // that can be safe without switching native slots: A is still running.
    // Never shut down WPF, mutate native A/B, launch B, or change HKCU.
    private static void CancelNativeStagedBWithoutStoppingA(
        OwnedWorkerClaim owner, string journalRoot, Process worker)
    {
        InspectionPhase = "native-stage-cancel-owned-generation";
        var journalPath = Path.Combine(journalRoot, owner.TransactionId + ".json");
        var stageReceiptPath = Path.Combine(journalRoot, owner.TransactionId + ".stage-b-commit.json");
        var nativeAuthorityPath = Path.Combine(journalRoot, owner.TransactionId + ".native-authority.json");
        var abortReceiptPath = Path.Combine(journalRoot, owner.TransactionId + ".pre-switch-abort-commit.json");
        if (File.Exists(abortReceiptPath))
            throw new InvalidDataException("Native pre-switch cancellation already has a terminal proof.");
        using var stageDoc = ReadOwnedTransitionRecord(stageReceiptPath, 8192);
        var stage = stageDoc.RootElement;
        RequireExactKeys(stage, ["schemaVersion", "transactionId", "stage", "sequence", "guardianPid",
            "preparedJournalSha256", "journalSha256", "nativeBFingerprintSha256"]);
        using var authorityDoc = ReadOwnedTransitionRecord(nativeAuthorityPath, 8192);
        var authority = authorityDoc.RootElement;
        RequireExactKeys(authority, ["schemaVersion", "transactionId", "stage", "sequence", "workerPid",
            "workerStartTimeUtcTicks", "guardianPid", "journalSha256", "handoffSha256"]);
        if (stage.GetProperty("schemaVersion").GetInt32() != 1 ||
            stage.GetProperty("transactionId").GetString() != owner.TransactionId ||
            stage.GetProperty("stage").GetString() != "native_staged" ||
            stage.GetProperty("sequence").GetInt32() != 1 ||
            stage.GetProperty("guardianPid").GetInt32() != Environment.ProcessId ||
            authority.GetProperty("transactionId").GetString() != owner.TransactionId ||
            authority.GetProperty("stage").GetString() != "prepared" ||
            authority.GetProperty("sequence").GetInt32() != 0 ||
            authority.GetProperty("guardianPid").GetInt32() != Environment.ProcessId ||
            authority.GetProperty("workerPid").GetInt32() != owner.Pid ||
            authority.GetProperty("workerStartTimeUtcTicks").GetString() != owner.Ticks ||
            !DigestPattern.IsMatch(stage.GetProperty("journalSha256").GetString() ?? "") ||
            !DigestPattern.IsMatch(stage.GetProperty("nativeBFingerprintSha256").GetString() ?? "") ||
            stage.GetProperty("preparedJournalSha256").GetString() != authority.GetProperty("journalSha256").GetString() ||
            authority.GetProperty("handoffSha256").GetString() !=
                Convert.ToHexStringLower(HashOwnedWorkerHandoff(journalRoot, owner.TransactionId)))
            throw new InvalidDataException("Pre-switch cancellation cannot bind exact authenticated staged-B receipts.");

        RequireNormalFile(journalPath);
        using var pinned = new FileStream(journalPath, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (pinned.Length is < 2 or > 8192)
            throw new InvalidDataException("Native B staged journal exceeds its bound.");
        using var stagedDoc = JsonDocument.Parse(pinned);
        var journal = stagedDoc.RootElement;
        RequireExactKeys(journal, ["schemaVersion", "channel", "transactionId", "target", "currentSha", "targetSha",
            "receiptStartedAt", "previousNative", "targetRuntimeContractSha256",
            "stage", "sequence", "createdAt", "updatedAt"]);
        if (journal.GetProperty("schemaVersion").GetInt32() != 1 ||
            journal.GetProperty("channel").GetString() != "main" ||
            journal.GetProperty("transactionId").GetString() != owner.TransactionId ||
            journal.GetProperty("stage").GetString() != "native_staged" ||
            journal.GetProperty("sequence").GetInt32() != 1 ||
            journal.GetProperty("previousNative").GetProperty("kind").GetString() != "stable" ||
            stage.GetProperty("nativeBFingerprintSha256").GetString() is not string nativeFingerprint ||
            !DigestPattern.IsMatch(nativeFingerprint))
            throw new InvalidDataException("Pre-switch cancellation requires a staged native B with a still-installed Stable A.");
        pinned.Position = 0;
        var stagedDigest = SHA256.HashData(pinned);
        if (stage.GetProperty("journalSha256").GetString() != Convert.ToHexStringLower(stagedDigest))
            throw new InvalidDataException("Staged B journal digest changed after exact Guardian receipt.");

        InspectionPhase = "native-stage-cancel-still-owned-old-a";
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var install = Path.Combine(local, "Equinox Local");
        var version = journal.GetProperty("previousNative").GetProperty("version").GetString() ?? "";
        var target = RuntimeInformation.ProcessArchitecture switch
        {
            Architecture.X64 => "win32-x64",
            Architecture.Arm64 => "win32-arm64",
            _ => throw new PlatformNotSupportedException("Unsupported pre-switch cancellation architecture."),
        };
        if (!VersionRegex().IsMatch(version) || journal.GetProperty("target").GetString() != target)
            throw new InvalidDataException("Original A Stable version or CPU is not exact.");
        using (var pointerDoc = ReadOwnedTransitionRecord(Path.Combine(install, "current-version.json"), 4096))
        {
            var pointer = pointerDoc.RootElement;
            RequireExactKeys(pointer, ["schemaVersion", "target", "version"]);
            if (pointer.GetProperty("schemaVersion").GetInt32() != 1 ||
                pointer.GetProperty("target").GetString() != target ||
                pointer.GetProperty("version").GetString() != version)
                throw new InvalidDataException("Original A pointer changed before pre-switch cancellation.");
        }
        var release = Path.Combine(install, "releases", version);
        var installedShell = Path.Combine(local, "Programs", "Equinox Local");
        CompareNativeTrees(Path.Combine(release, "runtime", "shell"), installedShell);

        var browserManifest = Path.Combine(install, "browser", "native-messaging", NativeMessagingHost + ".json");
        RequireNormalFile(browserManifest);
        using (var key = Registry.CurrentUser.OpenSubKey(NativeMessagingRegistrySubkey, writable: false))
        using (var manifestDoc = ReadOwnedTransitionRecord(browserManifest, 16384))
        {
            if (key is null || key.GetValueKind("") != RegistryValueKind.String ||
                key.GetValue("", null, RegistryValueOptions.DoNotExpandEnvironmentNames) is not string registered ||
                !Compare.Equals(Path.GetFullPath(registered), Path.GetFullPath(browserManifest)))
                throw new InvalidDataException("Original A Native Messaging HKCU owner changed before cancellation.");
            var manifest = manifestDoc.RootElement;
            RequireExactKeys(manifest, ["name", "description", "path", "type", "allowed_origins"]);
            var launcher = Path.Combine(release, "runtime", "browser", "equinox-browser-native-host.exe");
            if (manifest.GetProperty("name").GetString() != NativeMessagingHost ||
                manifest.GetProperty("path").GetString() is not string currentLauncher ||
                !Compare.Equals(Path.GetFullPath(currentLauncher), Path.GetFullPath(launcher)) ||
                manifest.GetProperty("type").GetString() != "stdio" ||
                manifest.GetProperty("description").GetString() != ExpectedBridgeDescription ||
                manifest.GetProperty("allowed_origins").GetArrayLength() != 1 ||
                manifest.GetProperty("allowed_origins")[0].GetString() != ExpectedChromeOrigin)
                throw new InvalidDataException("Original A Native Messaging manifest changed before cancellation.");
        }
        using var shell = FindSingleOwnedStableShell(Path.Combine(installedShell, "EquinoxLocal.exe"));
        var shellPid = shell.Id;
        var shellTicks = shell.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture);
        if (shell.HasExited || shell.SessionId != Process.GetCurrentProcess().SessionId ||
            !OpenProcessToken(shell.Handle, TokenQuery, out var shellToken))
            throw new InvalidDataException("Original A shell is not independently owned and live.");
        using (shellToken)
        using (var shellIdentity = new WindowsIdentity(shellToken.DangerousGetHandle()))
        using (var guardianIdentity = WindowsIdentity.GetCurrent())
        {
            if (shellIdentity.User is null || guardianIdentity.User is null ||
                !shellIdentity.User.Equals(guardianIdentity.User) ||
                ReadWindowsLogonAuthenticationId(shellToken) !=
                ReadWindowsLogonAuthenticationId(guardianIdentity.AccessToken))
                throw new InvalidDataException("Original A WPF SID or logon authentication changed.");
        }
        using (var pipe = new NamedPipeClientStream(".", "EquinoxLocal.WindowsShell.Reopen",
            PipeDirection.InOut, PipeOptions.Asynchronous))
        {
            pipe.Connect(1500);
            if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle, out var pipePid) ||
                pipePid != shellPid)
                throw new InvalidDataException("Original A WPF kernel pipe has a different owner.");
            // No bytes are EVER sent to the shell.
        }
        if (worker.HasExited ||
            worker.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks ||
            shell.HasExited ||
            shell.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != shellTicks)
            throw new InvalidDataException("Original A or native worker changed during cancellation audit.");

        InspectionPhase = "native-stage-cancel-durable-candidate";
        var at = DateTimeOffset.UtcNow.ToString(CanonicalUtcTime, CultureInfo.InvariantCulture);
        if (string.CompareOrdinal(at, journal.GetProperty("updatedAt").GetString()) < 0)
            throw new InvalidDataException("Pre-switch rollback time moved backwards.");
        var temp = Path.Combine(journalRoot, "." + owner.TransactionId + ".json." +
            Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(8)) + ".tmp");
        using (var fd = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
        {
            using (var writer = new Utf8JsonWriter(fd))
            {
                writer.WriteStartObject();
                foreach (var field in journal.EnumerateObject())
                {
                    if (field.NameEquals("stage")) writer.WriteString("stage", "rollback_started");
                    else if (field.NameEquals("sequence")) writer.WriteNumber("sequence", 2);
                    else if (field.NameEquals("updatedAt")) writer.WriteString("updatedAt", at);
                    else field.WriteTo(writer);
                }
                writer.WriteEndObject();
                writer.Flush();
            }
            fd.Flush(flushToDisk: true);
            if (fd.Length > 8192) throw new InvalidDataException("Pre-switch rollback candidate is unbounded.");
        }
        pinned.Position = 0;
        if (!CryptographicOperations.FixedTimeEquals(stagedDigest, SHA256.HashData(pinned)) ||
            shell.HasExited || shell.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != shellTicks)
            throw new InvalidDataException("Staged B or original WPF owner changed before rollback journal commit.");
        pinned.Dispose(); // Atomic replacement is allowed ONLY under the still-live exact exclusive Guardian lease.
        InspectionPhase = "native-stage-cancel-atomic-commit";
        File.Move(temp, journalPath, overwrite: true);
        using var outcome = new FileStream(journalPath, FileMode.Open, FileAccess.Read, FileShare.Read);
        using var committed = JsonDocument.Parse(outcome);
        if (committed.RootElement.GetProperty("transactionId").GetString() != owner.TransactionId ||
            committed.RootElement.GetProperty("stage").GetString() != "rollback_started" ||
            committed.RootElement.GetProperty("sequence").GetInt32() != 2)
            throw new InvalidDataException("Pre-switch rollback milestone is not durable.");
        outcome.Position = 0;
        var commitHash = SHA256.HashData(outcome);
        using var receipt = new FileStream(abortReceiptPath, FileMode.CreateNew, FileAccess.Write,
            FileShare.None, 4096, FileOptions.WriteThrough);
        using (var writer = new Utf8JsonWriter(receipt))
        {
            writer.WriteStartObject();
            writer.WriteNumber("schemaVersion", 1);
            writer.WriteString("transactionId", owner.TransactionId);
            writer.WriteString("stage", "rollback_started");
            writer.WriteNumber("sequence", 2);
            writer.WriteNumber("guardianPid", Environment.ProcessId);
            writer.WriteNumber("oldShellPid", shellPid);
            writer.WriteString("oldShellStartTimeUtcTicks", shellTicks);
            writer.WriteString("stagedJournalSha256", Convert.ToHexStringLower(stagedDigest));
            writer.WriteString("rollbackJournalSha256", Convert.ToHexStringLower(commitHash));
            writer.WriteString("nativeBFingerprintSha256", nativeFingerprint);
            writer.WriteEndObject();
            writer.Flush();
        }
        receipt.Flush(flushToDisk: true);
        InspectionPhase = "native-stage-cancel-pre-switch-only-committed";
        // Not terminal rolled_back or permission to clean an orphan lease.
    }
}
