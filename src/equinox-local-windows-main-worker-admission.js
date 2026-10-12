import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  inspectWindowsMainUpdateWorkerProcess,
  readWindowsMainUpdateWorkerOwnership,
} from './equinox-local-main-update-scheduler.js';
import { createEquinoxLocalWindowsNativeTransitionJournal } from './equinox-local-windows-native-transition-journal.js';
import { readEquinoxLocalMainNativePointer } from './equinox-local-main-native-state.js';
import { parseEquinoxVersion } from './equinox-local-updater.js';

const SHA = /^[a-f0-9]{40}$/u;
const TX = /^main-[a-f0-9]{32}$/u;
const TOKEN = /^[a-f0-9]{64}$/u;
const VALID_RESUME = new Set(['ready_to_switch', 'native_rollback_ready', 'native_switched', 'source_switched', 'rollback_source_restored', 'rollback_native_restored']);

/**
 * The actual detached Windows Main worker must first bind its launch owner,
 * real OS process and exact active Main receipt to one durable native journal.
 * This is admission, NOT permission to kill WPF or switch directories:
 * milestones remain fail-closed unless a separate verified supervisor exists.
 */
export async function admitWindowsMainNativeWorkerJournal({
  receipt, transition, installation, transactionRoot, engine,
  workerToken = process.env.EQUINOX_LOCAL_MAIN_WORKER_TOKEN,
  workerPid = process.pid, workerNodePath = process.execPath,
  fsImpl = fs,
  execFileImpl,
  readWorkerImpl = readWindowsMainUpdateWorkerOwnership,
  inspectWorkerImpl = inspectWindowsMainUpdateWorkerProcess,
  readPointerImpl = readEquinoxLocalMainNativePointer,
  journalFactory = createEquinoxLocalWindowsNativeTransitionJournal,
  verifyMilestone = async () => false,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ownershipAttempts = 25,
} = {}) {
  if (!TX.test(receipt?.transactionId ?? '') || !SHA.test(receipt?.currentSha ?? '') ||
      !SHA.test(receipt?.targetSha ?? '') || receipt.currentSha === receipt.targetSha ||
      !VALID_RESUME.has(receipt.stage) || !['promoting', 'verifying'].includes(receipt.status) ||
      !/^\d{4}-\d{2}-\d{2}T/u.test(receipt.startedAt ?? '') ||
      transition?.mode !== 'artifact_required' ||
      !['win32-x64', 'win32-arm64'].includes(transition.target) ||
      transition.currentSha !== receipt.currentSha || transition.targetSha !== receipt.targetSha ||
      !/^[a-f0-9]{64}$/u.test(transition.targetRuntimeContractSha256 ?? '') ||
      installation?.managed !== true || installation?.selfUpdateSupported !== true ||
      installation?.target !== transition.target ||
      typeof transactionRoot !== 'string' || !path.win32.isAbsolute(transactionRoot) ||
      !TOKEN.test(workerToken ?? '') || !Number.isSafeInteger(workerPid) || workerPid < 1 ||
      typeof workerNodePath !== 'string' || !path.win32.isAbsolute(workerNodePath) ||
      typeof engine?.readActive !== 'function' || typeof verifyMilestone !== 'function' ||
      typeof sleepImpl !== 'function' || !Number.isSafeInteger(ownershipAttempts) || ownershipAttempts < 1 || ownershipAttempts > 25) {
    throw new Error('Windows Main native worker journal admission lacks exact owned transaction identity.');
  }
  const releaseDir = installation.releaseDir;
  if (typeof releaseDir !== 'string' || !path.win32.isAbsolute(releaseDir)) {
    throw new Error('Windows Main worker requires its exact owned Stable release.');
  }
  const ownedNode = path.win32.join(releaseDir, 'runtime', 'node', 'bin', 'node.exe');
  const same = (a, b) => path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase();
  if (!same(workerNodePath, ownedNode)) throw new Error('Detached worker is not the product-owned Stable Node runtime.');
  // The Windows WPF parent starts Node before it persists the birthtime-bound
  // owner record. Allow a short bounded wait for that exact record only: a
  // present mismatched record is never retried or accepted as a race.
  let ownership = null;
  for (let attempt = 0; attempt < ownershipAttempts; attempt++) {
    ({ ownership } = await readWorkerImpl({ transactionId: receipt.transactionId, transactionRoot, fsImpl }));
    if (ownership) break;
    if (attempt + 1 < ownershipAttempts) await sleepImpl(200);
  }
  if (!ownership || ownership.transactionId !== receipt.transactionId ||
      ownership.pid !== workerPid || !same(ownership.nodePath, ownedNode) ||
      !TOKEN.test(ownership.token ?? '') ||
      !timingSafeEqual(Buffer.from(ownership.token, 'hex'), Buffer.from(workerToken, 'hex'))) {
    throw new Error('Windows Main worker launch token/PID and owned handoff record do not agree.');
  }
  const processIdentity = await inspectWorkerImpl(ownership, { execFileImpl });
  if (processIdentity?.running !== true || processIdentity?.stale || processIdentity?.uncertain) {
    throw new Error('Windows Main worker PID, OS creation timestamp or executable was not independently verified.');
  }
  const previousPointer = await readPointerImpl(path.win32.join(transactionRoot, 'current-native.json'), { transactionRoot, fsImpl }).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  const previousNative = previousPointer
    ? { kind: 'main', sourceSha: previousPointer.sourceSha, runtimeContractSha256: previousPointer.runtimeContractSha256 }
    : { kind: 'stable', version: parseEquinoxVersion(path.win32.basename(releaseDir)).text };
  if (previousPointer && (previousPointer.sourceSha !== receipt.currentSha ||
      previousPointer.target !== transition.target ||
      previousPointer.runtimeContractSha256 !== transition.currentRuntimeContractSha256)) {
    throw new Error('Windows Main worker previous native A identity differs from the source transaction.');
  }
  const inspectedReceipt = async () => {
    const active = await engine.readActive();
    if (!active || active.transactionId !== receipt.transactionId || active.currentSha !== receipt.currentSha ||
        active.targetSha !== receipt.targetSha || active.startedAt !== receipt.startedAt) {
      throw new Error('Windows Main native journal has no exact active receipt owner.');
    }
    return active;
  };
  const journal = journalFactory({ transactionRoot, fsImpl, platform: 'win32', inspectOwningReceipt: inspectedReceipt, verifyMilestone });
  const expected = { transactionId: receipt.transactionId, target: transition.target, currentSha: receipt.currentSha,
    targetSha: receipt.targetSha, receiptStartedAt: receipt.startedAt };
  if (receipt.stage === 'ready_to_switch') {
    try { await journal.create({ ...expected, previousNative, targetRuntimeContractSha256: transition.targetRuntimeContractSha256 }); }
    catch (error) { if (error?.code !== 'EEXIST') throw error; }
  }
  const record = await journal.read(receipt.transactionId, expected);
  if (record.targetRuntimeContractSha256 !== transition.targetRuntimeContractSha256 ||
      JSON.stringify(record.previousNative) !== JSON.stringify(previousNative)) {
    throw new Error('Windows native A/B journal previous identity or target contract drifted.');
  }
  // A self-asserted Node env token is insufficient for any destructive stage.
  return Object.freeze({ admitted: true, journal, record, ownedNode });
}
