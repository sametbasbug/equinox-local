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
    private const string ABRestartDomain = "equinox-local-guardian-ab-restart-v1:";

    // Second phase of the SAME Guardian and SAME OS-held writer lease. The
    // original authenticated worker cannot choose a path, command, PID, or
    // journal stage. No Main B WPF process starts before source B AND native
    // B pointers agree and Guardian independently verifies immutable Git,
    // native payload SHA, installed binaries and Chrome Native Messaging.
    private static void RestartOwnedIntegratedBWpf(OwnedWorkerClaim owner, string journalRoot, Process worker)
    {
        var journalPath = Path.Combine(journalRoot, owner.TransactionId + ".json");
        InspectionPhase = "native-integrated-b-restart-await-worker";
        using var endpoint = new NamedPipeServerStream("EquinoxLocalMainAB-Restart-" + owner.TransactionId,
            PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
        using var cutoff = new CancellationTokenSource(TimeSpan.FromSeconds(110));
        endpoint.WaitForConnectionAsync(cutoff.Token).GetAwaiter().GetResult();
        if (!GetNamedPipeClientProcessId(endpoint.SafePipeHandle, out var clientPid) || clientPid != owner.Pid ||
            worker.HasExited || worker.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks)
            throw new InvalidDataException("B WPF restart IPC did not originate from original live worker.");
        using var journal = ReadOwnedTransitionRecord(journalPath, 8192);
        var j = journal.RootElement;
        if (j.GetProperty("transactionId").GetString() != owner.TransactionId ||
            j.GetProperty("stage").GetString() != "switched" || j.GetProperty("sequence").GetInt32() != 3)
            throw new InvalidDataException("B WPF restart requires exact Guardian-switched generation.");
        var before = SHA256.HashData(File.ReadAllBytes(journalPath));
        var nonce = RandomNumberGenerator.GetBytes(32);
        endpoint.WriteAsync(nonce.AsMemory(), cutoff.Token).AsTask().GetAwaiter().GetResult();
        endpoint.FlushAsync(cutoff.Token).GetAwaiter().GetResult();
        var response = new byte[32];
        for (var offset = 0; offset < response.Length;)
        {
            var count = endpoint.ReadAsync(response.AsMemory(offset), cutoff.Token).AsTask().GetAwaiter().GetResult();
            if (count < 1) throw new InvalidDataException("Authenticated B WPF restart worker disconnected during proof.");
            offset += count;
        }
        var secret = Convert.FromHexString(owner.Token);
        try
        {
            using var mac = new HMACSHA256(secret);
            var expected = mac.ComputeHash(Encoding.ASCII.GetBytes(ABRestartDomain)
                .Concat(nonce).Concat(before).ToArray());
            if (!CryptographicOperations.FixedTimeEquals(response, expected))
                throw new InvalidDataException("B WPF restart token does not bind exact worker and switched journal.");
        }
        finally { CryptographicOperations.ZeroMemory(secret); }
        if (!CryptographicOperations.FixedTimeEquals(before, SHA256.HashData(File.ReadAllBytes(journalPath))))
            throw new InvalidDataException("B WPF journal changed before independent restart identity audit.");
        InspectionPhase = "native-integrated-b-restart-independent-identity";
        InspectMainNativeIdentity(); // Full immutable source Git + native B + NM + installed shell hashes.
        using var checkedJournal = ReadOwnedTransitionRecord(journalPath, 8192);
        if (checkedJournal.RootElement.GetProperty("stage").GetString() != "switched" ||
            checkedJournal.RootElement.GetProperty("sequence").GetInt32() != 3 ||
            !CryptographicOperations.FixedTimeEquals(before, SHA256.HashData(File.ReadAllBytes(journalPath))))
            throw new InvalidDataException("Independent B identity audit changed the exact journal generation.");
        var executable = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Programs", "Equinox Local", "EquinoxLocal.exe");
        RequireNormalFile(executable);
        // No competing WPF owner can cause a reopen of the old A instance.
        using (var existing = FindExactRunningWpfOrNull(executable))
        {
            if (existing is not null) throw new InvalidDataException("A different or preexisting WPF process blocks native B launch.");
        }
        InspectionPhase = "native-integrated-b-restart-os-launch";
        using var shell = Launch(executable, null);
        var started = shell.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture);
        if (shell.HasExited || shell.SessionId != Process.GetCurrentProcess().SessionId ||
            !Compare.Equals(Path.GetFullPath(shell.MainModule?.FileName ?? ""), Path.GetFullPath(executable)))
            throw new InvalidDataException("Native Guardian did not launch the exact installed WPF B executable.");
        if (!OpenProcessToken(shell.Handle, TokenQuery, out var shellToken))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot inspect owned B WPF token.");
        using (shellToken)
        using (var ownerIdentity = new WindowsIdentity(shellToken.DangerousGetHandle()))
        using (var guardianIdentity = WindowsIdentity.GetCurrent())
        {
            if (ownerIdentity.User is null || guardianIdentity.User is null ||
                !ownerIdentity.User.Equals(guardianIdentity.User) ||
                ReadWindowsLogonAuthenticationId(shellToken) != ReadWindowsLogonAuthenticationId(guardianIdentity.AccessToken))
                throw new InvalidDataException("B WPF process is not owned by the original Windows user logon.");
        }
        InspectionPhase = "native-integrated-b-restart-existing-wpf-pipe-attestation";
        var connected = false;
        for (var attempt = 0; attempt < 70; attempt++)
        {
            if (shell.HasExited || worker.HasExited) break;
            try
            {
                using var pipe = new NamedPipeClientStream(".", "EquinoxLocal.WindowsShell.Reopen",
                    PipeDirection.InOut, PipeOptions.Asynchronous);
                using var attemptCutoff = new CancellationTokenSource(TimeSpan.FromMilliseconds(500));
                pipe.ConnectAsync(attemptCutoff.Token).GetAwaiter().GetResult();
                if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle, out var serverPid) || serverPid != shell.Id)
                    throw new InvalidDataException("B WPF named-pipe server belongs to another OS process.");
                connected = true;
                break;
            }
            catch (OperationCanceledException) { }
            catch (TimeoutException) { }
            catch (IOException) { }
            Thread.Sleep(130);
        }
        if (!connected || shell.HasExited || shell.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != started ||
            worker.HasExited || !CryptographicOperations.FixedTimeEquals(before, SHA256.HashData(File.ReadAllBytes(journalPath))))
            throw new InvalidDataException("Guardian could not prove a live exact B WPF IPC process after launch.");
        var receipt = Path.Combine(journalRoot, owner.TransactionId + ".wpf-b-restarted.json");
        using (var marker = new FileStream(receipt, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
        {
            using (var writer = new Utf8JsonWriter(marker))
            {
                writer.WriteStartObject();
                writer.WriteNumber("schemaVersion", 1);
                writer.WriteString("transactionId", owner.TransactionId);
                writer.WriteString("sourceSha", j.GetProperty("targetSha").GetString());
                writer.WriteString("runtimeContractSha256", j.GetProperty("targetRuntimeContractSha256").GetString());
                writer.WriteNumber("shellPid", shell.Id);
                writer.WriteString("shellStartTimeUtcTicks", started);
                writer.WriteNumber("guardianPid", Environment.ProcessId);
                writer.WriteString("switchedJournalSha256", Convert.ToHexStringLower(before));
                writer.WriteEndObject();
                writer.Flush();
            }
            marker.Flush(flushToDisk: true);
        }
        WriteIntegratedOwnedNativeStage(owner, journalPath, "switched", 3, "restarted", 4);
        endpoint.WriteByte((byte)'r');
        endpoint.FlushAsync(cutoff.Token).GetAwaiter().GetResult();
        InspectionPhase = "native-integrated-b-restarted-await-sustained-health";
        // Deliberately NOT healthy, committed, or authorized to discard A.
    }

    private static Process? FindExactRunningWpfOrNull(string executable)
    {
        Process? found = null;
        foreach (var candidate in Process.GetProcessesByName("EquinoxLocal"))
        {
            try
            {
                if (!candidate.HasExited && Compare.Equals(Path.GetFullPath(candidate.MainModule?.FileName ?? ""),
                    Path.GetFullPath(executable)))
                {
                    if (found is not null) throw new InvalidDataException("Multiple active Equinox WPF shells block launch.");
                    found = candidate;
                    continue;
                }
            }
            finally { if (!ReferenceEquals(found, candidate)) candidate.Dispose(); }
        }
        return found;
    }
}
