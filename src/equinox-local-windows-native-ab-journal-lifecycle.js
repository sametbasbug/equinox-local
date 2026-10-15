import fs from 'node:fs/promises';
import {
  commitWindowsNativeABSlot,
  finalizeWindowsNativeABRollback,
  restoreWindowsNativeABSlot,
  switchWindowsNativeABSlot,
} from './equinox-local-windows-native-ab-switch.js';

const TX = /^main-[a-f0-9]{32}$/u;
const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;

// The worker-side physical-slot/journal bridge, not a public updater entry.
// Caller MUST supply independent OS worker attestations, exact native messaging
// proof and a journal whose writer authenticates the active Main receipt.
export function createWindowsJournaledNativeABLifecycle({
  transactionId, target, currentSha, targetSha, receiptStartedAt,
  targetRuntimeContractSha256, programRoot, previousReleaseDir, targetReleaseDir,
  journal, assertWorkerOwnership, shutdownOwnedWpf,
  verifyNativeMessaging, registerNativeMessaging, verifySustainedHealth,
  fsImpl = fs,
  slotSwitch = switchWindowsNativeABSlot,
  slotRestore = restoreWindowsNativeABSlot,
  slotCommit = commitWindowsNativeABSlot,
  slotFinalizeRollback = finalizeWindowsNativeABRollback,
  commitNativePointer,
} = {}) {
  if (!TX.test(transactionId ?? '') || !['win32-x64', 'win32-arm64'].includes(target) ||
      !SHA.test(currentSha ?? '') || !SHA.test(targetSha ?? '') || currentSha === targetSha ||
      !DIGEST.test(targetRuntimeContractSha256 ?? '') ||
      typeof receiptStartedAt !== 'string' || Number.isNaN(Date.parse(receiptStartedAt)) ||
      !programRoot || !previousReleaseDir || !targetReleaseDir ||
      typeof commitNativePointer !== 'function' ||
      typeof journal?.read !== 'function' || typeof journal?.advance !== 'function' ||
      ![assertWorkerOwnership, shutdownOwnedWpf, verifyNativeMessaging, registerNativeMessaging, verifySustainedHealth].every((v) => typeof v === 'function')) {
    throw new Error('Windows A/B lifecycle requires authenticated worker, journal and native ownership callbacks.');
  }
  const paths = Object.freeze({ transactionId, programRoot, previousReleaseDir, targetReleaseDir });
  const expected = Object.freeze({ target, currentSha, targetSha, receiptStartedAt });
  async function owned() {
    if (await assertWorkerOwnership({ transactionId, currentSha, targetSha, target }) !== true) {
      throw new Error('Independent native worker ownership is not verified.');
    }
    const record = await journal.read(transactionId, expected);
    if (record.targetRuntimeContractSha256 !== targetRuntimeContractSha256) {
      throw new Error('Native A/B journal contract differs from exact target release.');
    }
    return record;
  }
  async function advance(record, to) {
    // The journal itself checks the durable receipt and the OS milestone.
    await journal.advance(transactionId, { from: record.stage, to, sequence: record.sequence });
    return owned();
  }
  async function messaging(release) {
    if (await verifyNativeMessaging({ transactionId, release, previousReleaseDir, targetReleaseDir }) !== true) {
      throw new Error(`Native Messaging ${release} ownership has not been independently verified.`);
    }
  }
  return Object.freeze({
    journaledAB: true,
    journal,
    commit: async () => {
      if ((await owned()).stage !== 'healthy') throw new Error('Native pointer may not commit before verified B health.');
      await commitNativePointer({ transactionId, sourceSha: targetSha, runtimeContractSha256: targetRuntimeContractSha256 });
    },
    async activate() {
      let record = await owned();
      if (record.stage === 'prepared') record = await advance(record, 'native_staged');
      if (record.stage === 'native_staged') {
        await shutdownOwnedWpf({ transactionId, programRoot });
        record = await advance(record, 'shell_stopped');
      }
      if (record.stage === 'shell_stopped') {
        await slotSwitch(paths, { fsImpl, requestShutdown: async () => {
          if ((await owned()).stage !== 'shell_stopped') throw new Error('WPF stop ownership disappeared before native rename.');
        } });
        await registerNativeMessaging({ transactionId, release: 'B' });
        await messaging('B');
        record = await advance(record, 'switched');
      }
      if (!['switched', 'restarted', 'healthy'].includes(record.stage)) {
        throw new Error('Journaled native A/B activation is not in a resumable B stage.');
      }
      await messaging('B');
      return Object.freeze({ stage: record.stage });
    },
    async recordRestarted() {
      const record = await owned();
      if (['restarted', 'healthy'].includes(record.stage)) return record;
      if (record.stage !== 'switched') throw new Error('Native B restart cannot precede verified B switch.');
      return advance(record, 'restarted');
    },
    async recordHealthy() {
      const record = await owned();
      if (record.stage === 'healthy') return record;
      if (record.stage !== 'restarted') throw new Error('Native B health cannot precede verified restart.');
      await messaging('B');
      if (await verifySustainedHealth({ release: 'B', transactionId, sourceSha: targetSha }) !== true) {
        throw new Error('Independent native B sustained health was not established.');
      }
      return advance(record, 'healthy');
    },
    async rollback() {
      let record = await owned();
      if (!['rollback_started', 'rollback_native_restored', 'rollback_healthy'].includes(record.stage)) {
        record = await advance(record, 'rollback_started');
      }
      if (record.stage === 'rollback_started') {
        await slotRestore(paths, { fsImpl });
        await registerNativeMessaging({ transactionId, release: 'A' });
        await messaging('A');
        record = await advance(record, 'rollback_native_restored');
      }
      if (!['rollback_native_restored', 'rollback_healthy'].includes(record.stage)) {
        throw new Error('Native A rollback has no verified restored ownership.');
      }
      await messaging('A');
      return Object.freeze({ stage: record.stage });
    },
    async recordRollbackHealthy() {
      const record = await owned();
      if (record.stage === 'rollback_healthy') return record;
      if (record.stage !== 'rollback_native_restored') throw new Error('Native A health cannot precede restoration.');
      await messaging('A');
      if (await verifySustainedHealth({ release: 'A', transactionId, sourceSha: currentSha }) !== true) {
        throw new Error('Independent native A sustained health was not established.');
      }
      return advance(record, 'rollback_healthy');
    },
    // Only after the separate Main receipt records succeeded/rolled_back;
    // the ACL-bound journal independently validates that receipt status.
    async finalizeCommitted() {
      let record = await owned();
      if (record.stage === 'healthy') record = await advance(record, 'committed');
      if (record.stage !== 'committed') throw new Error('Native B cannot discard A before durable committed receipt.');
      return slotCommit(paths, { fsImpl, verifyBHealth: async () => {
        await messaging('B');
        return verifySustainedHealth({ release: 'B', transactionId, sourceSha: targetSha });
      } });
    },
    async finalizeRolledBack() {
      let record = await owned();
      if (record.stage === 'rollback_healthy') record = await advance(record, 'rolled_back');
      if (record.stage !== 'rolled_back') throw new Error('Native A cannot be finalized before durable rolled-back receipt.');
      return slotFinalizeRollback(paths, { fsImpl, verifyAHealth: async () => {
        await messaging('A');
        return verifySustainedHealth({ release: 'A', transactionId, sourceSha: currentSha });
      } });
    },
  });
}
