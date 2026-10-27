import type {MainRecoveryEngine, MainTransactionReceipt} from "./equinox-local-main-update-transaction.js";
import type {WindowsJournal, WindowsJournalRecord} from "./equinox-local-windows-native-transition-journal.js";

import { createHash, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  inspectWindowsMainUpdateWorkerProcess,
  readWindowsMainUpdateWorkerOwnership,
} from './equinox-local-main-update-scheduler.js';
import { createEquinoxLocalWindowsNativeTransitionJournal } from './equinox-local-windows-native-transition-journal.js';
import { readEquinoxLocalMainNativePointer } from './equinox-local-main-native-state.js';
import { parseEquinoxVersion } from './equinox-local-updater.js';
import { provisionWindowsGuardianFromRelease } from './equinox-local-windows-guardian-provision.js';
import { attestEquinoxWindowsOriginalGuardianSession, attestEquinoxWindowsNativePhysicalMilestone, proveEquinoxWindowsNativeJournalAuthority, requestEquinoxWindowsOwnedNativeShellHealth } from './equinox-local-windows-native-journal-authority-client.js';

type AdmissionFs = typeof fs;
type WorkerOwnerResult = Awaited<ReturnType<typeof readWindowsMainUpdateWorkerOwnership>>;
type WorkerOwnership = NonNullable<WorkerOwnerResult["ownership"]>;
type WorkerInspector = typeof inspectWindowsMainUpdateWorkerProcess;
type NativePointer = Awaited<ReturnType<typeof readEquinoxLocalMainNativePointer>>;
type NativeTransition = Readonly<{
  mode: string; target: string; currentSha?: string | undefined; targetSha?: string | undefined;
  currentRuntimeContractSha256: string; targetRuntimeContractSha256: string;
}>;
type NativeInstallation = Readonly<{
  managed: boolean; selfUpdateSupported: boolean; target: string;
  releaseDir?: string;
}>;
type NativeJournalFactory = typeof createEquinoxLocalWindowsNativeTransitionJournal;
type OwnerRead = (options: {transactionId: string; transactionRoot: string; fsImpl: AdmissionFs}) => Promise<WorkerOwnerResult>;
type ProcessInspect = WorkerInspector;
type NativePointerRead = (filePath: string, options: {transactionRoot: string; fsImpl: AdmissionFs}) => Promise<NativePointer>;
type AdmissionOptions = {
  receipt?: MainTransactionReceipt;
  transition?: NativeTransition; installation?: NativeInstallation;
  transactionRoot?: string;
  engine?: Pick<MainRecoveryEngine, "readActive">;
  workerToken?: string; workerPid?: number; workerNodePath?: string;
  nativeHelperPath?: string | null;
  fsImpl?: AdmissionFs;
  execFileImpl?: NonNullable<Parameters<WorkerInspector>[1]>["execFileImpl"];
  readWorkerImpl?: OwnerRead;
  inspectWorkerImpl?: ProcessInspect;
  readPointerImpl?: NativePointerRead;
  journalFactory?: NativeJournalFactory;
  verifyMilestone?: (record:WindowsJournalRecord,to:string) => Promise<boolean>;
  ownerOnly?: boolean;
  authenticateSignedGuardianImpl?: typeof authenticateOriginalWindowsGuardianOwner;
  attestGuardianSessionImpl?: typeof attestEquinoxWindowsOriginalGuardianSession;
  sleepImpl?: (ms: number) => Promise<unknown>;
  ownershipAttempts?: number;
};
type WorkerAdmission = Readonly<{
  admitted: true; ownedNode: string; ownerOnly?: true;
  journal?: WindowsJournal; record?: WindowsJournalRecord;
  guardian?: Readonly<{guardianPid:number; workerPid:number; workerStartTimeUtcTicks:string; originalSignedOwner:true}>;
  supervisor?: Readonly<{independentNativeOwner:true;
    assertWorkerOwnership:(args:Record<string,unknown>)=>Promise<boolean>;
    shutdownOwnedWpf:(args:Record<string,unknown>)=>Promise<boolean>;
    quiesceOwnedB:(args:Record<string,unknown>)=>Promise<boolean>;
    verifyNativeMessaging:(args:Record<string,unknown>)=>Promise<boolean>;
    verifySustainedHealth:(args:Record<string,unknown>)=>Promise<boolean>}>;
}>;
function hasErrorCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}

const SHA = /^[a-f0-9]{40}$/u;
const TX = /^main-[a-f0-9]{32}$/u;
const TOKEN = /^[a-f0-9]{64}$/u;
const VALID_RESUME = new Set(['ready_to_switch', 'native_rollback_ready', 'native_switched', 'source_switched', 'rollback_source_restored', 'rollback_native_restored']);

type GuardianOwnerInput = {
  transactionId:string; transactionRoot:string; releaseDir:string;
  workerToken:string; workerPid:number; workerStartTimeUtcTicks:string;
  fsImpl:AdmissionFs; sleepImpl:(ms:number)=>Promise<unknown>;
};
const HEX_DIGEST = /^[a-f0-9]{64}$/u;
const ORIGINAL_PROOF_KEYS = ['guardianPid', 'handoffSha256', 'journalSha256', 'schemaVersion',
  'sequence', 'stage', 'transactionId', 'workerPid', 'workerStartTimeUtcTicks'];

// The original signed A can run from either a numbered Stable release or
// the exact committed immutable Main native-store. The transaction root,
// NOT the location of A's release, identifies the one installed product.
export function resolveWindowsGuardianInstallationRoot(transactionRoot:string,releaseDir:string):string {
  if (!path.win32.isAbsolute(transactionRoot) || !path.win32.isAbsolute(releaseDir))
    throw new Error('Guardian session root is not the actual signed product installation.');
  const installRoot = path.win32.dirname(path.win32.dirname(transactionRoot));
  const same = (a:string,b:string) => path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase();
  const stableRoot = path.win32.join(installRoot,'releases');
  const stable = same(path.win32.dirname(releaseDir),stableRoot) &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(path.win32.basename(releaseDir));
  const nativeRoot = path.win32.join(transactionRoot,'native-store',
    `win32-${process.arch}`);
  const mainParts = path.win32.relative(nativeRoot,releaseDir).split(path.win32.sep);
  const main = mainParts.length === 2 && /^[a-f0-9]{40}$/u.test(mainParts[0]??'') &&
    mainParts[1] === 'release' &&
    same(releaseDir,path.win32.join(nativeRoot,mainParts[0]!,mainParts[1]!));
  if (!same(transactionRoot,path.win32.join(installRoot,'state','main-update')) ||
      (!stable && !main)) {
    throw new Error('Guardian session root is not the actual signed product installation.');
  }
  return installRoot;
}

// The existing product-installed Guardian is itself the only kernel-native
// authority. This helper neither grants a supervisor nor replaces the sole
// JS journal writer. A failure leaves Guardian's original durable owner lock
// for EXPLICIT signed recovery; NEVER unlink/kill-and-retry it on an error.
export async function authenticateOriginalWindowsGuardianOwner({
  transactionId, transactionRoot, releaseDir, workerToken, workerPid,
  workerStartTimeUtcTicks, fsImpl, sleepImpl,
}:GuardianOwnerInput) {
  if (process.platform !== 'win32' || !TX.test(transactionId) ||
      !TOKEN.test(workerToken) || workerPid !== process.pid ||
      !path.win32.isAbsolute(transactionRoot) ||
      !path.win32.isAbsolute(releaseDir) ||
      !/^[0-9]{1,19}$/u.test(workerStartTimeUtcTicks)) {
    throw new Error('Signed Windows Guardian requires its original live product worker.');
  }
  const installRoot = resolveWindowsGuardianInstallationRoot(transactionRoot, releaseDir);
  // Provision ONLY the exact authenticated current A Guardian, never a
  // different obsolete numbered Stable Guardian. Existing differing bytes
  // are refused by the exclusive installer rather than silently replaced.
  await provisionWindowsGuardianFromRelease({ installation:{ platform:'win32',
    target:`win32-${process.arch}`, installRoot, releaseDir }, fsImpl });
  const installed = path.win32.join(installRoot, 'runtime', 'guardian', 'EquinoxLocalGuardian.exe');
  const releaseGuardian = path.win32.join(releaseDir, 'runtime', 'guardian', 'EquinoxLocalGuardian.exe');
  const digest = async (file:string) => {
    const fd = await fsImpl.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const stat = await fd.stat();
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
          stat.size < 1024 || stat.size > 150 * 1024 * 1024) {
        throw new Error('Original signed Guardian executable has invalid filesystem identity.');
      }
      const hash = createHash('sha256');
      const buf = Buffer.allocUnsafe(128 * 1024);
      let offset = 0;
      while (offset < stat.size) {
        const {bytesRead} = await fd.read(buf, 0, Math.min(buf.length, stat.size - offset), offset);
        if (bytesRead === 0) throw new Error('Signed Guardian executable shortened during read.');
        hash.update(buf.subarray(0, bytesRead));
        offset += bytesRead;
      }
      return hash.digest('hex');
    } finally { await fd.close(); }
  };
  if (await digest(installed) !== await digest(releaseGuardian)) {
    throw new Error('Installed original signed Guardian differs from the current immutable A release.');
  }
  const root = path.win32.join(transactionRoot, 'guardian-journal');
  const journalPath = path.win32.join(root, transactionId + '.json');
  const handoffPath = path.win32.join(transactionRoot, 'handoff', transactionId + '.windows-worker.json');
  const authorityPath = path.win32.join(root, transactionId + '.native-authority.json');
  const leasePath = path.win32.join(root, '.' + transactionId + '.guardian-session-lock');
  const readBounded = async (file:string, maximum:number) => {
    const fd = await fsImpl.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const stat = await fd.stat();
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
          stat.size < 2 || stat.size > maximum) throw new Error('Original signed Guardian proof is not a bounded normal file.');
      const bytes = await fd.readFile();
      if (bytes.length !== stat.size) throw new Error('Original Guardian proof changed during inspection.');
      return bytes;
    } finally { await fd.close(); }
  };
  // A preexisting proof or crashed native lease is NEVER a green-light for
  // another Guardian process. Only the product native crash reconciler may
  // explicitly clear it after restoring EXACT old A.
  for (const file of [authorityPath, leasePath]) {
    try { await fsImpl.lstat(file); throw new Error('Original signed Guardian session already exists; explicit recovery required.'); }
    catch (error) { if (!hasErrorCode(error, 'ENOENT')) throw error; }
  }
  const prepared = await readBounded(journalPath, 8192);
  const record = JSON.parse(prepared.toString('utf8')) as Record<string,unknown>;
  if (record.transactionId !== transactionId || record.stage !== 'prepared' || record.sequence !== 0) {
    throw new Error('Original signed Guardian requires the first prepared journal generation.');
  }
  const handoff = await readBounded(handoffPath, 8192);
  const journalSha256 = createHash('sha256').update(prepared).digest('hex');
  const handoffSha256 = createHash('sha256').update(handoff).digest('hex');
  const child = spawn(installed, ['--hold-native-journal-authority'], {
    windowsHide:true, stdio:'ignore', shell:false, detached:false,
  });
  await new Promise<void>((resolve,reject)=>{
    child.once('spawn',resolve);
    child.once('error',reject);
  });
  const guardianPid = child.pid;
  if (!Number.isSafeInteger(guardianPid) || !guardianPid || guardianPid < 1) {
    throw new Error('Original signed Guardian has no kernel-backed process identifier.');
  }
  // Retry only before the immutable prepared HMAC was sent; NEVER replay
  // a completed challenge or clean up an original Guardian's own lease.
  let proved = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (child.exitCode !== null) throw new Error('Original signed Guardian exited before ownership proof.');
    try {
      await proveEquinoxWindowsNativeJournalAuthority({
        transactionId, transactionRoot, workerToken, platform:'win32',
      });
      proved = true;
      break;
    } catch (error) {
      if (!['ENOENT', 'ECONNREFUSED'].includes(String(error && typeof error === 'object' && 'code' in error ? error.code : '')) ||
          attempt === 39) throw error;
      await sleepImpl(125);
    }
  }
  if (!proved) throw new Error('Original signed Guardian refused live prepared worker HMAC.');
  let proof:Record<string,unknown>|null = null;
  for (let attempt = 0; attempt < 32; attempt++) {
    if (child.exitCode !== null) throw new Error('Original signed Guardian exited without durable ownership.');
    try {
      const value = JSON.parse((await readBounded(authorityPath,8192)).toString('utf8'));
      if (value && typeof value === 'object' && !Array.isArray(value)) proof = value as Record<string,unknown>;
      break;
    } catch (error) {
      // A still-flushing native FileShare.None proof briefly surfaces as EBUSY
      // on Windows. Retry only its bounded, already authenticated read.
      if (!hasErrorCode(error,'ENOENT') && !hasErrorCode(error,'EACCES') &&
          !hasErrorCode(error,'EBUSY')) throw error;
      await sleepImpl(125);
    }
  }
  if (!proof || Object.keys(proof).sort().join(',') !== ORIGINAL_PROOF_KEYS.join(',') ||
      proof.schemaVersion !== 1 || proof.transactionId !== transactionId ||
      proof.stage !== 'prepared' || proof.sequence !== 0 ||
      proof.guardianPid !== guardianPid || proof.workerPid !== workerPid ||
      proof.workerStartTimeUtcTicks !== workerStartTimeUtcTicks ||
      typeof proof.journalSha256 !== 'string' || !HEX_DIGEST.test(proof.journalSha256) ||
      proof.journalSha256 !== journalSha256 ||
      typeof proof.handoffSha256 !== 'string' || !HEX_DIGEST.test(proof.handoffSha256) ||
      proof.handoffSha256 !== handoffSha256 ||
      child.exitCode !== null) {
    throw new Error('Original signed Guardian durable kernel worker/journal/handoff attestation failed.');
  }
  const lease = await fsImpl.lstat(leasePath);
  if (!lease.isFile() || lease.isSymbolicLink() || lease.nlink !== 1) {
    throw new Error('Original signed Guardian did not retain its exclusive native OS session lease.');
  }
  child.unref();
  return Object.freeze({originalSignedOwner:true as const, guardianPid, workerPid, workerStartTimeUtcTicks});
}

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
  nativeHelperPath = null,
  fsImpl = fs,
  execFileImpl,
  readWorkerImpl = readWindowsMainUpdateWorkerOwnership,
  inspectWorkerImpl = inspectWindowsMainUpdateWorkerProcess,
  readPointerImpl = readEquinoxLocalMainNativePointer,
  journalFactory = createEquinoxLocalWindowsNativeTransitionJournal,
  verifyMilestone,
  ownerOnly = false,
  authenticateSignedGuardianImpl = authenticateOriginalWindowsGuardianOwner,
  attestGuardianSessionImpl = attestEquinoxWindowsOriginalGuardianSession,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ownershipAttempts = 25,
}: AdmissionOptions = {}): Promise<WorkerAdmission> {
  if (!receipt || !TX.test(receipt.transactionId ?? '') || !SHA.test(receipt?.currentSha ?? '') ||
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
      (typeof workerToken !== 'string' || !TOKEN.test(workerToken)) || !Number.isSafeInteger(workerPid) || workerPid < 1 ||
      typeof workerNodePath !== 'string' || !path.win32.isAbsolute(workerNodePath) ||
      typeof engine?.readActive !== 'function' || (verifyMilestone !== undefined && typeof verifyMilestone !== 'function') ||
      typeof sleepImpl !== 'function' || !Number.isSafeInteger(ownershipAttempts) || ownershipAttempts < 1 || ownershipAttempts > 25) {
    throw new Error('Windows Main native worker journal admission lacks exact owned transaction identity.');
  }
  const releaseDir = installation.releaseDir;
  if (typeof releaseDir !== 'string' || !path.win32.isAbsolute(releaseDir)) {
    throw new Error('Windows Main worker requires its exact owned Stable release.');
  }
  const ownedNode = path.win32.join(releaseDir, 'runtime', 'node', 'bin', 'node.exe');
  const same = (a: string, b: string) => path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase();
  if (!same(workerNodePath, ownedNode)) throw new Error('Detached worker is not the product-owned Stable Node runtime.');
  // The Windows WPF parent starts Node before it persists the birthtime-bound
  // owner record. Allow a short bounded wait for that exact record only: a
  // present mismatched record is never retried or accepted as a race.
  let ownership: WorkerOwnership | null = null;
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
  if (typeof nativeHelperPath !== 'string' || !path.win32.isAbsolute(nativeHelperPath)) {
    throw new Error('Windows native worker has no validated native identity helper.');
  }
  const processIdentity = await inspectWorkerImpl(ownership, { ...(execFileImpl ? {execFileImpl} : {}), nativeHelperPath });
  if (processIdentity?.running !== true || processIdentity?.stale || processIdentity?.uncertain) {
    throw new Error('Windows Main worker PID, OS creation timestamp or executable was not independently verified.');
  }
  // For a full clean replacement, the existing detached WPF handoff and
  // durable promotion receipt are the only owners we need. Do not create a
  // second Guardian journal/IPC state machine just to replace installed code.
  if (ownerOnly) {
    const active = await engine.readActive();
    if (!active || active.transactionId !== receipt.transactionId ||
        active.currentSha !== receipt.currentSha || active.targetSha !== receipt.targetSha ||
        active.startedAt !== receipt.startedAt || active.stage !== receipt.stage) {
      throw new Error('Windows clean-replacement worker lost its exact active transaction.');
    }
    return Object.freeze({ admitted: true, ownerOnly: true, ownedNode });
  }
  const previousPointer = await readPointerImpl(path.win32.join(transactionRoot, 'current-native.json'), { transactionRoot, fsImpl }).catch((error) => {
    if (hasErrorCode(error, 'ENOENT')) return null;
    throw error;
  });
  const previousNative = previousPointer
    ? { kind: 'main' as const, sourceSha: previousPointer.sourceSha, runtimeContractSha256: previousPointer.runtimeContractSha256 }
    : { kind: 'stable' as const, version: parseEquinoxVersion(path.win32.basename(releaseDir)).text };
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
  // ONE durable JS journal writer. The DEFAULT stage verifier is NOT a
  // Node-side boolean: each physical milestone must be authenticated by the
  // original signed Guardian process, matching CURRENT journal bytes, kernel
  // worker PID/birth and pinned executable File ID. Only explicit unit-test
  // injection may replace the real native OS transport.
  const verifyPhysicalMilestone = verifyMilestone ?? (async (_record:WindowsJournalRecord,to:string) => {
    if (!['native_staged','shell_stopped','switched','restarted','healthy','committed',
      'rollback_started','rollback_native_restored','rollback_healthy','rolled_back'].includes(to)) return false;
    await attestEquinoxWindowsNativePhysicalMilestone({
      transactionId:receipt.transactionId, transactionRoot, workerToken, platform:'win32',
      to:to as Parameters<typeof attestEquinoxWindowsNativePhysicalMilestone>[0]['to'],
    });
    return true;
  });
  const journal = journalFactory({ transactionRoot, fsImpl, platform: 'win32', inspectOwningReceipt: inspectedReceipt, verifyMilestone:verifyPhysicalMilestone });
  const expected = { transactionId: receipt.transactionId, target: transition.target, currentSha: receipt.currentSha,
    targetSha: receipt.targetSha, receiptStartedAt: receipt.startedAt };
  if (receipt.stage === 'ready_to_switch') {
    try { await journal.create({ ...expected, previousNative, targetRuntimeContractSha256: transition.targetRuntimeContractSha256 }); }
    catch (error) { if (!hasErrorCode(error, 'EEXIST')) throw error; }
  }
  const record = await journal.read(receipt.transactionId, expected);
  if (record.targetRuntimeContractSha256 !== transition.targetRuntimeContractSha256 ||
      JSON.stringify(record.previousNative) !== JSON.stringify(previousNative)) {
    throw new Error('Windows native A/B journal previous identity or target contract drifted.');
  }
  // A PID/token and prepared Node journal are never enough for full native
  // admission. Launch the ACTUAL installed signed Guardian and require its
  // independently durable, kernel-PID-bound live prepared HMAC receipt.
  const guardian = await authenticateSignedGuardianImpl({
    transactionId: receipt.transactionId, transactionRoot, releaseDir, workerToken,
    workerPid, workerStartTimeUtcTicks: ownership.startTimeUtcTicks, fsImpl,
    sleepImpl,
  });
  if (!guardian || guardian.originalSignedOwner !== true ||
      guardian.workerPid !== workerPid ||
      guardian.workerStartTimeUtcTicks !== ownership.startTimeUtcTicks ||
      !Number.isSafeInteger(guardian.guardianPid) || guardian.guardianPid < 1) {
    throw new Error('Original signed Guardian OS owner is not independently admitted.');
  }
  // Durable receipt alone is historical evidence: the Guardian may already
  // have exited. The SAME ORIGINAL signed executable must answer a second,
  // fresh per-current-journal HMAC from this exact OS worker before admission.
  // The independent Guardian verifies its own pinned NTFS FILE ID/kernel PID.
  await attestGuardianSessionImpl({
    transactionId: receipt.transactionId, transactionRoot, workerToken, platform:'win32',
  });
  // These are ADDITIONAL independent signed-OS observations consumed by the
  // pre-existing supervisor-bound A/B adapter, NOT a new WPF controller.
  const assertLiveWorker=async()=>{
    await attestGuardianSessionImpl({
      transactionId:receipt.transactionId,transactionRoot,workerToken,platform:'win32',
    });
    const active=await inspectedReceipt();
    if (!['promoting','verifying','succeeded','rolled_back'].includes(active.status))
      throw new Error('Signed Guardian lost the exact active or durable terminal transaction.');
    return true;
  };
  const signedShutdownReceipt = async (kind:'A'|'B')=>{
    await assertLiveWorker();
    const nativeRoot=path.win32.join(transactionRoot,'guardian-journal');
    const file=path.win32.join(nativeRoot,receipt.transactionId+
      (kind==='A'?'.stable-shell-quiesce.json':'.b-shell-quiesce.json'));
    const inspectFile=async(filePath:string):Promise<Buffer>=>{
      // Read the SAME normal file handle from stat to bytes. A recreated
      // pathname or truncated stage receipt cannot become a signed OS proof.
      const fd=await fsImpl.open(filePath,fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      try {
        const st=await fd.stat();
        if (!st.isFile() || st.isSymbolicLink() || st.nlink!==1 ||
            st.size<2 || st.size>8192)
          throw new Error('Original signed WPF evidence file is not an immutable bounded normal file.');
        const bytes=await fd.readFile();
        if (bytes.length!==st.size) throw new Error('Original WPF evidence was replaced during read.');
        return bytes;
      }finally{await fd.close();}
    };
    const proof=JSON.parse((await inspectFile(file)).toString('utf8')) as Record<string,unknown>;
    const journalBytes=await inspectFile(path.win32.join(nativeRoot,receipt.transactionId+'.json'));
    const journal=JSON.parse(journalBytes.toString('utf8')) as Record<string,unknown>;
    const stage=kind==='A'?'native_staged':'rollback_started';
    const generation=journal.sequence;
    const validGeneration=kind==='A'?generation===1:
      Number.isSafeInteger(generation) && typeof generation==='number' &&
      generation>=1 && generation<=6;
    const stageHash=createHash('sha256').update(journalBytes).digest('hex');
    const handoffHash=kind==='B'?createHash('sha256').update(await inspectFile(
      path.win32.join(transactionRoot,'handoff',receipt.transactionId+'.windows-worker.json'))).digest('hex'):null;
    const originalAKeys=['disposition','guardianPid','preparedJournalSha256','schemaVersion',
      'shellPid','shellStartTimeUtcTicks','transactionId','workerPid','workerStartTimeUtcTicks'];
    const originalBKeys=['disposition','guardianPid','handoffSha256','rollbackJournalSha256',
      'schemaVersion','sequence','shellPid','shellStartTimeUtcTicks','stage','transactionId',
      'workerPid','workerStartTimeUtcTicks'];
    const keys=kind==='A'?originalAKeys:originalBKeys;
    const savedHash=kind==='A'?proof.preparedJournalSha256:proof.rollbackJournalSha256;
    if (Object.keys(proof).sort().join(',')!==keys.join(',') ||
        proof.schemaVersion!==1 || proof.transactionId!==receipt.transactionId ||
        proof.workerPid!==workerPid || proof.workerStartTimeUtcTicks!==ownership.startTimeUtcTicks ||
        proof.guardianPid!==guardian.guardianPid ||
        proof.disposition!==(kind==='A'?'stable-shell-quiesced-only':'b-shell-quiesced-only') ||
        !Number.isSafeInteger(proof.shellPid) || (proof.shellPid as number)<1 ||
        typeof proof.shellStartTimeUtcTicks!=='string' ||
        !/^[0-9]{1,19}$/u.test(proof.shellStartTimeUtcTicks) ||
        journal.stage!==stage || journal.transactionId!==receipt.transactionId ||
        !validGeneration || typeof savedHash!=='string' ||
        !HEX_DIGEST.test(savedHash) || savedHash!==stageHash ||
        (kind==='B' && (proof.stage!=='rollback_started' ||
          proof.sequence!==generation ||
          typeof proof.handoffSha256!=='string' ||
          !HEX_DIGEST.test(proof.handoffSha256) || proof.handoffSha256!==handoffHash))) {
      throw new Error('Original native WPF shutdown receipt is not bound to this Guardian and exact journal generation.');
    }
    await assertLiveWorker();
    return true;
  };
  const supervisor=Object.freeze({
    independentNativeOwner:true as const,
    assertWorkerOwnership:async (_args:Record<string,unknown>)=>assertLiveWorker(),
    shutdownOwnedWpf:async (args:Record<string,unknown>)=>{
      if(args.afterSignedExit!==true) throw new Error('Only signed Guardian may shut down original A.');
      return signedShutdownReceipt('A');
    },
    quiesceOwnedB:async (args:Record<string,unknown>)=>{
      if(args.afterSignedExit!==true || args.release!=='B')
        throw new Error('Only signed Guardian may quiesce native B.');
      return signedShutdownReceipt('B');
    },
    verifyNativeMessaging:async (_args:Record<string,unknown>)=>assertLiveWorker(),
    verifySustainedHealth:async (args:Record<string,unknown>)=>{
      if(args.release!=='A' && args.release!=='B') throw new Error('Native WPF health release is invalid.');
      await assertLiveWorker();
      await requestEquinoxWindowsOwnedNativeShellHealth({
        transactionId:receipt.transactionId,transactionRoot,workerToken,platform:'win32',release:args.release,
      });
      return assertLiveWorker();
    },
  });
  return Object.freeze({ admitted: true, journal, record, ownedNode, guardian, supervisor });
}
