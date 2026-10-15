using System.Diagnostics;
using System.Globalization;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    private const string ABRollbackAdmissionDomain = "equinox-local-guardian-ab-rollback-start-v1:";

    // A future rollback coordinator may call this only inside the ORIGINAL
    // Guardian's exclusive writer lease, with the ORIGINAL admitted worker.
    // This narrow grant records rollback_started/5; it never restores files,
    // changes source/native pointers, launches WPF or discards either slot.
    // The original Guardian now listens after B restart and retained-A proof.
    // The original worker does NOT invoke this on its healthy B path; the
    // OS-owned physical A restore handoff remains deliberately disabled.
    private static void AuthorizeOwnedIntegratedARollbackStart(
        OwnedWorkerClaim owner, string journalRoot, Process worker)
    {
        using var endpoint = new NamedPipeServerStream("EquinoxLocalMainAB-Rollback-" + owner.TransactionId,
            PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
        // Await a request while the ORIGINAL Guardian retains CREATE_NEW /
        // FileShare.None for this transaction. A healthy B does not request
        // rollback, and an expired worker cannot trigger an orphan restart.
        // The same 20-minute bound replaces (rather than extends) the
        // preexisting Guardian lease wait for integrated A/B.
        InspectionPhase = "native-integrated-a-rollback-wait-original-worker-request";
        using (var requestCutoff = new CancellationTokenSource(TimeSpan.FromMinutes(20)))
        {
            var incoming = endpoint.WaitForConnectionAsync(requestCutoff.Token);
            var ownerExited = worker.WaitForExitAsync(requestCutoff.Token);
            Task completed;
            try { completed = Task.WhenAny(incoming, ownerExited).GetAwaiter().GetResult(); }
            catch (OperationCanceledException) { return; }
            if (completed != incoming)
            {
                requestCutoff.Cancel();
                InspectionPhase = "native-integrated-a-rollback-original-worker-exited-no-request";
                return;
            }
            incoming.GetAwaiter().GetResult();
            requestCutoff.Cancel();
        }
        using var cutoff = new CancellationTokenSource(TimeSpan.FromSeconds(45));
        if (!GetNamedPipeClientProcessId(endpoint.SafePipeHandle, out var pid) || pid != owner.Pid ||
            worker.HasExited || worker.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks)
            throw new InvalidDataException("Native A rollback pipe belongs to a foreign or expired Windows worker.");
        InspectionPhase = "native-integrated-a-rollback-original-journal";
        var journalPath = Path.Combine(journalRoot, owner.TransactionId + ".json");
        using var journal = ReadOwnedTransitionRecord(journalPath, 8192);
        var state = journal.RootElement;
        var a = state.GetProperty("previousNative");
        var stableVersion = a.GetProperty("version").GetString() ?? "";
        var target = state.GetProperty("target").GetString() ?? "";
        var targetSha = state.GetProperty("targetSha").GetString() ?? "";
        if (state.GetProperty("transactionId").GetString() != owner.TransactionId ||
            state.GetProperty("stage").GetString() != "restarted" || state.GetProperty("sequence").GetInt32() != 4 ||
            a.GetProperty("kind").GetString() != "stable" || !VersionRegex().IsMatch(stableVersion) ||
            !SourceShaPattern.IsMatch(targetSha) ||
            target != (System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture switch
                {
                    System.Runtime.InteropServices.Architecture.X64 => "win32-x64",
                    System.Runtime.InteropServices.Architecture.Arm64 => "win32-arm64",
                    _ => throw new PlatformNotSupportedException("Unsupported native rollback architecture."),
                }))
            throw new InvalidDataException("Guardian A rollback authorization requires exact restarted B and retained Stable A.");
        var original = SHA256.HashData(File.ReadAllBytes(journalPath));
        var digest = Convert.ToHexStringLower(original);
        using var proof = ReadOwnedTransitionRecord(Path.Combine(journalRoot, owner.TransactionId + ".retained-a.json"), 8192);
        var receipt = proof.RootElement;
        if (receipt.GetProperty("transactionId").GetString() != owner.TransactionId ||
            receipt.GetProperty("disposition").GetString() != "retained-a-verified-no-restore-authority" ||
            receipt.GetProperty("stableVersion").GetString() != stableVersion ||
            receipt.GetProperty("workerPid").GetInt32() != owner.Pid ||
            receipt.GetProperty("guardianPid").GetInt32() != Environment.ProcessId ||
            receipt.GetProperty("journalSequence").GetInt32() != 4 ||
            receipt.GetProperty("journalSha256").GetString() != digest)
            throw new InvalidDataException("Native A rollback cannot reuse a foreign retained-backup observation.");
        var live = InspectOwnedNativeWorkerProcess(guardianHoldsJournalLease: true);
        if (live.Pid != owner.Pid || live.Ticks != owner.Ticks || live.TransactionId != owner.TransactionId ||
            !CryptographicOperations.FixedTimeEquals(Convert.FromHexString(live.Token), Convert.FromHexString(owner.Token)))
            throw new InvalidDataException("Native A rollback lost its original OS-verified worker and token.");
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrWhiteSpace(local) || !Path.IsPathFullyQualified(local))
            throw new InvalidDataException("Native A rollback user root is unavailable.");
        var install = Path.Combine(local, "Equinox Local");
        var program = Path.Combine(local, "Programs", "Equinox Local");
        var backup = Path.Combine(Path.GetDirectoryName(program)!, ".equinox-shell-backup-" + owner.TransactionId);
        var aShell = Path.Combine(install, "releases", stableVersion, "runtime", "shell");
        var bRelease = Path.Combine(install, "state", "main-update", "native-store", target, targetSha, "release");
        InspectionPhase = "native-integrated-a-rollback-recheck-both-physical-slots";
        CompareNativeTrees(aShell, backup);
        CompareNativeTrees(Path.Combine(bRelease, "runtime", "shell"), program);
        InspectOwnedMainNativeMessaging(install, bRelease);
        // The rejected B must still be the exact currently selected Main
        // source/native pair. Physical B hashes and its Native Messaging
        // launcher alone cannot authorize a stale or crossed rollback.
        var txRoot = Path.Combine(install, "state", "main-update");
        var sourcePointer = Path.Combine(txRoot, "current-source.conf");
        RequireNormalFile(sourcePointer);
        if (new FileInfo(sourcePointer).Length is < 15 or > 8192)
            throw new InvalidDataException("Native A rollback source pointer exceeds bound.");
        var sourceLines = File.ReadAllText(sourcePointer).Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(line => line.TrimEnd('\r')).ToArray();
        if (sourceLines.Length != 3 || sourceLines[0] != "schemaVersion=1" ||
            !Compare.Equals(sourceLines[1], "sourceRoot=" + Path.Combine(txRoot, "sources", targetSha)) ||
            sourceLines[2] != "sha=" + targetSha)
            throw new InvalidDataException("Native rollback source pointer is not exact running B.");
        using var nativePointer = ReadOwnedTransitionRecord(Path.Combine(txRoot, "current-native.json"), 8192);
        var selected = nativePointer.RootElement;
        RequireExactKeys(selected, ["schemaVersion", "channel", "sourceSha", "target", "runtimeContractSha256"]);
        if (selected.GetProperty("schemaVersion").GetInt32() != 1 ||
            selected.GetProperty("channel").GetString() != "main" ||
            selected.GetProperty("sourceSha").GetString() != targetSha ||
            selected.GetProperty("target").GetString() != target ||
            selected.GetProperty("runtimeContractSha256").GetString() !=
                state.GetProperty("targetRuntimeContractSha256").GetString())
            throw new InvalidDataException("Native rollback pointer is not exact running B release.");
        if (worker.HasExited || worker.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks ||
            !CryptographicOperations.FixedTimeEquals(original, SHA256.HashData(File.ReadAllBytes(journalPath))))
            throw new InvalidDataException("Native A rollback slot or owning journal changed during read-only admission.");
        var nonce = RandomNumberGenerator.GetBytes(32);
        endpoint.WriteAsync(nonce.AsMemory(), cutoff.Token).AsTask().GetAwaiter().GetResult();
        endpoint.FlushAsync(cutoff.Token).GetAwaiter().GetResult();
        var response = new byte[32];
        for (var offset = 0; offset < response.Length;)
        {
            var read = endpoint.ReadAsync(response.AsMemory(offset), cutoff.Token).AsTask().GetAwaiter().GetResult();
            if (read < 1) throw new InvalidDataException("Native rollback owner HMAC response was truncated.");
            offset += read;
        }
        var key = Convert.FromHexString(owner.Token);
        try
        {
            using var mac = new HMACSHA256(key);
            var expected = mac.ComputeHash(Encoding.ASCII.GetBytes(ABRollbackAdmissionDomain)
                .Concat(nonce).Concat(original).ToArray());
            if (!CryptographicOperations.FixedTimeEquals(expected, response))
                throw new InvalidDataException("Native rollback owner HMAC does not bind the exact restarted journal.");
        }
        finally { CryptographicOperations.ZeroMemory(key); }
        if (worker.HasExited || worker.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks ||
            !CryptographicOperations.FixedTimeEquals(original, SHA256.HashData(File.ReadAllBytes(journalPath))))
            throw new InvalidDataException("Native rollback owner or journal changed during authenticated grant.");
        // The original worker's authenticated failure report is NOT proof.
        // AFTER HMAC, the original Guardian itself rejects any live WPF or
        // observed healthy exact-B backend. No transition on healthy B.
        RequireOwnedIntegratedBExitedAndUnhealthy(owner, journalRoot, worker, targetSha);
        if (worker.HasExited || worker.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks ||
            !CryptographicOperations.FixedTimeEquals(original, SHA256.HashData(File.ReadAllBytes(journalPath))))
            throw new InvalidDataException("Original rollback worker or journal changed after OS B health decision.");
        InspectionPhase = "native-integrated-a-rollback-durable-start-only";
        WriteIntegratedOwnedNativeStage(owner, journalPath, "restarted", 4, "rollback_started", 5);
        endpoint.WriteByte((byte)'r');
        endpoint.FlushAsync(cutoff.Token).GetAwaiter().GetResult();
        InspectionPhase = "native-integrated-a-rollback-authorized-not-restored";
    }
}
