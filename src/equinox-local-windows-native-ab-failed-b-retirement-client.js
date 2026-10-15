import {createHash, createHmac, timingSafeEqual} from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

const TX = /^main-[a-f0-9]{32}$/u;
const TOKEN = /^[a-f0-9]{64}$/u;
const SHA = /^[a-f0-9]{40}$/u;
const OWNER_DOMAIN = 'equinox-local-guardian-ab-retire-b-owner-v1:';
const WORKER_DOMAIN = 'equinox-local-guardian-ab-retire-b-worker-v1:';

// INTERNAL fixed original-Guardian action only. Not imported by production
// Main. Stage6 is already the original Guardian's SHA/PID-committed milestone.
// A live WPF PID+OS IPC is NOT old-A backend identity health or stage7.
export async function requestEquinoxLocalGuardianOwnedFailedBRetirement({
  transactionId, transactionRoot, workerToken, installation, stage6Receipt, relaunchReceipt, stage7Receipt, stage8Receipt,
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
      stage8Receipt?.transactionId !== transactionId || stage8Receipt?.stage !== 'rolled_back' ||
      stage8Receipt?.sequence !== 8 || !Number.isSafeInteger(stage8Receipt?.guardianPid) ||
      stage8Receipt.guardianPid !== stage7Receipt?.guardianPid ||
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
  const terminal = JSON.parse((await fsImpl.readFile(path.win32.join(dir,
    `${transactionId}.rolled_back.commit.json`))).toString('utf8'));
  const stage6 = JSON.parse((await fsImpl.readFile(path.win32.join(dir,
    `${transactionId}.rollback_native_restored.commit.json`))).toString('utf8'));
  const wpf = JSON.parse((await fsImpl.readFile(path.win32.join(dir,
    `${transactionId}.wpf-a-restarted.json`))).toString('utf8'));
  if (journal.transactionId !== transactionId || journal.stage !== 'rolled_back' ||
      journal.sequence !== 8 || journal.previousNative?.kind !== 'stable' ||
      !/^\d+\.\d+\.\d+$/u.test(journal.previousNative.version ?? '') ||
      !SHA.test(journal.currentSha ?? '') || journal.target !== installation.target ||
      stage7.schemaVersion !== 1 || stage7.transactionId !== transactionId ||
      stage7.stage !== 'rollback_healthy' || stage7.sequence !== 7 ||
      stage7.guardianPid !== stage7Receipt.guardianPid ||
      !/^[a-f0-9]{64}$/u.test(stage7.journalSha256 ?? '') ||
      terminal.schemaVersion !== 1 || terminal.transactionId !== transactionId ||
      terminal.stage !== 'rolled_back' || terminal.sequence !== 8 ||
      terminal.guardianPid !== stage7.guardianPid || terminal.guardianPid !== stage8Receipt.guardianPid ||
      terminal.journalSha256 !== digest.toString('hex') ||
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
      const socket = connect(`\\\\.\\pipe\\EquinoxLocalMainAB-RetireFailedB-${transactionId}`);
      let pending = Buffer.alloc(0);
      let phase = 'nonce';
      let ownerMac;
      let settled = false;
      let failed = false;
      const fail = error => {if (!settled && !failed) {failed = true; socket.destroy(error);}};
      socket.setTimeout(70000, () => fail(new Error('Original Guardian terminal stage8 verification exceeded deadline.')));
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
            if (!timingSafeEqual(pending.subarray(0, 32), ownerMac) || pending[32] !== 0x51)
              throw new Error('Failed B retirement lacks fixed Q original Guardian HMAC grant.');
            pending = pending.subarray(33);
            if (pending.length) throw new Error('Duplicate original B Q retirement grant.');
            phase = 'owner';
            socket.write(Buffer.from('q', 'ascii'));
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
        if (phase !== 'complete') reject(new Error('Original Guardian B retirement ended without no-delete receipt.'));
        else resolve();
      });
    });
    // Q ACK alone is not authority: require write-through exact original
    // Guardian intent+retirement receipts and unchanged stage8 SHA.
    const after = await fsImpl.readFile(journalPath);
    const intentBytes = await fsImpl.readFile(path.win32.join(dir,
      `${transactionId}.failed-b-retire.intent.json`));
    const committed = JSON.parse((await fsImpl.readFile(path.win32.join(dir,
      `${transactionId}.failed-b-retired.commit.json`))).toString('utf8'));
    const intent = JSON.parse(intentBytes.toString('utf8'));
    if (!after.equals(original) || intent.schemaVersion !== 1 ||
        intent.transactionId !== transactionId ||
        intent.disposition !== 'failed-b-retire-intent-no-delete' ||
        intent.guardianPid !== terminal.guardianPid || intent.workerPid !== process.pid ||
        intent.stage8JournalSha256 !== digest.toString('hex') ||
        intent.failedBSourceSha !== journal.targetSha ||
        committed.schemaVersion !== 1 || committed.transactionId !== transactionId ||
        committed.disposition !== 'failed-b-retired-still-on-disk-no-delete' ||
        committed.guardianPid !== terminal.guardianPid ||
        committed.stage8JournalSha256 !== digest.toString('hex') ||
        committed.failedBSourceSha !== journal.targetSha ||
        committed.intentSha256 !== createHash('sha256').update(intentBytes).digest('hex') ||
        stage6.guardianPid !== terminal.guardianPid || wpf.guardianPid !== terminal.guardianPid ||
        wpf.shellPid !== relaunchReceipt.shellPid ||
        wpf.shellStartTimeUtcTicks !== relaunchReceipt.shellStartTimeUtcTicks) {
      throw new Error('Original Guardian retirement lacks durable exact stage8 intent/commit without deletion.');
    }
    return Object.freeze({transactionId, stage: 'failed_b_retired_on_disk',
      guardianPid: terminal.guardianPid, shellPid: wpf.shellPid, deleted: false});
  } finally {secret.fill(0);}
}
