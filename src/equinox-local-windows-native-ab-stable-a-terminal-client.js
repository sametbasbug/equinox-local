import {createHash, createHmac, timingSafeEqual} from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

const TX = /^main-[a-f0-9]{32}$/u;
const TOKEN = /^[a-f0-9]{64}$/u;
const SHA = /^[a-f0-9]{40}$/u;
const OWNER_DOMAIN = 'equinox-local-guardian-ab-terminal-a-owner-v1:';
const WORKER_DOMAIN = 'equinox-local-guardian-ab-terminal-a-worker-v1:';

// INTERNAL fixed original-Guardian action only. Not imported by production
// Main. Stage6 is already the original Guardian's SHA/PID-committed milestone.
// A live WPF PID+OS IPC is NOT old-A backend identity health or stage7.
export async function requestEquinoxLocalGuardianOwnedStableATerminalCommit({
  transactionId, transactionRoot, workerToken, installation, stage6Receipt, relaunchReceipt, stage7Receipt,
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
      stage7Receipt?.transactionId !== transactionId || stage7Receipt?.stage !== 'rollback_healthy' ||
      stage7Receipt?.sequence !== 7 || !Number.isSafeInteger(stage7Receipt?.guardianPid) ||
      stage7Receipt.guardianPid !== stage6Receipt?.guardianPid ||
      relaunchReceipt?.transactionId !== transactionId ||
      relaunchReceipt?.stage !== 'wpf_a_restarted_health_pending' ||
      !Number.isSafeInteger(relaunchReceipt?.shellPid) || relaunchReceipt.shellPid < 1 ||
      stage6Receipt?.transactionId !== transactionId || stage6Receipt?.stage !== 'rollback_native_restored' ||
      stage6Receipt?.sequence !== 6 || !Number.isSafeInteger(stage6Receipt?.guardianPid) || stage6Receipt.guardianPid < 1) {
    throw new Error('Original terminal A requires original stage7 and same Guardian stage6/WPF evidence.');
  }
  const dir = path.win32.join(transactionRoot, 'guardian-journal');
  const journalPath = path.win32.join(dir, `${transactionId}.json`);
  const original = await fsImpl.readFile(journalPath);
  if (original.length < 2 || original.length > 8192) throw new Error('Original A terminal journal exceeds native bound.');
  const journal = JSON.parse(original.toString('utf8'));
  const digest = createHash('sha256').update(original).digest();
  const stage7 = JSON.parse((await fsImpl.readFile(path.win32.join(dir,
    `${transactionId}.rollback_healthy.commit.json`))).toString('utf8'));
  const stage6 = JSON.parse((await fsImpl.readFile(path.win32.join(dir,
    `${transactionId}.rollback_native_restored.commit.json`))).toString('utf8'));
  const wpf = JSON.parse((await fsImpl.readFile(path.win32.join(dir,
    `${transactionId}.wpf-a-restarted.json`))).toString('utf8'));
  if (journal.transactionId !== transactionId || journal.stage !== 'rollback_healthy' ||
      journal.sequence !== 7 || journal.previousNative?.kind !== 'stable' ||
      !/^\d+\.\d+\.\d+$/u.test(journal.previousNative.version ?? '') ||
      !SHA.test(journal.currentSha ?? '') || journal.target !== installation.target ||
      stage7.schemaVersion !== 1 || stage7.transactionId !== transactionId ||
      stage7.stage !== 'rollback_healthy' || stage7.sequence !== 7 ||
      stage7.guardianPid !== stage7Receipt.guardianPid ||
      stage7.journalSha256 !== digest.toString('hex') ||
      stage6.schemaVersion !== 1 || stage6.transactionId !== transactionId ||
      stage6.stage !== 'rollback_native_restored' || stage6.sequence !== 6 ||
      stage6.guardianPid !== stage7.guardianPid ||
      !/^[a-f0-9]{64}$/u.test(stage6.journalSha256 ?? '') ||
      wpf.schemaVersion !== 1 || wpf.transactionId !== transactionId ||
      wpf.guardianPid !== stage7.guardianPid ||
      wpf.stage6JournalSha256 !== stage6.journalSha256 ||
      wpf.stableVersion !== journal.previousNative.version ||
      wpf.sourceSha !== journal.currentSha ||
      wpf.shellPid !== relaunchReceipt.shellPid ||
      wpf.shellStartTimeUtcTicks !== relaunchReceipt.shellStartTimeUtcTicks) {
    throw new Error('Original Guardian terminal requires stage6+7 SHA/PID ancestry and exact A WPF birth.');
  }
  const secret = Buffer.from(workerToken, 'hex');
  try {
    await new Promise((resolve, reject) => {
      const socket = connect(`\\\\.\\pipe\\EquinoxLocalMainAB-TerminalStableA-${transactionId}`);
      let pending = Buffer.alloc(0);
      let phase = 'nonce';
      let ownerMac;
      let settled = false;
      let failed = false;
      const fail = error => {if (!settled && !failed) {failed = true; socket.destroy(error);}};
      socket.setTimeout(55000, () => fail(new Error('Original Guardian terminal stage8 verification exceeded deadline.')));
      socket.on('data', chunk => {
        if (settled || failed) return;
        try {
          pending = Buffer.concat([pending, chunk]);
          if (pending.length > 33) throw new Error('Unexpected A terminal IPC payload.');
          if (phase === 'nonce' && pending.length >= 32) {
            const nonce = pending.subarray(0, 32);
            pending = pending.subarray(32);
            ownerMac = createHmac('sha256', secret).update(OWNER_DOMAIN, 'ascii').update(nonce).update(digest).digest();
            const clientMac = createHmac('sha256', secret).update(WORKER_DOMAIN, 'ascii').update(nonce).update(digest).digest();
            phase = 'grant';
            socket.write(clientMac);
          }
          if (phase === 'grant' && pending.length >= 33) {
            if (!timingSafeEqual(pending.subarray(0, 32), ownerMac) || pending[32] !== 0x54)
              throw new Error('Original A terminal lacks fixed T original Guardian HMAC grant.');
            pending = pending.subarray(33);
            if (pending.length) throw new Error('Duplicate original terminal T grant.');
            phase = 'owner';
            socket.write(Buffer.from('t', 'ascii'));
          }
          if (phase === 'owner' && pending.length) {
            if (pending.length !== 1 || pending[0] !== 0x61)
              throw new Error('Original Guardian did not acknowledge terminal A stage8.');
            pending = Buffer.alloc(0);
            phase = 'complete';
          }
          if (phase === 'complete' && pending.length)
            throw new Error('Original terminal Guardian sent unsolicited bytes.');
        } catch (error) {fail(error);}
      });
      socket.on('error', error => {if (!settled) {settled = true; reject(error);}});
      socket.once('end', () => {
        if (settled) return;
        settled = true;
        if (phase !== 'complete') reject(new Error('Original Guardian terminal ended without independent stage8 receipt.'));
        else resolve();
      });
    });
    // Original OS/HMAC ACK is insufficient; require the exact NEW stage8
    // journal+Guardian PID/SHA sidecar and still intact stage7 ancestry.
    const after = await fsImpl.readFile(journalPath);
    const promoted = JSON.parse(after.toString('utf8'));
    const stage8 = JSON.parse((await fsImpl.readFile(path.win32.join(dir,
      `${transactionId}.rolled_back.commit.json`))).toString('utf8'));
    if (promoted.transactionId !== transactionId || promoted.stage !== 'rolled_back' ||
        promoted.sequence !== 8 || stage8.schemaVersion !== 1 ||
        stage8.transactionId !== transactionId || stage8.stage !== 'rolled_back' ||
        stage8.sequence !== 8 || stage8.guardianPid !== stage7.guardianPid ||
        stage8.journalSha256 !== createHash('sha256').update(after).digest('hex') ||
        stage7.journalSha256 !== digest.toString('hex') ||
        stage6.guardianPid !== stage8.guardianPid || wpf.guardianPid !== stage8.guardianPid ||
        wpf.shellPid !== relaunchReceipt.shellPid ||
        wpf.shellStartTimeUtcTicks !== relaunchReceipt.shellStartTimeUtcTicks) {
      throw new Error('Original Guardian terminal requires durable rolled_back/8 SHA/PID marker and unbroken A lineage.');
    }
    return Object.freeze({transactionId, stage: 'rolled_back', sequence: 8,
      guardianPid: stage8.guardianPid, shellPid: wpf.shellPid, failedBQuarantineRetained: true});
  } finally {secret.fill(0);}
}
