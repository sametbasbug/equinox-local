using System.Diagnostics;
using System.Globalization;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    private const string HealthyAWorkerDomain = "equinox-local-guardian-ab-healthy-a-worker-v1:";
    private const string HealthyAOwnerDomain = "equinox-local-guardian-ab-healthy-a-owner-v1:";

    // A newly admitted original worker action AFTER WPF A relaunch. One
    // fixed 'H' command; never trusts worker-asserted health, arbitrary
    // paths, timestamps or an old Guardian stage5/6 owner receipt.
    private static void ServeOwnedRestoredAHealthAdmission(
        OwnedWorkerClaim owner, string journalRoot, Process worker,
        FileStream lease, Stopwatch leaseAge, NamedPipeServerStream pipe)
    {
        InspectionPhase = "native-integrated-a-health-original-kernel-peer";
        if (!GetNamedPipeClientProcessId(pipe.SafePipeHandle, out var pid) || pid != owner.Pid ||
            worker.HasExited || lease.SafeFileHandle.IsClosed || lease.SafeFileHandle.IsInvalid ||
            leaseAge.Elapsed >= TimeSpan.FromMinutes(20) ||
            worker.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks)
            throw new InvalidDataException("Original A health request has no live Guardian OS owner.");
        var current = InspectOwnedNativeWorkerProcess(guardianHoldsJournalLease: true);
        InspectOwnedNativeWorkerOsArguments(guardianHoldsJournalLease: true);
        var ownerToken = Convert.FromHexString(owner.Token);
        var currentToken = Convert.FromHexString(current.Token);
        try
        {
            if (current.Pid != owner.Pid || current.Ticks != owner.Ticks ||
                current.TransactionId != owner.TransactionId ||
                !CryptographicOperations.FixedTimeEquals(ownerToken, currentToken))
                throw new InvalidDataException("Original A health worker OS credential changed.");
        }
        finally { CryptographicOperations.ZeroMemory(ownerToken); CryptographicOperations.ZeroMemory(currentToken); }
        RequireOwnedRestoredAIdentityWitness(owner, journalRoot, worker, lease, leaseAge,
            requireDurableStage6: true, allowRestoredAWpf: true);
        var journalPath = Path.Combine(journalRoot, owner.TransactionId + ".json");
        var digest = SHA256.HashData(File.ReadAllBytes(journalPath));
        var remaining = TimeSpan.FromMinutes(20) - leaseAge.Elapsed;
        if (remaining <= TimeSpan.Zero) throw new InvalidDataException("Original A health writer deadline expired.");
        using var cutoff = new CancellationTokenSource(remaining < TimeSpan.FromSeconds(110) ? remaining : TimeSpan.FromSeconds(110));
        var nonce = RandomNumberGenerator.GetBytes(32);
        pipe.WriteAsync(nonce.AsMemory(), cutoff.Token).AsTask().GetAwaiter().GetResult();
        pipe.FlushAsync(cutoff.Token).GetAwaiter().GetResult();
        var response = new byte[32];
        for (var i = 0; i < response.Length;)
        {
            var count = pipe.ReadAsync(response.AsMemory(i), cutoff.Token).AsTask().GetAwaiter().GetResult();
            if (count <= 0) throw new InvalidDataException("Original A health challenge truncated.");
            i += count;
        }
        var key = Convert.FromHexString(owner.Token);
        try
        {
            using var hmac = new HMACSHA256(key);
            var expected = hmac.ComputeHash(Encoding.ASCII.GetBytes(HealthyAWorkerDomain)
                .Concat(nonce).Concat(digest).ToArray());
            if (!CryptographicOperations.FixedTimeEquals(expected, response))
                throw new InvalidDataException("Original A health request lacks valid live worker HMAC.");
            RequireOwnedRestoredAIdentityWitness(owner, journalRoot, worker, lease, leaseAge,
                requireDurableStage6: true, allowRestoredAWpf: true);
            if (!CryptographicOperations.FixedTimeEquals(digest, SHA256.HashData(File.ReadAllBytes(journalPath))))
                throw new InvalidDataException("A stage6 drifted before health grant.");
            var own = hmac.ComputeHash(Encoding.ASCII.GetBytes(HealthyAOwnerDomain)
                .Concat(nonce).Concat(digest).ToArray());
            var grant = new byte[33];
            own.CopyTo(grant, 0);
            grant[32] = (byte)'H';
            pipe.WriteAsync(grant.AsMemory(), cutoff.Token).AsTask().GetAwaiter().GetResult();
            pipe.FlushAsync(cutoff.Token).GetAwaiter().GetResult();
        }
        finally { CryptographicOperations.ZeroMemory(key); }
        var ack = new byte[1];
        if (pipe.ReadAsync(ack.AsMemory(), cutoff.Token).AsTask().GetAwaiter().GetResult() != 1 ||
            ack[0] != (byte)'h')
            throw new InvalidDataException("Original A health request did not acknowledge fixed H action.");
        RequireOwnedRestoredAFourBackendHealthSamples(owner, journalRoot, worker, lease, leaseAge);
        RequireOwnedRestoredAIdentityWitness(owner, journalRoot, worker, lease, leaseAge,
            requireDurableStage6: true, allowRestoredAWpf: true);
        if (!CryptographicOperations.FixedTimeEquals(digest, SHA256.HashData(File.ReadAllBytes(journalPath))))
            throw new InvalidDataException("Four original A samples lost stage6 after health completion.");
        InspectionPhase = "native-integrated-a-durable-rollback-healthy-stage7";
        WriteIntegratedOwnedNativeStage(owner, journalPath,
            "rollback_native_restored", 6, "rollback_healthy", 7);
        var markerPath = Path.Combine(journalRoot, owner.TransactionId + ".rollback_healthy.commit.json");
        using var marker = ReadOwnedTransitionRecord(markerPath, 4096);
        using var promoted = ReadOwnedTransitionRecord(journalPath, 8192);
        if (marker.RootElement.GetProperty("schemaVersion").GetInt32() != 1 ||
            marker.RootElement.GetProperty("transactionId").GetString() != owner.TransactionId ||
            marker.RootElement.GetProperty("stage").GetString() != "rollback_healthy" ||
            marker.RootElement.GetProperty("sequence").GetInt32() != 7 ||
            marker.RootElement.GetProperty("guardianPid").GetInt32() != Environment.ProcessId ||
            marker.RootElement.GetProperty("journalSha256").GetString() !=
                Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(journalPath))) ||
            promoted.RootElement.GetProperty("stage").GetString() != "rollback_healthy" ||
            promoted.RootElement.GetProperty("sequence").GetInt32() != 7 ||
            lease.SafeFileHandle.IsClosed || lease.SafeFileHandle.IsInvalid || worker.HasExited ||
            leaseAge.Elapsed >= TimeSpan.FromMinutes(20) ||
            worker.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks)
            throw new InvalidDataException("Original OS Guardian stage7 SHA/PID proof is incomplete.");
        InspectionPhase = "native-integrated-a-healthy-stage7-terminal-pending";
        pipe.WriteByte((byte)'a');
        pipe.FlushAsync(cutoff.Token).GetAwaiter().GetResult();
        // Never mark rolled_back/8 or discard failed B based only on stage7.
    }
}
