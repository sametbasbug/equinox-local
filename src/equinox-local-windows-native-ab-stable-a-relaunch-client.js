import {createHash, createHmac, timingSafeEqual} from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

const TX = /^main-[a-f0-9]{32}$/u;
const TOKEN = /^[a-f0-9]{64}$/u;
const SHA = /^[a-f0-9]{40}$/u;
const OWNER_DOMAIN = 'equinox-local-guardian-ab-relaunch-a-owner-v1:';
const WORKER_DOMAIN = 'equinox-local-guardian-ab-relaunch-a-worker-v1:';

// INTERNAL fixed original-Guardian action only. Not imported by production
// Main. Stage6 is already the original Guardian's SHA/PID-committed milestone.
// A live WPF PID+OS IPC is NOT old-A backend identity health or stage7.
export async function requestEquinoxLocalGuardianOwnedStableAWpfRelaunch({
  transactionId, transactionRoot, workerToken, installation, stage6Receipt,
  platform = process.platform, env = process.env, fsImpl = fs, connect = net.createConnection,
} = {}) {
  const install = path.win32.join(env.LOCALAPPDATA ?? '', 'Equinox Local');
  if (platform !== 'win32' || !TX.test(transactionId ?? '') ||
      !TOKEN.test(workerToken ?? '') || !path.win32.isAbsolute(env.LOCALAPPDATA ?? '') ||
      !path.win32.isAbsolute(transactionRoot ?? '') ||
      path.win32.normalize(transactionRoot).toLowerCase() !== path.win32.join(install, 'state', 'main-update').toLowerCase() ||
      installation?.managed !== true || installation?.selfUpdateSupported !== true ||
      installation?.installRoot?.toLowerCase() !== install.toLowerCase() ||
      !['win32-x64', 'win32-arm64'].includes(installation?.target) ||
      stage6Receipt?.transactionId !== transactionId || stage6Receipt?.stage !== 'rollback_native_restored' ||
      stage6Receipt?.sequence !== 6 || !Number.isSafeInteger(stage6Receipt?.guardianPid) || stage6Receipt.guardianPid < 1) {
    throw new Error('Original Stable A relaunch requires exact Windows OS-owned stage6 identity.');
  }
  const dir = path.win32.join(transactionRoot, 'guardian-journal');
  const journalPath = path.win32.join(dir, `${transactionId}.json`);
  const original = await fsImpl.readFile(journalPath);
  if (original.length < 2 || original.length > 8192) throw new Error('Stable A stage6 exceeds native journal limit.');
  const journal = JSON.parse(original.toString('utf8'));
  const digest = createHash('sha256').update(original).digest();
  const marker = JSON.parse((await fsImpl.readFile(path.win32.join(dir,
    `${transactionId}.rollback_native_restored.commit.json`))).toString('utf8'));
  if (journal.transactionId !== transactionId || journal.stage !== 'rollback_native_restored' ||
      journal.sequence !== 6 || journal.previousNative?.kind !== 'stable' ||
      !/^\d+\.\d+\.\d+$/u.test(journal.previousNative.version ?? '') ||
      !SHA.test(journal.currentSha ?? '') || journal.target !== installation.target ||
      marker.schemaVersion !== 1 || marker.transactionId !== transactionId ||
      marker.stage !== 'rollback_native_restored' || marker.sequence !== 6 ||
      marker.guardianPid !== stage6Receipt.guardianPid ||
      marker.journalSha256 !== digest.toString('hex')) {
    throw new Error('Stable A relaunch requires original Guardian durable stage6 SHA/PID receipt.');
  }
  const secret = Buffer.from(workerToken, 'hex');
  try {
    await new Promise((resolve, reject) => {
      const socket = connect(`\\\\.\\pipe\\EquinoxLocalMainAB-RelaunchStableA-${transactionId}`);
      let pending = Buffer.alloc(0);
      let phase = 'nonce';
      let ownerMac;
      let settled = false;
      let failed = false;
      const fail = error => {if (!settled && !failed) {failed = true; socket.destroy(error);}};
      socket.setTimeout(65000, () => fail(new Error('Original Guardian A WPF relaunch exceeded deadline.')));
      socket.on('data', chunk => {
        if (settled || failed) return;
        try {
          pending = Buffer.concat([pending, chunk]);
          if (pending.length > 33) throw new Error('Unexpected A relaunch IPC payload.');
          if (phase === 'nonce' && pending.length >= 32) {
            const nonce = pending.subarray(0, 32);
            pending = pending.subarray(32);
            ownerMac = createHmac('sha256', secret).update(OWNER_DOMAIN, 'ascii').update(nonce).update(digest).digest();
            const clientMac = createHmac('sha256', secret).update(WORKER_DOMAIN, 'ascii').update(nonce).update(digest).digest();
            phase = 'grant';
            socket.write(clientMac);
          }
          if (phase === 'grant' && pending.length >= 33) {
            if (!timingSafeEqual(pending.subarray(0, 32), ownerMac) || pending[32] !== 0x4c)
              throw new Error('Stable A WPF relaunch has no fixed L original Guardian HMAC grant.');
            pending = pending.subarray(33);
            if (pending.length) throw new Error('Duplicate Stable A relaunch grant.');
            phase = 'owner';
            socket.write(Buffer.from('l', 'ascii'));
          }
          if (phase === 'owner' && pending.length) {
            if (pending.length !== 1 || pending[0] !== 0x61)
              throw new Error('Original Guardian did not acknowledge verified Stable A WPF PID.');
            pending = Buffer.alloc(0);
            phase = 'complete';
          }
          if (phase === 'complete' && pending.length)
            throw new Error('Original Guardian relaunch sent unsolicited bytes.');
        } catch (error) {fail(error);}
      });
      socket.on('error', error => {if (!settled) {settled = true; reject(error);}});
      socket.once('end', () => {
        if (settled) return;
        settled = true;
        if (phase !== 'complete') reject(new Error('Original Guardian relaunch ended without OS WPF attestation.'));
        else resolve();
      });
    });
    // Signed fixed grant and Guardian IPC alone are insufficient. Require
    // exact fsynced journal-bound WPF A PID/birth receipt and unchanged stage6.
    const after = await fsImpl.readFile(journalPath);
    const stage6 = JSON.parse(after.toString('utf8'));
    const proof = JSON.parse((await fsImpl.readFile(path.win32.join(dir,
      `${transactionId}.wpf-a-restarted.json`))).toString('utf8'));
    if (!after.equals(original) || stage6.stage !== 'rollback_native_restored' || stage6.sequence !== 6 ||
        proof.schemaVersion !== 1 || proof.transactionId !== transactionId ||
        proof.guardianPid !== marker.guardianPid || proof.stage6JournalSha256 !== digest.toString('hex') ||
        proof.stableVersion !== journal.previousNative.version || proof.sourceSha !== journal.currentSha ||
        !Number.isSafeInteger(proof.shellPid) || proof.shellPid < 1 ||
        !/^\d{15,19}$/u.test(proof.shellStartTimeUtcTicks ?? '')) {
      throw new Error('Original Guardian exact Stable A WPF OS process and stage6 receipt are not durable.');
    }
    return Object.freeze({transactionId, stage: 'wpf_a_restarted_health_pending',
      shellPid: proof.shellPid, shellStartTimeUtcTicks: proof.shellStartTimeUtcTicks});
  } finally {secret.fill(0);}
}
