using System.Diagnostics;
using System.Globalization;
using System.Text;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    // First independent native OS-owned writer lease, NOT a journal milestone
    // writer and NOT permission to stop WPF, swap A/B or relaunch anything.
    // The persistent marker is intentionally never deleted automatically:
    // a dead native owner needs independent receipt + filesystem reconciliation.
    private static void HoldOwnedNativeJournalLease(bool acceptAuthorityProof = false)
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
        var leasePath = Path.Combine(root, "." + owner.TransactionId + ".writer-lock");
        using var worker = Process.GetProcessById(owner.Pid);
        if (worker.HasExited || worker.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks)
            throw new InvalidDataException("Windows journal lease worker exited during admission.");
        InspectionPhase = "native-journal-lease-create-exclusive";
        // Win32 CreateFile CREATE_NEW and FILE_SHARE_NONE. The OS holds the
        // exclusive handle until Guardian exits. An existing lock, including
        // a crash remnant, MUST NOT be overwritten or silently reclaimed.
        using var lease = new FileStream(leasePath, FileMode.CreateNew, FileAccess.ReadWrite,
            FileShare.None, 4096, FileOptions.WriteThrough);
        var body = Encoding.ASCII.GetBytes($"schemaVersion=1\ntransactionId={owner.TransactionId}\nworkerPid={owner.Pid}\nguardianPid={Environment.ProcessId}\n");
        if (body.Length > 512) throw new InvalidDataException("Windows journal lease record exceeds its bound.");
        lease.Write(body);
        lease.Flush(flushToDisk: true);
        InspectionPhase = "native-journal-lease-exclusive-held";
        if (acceptAuthorityProof)
            RecordNativeJournalWorkerAuthority(owner, root, worker);
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
}
