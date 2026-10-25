import fs from 'node:fs/promises';
import path from 'node:path';

import {
  assertWindowsNativeMessagingHostOwnership,
  registerWindowsNativeMessagingHost,
  windowsNativeMessagingLauncherPath,
} from './equinox-browser-windows-native-messaging.js';
import { readEquinoxLocalMainNativePointer, writeEquinoxLocalMainNativePointer } from './equinox-local-main-native-state.js';
import { createWindowsJournaledNativeABLifecycle } from './equinox-local-windows-native-ab-journal-lifecycle.js';
import { requestEquinoxWindowsOwnedNativeShellHealth } from './equinox-local-windows-native-journal-authority-client.js';


type NativeFs = typeof fs;
type NativeTransition = Readonly<{
  target:string;currentSha:string;targetSha:string;
  currentRuntimeContractSha256:string;targetRuntimeContractSha256:string;
}>;
type Stored = Readonly<{sourceSha:string;target:string;runtimeContractSha256:string;releaseDir:string}>;
type BoundOwner = Readonly<{
  independentNativeOwner:true;
  assertWorkerOwnership:(values:Record<string,unknown>)=>Promise<unknown>;
  shutdownOwnedWpf:(values:Record<string,unknown>)=>Promise<unknown>;
  quiesceOwnedB:(values:Record<string,unknown>)=>Promise<unknown>;
  verifyNativeMessaging:(values:Record<string,unknown>)=>Promise<unknown>;
  verifySustainedHealth:(values:Record<string,unknown>)=>Promise<unknown>;
}>;
type BoundAdmission = Readonly<{
  admitted:true;
  record:Readonly<{transactionId:string;target:string;currentSha:string;targetSha:string;
    targetRuntimeContractSha256:string;receiptStartedAt:string}>;
  journal:Readonly<{read:(...args:unknown[])=>Promise<unknown>;advance:(...args:unknown[])=>Promise<unknown>}>;
  supervisor:BoundOwner;
}>;
type SupervisorOptions = {windowsAdmission?:unknown;transition?:unknown;transactionId?:unknown};
type BoundOptions = SupervisorOptions & {
  stored?:Stored;previousPointer?:unknown;previousReleaseDir?:string;programRoot?:string;
  manifestRoot?:string;transactionRoot?:string;pointerPath?:string;
  fsImpl?:NativeFs;execFileImpl?:unknown;env?:NodeJS.ProcessEnv;
  writePointerImpl?:typeof writeEquinoxLocalMainNativePointer;
  readPointerImpl?:typeof readEquinoxLocalMainNativePointer;
  assertNativeHostImpl?:typeof assertWindowsNativeMessagingHostOwnership;
  registerNativeHostImpl?:typeof registerWindowsNativeMessagingHost;
  launcherPathImpl?:(releaseDir:string)=>string;
  createLifecycleImpl?:typeof createWindowsJournaledNativeABLifecycle;
  verifySignedGuardianHealthImpl?:typeof requestEquinoxWindowsOwnedNativeShellHealth;
};
function matches(pattern:RegExp,value:unknown):boolean {
  return typeof value === "string" && pattern.test(value);
}
function recordOrNull(value:unknown):Record<string,unknown>|null {
  return value!==null && typeof value==="object" && !Array.isArray(value)
    ? value as Record<string,unknown> : null;
}

const SHA = /^[a-f0-9]{40}$/u;
const TX = /^main-[a-f0-9]{32}$/u;

// This is a composition seam into the SINGLE shared Main handoff engine.
// A real independent native supervisor MUST be supplied through an already
// OS/receipt-admitted worker handoff. No env flag, bare Node token, or legacy
// directory swap can grant these operations. In production today admission
// has NO supervisor, so native Windows upgrades remain deliberately blocked.
export function requireWindowsNativeABSupervisor({ windowsAdmission, transition, transactionId }:SupervisorOptions):BoundOwner {
  const admission = recordOrNull(windowsAdmission);
  const nativeTransition = recordOrNull(transition);
  const journal = recordOrNull(admission?.journal);
  const record = recordOrNull(admission?.record);
  const owner = recordOrNull(admission?.supervisor);
  if (admission?.admitted !== true ||
      !matches(TX, transactionId) ||
      record?.transactionId !== transactionId ||
      record?.target !== nativeTransition?.target ||
      record?.currentSha !== nativeTransition?.currentSha ||
      record?.targetSha !== nativeTransition?.targetSha ||
      record?.targetRuntimeContractSha256 !== nativeTransition?.targetRuntimeContractSha256 ||
      !matches(SHA, record?.currentSha) || !matches(SHA, record?.targetSha) ||
      typeof record?.receiptStartedAt !== 'string' ||
      typeof journal?.read !== 'function' ||
      typeof journal?.advance !== 'function' ||
      owner?.independentNativeOwner !== true ||
      !['assertWorkerOwnership', 'shutdownOwnedWpf', 'quiesceOwnedB', 'verifyNativeMessaging', 'verifySustainedHealth'].every((name) => typeof owner[name] === 'function')) {
    throw new Error('Windows native A/B refuses to replace WPF without independent supervisor ownership and exact journal identity.');
  }
  return owner as BoundOwner;
}

export function createSupervisorBoundWindowsNativeABLifecycle({
  windowsAdmission, transition, transactionId, stored, previousPointer,
  previousReleaseDir, programRoot, manifestRoot, transactionRoot, pointerPath,
  fsImpl = fs, execFileImpl, env = process.env,
  writePointerImpl = writeEquinoxLocalMainNativePointer,
  readPointerImpl = readEquinoxLocalMainNativePointer,
  assertNativeHostImpl = assertWindowsNativeMessagingHostOwnership,
  registerNativeHostImpl = registerWindowsNativeMessagingHost,
  launcherPathImpl = windowsNativeMessagingLauncherPath,
  createLifecycleImpl = createWindowsJournaledNativeABLifecycle,
  verifySignedGuardianHealthImpl = requestEquinoxWindowsOwnedNativeShellHealth,
}:BoundOptions = {}) {
  const supervisor = requireWindowsNativeABSupervisor({ windowsAdmission, transition, transactionId });
  const admitted = windowsAdmission as BoundAdmission;
  const id = transactionId as string;
  const exactTransition = transition as NativeTransition;
  if (stored?.sourceSha !== exactTransition.targetSha || stored?.target !== exactTransition.target ||
      stored?.runtimeContractSha256 !== exactTransition.targetRuntimeContractSha256 ||
      typeof stored.releaseDir !== 'string' || !stored.releaseDir ||
      typeof previousReleaseDir !== 'string' || !previousReleaseDir ||
      typeof programRoot !== 'string' || !programRoot ||
      typeof manifestRoot !== 'string' || !manifestRoot) {
    throw new Error('Windows supervisor native A/B release roots are not pinned to admitted native identities.');
  }
  const previousLauncher = launcherPathImpl(previousReleaseDir);
  const targetLauncher = launcherPathImpl(stored.releaseDir);
  const prior = previousPointer === null || previousPointer === undefined
    ? null : recordOrNull(previousPointer);
  if ((previousPointer !== null && previousPointer !== undefined && prior === null) ||
      (prior && (prior.sourceSha !== exactTransition.currentSha ||
        prior.target !== exactTransition.target ||
        prior.runtimeContractSha256 !== exactTransition.currentRuntimeContractSha256)) ||
      typeof pointerPath !== 'string' || typeof transactionRoot !== 'string' ||
      path.resolve(pointerPath) !== path.join(path.resolve(transactionRoot), 'current-native.json')) {
    throw new Error('Windows native A rollback pointer is not the exact original Main identity.');
  }
  const ownerArgs = Object.freeze({ transactionId: id, currentSha: exactTransition.currentSha, targetSha: exactTransition.targetSha, target: exactTransition.target });
  const pointer = Object.freeze({ schemaVersion: 1, channel: 'main', sourceSha: exactTransition.targetSha, target: exactTransition.target, runtimeContractSha256: exactTransition.targetRuntimeContractSha256 });
  const assertLiveOwner = async () => {
    if (await supervisor.assertWorkerOwnership(ownerArgs) !== true) {
      throw new Error('Independent Windows native worker ownership expired before side effect.');
    }
    return true as const;
  };
  // This does NOT grant native admission. Only the already-admitted signed
  // Guardian OS owner may independently certify that an exact live WPF B or
  // restored A survived sustained process/pipe/NTFS identity observations.
  // In addition, the existing supervisor and Main SHA/HTTP health gates stay
  // mandatory; Node's environment token alone has NO authorization.
  const proveSignedNativeHealth = async (release:'A'|'B', sourceSha:string) => {
    await assertLiveOwner();
    if (await supervisor.verifySustainedHealth({
      ...ownerArgs, release, sourceSha, programRoot,
    }) !== true) return false;
    const workerToken = env.EQUINOX_LOCAL_MAIN_WORKER_TOKEN;
    if (typeof workerToken !== 'string' || !/^[a-f0-9]{64}$/u.test(workerToken)) {
      throw new Error('Signed native WPF health requires the original owned worker token.');
    }
    await verifySignedGuardianHealthImpl({
      transactionId: id, transactionRoot, workerToken, platform:'win32', release,
    });
    await assertLiveOwner();
    return true;
  };
  const proveNativeMessaging = async (release:'A'|'B') => {
    const launcher = release === 'B' ? targetLauncher : previousLauncher;
    await assertNativeHostImpl({ manifestRoot, acceptedLauncherPaths: [launcher], execFileAsync: execFileImpl, fsImpl, env });
    return (await supervisor.verifyNativeMessaging({ ...ownerArgs, release, launcher, manifestRoot })) === true;
  };
  const registerNativeMessaging = async (release:'A'|'B') => {
    const launcher = release === 'B' ? targetLauncher : previousLauncher;
    const old = release === 'B' ? previousLauncher : targetLauncher;
    // Idempotent crash recovery: exact target already installed is a no-op.
    try { if (await proveNativeMessaging(release)) return; }
    catch { /* Previous owner must still pass the exact expected-old gate. */ }
    await assertNativeHostImpl({ manifestRoot, acceptedLauncherPaths: [old], execFileAsync: execFileImpl, fsImpl, env });
    // OS-owned worker may exit between journal read and registry mutation.
    await assertLiveOwner();
    await registerNativeHostImpl({ manifestRoot, launcherPath: launcher, expectedPreviousLauncherPath: old, execFileAsync: execFileImpl, fsImpl, env });
    if (!await proveNativeMessaging(release)) throw new Error('Independent native supervisor did not verify the new Native Messaging owner.');
  };
  const adapter = createLifecycleImpl({
    transactionId: id, target: exactTransition.target,
    currentSha: exactTransition.currentSha, targetSha: exactTransition.targetSha,
    receiptStartedAt: admitted.record.receiptStartedAt,
    targetRuntimeContractSha256: exactTransition.targetRuntimeContractSha256,
    programRoot, previousReleaseDir, targetReleaseDir: stored.releaseDir,
    journal: admitted.journal, fsImpl,
    assertWorkerOwnership: assertLiveOwner,
    shutdownOwnedWpf: async ({ transactionId: id, programRoot: root }) => {
      await assertLiveOwner();
      return supervisor.shutdownOwnedWpf({ ...ownerArgs, transactionId: id, programRoot: root });
    },
    quiesceOwnedB: async ({ transactionId: id, programRoot: root, sourceSha }) => {
      await assertLiveOwner();
      if (await supervisor.quiesceOwnedB({ ...ownerArgs, transactionId: id, programRoot: root, release: 'B', sourceSha }) !== true) {
        throw new Error('Independent Windows native B shutdown proof is unavailable.');
      }
      await assertLiveOwner();
      return true;
    },
    verifyNativeMessaging: ({ release }) => proveNativeMessaging(release),
    registerNativeMessaging: ({ release }) => registerNativeMessaging(release),
    verifySustainedHealth: ({ release, sourceSha }) => proveSignedNativeHealth(release, sourceSha),
    restoreNativePointer: async () => {
      // This is the same authenticated rollback session that restored the
      // installed original A bytes and its Native Messaging owner. Do not
      // silently leave a B pointer after a failure between pointer commit
      // and the durable Main succeeded receipt.
      await assertLiveOwner();
      if (!await proveNativeMessaging('A')) {
        throw new Error('Original A Native Messaging owner is not verified before pointer restoration.');
      }
      const nativeOptions = { transactionRoot: transactionRoot!, fsImpl };
      let existing = null;
      let before = null;
      try {
        before = await fsImpl.lstat(pointerPath!);
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
          throw new Error('Native rollback pointer is not one normal owned file.');
        }
        existing = await readPointerImpl(pointerPath!, nativeOptions);
      } catch (error) {
        if (error === null || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
      }
      const same = (pointer:Record<string,unknown>, other:Record<string,unknown>) =>
        pointer.sourceSha === other.sourceSha &&
        pointer.target === other.target &&
        pointer.runtimeContractSha256 === other.runtimeContractSha256;
      const b = { sourceSha: exactTransition.targetSha,
        target: exactTransition.target,
        runtimeContractSha256: exactTransition.targetRuntimeContractSha256 };
      if (existing && !same(existing, b) && !(prior && same(existing, prior))) {
        throw new Error('Foreign native pointer blocks exact original A rollback.');
      }
      if (prior && existing && same(existing, prior)) return;
      if (!prior && !existing) return;
      // Recheck identity after the asynchronous owned Main/NM inspections.
      if (before) {
        const now = await fsImpl.lstat(pointerPath!);
        if (!now.isFile() || now.isSymbolicLink() || now.nlink !== 1 ||
            now.dev !== before.dev || now.ino !== before.ino ||
            now.size !== before.size || now.mtimeMs !== before.mtimeMs) {
          throw new Error('Native pointer changed ownership before original A rollback.');
        }
      }
      await assertLiveOwner();
      if (prior) {
        await writePointerImpl(pointerPath!, {
          schemaVersion: 1, channel: 'main', sourceSha: prior.sourceSha as string,
          target: prior.target as string, runtimeContractSha256: prior.runtimeContractSha256 as string,
        }, nativeOptions);
      } else {
        // Stable A had no Main-native pointer. Only the exact verified B
        // pointer may be retired, and only after original A is restored.
        await fsImpl.unlink(pointerPath!);
      }
      if (prior) {
        const restored = await readPointerImpl(pointerPath!, nativeOptions);
        if (!same(restored, prior)) throw new Error('Original A native pointer restoration did not persist.');
      } else {
        try {
          await fsImpl.lstat(pointerPath!);
          throw new Error('Stable A restoration left an active Main B native pointer.');
        } catch (error) {
          if (error === null || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
        }
      }
    },
    commitNativePointer: async () => {
      // A HEALTHY journal is historical evidence, not proof the owner and B
      // stayed healthy until the irreversible durable pointer write.
      await assertLiveOwner();
      if (!await proveNativeMessaging('B')) {
        throw new Error('Native B messaging owner expired before pointer commit.');
      }
      if (await proveSignedNativeHealth('B', exactTransition.targetSha) !== true) {
        throw new Error('Native B health expired before pointer commit.');
      }
      await assertLiveOwner();
      return writePointerImpl(pointerPath, pointer, { transactionRoot: transactionRoot!, fsImpl });
    },
  });
  return Object.freeze({ ...adapter,
    target: exactTransition.target, stored, previousPointer,
    windowsProgramRoot: programRoot,
    rollbackPath: previousReleaseDir,
    journal: admitted.journal,
  });
}
