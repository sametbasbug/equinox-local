using Microsoft.Win32.SafeHandles;
using System.Diagnostics;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
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
    // 0 = read-only independently authenticated ORIGINAL live Guardian session
    //     (every valid original journal generation, including prepared/0)
    // 1 = graceful native A shutdown at native_staged
    // 2 = graceful native B shutdown at rollback_started
    // 3 = sustained native B WPF OS identity at restarted/healthy
    // 4 = sustained restored A WPF OS identity at rollback_native_restored/rollback_healthy
    // 5..14 = READ-ONLY signed physical milestone evidence for the ONE JS journal
    // writer. Every request verifies CURRENT stage; only JS may advance it.
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
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(35));
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
            stage is not ("prepared" or "native_staged" or "shell_stopped" or
                "switched" or "rollback_started" or
                "restarted" or "healthy" or "committed" or
                "rollback_native_restored" or "rollback_healthy" or "rolled_back") ||
            sequence is < 0 or > 9 ||
            (stage == "prepared" && sequence != 0) ||
            (stage == "shell_stopped" && sequence != 2) ||
            (stage == "switched" && sequence != 3))
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
        if (!((opcode == 0) ||
              (opcode == 1 && stage == "native_staged" && sequence == 1) ||
              (opcode == 2 && stage == "rollback_started" && sequence is >= 1 and <= 6) ||
              (opcode == 3 && ((stage == "restarted" && sequence == 4) ||
                               (stage == "healthy" && sequence == 5) ||
                               (stage == "committed" && sequence == 6))) ||
              (opcode == 4 && ((stage == "rollback_native_restored" && sequence is >= 2 and <= 7) ||
                               (stage == "rollback_healthy" && sequence is >= 3 and <= 8) ||
                               (stage == "rolled_back" && sequence is >= 4 and <= 9))) ||
              (opcode == 5 && stage == "prepared" && sequence == 0) ||
              (opcode == 6 && stage == "native_staged" && sequence == 1) ||
              (opcode == 7 && stage == "shell_stopped" && sequence == 2) ||
              (opcode == 8 && stage == "switched" && sequence == 3) ||
              (opcode == 9 && stage == "restarted" && sequence == 4) ||
              (opcode == 10 && stage == "healthy" && sequence == 5) ||
              (opcode == 11 && ((stage == "prepared" && sequence == 0) ||
                               (stage == "native_staged" && sequence == 1) ||
                               (stage == "shell_stopped" && sequence == 2) ||
                               (stage == "switched" && sequence == 3) ||
                               (stage == "restarted" && sequence == 4) ||
                               (stage == "healthy" && sequence == 5))) ||
              (opcode == 12 && stage == "rollback_started" && sequence is >= 1 and <= 6) ||
              (opcode == 13 && stage == "rollback_native_restored" && sequence is >= 2 and <= 7) ||
              (opcode == 14 && stage == "rollback_healthy" && sequence is >= 3 and <= 8)))
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
        if (opcode == 0)
        {
            // Fresh nonce + exact journal + kernel client PID and original
            // Guardian NTFS File ID ONLY. Never claim a WPF health/stop,
            // native byte switch or independently completed JS milestone.
            InspectionPhase = "native-session-live-original-os-owner";
        }
        else if (opcode == 1)
        {
            // A forged native_staged marker is NOT evidence of a loadable B.
            // Use EXACTLY the same full SHA-addressed Git/native manifest,
            // release and byte fingerprint gate as the original prepared
            // writer, before allowing the OS-owned WPF A to exit.
            InspectExactImmutableNativeBPayload(owner, j);
            QuiesceOwnedStableShell(owner, root, worker, continuousNativeSession: true);
        }
        else if (opcode == 2)
            QuiesceOwnedMainBRollbackShell(owner, root, worker, digest, handoffDigest,
                j.GetProperty("targetSha").GetString() ?? "", continuousNativeSession: true);
        else if (opcode is 3 or 4)
            InspectOwnedLiveNativeShellSustained(owner, j, opcode == 3, worker);
        else
            InspectOriginalGuardianPhysicalMilestone(owner, root, j, digest, opcode, worker);

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
        InspectionPhase = opcode == 0 ? "native-session-original-os-owner-confirmed"
            : opcode is 3 or 4 ? "native-session-sustained-os-wpf-identity-confirmed"
            : opcode is >= 5 and <= 14 ? "native-session-physical-milestone-verified"
            : "native-session-stage-wpf-exit-confirmed";
    }

    private static void InspectOriginalGuardianPhysicalMilestone(
        OwnedWorkerClaim owner, string root, JsonElement journal, byte[] digest,
        byte opcode, Process worker)
    {
        // Same ORIGINAL signed Guardian, worker PID, journal generation and
        // live OS File-ID handle as the four existing WPF stage operations.
        // No milestone witness may advance the JS journal or mutate slots.
        InspectionPhase = "native-session-physical-milestone";
        if (opcode == 5)
        {
            InspectExactImmutableNativeBPayload(owner, journal);
            return;
        }
        if (opcode == 6)
        {
            // Original signed Guardian op1 already observed old A WPF's
            // kernel pipe server PID, authenticated its SID/LUID and waited
            // for actual graceful exit before durably writing this receipt.
            var file = Path.Combine(root, owner.TransactionId + ".stable-shell-quiesce.json");
            using var document = ReadOwnedTransitionRecord(file, 8192);
            var proof = document.RootElement;
            RequireExactKeys(proof, ["schemaVersion", "transactionId", "disposition", "shellPid",
                "shellStartTimeUtcTicks", "workerPid", "workerStartTimeUtcTicks", "guardianPid",
                "preparedJournalSha256"]);
            if (proof.GetProperty("schemaVersion").GetInt32() != 1 ||
                proof.GetProperty("transactionId").GetString() != owner.TransactionId ||
                proof.GetProperty("disposition").GetString() != "stable-shell-quiesced-only" ||
                proof.GetProperty("workerPid").GetInt32() != owner.Pid ||
                proof.GetProperty("workerStartTimeUtcTicks").GetString() != owner.Ticks ||
                proof.GetProperty("guardianPid").GetInt32() != Environment.ProcessId ||
                !CryptographicOperations.FixedTimeEquals(
                    Encoding.ASCII.GetBytes(proof.GetProperty("preparedJournalSha256").GetString() ?? ""),
                    Encoding.ASCII.GetBytes(Convert.ToHexStringLower(digest))))
                throw new InvalidDataException("Original A WPF exit has no durable exact Guardian OS proof.");
            return;
        }
        if (opcode == 7 || opcode == 12)
        {
            // After physical A/B rename or B→A restore, inspect installed
            // executable BYTE FOR BYTE against the original immutable slot,
            // exact source/manifest and real HKCU Chrome Native Messaging.
            // This is NOT a claimed JS callback nor a synthetic stage receipt.
            InspectOwnedNativeShellPayload(owner, journal, targetB: opcode == 7);
            return;
        }
        if (opcode is 8 or 9 or 10 or 13 or 14)
        {
            InspectOwnedLiveNativeShellSustained(owner, journal, opcode is 8 or 9 or 10, worker);
            return;
        }
        if (opcode == 11)
        {
            // rollback_started only records a durable INTENT, not evidence B
            // is stopped. Actual B must separately undergo signed opcode2.
            InspectionPhase = "native-session-authenticated-rollback-intent";
            return;
        }
        throw new InvalidDataException("Native physical milestone opcode is not allowed.");
    }

    // A status HTTP 200 is NOT proof that the installed signed WPF shell
    // still exists, belongs to the same interactive logon or owns its OS pipe.
    // The caller independently verifies exact Main SHA/health HTTP; this
    // routine pins the native WPF OS identity for two separated observations.
    private static (string Exe, string OriginalShell, string InstalledShell) InspectOwnedNativeShellPayload(OwnedWorkerClaim owner, JsonElement journal, bool targetB)
    {
        InspectionPhase = targetB ? "native-milestone-exact-installed-b-bytes" : "native-milestone-exact-restored-a-bytes";
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var install = Path.Combine(local, "Equinox Local");
        var tx = Path.Combine(install, "state", "main-update");
        var cpu = RuntimeInformation.ProcessArchitecture switch
        {
            Architecture.X64 => "win32-x64",
            Architecture.Arm64 => "win32-arm64",
            _ => throw new PlatformNotSupportedException("Unsupported native WPF health CPU."),
        };
        if (journal.GetProperty("target").GetString() != cpu ||
            journal.GetProperty("transactionId").GetString() != owner.TransactionId)
            throw new InvalidDataException("Native shell health differs from original Guardian worker and CPU.");

        string release;
        if (targetB)
        {
            // The exact B immutable full payload remains required after the
            // physical switch, not just before stopping old A.
            InspectExactImmutableNativeBPayload(owner, journal);
            var sha = journal.GetProperty("targetSha").GetString() ?? "";
            release = Path.Combine(tx, "native-store", cpu, sha, "release");
            InspectOwnedMainNativeMessaging(install, release);
        }
        else
        {
            var previous = journal.GetProperty("previousNative");
            var kind = previous.GetProperty("kind").GetString();
            if (kind == "stable")
            {
                var version = previous.GetProperty("version").GetString() ?? "";
                if (!VersionRegex().IsMatch(version))
                    throw new InvalidDataException("Restored A Stable version is not original signed native.");
                using var pointer = ReadOwnedTransitionRecord(Path.Combine(install, "current-version.json"), 4096);
                if (pointer.RootElement.GetProperty("version").GetString() != version ||
                    pointer.RootElement.GetProperty("target").GetString() != cpu)
                    throw new InvalidDataException("Restored native A Stable pointer differs from original.");
                release = Path.Combine(install, "releases", version);
                // Rollback must restore the FULL original signed Stable
                // baseline, not only its version pointer and WPF filename.
                InspectBaseline(allowActiveOrphanForReconciliation: true);
            }
            else if (kind == "main")
            {
                var sha = previous.GetProperty("sourceSha").GetString() ?? "";
                var contract = previous.GetProperty("runtimeContractSha256").GetString() ?? "";
                if (!SourceShaPattern.IsMatch(sha) || !DigestPattern.IsMatch(contract) ||
                    journal.GetProperty("currentSha").GetString() != sha)
                    throw new InvalidDataException("Restored A Main SHA is not original.");
                using var pointer = ReadOwnedTransitionRecord(Path.Combine(tx, "current-native.json"), 8192);
                if (pointer.RootElement.GetProperty("sourceSha").GetString() != sha ||
                    pointer.RootElement.GetProperty("runtimeContractSha256").GetString() != contract ||
                    pointer.RootElement.GetProperty("target").GetString() != cpu)
                    throw new InvalidDataException("Restored native A Main pointer differs from original.");
                release = Path.Combine(tx, "native-store", cpu, sha, "release");
                InspectOwnedMainGit(install, cpu, Path.Combine(tx, "sources", sha), sha);
                InspectOwnedMainNativeMessaging(install, release);
            }
            else throw new InvalidDataException("Restored native A kind is foreign.");
        }

        var originalShell = Path.Combine(release, "runtime", "shell");
        var installedShell = Path.Combine(local, "Programs", "Equinox Local");
        RequireNormalDirectory(originalShell);
        RequireNormalDirectory(installedShell);
        CompareNativeTrees(originalShell, installedShell);
        var exe = Path.Combine(installedShell, "EquinoxLocal.exe");
        RequireNormalFile(exe);
        return (exe, originalShell, installedShell);
    }

    private static void InspectOwnedLiveNativeShellSustained(OwnedWorkerClaim owner,
        JsonElement journal, bool targetB, Process worker)
    {
        InspectionPhase = "native-session-sustained-wpf-native-identity";
        var payload = InspectOwnedNativeShellPayload(owner, journal, targetB);
        using var shell = FindSingleOwnedStableShell(payload.Exe);
        var pid = shell.Id;
        var birth = shell.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture);
        if (shell.HasExited || shell.SessionId != Process.GetCurrentProcess().SessionId ||
            pid == owner.Pid || worker.HasExited ||
            !OpenProcessToken(shell.Handle, TokenQuery, out var token))
            throw new InvalidDataException("Native WPF health process has no independently owned OS identity.");
        using (token)
        using (var shellIdentity = new WindowsIdentity(token.DangerousGetHandle()))
        using (var guardianIdentity = WindowsIdentity.GetCurrent())
        {
            if (shellIdentity.User is null || guardianIdentity.User is null ||
                !shellIdentity.User.Equals(guardianIdentity.User) ||
                ReadWindowsLogonAuthenticationId(token) !=
                    ReadWindowsLogonAuthenticationId(guardianIdentity.AccessToken))
                throw new InvalidDataException("Native WPF health shell is not in original Windows user logon.");
        }
        for (var observation = 0; observation < 2; observation++)
        {
            InspectionPhase = "native-session-sustained-wpf-kernel-pipe";
            using (var pipe = new NamedPipeClientStream(".", "EquinoxLocal.WindowsShell.Reopen",
                PipeDirection.InOut, PipeOptions.Asynchronous))
            {
                pipe.Connect(2500);
                if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle, out var serverPid) ||
                    serverPid != pid || shell.HasExited ||
                    shell.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != birth ||
                    worker.HasExited ||
                    worker.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks)
                    throw new InvalidDataException("Native WPF health is not the same original Windows OS process.");
            }
            // The process must remain running after the exact OS pipe and
            // installed bytes were measured, never a single historical PID.
            if (observation == 0) Thread.Sleep(1500);
        }
        CompareNativeTrees(payload.OriginalShell, payload.InstalledShell);
        if (shell.HasExited ||
            shell.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != birth)
            throw new InvalidDataException("Native WPF health shell changed since sustained observations.");
        InspectionPhase = "native-session-sustained-wpf-os-proof-only";
    }
}
