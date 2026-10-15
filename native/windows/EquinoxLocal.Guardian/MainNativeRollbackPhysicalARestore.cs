using System.Diagnostics;
using System.Globalization;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    private const string PhysicalARestoreWorkerDomain = "equinox-local-guardian-ab-physical-restore-worker-v1:";
    private const string PhysicalARestoreOwnerDomain = "equinox-local-guardian-ab-physical-restore-owner-v1:";

    // ONE fixed-action request on the original OS-owned Guardian after
    // rollback_started/5. The Guardian never performs a second filesystem
    // implementation: the admitted original worker executes the shared JS
    // restoreWindowsNativeABSlot only after this mutual HMAC grant.
    // Physical A alone is NOT a journal milestone or source/native/NM commit.
    private static void ServeOwnedPhysicalARestore(
        OwnedWorkerClaim owner, string journalRoot, Process worker,
        FileStream lease, Stopwatch leaseAge, NamedPipeServerStream endpoint)
    {
        InspectionPhase = "native-integrated-a-physical-restore-peer";
        if (!GetNamedPipeClientProcessId(endpoint.SafePipeHandle, out var clientPid) ||
            clientPid != owner.Pid || worker.HasExited ||
            worker.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks ||
            lease.SafeFileHandle.IsClosed || lease.SafeFileHandle.IsInvalid)
            throw new InvalidDataException("A physical restore does not belong to the original live worker and Guardian lease.");
        // Inspect kernel user SID, AuthenticationId/LUID and Windows session
        // plus birth time/owned Node image again, not merely the JSON PID.
        var observed = InspectOwnedNativeWorkerProcess(guardianHoldsJournalLease: true);
        if (observed.Pid != owner.Pid || observed.Ticks != owner.Ticks ||
            observed.TransactionId != owner.TransactionId)
            throw new InvalidDataException("Original physical A worker OS identity changed.");
        // The trusted argv was admitted before A->B; independently check
        // exact current worker argv again with this original lease held.
        InspectOwnedNativeWorkerOsArguments(guardianHoldsJournalLease: true);
        var originalToken = Convert.FromHexString(owner.Token);
        var observedToken = Convert.FromHexString(observed.Token);
        try
        {
            if (!CryptographicOperations.FixedTimeEquals(originalToken, observedToken))
                throw new InvalidDataException("Physical A worker ownership token changed.");
        }
        finally { CryptographicOperations.ZeroMemory(observedToken); CryptographicOperations.ZeroMemory(originalToken); }

        RequireOwnedPhysicalARestoreReadiness(owner, journalRoot, worker, lease, leaseAge);
        var journalPath = Path.Combine(journalRoot, owner.TransactionId + ".json");
        var digest = SHA256.HashData(File.ReadAllBytes(journalPath));
        var remaining = TimeSpan.FromMinutes(20) - leaseAge.Elapsed;
        if (remaining <= TimeSpan.Zero)
            throw new InvalidDataException("Original Guardian A restore deadline expired.");
        using var timeout = new CancellationTokenSource(remaining < TimeSpan.FromSeconds(45) ? remaining : TimeSpan.FromSeconds(45));
        var nonce = RandomNumberGenerator.GetBytes(32);
        InspectionPhase = "native-integrated-a-physical-restore-worker-challenge";
        endpoint.WriteAsync(nonce.AsMemory(), timeout.Token).AsTask().GetAwaiter().GetResult();
        endpoint.FlushAsync(timeout.Token).GetAwaiter().GetResult();
        var response = new byte[32];
        for (var offset = 0; offset < response.Length;)
        {
            var received = endpoint.ReadAsync(response.AsMemory(offset), timeout.Token).AsTask().GetAwaiter().GetResult();
            if (received < 1) throw new InvalidDataException("Physical A original worker HMAC was truncated.");
            offset += received;
        }
        var secret = Convert.FromHexString(owner.Token);
        try
        {
            using var hmac = new HMACSHA256(secret);
            var expected = hmac.ComputeHash(Encoding.ASCII.GetBytes(PhysicalARestoreWorkerDomain)
                .Concat(nonce).Concat(digest).ToArray());
            if (!CryptographicOperations.FixedTimeEquals(expected, response))
                throw new InvalidDataException("Physical A restore request lacks the original worker's fresh HMAC.");
            // Grant only after an independent RE-check of both physical slots,
            // native/source pointers, live owner and exclusive writer handle.
            RequireOwnedPhysicalARestoreReadiness(owner, journalRoot, worker, lease, leaseAge);
            if (!CryptographicOperations.FixedTimeEquals(digest, SHA256.HashData(File.ReadAllBytes(journalPath))))
                throw new InvalidDataException("Stage5 changed before OS-authorized physical A restore.");
            var ownerMac = hmac.ComputeHash(Encoding.ASCII.GetBytes(PhysicalARestoreOwnerDomain)
                .Concat(nonce).Concat(digest).ToArray());
            var grant = new byte[33];
            ownerMac.CopyTo(grant, 0);
            grant[32] = (byte)'R';  // ONE action, no paths/commands from worker
            InspectionPhase = "native-integrated-a-physical-restore-fixed-grant";
            endpoint.WriteAsync(grant.AsMemory(), timeout.Token).AsTask().GetAwaiter().GetResult();
            endpoint.FlushAsync(timeout.Token).GetAwaiter().GetResult();
        }
        finally { CryptographicOperations.ZeroMemory(secret); }

        var acknowledgment = new byte[1];
        if (endpoint.ReadAsync(acknowledgment.AsMemory(), timeout.Token).AsTask().GetAwaiter().GetResult() != 1 ||
            acknowledgment[0] != (byte)'r')
            throw new InvalidDataException("Original worker did not acknowledge exact shared physical A restore.");
        InspectionPhase = "native-integrated-a-physical-restore-independent-hashes";
        // The worker's 'r' alone is never evidence. Native Guardian re-hashes
        // actual installed A and transaction-scoped quarantined B before ack.
        using var journal = ReadOwnedTransitionRecord(journalPath, 8192);
        var state = journal.RootElement;
        if (state.GetProperty("transactionId").GetString() != owner.TransactionId ||
            state.GetProperty("stage").GetString() != "rollback_started" ||
            state.GetProperty("sequence").GetInt32() != 5 ||
            !CryptographicOperations.FixedTimeEquals(digest, SHA256.HashData(File.ReadAllBytes(journalPath))))
            throw new InvalidDataException("Physical A restore changed Guardian journal without authorization.");
        var version = state.GetProperty("previousNative").GetProperty("version").GetString() ?? "";
        if (!VersionRegex().IsMatch(version)) throw new InvalidDataException("Physical A restore previous Stable version is invalid.");
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var install = Path.Combine(local, "Equinox Local");
        var program = Path.Combine(local, "Programs", "Equinox Local");
        var failedB = Path.Combine(Path.GetDirectoryName(program)!, ".equinox-shell-failed-" + owner.TransactionId);
        var originalA = Path.Combine(install, "releases", version, "runtime", "shell");
        var target = state.GetProperty("target").GetString() ?? "";
        var targetSha = state.GetProperty("targetSha").GetString() ?? "";
        if (!SourceShaPattern.IsMatch(targetSha) || target is not ("win32-x64" or "win32-arm64"))
            throw new InvalidDataException("Physical restore target B identity is foreign.");
        var bShell = Path.Combine(install, "state", "main-update", "native-store", target, targetSha, "release", "runtime", "shell");
        CompareNativeTrees(originalA, program);
        CompareNativeTrees(bShell, failedB);
        var backup = Path.Combine(Path.GetDirectoryName(program)!, ".equinox-shell-backup-" + owner.TransactionId);
        if (Directory.Exists(backup) || File.Exists(backup))
            throw new InvalidDataException("Original A backup still exists after physical restore.");
        using (var active = FindExactRunningWpfOrNull(Path.Combine(program, "EquinoxLocal.exe")))
            if (active is not null) throw new InvalidDataException("WPF launched before exact A identities were restored.");
        if (worker.HasExited || worker.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks ||
            lease.SafeFileHandle.IsClosed || lease.SafeFileHandle.IsInvalid ||
            leaseAge.Elapsed >= TimeSpan.FromMinutes(20))
            throw new InvalidDataException("Original OS lease or worker ended during physical A restoration.");
        // Separate post-rename gate: A must now occupy the live WPF slot,
        // B must be quarantined and ALL source/native/NM pointers still B.
        // Even a successful fixed physical rename is not A identity recovery.
        RequireOwnedRestoredASelectionReadiness(owner, journalRoot, worker, lease, leaseAge);
        InspectionPhase = "native-integrated-a-physical-restored-no-stage6";
        endpoint.WriteByte((byte)'a');
        endpoint.FlushAsync(timeout.Token).GetAwaiter().GetResult();
        // Keep the stage5/original exclusive writer lock unreconciled; source,
        // native and Native Messaging still select B. NOTHING may report
        // terminal restored, run WPF A or silently reclaim this lock.
    }
}
