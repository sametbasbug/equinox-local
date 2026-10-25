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
  } });
  let registered = oldRelease;
  const launcher = (value) => `${value}\\runtime\\browser\\host.exe`;
  const adapter = createSupervisorBoundWindowsNativeABLifecycle({
    // The fixture has no real signed Guardian. Production defaults to
    // original Windows PID/file-ID/HMAC pipe, never to this stub.
    env: {EQUINOX_LOCAL_MAIN_WORKER_TOKEN:'e'.repeat(64)},
    verifySignedGuardianHealthImpl: async () => {},
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
    // The fixture has no real signed Guardian. Production defaults to
    // original Windows PID/file-ID/HMAC pipe, never to this stub.
    env: {EQUINOX_LOCAL_MAIN_WORKER_TOKEN:'e'.repeat(64)},
    verifySignedGuardianHealthImpl: async () => {},
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
    writePointerImpl: async () => {calls.push(['commit']);},
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
    // The fixture has no real signed Guardian. Production defaults to
    // original Windows PID/file-ID/HMAC pipe, never to this stub.
    env: {EQUINOX_LOCAL_MAIN_WORKER_TOKEN:'e'.repeat(64)},
    verifySignedGuardianHealthImpl: async () => {},
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
    writePointerImpl: async () => calls.push('pointer-mutated'),
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
    }});
    const adapter = createSupervisorBoundWindowsNativeABLifecycle({
    // The fixture has no real signed Guardian. Production defaults to
    // original Windows PID/file-ID/HMAC pipe, never to this stub.
    env: {EQUINOX_LOCAL_MAIN_WORKER_TOKEN:'e'.repeat(64)},
    verifySignedGuardianHealthImpl: async () => {},
      transition,transactionId:ID,windowsAdmission:admission,
      stored:{sourceSha:B,target,runtimeContractSha256:CB,releaseDir:newRelease},
      previousReleaseDir:oldRelease,programRoot:install.programRoot,
      manifestRoot:install.nativeMessagingManifestRoot,transactionRoot:TEST_TX_ROOT,
      pointerPath:path.join(TEST_TX_ROOT,'current-native.json'),
      launcherPathImpl:dir=>`${dir}\\host.exe`,
      assertNativeHostImpl:async()=>calls.push('inspect-B'),
      writePointerImpl:async()=>calls.push('pointer-mutated'),
      createLifecycleImpl:args=>({commit:()=>args.commitNativePointer()}),
    });
    await assert.rejects(adapter.commit(), /expired before (side effect|pointer commit)/u, scenario);
    assert.equal(calls.includes('pointer-mutated'),false,scenario);
  }
});


test('supervisor-bound rollback restores exact Stable A absence after B pointer persisted and refuses foreign pointers', async () => {
  let owned = true, registered = oldRelease, pointer = {sourceSha:B,target,runtimeContractSha256:CB};
  const events = [];
  const launcher = dir => dir + '\\\\runtime\\\\browser\\\\host.exe';
  const fakeFs = {
    async lstat() {
      if (!pointer) throw Object.assign(Error('pointer absent'),{code:'ENOENT'});
      return {isFile:()=>true,isSymbolicLink:()=>false,nlink:1,dev:1,ino:2,size:80,mtimeMs:3};
    },
    async unlink() { assert.equal(pointer.sourceSha,B); pointer = null; events.push('pointer-removed'); },
  };
  const a = createSupervisorBoundWindowsNativeABLifecycle({
    // The fixture has no real signed Guardian. Production defaults to
    // original Windows PID/file-ID/HMAC pipe, never to this stub.
    env: {EQUINOX_LOCAL_MAIN_WORKER_TOKEN:'e'.repeat(64)},
    verifySignedGuardianHealthImpl: async () => {},
    transition,transactionId:ID,windowsAdmission:admitted({supervisor:{
      ...admitted().supervisor,
      assertWorkerOwnership:async()=>owned,
      verifyNativeMessaging:async({release})=>release==='A'&&registered===oldRelease,
    }}),
    stored:{sourceSha:B,target,runtimeContractSha256:CB,releaseDir:newRelease},
    previousPointer:null,previousReleaseDir:oldRelease,programRoot:install.programRoot,
    manifestRoot:install.nativeMessagingManifestRoot,transactionRoot:TEST_TX_ROOT,
    pointerPath:path.join(TEST_TX_ROOT,'current-native.json'),launcherPathImpl:launcher,
    fsImpl:fakeFs,readPointerImpl:async()=>pointer,
    assertNativeHostImpl:async({acceptedLauncherPaths})=>assert.deepEqual(acceptedLauncherPaths,[launcher(oldRelease)]),
    createLifecycleImpl:args=>({restore:()=>args.restoreNativePointer()}),
  });
  await a.restore();
  assert.equal(pointer,null);
  assert.deepEqual(events,['pointer-removed']);
  await a.restore(); // exact previous Stable state is idempotent
  assert.equal(pointer,null);
  pointer={sourceSha:'d'.repeat(40),target,runtimeContractSha256:CB};
  await assert.rejects(a.restore(),/Foreign native pointer/u);
  assert.equal(pointer.sourceSha,'d'.repeat(40));
  pointer={sourceSha:B,target,runtimeContractSha256:CB};
  owned=false;
  await assert.rejects(a.restore(),/ownership expired/u);
  assert.equal(pointer.sourceSha,B);
});

test('original Main pointer cannot be substituted with a foreign runtime contract before rollback', () => {
  assert.throws(() => createSupervisorBoundWindowsNativeABLifecycle({
    // The fixture has no real signed Guardian. Production defaults to
    // original Windows PID/file-ID/HMAC pipe, never to this stub.
    env: {EQUINOX_LOCAL_MAIN_WORKER_TOKEN:'e'.repeat(64)},
    verifySignedGuardianHealthImpl: async () => {},
    transition,transactionId:ID,windowsAdmission:admitted(),
    stored:{sourceSha:B,target,runtimeContractSha256:CB,releaseDir:newRelease},
    previousPointer:{sourceSha:A,target,runtimeContractSha256:'f'.repeat(64)},
    previousReleaseDir:oldRelease,programRoot:install.programRoot,
    manifestRoot:install.nativeMessagingManifestRoot,transactionRoot:TEST_TX_ROOT,
    pointerPath:path.join(TEST_TX_ROOT,'current-native.json'),
  }), /original Main identity/u);
});

test('supervisor-bound rollback restores exact prior Main A pointer after B pointer persisted', async () => {
  let pointer={sourceSha:B,target,runtimeContractSha256:CB};
  const original={sourceSha:A,target,runtimeContractSha256:CA};
  let wrote=0;
  const lc=createSupervisorBoundWindowsNativeABLifecycle({
    // The fixture has no real signed Guardian. Production defaults to
    // original Windows PID/file-ID/HMAC pipe, never to this stub.
    env: {EQUINOX_LOCAL_MAIN_WORKER_TOKEN:'e'.repeat(64)},
    verifySignedGuardianHealthImpl: async () => {},
    transition,transactionId:ID,windowsAdmission:admitted(),
    stored:{sourceSha:B,target,runtimeContractSha256:CB,releaseDir:newRelease},
    previousPointer:original,previousReleaseDir:oldRelease,programRoot:install.programRoot,
    manifestRoot:install.nativeMessagingManifestRoot,transactionRoot:TEST_TX_ROOT,
    pointerPath:path.join(TEST_TX_ROOT,'current-native.json'),
    launcherPathImpl:dir=>dir+'\\\\runtime\\\\browser\\\\host.exe',
    fsImpl:{async lstat(){return {isFile:()=>true,isSymbolicLink:()=>false,nlink:1,dev:1,ino:4,size:80,mtimeMs:3}}},
    readPointerImpl:async()=>pointer,
    writePointerImpl:async(_path,value)=>{wrote++;pointer={sourceSha:value.sourceSha,target:value.target,runtimeContractSha256:value.runtimeContractSha256}},
    assertNativeHostImpl:async()=>true,
    createLifecycleImpl:args=>({restore:()=>args.restoreNativePointer()}),
  });
  await lc.restore();
  assert.deepEqual(pointer,original);
  assert.equal(wrote,1);
  await lc.restore();
  assert.equal(wrote,1);
});

test('supervisor-bound rollback requires distinct native B quiesce and rejects unproved B shutdown', async () => {
  let namedProof = null;
  let fileMutations = 0;
  const admission = admitted({supervisor: {...admitted().supervisor,
    quiesceOwnedB: async (input) => { namedProof = input; return false; },
  }});
  const adapter = createSupervisorBoundWindowsNativeABLifecycle({
    // The fixture has no real signed Guardian. Production defaults to
    // original Windows PID/file-ID/HMAC pipe, never to this stub.
    env: {EQUINOX_LOCAL_MAIN_WORKER_TOKEN:'e'.repeat(64)},
    verifySignedGuardianHealthImpl: async () => {},
    transition, transactionId:ID,windowsAdmission:admission,
    stored:{sourceSha:B,target,runtimeContractSha256:CB,releaseDir:newRelease},
    previousReleaseDir:oldRelease, programRoot:install.programRoot,
    manifestRoot:install.nativeMessagingManifestRoot,transactionRoot:TEST_TX_ROOT,
    pointerPath:path.join(TEST_TX_ROOT,'current-native.json'),
    launcherPathImpl:dir=>`${dir}\\host.exe`,
    registerNativeHostImpl:async()=>{fileMutations++},
    writePointerImpl:async()=>{fileMutations++},
    createLifecycleImpl:args=>({tryBQuiesce:()=>args.quiesceOwnedB({transactionId:ID, programRoot:install.programRoot,sourceSha:B})}),
  });
  await assert.rejects(adapter.tryBQuiesce(),/B shutdown proof is unavailable/u);
  assert.equal(namedProof.release,'B');
  assert.equal(namedProof.sourceSha,B);
  assert.equal(namedProof.programRoot,install.programRoot);
  assert.equal(fileMutations,0);
});

test('genuine Guardian B/A OS witness is required in addition to admitted supervisor health, never inferred from a worker token', async () => {
  const events=[];
  const admission=admitted({supervisor:{...admitted().supervisor,
    verifySustainedHealth:async ({release,sourceSha})=>{
      events.push('supervisor-'+release+'-'+sourceSha);
      return true;
    },
  }});
  const adapter=createSupervisorBoundWindowsNativeABLifecycle({
    transition,transactionId:ID,windowsAdmission:admission,
    stored:{sourceSha:B,target,runtimeContractSha256:CB,releaseDir:newRelease},
    previousReleaseDir:oldRelease,programRoot:install.programRoot,
    manifestRoot:install.nativeMessagingManifestRoot,transactionRoot:TEST_TX_ROOT,
    pointerPath:path.join(TEST_TX_ROOT,'current-native.json'),
    env:{EQUINOX_LOCAL_MAIN_WORKER_TOKEN:'e'.repeat(64)},
    verifySignedGuardianHealthImpl:async ({release,transactionId,workerToken,transactionRoot})=>{
      assert.equal(transactionId,ID);
      assert.equal(transactionRoot,TEST_TX_ROOT);
      assert.equal(workerToken,'e'.repeat(64));
      events.push('kernel-witness-'+release);
      throw Error('original signed Guardian did not attest installed WPF PID and File ID');
    },
    assertNativeHostImpl:async()=>true,
    writePointerImpl:async()=>events.push('UNSAFE POINTER'),
    createLifecycleImpl:args=>({
      nativeBHealth:()=>args.verifySustainedHealth({release:'B',sourceSha:B}),
      restoredAHealth:()=>args.verifySustainedHealth({release:'A',sourceSha:A}),
      commit:()=>args.commitNativePointer(),
    }),
  });
  await assert.rejects(adapter.nativeBHealth(),/did not attest installed WPF PID/u);
  await assert.rejects(adapter.restoredAHealth(),/did not attest installed WPF PID/u);
  await assert.rejects(adapter.commit(),/did not attest installed WPF PID/u);
  assert.deepEqual(events,['supervisor-B-'+B,'kernel-witness-B',
    'supervisor-A-'+A,'kernel-witness-A',
    'supervisor-B-'+B,'kernel-witness-B']);
  assert.equal(events.includes('UNSAFE POINTER'),false);
});
