import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { equinoxWindowsMainWorkerProofPipe, startEquinoxWindowsMainWorkerProof } from '../../src/equinox-local-windows-main-worker-proof.js';

const id = `main-${'a'.repeat(32)}`;
const token = 'e'.repeat(64);
const context = 'equinox-local-native-main-proof-v1:';

async function connect(pathname, body) {
  return new Promise((resolve, reject) => {
    let result = '';
    const socket = net.createConnection(pathname);
    socket.on('connect', () => socket.write(body));
    socket.on('data', chunk => { result += chunk.toString('ascii'); });
    socket.on('end', () => resolve(result));
    socket.on('error', reject);
  });
}

test('native worker witness responds to fresh nonces with domain-bound HMAC and cleans up', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'win-worker-proof-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const socketPath = path.join(root, 'w.sock');
  const server = await startEquinoxWindowsMainWorkerProof({transactionId:id,workerToken:token,platform:'test',fixtureSocketPath:socketPath});
  t.after(async () => server.close());
  for (const challenge of ['0'.repeat(64), '1'.repeat(64)]) {
    const response = await connect(socketPath, `${challenge}\n`);
    const expected = createHmac('sha256', Buffer.from(token,'hex'))
      .update(context, 'ascii').update(Buffer.from(challenge,'hex')).digest('hex');
    assert.equal(response, `${expected}\n`);
  }
  assert.equal(await connect(socketPath, 'invalid\n'), '');
  assert.equal(await connect(socketPath, `${'b'.repeat(70)}\n`), '');
});

test('native worker witness rejects invalid tokens, transactions, and forbidden endpoint overrides', async () => {
  assert.match(equinoxWindowsMainWorkerProofPipe(id), /EquinoxLocalMainOwner-main-/u);
  assert.throws(() => equinoxWindowsMainWorkerProofPipe('other'), /invalid/u);
  await assert.rejects(startEquinoxWindowsMainWorkerProof({transactionId:id,workerToken:'bad',platform:'test',fixtureSocketPath:'/tmp/unused'}), /invalid/u);
  await assert.rejects(startEquinoxWindowsMainWorkerProof({transactionId:id,workerToken:token,platform:'win32',fixtureSocketPath:'/tmp/foreign'}), /invalid/u);
});
