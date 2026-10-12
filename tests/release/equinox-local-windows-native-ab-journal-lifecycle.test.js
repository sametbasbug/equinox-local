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

async function fixture(t, { healthyB = true, blockOwnership = false, failMessagingBOnce = false, failFinalBHealth = false, failFinalAHealth = false, failSelectBOnce = false } = {}) {
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
  let bHealthCalls = 0, aHealthCalls = 0;
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
    assertWorkerOwnership: async () => !blockOwnership,
    shutdownOwnedWpf: async () => { wpfStopped = true; calls.push('shutdown-owned-wpf'); },
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
    selectNativeRuntime: async ({ release, sourceSha }) => {
      assert.equal(sourceSha, release === 'B' ? B : A);
      if (release === 'B' && failSelectBOnce) {
        failSelectBOnce = false;
        throw new Error('simulated power loss while selecting B native runtime');
      }
      nativePointer = release;
      calls.push(`native-pointer-${release}`);
    },
    verifyNativeRuntime: async ({ release, sourceSha }) =>
      nativePointer === release && sourceSha === (release === 'B' ? B : A),
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
    restartRuntime: async ({ rollback }) => {
      restart = rollback ? 'A' : 'B';
      assert.equal(nativePointer, restart, 'WPF must never start with the wrong native runtime pointer');
      assert.equal(switchedSource, restart, 'WPF must never start with the wrong managed-source pointer');
      calls.push(`restart:${restart}`);
    },
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
  assert.ok(f.calls.indexOf('native-pointer-B') < f.calls.indexOf('restart:B'));
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
  assert.ok(f.calls.indexOf('native-pointer-A') < f.calls.indexOf('restart:A'));
  assert.equal((await f.journal.read(ID)).stage, 'rolled_back');
  assert.ok(f.calls.indexOf('durable-receipt-rolled-back') < f.calls.indexOf('milestone:rolled_back'));
  await assert.rejects(fs.lstat(f.quarantineRoot), { code: 'ENOENT' });
  assert.equal(f.calls.at(-1), 'release-lock');
});

test('B native pointer selection failure rolls back both WPF slot and A source before A relaunch', async (t) => {
  const f = await fixture(t, { failSelectBOnce: true });
  const result = await runEquinoxLocalMainUpdateHandoff(f.options);
  assert.equal(result.status, 'rolled_back');
  assert.match(result.targetError.message, /simulated power loss/u);
  assert.equal(await f.readExe(), 'trusted WPF-A');
  assert.equal(f.getPointer(), 'A');
  assert.ok(f.calls.indexOf('native-pointer-A') < f.calls.indexOf('restart:A'));
  assert.equal(f.calls.includes('restart:B'), false, 'unselected native B must never start WPF');
  assert.equal((await f.journal.read(ID)).stage, 'rolled_back');
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

test('native-owned Guardian journal mode observes switched/3 and restarted/4 without a second JS journal or slot writer', async () => {
  let current = 'prepared';
  let sequence = 0;
  let owned = true;
  const witnessed = [];
  const calls = [];
  const observer = async ({ transactionId, stage, sourceSha, target }) => {
    witnessed.push(stage);
    return owned ? { transactionId, stage, sourceSha, target, sequence: stage === 'switched' ? 3 : 4, guardianPid: 5678, journalSha256: 'b'.repeat(64) } : null;
  };
  const lc = createWindowsJournaledNativeABLifecycle({
    transactionId: ID, target: 'win32-x64', currentSha: A, targetSha: B,
    receiptStartedAt: '2026-10-12T12:00:00.000Z', targetRuntimeContractSha256: 'd'.repeat(64),
    programRoot: 'C:\\fixture\\Programs\\Equinox Local', previousReleaseDir: 'C:\\fixture\\A',
    targetReleaseDir: 'C:\\fixture\\B',
    nativeOwnsMilestones: true, observeNativeMilestone: observer,
    journal: { read: async () => ({ transactionId: ID, targetRuntimeContractSha256: 'd'.repeat(64), stage: current, sequence }) },
    assertWorkerOwnership: async () => true,
    shutdownOwnedWpf: async () => { throw new Error('JS must never shut down WPF in native-owned mode'); },
    verifyNativeMessaging: async ({ release }) => { calls.push(`verify:${release}`); return release === 'B'; },
    registerNativeMessaging: async () => { throw new Error('JS must never register NM in native-owned mode'); },
    verifySustainedHealth: async () => true,
    selectNativeRuntime: async () => {}, verifyNativeRuntime: async () => true,
    slotSwitch: async () => { throw new Error('JS must never physically switch A/B in native-owned mode'); },
  });
  await assert.rejects(lc.activate(), /independent journal generation/u);
  assert.deepEqual(witnessed, ['switched']);
  current = 'switched'; sequence = 3;
  assert.equal((await lc.activate()).stage, 'switched');
  await assert.rejects(lc.recordRestarted(), /independent journal generation/u);
  current = 'restarted'; sequence = 4;
  assert.equal((await lc.recordRestarted()).stage, 'restarted');
  assert.deepEqual(witnessed, ['switched', 'switched', 'restarted', 'restarted']);
  assert.deepEqual(calls, ['verify:B']);
  await assert.rejects(lc.recordHealthy(), /separate OS-authorized commit phase/u);
  await assert.rejects(lc.rollback(), /independently authorized OS recovery/u);
  owned = false;
  await assert.rejects(lc.recordRestarted(), /independent journal generation/u);
});
