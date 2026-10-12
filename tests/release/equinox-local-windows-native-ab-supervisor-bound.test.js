import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';

import { prepareEquinoxLocalMainNativeLifecycle } from '../../src/equinox-local-main-native-activation.js';
import { recoverEquinoxLocalMainNativeLifecycle } from '../../src/equinox-local-main-native-recovery.js';
import {
  createSupervisorBoundWindowsNativeABLifecycle,
  requireWindowsNativeABSupervisor,
} from '../../src/equinox-local-windows-native-ab-supervisor-bound.js';

const A = 'a'.repeat(40), B = 'b'.repeat(40);
const CA = 'c'.repeat(64), CB = 'd'.repeat(64);
const ID = `main-${'7'.repeat(32)}`;
const target = 'win32-x64';
const TEST_TX_ROOT = path.join(os.homedir(), '.equinox-unit-native-ab-state');
const transition = { mode: 'artifact_required', target, currentSha: A, targetSha: B, currentRuntimeContractSha256: CA, targetRuntimeContractSha256: CB };
const oldRelease = 'C:\\Equinox\\releases\\6.0.4';
const newRelease = `C:\\Equinox\\state\\native-store\\${target}\\${B}\\release`;
const install = { managed: true, selfUpdateSupported: true, target, platform: 'win32', releaseDir: oldRelease,
  releasesRoot: 'C:\\Equinox\\releases', programRoot: 'C:\\Equinox\\Programs\\Equinox Local', nativeMessagingManifestRoot: 'C:\\Equinox\\NativeMessaging' };
const journal = { read: async () => ({}), advance: async () => ({}) };
function admitted(extra = {}) {
  return { admitted: true, journal,
    record: { transactionId: ID, target, currentSha: A, targetSha: B, targetRuntimeContractSha256: CB, receiptStartedAt: '2026-10-12T12:00:00.000Z' },
    supervisor: { independentNativeOwner: true,
      assertWorkerOwnership: async () => true,
      shutdownOwnedWpf: async () => true,
      verifyNativeMessaging: async () => true,
      verifySustainedHealth: async () => true }, ...extra };
}

test('Windows native lifecycle admission without independent supervisor cannot promote inactive payload or touch WPF', async () => {
  let prepared = false;
  const bad = admitted({ supervisor: undefined });
  assert.throws(() => requireWindowsNativeABSupervisor({ windowsAdmission: bad, transition, transactionId: ID }), /independent supervisor/u);
  await assert.rejects(prepareEquinoxLocalMainNativeLifecycle({
    transition, transactionId: ID, transactionRoot: TEST_TX_ROOT,
    candidate: { sourceSha: B, target, runtimeContractSha256: CB }, installation: install,
    windowsAdmission: bad,
    promoteCandidateImpl: async () => { prepared = true; throw Error('unexpected promotion'); },
  }), /independent supervisor/u);
  assert.equal(prepared, false);
  for (const extra of [{ record: { ...admitted().record, targetSha: A } }, { admitted: false }, { journal: {} },
    { supervisor: { independentNativeOwner: true } }]) {
    assert.throws(() => requireWindowsNativeABSupervisor({ windowsAdmission: admitted(extra), transition, transactionId: ID }), /independent supervisor/u);
  }
});

test('real prepare lifecycle binds stored A/B source/native identities, journal and pointer through supervisor instead of legacy random backup', async () => {
  const events = [], admission = admitted();
  const candidate = { sourceSha: B, target, runtimeContractSha256: CB };
  const lc = await prepareEquinoxLocalMainNativeLifecycle({
    transition, candidate, transactionId: ID, transactionRoot: TEST_TX_ROOT, installation: install,
    windowsAdmission: admission,
    promoteCandidateImpl: async () => ({ sourceSha: B, target, runtimeContractSha256: CB, releaseDir: newRelease }),
    readPointerImpl: async () => { throw Object.assign(Error('absent Stable native pointer'), { code: 'ENOENT' }); },
    snapshotWindowsImpl: async () => events.push('snapshot-old-A'),
    writeRecoveryDescriptorImpl: async () => events.push('write-recovery-descriptor'),
    activateWindowsImpl: async () => assert.fail('legacy native switch must never run'),
    createBoundWindowsABImpl: (options) => {
      events.push('bind-journaled-native-lifecycle');
      assert.equal(options.windowsAdmission, admission);
      assert.equal(options.previousReleaseDir, oldRelease);
      assert.equal(options.stored.releaseDir, newRelease);
      assert.equal(options.transition.targetSha, B);
      return Object.freeze({ journaledAB: true, journal: admission.journal, windowsProgramRoot: install.programRoot, rollbackPath: oldRelease });
    },
  });
  assert.equal(lc.journaledAB, true);
  assert.equal(lc.journal, admission.journal);
  assert.deepEqual(events, ['snapshot-old-A', 'write-recovery-descriptor', 'bind-journaled-native-lifecycle']);
});

test('recovered Windows native lifecycle binds exactly prior Stable release from immutable descriptor to the SAME journal', async () => {
  const admission = admitted();
  const lc = await recoverEquinoxLocalMainNativeLifecycle({
    transition, transactionId: ID, transactionRoot: TEST_TX_ROOT, installation: install, windowsAdmission: admission,
    readDescriptorImpl: async () => ({ previous: { kind: 'stable', version: '6.0.4' } }),
    inspectStoredReleaseImpl: async () => ({ sourceSha: B, target, runtimeContractSha256: CB, releaseDir: newRelease }),
    inspectWindowsSnapshotImpl: async () => {},
    activateWindowsImpl: async () => assert.fail('legacy recovery WPF swap not permitted'),
    createBoundWindowsABImpl: (options) => {
      assert.equal(options.previousReleaseDir, oldRelease);
      assert.equal(options.windowsAdmission, admission);
      return { journaledAB: true, journal: admission.journal, rollbackPath: oldRelease };
    },
  });
  assert.equal(lc.journaledAB, true);
});

test('supervisor-bound native host selects and reverts exact runtime pointer only after admitted owner', async () => {
  const calls = [];
  const admission = admitted({ supervisor: { independentNativeOwner: true,
    assertWorkerOwnership: async () => true,
    shutdownOwnedWpf: async () => { calls.push('shutdown-WPF'); },
    verifyNativeMessaging: async ({ release }) => release === 'B',
    verifySustainedHealth: async ({ sourceSha }) => sourceSha === B,
  } });
  let registered = oldRelease;
  let registeredPointer = null;
  const launcher = (value) => `${value}\\runtime\\browser\\host.exe`;
  const adapter = createSupervisorBoundWindowsNativeABLifecycle({
    transition, transactionId: ID, stored: { sourceSha: B, target, runtimeContractSha256: CB, releaseDir: newRelease },
    windowsAdmission: admission, previousReleaseDir: oldRelease,
    programRoot: install.programRoot, manifestRoot: install.nativeMessagingManifestRoot,
    transactionRoot: TEST_TX_ROOT, pointerPath: path.join(TEST_TX_ROOT, 'current-native.json'),
    launcherPathImpl: launcher,
    assertNativeHostImpl: async ({ acceptedLauncherPaths }) => {
      if (acceptedLauncherPaths[0] !== launcher(registered)) throw Error('host not installed at exact allowed launcher');
    },
    registerNativeHostImpl: async ({ launcherPath, expectedPreviousLauncherPath }) => {
      assert.equal(expectedPreviousLauncherPath, launcher(oldRelease));
      registered = newRelease;
      calls.push('registered-B');
      assert.equal(launcherPath, launcher(newRelease));
    },
    readPointerImpl: async () => { if (!registeredPointer) throw Object.assign(new Error('missing native pointer'), { code: 'ENOENT' }); return registeredPointer; },
    writePointerImpl: async (_path, value) => { assert.equal(value.sourceSha, B); registeredPointer = value; calls.push('pointer-B'); },
    removePointerImpl: async () => { registeredPointer = null; calls.push('pointer-removed-A'); },
    createLifecycleImpl: (args) => {
      assert.equal(args.journal, journal);
      assert.equal(args.previousReleaseDir, oldRelease);
      assert.equal(args.targetReleaseDir, newRelease);
      return { journaledAB: true, selectRuntime: async ({ rollback }) => {
        await args.selectNativeRuntime({ release: rollback ? 'A' : 'B' });
        assert.equal(await args.verifyNativeRuntime({ release: rollback ? 'A' : 'B' }), true);
      }, activate: async () => {
        await args.assertWorkerOwnership();
        await args.shutdownOwnedWpf({ transactionId: ID, programRoot: install.programRoot });
        await args.registerNativeMessaging({ release: 'B' });
        assert.equal(await args.verifyNativeMessaging({ release: 'B' }), true);
        assert.equal(await args.verifySustainedHealth({ release: 'B', sourceSha: B }), true);
      } };
    },
  });
  assert.equal(adapter.journaledAB, true);
  assert.equal(adapter.rollbackPath, oldRelease);
  assert.deepEqual(calls, []);
  await adapter.activate();
  await adapter.selectRuntime({ rollback: false });
  await adapter.selectRuntime({ rollback: false }); // Restart replay is exact no-op.
  assert.deepEqual(calls, ['shutdown-WPF', 'registered-B', 'pointer-B']);
  await adapter.selectRuntime({ rollback: true });
  assert.equal(registeredPointer, null);
  assert.deepEqual(calls, ['shutdown-WPF', 'registered-B', 'pointer-B', 'pointer-removed-A']);
});

test('native runtime selector refuses foreign or mismatched A/B pointers without writing or deleting state', async () => {
  let pointer = { schemaVersion: 1, channel: 'main', sourceSha: 'e'.repeat(40), target, runtimeContractSha256: CA };
  let mutations = 0;
  const adapter = createSupervisorBoundWindowsNativeABLifecycle({
    transition, transactionId: ID, stored: { sourceSha: B, target, runtimeContractSha256: CB, releaseDir: newRelease },
    windowsAdmission: admitted(), previousReleaseDir: oldRelease,
    programRoot: install.programRoot, manifestRoot: install.nativeMessagingManifestRoot,
    transactionRoot: TEST_TX_ROOT, pointerPath: path.join(TEST_TX_ROOT, 'current-native.json'),
    readPointerImpl: async () => pointer,
    writePointerImpl: async () => { mutations++; },
    removePointerImpl: async () => { mutations++; },
    createLifecycleImpl: ({ selectNativeRuntime }) => ({
      selectRuntime: ({ rollback }) => selectNativeRuntime({ release: rollback ? 'A' : 'B' }),
    }),
  });
  await assert.rejects(adapter.selectRuntime({ rollback: false }), /neither the expected old nor target/u);
  await assert.rejects(adapter.selectRuntime({ rollback: true }), /neither the expected old nor target/u);
  assert.equal(mutations, 0);
  pointer = { schemaVersion: 1, channel: 'main', sourceSha: A, target, runtimeContractSha256: CA };
  assert.throws(() => createSupervisorBoundWindowsNativeABLifecycle({
    transition, transactionId: ID, stored: { sourceSha: B, target, runtimeContractSha256: CB, releaseDir: newRelease },
    previousPointer: { sourceSha: A, target, runtimeContractSha256: CB },
    windowsAdmission: admitted(), previousReleaseDir: oldRelease,
    programRoot: install.programRoot, manifestRoot: install.nativeMessagingManifestRoot,
    transactionRoot: TEST_TX_ROOT, pointerPath: path.join(TEST_TX_ROOT, 'current-native.json'),
  }), /does not match admitted source A/u);
  assert.equal(mutations, 0);
});

test('native selection advances pre-existing exact A pointer to B and recovers A after B failure', async () => {
  const previousPointer = { schemaVersion: 1, channel: 'main', sourceSha: A, target, runtimeContractSha256: CA };
  let current = previousPointer;
  const writes = [];
  const lc = createSupervisorBoundWindowsNativeABLifecycle({
    transition, transactionId: ID, stored: { sourceSha: B, target, runtimeContractSha256: CB, releaseDir: newRelease },
    previousPointer, windowsAdmission: admitted(), previousReleaseDir: oldRelease,
    programRoot: install.programRoot, manifestRoot: install.nativeMessagingManifestRoot,
    transactionRoot: TEST_TX_ROOT, pointerPath: path.join(TEST_TX_ROOT, 'current-native.json'),
    readPointerImpl: async () => current,
    writePointerImpl: async (_file, selected) => { writes.push(selected.sourceSha); current = selected; },
    removePointerImpl: async () => assert.fail('existing A pointer may never be deleted'),
    createLifecycleImpl: ({ selectNativeRuntime, verifyNativeRuntime }) => ({
      selectRuntime: async ({ rollback }) => {
        const release = rollback ? 'A' : 'B';
        await selectNativeRuntime({ release });
        assert.equal(await verifyNativeRuntime({ release }), true);
      },
    }),
  });
  await lc.selectRuntime({ rollback: false });
  assert.equal(current.sourceSha, B);
  await lc.selectRuntime({ rollback: false });
  await lc.selectRuntime({ rollback: true });
  assert.equal(current.sourceSha, A);
  assert.deepEqual(writes, [B, A]);
});
