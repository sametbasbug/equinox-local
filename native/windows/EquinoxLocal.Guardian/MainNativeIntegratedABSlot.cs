using System.Diagnostics;
using System.Globalization;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    private const string ABSlotDomain = "equinox-local-guardian-ab-slot-v1:";

    // The Guardian authorizes the one existing shared JS A/B slot primitive,
    // but does NOT implement a competing native filesystem update engine.
    // Kernel PID + ephemeral HMAC authenticate the existing detached worker;
    // after its swap acknowledgement, Guardian independently hashes both
    // physical trees. Lack of proof preserves the exclusive orphan lease.
    private static void RequestOwnedIntegratedABSlotSwap(
        OwnedWorkerClaim owner, string journalRoot, Process worker, string stagedRelease)
    {
        InspectionPhase = "native-integrated-ab-slot-owned-physical";
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var install = Path.Combine(local, "Equinox Local");
        var root = Path.Combine(install, "state", "main-update");
        var journalPath = Path.Combine(journalRoot, owner.TransactionId + ".json");
        using var journal = ReadOwnedTransitionRecord(journalPath, 8192);
        if (journal.RootElement.GetProperty("transactionId").GetString() != owner.TransactionId ||
            journal.RootElement.GetProperty("stage").GetString() != "shell_stopped" ||
            journal.RootElement.GetProperty("sequence").GetInt32() != 2)
            throw new InvalidDataException("Guardian cannot authorize slot switch before real journaled WPF exit.");
        var originalSha = SHA256.HashData(File.ReadAllBytes(journalPath));
        var stableVersion = journal.RootElement.GetProperty("previousNative").GetProperty("version").GetString() ?? "";
        if (!VersionRegex().IsMatch(stableVersion)) throw new InvalidDataException("Original Stable A version is foreign.");
        var previousShell = Path.Combine(install, "releases", stableVersion, "runtime", "shell");
        var newShell = Path.Combine(stagedRelease, "runtime", "shell");
        var program = Path.Combine(local, "Programs", "Equinox Local");
        var backup = Path.Combine(Path.GetDirectoryName(program)!, ".equinox-shell-backup-" + owner.TransactionId);
        if (Directory.Exists(backup) || File.Exists(backup))
            throw new InvalidDataException("A/B slot swap sees an unreconciled previous A backup.");
        RequireNormalDirectory(program);
        RequireNormalDirectory(previousShell);
        RequireNormalDirectory(newShell);
        CompareNativeTrees(previousShell, program);
        if (!File.Exists(Path.Combine(journalRoot, owner.TransactionId + ".stable-shell-quiesce.json")))
            throw new InvalidDataException("A/B slot switch lacks independent actual WPF exit evidence.");

        using var endpoint = new NamedPipeServerStream("EquinoxLocalMainAB-" + owner.TransactionId,
            PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
        using var cutoff = new CancellationTokenSource(TimeSpan.FromSeconds(150));
        InspectionPhase = "native-integrated-ab-slot-wait-exact-worker";
        endpoint.WaitForConnectionAsync(cutoff.Token).GetAwaiter().GetResult();
        if (!GetNamedPipeClientProcessId(endpoint.SafePipeHandle, out var clientPid) || clientPid != owner.Pid ||
            worker.HasExited || worker.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks)
            throw new InvalidDataException("A/B slot IPC is not connected to the admitted live product worker.");
        var nonce = RandomNumberGenerator.GetBytes(32);
        endpoint.WriteAsync(nonce.AsMemory(), cutoff.Token).AsTask().GetAwaiter().GetResult();
        endpoint.FlushAsync(cutoff.Token).GetAwaiter().GetResult();
        var response = new byte[32];
        for (var received = 0; received < response.Length;)
        {
            var size = endpoint.ReadAsync(response.AsMemory(received), cutoff.Token).AsTask().GetAwaiter().GetResult();
            if (size < 1) throw new InvalidDataException("A/B slot worker proof disconnected during nonce admission.");
            received += size;
        }
        var secret = Convert.FromHexString(owner.Token);
        try
        {
            using var mac = new HMACSHA256(secret);
            var expected = mac.ComputeHash(Encoding.ASCII.GetBytes(ABSlotDomain)
                .Concat(nonce).Concat(originalSha).ToArray());
            if (!CryptographicOperations.FixedTimeEquals(response, expected))
                throw new InvalidDataException("A/B slot worker HMAC did not match the exact journal generation.");
        }
        finally { CryptographicOperations.ZeroMemory(secret); }
        if (!CryptographicOperations.FixedTimeEquals(originalSha, SHA256.HashData(File.ReadAllBytes(journalPath))))
            throw new InvalidDataException("Guardian A/B slot journal mutated during IPC admission.");
        InspectionPhase = "native-integrated-ab-slot-authorize-existing-engine";
        // 'S' is the ONLY command. No generic path, operation or target comes
        // from the worker; all identities derive from the admitted transaction.
        endpoint.WriteByte((byte)'S');
        endpoint.FlushAsync(cutoff.Token).GetAwaiter().GetResult();
        var completion = new byte[1];
        var count = endpoint.ReadAsync(completion.AsMemory(), cutoff.Token).AsTask().GetAwaiter().GetResult();
        if (count != 1 || completion[0] != (byte)'s')
            throw new InvalidDataException("Existing JS native A/B slot engine did not acknowledge its physical switch.");
        InspectionPhase = "native-integrated-ab-slot-observe-physical-b-and-retained-a";
        if (worker.HasExited || worker.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks ||
            !CryptographicOperations.FixedTimeEquals(originalSha, SHA256.HashData(File.ReadAllBytes(journalPath))))
            throw new InvalidDataException("Worker or journal changed during native A/B physical swap.");
        CompareNativeTrees(newShell, program);
        CompareNativeTrees(previousShell, backup);
        InspectionPhase = "native-integrated-ab-owned-native-messaging-b";
        // The worker reuses the exact existing JS Chrome registration routine;
        // Guardian audits the real HKCU registry and immutable B launcher.
        endpoint.WriteByte((byte)'M');
        endpoint.FlushAsync(cutoff.Token).GetAwaiter().GetResult();
        var registered = new byte[1];
        if (endpoint.ReadAsync(registered.AsMemory(), cutoff.Token).AsTask().GetAwaiter().GetResult() != 1 ||
            registered[0] != (byte)'m')
            throw new InvalidDataException("Product worker did not acknowledge the fixed native messaging owner transition.");
        InspectOwnedMainNativeMessaging(install, stagedRelease);
        if (!CryptographicOperations.FixedTimeEquals(originalSha, SHA256.HashData(File.ReadAllBytes(journalPath))))
            throw new InvalidDataException("Native Messaging B changed the transaction journal before native verification.");
        WriteIntegratedOwnedNativeStage(owner, journalPath, "shell_stopped", 2, "switched", 3);
        InspectionPhase = "native-integrated-ab-slot-b-installed-messaging-b-a-retained";
        // Still no B launch / health / commit: exact A must be retained until
        // new native WPF and Native Messaging B are sustained and the Main
        // receipt independently validates success. Crash stays fail-closed.
    }
}
