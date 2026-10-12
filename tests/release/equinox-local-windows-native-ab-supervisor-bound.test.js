import assert from 'node:assert/strict';
import test from 'node:test';

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
    transition, transactionId: ID, transactionRoot: '/tmp/main-state',
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
    transition, candidate, transactionId: ID, transactionRoot: '/tmp/main-state', installation: install,
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
    transition, transactionId: ID, transactionRoot: '/tmp/main-state', installation: install, windowsAdmission: admission,
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

test('supervisor-bound native host registers exact launcher and makes pointer commit explicit, never on binding', async () => {
  const calls = [];
  const admission = admitted({ supervisor: { independentNativeOwner: true,
    assertWorkerOwnership: async () => true,
    shutdownOwnedWpf: async () => { calls.push('shutdown-WPF'); },
    verifyNativeMessaging: async ({ release }) => release === 'B',
    verifySustainedHealth: async ({ sourceSha }) => sourceSha === B,
  } });
  let registered = oldRelease;
  const launcher = (value) => `${value}\\runtime\\browser\\host.exe`;
  const adapter = createSupervisorBoundWindowsNativeABLifecycle({
    transition, transactionId: ID, stored: { sourceSha: B, target, runtimeContractSha256: CB, releaseDir: newRelease },
    windowsAdmission: admission, previousReleaseDir: oldRelease,
    programRoot: install.programRoot, manifestRoot: install.nativeMessagingManifestRoot,
    transactionRoot: '/tmp/main-state', pointerPath: '/tmp/main-state/current-native.json',
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
    writePointerImpl: async (_path, value) => { assert.equal(value.sourceSha, B); calls.push('pointer-B'); },
    createLifecycleImpl: (args) => {
      assert.equal(args.journal, journal);
      assert.equal(args.previousReleaseDir, oldRelease);
      assert.equal(args.targetReleaseDir, newRelease);
      return { journaledAB: true, commit: async () => args.commitNativePointer(), activate: async () => {
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
  await adapter.commit();
  assert.deepEqual(calls, ['shutdown-WPF', 'registered-B', 'pointer-B']);
});
