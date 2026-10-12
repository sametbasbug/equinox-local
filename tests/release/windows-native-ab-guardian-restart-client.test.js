import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import test from 'node:test';

import { requestEquinoxLocalGuardianOwnedBWpfRestart } from '../../src/equinox-local-windows-native-ab-restart-client.js';

const local = 'C:\\Users\\fixture\\AppData\\Local';
const transactionRoot = path.win32.join(local, 'Equinox Local', 'state', 'main-update');
const transactionId = `main-${'3'.repeat(32)}`;
const sourceSha = 'b'.repeat(40);
const contract = 'f'.repeat(64);
const workerToken = 'e'.repeat(64);
const journalPath = path.win32.join(transactionRoot, 'guardian-journal', `${transactionId}.json`);
const sourcePath = path.win32.join(transactionRoot, 'current-source.conf');
const nativePath = path.win32.join(transactionRoot, 'current-native.json');
const journal = { schemaVersion: 1, transactionId, stage: 'switched', sequence: 3,
  targetSha: sourceSha, target: 'win32-x64', targetRuntimeContractSha256: contract };
const native = { schemaVersion: 1, channel: 'main', sourceSha,
  target: 'win32-x64', runtimeContractSha256: contract };
const source = `schemaVersion=1\nsourceRoot=${path.win32.join(transactionRoot, 'sources', sourceSha)}\nsha=${sourceSha}\n`;

function fixture({ selected = sourceSha, stage = 'switched', nativeContract = contract, serverAccepted = true } = {}) {
  const memory = new Map([
    [sourcePath, source.replaceAll(sourceSha, selected)],
    [nativePath, JSON.stringify({ ...native, runtimeContractSha256: nativeContract })],
    [journalPath, JSON.stringify({ ...journal, stage, sequence: stage === 'restarted' ? 4 : 3 })],
  ]);
  let connects = 0;
  const fsImpl = { readFile: async (name, encoding) => {
    if (!memory.has(name)) throw new Error(`unexpected read ${name}`);
    const data = memory.get(name);
    return encoding ? data : Buffer.from(data);
  } };
  function connect(endpoint) {
    connects++;
    assert.equal(endpoint, `\\\\.\\pipe\\EquinoxLocalMainAB-Restart-${transactionId}`);
    const stream = new EventEmitter();
    stream.setTimeout = () => stream;
    stream.destroy = (error) => { queueMicrotask(() => stream.emit('error', error)); };
    const nonce = Buffer.alloc(32, 0x41);
    stream.write = (mac) => {
      const exact = createHmac('sha256', Buffer.from(workerToken, 'hex'))
        .update('equinox-local-guardian-ab-restart-v1:', 'ascii')
        .update(nonce).update(createHash('sha256').update(Buffer.from(JSON.stringify(journal))).digest())
        .digest();
      assert.ok(mac.equals(exact), 'Guardian accepted only its exact switched journal nonce and worker token');
      if (serverAccepted) {
        memory.set(journalPath, JSON.stringify({ ...journal, stage: 'restarted', sequence: 4 }));
        queueMicrotask(() => { stream.emit('data', Buffer.from('r')); stream.emit('end'); });
      } else queueMicrotask(() => stream.emit('end'));
    };
    queueMicrotask(() => stream.emit('data', nonce));
    return stream;
  }
  return { fsImpl, connect, get connects() { return connects; } };
}

const options = { transactionId, transactionRoot, workerToken, sourceSha,
  platform: 'win32', env: { LOCALAPPDATA: local } };

test('Guardian B restart rejects wrong platform, transaction roots, journal stage and mixed source/native pointers before IPC', async () => {
  const good = fixture();
  await assert.rejects(requestEquinoxLocalGuardianOwnedBWpfRestart({ ...options, platform: 'darwin', ...good }), /requires an exact Windows owner/u);
  await assert.rejects(requestEquinoxLocalGuardianOwnedBWpfRestart({ ...options, transactionRoot: 'C:\\Other', ...good }), /cannot cross/u);
  const stale = fixture({ stage: 'prepared' });
  await assert.rejects(requestEquinoxLocalGuardianOwnedBWpfRestart({ ...options, ...stale }), /non-switched/u);
  const wrongSource = fixture({ selected: 'a'.repeat(40) });
  await assert.rejects(requestEquinoxLocalGuardianOwnedBWpfRestart({ ...options, ...wrongSource }), /source pointer/u);
  const wrongNative = fixture({ nativeContract: 'a'.repeat(64) });
  await assert.rejects(requestEquinoxLocalGuardianOwnedBWpfRestart({ ...options, ...wrongNative }), /native B/u);
  assert.equal(good.connects + stale.connects + wrongSource.connects + wrongNative.connects, 0);
});

test('Guardian B restart requires real OS-owned native restarted milestone after nonce HMAC', async () => {
  const f = fixture();
  assert.deepEqual(await requestEquinoxLocalGuardianOwnedBWpfRestart({ ...options, ...f }),
    { transactionId, sourceSha, journalStage: 'restarted' });
  assert.equal(f.connects, 1);
  const missing = fixture({ serverAccepted: false });
  await assert.rejects(requestEquinoxLocalGuardianOwnedBWpfRestart({ ...options, ...missing }), /disconnected before exact native B restart proof/u);
});
