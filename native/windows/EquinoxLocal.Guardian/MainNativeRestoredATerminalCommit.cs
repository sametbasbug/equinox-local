using System.Diagnostics;
using System.Globalization;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    private const string TerminalAWorkerDomain = "equinox-local-guardian-ab-terminal-a-worker-v1:";
    private const string TerminalAOwnerDomain = "equinox-local-guardian-ab-terminal-a-owner-v1:";

    // ONE terminal fixed 'T' command after stage7 + original read-only
    // full physical A/B + stage6/stage7 ancestry and WPF OS proof. No B
    // quarantine deletion, no JS-only grant, no replacement OS writer.
    private static void ServeOwnedRestoredATerminalCommit(
        OwnedWorkerClaim owner, string journalRoot, Process worker,
        FileStream lease, Stopwatch leaseAge, NamedPipeServerStream pipe)
    {
        InspectionPhase = "native-integrated-a-terminal-original-kernel-peer";
        if (!GetNamedPipeClientProcessId(pipe.SafePipeHandle, out var pid) || pid != owner.Pid ||
            worker.HasExited || lease.SafeFileHandle.IsClosed || lease.SafeFileHandle.IsInvalid ||
            leaseAge.Elapsed >= TimeSpan.FromMinutes(20) ||
            worker.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks)
            throw new InvalidDataException("Original A terminal request has no live Guardian OS owner.");
        var current = InspectOwnedNativeWorkerProcess(guardianHoldsJournalLease: true);
        InspectOwnedNativeWorkerOsArguments(guardianHoldsJournalLease: true);
        var ownerToken = Convert.FromHexString(owner.Token);
        var currentToken = Convert.FromHexString(current.Token);
        try
        {
            if (current.Pid != owner.Pid || current.Ticks != owner.Ticks ||
                current.TransactionId != owner.TransactionId ||
                !CryptographicOperations.FixedTimeEquals(ownerToken, currentToken))
                throw new InvalidDataException("Original A terminal worker OS credential changed.");
        }
        finally { CryptographicOperations.ZeroMemory(ownerToken); CryptographicOperations.ZeroMemory(currentToken); }
        RequireOwnedRestoredATerminalReadiness(owner, journalRoot, worker, lease, leaseAge);
        var journalPath = Path.Combine(journalRoot, owner.TransactionId + ".json");
        var digest = SHA256.HashData(File.ReadAllBytes(journalPath));
        var remaining = TimeSpan.FromMinutes(20) - leaseAge.Elapsed;
        if (remaining <= TimeSpan.Zero) throw new InvalidDataException("Original A terminal writer deadline expired.");
        using var cutoff = new CancellationTokenSource(remaining < TimeSpan.FromSeconds(110) ? remaining : TimeSpan.FromSeconds(110));
        var nonce = RandomNumberGenerator.GetBytes(32);
        pipe.WriteAsync(nonce.AsMemory(), cutoff.Token).AsTask().GetAwaiter().GetResult();
        pipe.FlushAsync(cutoff.Token).GetAwaiter().GetResult();
        var response = new byte[32];
        for (var i = 0; i < response.Length;)
        {
            var count = pipe.ReadAsync(response.AsMemory(i), cutoff.Token).AsTask().GetAwaiter().GetResult();
            if (count <= 0) throw new InvalidDataException("Original A terminal challenge truncated.");
            i += count;
        }
        var key = Convert.FromHexString(owner.Token);
        try
        {
            using var hmac = new HMACSHA256(key);
            var expected = hmac.ComputeHash(Encoding.ASCII.GetBytes(TerminalAWorkerDomain)
                .Concat(nonce).Concat(digest).ToArray());
            if (!CryptographicOperations.FixedTimeEquals(expected, response))
                throw new InvalidDataException("Original A terminal request lacks valid live worker HMAC.");
            RequireOwnedRestoredATerminalReadiness(owner, journalRoot, worker, lease, leaseAge);
            if (!CryptographicOperations.FixedTimeEquals(digest, SHA256.HashData(File.ReadAllBytes(journalPath))))
                throw new InvalidDataException("Original A stage7 drifted before terminal grant.");
            var own = hmac.ComputeHash(Encoding.ASCII.GetBytes(TerminalAOwnerDomain)
                .Concat(nonce).Concat(digest).ToArray());
            var grant = new byte[33];
            own.CopyTo(grant, 0);
            grant[32] = (byte)'T';
            pipe.WriteAsync(grant.AsMemory(), cutoff.Token).AsTask().GetAwaiter().GetResult();
            pipe.FlushAsync(cutoff.Token).GetAwaiter().GetResult();
        }
        finally { CryptographicOperations.ZeroMemory(key); }
        var ack = new byte[1];
        if (pipe.ReadAsync(ack.AsMemory(), cutoff.Token).AsTask().GetAwaiter().GetResult() != 1 ||
            ack[0] != (byte)'t')
            throw new InvalidDataException("Original A terminal request did not acknowledge fixed T action.");
        RequireOwnedRestoredATerminalReadiness(owner, journalRoot, worker, lease, leaseAge);
        if (!CryptographicOperations.FixedTimeEquals(digest, SHA256.HashData(File.ReadAllBytes(journalPath))))
            throw new InvalidDataException("Original A terminal identity lost durable stage7 before terminal commit.");
        InspectionPhase = "native-integrated-a-durable-rolled-back-stage8";
        WriteIntegratedOwnedNativeStage(owner, journalPath,
            "rollback_healthy", 7, "rolled_back", 8);
        var markerPath = Path.Combine(journalRoot, owner.TransactionId + ".rolled_back.commit.json");
        using var marker = ReadOwnedTransitionRecord(markerPath, 4096);
        using var promoted = ReadOwnedTransitionRecord(journalPath, 8192);
        if (marker.RootElement.GetProperty("schemaVersion").GetInt32() != 1 ||
            marker.RootElement.GetProperty("transactionId").GetString() != owner.TransactionId ||
            marker.RootElement.GetProperty("stage").GetString() != "rolled_back" ||
            marker.RootElement.GetProperty("sequence").GetInt32() != 8 ||
            marker.RootElement.GetProperty("guardianPid").GetInt32() != Environment.ProcessId ||
            marker.RootElement.GetProperty("journalSha256").GetString() !=
                Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(journalPath))) ||
            promoted.RootElement.GetProperty("stage").GetString() != "rolled_back" ||
            promoted.RootElement.GetProperty("sequence").GetInt32() != 8 ||
            lease.SafeFileHandle.IsClosed || lease.SafeFileHandle.IsInvalid || worker.HasExited ||
            leaseAge.Elapsed >= TimeSpan.FromMinutes(20) ||
            worker.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks)
            throw new InvalidDataException("Original OS Guardian terminal stage8 SHA/PID proof is incomplete.");
        InspectionPhase = "native-integrated-a-rolled-back-stage8-retained-b-cleanup-pending";
        pipe.WriteByte((byte)'a');
        pipe.FlushAsync(cutoff.Token).GetAwaiter().GetResult();
        // Stage8 finalizes the durable rollback identity, but B remains SHA-
        // quarantined. No B deletion or cleanup grant exists in this action.
    }
}
