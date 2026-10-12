import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

import { switchWindowsNativeABSlot } from './equinox-local-windows-native-ab-switch.js';

const TX = /^main-[a-f0-9]{32}$/u;
const SHA = /^[a-f0-9]{40}$/u;
const TOKEN = /^[a-f0-9]{64}$/u;
const DOMAIN = 'equinox-local-guardian-ab-slot-v1:';

// Only the original immutable worker may connect: Guardian independently
// checks its OS PID/birthtime/argv/token, and explicitly grants ONE fixed
// A/B switch. This reuses the common JS slot engine, not a second native
// filesystem engine. The old A backup is retained until durable B health.
export async function runEquinoxLocalWindowsGuardianOwnedSlot({
  transactionId, transactionRoot, workerToken,
  platform = process.platform,
  env = process.env,
  slotSwitch = switchWindowsNativeABSlot,
} = {}) {
  if (platform !== 'win32' || !TX.test(transactionId ?? '') ||
      !TOKEN.test(workerToken ?? '') || typeof transactionRoot !== 'string' ||
      !path.win32.isAbsolute(transactionRoot) || path.win32.normalize(transactionRoot).toLowerCase() !== transactionRoot.toLowerCase() ||
      typeof env.LOCALAPPDATA !== 'string' || !path.win32.isAbsolute(env.LOCALAPPDATA)) {
    throw new Error('Windows Guardian slot worker requires exact native transaction and Windows user root.');
  }
  const appRoot = path.win32.join(env.LOCALAPPDATA, 'Equinox Local');
  const expectedTx = path.win32.join(appRoot, 'state', 'main-update');
  if (transactionRoot.toLowerCase() !== expectedTx.toLowerCase()) {
    throw new Error('Guardian A/B slot transaction root escapes the current installed profile.');
  }
  const journalPath = path.win32.join(transactionRoot, 'guardian-journal', `${transactionId}.json`);
  const journalBytes = await fs.readFile(journalPath);
  if (journalBytes.length < 2 || journalBytes.length > 8192) throw new Error('Guardian slot journal exceeds bound.');
  const journal = JSON.parse(journalBytes.toString('utf8'));
  if (journal.transactionId !== transactionId || journal.stage !== 'shell_stopped' || journal.sequence !== 2 ||
      journal.previousNative?.kind !== 'stable' ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(journal.previousNative.version ?? '') ||
      !SHA.test(journal.targetSha ?? '') || !['win32-x64', 'win32-arm64'].includes(journal.target)) {
    throw new Error('Guardian native A/B slot refuses a foreign journal stage or Stable A.');
  }
  const roots = Object.freeze({
    transactionId,
    programRoot: path.win32.join(env.LOCALAPPDATA, 'Programs', 'Equinox Local'),
    previousReleaseDir: path.win32.join(appRoot, 'releases', journal.previousNative.version),
    targetReleaseDir: path.win32.join(transactionRoot, 'native-store', journal.target, journal.targetSha, 'release'),
  });
  const journalDigest = createHash('sha256').update(journalBytes).digest();
  const key = Buffer.from(workerToken, 'hex');
  const endpoint = `\\\\.\\pipe\\EquinoxLocalMainAB-${transactionId}`;
  try {
    await new Promise((resolve, reject) => {
      const socket = net.createConnection(endpoint);
      let waiting = Buffer.alloc(0);
      let phase = 'nonce';
      let completed = false;
      const fail = (error) => socket.destroy(error);
      socket.setTimeout(120000, () => fail(new Error('Guardian native A/B slot permission timed out.')));
      socket.on('data', (chunk) => {
        waiting = Buffer.concat([waiting, chunk]);
        if (waiting.length > 33) { fail(new Error('Guardian native slot sent an oversized challenge.')); return; }
        if (phase === 'nonce' && waiting.length >= 32) {
          const nonce = waiting.subarray(0, 32);
          waiting = waiting.subarray(32);
          const response = createHmac('sha256', key).update(DOMAIN, 'ascii').update(nonce).update(journalDigest).digest();
          phase = 'grant';
          socket.write(response);
        }
        if (phase === 'grant' && waiting.length === 1) {
          if (waiting[0] !== 0x53) { fail(new Error('Guardian native slot refused its fixed single action.')); return; }
          waiting = Buffer.alloc(0);
          phase = 'executing';
          void (async () => {
            const before = await fs.readFile(journalPath);
            if (!before.equals(journalBytes)) throw new Error('Guardian native slot journal changed after HMAC admission.');
            await slotSwitch(roots, {
              requestShutdown: async () => {
                const staged = JSON.parse((await fs.readFile(journalPath)).toString('utf8'));
                if (staged.stage !== 'shell_stopped' || staged.sequence !== 2 || staged.transactionId !== transactionId) {
                  throw new Error('Guardian native slot lost its authenticated WPF shutdown milestone.');
                }
              },
            });
            socket.write(Buffer.from('s', 'ascii'));
            completed = true;
            phase = 'acknowledged';
          })().catch(fail);
        }
        if (phase === 'acknowledged' && waiting.length) fail(new Error('Guardian native slot returned unsolicited data.'));
      });
      socket.once('error', reject);
      socket.once('end', () => completed ? resolve() : reject(new Error('Guardian native slot disconnected before completing owned swap.')));
    });
  } finally {
    key.fill(0);
  }
}
