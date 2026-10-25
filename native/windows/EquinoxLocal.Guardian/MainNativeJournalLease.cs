using System.Diagnostics;
using System.Globalization;
using System.Text;
using Microsoft.Win32.SafeHandles;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    // First independent native OS-owned writer lease, NOT a journal milestone
    // writer and NOT permission to stop WPF, swap A/B or relaunch anything.
    // The persistent marker is intentionally never deleted automatically:
    // a dead native owner needs independent receipt + filesystem reconciliation.
    private static void HoldOwnedNativeJournalLease(bool acceptAuthorityProof = false, bool recordPreparedAbort = false, bool quiesceStableShell = false, bool recordNativeStaged = false, bool cancelBeforeSwitch = false)
    {
        InspectionPhase = "native-journal-lease-preflight";
        InspectOwnedNativeWorkerOsArguments();
        InspectOwnedNativeWorkerPipeProof();
        var owner = InspectOwnedNativeWorkerProcess();
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrWhiteSpace(local) || !Path.IsPathFullyQualified(local))
            throw new InvalidDataException("Windows native journal lease has no canonical user root.");
        var root = Path.Combine(local, "Equinox Local", "state", "main-update", "guardian-journal");
        RequireNormalDirectory(root);
        // Existing authenticated authority mode is the one continuous OS
        // Guardian session. It must NOT take the JS journal's .writer-lock:
        // that lock has exactly one writer, the transaction journal. Other
        // historical one-shot native journal mutation modes still hold the
        // exclusive writer-lock and cannot run beside the JS writer.
        var continuousSession = acceptAuthorityProof && !recordPreparedAbort &&
            !recordNativeStaged && !quiesceStableShell && !cancelBeforeSwitch;
        var leasePath = Path.Combine(root, "." + owner.TransactionId +
            (continuousSession ? ".guardian-session-lock" : ".writer-lock"));
        if (continuousSession && (File.Exists(Path.Combine(root, "." + owner.TransactionId + ".writer-lock")) ||
            Directory.Exists(Path.Combine(root, "." + owner.TransactionId + ".writer-lock"))))
            throw new InvalidDataException("Orphan or active JS journal writer blocks independent Guardian session.");
        using var originalGuardian = continuousSession ? PinNativeGuardianFileForSession() : null;
        using var worker = Process.GetProcessById(owner.Pid);
        if (worker.HasExited || worker.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks)
            throw new InvalidDataException("Windows journal lease worker exited during admission.");
        InspectionPhase = "native-journal-lease-create-exclusive";
        // Win32 CreateFile CREATE_NEW and FILE_SHARE_NONE. The OS holds the
        // exclusive handle until Guardian exits. An existing lock, including
        // a crash remnant, MUST NOT be overwritten or silently reclaimed.
        using var lease = continuousSession
            ? OpenOwnedTerminalCapableSessionLease(leasePath)
            : new FileStream(leasePath, FileMode.CreateNew, FileAccess.ReadWrite,
                FileShare.None, 4096, FileOptions.WriteThrough);
        var body = Encoding.ASCII.GetBytes($"schemaVersion=1\ntransactionId={owner.TransactionId}\nworkerPid={owner.Pid}\nworkerStartTimeUtcTicks={owner.Ticks}\nguardianPid={Environment.ProcessId}\n");
        if (body.Length > 512) throw new InvalidDataException("Windows journal lease record exceeds its bound.");
        lease.Write(body);
        lease.Flush(flushToDisk: true);
        InspectionPhase = "native-journal-lease-exclusive-held";
        if (acceptAuthorityProof || recordPreparedAbort || quiesceStableShell || recordNativeStaged)
            RecordNativeJournalWorkerAuthority(owner, root, worker, recordPreparedAbort, recordNativeStaged, cancelBeforeSwitch);
        if (quiesceStableShell)
            QuiesceOwnedStableShell(owner, root, worker);
        if (continuousSession)
            VerifyPinnedNativeGuardianFile(originalGuardian!);
        // The original signed OS session alone can RETIRE its own two
        // create-only ownership files after independently verified terminal
        // recovery. No path-based deletion, generic orphan reclaim or
        // guessed completion from the worker's exit code.
        var cutoff = Stopwatch.StartNew();
        var nextTerminalCheck = TimeSpan.Zero;
        while (!worker.HasExited && cutoff.Elapsed < TimeSpan.FromMinutes(20))
        {
            if (worker.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks)
                break;
            if (continuousSession && cutoff.Elapsed >= nextTerminalCheck)
            {
                nextTerminalCheck = cutoff.Elapsed + TimeSpan.FromSeconds(1);
                VerifyPinnedNativeGuardianFile(originalGuardian!);
                HandleOneOwnedGuardianSessionRequest(owner, root, worker, originalGuardian!);
                if (TryRetireCompletedNativeGuardianSession(owner, root, worker,
                    originalGuardian!, lease)) return;
            }
            Thread.Sleep(150);
        }
        throw new InvalidOperationException("Windows native journal lease ended and requires explicit owner reconciliation.");
    }

    private const uint NativeGuardianGenericWrite = 0x40000000;
    private const uint NativeGuardianCreateNew = 1;
    private const int NativeGuardianFileDispositionInfo = 4;

    private static FileStream OpenOwnedTerminalCapableSessionLease(string path)
    {
        // Open once with DELETE permission for eventual *handle-bound*
        // successful completion. A failed or crashed session NEVER sets
        // disposition, so the original name remains durable and blocks boot.
        var handle = OpenNativeOrphanFileForRename(path,
            NativeOrphanGenericRead | NativeGuardianGenericWrite | NativeOrphanDelete,
            0, 0, NativeGuardianCreateNew, NativeOrphanOpenReparsePoint, 0);
        if (handle.IsInvalid)
        {
            var error = Marshal.GetLastWin32Error();
            handle.Dispose();
            throw new Win32Exception(error, "Cannot create original signed Guardian OS session lease.");
        }
        try
        {
            return new FileStream(handle, FileAccess.ReadWrite, 4096, isAsync: false);
        }
        catch
        {
            handle.Dispose();
            throw;
        }
    }

    private static void DeleteExactOwnedNativeFileOnHandle(SafeFileHandle handle)
    {
        // FILE_DISPOSITION_INFO (BOOL DeleteFile), using the exact
        // DELETE-capable live OS handle, NEVER unlinking a pathname.
        if (handle.IsInvalid || handle.IsClosed ||
            !ReadNativeOrphanHandleInformation(handle, out var info) ||
            (info.Attributes & (NativeOrphanReparseAttribute | NativeOrphanDirectoryAttribute)) != 0 ||
            info.LinkCount != 1 || info.VolumeSerial == 0 ||
            info.FileIndexHigh == 0 && info.FileIndexLow == 0)
            throw new InvalidDataException("Owned native terminal file lost its exact kernel identity.");
        var buffer = Marshal.AllocHGlobal(sizeof(int));
        try
        {
            Marshal.WriteInt32(buffer, 1);
            if (!RenameNativeOrphanByHandle(handle, NativeGuardianFileDispositionInfo, buffer, sizeof(int)))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "OS denied disposition on exact Guardian-owned terminal file.");
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    private static bool TryRetireCompletedNativeGuardianSession(OwnedWorkerClaim owner,
        string journalRoot, Process worker, SafeFileHandle originalGuardian, FileStream lease)
    {
        var tx = Path.GetDirectoryName(journalRoot)
            ?? throw new InvalidDataException("Original Guardian transaction root is missing.");
        // Before the Main worker releases its active lock, the terminal
        // receipt is only a tentative update decision. Never release the
        // OS owner merely because a worker writes "healthy" or exits.
        var active = Path.Combine(tx, "active.json");
        if (File.Exists(active) || Directory.Exists(active)) return false;
        var receiptPath = Path.Combine(tx, "receipts", owner.TransactionId + ".json");
        if (!File.Exists(receiptPath)) return false;

        InspectionPhase = "native-guardian-session-terminal-identity";
        using var receipt = ReadOwnedTransitionRecord(receiptPath, 8192);
        var r = receipt.RootElement;
        RequireExactKeys(r, ["schemaVersion", "transactionId", "channel", "status", "stage",
            "currentSha", "targetSha", "rollbackSha", "rollbackSourceRoot", "targetSourceRoot",
            "startedAt", "updatedAt", "lastError"]);
        var disposition = r.GetProperty("status").GetString();
        if (disposition is not ("succeeded" or "rolled_back")) return false;
        var rollback = disposition == "rolled_back";
        if (r.GetProperty("schemaVersion").GetInt32() != 1 ||
            r.GetProperty("channel").GetString() != "main" ||
            r.GetProperty("transactionId").GetString() != owner.TransactionId ||
            r.GetProperty("stage").GetString() != (rollback ? "rollback_healthy" : "healthy") ||
            r.GetProperty("rollbackSha").GetString() != r.GetProperty("currentSha").GetString())
            throw new InvalidDataException("Final Main receipt does not authorize original Guardian session retirement.");
        using var journal = ReadOwnedTransitionRecord(Path.Combine(journalRoot, owner.TransactionId + ".json"), 8192);
        var j = journal.RootElement;
        RequireExactKeys(j, ["schemaVersion", "channel", "transactionId", "target",
            "currentSha", "targetSha", "receiptStartedAt", "previousNative",
            "targetRuntimeContractSha256", "stage", "sequence", "createdAt", "updatedAt"]);
        var finalSha = (rollback ? r.GetProperty("currentSha") : r.GetProperty("targetSha")).GetString() ?? "";
        var oldSha = r.GetProperty("currentSha").GetString() ?? "";
        var newSha = r.GetProperty("targetSha").GetString() ?? "";
        if (!SourceShaPattern.IsMatch(finalSha) || !SourceShaPattern.IsMatch(oldSha) ||
            !SourceShaPattern.IsMatch(newSha) || oldSha == newSha ||
            j.GetProperty("schemaVersion").GetInt32() != 1 ||
            j.GetProperty("channel").GetString() != "main" ||
            j.GetProperty("transactionId").GetString() != owner.TransactionId ||
            j.GetProperty("currentSha").GetString() != oldSha ||
            j.GetProperty("targetSha").GetString() != newSha ||
            j.GetProperty("receiptStartedAt").GetString() != r.GetProperty("startedAt").GetString() ||
            j.GetProperty("stage").GetString() != (rollback ? "rolled_back" : "committed") ||
            j.GetProperty("sequence").GetInt32() is < 1 or > 11)
            throw new InvalidDataException("Final native A/B journal differs from exact terminal Main receipt.");

        var target = RuntimeInformation.ProcessArchitecture switch
        {
            Architecture.X64 => "win32-x64", Architecture.Arm64 => "win32-arm64",
            _ => throw new PlatformNotSupportedException("Unrecognized Windows terminal Main CPU."),
        };
        if (j.GetProperty("target").GetString() != target ||
            worker.HasExited ||
            worker.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks)
            throw new InvalidDataException("Original Guardian terminal transaction lost its live OS worker/CPU.");
        foreach (var item in Directory.EnumerateFileSystemEntries(journalRoot))
        {
            var name = Path.GetFileName(item);
            if (name.EndsWith(".writer-lock", StringComparison.OrdinalIgnoreCase) ||
                name.StartsWith("." + owner.TransactionId + ".json.", StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Concurrent/orphan native journal writer blocks terminal owner retirement.");
        }

        var priorNative = j.GetProperty("previousNative");
        var stableRollback = rollback && priorNative.GetProperty("kind").GetString() == "stable";
        if (rollback && priorNative.GetProperty("kind").GetString() is not ("stable" or "main"))
            throw new InvalidDataException("Terminal A/B rollback has an unknown original A kind.");
        var handoffPath = Path.Combine(tx, "handoff", owner.TransactionId + ".windows-worker.json");
        RequireNormalFile(handoffPath);
        // Take DELETE permission on this ORIGINAL worker handoff before any
        // cleanup; do not trust a later pathname unlink after a separate
        // validation, and never leak the 256-bit worker token into logs.
        var handoffHandle = OpenNativeOrphanFileForRename(handoffPath,
            NativeOrphanGenericRead | NativeOrphanDelete, NativeOrphanShareRead,
            0, NativeOrphanOpenExisting, NativeOrphanOpenReparsePoint, 0);
        if (handoffHandle.IsInvalid)
        {
            var code = Marshal.GetLastWin32Error();
            handoffHandle.Dispose();
            throw new Win32Exception(code, "Terminal native handoff cannot be pinned by kernel File ID.");
        }
        using (handoffHandle)
        {
            if (!ReadNativeOrphanHandleInformation(handoffHandle, out var file) ||
                (file.Attributes & (NativeOrphanReparseAttribute | NativeOrphanDirectoryAttribute)) != 0 ||
                file.LinkCount != 1 || file.SizeHigh != 0 || file.SizeLow is < 2 or > 8192)
                throw new InvalidDataException("Terminal worker handoff kernel file identity is invalid.");
            using var handoffStream = new FileStream(handoffHandle, FileAccess.Read, 8192, isAsync: false);
            using var handoff = JsonDocument.Parse(handoffStream);
            var identity = handoff.RootElement;
            RequireExactKeys(identity, ["schemaVersion", "transactionId", "pid",
                "startTimeUtcTicks", "token", "nodePath"]);
            if (identity.GetProperty("schemaVersion").GetInt32() != 1 ||
                identity.GetProperty("transactionId").GetString() != owner.TransactionId ||
                identity.GetProperty("pid").GetInt32() != owner.Pid ||
                identity.GetProperty("startTimeUtcTicks").GetString() != owner.Ticks)
                throw new InvalidDataException("Terminal Main worker handoff differs from original kernel owner.");

            // Bind the final proof to the initial kernel-PID/HMAC-prepared
            // session: a new handoff with the same PID cannot retire it.
            handoffStream.Position = 0;
            var ownerDigest = Convert.ToHexStringLower(SHA256.HashData(handoffStream));
            using var authority = ReadOwnedTransitionRecord(Path.Combine(
                journalRoot, owner.TransactionId + ".native-authority.json"), 8192);
            var proof = authority.RootElement;
            if (proof.GetProperty("transactionId").GetString() != owner.TransactionId ||
                proof.GetProperty("workerPid").GetInt32() != owner.Pid ||
                proof.GetProperty("workerStartTimeUtcTicks").GetString() != owner.Ticks ||
                proof.GetProperty("guardianPid").GetInt32() != Environment.ProcessId ||
                proof.GetProperty("handoffSha256").GetString() != ownerDigest)
                throw new InvalidDataException("Final native session handoff is not original HMAC-attested worker.");

            // Source+native pointer identity and actual WPF/Browser Native
            // Messaging bytes must be independently correct BEFORE retiring
            // any file: otherwise a fabricated journal success could brick A.
            var nativePointer = Path.Combine(tx, "current-native.json");
            if (stableRollback)
            {
                if (File.Exists(nativePointer) || Directory.Exists(nativePointer))
                    throw new InvalidDataException("Stable A rollback did not remove Main B native pointer.");
                if (priorNative.GetProperty("version").GetString() is not string expectedStableVersion ||
                    !VersionRegex().IsMatch(expectedStableVersion))
                    throw new InvalidDataException("Terminal stable A version lacks exact original journal provenance.");
                using var stablePointer = ReadOwnedTransitionRecord(Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "Equinox Local", "current-version.json"), 4096);
                if (stablePointer.RootElement.GetProperty("version").GetString() != expectedStableVersion)
                    throw new InvalidDataException("Terminal Stable A differs from recorded original release.");
                InspectBaseline(allowActiveOrphanForReconciliation: true);
            }
            else
            {
                using var ptr = ReadOwnedTransitionRecord(nativePointer, 8192);
                if (ptr.RootElement.GetProperty("sourceSha").GetString() != finalSha ||
                    ptr.RootElement.GetProperty("target").GetString() != target)
                    throw new InvalidDataException("Terminal native pointer is not original A or exact healthy B.");
            }
            var sourcePointer = Path.Combine(tx, "current-source.conf");
            RequireNormalFile(sourcePointer);
            var rows = File.ReadAllText(sourcePointer).Split('\n', StringSplitOptions.RemoveEmptyEntries)
                .Select(row => row.TrimEnd('\r')).ToArray();
            if (rows.Length != 3 || rows[0] != "schemaVersion=1" ||
                rows[1] != "sourceRoot=" + Path.Combine(tx, "sources", finalSha) ||
                rows[2] != "sha=" + finalSha)
                throw new InvalidDataException("Terminal Main source pointer differs from verified A/B.");
            if (!stableRollback)
            {
                var immutable = Path.Combine(tx, "native-store", target, finalSha, "release");
                CompareNativeTrees(Path.Combine(immutable, "runtime", "shell"),
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                        "Programs", "Equinox Local"));
                InspectOwnedMainNativeMessaging(Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "Equinox Local"), immutable);
            }
            // The very last decision must still be within the identical
            // active OS worker + pinned original signed Guardian session.
            VerifyPinnedNativeGuardianFile(originalGuardian);
            if (File.Exists(active) || Directory.Exists(active) ||
                worker.HasExited ||
                worker.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks)
                throw new InvalidDataException("Native terminal cleanup lost exact live ownership.");

            InspectionPhase = "native-guardian-session-retire-original-handles";
            // If the process crashes between these two operations the
            // remaining Guardian session marker STILL fails closed.
            DeleteExactOwnedNativeFileOnHandle(handoffStream.SafeFileHandle);
        }
        // Only NOW, with no active Main lock/worker handoff, can the same
        // product-native full source/Git/native-store/installed WPF and
        // Native Messaging audit prove what the NEXT boot will select.
        // The live original Guardian OS File ID and lease remain pinned.
        if (stableRollback) InspectBaseline(allowActiveOrphanForReconciliation: true);
        else
        {
            InspectMainNativeIdentity();
            using var native = ReadOwnedTransitionRecord(Path.Combine(tx, "current-native.json"), 8192);
            if (native.RootElement.GetProperty("sourceSha").GetString() != finalSha)
                throw new InvalidDataException("Final native Main full audit returned a foreign SHA.");
        }
        if (File.Exists(active) || Directory.Exists(active) || worker.HasExited)
            throw new InvalidDataException("Terminal owner lost worker or Main lock identity after full native audit.");
        VerifyPinnedNativeGuardianFile(originalGuardian);
        lease.Flush(flushToDisk: true);
        DeleteExactOwnedNativeFileOnHandle(lease.SafeFileHandle);
        InspectionPhase = "native-guardian-session-terminal-owner-released";
        return true;
    }

    // Hold the original signed Guardian executable's kernel FILE ID throughout
    // the native owner session. FILE_SHARE_READ excludes delete/rename by a
    // later competing native update; no pathname-based identity reassignment.
    private static SafeFileHandle PinNativeGuardianFileForSession()
    {
        InspectionPhase = "native-guardian-session-original-file-id";
        if (!OperatingSystem.IsWindows())
            throw new PlatformNotSupportedException("Guardian OS file identity requires Windows.");
        var expected = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Equinox Local", "runtime", "guardian", "EquinoxLocalGuardian.exe");
        if (!Compare.Equals(Path.GetFullPath(Environment.ProcessPath ?? ""), Path.GetFullPath(expected)))
            throw new InvalidDataException("Original Guardian executable is not the installed signed owner.");
        RequireNormalFile(expected);
        var handle = OpenNativeOrphanFileForRename(expected, NativeOrphanGenericRead,
            NativeOrphanShareRead, 0, NativeOrphanOpenExisting, NativeOrphanOpenReparsePoint, 0);
        try
        {
            VerifyPinnedNativeGuardianFile(handle);
            return handle;
        }
        catch
        {
            handle.Dispose();
            throw;
        }
    }

    private static void VerifyPinnedNativeGuardianFile(SafeFileHandle handle)
    {
        if (handle.IsInvalid || handle.IsClosed ||
            !ReadNativeOrphanHandleInformation(handle, out var info) ||
            (info.Attributes & (NativeOrphanReparseAttribute | NativeOrphanDirectoryAttribute)) != 0 ||
            info.LinkCount != 1 || info.SizeHigh == 0 && info.SizeLow == 0 ||
            info.VolumeSerial == 0 || info.FileIndexHigh == 0 && info.FileIndexLow == 0)
            throw new InvalidDataException("Original signed Guardian kernel file ID is not pinned.");
    }
}
