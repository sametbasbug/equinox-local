import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

const TX = /^main-[a-f0-9]{32}$/u;
const SHA = /^[a-f0-9]{40}$/u;
const TOKEN = /^[a-f0-9]{64}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const DOMAIN = 'equinox-local-guardian-ab-rollback-start-v1:';

// Internal worker-side client for a future Guardian-driven rejected-B path.
// It can only ASK the original OS-admitted Guardian for rollback_started/5;
// there are deliberately no local restore/kill/registry/journal mutations.
// Its OS-owning Guardian counterpart is not invoked by normal B startup yet.
export async function requestEquinoxLocalGuardianOwnedARollbackStart({
  transactionId, transactionRoot, workerToken, sourceSha,
  platform = process.platform, env = process.env,
  fsImpl = fs, connect = net.createConnection,
} = {}) {
  if (platform !== 'win32' || !TX.test(transactionId ?? '') ||
      !TOKEN.test(workerToken ?? '') || !SHA.test(sourceSha ?? '') ||
      typeof transactionRoot !== 'string' || !path.win32.isAbsolute(transactionRoot) ||
      !path.win32.isAbsolute(env.LOCALAPPDATA ?? '')) {
    throw new Error('Native rollback admission requires exact Windows worker, transaction and target source identity.');
  }
  const root = path.win32.join(env.LOCALAPPDATA, 'Equinox Local', 'state', 'main-update');
  if (path.win32.normalize(transactionRoot).toLowerCase() !== path.win32.normalize(root).toLowerCase()) {
    throw new Error('Native rollback request escapes its canonical Main transaction root.');
  }
  const journalPath = path.win32.join(root, 'guardian-journal', `${transactionId}.json`);
  const proofPath = path.win32.join(root, 'guardian-journal', `${transactionId}.retained-a.json`);
  const bytes = await fsImpl.readFile(journalPath);
  if (bytes.length < 2 || bytes.length > 8192) throw new Error('Native rollback journal exceeds bound.');
  const journal = JSON.parse(bytes.toString('utf8'));
  const digest = createHash('sha256').update(bytes).digest();
  const retainedBytes = await fsImpl.readFile(proofPath);
  if (retainedBytes.length < 2 || retainedBytes.length > 8192) throw new Error('Native rollback A proof exceeds bound.');
  const retained = JSON.parse(retainedBytes.toString('utf8'));
  if (journal.transactionId !== transactionId || journal.stage !== 'restarted' || journal.sequence !== 4 ||
      journal.targetSha !== sourceSha || journal.previousNative?.kind !== 'stable' ||
      retained.schemaVersion !== 1 || retained.transactionId !== transactionId ||
      retained.disposition !== 'retained-a-verified-no-restore-authority' ||
      retained.stableVersion !== journal.previousNative.version ||
      retained.journalSequence !== 4 || !DIGEST.test(retained.journalSha256 ?? '') ||
      retained.journalSha256 !== digest.toString('hex')) {
    throw new Error('Native rollback lacks exact Guardian-restarted B and retained Stable A proof.');
  }
  const secret = Buffer.from(workerToken, 'hex');
  try {
    await new Promise((resolve, reject) => {
      const pipe = connect(`\\\\.\\pipe\\EquinoxLocalMainAB-Rollback-${transactionId}`);
      let phase = 'nonce';
      let pending = Buffer.alloc(0);
      let admitted = false;
      pipe.setTimeout(45000, () => pipe.destroy(new Error('Native A rollback admission timed out.')));
      pipe.on('data', (chunk) => {
        pending = Buffer.concat([pending, chunk]);
        if (pending.length > 33) { pipe.destroy(new Error('Native rollback pipe exceeded bounded frame.')); return; }
        if (phase === 'nonce' && pending.length >= 32) {
          const nonce = pending.subarray(0, 32);
          pending = pending.subarray(32);
          phase = 'receipt';
          pipe.write(createHmac('sha256', secret).update(DOMAIN, 'ascii').update(nonce).update(digest).digest());
        }
        if (phase === 'receipt' && pending.length) {
          if (pending.length !== 1 || pending[0] !== 0x72) {
            pipe.destroy(new Error('Original Guardian refused exact A rollback-start admission.'));
            return;
          }
          admitted = true;
          pending = Buffer.alloc(0);
          phase = 'done';
        }
        if (phase === 'done' && pending.length) pipe.destroy(new Error('Native rollback Guardian sent unsolicited data.'));
      });
      pipe.once('error', reject);
      pipe.once('end', () => admitted ? resolve() : reject(new Error('Guardian did not persist rollback-start before disconnect.')));
    });
    const afterBytes = await fsImpl.readFile(journalPath);
    const after = JSON.parse(afterBytes.toString('utf8'));
    if (after.transactionId !== transactionId || after.targetSha !== sourceSha ||
        after.stage !== 'rollback_started' || after.sequence !== 5) {
      throw new Error('Native Guardian did not durably authorize exact rollback_started/5.');
    }
    return Object.freeze({ transactionId, sourceSha, journalStage: 'rollback_started' });
  } finally {
    secret.fill(0);
  }
}
