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
    private static void QuiesceOwnedStableShell(OwnedWorkerClaim owner, string journalRoot, Process worker) =>
        QuiesceOwnedAShell(owner, journalRoot, worker, mainA: false);

    // Isolated native pilot for the original managed-Main A. The existing
    // single OS Guardian owns the full live worker identity and journal lease;
    // no native slot, current pointer, B process or registry change is allowed.
    private static void QuiesceOwnedMainAShell(OwnedWorkerClaim owner, string journalRoot, Process worker) =>
        QuiesceOwnedAShell(owner, journalRoot, worker, mainA: true);

    private static void QuiesceOwnedAShell(OwnedWorkerClaim owner, string journalRoot, Process worker, bool mainA)
    {
        InspectionPhase = mainA ? "native-wpf-quiesce-owned-original-main-a" : "native-wpf-quiesce-owned-stable";
        if (mainA)
            InspectMainNativeIdentity(allowExactActiveMainTransaction: true);
        else
            InspectBaseline(allowActiveOrphanForReconciliation: true);
        var install = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Equinox Local");
        var root = Path.Combine(install, "state", "main-update");
        var activePath = Path.Combine(root, "active.json");
        RequireNormalFile(activePath);
        // No other process may replace the exact active marker between
        // native predecessor validation and WPF shutdown/receipt persistence.
        using var activeHandle = new FileStream(activePath, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (activeHandle.Length is < 2 or > 8192)
            throw new InvalidDataException("Native A active marker is outside its bound.");
        using var active = JsonDocument.Parse(activeHandle);
        if (active.RootElement.GetProperty("transactionId").GetString() != owner.TransactionId)
            throw new InvalidDataException("Stable WPF quiesce active transaction changed.");
        var journalPath = Path.Combine(journalRoot, owner.TransactionId + ".json");
        RequireNormalFile(journalPath);
        // Keep the OS file object non-replaceable throughout WPF exit.
        // Read and hash from this same pinned handle; no pathname reopen race.
        using var journalHandle = new FileStream(journalPath, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (journalHandle.Length is < 2 or > 8192)
            throw new InvalidDataException("Native A journal is outside its bounded generation.");
        using var journal = JsonDocument.Parse(journalHandle);
        var record = journal.RootElement;
        var previousA = record.GetProperty("previousNative");
        if (record.GetProperty("schemaVersion").GetInt32() != 1 ||
            record.GetProperty("channel").GetString() != "main" ||
            record.GetProperty("transactionId").GetString() != owner.TransactionId ||
            record.GetProperty("receiptStartedAt").GetString() != active.RootElement.GetProperty("startedAt").GetString() ||
            record.GetProperty("currentSha").GetString() != active.RootElement.GetProperty("currentSha").GetString() ||
            record.GetProperty("targetSha").GetString() != active.RootElement.GetProperty("targetSha").GetString() ||
            record.GetProperty("stage").GetString() != "prepared" ||
            record.GetProperty("sequence").GetInt32() != 0 ||
            previousA.GetProperty("kind").GetString() != (mainA ? "main" : "stable"))
            throw new InvalidDataException("Native A shell quiesce requires the exact unchanged prepared A journal.");
        var mainPointerPath = Path.Combine(root, "current-native.json");
        if (mainA) RequireNormalFile(mainPointerPath);
        // Main A selection must remain unchanged for the *whole* IPC exit.
        using var pointerHandle = mainA
            ? new FileStream(mainPointerPath, FileMode.Open, FileAccess.Read, FileShare.Read) : null;
        if (mainA)
        {
            RequireExactKeys(previousA, ["kind", "sourceSha", "runtimeContractSha256"]);
            if (pointerHandle is null || pointerHandle.Length is < 2 or > 8192)
                throw new InvalidDataException("Original Main A pointer is outside its trusted bound.");
            using var pointer = JsonDocument.Parse(pointerHandle);
            RequireExactKeys(pointer.RootElement, ["schemaVersion", "channel", "sourceSha", "target", "runtimeContractSha256"]);
            var sourceSha = active.RootElement.GetProperty("currentSha").GetString();
            var contract = pointer.RootElement.GetProperty("runtimeContractSha256").GetString();
            if (sourceSha != previousA.GetProperty("sourceSha").GetString() ||
                sourceSha != record.GetProperty("currentSha").GetString() ||
                sourceSha != pointer.RootElement.GetProperty("sourceSha").GetString() ||
                contract != previousA.GetProperty("runtimeContractSha256").GetString() ||
                active.RootElement.GetProperty("targetSha").GetString() != record.GetProperty("targetSha").GetString() ||
                pointer.RootElement.GetProperty("channel").GetString() != "main" ||
                pointer.RootElement.GetProperty("schemaVersion").GetInt32() != 1 ||
                pointer.RootElement.GetProperty("target").GetString() != record.GetProperty("target").GetString())
                throw new InvalidDataException("Main original A journal, native pointer and active source are not identical.");
        }
        else
            RequireExactKeys(previousA, ["kind", "version"]);
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
        var originalJournalDigest = HashPinnedOriginalAJournal(journalHandle);
        var proofPath = Path.Combine(journalRoot, owner.TransactionId + ".native-authority.json");
        RequireNormalFile(proofPath);
        using var proofHandle = new FileStream(proofPath, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (proofHandle.Length is < 2 or > 8192)
            throw new InvalidDataException("Original native A authority receipt is outside its bound.");
        using (var authority = JsonDocument.Parse(proofHandle))
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
                !CryptographicOperations.FixedTimeEquals(
                    Encoding.ASCII.GetBytes(proof.GetProperty("journalSha256").GetString() ?? ""),
                    Encoding.ASCII.GetBytes(Convert.ToHexStringLower(originalJournalDigest))) ||
                !CryptographicOperations.FixedTimeEquals(
                    Encoding.ASCII.GetBytes(proof.GetProperty("handoffSha256").GetString() ?? ""),
                    Encoding.ASCII.GetBytes(Convert.ToHexStringLower(HashOwnedWorkerHandoff(journalRoot, owner.TransactionId)))))
                throw new InvalidDataException("Stable WPF shutdown lacks the exact native authenticated prepared generation.");
        }
        var receipt = Path.Combine(journalRoot, owner.TransactionId +
            (mainA ? ".main-a-shell-quiesce.json" : ".stable-shell-quiesce.json"));
        if (File.Exists(receipt)) throw new InvalidDataException("Stable shell quiesce evidence already exists.");
        InspectionPhase = "native-wpf-quiesce-kernel-pipe";
        using var pipe = new NamedPipeClientStream(".", "EquinoxLocal.WindowsShell.Reopen",
            PipeDirection.InOut, PipeOptions.Asynchronous);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        pipe.ConnectAsync(deadline.Token).GetAwaiter().GetResult();
        if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle, out var serverPid) || serverPid != pid ||
            shell.HasExited || shell.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != ticks ||
            worker.HasExited || worker.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks ||
            !CryptographicOperations.FixedTimeEquals(originalJournalDigest, HashPinnedOriginalAJournal(journalHandle)))
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
        if (!CryptographicOperations.FixedTimeEquals(originalJournalDigest, HashPinnedOriginalAJournal(journalHandle)))
            throw new InvalidDataException("Stable WPF shutdown journal changed without independent milestone authorization.");
        using (var marker = new FileStream(receipt, FileMode.CreateNew, FileAccess.Write,
            FileShare.None, 4096, FileOptions.WriteThrough))
        {
            using (var json = new Utf8JsonWriter(marker))
            {
                json.WriteStartObject();
                json.WriteNumber("schemaVersion", 1);
                json.WriteString("transactionId", owner.TransactionId);
                json.WriteString("disposition", mainA ? "original-main-a-shell-quiesced-only" : "stable-shell-quiesced-only");
                json.WriteNumber("shellPid", pid);
                json.WriteString("shellStartTimeUtcTicks", ticks);
                json.WriteNumber("workerPid", owner.Pid);
                json.WriteString("workerStartTimeUtcTicks", owner.Ticks);
                json.WriteNumber("guardianPid", Environment.ProcessId);
                json.WriteString("preparedJournalSha256", Convert.ToHexStringLower(originalJournalDigest));
                json.WriteEndObject();
                json.Flush();
            }
            marker.Flush(flushToDisk: true);
        }
        InspectionPhase = mainA ? "native-original-main-a-quiesced-ab-still-blocked" :
            "native-wpf-quiesce-verified-but-main-blocked";
    }

    private static byte[] HashPinnedOriginalAJournal(FileStream handle)
    {
        handle.Position = 0;
        return SHA256.HashData(handle);
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
