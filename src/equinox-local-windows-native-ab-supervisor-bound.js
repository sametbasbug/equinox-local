import fs from 'node:fs/promises';

import {
  assertWindowsNativeMessagingHostOwnership,
  registerWindowsNativeMessagingHost,
  windowsNativeMessagingLauncherPath,
} from './equinox-browser-windows-native-messaging.js';
import { readEquinoxLocalMainNativePointer, writeEquinoxLocalMainNativePointer } from './equinox-local-main-native-state.js';
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
      (owner?.nativeOwnsMilestones === true
        ? typeof owner?.observeNativeMilestone !== 'function'
        : typeof windowsAdmission?.journal?.advance !== 'function') ||
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
  readPointerImpl = readEquinoxLocalMainNativePointer,
  removePointerImpl = (file) => fs.unlink(file),
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
  const oldPointer = previousPointer ? Object.freeze({ schemaVersion: 1, channel: 'main',
    sourceSha: previousPointer.sourceSha, target: previousPointer.target, runtimeContractSha256: previousPointer.runtimeContractSha256 }) : null;
  if (oldPointer && (oldPointer.sourceSha !== transition.currentSha || oldPointer.target !== transition.target ||
      oldPointer.runtimeContractSha256 !== transition.currentRuntimeContractSha256)) {
    throw new Error('Windows native runtime rollback pointer does not match admitted source A.');
  }
  async function exactPointer() {
    try { return await readPointerImpl(pointerPath, { transactionRoot, fsImpl }); }
    catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  }
  const matches = (a, b) => a?.sourceSha === b?.sourceSha && a?.target === b?.target &&
    a?.runtimeContractSha256 === b?.runtimeContractSha256 && (a !== null) === (b !== null);
  async function selectNativeRuntime({ release }) {
    const current = await exactPointer();
    const expected = release === 'B' ? pointer : oldPointer;
    const other = release === 'B' ? oldPointer : pointer;
    if (release !== 'A' && release !== 'B') throw new Error('Foreign native runtime selection.');
    if (matches(current, expected)) return;
    if (!matches(current, other)) throw new Error('Native runtime pointer is neither the expected old nor target identity.');
    if (expected) await writePointerImpl(pointerPath, expected, { transactionRoot, fsImpl });
    else await removePointerImpl(pointerPath);
    if (!matches(await exactPointer(), expected)) throw new Error('Native runtime pointer did not durably select the exact owned release.');
  }
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
    nativeOwnsMilestones: supervisor.nativeOwnsMilestones === true,
    observeNativeMilestone: supervisor.nativeOwnsMilestones === true
      ? ({ stage }) => supervisor.observeNativeMilestone({ ...ownerArgs, stage })
      : null,
    selectNativeRuntime,
    verifyNativeRuntime: async ({ release }) => (release === 'A' || release === 'B') &&
      matches(await exactPointer(), release === 'B' ? pointer : oldPointer),
  });
  return Object.freeze({ ...adapter,
    target: transition.target, stored, previousPointer,
    windowsProgramRoot: programRoot,
    rollbackPath: previousReleaseDir,
    journal: windowsAdmission.journal,
  });
}
