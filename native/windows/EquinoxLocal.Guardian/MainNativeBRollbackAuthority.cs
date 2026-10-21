using System.Diagnostics;
using System.Globalization;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    private const string BRollbackProofDomain = "equinox-local-guardian-b-rollback-authority-v1:";

    // Unexposed pilot. It does NOT authorize WPF shutdown, slot rename,
    // Native Messaging changes or update success. No public Guardian switch
    // may call this until real signed Windows owner/lease acceptance exists.
    private static void InspectOwnedNativeBRollbackWorkerAuthority()
    {
        InspectionPhase = "native-b-rollback-os-worker-admission";
        InspectOwnedNativeWorkerOsArguments();
        InspectOwnedNativeWorkerPipeProof();
        var owner = InspectOwnedNativeWorkerProcess();
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrWhiteSpace(local) || !Path.IsPathFullyQualified(local))
            throw new InvalidDataException("B rollback Guardian user root unavailable.");
        var journalRoot = Path.Combine(local, "Equinox Local", "state", "main-update", "guardian-journal");
        RequireNormalDirectory(journalRoot);
        var journalPath = Path.Combine(journalRoot, owner.TransactionId + ".json");
        RequireNormalFile(journalPath);
        using var journal = ReadOwnedTransitionRecord(journalPath, 8192);
        var record = journal.RootElement;
        RequireExactKeys(record, ["schemaVersion", "channel", "transactionId", "target", "currentSha", "targetSha",
            "receiptStartedAt", "previousNative", "targetRuntimeContractSha256", "stage", "sequence", "createdAt", "updatedAt"]);
        var sourceSha = record.GetProperty("targetSha").GetString() ?? "";
        if (record.GetProperty("schemaVersion").GetInt32() != 1 ||
            record.GetProperty("channel").GetString() != "main" ||
            record.GetProperty("transactionId").GetString() != owner.TransactionId ||
            !SourceShaPattern.IsMatch(sourceSha) ||
            record.GetProperty("stage").GetString() != "rollback_started" ||
            record.GetProperty("sequence").GetInt32() is < 1 or > 6)
            throw new InvalidDataException("B rollback native proof requires the exact rollback_started journal.");
        // The existing stable-A admission and HMAC are not valid for B.
        // This phase requires the installed SHA-addressed B and exact live WPF.
        InspectOwnedMainBRollbackPreflight(owner.TransactionId, sourceSha);
        var bytes = File.ReadAllBytes(journalPath);
        if (bytes.Length is < 2 or > 8192)
            throw new InvalidDataException("B rollback journal exceeds its bound.");
        var digest = SHA256.HashData(bytes);
        var handoffDigest = HashOwnedWorkerHandoff(journalRoot, owner.TransactionId);
        var lockPath = Path.Combine(journalRoot, "." + owner.TransactionId + ".rollback.writer-lock");
        var receiptPath = Path.Combine(journalRoot, owner.TransactionId + ".rollback-authority.json");
        if (File.Exists(receiptPath))
            throw new InvalidDataException("B rollback native proof was already recorded.");
        using var worker = Process.GetProcessById(owner.Pid);
        if (worker.HasExited || worker.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks)
            throw new InvalidDataException("B rollback native owner died before lease acquisition.");
        // Distinct exclusive rollback lease; never reclaim the prepared writer
        // or silently delete an orphan after a Guardian crash.
        using var lease = new FileStream(lockPath, FileMode.CreateNew, FileAccess.ReadWrite,
            FileShare.None, 4096, FileOptions.WriteThrough);
        var leaseRecord = Encoding.ASCII.GetBytes($"schemaVersion=1\ntransactionId={owner.TransactionId}\nworkerPid={owner.Pid}\nworkerStartTimeUtcTicks={owner.Ticks}\nguardianPid={Environment.ProcessId}\n");
        if (leaseRecord.Length > 512) throw new InvalidDataException("B rollback lease identity exceeds bound.");
        lease.Write(leaseRecord);
        lease.Flush(flushToDisk: true);
        // Fresh challenge, exact authenticated live kernel pipe client PID and
        // stage-separated HMAC over the ORIGINAL rollback_started journal.
        InspectionPhase = "native-b-rollback-worker-journal-hmac";
        using var listener = new NamedPipeServerStream("EquinoxLocalMainRollbackJournal-" + owner.TransactionId,
            PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(8));
        listener.WaitForConnectionAsync(deadline.Token).GetAwaiter().GetResult();
        if (!GetNamedPipeClientProcessId(listener.SafePipeHandle, out var clientPid) || clientPid != owner.Pid ||
            worker.HasExited || worker.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks)
            throw new InvalidDataException("B rollback journal client is not the original OS worker.");
        var nonce = RandomNumberGenerator.GetBytes(32);
        listener.WriteAsync(nonce.AsMemory(), deadline.Token).AsTask().GetAwaiter().GetResult();
        listener.FlushAsync(deadline.Token).GetAwaiter().GetResult();
        var response = new byte[32];
        for (var offset = 0; offset < response.Length;)
        {
            var received = listener.ReadAsync(response.AsMemory(offset), deadline.Token).AsTask().GetAwaiter().GetResult();
            if (received < 1) throw new InvalidDataException("B rollback nonce proof ended prematurely.");
            offset += received;
        }
        var key = Convert.FromHexString(owner.Token);
        try
        {
            var domain = Encoding.ASCII.GetBytes(BRollbackProofDomain);
            var message = new byte[domain.Length + nonce.Length + digest.Length];
            domain.CopyTo(message.AsSpan());
            nonce.CopyTo(message.AsSpan(domain.Length));
            digest.CopyTo(message.AsSpan(domain.Length + nonce.Length));
            if (!CryptographicOperations.FixedTimeEquals(HMACSHA256.HashData(key.AsSpan(), message.AsSpan()), response))
                throw new InvalidDataException("Independent B rollback journal proof failed.");
        }
        finally { CryptographicOperations.ZeroMemory(key); }
        if (worker.HasExited || worker.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks ||
            !CryptographicOperations.FixedTimeEquals(digest, SHA256.HashData(File.ReadAllBytes(journalPath))) ||
            !CryptographicOperations.FixedTimeEquals(handoffDigest, HashOwnedWorkerHandoff(journalRoot, owner.TransactionId)))
            throw new InvalidDataException("B rollback owner, journal or worker handoff changed after HMAC.");
        InspectOwnedMainBRollbackPreflight(owner.TransactionId, sourceSha);
        // CREATE_NEW, write-through and fsync. This sidecar is proof of the
        // read-only witness, NOT a shutdown receipt or permission to move B.
        using var receipt = new FileStream(receiptPath, FileMode.CreateNew, FileAccess.Write,
            FileShare.None, 4096, FileOptions.WriteThrough);
        using (var json = new Utf8JsonWriter(receipt))
        {
            json.WriteStartObject();
            json.WriteNumber("schemaVersion", 1);
            json.WriteString("transactionId", owner.TransactionId);
            json.WriteString("stage", "rollback_started");
            json.WriteNumber("sequence", record.GetProperty("sequence").GetInt32());
            json.WriteNumber("workerPid", owner.Pid);
            json.WriteString("workerStartTimeUtcTicks", owner.Ticks);
            json.WriteNumber("guardianPid", Environment.ProcessId);
            json.WriteString("journalSha256", Convert.ToHexStringLower(digest));
            json.WriteString("handoffSha256", Convert.ToHexStringLower(handoffDigest));
            json.WriteEndObject();
            json.Flush();
        }
        receipt.Flush(flushToDisk: true);
        InspectionPhase = "native-b-rollback-authority-recorded-no-wpf-mutation";
        // The writer-lock remains durable after return; independent recovery
        // must prove both native owners dead before any future B operation.
    }
}
