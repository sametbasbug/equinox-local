using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    // Phase ZERO of the SAME original Windows Guardian native session.
    // Establish an exclusive LIVE OS-held, non-mutating signed-native owner
    // after independently verifying original Ed25519 + retained ZIP,
    // kernel PID/birth/SID/logon LUID, exact NTFS B and worker argv, and the
    // original fresh nonce worker-pipe HMAC. Not a second journal writer.
    //
    // DeleteOnClose is correct HERE because this lease authorizes NO WPF
    // stop, A/B switch, NativeMessaging mutation or commit. A future
    // mutating lease MUST be durable/crash-recoverable instead, and must
    // never reuse this throwaway proof as update permission.
    private static void InspectSignedNativeOwnerExclusiveLeaseWithoutGrant()
    {
        InspectionPhase = "signed-native-independent-owner-lease";
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrWhiteSpace(local) || !Path.IsPathFullyQualified(local))
            throw new InvalidDataException("Signed-native Guardian has no original Windows user root.");
        var root = Path.Combine(local, "Equinox Local", "state", "main-update");
        RequireNormalDirectory(root);
        using var activeDocument = ReadOwnedTransitionRecord(
            Path.Combine(root, "active.json"), 8192);
        var active = activeDocument.RootElement;
        RequireExactKeys(active, ["schemaVersion", "kind", "transactionId",
            "sourceSha", "target", "runtimeContractSha256"]);
        var id = active.GetProperty("transactionId").GetString() ?? "";
        var sha = active.GetProperty("sourceSha").GetString() ?? "";
        var target = active.GetProperty("target").GetString() ?? "";
        if (active.GetProperty("schemaVersion").GetInt32() != 1 ||
            active.GetProperty("kind").GetString() != "signed-native" ||
            !NativeTransactionPattern.IsMatch(id) ||
            !SourceShaPattern.IsMatch(sha))
            throw new InvalidDataException("Original signed-native lease lacks an exact active owner.");
        var expected = EquinoxLocal.NativeShared.MainSignedNativeWorkerContract.ForSignedNativeB(
            id, sha, target, root);
        var handoff = Path.Combine(root, "handoff");
        RequireNormalDirectory(handoff);
        var orphanRoot = Path.Combine(root, "guardian-journal");
        if (Directory.Exists(orphanRoot))
        {
            RequireNormalDirectory(orphanRoot);
            foreach (var entry in Directory.EnumerateFileSystemEntries(orphanRoot))
            {
                var name = Path.GetFileName(entry);
                if (name.EndsWith(".writer-lock", StringComparison.OrdinalIgnoreCase) ||
                    name.EndsWith(".guardian-session-lock", StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("Original Git Guardian journal owner blocks signed-native OS admission.");
            }
        }

        var leaseName = "." + id + ".signed-native-owner-proof.lock";
        var leasePath = Path.Combine(handoff, leaseName);
        using var originalGuardian = PinNativeGuardianFileForSession();
        // CREATE_NEW + FILE_SHARE_NONE rejects a second authentic concurrent
        // Guardian owner even with the same PID, token or original receipt.
        // Never replace/delete an existing lock by path on a failed open.
        InspectionPhase = "signed-native-owner-kernel-create-exclusive";
        using var lease = new FileStream(leasePath, FileMode.CreateNew, FileAccess.ReadWrite,
            FileShare.None, 4096, FileOptions.DeleteOnClose | FileOptions.WriteThrough);
        var record = Encoding.ASCII.GetBytes(
            $"schemaVersion=1\nmode=signed-native-read-only\ntransactionId={id}\n" +
            $"guardianPid={Environment.ProcessId}\n");
        if (record.Length > 512)
            throw new InvalidDataException("Signed-native original owner lease record exceeds bound.");
        lease.Write(record);
        lease.Flush(flushToDisk: true);

        InspectionPhase = "signed-native-owner-kernel-file-id-and-ed25519";
        // The *same* immutable Node/worker File IDs stay pinned across full
        // original ZIP verification and the fresh kernel nonce challenge.
        using var pinnedB = EquinoxLocal.NativeShared.MainSignedNativeWorkerContract
            .PinExactBExecutables(expected);
        var audited = InspectOwnedNativeWorkerOsArguments(signedNativeReadOnly: true);
        if (audited.TransactionId != id)
            throw new InvalidDataException("Signed-native Guardian live worker differs from exclusive lease.");
        InspectionPhase = "signed-native-owner-live-kernel-hmac";
        InspectOwnedNativeWorkerPipeProof(signedNativeReadOnly: true, previouslyAudited: audited);
        VerifyPinnedNativeGuardianFile(originalGuardian);
        using var process = Process.GetProcessById(audited.Pid);
        if (process.HasExited ||
            process.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != audited.Ticks)
            throw new InvalidDataException("Original signed-native OS owner changed during exclusive HMAC lease.");
        // Success explicitly means ONLY live original Guardian owner proof.
        // No reference to the lease escapes, so no JS caller can promote it
        // to the original mutating Git Guardian journal authorization.
        InspectionPhase = "signed-native-exclusive-owner-read-only-complete";
    }
}
