import path from "node:path";

import { planEquinoxLocalMainNativeTransition } from "./equinox-local-main-native-admission.js";
import { stageEquinoxLocalMainSnapshotArtifact } from "./equinox-local-main-snapshot.js";
import { equinoxLocalReleaseTarget } from "./equinox-local-platform.js";
import { createEquinoxLocalMainUpdateTransactionEngine } from "./equinox-local-main-update-transaction.js";
import { scheduleEquinoxLocalMainUpdateWorker } from "./equinox-local-main-update-scheduler.js";

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export async function prepareAndScheduleEquinoxLocalMainUpdate({
  sourceRoot,
  transactionRoot,
  currentSha,
  targetSha,
  engineFactory = (options) => createEquinoxLocalMainUpdateTransactionEngine(options),
  resolveHostTarget = () => equinoxLocalReleaseTarget(),
  planNativeTransition = planEquinoxLocalMainNativeTransition,
  stageNativeArtifact = stageEquinoxLocalMainSnapshotArtifact,
  scheduleWorker = scheduleEquinoxLocalMainUpdateWorker,
  schedulerOptions = {},
} = {}) {
  const engine = engineFactory({ sourceRoot, transactionRoot });
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
    });
    if (nativeTransition?.mode === "artifact_required") {
      await stageNativeArtifact({
        sourceSha: targetSha,
        target,
        expectedRuntimeContractSha256: nativeTransition.targetRuntimeContractSha256,
        transactionRoot,
        transactionId,
      });
    } else if (nativeTransition?.mode !== "reuse_native") {
      throw new Error("Main native transition mode is unsupported.");
    }
  } catch (error) {
    await engine.abortStagedPreparation(transactionId, errorMessage(error)).catch(() => {});
    throw error;
  }

  const prepared = await engine.preparePromotion(transactionId);
  const workerPath = path.join(prepared.targetSourceRoot, "src", "equinox-local-main-update-worker.js");
  try {
    const handoff = await scheduleWorker({
      transactionId,
      sourceRoot,
      transactionRoot,
      workerPath,
      ...schedulerOptions,
    });
    return Object.freeze({
      status: "scheduled",
      transactionId,
      targetSha,
      targetSourceRoot: prepared.targetSourceRoot,
      nativeTransition,
      handoff,
    });
  } catch (error) {
    await engine.abortPreparedPromotion(transactionId, errorMessage(error)).catch(() => {});
    throw error;
  }
}
