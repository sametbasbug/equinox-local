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
      quiesceOwnedB: async () => true,
      verifyNativeMessaging: async () => true,
      verifySustainedHealth: async () => true,
      commitNativePointer: async () => true }, ...extra };
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
    { ownerOnly: true }, { supervisor: { independentNativeOwner: true } }]) {
    assert.throws(() => requireWindowsNativeABSupervisor({ windowsAdmission: admitted(extra), transition, transactionId: ID }), /independent supervisor/u);
  }
});


test('owner-only Windows worker evidence cannot be upgraded by attaching fake WPF callbacks', async () => {
  const owned = admitted({ ownerOnly: true });
  let sideEffects = 0;
  const forged = { ...owned, supervisor: { ...owned.supervisor,
    shutdownOwnedWpf: async () => { sideEffects++; },
  }};
  assert.throws(() => requireWindowsNativeABSupervisor({ windowsAdmission: forged, transition, transactionId: ID }), /independent supervisor/u);
  await assert.rejects(prepareEquinoxLocalMainNativeLifecycle({
    transition, transactionId: ID, transactionRoot: TEST_TX_ROOT,
    candidate: { sourceSha: B, target, runtimeContractSha256: CB }, installation: install,
    windowsAdmission: forged,
    promoteCandidateImpl: async () => { sideEffects++; return { sourceSha: B, target, runtimeContractSha256: CB, releaseDir: newRelease }; },
  }), /independent supervisor/u);
  assert.equal(sideEffects, 0);
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
  assert.deepEqual(events, ['write-recovery-descriptor', 'bind-journaled-native-lifecycle']);
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

test('supervisor-bound native host registers exact launcher and makes pointer commit explicit, never on binding', async () => {
  const calls = [];
  const admission = admitted({ supervisor: { independentNativeOwner: true,
    assertWorkerOwnership: async () => true,
    shutdownOwnedWpf: async () => { calls.push('shutdown-WPF'); },
    quiesceOwnedB: async () => true,
    verifyNativeMessaging: async ({ release }) => release === 'B',
    verifySustainedHealth: async ({ sourceSha }) => sourceSha === B,
    commitNativePointer: async ({ pointer, transactionRoot, pointerPath }) => {
      assert.equal(pointer.sourceSha, B);
      assert.equal(transactionRoot, TEST_TX_ROOT);
      assert.equal(pointerPath, path.join(TEST_TX_ROOT, 'current-native.json'));
      calls.push('pointer-B');
      return true;
    },
  } });
  let registered = oldRelease;
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

test('native A/B rejects spoofed receipts, journal objects and lookalike transaction identities before touching WPF', () => {
  let touched = 0;
  const trusted = admitted();
  const badValues = [
    { transactionId: 'main-' + '7'.repeat(31) + 'Z' },
    { transactionId: 'main-' + '7'.repeat(32) + '\n' },
    { record: { ...trusted.record, targetRuntimeContractSha256: CA } },
    { record: { ...trusted.record, targetSha: 'C'.repeat(40) } },
    { record: { ...trusted.record, currentSha: 'a'.repeat(39) } },
    { record: { ...trusted.record, receiptStartedAt: null } },
    { journal: { read: async () => ({}) } },
    { supervisor: { ...trusted.supervisor, independentNativeOwner: 'true' } },
    { supervisor: { ...trusted.supervisor, verifyNativeMessaging: false } },
    { supervisor: { ...trusted.supervisor, assertWorkerOwnership: undefined } },
    { supervisor: { ...trusted.supervisor, quiesceOwnedB: undefined } },
    { supervisor: { ...trusted.supervisor, commitNativePointer: undefined } },
  ];
  for (const override of badValues) {
    const transactionId = override.transactionId ?? ID;
    const invalid = admitted({
      ...override,
      supervisor: override.supervisor ?? {
        ...trusted.supervisor,
        shutdownOwnedWpf: async () => { touched++; },
      },
    });
    assert.throws(
      () => requireWindowsNativeABSupervisor({ windowsAdmission: invalid, transition, transactionId }),
      /independent supervisor ownership and exact journal identity/u,
    );
  }
  assert.equal(touched, 0);
});

test('native A/B refuses new Native Messaging owner not independently verified and never commits pointer', async () => {
  const calls = [];
  let registered = oldRelease;
  const launcher = releaseDir => releaseDir + '\\runtime\\browser\\host.exe';
  const admission = admitted({supervisor: {
    ...admitted().supervisor,
    verifyNativeMessaging: async () => false,
  }});
  const adapter = createSupervisorBoundWindowsNativeABLifecycle({
    transition, transactionId: ID,
    windowsAdmission: admission,
    stored: { sourceSha:B, target, runtimeContractSha256:CB, releaseDir:newRelease },
    previousReleaseDir: oldRelease,
    programRoot: install.programRoot,
    manifestRoot: install.nativeMessagingManifestRoot,
    transactionRoot: TEST_TX_ROOT,
    pointerPath: path.join(TEST_TX_ROOT, 'current-native.json'),
    launcherPathImpl: launcher,
    assertNativeHostImpl: async ({acceptedLauncherPaths}) => {
      calls.push(['assert',acceptedLauncherPaths[0]]);
      assert.equal(acceptedLauncherPaths[0],launcher(registered));
    },
    registerNativeHostImpl: async ({launcherPath,expectedPreviousLauncherPath}) => {
      assert.equal(expectedPreviousLauncherPath,launcher(oldRelease));
      registered = newRelease;
      calls.push(['register',launcherPath]);
    },
    createLifecycleImpl: args => ({
      async activate() {
        await args.registerNativeMessaging({release:'B'});
        await args.commitNativePointer();
      },
    }),
  });
  await assert.rejects(adapter.activate(), /did not verify the new Native Messaging owner/u);
  assert.equal(calls.filter(c=>c[0]==='register').length,1);
  assert.equal(calls.filter(c=>c[0]==='commit').length,0);
});

test('supervisor-owned WPF shutdown and Native Messaging write reject expired worker after initial admission', async () => {
  const calls = [];
  const admission = admitted({ supervisor: { ...admitted().supervisor,
    assertWorkerOwnership: async () => false,
    shutdownOwnedWpf: async () => calls.push('shutdown'),
    verifyNativeMessaging: async () => false,
    verifySustainedHealth: async () => true,
  }});
  const adapter = createSupervisorBoundWindowsNativeABLifecycle({
    transition, transactionId: ID, windowsAdmission: admission,
    stored: {sourceSha:B,target,runtimeContractSha256:CB,releaseDir:newRelease},
    previousReleaseDir:oldRelease,programRoot:install.programRoot,
    manifestRoot:install.nativeMessagingManifestRoot,
    transactionRoot:TEST_TX_ROOT,pointerPath:path.join(TEST_TX_ROOT,'current-native.json'),
    launcherPathImpl: (dir) => `${dir}\\host.exe`,
    assertNativeHostImpl: async ({acceptedLauncherPaths}) => {
      calls.push('inspect');
      if (acceptedLauncherPaths[0].startsWith(newRelease)) throw Error('B is not registered');
    },
    registerNativeHostImpl: async () => calls.push('registry-mutated'),
    createLifecycleImpl: (args) => ({
      shutdown: () => args.shutdownOwnedWpf({transactionId:ID,programRoot:install.programRoot}),
      register: () => args.registerNativeMessaging({release:'B'}),
      owned: () => args.assertWorkerOwnership(),
    }),
  });
  await assert.rejects(adapter.shutdown(), /ownership expired before side effect/u);
  await assert.rejects(adapter.register(), /ownership expired before side effect/u);
  await assert.rejects(adapter.owned(), /ownership expired before side effect/u);
  assert.equal(calls.includes('shutdown'),false);
  assert.equal(calls.includes('registry-mutated'),false);
  assert.equal(calls.includes('pointer-mutated'),false);
});

test('supervisor-bound B pointer refuses expired owner, messaging or health before durable write', async () => {
  for (const scenario of ['owner-expired','messaging-expired','health-expired','owner-lost-after-health']) {
    const calls = [];
    let ownerChecks = 0;
    const admission = admitted({supervisor: { ...admitted().supervisor,
      assertWorkerOwnership: async () => {
        calls.push('os-owner');
        ownerChecks++;
        return scenario === 'owner-expired' ? false : scenario === 'owner-lost-after-health' ? ownerChecks < 2 : true;
      },
      verifyNativeMessaging: async () => scenario !== 'messaging-expired',
      verifySustainedHealth: async () => { calls.push('health-B'); return scenario !== 'health-expired'; },
      commitNativePointer: async () => { calls.push('pointer-mutated'); return true; },
    }});
    const adapter = createSupervisorBoundWindowsNativeABLifecycle({
      transition,transactionId:ID,windowsAdmission:admission,
      stored:{sourceSha:B,target,runtimeContractSha256:CB,releaseDir:newRelease},
      previousReleaseDir:oldRelease,programRoot:install.programRoot,
      manifestRoot:install.nativeMessagingManifestRoot,transactionRoot:TEST_TX_ROOT,
      pointerPath:path.join(TEST_TX_ROOT,'current-native.json'),
      launcherPathImpl:dir=>`${dir}\\host.exe`,
      assertNativeHostImpl:async()=>calls.push('inspect-B'),
      createLifecycleImpl:args=>({commit:()=>args.commitNativePointer()}),
    });
    await assert.rejects(adapter.commit(), /expired before (side effect|pointer commit)/u, scenario);
    assert.equal(calls.includes('pointer-mutated'),false,scenario);
  }
});


test('supervisor-bound rollback requires distinct native B quiesce and rejects unproved B shutdown', async () => {
  let namedProof = null;
  let fileMutations = 0;
  const admission = admitted({supervisor: {...admitted().supervisor,
    quiesceOwnedB: async (input) => { namedProof = input; return false; },
  }});
  const adapter = createSupervisorBoundWindowsNativeABLifecycle({
    transition, transactionId:ID,windowsAdmission:admission,
    stored:{sourceSha:B,target,runtimeContractSha256:CB,releaseDir:newRelease},
    previousReleaseDir:oldRelease, programRoot:install.programRoot,
    manifestRoot:install.nativeMessagingManifestRoot,transactionRoot:TEST_TX_ROOT,
    pointerPath:path.join(TEST_TX_ROOT,'current-native.json'),
    launcherPathImpl:dir=>`${dir}\\host.exe`,
    registerNativeHostImpl:async()=>{fileMutations++},
    createLifecycleImpl:args=>({tryBQuiesce:()=>args.quiesceOwnedB({transactionId:ID, programRoot:install.programRoot,sourceSha:B})}),
  });
  await assert.rejects(adapter.tryBQuiesce(),/B shutdown proof is unavailable/u);
  assert.equal(namedProof.release,'B');
  assert.equal(namedProof.sourceSha,B);
  assert.equal(namedProof.programRoot,install.programRoot);
  assert.equal(fileMutations,0);
});


test('native B pointer commit never falls back to JavaScript when the independent native owner refuses', async () => {
  const calls = [];
  const admission = admitted({ supervisor: { ...admitted().supervisor,
    commitNativePointer: async ({ transactionId, pointer, pointerPath }) => {
      calls.push('native-owner-refusal');
      assert.equal(transactionId, ID);
      assert.equal(pointer.sourceSha, B);
      assert.equal(pointerPath, path.join(TEST_TX_ROOT, 'current-native.json'));
      return false;
    },
  }});
  const adapter = createSupervisorBoundWindowsNativeABLifecycle({
    transition, transactionId: ID, windowsAdmission: admission,
    stored: { sourceSha: B, target, runtimeContractSha256: CB, releaseDir: newRelease },
    previousReleaseDir: oldRelease, programRoot: install.programRoot,
    manifestRoot: install.nativeMessagingManifestRoot, transactionRoot: TEST_TX_ROOT,
    pointerPath: path.join(TEST_TX_ROOT, 'current-native.json'),
    launcherPathImpl: dir => `${dir}\\host.exe`,
    assertNativeHostImpl: async () => {},
    createLifecycleImpl: args => ({ commit: () => args.commitNativePointer() }),
  });
  await assert.rejects(adapter.commit(), /native owner refused durable Main pointer commit/u);
  assert.deepEqual(calls, ['native-owner-refusal']);
  assert.throws(() => createSupervisorBoundWindowsNativeABLifecycle({
    transition, transactionId: ID, windowsAdmission: admission,
    stored: { sourceSha: B, target, runtimeContractSha256: CB, releaseDir: newRelease },
    previousReleaseDir: oldRelease, programRoot: install.programRoot,
    manifestRoot: install.nativeMessagingManifestRoot, transactionRoot: TEST_TX_ROOT,
    pointerPath: path.join(TEST_TX_ROOT, 'foreign-native.json'),
  }), /release roots are not pinned/u);
});
