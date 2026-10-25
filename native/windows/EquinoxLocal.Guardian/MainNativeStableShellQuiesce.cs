using System.Diagnostics;
using System.Globalization;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Security.Principal;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    // Opt-in pilot: actually ask exactly the installed Stable WPF shell to
    // exit through its existing ownership pipe, but NEVER swap native bytes,
    // register Chrome Native Messaging, start a B runtime or advance Main.
    private static void QuiesceOwnedStableShell(OwnedWorkerClaim owner, string journalRoot, Process worker,
        bool continuousNativeSession = false)
    {
        InspectionPhase = "native-wpf-quiesce-owned-stable";
        InspectBaseline(allowActiveOrphanForReconciliation: true);
        var install = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Equinox Local");
        var root = Path.Combine(install, "state", "main-update");
        using var active = ReadOwnedTransitionRecord(Path.Combine(root, "active.json"), 8192);
        if (active.RootElement.GetProperty("transactionId").GetString() != owner.TransactionId)
            throw new InvalidDataException("Stable WPF quiesce active transaction changed.");
        using var journal = ReadOwnedTransitionRecord(Path.Combine(journalRoot, owner.TransactionId + ".json"), 8192);
        if (!(continuousNativeSession
                ? journal.RootElement.GetProperty("stage").GetString() == "native_staged" &&
                  journal.RootElement.GetProperty("sequence").GetInt32() == 1
                : journal.RootElement.GetProperty("stage").GetString() == "prepared" &&
                  journal.RootElement.GetProperty("sequence").GetInt32() == 0) ||
            journal.RootElement.GetProperty("previousNative").GetProperty("kind").GetString() != "stable")
            throw new InvalidDataException("Stable shell quiesce pilot requires exact unchanged prepared Stable A.");
        var stableExe = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Programs", "Equinox Local", "EquinoxLocal.exe");
        RequireNormalFile(stableExe);
        using var shell = FindSingleOwnedStableShell(stableExe);
        var pid = shell.Id;
        var ticks = shell.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture);
        // A matching path and Windows session are not enough to authorize
        // closing a process: compare OS token SID and logon authentication LUID.
        if (!OpenProcessToken(shell.Handle, TokenQuery, out var shellToken))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot query the owned Stable WPF identity.");
        using (shellToken)
        using (var shellIdentity = new WindowsIdentity(shellToken.DangerousGetHandle()))
        using (var guardianIdentity = WindowsIdentity.GetCurrent())
        {
            if (shellIdentity.User is null || guardianIdentity.User is null ||
                !shellIdentity.User.Equals(guardianIdentity.User) ||
                ReadWindowsLogonAuthenticationId(shellToken) != ReadWindowsLogonAuthenticationId(guardianIdentity.AccessToken))
                throw new InvalidDataException("Stable WPF SID or Windows logon differs from native Guardian.");
        }
        if (shell.HasExited || shell.SessionId != Process.GetCurrentProcess().SessionId ||
            worker.HasExited || worker.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks)
            throw new InvalidDataException("Stable WPF and worker owners are no longer live in Guardian session.");
        var journalPath = Path.Combine(journalRoot, owner.TransactionId + ".json");
        var originalJournalDigest = SHA256.HashData(File.ReadAllBytes(journalPath));
        var proofPath = Path.Combine(journalRoot, owner.TransactionId + ".native-authority.json");
        using (var authority = ReadOwnedTransitionRecord(proofPath, 8192))
        {
            var proof = authority.RootElement;
            RequireExactKeys(proof, ["schemaVersion", "transactionId", "stage", "sequence", "workerPid",
                "workerStartTimeUtcTicks", "guardianPid", "journalSha256", "handoffSha256"]);
            if (proof.GetProperty("schemaVersion").GetInt32() != 1 ||
                proof.GetProperty("transactionId").GetString() != owner.TransactionId ||
                proof.GetProperty("stage").GetString() != "prepared" || proof.GetProperty("sequence").GetInt32() != 0 ||
                proof.GetProperty("workerPid").GetInt32() != owner.Pid ||
                proof.GetProperty("workerStartTimeUtcTicks").GetString() != owner.Ticks ||
                proof.GetProperty("guardianPid").GetInt32() != Environment.ProcessId ||
                (!continuousNativeSession && !CryptographicOperations.FixedTimeEquals(
                    Encoding.ASCII.GetBytes(proof.GetProperty("journalSha256").GetString() ?? ""),
                    Encoding.ASCII.GetBytes(Convert.ToHexStringLower(originalJournalDigest)))) ||
                !CryptographicOperations.FixedTimeEquals(
                    Encoding.ASCII.GetBytes(proof.GetProperty("handoffSha256").GetString() ?? ""),
                    Encoding.ASCII.GetBytes(Convert.ToHexStringLower(HashOwnedWorkerHandoff(journalRoot, owner.TransactionId)))))
                throw new InvalidDataException("Stable WPF shutdown lacks the exact native authenticated prepared generation.");
        }
        var receipt = Path.Combine(journalRoot, owner.TransactionId + ".stable-shell-quiesce.json");
        if (File.Exists(receipt)) throw new InvalidDataException("Stable shell quiesce evidence already exists.");
        InspectionPhase = "native-wpf-quiesce-kernel-pipe";
        using var pipe = new NamedPipeClientStream(".", "EquinoxLocal.WindowsShell.Reopen",
            PipeDirection.InOut, PipeOptions.Asynchronous);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        pipe.ConnectAsync(deadline.Token).GetAwaiter().GetResult();
        if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle, out var serverPid) || serverPid != pid ||
            shell.HasExited || shell.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != ticks)
            throw new InvalidDataException("Windows named pipe server PID is not the exactly owned Stable WPF shell.");
        // Do not invent a second shell IPC command or generic process killer.
        // We only use the existing WPF graceful app-exit route. Its process
        // must genuinely exit within the bounded deadline to count as proof.
        InspectionPhase = "native-wpf-quiesce-owned-request";
        var command = Encoding.UTF8.GetBytes("shutdown-for-update\n");
        pipe.WriteAsync(command.AsMemory(), deadline.Token).AsTask().GetAwaiter().GetResult();
        pipe.FlushAsync(deadline.Token).GetAwaiter().GetResult();
        pipe.Dispose();
        InspectionPhase = "native-wpf-quiesce-observe-exit";
        if (!shell.WaitForExit(12000))
            throw new InvalidOperationException("Verified Stable WPF shell did not gracefully exit.");
        if (worker.HasExited || worker.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks)
            throw new InvalidDataException("Worker changed while Stable shell shutdown completed.");
        if (!CryptographicOperations.FixedTimeEquals(originalJournalDigest, SHA256.HashData(File.ReadAllBytes(journalPath))))
            throw new InvalidDataException("Stable WPF shutdown journal changed without independent milestone authorization.");
        using (var marker = new FileStream(receipt, FileMode.CreateNew, FileAccess.Write,
            FileShare.None, 4096, FileOptions.WriteThrough))
        {
            using (var json = new Utf8JsonWriter(marker))
            {
                json.WriteStartObject();
                json.WriteNumber("schemaVersion", 1);
                json.WriteString("transactionId", owner.TransactionId);
                json.WriteString("disposition", "stable-shell-quiesced-only");
                json.WriteNumber("shellPid", pid);
                json.WriteString("shellStartTimeUtcTicks", ticks);
                json.WriteNumber("workerPid", owner.Pid);
                json.WriteString("workerStartTimeUtcTicks", owner.Ticks);
                json.WriteNumber("guardianPid", Environment.ProcessId);
                json.WriteString("preparedJournalSha256", Convert.ToHexStringLower(SHA256.HashData(
                    File.ReadAllBytes(journalPath))));
                json.WriteEndObject();
                json.Flush();
            }
            marker.Flush(flushToDisk: true);
        }
        InspectionPhase = "native-wpf-quiesce-verified-but-main-blocked";
    }

    private static Process FindSingleOwnedStableShell(string expectedExecutable)
    {
        Process? owned = null;
        foreach (var candidate in Process.GetProcessesByName("EquinoxLocal"))
        {
            try
            {
                if (!candidate.HasExited &&
                    Compare.Equals(Path.GetFullPath(candidate.MainModule?.FileName ?? ""),
                        Path.GetFullPath(expectedExecutable)))
                {
                    if (owned is not null)
                        throw new InvalidDataException("Multiple owned WPF processes block native quiesce.");
                    owned = candidate;
                    continue;
                }
            }
            finally { if (!ReferenceEquals(owned, candidate)) candidate.Dispose(); }
        }
        return owned ?? throw new InvalidDataException("Exact installed Stable WPF shell is not running.");
    }
}
