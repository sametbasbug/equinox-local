namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    // Combined, read-only OS Guardian pre-stage admission. No single worker
    // callback, detached B file, valid PE digest or guessed source SHA can
    // authorize a native B transition. Only the currently installed original
    // Main A Guardian can independently establish every prerequisite.
    //
    // IMPORTANT: even SUCCESS is NOT a native_staged milestone: no journal,
    // receipt, native pointer, WPF, NativeMessaging or exclusive lease writes.
    // A future OS-owned stage writer must reattest the whole source and
    // signature inside its exclusive lease, before and after its own writes.
    private static void InspectOwnedSignedMainBStageReadiness()
    {
        InspectionPhase = "native-b-stage-ready-original-a-live-worker";
        InspectOwnedNativeWorkerOsArguments();
        InspectOwnedNativeWorkerPipeProof();
        // Preserve the original installed Guardian's real physical kernel
        // identity, never emit a misleading A-success marker if B later fails.
        var originalA = InspectOriginalMainGuardianPhysicalFileId(emitEvidence: false);
        InspectionPhase = "native-b-stage-ready-production-ed25519";
        InspectOwnedSignedMainBCandidate();
        // The pinned A source, native store and OS worker may change during
        // the multi-second Ed25519 child verification. Reread original A and
        // reprove the live owner on the far side; any race fails closed.
        InspectionPhase = "native-b-stage-ready-post-signature-worker";
        InspectOwnedNativeWorkerOsArguments();
        InspectOwnedNativeWorkerPipeProof();
        var confirmedA = InspectOriginalMainGuardianPhysicalFileId(emitEvidence: false);
        if (confirmedA != originalA)
            throw new InvalidDataException("Original Main A physical Guardian kernel File ID changed across signed B admission.");
        InspectionPhase = "native-b-stage-ready-readonly-not-a-lease";
    }
}
