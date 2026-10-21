import fs from 'node:fs/promises';
import path from 'node:path';

import {
  stageWindowsStableShellForRelease,
  snapshotWindowsStableShellTree,
  sameWindowsStableShellTree,
  renameWindowsPathWhenUnlocked,
} from './equinox-local-windows-stable-shell.js';

export type WindowsSlotPaths = Readonly<{
  transactionId:string;programRoot:string;previousReleaseDir:string;targetReleaseDir:string;
}>;
type SlotFs = typeof fs;
type SlotOptions = Readonly<{fsImpl?:SlotFs}>;
type SwitchOptions = SlotOptions & {
  requestShutdown?:()=>Promise<unknown>;
  sleepImpl?:(ms:number)=>Promise<unknown>;
};
type RestoreOptions = SlotOptions & {sleepImpl?:(ms:number)=>Promise<unknown>};
type CommitOptions = SlotOptions & {verifyBHealth?:()=>Promise<unknown>};
type RollbackOptions = SlotOptions & {verifyAHealth?:()=>Promise<unknown>};
function hasCode(error:unknown,code:string):boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}

const TX = /^main-[a-f0-9]{32}$/u;
const PATH_ERROR = 'Windows immutable native A/B slot identity is invalid.';

function ownedPaths({ transactionId, programRoot, previousReleaseDir, targetReleaseDir }: WindowsSlotPaths) {
  if (!TX.test(transactionId ?? '') ||
      ![programRoot, previousReleaseDir, targetReleaseDir].every((p) => typeof p === 'string' && path.isAbsolute(p) && path.normalize(p) === p)) {
    throw new Error(PATH_ERROR);
  }
  if (path.resolve(previousReleaseDir) === path.resolve(targetReleaseDir)) throw new Error(PATH_ERROR);
  const parent = path.dirname(programRoot);
  return Object.freeze({
    transactionId, programRoot, previousReleaseDir, targetReleaseDir,
    backupRoot: path.join(parent, `.equinox-shell-backup-${transactionId}`),
    quarantineRoot: path.join(parent, `.equinox-shell-failed-${transactionId}`),
  });
}

async function knownTree(root:string,fsImpl:SlotFs):Promise<Awaited<ReturnType<typeof snapshotWindowsStableShellTree>>|null> {
  try {
    const stat = await fsImpl.lstat(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Windows native slot is a foreign filesystem entry.');
    return await snapshotWindowsStableShellTree(root, { fsImpl });
  } catch (error) {
    if (hasCode(error,'ENOENT')) return null;
    throw error;
  }
}

async function referenceTree(releaseDir:string,fsImpl:SlotFs) {
  const rows = await snapshotWindowsStableShellTree(path.join(releaseDir, 'runtime', 'shell'), { fsImpl });
  if (!rows.some((entry) => entry.relative === 'EquinoxLocal.exe')) throw new Error('Windows release has no signed-shell entry.');
  return rows;
}

// This is the low-level detached-worker slot primitive. It does not decide
// update ownership, acknowledge a journal milestone, or launch the WPF shell.
// The old immutable A directory is retained until an independently proven
// B health/commit gate. Fixed transaction paths allow reboot-time inspection.
export async function switchWindowsNativeABSlot(options:WindowsSlotPaths, {
  fsImpl = fs, requestShutdown, sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)),
}:SwitchOptions = {}) {
  const p = ownedPaths(options);
  if (typeof requestShutdown !== 'function') throw new Error('Native switch requires an explicit owned WPF shutdown callback.');
  const [a, b, backup, current, foreignQuarantine] = await Promise.all([
    referenceTree(p.previousReleaseDir, fsImpl), referenceTree(p.targetReleaseDir, fsImpl),
    knownTree(p.backupRoot, fsImpl), knownTree(p.programRoot, fsImpl), knownTree(p.quarantineRoot, fsImpl),
  ]);
  if (foreignQuarantine || (backup && !sameWindowsStableShellTree(backup, a))) throw new Error('Native A/B transaction has a foreign backup or orphan quarantine.');
  if (backup && current && sameWindowsStableShellTree(current, b)) return Object.freeze({ stage: 'switched', recovered: true, backupRoot: p.backupRoot });
  if (backup && current) throw new Error('Native A/B state is ambiguous: original backup and foreign active directory both exist.');
  if (!backup && (!current || !sameWindowsStableShellTree(current, a))) throw new Error('Native A/B previous release does not match the installed shell.');

  const staged = await stageWindowsStableShellForRelease({ releaseDir: p.targetReleaseDir, programRoot: p.programRoot, fsImpl });
  try {
    await requestShutdown!();
    if (!backup) await renameWindowsPathWhenUnlocked(p.programRoot, p.backupRoot, { fsImpl, sleepImpl });
    await renameWindowsPathWhenUnlocked(staged.stagedRoot, p.programRoot, { fsImpl, sleepImpl });
    const installed = await knownTree(p.programRoot, fsImpl);
    if (!installed || !sameWindowsStableShellTree(installed, b)) throw new Error('Native B shell failed post-switch SHA validation.');
    const retained = await knownTree(p.backupRoot, fsImpl);
    if (!retained || !sameWindowsStableShellTree(retained, a)) throw new Error('Native A rollback backup was not retained after switch.');
    return Object.freeze({ stage: 'switched', recovered: Boolean(backup), backupRoot: p.backupRoot });
  } finally {
    // Never delete the old A backup, even after a failed B rename.
    await fsImpl.rm(staged.stagedRoot, { recursive: true, force: true }).catch(() => {});
  }
}

export async function restoreWindowsNativeABSlot(options:WindowsSlotPaths, {
  fsImpl = fs, sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}:RestoreOptions = {}) {
  const p = ownedPaths(options);
  const [a, b, backup, active, quarantine] = await Promise.all([
    referenceTree(p.previousReleaseDir, fsImpl), referenceTree(p.targetReleaseDir, fsImpl),
    knownTree(p.backupRoot, fsImpl), knownTree(p.programRoot, fsImpl), knownTree(p.quarantineRoot, fsImpl),
  ]);
  if (quarantine && !sameWindowsStableShellTree(quarantine, b)) {
    throw new Error('Native A/B rollback has a foreign candidate quarantine.');
  }
  if (!backup) {
    // Crash after A was successfully restored but before the receipt advanced:
    // A plus a verified B quarantine is a legitimate idempotent replay state.
    if (active && sameWindowsStableShellTree(active, a)) {
      return Object.freeze({ stage: 'restored', recovered: true, quarantineRoot: quarantine ? p.quarantineRoot : null });
    }
    throw new Error('Native A/B rollback lacks the exact old A backup.');
  }
  if (quarantine && active) throw new Error('Native A/B rollback has ambiguous active and quarantined candidates.');
  if (!sameWindowsStableShellTree(backup, a) || (active && !sameWindowsStableShellTree(active, b))) {
    throw new Error('Native A/B rollback old A or active B hash mismatch.');
  }
  // Windows may retain WPF image/Native Messaging file locks briefly after
  // shutdown. Use the same bounded, lock-error-only retry as forward A→B;
  // never fall back to copying or discard old A on a failed rollback rename.
  if (active) await renameWindowsPathWhenUnlocked(p.programRoot, p.quarantineRoot, { fsImpl, sleepImpl });
  // If power loss occurs between candidate quarantine and A restoration,
  // the verified old A stays at its deterministic backup path for recovery.
  await renameWindowsPathWhenUnlocked(p.backupRoot, p.programRoot, { fsImpl, sleepImpl });
  const restored = await knownTree(p.programRoot, fsImpl);
  if (!restored || !sameWindowsStableShellTree(restored, a)) throw new Error('Native A/B restored shell verification failed.');
  return Object.freeze({ stage: 'restored', recovered: Boolean(quarantine), quarantineRoot: p.quarantineRoot });
}

export async function commitWindowsNativeABSlot(options:WindowsSlotPaths, { fsImpl = fs, verifyBHealth }:CommitOptions = {}) {
  const p = ownedPaths(options);
  if (typeof verifyBHealth !== 'function') throw new Error('Native B commit requires an independent health verifier.');
  const [a, b, backup, active, quarantine] = await Promise.all([
    referenceTree(p.previousReleaseDir, fsImpl), referenceTree(p.targetReleaseDir, fsImpl),
    knownTree(p.backupRoot, fsImpl), knownTree(p.programRoot, fsImpl), knownTree(p.quarantineRoot, fsImpl),
  ]);
  if (quarantine || !backup || !sameWindowsStableShellTree(backup, a) || !active || !sameWindowsStableShellTree(active, b)) {
    throw new Error('Native B commit requires intact B and recoverable old A.');
  }
  if (await verifyBHealth!() !== true) throw new Error('Native B sustained health was not independently verified.');
  // Sustained health is asynchronous; a foreign process can replace B or the
  // old A backup while the owner waits. Never delete a stale-checked A path.
  const [aNow, bNow, backupNow, activeNow, quarantineNow] = await Promise.all([
    referenceTree(p.previousReleaseDir, fsImpl), referenceTree(p.targetReleaseDir, fsImpl),
    knownTree(p.backupRoot, fsImpl), knownTree(p.programRoot, fsImpl), knownTree(p.quarantineRoot, fsImpl),
  ]);
  if (!sameWindowsStableShellTree(aNow, a) || !sameWindowsStableShellTree(bNow, b) ||
      !backupNow || !sameWindowsStableShellTree(backupNow, a) ||
      !activeNow || !sameWindowsStableShellTree(activeNow, b) || quarantineNow) {
    throw new Error('Native A/B slot ownership changed while B health was being verified; old A must be preserved.');
  }
  // This commit operation must only be invoked after the owning durable
  // receipt has recorded successful runtime and Native Messaging health.
  await fsImpl.rm(p.backupRoot, { recursive: true, force: false });
  return Object.freeze({ stage: 'committed' });
}

// The failed B quarantine is not discarded until old A has demonstrably
// started and passed the owning receipt's independent rollback health gate.
export async function finalizeWindowsNativeABRollback(options:WindowsSlotPaths, { fsImpl = fs, verifyAHealth }:RollbackOptions = {}) {
  const p = ownedPaths(options);
  if (typeof verifyAHealth !== 'function') throw new Error('Native A rollback finalization requires independent health verification.');
  const [a, b, active, backup, quarantine] = await Promise.all([
    referenceTree(p.previousReleaseDir, fsImpl), referenceTree(p.targetReleaseDir, fsImpl),
    knownTree(p.programRoot, fsImpl), knownTree(p.backupRoot, fsImpl), knownTree(p.quarantineRoot, fsImpl),
  ]);
  if (!active || !sameWindowsStableShellTree(active, a) || backup ||
      (quarantine && !sameWindowsStableShellTree(quarantine, b))) {
    throw new Error('Native A rollback finalization requires exact installed A and no stranded backup.');
  }
  if (await verifyAHealth!() !== true) throw new Error('Native A rollback runtime health was not independently verified.');
  // A foreign directory can replace failed B while the native health verifier
  // waits. Never remove an unverified or newly introduced quarantine tree.
  const [aNow, bNow, activeNow, backupNow, quarantineNow] = await Promise.all([
    referenceTree(p.previousReleaseDir, fsImpl), referenceTree(p.targetReleaseDir, fsImpl),
    knownTree(p.programRoot, fsImpl), knownTree(p.backupRoot, fsImpl), knownTree(p.quarantineRoot, fsImpl),
  ]);
  if (!sameWindowsStableShellTree(aNow, a) || !sameWindowsStableShellTree(bNow, b) ||
      !activeNow || !sameWindowsStableShellTree(activeNow, a) || backupNow ||
      Boolean(quarantineNow) !== Boolean(quarantine) ||
      (quarantineNow && !sameWindowsStableShellTree(quarantineNow, b))) {
    throw new Error('Native A/B slot ownership changed while A health was being verified; quarantine must be preserved.');
  }
  if (quarantine) await fsImpl.rm(p.quarantineRoot, { recursive: true, force: false });
  return Object.freeze({ stage: 'rolled_back' });
}
