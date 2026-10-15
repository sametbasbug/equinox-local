import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

import { readEquinoxWindowsNativeGuardianMilestone } from './equinox-local-windows-native-guardian-evidence.js';
import { createEquinoxWindowsNativeRollbackOwnerVerifier } from './equinox-local-windows-native-rollback-owner-verifier.js';
import { restoreWindowsNativeABSlot } from './equinox-local-windows-native-ab-switch.js';

const TX = /^main-[a-f0-9]{32}$/u;
const TOKEN = /^[a-f0-9]{64}$/u;
const SHA = /^[a-f0-9]{40}$/u;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const CLIENT_DOMAIN = 'equinox-local-guardian-ab-physical-restore-worker-v1:';
const OWNER_DOMAIN = 'equinox-local-guardian-ab-physical-restore-owner-v1:';

// Internal ORIGINAL detached-worker half of a future fixed Guardian action.
// Not wired into production or hosted activation until Guardian implements the
// matching OS PID/lease/HMAC endpoint. Unlike a journal-based restore, this
// NEVER touches A/B unless a live Guardian answers a fresh, bidirectionally
// authenticated challenge on the same socket as the narrowly scoped action.
// Successful physical rename is NOT durable journal stage6, pointer A, WPF A
// health, or permission to release an orphan writer-lock.
export async function runEquinoxLocalWindowsGuardianOwnedPhysicalARestore({
  transactionId, transactionRoot, workerToken, installation,
  platform = process.platform, env = process.env,
  fsImpl = fs, connect = net.createConnection,
  observer = readEquinoxWindowsNativeGuardianMilestone,
  makeVerifier = createEquinoxWindowsNativeRollbackOwnerVerifier,
  slotRestore = restoreWindowsNativeABSlot,
} = {}) {
  if (platform !== 'win32' || !TX.test(transactionId ?? '') ||
      !TOKEN.test(workerToken ?? '') || typeof env.LOCALAPPDATA !== 'string' ||
      !path.win32.isAbsolute(env.LOCALAPPDATA) || !path.win32.isAbsolute(transactionRoot ?? '') ||
      path.win32.normalize(transactionRoot) !== transactionRoot) {
    throw new Error('Original Guardian physical A worker requires exact Windows transaction identity.');
  }
  const root = path.win32.join(env.LOCALAPPDATA, 'Equinox Local');
  const txRoot = path.win32.join(root, 'state', 'main-update');
  if (transactionRoot.toLowerCase() !== txRoot.toLowerCase() ||
      installation?.managed !== true || installation?.selfUpdateSupported !== true ||
      installation?.installRoot?.toLowerCase() !== root.toLowerCase() ||
      !['win32-x64', 'win32-arm64'].includes(installation?.target)) {
    throw new Error('Original Guardian physical A worker does not own this installed profile.');
  }
  const journalPath = path.win32.join(txRoot, 'guardian-journal', `${transactionId}.json`);
  const bytes = await fsImpl.readFile(journalPath);
  if (bytes.length < 2 || bytes.length > 8192) throw new Error('Original Guardian stage5 journal exceeds bound.');
  const journal = JSON.parse(bytes.toString('utf8'));
  if (journal.transactionId !== transactionId || journal.stage !== 'rollback_started' ||
      journal.sequence !== 5 || !SHA.test(journal.currentSha ?? '') || !SHA.test(journal.targetSha ?? '') ||
      journal.currentSha === journal.targetSha || journal.target !== installation.target ||
      journal.previousNative?.kind !== 'stable' || !VERSION.test(journal.previousNative.version ?? '')) {
    throw new Error('Original Guardian cannot restore A from a stale or foreign native stage5.');
  }
  const original = await observer({
    transactionRoot, transactionId, stage: 'rollback_started',
    expected: {transactionId, target: journal.target, currentSha: journal.currentSha,
      targetSha: journal.targetSha, receiptStartedAt: journal.receiptStartedAt},
    verifyGuardianOsOwner: makeVerifier({transactionId, installation}), fsImpl, platform,
  });
  const digest = createHash('sha256').update(bytes).digest();
  if (original?.transactionId !== transactionId || original.stage !== 'rollback_started' ||
      original.sequence !== 5 || original.sourceSha !== journal.targetSha ||
      !Number.isSafeInteger(original.guardianPid) || original.guardianPid < 1 ||
      original.journalSha256 !== digest.toString('hex')) {
    throw new Error('Original Guardian live OS owner and durable stage5 are not independently attested.');
  }
  const slots = Object.freeze({
    transactionId,
    programRoot: path.win32.join(env.LOCALAPPDATA, 'Programs', 'Equinox Local'),
    previousReleaseDir: path.win32.join(root, 'releases', journal.previousNative.version),
    targetReleaseDir: path.win32.join(txRoot, 'native-store', journal.target, journal.targetSha, 'release'),
  });
  const secret = Buffer.from(workerToken, 'hex');
  const pipeName = `\\\\.\\pipe\\EquinoxLocalMainAB-PhysicalRestore-${transactionId}`;
  try {
    return await new Promise((resolve, reject) => {
      const socket = connect(pipeName);
      let phase = 'nonce';
      let incoming = Buffer.alloc(0);
      let expectedOwnerMac = null;
      let restored = false;
      let settled = false;
      let failed = false;
      const fail = (error) => {
        if (settled || failed) return;
        failed = true;
        socket.destroy(error);
      };
      socket.setTimeout(45000, () => fail(new Error('Original Guardian physical A action timed out.')));
      let draining = false;
      const pump = async () => {
        if (draining || settled) return;
        draining = true;
        try {
          while (!settled) {
            if (incoming.length > 33) throw new Error('Guardian physical A protocol exceeded bounded frame.');
            if (phase === 'nonce') {
              if (incoming.length < 32) break;
              const nonce = incoming.subarray(0, 32);
              incoming = incoming.subarray(32);
              const workerProof = createHmac('sha256', secret).update(CLIENT_DOMAIN, 'ascii').update(nonce).update(digest).digest();
              expectedOwnerMac = createHmac('sha256', secret).update(OWNER_DOMAIN, 'ascii').update(nonce).update(digest).digest();
              phase = 'grant';
              socket.write(workerProof);
              continue;
            }
            if (phase === 'grant') {
              if (incoming.length < 33) break;
              const received = incoming.subarray(0, 32);
              const action = incoming[32];
              incoming = incoming.subarray(33);
              if (!timingSafeEqual(received, expectedOwnerMac) || action !== 0x52 || incoming.length) {
                throw new Error('Guardian physical A action lacks fresh server HMAC and fixed R grant.');
              }
              phase = 'restoring';
              const unchanged = await fsImpl.readFile(journalPath);
              if (!unchanged.equals(bytes)) throw new Error('Original Guardian stage5 changed before physical A rename.');
              // One grant, one existing shared exact A/B filesystem primitive.
              // No JS journal advance, source pointer selection, registry edit,
              // native shell restart or A health assertion can happen here.
              const result = await slotRestore(slots, {fsImpl});
              if (result?.stage !== 'restored') throw new Error('Shared A/B slot engine did not verify installed physical A.');
              restored = true;
              phase = 'owner-ack';
              socket.write(Buffer.from('r', 'ascii'));
              continue;
            }
            if (phase === 'owner-ack') {
              if (!incoming.length) break;
              if (incoming.length !== 1 || incoming[0] !== 0x61 || !restored) {
                throw new Error('Original Guardian did not acknowledge verified physical A after rename.');
              }
              incoming = Buffer.alloc(0);
              phase = 'complete';
              continue;
            }
            if (incoming.length) throw new Error('Guardian physical A protocol has unsolicited trailing data.');
            break;
          }
        } catch (error) { fail(error); }
        finally { draining = false; }
      };
      socket.on('data', (chunk) => {
        if (settled) return;
        incoming = Buffer.concat([incoming, chunk]);
        void pump();
      });
      socket.on('error', (error) => { if (!settled) { settled = true; reject(error); } });
      socket.once('end', () => {
        if (settled) return;
        settled = true;
        if (phase !== 'complete') reject(new Error('Guardian physical A action ended without verified owner acknowledgement.'));
        else resolve(Object.freeze({transactionId, stage: 'physical_a_restored_pending_native_and_source_commit'}));
      });
    });
  } finally { secret.fill(0); }
}
