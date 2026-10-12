import fs from 'node:fs/promises';

import {
  assertWindowsNativeMessagingHostOwnership,
  registerWindowsNativeMessagingHost,
  windowsNativeMessagingLauncherPath,
} from './equinox-browser-windows-native-messaging.js';
import { writeEquinoxLocalMainNativePointer } from './equinox-local-main-native-state.js';
import { createWindowsJournaledNativeABLifecycle } from './equinox-local-windows-native-ab-journal-lifecycle.js';

const SHA = /^[a-f0-9]{40}$/u;
const TX = /^main-[a-f0-9]{32}$/u;

// This is a composition seam into the SINGLE shared Main handoff engine.
// A real independent native supervisor MUST be supplied through an already
// OS/receipt-admitted worker handoff. No env flag, bare Node token, or legacy
// directory swap can grant these operations. In production today admission
// has NO supervisor, so native Windows upgrades remain deliberately blocked.
export function requireWindowsNativeABSupervisor({ windowsAdmission, transition, transactionId }) {
  const record = windowsAdmission?.record;
  const owner = windowsAdmission?.supervisor;
  if (windowsAdmission?.admitted !== true ||
      !TX.test(transactionId ?? '') ||
      record?.transactionId !== transactionId ||
      record?.target !== transition?.target ||
      record?.currentSha !== transition?.currentSha ||
      record?.targetSha !== transition?.targetSha ||
      record?.targetRuntimeContractSha256 !== transition?.targetRuntimeContractSha256 ||
      !SHA.test(record?.currentSha ?? '') || !SHA.test(record?.targetSha ?? '') ||
      typeof record?.receiptStartedAt !== 'string' ||
      typeof windowsAdmission?.journal?.read !== 'function' ||
      typeof windowsAdmission?.journal?.advance !== 'function' ||
      owner?.independentNativeOwner !== true ||
      !['assertWorkerOwnership', 'shutdownOwnedWpf', 'verifyNativeMessaging', 'verifySustainedHealth'].every((name) => typeof owner[name] === 'function')) {
    throw new Error('Windows native A/B refuses to replace WPF without independent supervisor ownership and exact journal identity.');
  }
  return owner;
}

export function createSupervisorBoundWindowsNativeABLifecycle({
  windowsAdmission, transition, transactionId, stored, previousPointer,
  previousReleaseDir, programRoot, manifestRoot, transactionRoot, pointerPath,
  fsImpl = fs, execFileImpl, env = process.env,
  writePointerImpl = writeEquinoxLocalMainNativePointer,
  assertNativeHostImpl = assertWindowsNativeMessagingHostOwnership,
  registerNativeHostImpl = registerWindowsNativeMessagingHost,
  launcherPathImpl = windowsNativeMessagingLauncherPath,
  createLifecycleImpl = createWindowsJournaledNativeABLifecycle,
} = {}) {
  const supervisor = requireWindowsNativeABSupervisor({ windowsAdmission, transition, transactionId });
  if (stored?.sourceSha !== transition.targetSha || stored?.target !== transition.target ||
      stored?.runtimeContractSha256 !== transition.targetRuntimeContractSha256 ||
      typeof stored.releaseDir !== 'string' || !stored.releaseDir ||
      typeof previousReleaseDir !== 'string' || !previousReleaseDir ||
      typeof programRoot !== 'string' || !programRoot ||
      typeof manifestRoot !== 'string' || !manifestRoot) {
    throw new Error('Windows supervisor native A/B release roots are not pinned to admitted native identities.');
  }
  const previousLauncher = launcherPathImpl(previousReleaseDir);
  const targetLauncher = launcherPathImpl(stored.releaseDir);
  const ownerArgs = Object.freeze({ transactionId, currentSha: transition.currentSha, targetSha: transition.targetSha, target: transition.target });
  const pointer = Object.freeze({ schemaVersion: 1, channel: 'main', sourceSha: transition.targetSha, target: transition.target, runtimeContractSha256: transition.targetRuntimeContractSha256 });
  const proveNativeMessaging = async (release) => {
    const launcher = release === 'B' ? targetLauncher : previousLauncher;
    await assertNativeHostImpl({ manifestRoot, acceptedLauncherPaths: [launcher], execFileAsync: execFileImpl, fsImpl, env });
    return (await supervisor.verifyNativeMessaging({ ...ownerArgs, release, launcher, manifestRoot })) === true;
  };
  const registerNativeMessaging = async (release) => {
    const launcher = release === 'B' ? targetLauncher : previousLauncher;
    const old = release === 'B' ? previousLauncher : targetLauncher;
    // Idempotent crash recovery: exact target already installed is a no-op.
    try { if (await proveNativeMessaging(release)) return; }
    catch { /* Previous owner must still pass the exact expected-old gate. */ }
    await assertNativeHostImpl({ manifestRoot, acceptedLauncherPaths: [old], execFileAsync: execFileImpl, fsImpl, env });
    await registerNativeHostImpl({ manifestRoot, launcherPath: launcher, expectedPreviousLauncherPath: old, execFileAsync: execFileImpl, fsImpl, env });
    if (!await proveNativeMessaging(release)) throw new Error('Independent native supervisor did not verify the new Native Messaging owner.');
  };
  const adapter = createLifecycleImpl({
    transactionId, target: transition.target,
    currentSha: transition.currentSha, targetSha: transition.targetSha,
    receiptStartedAt: windowsAdmission.record.receiptStartedAt,
    targetRuntimeContractSha256: transition.targetRuntimeContractSha256,
    programRoot, previousReleaseDir, targetReleaseDir: stored.releaseDir,
    journal: windowsAdmission.journal, fsImpl,
    assertWorkerOwnership: () => supervisor.assertWorkerOwnership(ownerArgs),
    shutdownOwnedWpf: ({ transactionId: id, programRoot: root }) => supervisor.shutdownOwnedWpf({ ...ownerArgs, transactionId: id, programRoot: root }),
    verifyNativeMessaging: ({ release }) => proveNativeMessaging(release),
    registerNativeMessaging: ({ release }) => registerNativeMessaging(release),
    verifySustainedHealth: ({ release, sourceSha }) => supervisor.verifySustainedHealth({ ...ownerArgs, release, sourceSha, programRoot }),
    commitNativePointer: () => writePointerImpl(pointerPath, pointer, { transactionRoot, fsImpl }),
  });
  return Object.freeze({ ...adapter,
    target: transition.target, stored, previousPointer,
    windowsProgramRoot: programRoot,
    rollbackPath: previousReleaseDir,
    journal: windowsAdmission.journal,
  });
}
