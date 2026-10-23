using Microsoft.Win32.SafeHandles;
using System.Diagnostics;
using System.Globalization;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    private const string JournalProofDomain = "equinox-local-guardian-journal-authority-v1:";

    // Only bind already independently audited, exact product-owned handoff
    // bytes. Keep the random worker bearer token OUT of durable sidecars.
    // A changed token, executable path or owner record cannot masquerade as
    // the same Guardian-attested prepared transaction after a crash.
    private static byte[] HashOwnedWorkerHandoff(string journalRoot, string transactionId)
    {
        var transactionRoot = Path.GetDirectoryName(journalRoot) ??
            throw new InvalidDataException("Native journal has no transaction root.");
        var handoffRoot = Path.Combine(transactionRoot, "handoff");
        RequireNormalDirectory(handoffRoot);
        var path = Path.Combine(handoffRoot, transactionId + ".windows-worker.json");
        RequireNormalFile(path);
        // Hash the exact handle whose length was checked. FileInfo.Length +
        // File.ReadAllBytes would reopen a mutable pathname between the bound
        // and the worker-identity digest; Windows read sharing bars an
        // incompatible write/rename while the digest is being computed.
        using var handle = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (handle.Length is < 2 or > 8192)
            throw new InvalidDataException("Native worker handoff bytes exceed the bounded ownership record.");
        return SHA256.HashData(handle);
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint clientPid);

    // Only a read-only prepared-stage sidecar. A real native milestone writer
    // will separately verify WPF/NativeMessaging/slot evidence in later work.
    // Failure keeps the exclusive lease marker for supervised reconciliation.
    private static void RecordNativeJournalWorkerAuthority(OwnedWorkerClaim owner, string root, Process worker, bool recordPreparedAbort = false)
    {
        InspectionPhase = "native-journal-authority-prepared-only";
        var journalPath = Path.Combine(root, owner.TransactionId + ".json");
        RequireNormalFile(journalPath);
        using var journal = ReadOwnedTransitionRecord(journalPath, 8192);
        if (journal.RootElement.GetProperty("transactionId").GetString() != owner.TransactionId ||
            journal.RootElement.GetProperty("stage").GetString() != "prepared" ||
            journal.RootElement.GetProperty("sequence").GetInt32() != 0)
            throw new InvalidDataException("Guardian authority proof requires the exact prepared journal generation.");
        var journalBytes = File.ReadAllBytes(journalPath);
        if (journalBytes.Length < 2 || journalBytes.Length > 8192)
            throw new InvalidDataException("Native journal generation exceeds its bound.");
        var digest = SHA256.HashData(journalBytes);
        var handoffDigest = HashOwnedWorkerHandoff(root, owner.TransactionId);
        var dest = Path.Combine(root, owner.TransactionId + ".native-authority.json");
        if (File.Exists(dest)) throw new InvalidDataException("Native journal authority proof already exists; replay denied.");
        var pipeName = "EquinoxLocalMainJournal-" + owner.TransactionId;
        using var listener = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1,
            PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(8));
        InspectionPhase = "native-journal-authority-wait-exact-worker";
        listener.WaitForConnectionAsync(deadline.Token).GetAwaiter().GetResult();
        if (!GetNamedPipeClientProcessId(listener.SafePipeHandle, out var clientPid) || clientPid != owner.Pid ||
            worker.HasExited || worker.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks)
            throw new InvalidDataException("Journal authority named pipe client is not the audited live worker.");
        var nonce = RandomNumberGenerator.GetBytes(32);
        listener.WriteAsync(nonce.AsMemory(), deadline.Token).AsTask().GetAwaiter().GetResult();
        listener.FlushAsync(deadline.Token).GetAwaiter().GetResult();
        var response = new byte[32];
        for (var offset = 0; offset < response.Length;)
        {
            var count = listener.ReadAsync(response.AsMemory(offset), deadline.Token).AsTask().GetAwaiter().GetResult();
            if (count < 1) throw new InvalidDataException("Journal authority nonce response ended prematurely.");
            offset += count;
        }
        var key = Convert.FromHexString(owner.Token);
        try
        {
            var domain = Encoding.ASCII.GetBytes(JournalProofDomain);
            var message = new byte[domain.Length + nonce.Length + digest.Length];
            domain.CopyTo(message.AsSpan());
            nonce.CopyTo(message.AsSpan(domain.Length));
            digest.CopyTo(message.AsSpan(domain.Length + nonce.Length));
            var expected = HMACSHA256.HashData(key.AsSpan(), message.AsSpan());
            if (!CryptographicOperations.FixedTimeEquals(expected, response))
                throw new InvalidDataException("Live worker journal authority HMAC proof is invalid.");
        }
        finally { CryptographicOperations.ZeroMemory(key); }
        if (worker.HasExited || worker.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks)
            throw new InvalidDataException("Native journal worker changed after HMAC proof.");
        // Never accept a journal generation that changed during the handshake.
        if (!CryptographicOperations.FixedTimeEquals(digest, SHA256.HashData(File.ReadAllBytes(journalPath))))
            throw new InvalidDataException("Native journal generation changed during worker authentication.");
        if (!CryptographicOperations.FixedTimeEquals(handoffDigest, HashOwnedWorkerHandoff(root, owner.TransactionId)))
            throw new InvalidDataException("Native worker handoff changed during live Guardian authorization.");
        InspectionPhase = "native-journal-authority-durable-prepared-attestation";
        // CREATE_NEW + write-through: a duplicate proof cannot silently replace
        // an earlier one. Crash leaves either an orphan writer lease or this
        // durable sidecar, both of which require explicit native reconciliation.
        // No process may read an incomplete proof while the independent
        // Guardian is writing it. Verify the durable record only after its
        // owner has exited, never by granting a second writer the handle.
        using var fd = new FileStream(dest, FileMode.CreateNew, FileAccess.Write,
            FileShare.None, 4096, FileOptions.WriteThrough);
        // Guardian is published trimmed/single-file. Write the nine fixed
        // fields directly; anonymous-object reflection serialization is not
        // reliable after IL trimming. A partial create-only record still
        // fails closed until the durable owner lock is reconciled.
        using (var writer = new Utf8JsonWriter(fd))
        {
            writer.WriteStartObject();
            writer.WriteNumber("schemaVersion", 1);
            writer.WriteString("transactionId", owner.TransactionId);
            writer.WriteString("stage", "prepared");
            writer.WriteNumber("sequence", 0);
            writer.WriteNumber("workerPid", owner.Pid);
            writer.WriteString("workerStartTimeUtcTicks", owner.Ticks);
            writer.WriteNumber("guardianPid", Environment.ProcessId);
            writer.WriteString("journalSha256", Convert.ToHexStringLower(digest));
            writer.WriteString("handoffSha256", Convert.ToHexStringLower(handoffDigest));
            writer.WriteEndObject();
            writer.Flush();
        }
        fd.Flush(flushToDisk: true);
        InspectionPhase = "native-journal-authority-proof-durable";
        if (recordPreparedAbort)
            WriteNativeJournalPreparedAbort(owner, journalPath, journalBytes, digest);
    }
}
