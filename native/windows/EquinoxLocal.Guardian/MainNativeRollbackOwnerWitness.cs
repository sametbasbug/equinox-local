using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    private const string RollbackOwnerProofDomain = "equinox-local-guardian-rollback-os-owner-v1:";

    // Serves ONLY the independently audited original detached worker, on the
    // SAME Guardian PID and FileShare.None writer lease retained after stage5.
    // Never publishes the worker secret, launches programs or moves A/B.
    private static void HoldOwnedRollbackOwnerWitness(
        OwnedWorkerClaim owner, string journalRoot, Process worker, FileStream lease, Stopwatch leaseAge)
    {
        var journalPath = Path.Combine(journalRoot, owner.TransactionId + ".json");
        var markerPath = Path.Combine(journalRoot, owner.TransactionId + ".rollback_started.commit.json");
        while (!worker.HasExited && leaseAge.Elapsed < TimeSpan.FromMinutes(20))
        {
            if (lease.SafeFileHandle.IsClosed || lease.SafeFileHandle.IsInvalid)
                throw new InvalidDataException("Original Guardian OS writer handle was lost.");
            var remaining = TimeSpan.FromMinutes(20) - leaseAge.Elapsed;
            if (remaining <= TimeSpan.Zero) break;
            InspectionPhase = "native-integrated-a-rollback-owner-proof-wait";
            using var endpoint = new NamedPipeServerStream("EquinoxLocalMainAB-Owner-" + owner.TransactionId,
                PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
            // The same OS Guardian process multiplexes the read-only owner
            // witness and ONE fixed physical restore action under this SAME
            // exclusive lease. Neither endpoint is hosted by another owner.
            using var physical = new NamedPipeServerStream("EquinoxLocalMainAB-PhysicalRestore-" + owner.TransactionId,
                PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
            using var deadline = new CancellationTokenSource(remaining);
            var arrival = endpoint.WaitForConnectionAsync(deadline.Token);
            var physicalArrival = physical.WaitForConnectionAsync(deadline.Token);
            var exit = worker.WaitForExitAsync(deadline.Token);
            var completed = Task.WhenAny(arrival, physicalArrival, exit).GetAwaiter().GetResult();
            if (completed == physicalArrival)
            {
                physicalArrival.GetAwaiter().GetResult();
                deadline.Cancel();
                ServeOwnedPhysicalARestore(owner, journalRoot, worker, lease, leaseAge, physical);
                // A is physically restored but all pointers still select B:
                // never resume the read-only stage5 loop or mark rollback done.
                return;
            }
            if (completed != arrival) { deadline.Cancel(); break; }
            try { arrival.GetAwaiter().GetResult(); }
            catch (OperationCanceledException) { break; }
            deadline.Cancel();
            // Only the narrow product-owned read-only Guardian auditor is
            // admitted as a client, NEVER an arbitrary process/PID claim.
            // The original detached worker identity must ALSO remain live.
            if (!GetNamedPipeClientProcessId(endpoint.SafePipeHandle, out var pid) || pid < 1 ||
                worker.HasExited || worker.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks)
                throw new InvalidDataException("Guardian rollback OS witness has no valid audit peer or original worker.");
            using (var auditor = Process.GetProcessById(checked((int)pid)))
            {
                var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                var auditorExe = Path.Combine(local, "Equinox Local", "runtime", "guardian", "EquinoxLocalGuardian.exe");
                if (auditor.HasExited || auditor.SessionId != Process.GetCurrentProcess().SessionId ||
                    !Compare.Equals(Path.GetFullPath(auditor.MainModule?.FileName ?? ""), Path.GetFullPath(auditorExe)) ||
                    !OpenProcessToken(auditor.Handle, TokenQuery, out var auditorToken))
                    throw new InvalidDataException("Guardian rollback OS witness audit peer executable or OS session is invalid.");
                using (auditorToken)
                using (var auditorIdentity = new WindowsIdentity(auditorToken.DangerousGetHandle()))
                using (var ownIdentity = WindowsIdentity.GetCurrent())
                {
                    var auditLogon = ReadWindowsLogonAuthenticationId(auditorToken);
                    var ownerLogon = ReadWindowsLogonAuthenticationId(ownIdentity.AccessToken);
                    if (auditorIdentity.User is null || !auditorIdentity.User.Equals(ownIdentity.User) ||
                        auditLogon == 0 || auditLogon != ownerLogon)
                        throw new InvalidDataException("Guardian OS witness audit peer belongs to a foreign Windows logon.");
                }
            }
            InspectionPhase = "native-integrated-a-rollback-owner-proof-journal";
            using var journal = ReadOwnedTransitionRecord(journalPath, 8192);
            using var marker = ReadOwnedTransitionRecord(markerPath, 4096);
            if (journal.RootElement.GetProperty("transactionId").GetString() != owner.TransactionId ||
                journal.RootElement.GetProperty("stage").GetString() != "rollback_started" ||
                journal.RootElement.GetProperty("sequence").GetInt32() != 5 ||
                marker.RootElement.GetProperty("transactionId").GetString() != owner.TransactionId ||
                marker.RootElement.GetProperty("stage").GetString() != "rollback_started" ||
                marker.RootElement.GetProperty("sequence").GetInt32() != 5 ||
                marker.RootElement.GetProperty("guardianPid").GetInt32() != Environment.ProcessId)
                throw new InvalidDataException("Guardian rollback OS owner witness has no exact durable stage5.");
            var digest = SHA256.HashData(File.ReadAllBytes(journalPath));
            if (marker.RootElement.GetProperty("journalSha256").GetString() != Convert.ToHexStringLower(digest))
                throw new InvalidDataException("Guardian rollback OS witness stage5 SHA drifted.");
            using var replyCutoff = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            var nonce = new byte[32];
            for (var offset = 0; offset < nonce.Length;)
            {
                var count = endpoint.ReadAsync(nonce.AsMemory(offset), replyCutoff.Token).AsTask().GetAwaiter().GetResult();
                if (count < 1) throw new InvalidDataException("Guardian OS owner challenge ended before nonce.");
                offset += count;
            }
            var key = Convert.FromHexString(owner.Token);
            try
            {
                using var mac = new HMACSHA256(key);
                var guardianTicks = Process.GetCurrentProcess().StartTime.ToUniversalTime().Ticks;
                var challenge = Encoding.ASCII.GetBytes(RollbackOwnerProofDomain)
                    .Concat(nonce).Concat(digest)
                    .Concat(BitConverter.GetBytes(Environment.ProcessId))
                    .Concat(BitConverter.GetBytes(guardianTicks)).ToArray();
                var proof = mac.ComputeHash(challenge);
                if (lease.SafeFileHandle.IsClosed || lease.SafeFileHandle.IsInvalid || worker.HasExited ||
                    worker.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks ||
                    !CryptographicOperations.FixedTimeEquals(digest, SHA256.HashData(File.ReadAllBytes(journalPath))))
                    throw new InvalidDataException("Guardian original OS lease or worker changed during owner challenge.");
                endpoint.WriteAsync(proof.AsMemory(), replyCutoff.Token).AsTask().GetAwaiter().GetResult();
                endpoint.FlushAsync(replyCutoff.Token).GetAwaiter().GetResult();
                InspectionPhase = "native-integrated-a-rollback-owner-proof-read-only";
            }
            finally { CryptographicOperations.ZeroMemory(key); }
        }
    }

    // A SECOND PROCESS may perform this strictly READ-ONLY audit, but it never
    // creates, acquires, deletes or reconciles a writer lock and cannot act as
    // a replacement Guardian. OS kernel reports ORIGINAL named-pipe SERVER
    // PID; the original owner replies with fresh nonce HMAC under live lease.
    private static void AuditOwnedRollbackGuardianOsWitness()
    {
        InspectionPhase = "native-rollback-owner-audit-worker";
        var worker = InspectOwnedNativeWorkerProcess(guardianHoldsJournalLease: true);
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var install = Path.Combine(local, "Equinox Local");
        var journalRoot = Path.Combine(install, "state", "main-update", "guardian-journal");
        var journalPath = Path.Combine(journalRoot, worker.TransactionId + ".json");
        var markerPath = Path.Combine(journalRoot, worker.TransactionId + ".rollback_started.commit.json");
        var lockPath = Path.Combine(journalRoot, "." + worker.TransactionId + ".writer-lock");
        RequireNormalFile(lockPath);
        using var journal = ReadOwnedTransitionRecord(journalPath, 8192);
        using var marker = ReadOwnedTransitionRecord(markerPath, 4096);
        if (journal.RootElement.GetProperty("stage").GetString() != "rollback_started" ||
            journal.RootElement.GetProperty("sequence").GetInt32() != 5 ||
            journal.RootElement.GetProperty("transactionId").GetString() != worker.TransactionId ||
            marker.RootElement.GetProperty("stage").GetString() != "rollback_started" ||
            marker.RootElement.GetProperty("sequence").GetInt32() != 5 ||
            marker.RootElement.GetProperty("transactionId").GetString() != worker.TransactionId)
            throw new InvalidDataException("Read-only owner audit requires exact native rollback_started/5.");
        var original = SHA256.HashData(File.ReadAllBytes(journalPath));
        if (marker.RootElement.GetProperty("journalSha256").GetString() != Convert.ToHexStringLower(original))
            throw new InvalidDataException("Read-only owner audit journal SHA mismatch.");
        var originalMarkerSha = SHA256.HashData(File.ReadAllBytes(markerPath));
        // Windows error 32 is ERROR_SHARING_VIOLATION. Any other I/O failure
        // (ACL denial, missing file etc.) is NOT proof of a held OS lease.
        try
        {
            using var unowned = new FileStream(lockPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            throw new InvalidDataException("Rollback Guardian writer lease is not exclusively OS-held.");
        }
        catch (IOException ex) when ((ex.HResult & 0xffff) == 32) { }
        InspectionPhase = "native-rollback-owner-audit-kernel-server-pid";
        using var pipe = new NamedPipeClientStream(".", "EquinoxLocalMainAB-Owner-" + worker.TransactionId,
            PipeDirection.InOut, PipeOptions.Asynchronous);
        pipe.Connect(1500);
        if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle, out var serverPid) ||
            serverPid != marker.RootElement.GetProperty("guardianPid").GetInt32())
            throw new InvalidDataException("Original Guardian OS server PID differs from durable native stage5.");
        using var server = Process.GetProcessById(checked((int)serverPid));
        var pinned = Path.Combine(install, "runtime", "guardian", "EquinoxLocalGuardian.exe");
        if (server.HasExited || !Compare.Equals(Path.GetFullPath(server.MainModule?.FileName ?? ""), Path.GetFullPath(pinned)) ||
            server.SessionId != Process.GetCurrentProcess().SessionId)
            throw new InvalidDataException("Original Guardian OS pipe belongs to an untrusted executable or session.");
        if (!OpenProcessToken(server.Handle, TokenQuery, out var serverToken))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot inspect original Guardian OS token.");
        using (serverToken)
        using (var serverIdentity = new WindowsIdentity(serverToken.DangerousGetHandle()))
        using (var ownIdentity = WindowsIdentity.GetCurrent())
        {
            var serverLogon = ReadWindowsLogonAuthenticationId(serverToken);
            var auditorLogon = ReadWindowsLogonAuthenticationId(ownIdentity.AccessToken);
            if (serverIdentity.User is null || !serverIdentity.User.Equals(ownIdentity.User) ||
                serverLogon == 0 || serverLogon != auditorLogon)
                throw new InvalidDataException("Original Guardian server does not belong to this Windows OS logon.");
        }
        InspectionPhase = "native-rollback-owner-audit-fresh-challenge";
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        var nonce = RandomNumberGenerator.GetBytes(32);
        pipe.WriteAsync(nonce.AsMemory(), deadline.Token).AsTask().GetAwaiter().GetResult();
        pipe.FlushAsync(deadline.Token).GetAwaiter().GetResult();
        var response = new byte[32];
        for (var offset = 0; offset < response.Length;)
        {
            var count = pipe.ReadAsync(response.AsMemory(offset), deadline.Token).AsTask().GetAwaiter().GetResult();
            if (count < 1) throw new InvalidDataException("Original Guardian owner reply truncated.");
            offset += count;
        }
        var key = Convert.FromHexString(worker.Token);
        try
        {
            using var mac = new HMACSHA256(key);
            var challenge = Encoding.ASCII.GetBytes(RollbackOwnerProofDomain)
                .Concat(nonce).Concat(original)
                .Concat(BitConverter.GetBytes(checked((int)serverPid)))
                .Concat(BitConverter.GetBytes(server.StartTime.ToUniversalTime().Ticks)).ToArray();
            if (!CryptographicOperations.FixedTimeEquals(mac.ComputeHash(challenge), response))
                throw new InvalidDataException("Original live Guardian did not prove exact OS-held lease challenge.");
        }
        finally { CryptographicOperations.ZeroMemory(key); }
        if (server.HasExited ||
            marker.RootElement.GetProperty("journalSha256").GetString() != Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(journalPath))) ||
            !CryptographicOperations.FixedTimeEquals(originalMarkerSha, SHA256.HashData(File.ReadAllBytes(markerPath))))
            throw new InvalidDataException("Original Guardian OS owner or native stage5 changed after attestation.");
        // The independent audit never closes, deletes or assumes ownership
        // of the original writer handle; ensure it remains OS-exclusive.
        try
        {
            using var unowned = new FileStream(lockPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            throw new InvalidDataException("Original Guardian writer lease ended during independent audit.");
        }
        catch (IOException ex) when ((ex.HResult & 0xffff) == 32) { }
        InspectionPhase = "native-rollback-owner-audit-read-only-pass";
    }
}
