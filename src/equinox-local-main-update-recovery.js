import path from "node:path";

import { scheduleEquinoxLocalMainUpdateWorker, cleanupEquinoxLocalMainUpdateWorkerOwnership, inspectEquinoxLocalMainUpdateWorkerOwnership } from "./equinox-local-main-update-scheduler.js";
import { createEquinoxLocalMainUpdateTransactionEngine } from "./equinox-local-main-update-transaction.js";
import { inspectCanonicalMainCheckout } from "./equinox-local-main-update.js";

const RESUMABLE = new Set([
  "promoting:ready_to_switch",
  "promoting:native_rollback_ready",
  "promoting:native_switched",
  "verifying:source_switched",
  "verifying:rollback_source_restored",
  "verifying:rollback_native_restored",
]);

async function assertExactSource(root, sha, inspectCheckout) {
  if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("Main update recovery source root is unavailable.");
  const inspected = await inspectCheckout(root);
  if (!inspected?.eligible || inspected.currentSha !== sha) throw new Error("Main update recovery source identity does not match its durable receipt.");
  return path.resolve(root);
}

export async function reconcileEquinoxLocalMainUpdate({
  sourceRoot,
  transactionRoot,
  engineFactory = (options) => createEquinoxLocalMainUpdateTransactionEngine(options),
  inspectCheckout = inspectCanonicalMainCheckout,
  inspectWorker = inspectEquinoxLocalMainUpdateWorkerOwnership,
  cleanupWorker = cleanupEquinoxLocalMainUpdateWorkerOwnership,
  scheduleWorker = scheduleEquinoxLocalMainUpdateWorker,
} = {}) {
  const engine = engineFactory({ sourceRoot, transactionRoot });
  const active = await engine.readActive();
  if (!active) return Object.freeze({ status: "idle" });
  const worker = await inspectWorker({ transactionId: active.transactionId });
  if (worker?.running) return Object.freeze({ status: "worker_active", transactionId: active.transactionId, stage: active.stage });

  if (["succeeded", "rolled_back", "failed"].includes(active.status)) {
    await cleanupWorker({ transactionId: active.transactionId, transactionRoot });
    await engine.releaseStagedLock(active.transactionId);
    return Object.freeze({ status: "settled", transactionId: active.transactionId, receiptStatus: active.status });
  }
  if (active.status === "rollback_failed") {
    return Object.freeze({ status: "blocked", transactionId: active.transactionId, stage: active.stage, reason: "rollback_failed" });
  }
  if (!RESUMABLE.has(`${active.status}:${active.stage}`)) {
    return Object.freeze({ status: "blocked", transactionId: active.transactionId, stage: active.stage, reason: "not_resumable" });
  }

  const rollbackSourceRoot = await assertExactSource(active.rollbackSourceRoot, active.rollbackSha, inspectCheckout);
  const targetSourceRoot = await assertExactSource(active.targetSourceRoot, active.targetSha, inspectCheckout);
  const workerPath = path.join(targetSourceRoot, "src", "equinox-local-main-update-worker.js");
  await cleanupWorker({ transactionId: active.transactionId, transactionRoot });
  const scheduled = await scheduleWorker({
    transactionId: active.transactionId,
    sourceRoot: rollbackSourceRoot,
    transactionRoot,
    workerPath,
  });
  return Object.freeze({ status: "scheduled", transactionId: active.transactionId, stage: active.stage, scheduled });
}
