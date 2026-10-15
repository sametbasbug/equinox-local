import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

import { EQUINOX_LOCAL_DUGITE_VERSION } from './equinox-local-runtime-versions.js';
import { readEquinoxLocalMainSourcePointer, writeEquinoxLocalMainSourcePointer } from './equinox-local-main-source-pointer.js';
import { readEquinoxLocalMainNativePointer } from './equinox-local-main-native-state.js';
import {
  assertWindowsNativeMessagingHostOwnership,
  registerWindowsNativeMessagingHost,
  windowsNativeMessagingLauncherPath,
} from './equinox-browser-windows-native-messaging.js';

const TX = /^main-[a-f0-9]{32}$/u;
const TOKEN = /^[a-f0-9]{64}$/u;
const SHA = /^[a-f0-9]{40}$/u;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const WORKER_DOMAIN = 'equinox-local-guardian-ab-select-stable-a-worker-v1:';
const OWNER_DOMAIN = 'equinox-local-guardian-ab-select-stable-a-owner-v1:';

async function selectExactStableAIdentities({ transactionRoot, journal, env, fsImpl = fs,
  readSource = readEquinoxLocalMainSourcePointer,
  writeSource = writeEquinoxLocalMainSourcePointer,
  readNative = readEquinoxLocalMainNativePointer,
  assertMessaging = assertWindowsNativeMessagingHostOwnership,
  registerMessaging = registerWindowsNativeMessagingHost,
} = {}) {
  const install = path.win32.join(env.LOCALAPPDATA, 'Equinox Local');
  const sourcePointer = path.win32.join(transactionRoot, 'current-source.conf');
  const nativePointer = path.win32.join(transactionRoot, 'current-native.json');
  const oldSource = path.win32.join(transactionRoot, 'sources', journal.currentSha);
  const targetSource = path.win32.join(transactionRoot, 'sources', journal.targetSha);
  const stableRelease = path.win32.join(install, 'releases', journal.previousNative.version);
  const targetRelease = path.win32.join(transactionRoot, 'native-store', journal.target, journal.targetSha, 'release');
  const manifestRoot = path.win32.join(install, 'browser', 'native-messaging');
  const aLauncher = windowsNativeMessagingLauncherPath(stableRelease);
  const bLauncher = windowsNativeMessagingLauncherPath(targetRelease);
  const gitPath = path.win32.join(install, 'runtime', 'toolchain', 'git',
    EQUINOX_LOCAL_DUGITE_VERSION, journal.target, 'cmd', 'git.exe');
  const [source, native, messaging] = await Promise.all([
    readSource(sourcePointer, {fsImpl, gitPath}),
    readNative(nativePointer, {transactionRoot, fsImpl}),
    assertMessaging({manifestRoot, acceptedLauncherPaths: [bLauncher], fsImpl, env}),
  ]);
  if (source.sha !== journal.targetSha ||
      path.win32.normalize(source.sourceRoot).toLowerCase() !== targetSource.toLowerCase() ||
      native.sourceSha !== journal.targetSha || native.target !== journal.target ||
      native.runtimeContractSha256 !== journal.targetRuntimeContractSha256 ||
      path.win32.normalize(messaging.launcherPath).toLowerCase() !== bLauncher.toLowerCase()) {
    throw new Error('Original OS-granted A selection requires all three exact B pointer owners.');
  }
  // Deliberate write order: every interrupted intermediate state remains
  // rollback_started/5 and requires ORIGINAL Guardian or offline recovery.
  // Never auto-retry after mutation or claim A health/stage6 on its own.
  await writeSource(sourcePointer, {sourceRoot: oldSource, sha: journal.currentSha}, {fsImpl, gitPath});
  await fsImpl.unlink(nativePointer);
  await registerMessaging({manifestRoot, launcherPath: aLauncher,
    expectedPreviousLauncherPath: bLauncher, fsImpl, env});
  const [selected, selectedMessaging] = await Promise.all([
    readSource(sourcePointer, {fsImpl, gitPath}),
    assertMessaging({manifestRoot, acceptedLauncherPaths: [aLauncher], fsImpl, env}),
  ]);
  if (selected.sha !== journal.currentSha ||
      path.win32.normalize(selected.sourceRoot).toLowerCase() !== oldSource.toLowerCase() ||
      path.win32.normalize(selectedMessaging.launcherPath).toLowerCase() !== aLauncher.toLowerCase()) {
    throw new Error('Original Stable A source or Native Messaging selection did not persist.');
  }
  try { await fsImpl.lstat(nativePointer); }
  catch (error) {
    if (error?.code === 'ENOENT') return Object.freeze({status: 'selected_a_identity_stage6_pending'});
    throw error;
  }
  throw new Error('Original Stable A native Main pointer was recreated.');
}

// INTERNAL; not imported by public updater, only future disposable fixture
// or explicitly admitted ORIGINAL worker. All mutations require a fresh
// fixed, double-HMAC S grant from the original OS-owned Guardian process.
export async function runEquinoxLocalWindowsGuardianOwnedStableASelection({
  transactionId, transactionRoot, workerToken, installation, physicalReceipt,
  platform = process.platform, env = process.env, fsImpl = fs,
  connect = net.createConnection,
  applySelection = selectExactStableAIdentities,
} = {}) {
  if (platform !== 'win32' || !TX.test(transactionId ?? '') ||
      !TOKEN.test(workerToken ?? '') || !path.win32.isAbsolute(env.LOCALAPPDATA ?? '') ||
      !path.win32.isAbsolute(transactionRoot ?? '') ||
      path.win32.normalize(transactionRoot).toLowerCase() !==
        path.win32.join(env.LOCALAPPDATA, 'Equinox Local', 'state', 'main-update').toLowerCase() ||
      installation?.managed !== true || installation?.selfUpdateSupported !== true ||
      installation?.installRoot?.toLowerCase() !== path.win32.join(env.LOCALAPPDATA, 'Equinox Local').toLowerCase() ||
      !['win32-x64', 'win32-arm64'].includes(installation?.target) ||
      physicalReceipt?.transactionId !== transactionId ||
      physicalReceipt?.stage !== 'physical_a_restored_pending_native_and_source_commit') {
    throw new Error('Original Guardian Stable A selection requires physical proof and exact Windows worker identity.');
  }
  const journalPath = path.win32.join(transactionRoot, 'guardian-journal', `${transactionId}.json`);
  const bytes = await fsImpl.readFile(journalPath);
  if (bytes.length < 2 || bytes.length > 8192) throw new Error('Original Guardian A selection journal is outside bound.');
  const journal = JSON.parse(bytes.toString('utf8'));
  if (journal.transactionId !== transactionId || journal.stage !== 'rollback_started' ||
      journal.sequence !== 5 || journal.previousNative?.kind !== 'stable' ||
      !VERSION.test(journal.previousNative.version ?? '') ||
      !SHA.test(journal.currentSha ?? '') || !SHA.test(journal.targetSha ?? '') ||
      journal.currentSha === journal.targetSha || journal.target !== installation.target ||
      !/^[a-f0-9]{64}$/u.test(journal.targetRuntimeContractSha256 ?? '')) {
    throw new Error('Stable A selection requires exact original rollback_started/5 generation.');
  }
  const digest = createHash('sha256').update(bytes).digest();
  const secret = Buffer.from(workerToken, 'hex');
  try {
    return await new Promise((resolve, reject) => {
      const socket = connect(`\\\\.\\pipe\\EquinoxLocalMainAB-SelectStableA-${transactionId}`);
      let phase = 'nonce';
      let pending = Buffer.alloc(0);
      let expectedMac;
      let settled = false;
      let failed = false;
      let draining = false;
      const fail = error => {if (!settled && !failed) {failed = true; socket.destroy(error);}};
      socket.setTimeout(45000, () => fail(new Error('Original Guardian A selection timed out.')));
      const pump = async () => {
        if (draining || settled || failed) return;
        draining = true;
        try {
          while (!settled && !failed) {
            if (pending.length > 33) throw new Error('Stable A selection challenge exceeds bound.');
            if (phase === 'nonce') {
              if (pending.length < 32) break;
              const nonce = pending.subarray(0, 32);
              pending = pending.subarray(32);
              expectedMac = createHmac('sha256', secret).update(OWNER_DOMAIN, 'ascii').update(nonce).update(digest).digest();
              const response = createHmac('sha256', secret).update(WORKER_DOMAIN, 'ascii').update(nonce).update(digest).digest();
              phase = 'grant';
              socket.write(response);
              continue;
            }
            if (phase === 'grant') {
              if (pending.length < 33) break;
              const mac = pending.subarray(0, 32);
              const action = pending[32];
              pending = pending.subarray(33);
              if (!timingSafeEqual(mac, expectedMac) || action !== 0x53 || pending.length)
                throw new Error('Stable A selection lacks fixed S and live original Guardian server HMAC.');
              phase = 'mutating';
              if (!(await fsImpl.readFile(journalPath)).equals(bytes))
                throw new Error('Original Guardian stage5 changed before Stable A selection.');
              const selected = await applySelection({transactionRoot, journal, env, fsImpl});
              if (selected?.status !== 'selected_a_identity_stage6_pending')
                throw new Error('Shared Stable A selection helpers did not verify all A identities.');
              phase = 'ack';
              socket.write(Buffer.from('s', 'ascii'));
              continue;
            }
            if (phase === 'ack') {
              if (!pending.length) break;
              if (pending.length !== 1 || pending[0] !== 0x61)
                throw new Error('Original Guardian did not independently confirm selected Stable A.');
              pending = Buffer.alloc(0);
              phase = 'done';
              continue;
            }
            if (pending.length) throw new Error('Guardian sent unsolicited Stable A identity bytes.');
            break;
          }
        } catch (error) {fail(error);}
        finally {draining = false;}
      };
      socket.on('data', chunk => {if (!settled && !failed) {pending = Buffer.concat([pending, chunk]); void pump();}});
      socket.on('error', error => {if (!settled) {settled = true; reject(error);}});
      socket.once('end', () => {
        if (settled) return;
        settled = true;
        if (phase !== 'done') {
          reject(new Error('Original Guardian A selection disconnected without authoritative ACK.'));
          return;
        }
        // A fixed native `a` acknowledgement alone is insufficient. The
        // exact ORIGINAL Guardian must have fsynced both stage6 and its
        // transaction-scoped SHA commit marker under the first OS lease.
        void (async () => {
          const root = path.win32.join(transactionRoot, 'guardian-journal');
          const promotedBytes = await fsImpl.readFile(journalPath);
          const promoted = JSON.parse(promotedBytes.toString('utf8'));
          const startProof = JSON.parse((await fsImpl.readFile(path.win32.join(root,
            `${transactionId}.rollback_started.commit.json`))).toString('utf8'));
          const stageProof = JSON.parse((await fsImpl.readFile(path.win32.join(root,
            `${transactionId}.rollback_native_restored.commit.json`))).toString('utf8'));
          if (promoted.transactionId !== transactionId ||
              promoted.stage !== 'rollback_native_restored' || promoted.sequence !== 6 ||
              startProof.transactionId !== transactionId || startProof.stage !== 'rollback_started' ||
              startProof.sequence !== 5 || !Number.isSafeInteger(startProof.guardianPid) || startProof.guardianPid < 1 ||
              startProof.journalSha256 !== digest.toString('hex') ||
              stageProof.schemaVersion !== 1 || stageProof.transactionId !== transactionId ||
              stageProof.stage !== 'rollback_native_restored' || stageProof.sequence !== 6 ||
              stageProof.guardianPid !== startProof.guardianPid ||
              stageProof.journalSha256 !== createHash('sha256').update(promotedBytes).digest('hex')) {
            throw new Error('Original Guardian durable rollback_native_restored/6 and SHA/PID receipt are missing or mismatched.');
          }
          return Object.freeze({transactionId, stage: 'rollback_native_restored', sequence: 6, guardianPid: stageProof.guardianPid});
        })().then(resolve, reject);
      });
    });
  } finally {secret.fill(0);}
}
