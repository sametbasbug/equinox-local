import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

const TX = /^main-[a-f0-9]{32}$/u;
const SHA = /^[a-f0-9]{40}$/u;
const TOKEN = /^[a-f0-9]{64}$/u;
const DOMAIN = 'equinox-local-guardian-ab-restart-v1:';

// Only the same product-owned detached Node process can request launch, via
// Guardian's OS-owned pipe and one-time HMAC over the exact switched journal.
// This client never spawns a WPF process and never chooses an executable.
export async function requestEquinoxLocalGuardianOwnedBWpfRestart({
  transactionId, transactionRoot, workerToken,
  sourceSha, platform = process.platform, env = process.env,
  fsImpl = fs, connect = net.createConnection,
} = {}) {
  if (platform !== 'win32' || !TX.test(transactionId ?? '') || !TOKEN.test(workerToken ?? '') ||
      !SHA.test(sourceSha ?? '') || typeof transactionRoot !== 'string' ||
      !path.win32.isAbsolute(transactionRoot) || !path.win32.isAbsolute(env.LOCALAPPDATA ?? '')) {
    throw new Error('Native B restart requires an exact Windows owner and source SHA.');
  }
  const canonical = path.win32.join(env.LOCALAPPDATA, 'Equinox Local', 'state', 'main-update');
  if (path.win32.normalize(transactionRoot).toLowerCase() !== path.win32.normalize(canonical).toLowerCase()) {
    throw new Error('Native B restart cannot cross an installed Windows transaction root.');
  }
  const journalPath = path.win32.join(canonical, 'guardian-journal', `${transactionId}.json`);
  const raw = await fsImpl.readFile(journalPath);
  if (raw.length < 2 || raw.length > 8192) throw new Error('Native B restart journal is outside its bound.');
  const journal = JSON.parse(raw.toString('utf8'));
  if (journal.transactionId !== transactionId || journal.targetSha !== sourceSha ||
      journal.stage !== 'switched' || journal.sequence !== 3) {
    throw new Error('Native B restart refuses any non-switched or foreign transaction.');
  }
  const [source, native] = await Promise.all([
    fsImpl.readFile(path.win32.join(canonical, 'current-source.conf'), 'utf8'),
    fsImpl.readFile(path.win32.join(canonical, 'current-native.json'), 'utf8'),
  ]);
  const rows = source.trim().split(/\r?\n/u);
  const expectedSource = path.win32.join(canonical, 'sources', sourceSha);
  if (rows.length !== 3 || rows[0] !== 'schemaVersion=1' || rows[1] !== `sourceRoot=${expectedSource}` ||
      rows[2] !== `sha=${sourceSha}`) {
    throw new Error('Native B restart source pointer has not durably selected exact B.');
  }
  const ptr = JSON.parse(native);
  if (ptr.schemaVersion !== 1 || ptr.channel !== 'main' || ptr.sourceSha !== sourceSha ||
      ptr.target !== journal.target || ptr.runtimeContractSha256 !== journal.targetRuntimeContractSha256) {
    throw new Error('Native B restart pointer has not durably selected exact native B.');
  }
  const journalDigest = createHash('sha256').update(raw).digest();
  const secret = Buffer.from(workerToken, 'hex');
  try {
    await new Promise((resolve, reject) => {
      const pipe = connect(`\\\\.\\pipe\\EquinoxLocalMainAB-Restart-${transactionId}`);
      let phase = 'nonce';
      let pending = Buffer.alloc(0);
      let admitted = false;
      pipe.setTimeout(120000, () => pipe.destroy(new Error('Native B Guardian restart proof timed out.')));
      pipe.on('data', (chunk) => {
        pending = Buffer.concat([pending, chunk]);
        if (pending.length > 33) { pipe.destroy(new Error('Guardian restart reply exceeds bound.')); return; }
        if (phase === 'nonce' && pending.length >= 32) {
          const nonce = pending.subarray(0, 32);
          pending = pending.subarray(32);
          const response = createHmac('sha256', secret).update(DOMAIN, 'ascii').update(nonce).update(journalDigest).digest();
          phase = 'receipt';
          pipe.write(response);
        }
        if (phase === 'receipt' && pending.length) {
          if (pending.length !== 1 || pending[0] !== 0x72) {
            pipe.destroy(new Error('Guardian did not attest native B WPF real process restart.'));
            return;
          }
          admitted = true;
          pending = Buffer.alloc(0);
          phase = 'done';
        }
        if (phase === 'done' && pending.length) pipe.destroy(new Error('Guardian sent unsolicited native restart data.'));
      });
      pipe.once('error', reject);
      pipe.once('end', () => admitted ? resolve() : reject(new Error('Guardian disconnected before exact native B restart proof.')));
    });
    const after = JSON.parse((await fsImpl.readFile(journalPath)).toString('utf8'));
    if (after.transactionId !== transactionId || after.targetSha !== sourceSha ||
        after.stage !== 'restarted' || after.sequence !== 4) {
      throw new Error('Native B Guardian did not persist exact real WPF restart journal milestone.');
    }
    return Object.freeze({ transactionId, sourceSha, journalStage: 'restarted' });
  } finally {
    secret.fill(0);
  }
}
