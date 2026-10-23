import path from "node:path";
import { planEquinoxLocalMainNativeTransition } from "./equinox-local-main-native-admission.js";
import { stageEquinoxLocalMainSnapshotArtifact } from "./equinox-local-main-snapshot.js";
import { equinoxLocalReleaseTarget } from "./equinox-local-platform.js";
import { createEquinoxLocalMainUpdateTransactionEngine } from "./equinox-local-main-update-transaction.js";
import { scheduleEquinoxLocalMainUpdateWorker } from "./equinox-local-main-update-scheduler.js";
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
// Coordinator only orchestrates already guarded source/native and OS worker APIs.
export async function prepareAndScheduleEquinoxLocalMainUpdate({ sourceRoot, transactionRoot, currentSha, targetSha, engineFactory = (options) => createEquinoxLocalMainUpdateTransactionEngine(options), resolveHostTarget = () => equinoxLocalReleaseTarget(), planNativeTransition = planEquinoxLocalMainNativeTransition, stageNativeArtifact = stageEquinoxLocalMainSnapshotArtifact, scheduleWorker = scheduleEquinoxLocalMainUpdateWorker, schedulerOptions = {}, engineOptions = {}, }) {
    const engine = engineFactory({ ...engineOptions, sourceRoot, transactionRoot });
    await engine.initializeSourcePointer();
    const staged = await engine.stage({ currentSha, targetSha });
    const transactionId = staged.receipt.transactionId;
    let nativeTransition;
    try {
        const target = resolveHostTarget();
        nativeTransition = await planNativeTransition({
            currentRoot: sourceRoot,
            currentSha,
            targetRoot: staged.stagedSourceRoot,
            targetSha,
            target,
            gitPath: engineOptions.gitPath ?? "git",
        });
        if (nativeTransition?.mode === "artifact_required") {
            await stageNativeArtifact({
                sourceSha: targetSha,
                target,
                expectedRuntimeContractSha256: nativeTransition.targetRuntimeContractSha256,
                transactionRoot,
                transactionId,
            });
        }
        else if (nativeTransition?.mode !== "reuse_native") {
            throw new Error("Main native transition mode is unsupported.");
        }
    }
    catch (error) {
        await engine.abortStagedPreparation(transactionId, errorMessage(error)).catch(() => { });
        throw error;
    }
    // A failure before promotion must release the staged single-flight lock.
    // Otherwise a missing tool or interrupted Git check leaves Windows stuck in
    // staged forever and blocks every subsequent Update & restart attempt.
    let prepared;
    try {
        prepared = await engine.preparePromotion(transactionId);
    }
    catch (error) {
        await engine.abortStagedPreparation(transactionId, errorMessage(error)).catch(() => { });
        throw error;
    }
    const workerPath = path.join(prepared.targetSourceRoot, "src", "equinox-local-main-update-worker.js");
    try {
        const handoff = await scheduleWorker({
            ...schedulerOptions,
            transactionId,
            sourceRoot,
            transactionRoot,
            workerPath,
        });
        if (handoff?.scheduled !== true) {
            throw new Error("Main update worker handoff did not confirm scheduling.");
        }
        return Object.freeze({
            status: "scheduled",
            transactionId,
            targetSha,
            targetSourceRoot: prepared.targetSourceRoot,
            nativeTransition,
            handoff,
        });
    }
    catch (error) {
        await engine.abortPreparedPromotion(transactionId, errorMessage(error)).catch(() => { });
        throw error;
    }
}
