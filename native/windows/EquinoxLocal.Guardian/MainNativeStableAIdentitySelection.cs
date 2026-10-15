using System.Diagnostics;
using System.Globalization;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    private const string SelectStableAWorkerDomain = "equinox-local-guardian-ab-select-stable-a-worker-v1:";
    private const string SelectStableAOwnerDomain = "equinox-local-guardian-ab-select-stable-a-owner-v1:";

    // Fixed, ONE-SHOT, original-Guardian action. Only the owned detached Node
    // worker may call the existing product source/native/NM selection helpers.
    // This server never accepts paths or scripts, never writes a pointer and
    // never advances stage5. Stage6 is a separate durable owner transaction.
    private static void ServeOwnedStableAIdentitySelection(
        OwnedWorkerClaim owner, string journalRoot, Process worker,
        FileStream lease, Stopwatch leaseAge, NamedPipeServerStream pipe)
    {
        InspectionPhase = "native-integrated-a-select-stable-os-peer";
        if (!GetNamedPipeClientProcessId(pipe.SafePipeHandle, out var peerPid) ||
            peerPid != owner.Pid || worker.HasExited ||
            worker.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks ||
            lease.SafeFileHandle.IsClosed || lease.SafeFileHandle.IsInvalid ||
            leaseAge.Elapsed >= TimeSpan.FromMinutes(20))
            throw new InvalidDataException("Stable A selection must come from the original live OS worker and owner.");
        var observed = InspectOwnedNativeWorkerProcess(guardianHoldsJournalLease: true);
        InspectOwnedNativeWorkerOsArguments(guardianHoldsJournalLease: true);
        var claimed = Convert.FromHexString(owner.Token);
        var current = Convert.FromHexString(observed.Token);
        try
        {
            if (observed.Pid != owner.Pid || observed.Ticks != owner.Ticks ||
                observed.TransactionId != owner.TransactionId ||
                !CryptographicOperations.FixedTimeEquals(claimed, current))
                throw new InvalidDataException("Stable A selection has changed original worker OS credentials.");
        }
        finally { CryptographicOperations.ZeroMemory(claimed); CryptographicOperations.ZeroMemory(current); }
        RequireOwnedRestoredASelectionReadiness(owner, journalRoot, worker, lease, leaseAge);
        var journalPath = Path.Combine(journalRoot, owner.TransactionId + ".json");
        var digest = SHA256.HashData(File.ReadAllBytes(journalPath));
        var budget = TimeSpan.FromMinutes(20) - leaseAge.Elapsed;
        if (budget <= TimeSpan.Zero) throw new InvalidDataException("Stable A selection missed original writer deadline.");
        using var deadline = new CancellationTokenSource(budget < TimeSpan.FromSeconds(45) ? budget : TimeSpan.FromSeconds(45));
        var nonce = RandomNumberGenerator.GetBytes(32);
        InspectionPhase = "native-integrated-a-select-stable-challenge";
        pipe.WriteAsync(nonce.AsMemory(), deadline.Token).AsTask().GetAwaiter().GetResult();
        pipe.FlushAsync(deadline.Token).GetAwaiter().GetResult();
        var reply = new byte[32];
        for (var i = 0; i < reply.Length;)
        {
            var count = pipe.ReadAsync(reply.AsMemory(i), deadline.Token).AsTask().GetAwaiter().GetResult();
            if (count < 1) throw new InvalidDataException("Stable A original worker challenge was truncated.");
            i += count;
        }
        var key = Convert.FromHexString(owner.Token);
        try
        {
            using var hmac = new HMACSHA256(key);
            var workerMac = hmac.ComputeHash(Encoding.ASCII.GetBytes(SelectStableAWorkerDomain)
                .Concat(nonce).Concat(digest).ToArray());
            if (!CryptographicOperations.FixedTimeEquals(workerMac, reply))
                throw new InvalidDataException("Stable A selection did not authenticate original worker and journal.");
            // An authenticated request is NOT permission if the physical A/B
            // trees, selected B pointers or ORIGINAL writer/worker drifted.
            RequireOwnedRestoredASelectionReadiness(owner, journalRoot, worker, lease, leaseAge);
            if (!CryptographicOperations.FixedTimeEquals(digest, SHA256.HashData(File.ReadAllBytes(journalPath))))
                throw new InvalidDataException("Stable A selection stage5 changed before fixed grant.");
            var guardianMac = hmac.ComputeHash(Encoding.ASCII.GetBytes(SelectStableAOwnerDomain)
                .Concat(nonce).Concat(digest).ToArray());
            var fixedGrant = new byte[33];
            guardianMac.CopyTo(fixedGrant, 0);
            fixedGrant[32] = (byte)'S';
            InspectionPhase = "native-integrated-a-select-stable-fixed-grant";
            pipe.WriteAsync(fixedGrant.AsMemory(), deadline.Token).AsTask().GetAwaiter().GetResult();
            pipe.FlushAsync(deadline.Token).GetAwaiter().GetResult();
        }
        finally { CryptographicOperations.ZeroMemory(key); }
        var ack = new byte[1];
        if (pipe.ReadAsync(ack.AsMemory(), deadline.Token).AsTask().GetAwaiter().GetResult() != 1 ||
            ack[0] != (byte)'s')
            throw new InvalidDataException("Stable A original worker did not acknowledge fixed identity selection.");
        // The worker acknowledgment proves NOTHING by itself. The original
        // Guardian independently reads every identity and both physical slots.
        RequireOwnedRestoredAIdentityWitness(owner, journalRoot, worker, lease, leaseAge);
        // Independent OS-owned exact physical A + quarantined B SHA, Stable
        // source SHA, absent B native pointer and Stable NM identity are now
        // confirmed. Only THIS ORIGINAL Guardian holding its first kernel
        // writer lease can persist rollback_native_restored/6. A crash between
        // journal replacement and its write-through commit marker leaves a
        // permanent orphan requiring offline reconciliation, NEVER success.
        InspectionPhase = "native-integrated-a-restore-durable-stage6";
        WriteIntegratedOwnedNativeStage(owner, journalPath,
            "rollback_started", 5, "rollback_native_restored", 6);
        var commitPath = Path.Combine(journalRoot, owner.TransactionId + ".rollback_native_restored.commit.json");
        using var commit = ReadOwnedTransitionRecord(commitPath, 4096);
        using var promoted = ReadOwnedTransitionRecord(journalPath, 8192);
        if (commit.RootElement.GetProperty("schemaVersion").GetInt32() != 1 ||
            commit.RootElement.GetProperty("transactionId").GetString() != owner.TransactionId ||
            commit.RootElement.GetProperty("stage").GetString() != "rollback_native_restored" ||
            commit.RootElement.GetProperty("sequence").GetInt32() != 6 ||
            commit.RootElement.GetProperty("guardianPid").GetInt32() != Environment.ProcessId ||
            promoted.RootElement.GetProperty("transactionId").GetString() != owner.TransactionId ||
            promoted.RootElement.GetProperty("stage").GetString() != "rollback_native_restored" ||
            promoted.RootElement.GetProperty("sequence").GetInt32() != 6 ||
            commit.RootElement.GetProperty("journalSha256").GetString() !=
                Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(journalPath))) ||
            lease.SafeFileHandle.IsClosed || lease.SafeFileHandle.IsInvalid || worker.HasExited ||
            worker.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks ||
            leaseAge.Elapsed >= TimeSpan.FromMinutes(20))
            throw new InvalidDataException("Original Guardian durable rollback_native_restored/6 is unproven.");
        InspectionPhase = "native-integrated-a-restored-stage6-no-health";
        pipe.WriteByte((byte)'a');
        pipe.FlushAsync(deadline.Token).GetAwaiter().GetResult();
        // No new OS owner, WPF relaunch, A backend health or terminal success.
    }
}
