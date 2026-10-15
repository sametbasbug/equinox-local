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
    private const string RestoredARestartWorkerDomain = "equinox-local-guardian-ab-relaunch-a-worker-v1:";
    private const string RestoredARestartOwnerDomain = "equinox-local-guardian-ab-relaunch-a-owner-v1:";

    // Original OS Guardian ONLY, fixed one-shot action after its durable
    // rollback_native_restored/6. Reuses existing WPF launch and reopen pipe
    // verification; does not claim backend A health or create stage7.
    private static void RestartOwnedRestoredAWpf(
        OwnedWorkerClaim owner, string journalRoot, Process worker,
        FileStream lease, Stopwatch leaseAge, NamedPipeServerStream pipe)
    {
        InspectionPhase = "native-integrated-a-relaunch-original-os-peer";
        if (!GetNamedPipeClientProcessId(pipe.SafePipeHandle, out var peerPid) || peerPid != owner.Pid ||
            lease.SafeFileHandle.IsClosed || lease.SafeFileHandle.IsInvalid ||
            leaseAge.Elapsed >= TimeSpan.FromMinutes(20) || worker.HasExited ||
            worker.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks)
            throw new InvalidDataException("Restored A launch is not owned by original kernel Guardian/worker.");
        var observed = InspectOwnedNativeWorkerProcess(guardianHoldsJournalLease: true);
        InspectOwnedNativeWorkerOsArguments(guardianHoldsJournalLease: true);
        var originalKey = Convert.FromHexString(owner.Token);
        var observedKey = Convert.FromHexString(observed.Token);
        try
        {
            if (observed.Pid != owner.Pid || observed.Ticks != owner.Ticks ||
                observed.TransactionId != owner.TransactionId ||
                !CryptographicOperations.FixedTimeEquals(originalKey, observedKey))
                throw new InvalidDataException("Restored A relaunch original worker OS credentials drifted.");
        }
        finally { CryptographicOperations.ZeroMemory(observedKey); CryptographicOperations.ZeroMemory(originalKey); }
        RequireOwnedRestoredAIdentityWitness(owner, journalRoot, worker, lease, leaseAge, requireDurableStage6: true);
        var journalPath = Path.Combine(journalRoot, owner.TransactionId + ".json");
        var before = SHA256.HashData(File.ReadAllBytes(journalPath));
        var remaining = TimeSpan.FromMinutes(20) - leaseAge.Elapsed;
        if (remaining <= TimeSpan.Zero) throw new InvalidDataException("Original A relaunch writer deadline expired.");
        using var cutoff = new CancellationTokenSource(remaining < TimeSpan.FromSeconds(65) ? remaining : TimeSpan.FromSeconds(65));
        var nonce = RandomNumberGenerator.GetBytes(32);
        pipe.WriteAsync(nonce.AsMemory(), cutoff.Token).AsTask().GetAwaiter().GetResult();
        pipe.FlushAsync(cutoff.Token).GetAwaiter().GetResult();
        var response = new byte[32];
        for (var i = 0; i < response.Length;)
        {
            var count = pipe.ReadAsync(response.AsMemory(i), cutoff.Token).AsTask().GetAwaiter().GetResult();
            if (count < 1) throw new InvalidDataException("Restored A original worker HMAC truncated.");
            i += count;
        }
        var secret = Convert.FromHexString(owner.Token);
        try
        {
            using var hmac = new HMACSHA256(secret);
            var expected = hmac.ComputeHash(Encoding.ASCII.GetBytes(RestoredARestartWorkerDomain)
                .Concat(nonce).Concat(before).ToArray());
            if (!CryptographicOperations.FixedTimeEquals(expected, response))
                throw new InvalidDataException("Restored A relaunch request lacks original live OS worker HMAC.");
            RequireOwnedRestoredAIdentityWitness(owner, journalRoot, worker, lease, leaseAge, requireDurableStage6: true);
            if (!CryptographicOperations.FixedTimeEquals(before, SHA256.HashData(File.ReadAllBytes(journalPath))))
                throw new InvalidDataException("Durable A stage6 changed before relaunch grant.");
            var ownerMac = hmac.ComputeHash(Encoding.ASCII.GetBytes(RestoredARestartOwnerDomain)
                .Concat(nonce).Concat(before).ToArray());
            var fixedGrant = new byte[33];
            ownerMac.CopyTo(fixedGrant, 0);
            fixedGrant[32] = (byte)'L';
            pipe.WriteAsync(fixedGrant.AsMemory(), cutoff.Token).AsTask().GetAwaiter().GetResult();
            pipe.FlushAsync(cutoff.Token).GetAwaiter().GetResult();
        }
        finally { CryptographicOperations.ZeroMemory(secret); }
        var grantAcknowledgement = new byte[1];
        if (pipe.ReadAsync(grantAcknowledgement.AsMemory(), cutoff.Token).AsTask().GetAwaiter().GetResult() != 1 ||
            grantAcknowledgement[0] != (byte)'l')
            throw new InvalidDataException("Fixed original A relaunch grant was not acknowledged.");
        RequireOwnedRestoredAIdentityWitness(owner, journalRoot, worker, lease, leaseAge, requireDurableStage6: true);
        using var journal = ReadOwnedTransitionRecord(journalPath, 8192);
        var state = journal.RootElement;
        var aSha = state.GetProperty("currentSha").GetString() ?? "";
        var stableVersion = state.GetProperty("previousNative").GetProperty("version").GetString() ?? "";
        var executable = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Programs", "Equinox Local", "EquinoxLocal.exe");
        RequireNormalFile(executable);
        using (var running = FindExactRunningWpfOrNull(executable))
            if (running is not null)
                throw new InvalidDataException("Competing or already relaunched A WPF blocks a second native launch.");
        InspectionPhase = "native-integrated-a-relaunch-os-exact-wpf";
        using var shell = Launch(executable, null);
        var shellTicks = shell.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture);
        if (shell.HasExited || shell.SessionId != Process.GetCurrentProcess().SessionId ||
            !Compare.Equals(Path.GetFullPath(shell.MainModule?.FileName ?? ""), Path.GetFullPath(executable)))
            throw new InvalidDataException("Guardian did not launch the exact installed Stable A WPF image.");
        if (!OpenProcessToken(shell.Handle, TokenQuery, out var shellToken))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot verify original A WPF token.");
        using (shellToken)
        using (var shellIdentity = new WindowsIdentity(shellToken.DangerousGetHandle()))
        using (var originalIdentity = WindowsIdentity.GetCurrent())
            if (shellIdentity.User is null || originalIdentity.User is null ||
                !shellIdentity.User.Equals(originalIdentity.User) ||
                ReadWindowsLogonAuthenticationId(shellToken) != ReadWindowsLogonAuthenticationId(originalIdentity.AccessToken))
                throw new InvalidDataException("Restored A WPF belongs to a foreign Windows SID/logon.");
        InspectionPhase = "native-integrated-a-relaunch-existing-wpf-pipe";
        var connected = false;
        for (var attempt = 0; attempt < 70; attempt++)
        {
            if (shell.HasExited || worker.HasExited || leaseAge.Elapsed >= TimeSpan.FromMinutes(20)) break;
            try
            {
                using var wpfPipe = new NamedPipeClientStream(".", "EquinoxLocal.WindowsShell.Reopen",
                    PipeDirection.InOut, PipeOptions.Asynchronous);
                using var attemptCutoff = new CancellationTokenSource(TimeSpan.FromMilliseconds(500));
                wpfPipe.ConnectAsync(attemptCutoff.Token).GetAwaiter().GetResult();
                if (!GetNamedPipeServerProcessId(wpfPipe.SafePipeHandle, out var serverPid) || serverPid != shell.Id)
                    throw new InvalidDataException("Restored A WPF reopen pipe is owned by foreign process.");
                connected = true;
                break;
            }
            catch (OperationCanceledException) { }
            catch (TimeoutException) { }
            catch (IOException) { }
            Thread.Sleep(130);
        }
        if (!connected || shell.HasExited || worker.HasExited ||
            shell.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != shellTicks ||
            worker.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks ||
            lease.SafeFileHandle.IsClosed || lease.SafeFileHandle.IsInvalid ||
            leaseAge.Elapsed >= TimeSpan.FromMinutes(20) ||
            !CryptographicOperations.FixedTimeEquals(before, SHA256.HashData(File.ReadAllBytes(journalPath))))
            throw new InvalidDataException("Original OS Guardian cannot prove the exact live A WPF after launch.");
        var receipt = Path.Combine(journalRoot, owner.TransactionId + ".wpf-a-restarted.json");
        using (var fd = new FileStream(receipt, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
        {
            using (var writer = new Utf8JsonWriter(fd))
            {
                writer.WriteStartObject();
                writer.WriteNumber("schemaVersion", 1);
                writer.WriteString("transactionId", owner.TransactionId);
                writer.WriteString("stableVersion", stableVersion);
                writer.WriteString("sourceSha", aSha);
                writer.WriteNumber("shellPid", shell.Id);
                writer.WriteString("shellStartTimeUtcTicks", shellTicks);
                writer.WriteNumber("guardianPid", Environment.ProcessId);
                writer.WriteString("stage6JournalSha256", Convert.ToHexStringLower(before));
                writer.WriteEndObject();
                writer.Flush();
            }
            fd.Flush(flushToDisk: true);
        }
        InspectionPhase = "native-integrated-a-relaunched-stage6-await-four-health";
        pipe.WriteByte((byte)'a');
        pipe.FlushAsync(cutoff.Token).GetAwaiter().GetResult();
        // WPF PID / native pipe is NOT 4 healthy backend/source/NM samples.
        // Keep stage6, same original exclusive lease and failed B quarantine.
    }
}
