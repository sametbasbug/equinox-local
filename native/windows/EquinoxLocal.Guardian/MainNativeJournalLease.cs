using System.Diagnostics;
using System.Globalization;
using System.Text;
using Microsoft.Win32.SafeHandles;

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
        using var lease = new FileStream(leasePath, FileMode.CreateNew, FileAccess.ReadWrite,
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
        // Deliberately no journal/receipt modifications and no automatic
        // cleanup. Worker exit or bounded lease expiry means a trusted
        // supervisor must reconcile before any further native mutation.
        var cutoff = Stopwatch.StartNew();
        while (!worker.HasExited && cutoff.Elapsed < TimeSpan.FromMinutes(20))
        {
            if (worker.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks)
                break;
            Thread.Sleep(150);
        }
        throw new InvalidOperationException("Windows native journal lease ended and requires explicit owner reconciliation.");
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
