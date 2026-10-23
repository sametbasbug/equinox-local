using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    // INTENTIONALLY UNEXPOSED: callable only under the same authenticated
    // rollback-stage Guardian lease that owns the live HMAC journal challenge.
    // No CLI, independent Node flag, general process killer or slot rename.
    private static void QuiesceOwnedMainBRollbackShell(OwnedWorkerClaim owner, string journalRoot,
        Process worker, byte[] originalJournalDigest, byte[] handoffDigest, string sourceSha)
    {
        InspectionPhase = "native-b-wpf-quiesce-rollback-stage-only";
        InspectOwnedMainBRollbackPreflight(owner.TransactionId, sourceSha);
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var programRoot = Path.Combine(local, "Programs", "Equinox Local");
        var installedExe = Path.Combine(programRoot, "EquinoxLocal.exe");
        var journalPath = Path.Combine(journalRoot, owner.TransactionId + ".json");
        var receiptPath = Path.Combine(journalRoot, owner.TransactionId + ".b-shell-quiesce.json");
        if (File.Exists(receiptPath))
            throw new InvalidDataException("B WPF rollback shutdown receipt already exists.");
        var nativeAuthorityPath = Path.Combine(journalRoot, owner.TransactionId + ".rollback-authority.json");
        RequireNormalFile(nativeAuthorityPath);
        // Keep the exact independently created Guardian receipt open for the
        // whole WPF shutdown. Windows FileShare.Read forbids replacement,
        // renaming or rewriting this file during the asynchronous IPC/exit.
        using var nativeAuthorityHandle = new FileStream(nativeAuthorityPath, FileMode.Open,
            FileAccess.Read, FileShare.Read);
        if (nativeAuthorityHandle.Length is < 2 or > 8192)
            throw new InvalidDataException("B rollback authority receipt exceeds its trusted size bound.");
        using var nativeAuthority = JsonDocument.Parse(nativeAuthorityHandle);
        var receipt = nativeAuthority.RootElement;
        RequireExactKeys(receipt, ["schemaVersion", "transactionId", "stage", "sequence", "workerPid",
            "workerStartTimeUtcTicks", "guardianPid", "journalSha256", "handoffSha256"]);
        if (receipt.GetProperty("schemaVersion").GetInt32() != 1 ||
            receipt.GetProperty("transactionId").GetString() != owner.TransactionId ||
            receipt.GetProperty("stage").GetString() != "rollback_started" ||
            receipt.GetProperty("workerPid").GetInt32() != owner.Pid ||
            receipt.GetProperty("workerStartTimeUtcTicks").GetString() != owner.Ticks ||
            receipt.GetProperty("guardianPid").GetInt32() != Environment.ProcessId ||
            !CryptographicOperations.FixedTimeEquals(
                Encoding.ASCII.GetBytes(receipt.GetProperty("journalSha256").GetString() ?? ""),
                Encoding.ASCII.GetBytes(Convert.ToHexStringLower(originalJournalDigest))) ||
            !CryptographicOperations.FixedTimeEquals(
                Encoding.ASCII.GetBytes(receipt.GetProperty("handoffSha256").GetString() ?? ""),
                Encoding.ASCII.GetBytes(Convert.ToHexStringLower(handoffDigest))))
            throw new InvalidDataException("B shutdown has no exact rollback-stage independent Guardian proof.");
        RequireNormalFile(journalPath);
        // Keep the ORIGINAL HMAC-authorized rollback journal readable but
        // non-replaceable for the whole B shutdown/exit evidence lifetime.
        using var journalHandle = new FileStream(journalPath, FileMode.Open,
            FileAccess.Read, FileShare.Read);
        if (journalHandle.Length is < 2 or > 8192)
            throw new InvalidDataException("B rollback journal exceeds its trusted size bound.");
        using var rollbackJournal = JsonDocument.Parse(journalHandle);
        var journal = rollbackJournal.RootElement;
        RequireExactKeys(journal, ["schemaVersion", "channel", "transactionId", "target", "currentSha", "targetSha",
            "receiptStartedAt", "previousNative", "targetRuntimeContractSha256", "stage", "sequence", "createdAt", "updatedAt"]);
        if (journal.GetProperty("transactionId").GetString() != owner.TransactionId ||
            journal.GetProperty("stage").GetString() != "rollback_started" ||
            journal.GetProperty("targetSha").GetString() != sourceSha ||
            journal.GetProperty("sequence").GetInt32() is < 1 or > 6 ||
            journal.GetProperty("sequence").GetInt32() != receipt.GetProperty("sequence").GetInt32())
            throw new InvalidDataException("Native B quiesce evidence does not belong to the same rollback journal generation.");
        journalHandle.Position = 0;
        if (!CryptographicOperations.FixedTimeEquals(originalJournalDigest, SHA256.HashData(journalHandle)))
            throw new InvalidDataException("B shutdown journal does not match the original native HMAC proof.");
        using var shell = FindSingleOwnedStableShell(installedExe);
        var pid = shell.Id;
        var ticks = shell.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture);
        if (!OpenProcessToken(shell.Handle, TokenQuery, out var shellToken))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot inspect native B WPF process token.");
        using (shellToken)
        using (var shellIdentity = new WindowsIdentity(shellToken.DangerousGetHandle()))
        using (var guardianIdentity = WindowsIdentity.GetCurrent())
        {
            if (shellIdentity.User is null || guardianIdentity.User is null ||
                !shellIdentity.User.Equals(guardianIdentity.User) ||
                ReadWindowsLogonAuthenticationId(shellToken) !=
                    ReadWindowsLogonAuthenticationId(guardianIdentity.AccessToken))
                throw new InvalidDataException("B WPF shutdown process belongs to another user logon.");
        }
        if (shell.HasExited || shell.SessionId != Process.GetCurrentProcess().SessionId ||
            worker.HasExited || worker.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks)
            throw new InvalidDataException("B WPF shutdown lacks live exact OS process/session owners.");
        // The pipe name is the EXISTING installed WPF reopen server, not an
        // invented IPC capability. Win32 kernel supplies its actual server PID.
        InspectionPhase = "native-b-wpf-quiesce-kernel-pipe";
        using var pipe = new NamedPipeClientStream(".", "EquinoxLocal.WindowsShell.Reopen",
            PipeDirection.InOut, PipeOptions.Asynchronous);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        pipe.ConnectAsync(deadline.Token).GetAwaiter().GetResult();
        if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle, out var serverPid) || serverPid != pid ||
            shell.HasExited || shell.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != ticks ||
            worker.HasExited || worker.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks ||
            !CryptographicOperations.FixedTimeEquals(originalJournalDigest, HashPinnedBRollbackJournal(journalHandle)) ||
            !CryptographicOperations.FixedTimeEquals(handoffDigest, HashOwnedWorkerHandoff(journalRoot, owner.TransactionId)))
            throw new InvalidDataException("B WPF shutdown peer or rollback-stage journal changed before IPC.");
        // A graceful shutdown through the already-existing WPF command ONLY.
        // No forced termination, generic process exit or OS elevation.
        InspectionPhase = "native-b-wpf-quiesce-graceful-request";
        var command = Encoding.UTF8.GetBytes("shutdown-for-update\n");
        pipe.WriteAsync(command.AsMemory(), deadline.Token).AsTask().GetAwaiter().GetResult();
        pipe.FlushAsync(deadline.Token).GetAwaiter().GetResult();
        pipe.Dispose();
        InspectionPhase = "native-b-wpf-quiesce-observe-exit";
        if (!shell.WaitForExit(12000))
            throw new InvalidOperationException("Exact installed B WPF did not gracefully exit.");
        if (worker.HasExited || worker.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks ||
            !CryptographicOperations.FixedTimeEquals(originalJournalDigest, HashPinnedBRollbackJournal(journalHandle)) ||
            !CryptographicOperations.FixedTimeEquals(handoffDigest, HashOwnedWorkerHandoff(journalRoot, owner.TransactionId)))
            throw new InvalidDataException("B shutdown owner/journal changed during graceful exit.");
        // CREATE_NEW and write-through evidence, still NOT permission to
        // perform a physical B→A rename or mutate Native Messaging.
        using var output = new FileStream(receiptPath, FileMode.CreateNew, FileAccess.Write,
            FileShare.None, 4096, FileOptions.WriteThrough);
        using (var json = new Utf8JsonWriter(output))
        {
            json.WriteStartObject();
            json.WriteNumber("schemaVersion", 1);
            json.WriteString("transactionId", owner.TransactionId);
            json.WriteString("disposition", "b-shell-quiesced-only");
            json.WriteString("stage", "rollback_started");
            json.WriteNumber("sequence", journal.GetProperty("sequence").GetInt32());
            json.WriteNumber("shellPid", pid);
            json.WriteString("shellStartTimeUtcTicks", ticks);
            json.WriteNumber("workerPid", owner.Pid);
            json.WriteString("workerStartTimeUtcTicks", owner.Ticks);
            json.WriteNumber("guardianPid", Environment.ProcessId);
            json.WriteString("rollbackJournalSha256", Convert.ToHexStringLower(originalJournalDigest));
            json.WriteString("handoffSha256", Convert.ToHexStringLower(handoffDigest));
            json.WriteEndObject();
            json.Flush();
        }
        output.Flush(flushToDisk: true);
        InspectionPhase = "native-b-wpf-quiesced-main-still-blocked";
    }

    private static byte[] HashPinnedBRollbackJournal(FileStream journalHandle)
    {
        journalHandle.Position = 0;
        return SHA256.HashData(journalHandle);
    }
}
