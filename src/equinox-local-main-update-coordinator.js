import path from "node:path";

import { createEquinoxLocalMainUpdateTransactionEngine } from "./equinox-local-main-update-transaction.js";
import { scheduleEquinoxLocalMainUpdateWorker } from "./equinox-local-main-update-scheduler.js";

export async function prepareAndScheduleEquinoxLocalMainUpdate({
  sourceRoot,
  transactionRoot,
  currentSha,
  targetSha,
  engineFactory = (options) => createEquinoxLocalMainUpdateTransactionEngine(options),
  scheduleWorker = scheduleEquinoxLocalMainUpdateWorker,
  schedulerOptions = {},
} = {}) {
  const engine = engineFactory({ sourceRoot, transactionRoot });
  await engine.initializeSourcePointer();
  const staged = await engine.stage({ currentSha, targetSha });
  const prepared = await engine.preparePromotion(staged.receipt.transactionId);
  const workerPath = path.join(prepared.targetSourceRoot, "src", "equinox-local-main-update-worker.js");
  try {
    const handoff = await scheduleWorker({
      transactionId: prepared.receipt.transactionId,
      sourceRoot,
      transactionRoot,
      workerPath,
      ...schedulerOptions,
    });
    return Object.freeze({ status: "scheduled", transactionId: prepared.receipt.transactionId, targetSha, targetSourceRoot: prepared.targetSourceRoot, handoff });
  } catch (error) {
    await engine.abortPreparedPromotion(prepared.receipt.transactionId, error instanceof Error ? error.message : String(error)).catch(() => {});
    throw error;
  }
}
