import path from "node:path";

import { createEquinoxLocalMainUpdateTransactionEngine } from "./equinox-local-main-update-transaction.js";
import { inspectEquinoxLocalMainUpdateWorkerOwnership, cleanupEquinoxLocalMainUpdateWorkerOwnership } from "./equinox-local-main-update-scheduler.js";
import { readEquinoxLocalMainSourcePointer } from "./equinox-local-main-source-pointer.js";
import { inspectCanonicalMainCheckout } from "./equinox-local-main-update.js";
import { waitForExactSourceHealth } from "./equinox-local-main-update-worker.js";
import { readManagedCurrentRelease } from "./equinox-local-update-activation.js";
import { assertWindowsStableShellOwnedByRelease } from "./equinox-local-windows-stable-shell.js";
import { assertWindowsNativeMessagingHostOwnership, windowsNativeMessagingLauncherPath } from "./equinox-browser-windows-native-messaging.js";

import type { MainRecoveryEngine } from "./equinox-local-main-update-transaction.js";
import type { MainWorkerIdentity, MainWorkerCleanup } from "./equinox-local-main-update-scheduler.js";

type RecoveryInstallation = {
  readonly platform: string;
  readonly kind: string;
  readonly managed: boolean;
  readonly selfUpdateSupported: boolean;
  readonly gitPath: string;
  readonly mainTransactionRoot: string;
  readonly sourceRoot: string;
  readonly programRoot: string;
  readonly nativeMessagingManifestRoot: string;
  readonly releaseDir?: string;
};
type RecoveredHashes = Readonly<{transactionId: string; originalSha: string; failedTargetSha: string}>;
type RecoveryOptions = {
  installation?: RecoveryInstallation;
  apply?: boolean;
  engineFactory?: (options: {sourceRoot: string; transactionRoot: string; gitPath: string}) => MainRecoveryEngine;
  inspectWorker?: (options: {transactionId: string; transactionRoot: string}) => Promise<MainWorkerIdentity>;
  cleanupWorker?: (options: {transactionId: string; transactionRoot: string}) => Promise<MainWorkerCleanup>;
  readPointer?: typeof readEquinoxLocalMainSourcePointer;
  inspectCheckout?: typeof inspectCanonicalMainCheckout;
  readRelease?: typeof readManagedCurrentRelease;
  verifyShell?: typeof assertWindowsStableShellOwnedByRelease;
  verifyNativeHost?: typeof assertWindowsNativeMessagingHostOwnership;
  verifyHealth?: typeof waitForExactSourceHealth;
};


// This is an *offline operator recovery*, not part of normal startup/update.
// Never automatically turn an unknown failed rollback into a successful update.
export async function recoverVerifiedWindowsMainFailedRollback({
  installation,
  apply = false,
  engineFactory = createEquinoxLocalMainUpdateTransactionEngine,
  inspectWorker = inspectEquinoxLocalMainUpdateWorkerOwnership,
  cleanupWorker = cleanupEquinoxLocalMainUpdateWorkerOwnership,
  readPointer = readEquinoxLocalMainSourcePointer,
  inspectCheckout = inspectCanonicalMainCheckout,
  readRelease = readManagedCurrentRelease,
  verifyShell = assertWindowsStableShellOwnedByRelease,
  verifyNativeHost = assertWindowsNativeMessagingHostOwnership,
  verifyHealth = waitForExactSourceHealth,
}: RecoveryOptions = {}) {
  if (installation?.platform !== "win32" || installation?.kind !== "managed-source" ||
      installation?.managed !== true || installation?.selfUpdateSupported !== true ||
      typeof installation.gitPath !== "string" || !path.win32.isAbsolute(installation.gitPath) ||
      typeof installation.mainTransactionRoot !== "string" || !path.win32.isAbsolute(installation.mainTransactionRoot) ||
      typeof installation.sourceRoot !== "string" || !path.win32.isAbsolute(installation.sourceRoot) ||
      typeof installation.programRoot !== "string" || !path.win32.isAbsolute(installation.programRoot) ||
      typeof installation.nativeMessagingManifestRoot !== "string" || !path.win32.isAbsolute(installation.nativeMessagingManifestRoot)) {
    throw new Error("Failed rollback recovery requires an owned Windows managed-source installation.");
  }
  const sourceRoot = installation.sourceRoot;
  const transactionRoot = installation.mainTransactionRoot;
  const engine = engineFactory({ sourceRoot, transactionRoot, gitPath: installation.gitPath });
  const audit = async (): Promise<RecoveredHashes> => {
    const active = await engine.readActive();
    if (!active || active.status !== "rollback_failed" || active.stage !== "rollback_failed") {
      throw new Error("There is no exact rollback_failed Main transaction to recover.");
    }
    if (active.currentSha !== active.rollbackSha || active.rollbackSourceRoot !== sourceRoot ||
        active.currentSha === active.targetSha || !active.targetSourceRoot ||
        path.win32.dirname(active.targetSourceRoot).toLowerCase() !== path.win32.join(transactionRoot, "sources").toLowerCase() ||
        path.win32.basename(active.targetSourceRoot) !== active.targetSha) {
      throw new Error("Failed rollback recovery receipt does not own its original and target source stores.");
    }
    const worker = await inspectWorker({ transactionId: active.transactionId, transactionRoot });
    if (!worker || worker.running !== false || worker.uncertain || worker.stale === false && worker.loaded === true) {
      throw new Error("Failed rollback recovery cannot prove the detached update worker has stopped.");
    }
    const pointer = await readPointer(engine.paths.sourcePointerPath, { gitPath: installation.gitPath });
    const checkout = await inspectCheckout(sourceRoot, { gitPath: installation.gitPath });
    if (pointer.sha !== active.rollbackSha || pointer.sourceRoot !== sourceRoot ||
        checkout?.eligible !== true || checkout.currentSha !== active.rollbackSha) {
      throw new Error("Failed rollback recovery source pointer or checkout differs from original SHA.");
    }
    const current = await readRelease(installation);
    if (typeof current?.releaseDir !== "string" || !path.win32.isAbsolute(current.releaseDir) ||
        current.releaseDir.toLowerCase() !== installation.releaseDir?.toLowerCase()) {
      throw new Error("Failed rollback recovery native current release identity changed.");
    }
    const owned = await verifyShell({ releaseDir: current.releaseDir, programRoot: installation.programRoot });
    if (owned?.owned !== true || path.win32.normalize(owned.shellExecutable).toLowerCase() !==
        path.win32.join(installation.programRoot, "EquinoxLocal.exe").toLowerCase()) {
      throw new Error("Failed rollback recovery Windows shell ownership cannot be proved.");
    }
    const native = await verifyNativeHost({
      manifestRoot: installation.nativeMessagingManifestRoot,
      acceptedLauncherPaths: [windowsNativeMessagingLauncherPath(current.releaseDir)],
    });
    if (!native || path.win32.normalize(native.launcherPath).toLowerCase() !==
        windowsNativeMessagingLauncherPath(current.releaseDir).toLowerCase()) {
      throw new Error("Failed rollback recovery Native Messaging host ownership cannot be proved.");
    }
    const healthy = await verifyHealth({
      sha: active.rollbackSha, sourceRoot, pointerPath: engine.paths.sourcePointerPath,
      gitPath: installation.gitPath, attempts: 1,
    });
    if (healthy !== true) throw new Error("Failed rollback recovery runtime health is not proven.");
    return Object.freeze({ transactionId: active.transactionId, originalSha: active.rollbackSha, failedTargetSha: active.targetSha });
  };
  const inspected = await audit();
  if (!apply) return Object.freeze({ status: "verified_dry_run", ...inspected });
  const cleaned = await cleanupWorker({ transactionId: inspected.transactionId, transactionRoot });
  if (!cleaned || cleaned.cleaned !== true) throw new Error("Failed rollback recovery refused to clean detached worker ownership.");
  // Re-verify all identities after cleanup. Failure leaves the lock intact.
  const verified = await audit();
  if (verified.transactionId !== inspected.transactionId || verified.originalSha !== inspected.originalSha ||
      verified.failedTargetSha !== inspected.failedTargetSha) throw new Error("Failed rollback recovery transaction changed between audits.");
  await engine.archiveVerifiedFailedRollbackLock(verified.transactionId, {
    currentSha: verified.originalSha, targetSha: verified.failedTargetSha,
  });
  return Object.freeze({ status: "recovered", ...verified });
}
