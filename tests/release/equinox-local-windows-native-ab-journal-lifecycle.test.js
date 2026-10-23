import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createEquinoxLocalWindowsNativeTransitionJournal } from '../../src/equinox-local-windows-native-transition-journal.js';
import { createWindowsJournaledNativeABLifecycle } from '../../src/equinox-local-windows-native-ab-journal-lifecycle.js';
import { runEquinoxLocalMainUpdateHandoff } from '../../src/equinox-local-main-update-handoff.js';

const A = 'a'.repeat(40), B = 'b'.repeat(40), CONTRACT = 'f'.repeat(64);
const ID = `main-${'6'.repeat(32)}`, STARTED = '2026-10-12T09:00:00.000Z';

async function fixture(t, { healthyB = true, blockOwnership = false, failMessagingBOnce = false, failFinalBHealth = false, failFinalAHealth = false, denyBQuiesce = false, loseOwnershipAfterQuiesce = false } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'equinox-journal-ab-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const transactionRoot = path.join(root, 'main-update');
  const previousReleaseDir = path.join(root, 'releases', '6.0.4');
  const targetReleaseDir = path.join(root, 'releases', 'MainB');
  const programRoot = path.join(root, 'Programs', 'Equinox Local');
  for (const [release, label] of [[previousReleaseDir, 'A'], [targetReleaseDir, 'B']]) {
    const dir = path.join(release, 'runtime', 'shell');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'EquinoxLocal.exe'), `trusted WPF-${label}`);
    await fs.writeFile(path.join(dir, 'coreclr.dll'), `trusted runtime-${label}`);
  }
  await fs.mkdir(path.dirname(programRoot), { recursive: true });
  await fs.cp(path.join(previousReleaseDir, 'runtime', 'shell'), programRoot, { recursive: true });
  await fs.mkdir(transactionRoot, { recursive: true });
  const calls = [];
  let receipt = { transactionId: ID, currentSha: A, targetSha: B, startedAt: STARTED, status: 'promoting', stage: 'native_rollback_ready' };
  let messaging = 'A', wpfStopped = false, switchedSource = 'A', restart = 'A', nativePointer = 'A';
  let bHealthCalls = 0, aHealthCalls = 0, bQuiesceProved = false;
  const readExe = async () => fs.readFile(path.join(programRoot, 'EquinoxLocal.exe'), 'utf8');
  const journal = createEquinoxLocalWindowsNativeTransitionJournal({
    transactionRoot, platform: 'win32',
    protectWindowsAcl: async () => ({ safe: true }), verifyWindowsAcl: async () => ({ safe: true }),
    inspectOwningReceipt: async () => receipt,
    verifyMilestone: async (_, to) => {
      calls.push(`milestone:${to}`);
      if (to === 'shell_stopped') return wpfStopped;
      if (to === 'switched' || to === 'restarted' || to === 'healthy' || to === 'committed') {
        return await readExe() === 'trusted WPF-B' && messaging === 'B';
      }
      if (to === 'rollback_native_restored' || to === 'rollback_healthy' || to === 'rolled_back') {
        return await readExe() === 'trusted WPF-A' && messaging === 'A';
      }
      return true;
    },
  });
  await journal.create({ transactionId: ID, target: 'win32-x64', currentSha: A, targetSha: B,
    receiptStartedAt: STARTED, previousNative: { kind: 'stable', version: '6.0.4' }, targetRuntimeContractSha256: CONTRACT });
  const lifecycle = createWindowsJournaledNativeABLifecycle({
    transactionId: ID, target: 'win32-x64', currentSha: A, targetSha: B,
    receiptStartedAt: STARTED, targetRuntimeContractSha256: CONTRACT,
    programRoot, previousReleaseDir, targetReleaseDir, journal,
    assertWorkerOwnership: async () => !blockOwnership && !(loseOwnershipAfterQuiesce && bQuiesceProved),
    shutdownOwnedWpf: async () => { wpfStopped = true; calls.push('shutdown-owned-wpf'); },
    quiesceOwnedB: async ({ sourceSha }) => {
      assert.equal(sourceSha, B);
      assert.equal(await readExe(), 'trusted WPF-B');
      calls.push('quiesce-owned-B');
      if (denyBQuiesce) return false;
      bQuiesceProved = true;
      return true;
    },
    registerNativeMessaging: async ({ release }) => {
      if (release === 'B' && failMessagingBOnce) { failMessagingBOnce = false; throw new Error('simulated power loss after A→B WPF rename'); }
      messaging = release; calls.push(`nm:${release}`);
    },
    verifyNativeMessaging: async ({ release }) => messaging === release,
    verifySustainedHealth: async ({ release, sourceSha }) => {
      calls.push(`health:${release}`);
      if (release === 'B' && ++bHealthCalls > 1 && failFinalBHealth) return false;
      if (release === 'A' && ++aHealthCalls > 1 && failFinalAHealth) return false;
      return restart === release && switchedSource === release &&
        (release === 'A' || healthyB) && sourceSha === (release === 'A' ? A : B);
    },
    commitNativePointer: async ({ sourceSha }) => { assert.equal(sourceSha, B); nativePointer = 'B'; calls.push('native-pointer-B'); },
  });
  const base = {
    transactionId: ID, currentSha: A, targetSha: B, rollbackSha: A,
    rollbackSourceRoot: path.join(root, 'sourceA'), targetSourceRoot: path.join(root, 'sourceB'),
  };
  const engine = {
    async markNativeSwitched() { receipt = { ...receipt, status: 'promoting', stage: 'native_switched' }; return { ...base, ...receipt }; },
    async activatePromotion() { switchedSource = 'B'; receipt = { ...receipt, status: 'verifying', stage: 'source_switched' }; return { ...base, ...receipt }; },
    async rollbackPromotion(_id, reason) { switchedSource = 'A'; receipt = { ...receipt, status: 'verifying', stage: 'rollback_source_restored', lastError: reason }; return { ...base, ...receipt }; },
    async markNativeRollbackRestored() { receipt = { ...receipt, stage: 'rollback_native_restored' }; return { ...base, ...receipt }; },
    async markPromotionSucceeded() { receipt = { ...receipt, status: 'succeeded', stage: 'healthy' }; calls.push('durable-receipt-succeeded'); return { ...base, ...receipt }; },
    async markRollbackSucceeded() { receipt = { ...receipt, status: 'rolled_back', stage: 'rollback_healthy' }; calls.push('durable-receipt-rolled-back'); return { ...base, ...receipt }; },
    async markRollbackFailed() { calls.push('rollback-failed'); },
    async releaseStagedLock() { calls.push('release-lock'); },
  };
  const options = {
    transactionId: ID, engine, nativeLifecycle: lifecycle,
    initialReceipt: { ...base, stage: 'native_rollback_ready' },
    restartRuntime: async ({ rollback }) => { restart = rollback ? 'A' : 'B'; calls.push(`restart:${restart}`); },
    verifyRuntime: async ({ rollback }) => rollback || healthyB,
  };
  return { root, programRoot, journal, lifecycle, calls, options, readExe,
    getReceipt: () => receipt, getPointer: () => nativePointer,
    backupRoot: path.join(root, 'Programs', `.equinox-shell-backup-${ID}`),
    quarantineRoot: path.join(root, 'Programs', `.equinox-shell-failed-${ID}`) };
}

test('shared handoff physically switches WPF A→B and commits journal only after durable receipt', async (t) => {
  const f = await fixture(t);
  const result = await runEquinoxLocalMainUpdateHandoff(f.options);
  assert.equal(result.status, 'succeeded');
  assert.equal(await f.readExe(), 'trusted WPF-B');
  assert.equal(f.getPointer(), 'B');
  assert.equal((await f.journal.read(ID)).stage, 'committed');
  assert.ok(f.calls.indexOf('durable-receipt-succeeded') < f.calls.indexOf('milestone:committed'));
  await assert.rejects(fs.lstat(f.backupRoot), { code: 'ENOENT' });
  assert.equal(f.calls.at(-1), 'release-lock');
});

test('shared handoff physically rolls back unhealthy B→A and finalizes only after durable rollback receipt', async (t) => {
  const f = await fixture(t, { healthyB: false });
  const result = await runEquinoxLocalMainUpdateHandoff(f.options);
  assert.equal(result.status, 'rolled_back');
  assert.equal(await f.readExe(), 'trusted WPF-A');
  assert.equal(f.getPointer(), 'A');
  assert.equal((await f.journal.read(ID)).stage, 'rolled_back');
  assert.ok(f.calls.indexOf('durable-receipt-rolled-back') < f.calls.indexOf('milestone:rolled_back'));
  await assert.rejects(fs.lstat(f.quarantineRoot), { code: 'ENOENT' });
  assert.equal(f.calls.at(-1), 'release-lock');
});

test('foreign worker refuses journal and physical A→B without touching the shell', async (t) => {
  const f = await fixture(t, { blockOwnership: true });
  await assert.rejects(f.lifecycle.activate(), /ownership/u);
  assert.equal(await f.readExe(), 'trusted WPF-A');
  assert.equal((await f.journal.read(ID)).stage, 'prepared');
});


test('crash after A→B rename and before NM registration leaves A and replay is idempotent', async (t) => {
  const f = await fixture(t, { failMessagingBOnce: true });
  await assert.rejects(f.lifecycle.activate(), /simulated power loss/u);
  assert.equal((await f.journal.read(ID)).stage, 'shell_stopped');
  assert.equal(await f.readExe(), 'trusted WPF-B');
  assert.equal(await fs.readFile(path.join(f.backupRoot, 'EquinoxLocal.exe'), 'utf8'), 'trusted WPF-A');
  const resumed = await f.lifecycle.activate();
  assert.equal(resumed.stage, 'switched');
  assert.equal((await f.journal.read(ID)).stage, 'switched');
  assert.equal(await f.readExe(), 'trusted WPF-B');
});

test('committed success receipt followed by failed cleanup keeps old A and never initiates rollback', async (t) => {
  const f = await fixture(t, { failFinalBHealth: true });
  await assert.rejects(runEquinoxLocalMainUpdateHandoff(f.options), /cleanup remains pending/u);
  assert.equal(f.getReceipt().status, 'succeeded');
  assert.equal((await f.journal.read(ID)).stage, 'committed');
  assert.equal(await f.readExe(), 'trusted WPF-B');
  assert.equal(await fs.readFile(path.join(f.backupRoot, 'EquinoxLocal.exe'), 'utf8'), 'trusted WPF-A');
  assert.equal(f.calls.includes('rollback-failed'), false);
  assert.equal(f.calls.includes('release-lock'), false);
});

test('durable rollback receipt plus failed cleanup keeps restored A and B quarantine', async (t) => {
  const f = await fixture(t, { healthyB: false, failFinalAHealth: true });
  await assert.rejects(runEquinoxLocalMainUpdateHandoff(f.options), /cleanup remains pending/u);
  assert.equal(f.getReceipt().status, 'rolled_back');
  assert.equal((await f.journal.read(ID)).stage, 'rolled_back');
  assert.equal(await f.readExe(), 'trusted WPF-A');
  assert.equal(await fs.readFile(path.join(f.quarantineRoot, 'EquinoxLocal.exe'), 'utf8'), 'trusted WPF-B');
  assert.equal(f.calls.includes('rollback-failed'), false);
  assert.equal(f.calls.includes('release-lock'), false);
});

test('journal refuses premature B pointer commit, health and cleanup before any physical WPF mutation', async(t)=>{
  const f=await fixture(t);
  for(const [invoke,message] of [
    [()=>f.lifecycle.commit(),/may not commit before verified B health/u],
    [()=>f.lifecycle.recordRestarted(),/cannot precede verified B switch/u],
    [()=>f.lifecycle.recordHealthy(),/cannot precede verified restart/u],
    [()=>f.lifecycle.recordRollbackHealthy(),/cannot precede restoration/u],
    [()=>f.lifecycle.finalizeCommitted(),/cannot discard A before durable committed receipt/u],
    [()=>f.lifecycle.finalizeRolledBack(),/cannot be finalized before durable rolled-back receipt/u],
  ]){
    await assert.rejects(invoke(),message);
  }
  assert.equal(await f.readExe(),'trusted WPF-A');
  assert.equal(f.getPointer(),'A');
  assert.equal((await f.journal.read(ID)).stage,'prepared');
  assert.equal(f.calls.some(v=>String(v).includes('native-pointer-B')),false);
  await assert.rejects(fs.lstat(f.backupRoot),{code:'ENOENT'});
});

test('journal never records B healthy without independently established sustained B runtime',async(t)=>{
  const f=await fixture(t,{healthyB:false});
  const switched=await f.lifecycle.activate();
  assert.equal(switched.stage,'switched');
  await f.lifecycle.recordRestarted();
  await assert.rejects(f.lifecycle.recordHealthy(),/Independent native B sustained health was not established/u);
  assert.equal((await f.journal.read(ID)).stage,'restarted');
  await assert.rejects(f.lifecycle.commit(),/may not commit before verified B health/u);
  assert.equal(f.getPointer(),'A');
  assert.equal(await f.readExe(),'trusted WPF-B');
  assert.equal(await fs.readFile(path.join(f.backupRoot,'EquinoxLocal.exe'),'utf8'),'trusted WPF-A');
  assert.equal(f.calls.includes('milestone:healthy'),false);
});

test('untrusted native A/B journal transport cannot trigger WPF changes with forged record identities or stages', async (t) => {
  const f = await fixture(t);
  const valid = await f.journal.read(ID);
  const forged = [
    { ...valid, transactionId: `main-${'9'.repeat(32)}` },
    { ...valid, currentSha: B },
    { ...valid, targetSha: A },
    { ...valid, target: 'win32-arm64' },
    { ...valid, receiptStartedAt: '2026-10-12T10:00:00.000Z' },
    { ...valid, stage: 'healthy' },
    { ...valid, stage: 'committed', sequence: 0 },
    { ...valid, sequence: 9 },
    { ...valid, previousNative: { kind: 'main', sourceSha: B, runtimeContractSha256: CONTRACT } },
    { ...valid, targetRuntimeContractSha256: 'a'.repeat(64) },
    { ...valid, unexpectedPrivilege: true },
    null,
  ];
  const dangerous = async () => assert.fail('unauthenticated journal reached native WPF, health or pointer mutation');
  for (const record of forged) {
    const lifecycle = createWindowsJournaledNativeABLifecycle({
      transactionId: ID, target: 'win32-x64', currentSha: A, targetSha: B,
      receiptStartedAt: STARTED, targetRuntimeContractSha256: CONTRACT,
      programRoot: f.programRoot,
      previousReleaseDir: path.join(f.root, 'releases', '6.0.4'),
      targetReleaseDir: path.join(f.root, 'releases', 'MainB'),
      journal: { read: async () => record, advance: dangerous },
      assertWorkerOwnership: async () => true,
      shutdownOwnedWpf: dangerous,
      quiesceOwnedB: dangerous,
      verifyNativeMessaging: dangerous,
      registerNativeMessaging: dangerous,
      verifySustainedHealth: dangerous,
      commitNativePointer: dangerous,
      slotSwitch: dangerous,
    });
    await assert.rejects(lifecycle.activate(), /journal|identity|contract|state|transaction/u);
    assert.equal(await f.readExe(), 'trusted WPF-A', 'invalid native journal must preserve physical WPF A');
    assert.equal((await f.journal.read(ID)).stage, 'prepared');
  }
  await assert.rejects(fs.lstat(f.backupRoot), { code: 'ENOENT' });
});


test('rollback cannot move B or restore A without explicit independently attested B WPF quiesce', async (t) => {
  const f = await fixture(t, {denyBQuiesce: true});
  await f.lifecycle.activate();
  assert.equal(await f.readExe(), 'trusted WPF-B');
  await assert.rejects(f.lifecycle.rollback(), /Independent Windows native B WPF shutdown is not verified/u);
  assert.equal((await f.journal.read(ID)).stage, 'rollback_started');
  assert.equal(await f.readExe(), 'trusted WPF-B');
  assert.equal(await fs.readFile(path.join(f.backupRoot, 'EquinoxLocal.exe'),'utf8'), 'trusted WPF-A');
  await assert.rejects(fs.lstat(f.quarantineRoot), {code: 'ENOENT'});
  assert.ok(f.calls.includes('quiesce-owned-B'));
  assert.equal(f.calls.includes('nm:A') && f.calls.at(-1) === 'nm:A', false);
});

test('rollback refuses to move B when independent worker expires after positive B shutdown proof', async (t) => {
  const f = await fixture(t, {loseOwnershipAfterQuiesce:true});
  await f.lifecycle.activate();
  await assert.rejects(f.lifecycle.rollback(), /ownership/u);
  assert.equal((await f.journal.read(ID)).stage, 'rollback_started');
  assert.equal(await f.readExe(), 'trusted WPF-B');
  assert.equal(await fs.readFile(path.join(f.backupRoot, 'EquinoxLocal.exe'),'utf8'), 'trusted WPF-A');
  await assert.rejects(fs.lstat(f.quarantineRoot), {code:'ENOENT'});
});

test('native A→B failure rollback proves B shutdown before B quarantine and A messaging', async (t) => {
  const f = await fixture(t,{healthyB:false});
  const result=await runEquinoxLocalMainUpdateHandoff(f.options);
  assert.equal(result.status,'rolled_back');
  const shutdown=f.calls.indexOf('quiesce-owned-B');
  const restoreMessage=f.calls.indexOf('nm:A');
  assert.ok(shutdown>=0 && restoreMessage>shutdown,'real A restore may not begin before B shutdown proof');
  assert.equal(await f.readExe(),'trusted WPF-A');
});
