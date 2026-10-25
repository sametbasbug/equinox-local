using Microsoft.Win32.SafeHandles;
using System.Diagnostics;
using System.Globalization;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    // SAME pinned signed Guardian OS process and original worker HMAC.
    // No new CLI, service, journal writer or independently spawnable agent.
    // 1 = graceful native A shutdown at native_staged
    // 2 = graceful native B shutdown at rollback_started
    private const string SessionProofDomain = "equinox-local-guardian-native-stage-v1:";
    private static void HandleOneOwnedGuardianSessionRequest(OwnedWorkerClaim owner, string root,
        Process worker, SafeFileHandle originalGuardian)
    {
        using var server = new NamedPipeServerStream("EquinoxLocalMainSession-" + owner.TransactionId,
            PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
        using var acceptDeadline = new CancellationTokenSource(TimeSpan.FromMilliseconds(170));
        try { server.WaitForConnectionAsync(acceptDeadline.Token).GetAwaiter().GetResult(); }
        catch (OperationCanceledException) { return; }

        InspectionPhase = "native-session-exact-worker-stage-hmac";
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(8));
        if (!GetNamedPipeClientProcessId(server.SafePipeHandle, out var pid) ||
            pid != owner.Pid || worker.HasExited ||
            worker.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks)
            throw new InvalidDataException("Native session pipe is not the exact original kernel worker.");
        // Prove the current journal generation BEFORE a side effect. A
        // prepared-stage HMAC may NEVER be replayed to stop native B.
        var journalFile = Path.Combine(root, owner.TransactionId + ".json");
        using var journalHandle = new FileStream(journalFile, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (journalHandle.Length is < 2 or > 8192)
            throw new InvalidDataException("Native session journal exceeds bounds.");
        using var journalDoc = JsonDocument.Parse(journalHandle);
        var j = journalDoc.RootElement;
        RequireExactKeys(j, ["schemaVersion", "channel", "transactionId", "target", "currentSha",
            "targetSha", "receiptStartedAt", "previousNative", "targetRuntimeContractSha256",
            "stage", "sequence", "createdAt", "updatedAt"]);
        var stage = j.GetProperty("stage").GetString();
        var sequence = j.GetProperty("sequence").GetInt32();
        if (j.GetProperty("schemaVersion").GetInt32() != 1 ||
            j.GetProperty("channel").GetString() != "main" ||
            j.GetProperty("transactionId").GetString() != owner.TransactionId ||
            stage is not ("native_staged" or "rollback_started") ||
            sequence is < 1 or > 6)
            throw new InvalidDataException("Native session request has no authorized A/B stage.");

        journalHandle.Position = 0;
        var digest = SHA256.HashData(journalHandle);
        var handoffDigest = HashOwnedWorkerHandoff(root, owner.TransactionId);
        VerifyPinnedNativeGuardianFile(originalGuardian);
        var nonce = RandomNumberGenerator.GetBytes(32);
        server.WriteAsync(nonce.AsMemory(), deadline.Token).AsTask().GetAwaiter().GetResult();
        server.FlushAsync(deadline.Token).GetAwaiter().GetResult();
        var reply = new byte[33]; // exact opcode + HMAC, never arbitrary JSON
        for (var offset = 0; offset < reply.Length;)
        {
            var count = server.ReadAsync(reply.AsMemory(offset), deadline.Token).AsTask().GetAwaiter().GetResult();
            if (count < 1) throw new InvalidDataException("Native stage request ended prematurely.");
            offset += count;
        }
        var opcode = reply[0];
        if (!((opcode == 1 && stage == "native_staged" && sequence == 1) ||
              (opcode == 2 && stage == "rollback_started" && sequence is >= 1 and <= 6)))
            throw new InvalidDataException("Native stage opcode does not match exact journal generation.");

        var key = Convert.FromHexString(owner.Token);
        try
        {
            var domain = Encoding.ASCII.GetBytes(SessionProofDomain);
            var message = new byte[domain.Length + 1 + nonce.Length + digest.Length];
            domain.CopyTo(message.AsSpan());
            message[domain.Length] = opcode;
            nonce.CopyTo(message.AsSpan(domain.Length + 1));
            digest.CopyTo(message.AsSpan(domain.Length + 1 + nonce.Length));
            var mac = HMACSHA256.HashData(key.AsSpan(), message.AsSpan());
            if (!CryptographicOperations.FixedTimeEquals(mac, reply.AsSpan(1)))
                throw new InvalidDataException("Native stage worker HMAC is invalid.");
        }
        finally { CryptographicOperations.ZeroMemory(key); }

        if (worker.HasExited ||
            worker.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks ||
            !CryptographicOperations.FixedTimeEquals(digest, HashPinnedBRollbackJournal(journalHandle)) ||
            !CryptographicOperations.FixedTimeEquals(handoffDigest, HashOwnedWorkerHandoff(root, owner.TransactionId)))
            throw new InvalidDataException("Native journal/handoff changed during live stage authorization.");

        // Existing exact OS kernel WPF PID/creation-time/SID/LUID and WPF
        // named-pipe server PID/actual graceful exit checks own the effects.
        // Nothing here swaps native bytes or writes Main journal transitions.
        InspectionPhase = "native-session-authorized-wpf-side-effect";
        if (opcode == 1)
        {
            // A forged native_staged marker is NOT evidence of a loadable B.
            // Use EXACTLY the same full SHA-addressed Git/native manifest,
            // release and byte fingerprint gate as the original prepared
            // writer, before allowing the OS-owned WPF A to exit.
            InspectExactImmutableNativeBPayload(owner, j);
            QuiesceOwnedStableShell(owner, root, worker, continuousNativeSession: true);
        }
        else
            QuiesceOwnedMainBRollbackShell(owner, root, worker, digest, handoffDigest,
                j.GetProperty("targetSha").GetString() ?? "", continuousNativeSession: true);

        VerifyPinnedNativeGuardianFile(originalGuardian);
        if (worker.HasExited || !CryptographicOperations.FixedTimeEquals(
                digest, HashPinnedBRollbackJournal(journalHandle)))
            throw new InvalidDataException("Original native journal changed during signed WPF shutdown.");
        // Close the pinned read-only journal BEFORE acknowledging success;
        // otherwise the sole JS writer could race this open FILE_SHARE_READ
        // handle while attempting the next atomic stage rename on Windows.
        journalHandle.Dispose();
        server.WriteByte(1);
        server.Flush();
        InspectionPhase = "native-session-stage-wpf-exit-confirmed";
    }
}
