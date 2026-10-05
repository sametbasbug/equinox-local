import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { planEquinoxLocalMainNativeTransition } from "./equinox-local-main-native-admission.js";
import { prepareEquinoxLocalMainNativeCandidate } from "./equinox-local-main-native-candidate.js";
import { prepareEquinoxLocalMainNativeLifecycle } from "./equinox-local-main-native-activation.js";
import { recoverEquinoxLocalMainNativeLifecycle } from "./equinox-local-main-native-recovery.js";
import { equinoxLocalReleaseTarget } from "./equinox-local-platform.js";
import { createEquinoxLocalMainUpdateTransactionEngine } from "./equinox-local-main-update-transaction.js";
import { runEquinoxLocalMainUpdateHandoff } from "./equinox-local-main-update-handoff.js";
import { readEquinoxLocalMainSourcePointer } from "./equinox-local-main-source-pointer.js";
import { inspectCanonicalMainCheckout } from "./equinox-local-main-update.js";
import { EQUINOX_LOCAL_CONTROL_CENTER_STATUS_URL } from "./equinox-local-update-activation.js";
import { cleanupEquinoxLocalMainUpdateWorkerOwnership } from "./equinox-local-main-update-scheduler.js";

const execFile = promisify(execFileCallback);
const HEALTH_ATTEMPTS = 40;
const HEALTH_DELAY_MS = 500;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!value || !new Set(["--transaction-id", "--source-root", "--transaction-root"]).has(key)) throw new Error("Main update worker arguments are invalid.");
    if (Object.hasOwn(result, key)) throw new Error("Main update worker arguments contain duplicates.");
    result[key] = value;
  }
  if (Object.keys(result).length !== 3) throw new Error("Main update worker requires transaction id, source root and transaction root.");
  return Object.freeze({ transactionId: result["--transaction-id"], sourceRoot: path.resolve(result["--source-root"]), transactionRoot: path.resolve(result["--transaction-root"]) });
}

async function restartSourceRuntime({ sourceRoot, previousSourceRoot, execFileImpl = execFile, env = process.env }) {
  const scriptPath = path.join(sourceRoot, "scripts", "restart-runtime.sh");
  const stat = await fs.lstat(scriptPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Main update restart script is unsafe.");
  await execFileImpl("/bin/bash", [scriptPath, "--worker"], {
    timeout: 180_000,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...env, EQUINOX_LOCAL_PREVIOUS_SOURCE_ROOT: previousSourceRoot },
  });
}

async function waitForExactSourceHealth({ sha, sourceRoot, pointerPath, fetchImpl = globalThis.fetch, sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), attempts = HEALTH_ATTEMPTS }) {
  const pointer = await readEquinoxLocalMainSourcePointer(pointerPath);
  if (pointer.sha !== sha || pointer.sourceRoot !== sourceRoot) throw new Error("Main update source pointer does not match the expected runtime identity.");
  const checkout = await inspectCanonicalMainCheckout(sourceRoot);
  if (!checkout.eligible || checkout.currentSha !== sha) throw new Error("Main update runtime checkout does not match the expected canonical SHA.");
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchImpl(EQUINOX_LOCAL_CONTROL_CENTER_STATUS_URL, { method: "GET", redirect: "error", cache: "no-store", credentials: "omit", headers: { accept: "application/json" } });
      if (!response?.ok) throw new Error(`HTTP ${response?.status ?? "unknown"}`);
      const body = await response.json();
      if (body?.status?.health?.state === "HEALTHY") return true;
      throw new Error(`health=${body?.status?.health?.state ?? "unknown"}`);
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await sleepImpl(HEALTH_DELAY_MS);
    }
  }
  throw new Error(`Main update runtime did not become healthy: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}



export async function runEquinoxLocalMainUpdateWorker({
  argv = process.argv.slice(2),
  execFileImpl = execFile,
  fetchImpl = globalThis.fetch,
  sleepImpl,
  fsImpl = fs,
  env = process.env,
  uid = process.getuid?.(),
  engineFactory = (options) => createEquinoxLocalMainUpdateTransactionEngine(options),
  resolveHostTarget = () => equinoxLocalReleaseTarget(),
  planNativeTransition = planEquinoxLocalMainNativeTransition,
  prepareNativeCandidate = prepareEquinoxLocalMainNativeCandidate,
  prepareNativeLifecycle = prepareEquinoxLocalMainNativeLifecycle,
  recoverNativeLifecycle = recoverEquinoxLocalMainNativeLifecycle,
  handoffImpl = runEquinoxLocalMainUpdateHandoff,
  restartRuntimeImpl = (value) => restartSourceRuntime({ ...value, execFileImpl, env }),
  verifyRuntimeImpl,
  cleanupImpl = (value) => cleanupEquinoxLocalMainUpdateWorkerOwnership({ ...value, execFileImpl, fsImpl, uid }),
} = {}) {
  const args = parseArgs(argv);
  try {
    const engine = engineFactory({ sourceRoot: args.sourceRoot, transactionRoot: args.transactionRoot });
    let active = await engine.readActive();
    if (!active || active.transactionId !== args.transactionId) throw new Error("Main update worker does not own the active transaction.");
    if (["succeeded", "rolled_back"].includes(active.status)) {
      await engine.releaseStagedLock(args.transactionId);
      return Object.freeze({ status: active.status, receipt: active, recovered: true });
    }
    if (active.status === "rollback_failed") throw new Error("Main update worker cannot resume a transaction whose rollback already failed.");
    const resumable = new Set([
      "promoting:ready_to_switch",
      "promoting:native_rollback_ready",
      "promoting:native_switched",
      "verifying:source_switched",
      "verifying:rollback_source_restored",
      "verifying:rollback_native_restored",
    ]);
    if (!resumable.has(`${active.status}:${active.stage}`)) throw new Error("Main update worker requires a resumable promotion receipt.");
    const initialStage = active.stage;
    let nativeTransition;
    let nativeLifecycle = null;
    try {
      const target = resolveHostTarget();
      nativeTransition = await planNativeTransition({
        currentRoot: active.rollbackSourceRoot,
        currentSha: active.currentSha,
        targetRoot: active.targetSourceRoot,
        targetSha: active.targetSha,
        target,
      });
      if (nativeTransition?.mode === "artifact_required") {
        if (initialStage === "ready_to_switch") {
          const candidate = await prepareNativeCandidate({
            sourceSha: active.targetSha,
            target,
            expectedRuntimeContractSha256: nativeTransition.targetRuntimeContractSha256,
            transactionRoot: args.transactionRoot,
            transactionId: args.transactionId,
            fsImpl,
            execFileImpl,
          });
          nativeLifecycle = await prepareNativeLifecycle({
            transition: nativeTransition,
            candidate,
            transactionRoot: args.transactionRoot,
            transactionId: args.transactionId,
            fsImpl,
            execFileImpl,
            env,
          });
          active = await engine.markNativeRollbackReady(args.transactionId);
        } else {
          nativeLifecycle = await recoverNativeLifecycle({
            transition: nativeTransition,
            transactionRoot: args.transactionRoot,
            transactionId: args.transactionId,
            fsImpl,
            execFileImpl,
            env,
          });
        }
      } else if (nativeTransition?.mode === "reuse_native") {
        if (["native_rollback_ready", "native_switched", "rollback_source_restored", "rollback_native_restored"].includes(initialStage)) {
          throw new Error("Main update native receipt stage is incompatible with reuse_native recovery.");
        }
      } else {
        throw new Error("Main native transition mode is unsupported.");
      }
    } catch (error) {
      if (initialStage === "ready_to_switch") {
        await engine.abortPreparedPromotion(args.transactionId, errorMessage(error), { stage: "native_admission_failed" }).catch(() => {});
      } else {
        await engine.markRollbackFailed(args.transactionId, errorMessage(error)).catch(() => {});
      }
      throw error;
    }
    const verify = typeof verifyRuntimeImpl === "function"
      ? verifyRuntimeImpl
      : (value) => waitForExactSourceHealth({ ...value, pointerPath: engine.paths.sourcePointerPath, fetchImpl, sleepImpl });
    return await handoffImpl({
      engine,
      transactionId: args.transactionId,
      nativeTransition,
      nativeLifecycle,
      initialReceipt: active,
      restartRuntime: restartRuntimeImpl,
      verifyRuntime: verify,
    });
  } finally {
    await cleanupImpl({ transactionId: args.transactionId, transactionRoot: args.transactionRoot });
  }
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invoked && import.meta.url === invoked) {
  runEquinoxLocalMainUpdateWorker().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
