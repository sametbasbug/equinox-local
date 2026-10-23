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

test('native worker witness rejects high-bit challenge bytes rather than authenticating lossy ASCII decoding', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'win-worker-high-bit-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const socketPath=path.join(root,'proof.sock');
  const witness=await startEquinoxWindowsMainWorkerProof({
    transactionId:id,workerToken:token,platform:'test',fixtureSocketPath:socketPath,
  });
  t.after(()=>witness.close());
  const bytes=Buffer.from('a'.repeat(64)+'\n','ascii');
  bytes[0]|=0x80;
  const result=await new Promise((resolve,reject)=>{
    const socket=net.createConnection(socketPath);
    let response='';
    socket.on('connect',()=>socket.write(bytes));
    socket.on('data',chunk=>response+=chunk.toString('ascii'));
    socket.on('close',()=>resolve(response));
    socket.on('error',reject);
  });
  assert.equal(result,'');
});

test('native worker witness accepts exact chunked 64-hex challenge and rejects malformed nonce suffix', async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'win-worker-chunks-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const socketPath=path.join(root,'proof.sock');
  const witness=await startEquinoxWindowsMainWorkerProof({
    transactionId:id,workerToken:token,platform:'test',fixtureSocketPath:socketPath,
  });
  t.after(()=>witness.close());
  const challenge='c'.repeat(64);
  const result=await new Promise((resolve,reject)=>{
    const socket=net.createConnection(socketPath);
    let response='';
    socket.on('connect',()=>{socket.write(challenge.slice(0,27));socket.write(challenge.slice(27)+'\n');});
    socket.on('data',chunk=>response+=chunk.toString('ascii'));
    socket.on('end',()=>resolve(response));
    socket.on('error',reject);
  });
  const expected=createHmac('sha256',Buffer.from(token,'hex')).update(context,'ascii')
    .update(Buffer.from(challenge,'hex')).digest('hex')+'\n';
  assert.equal(result,expected);
  assert.equal(await connect(socketPath,challenge+'\nforged'), '');
  assert.equal(await connect(socketPath,challenge.toUpperCase()+'\n'), '');
});

test('native worker witness refuses an already-owned socket address without changing the owner', async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'win-worker-owner-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const socketPath=path.join(root,'proof.sock');
  const original=await startEquinoxWindowsMainWorkerProof({
    transactionId:id,workerToken:token,platform:'test',fixtureSocketPath:socketPath,
  });
  t.after(()=>original.close());
  await assert.rejects(startEquinoxWindowsMainWorkerProof({
    transactionId:id,workerToken:token,platform:'test',fixtureSocketPath:socketPath,
  }),{code:'EADDRINUSE'});
  const challenge='f'.repeat(64);
  const expected=createHmac('sha256',Buffer.from(token,'hex')).update(context,'ascii')
    .update(Buffer.from(challenge,'hex')).digest('hex')+'\n';
  assert.equal(await connect(socketPath,challenge+'\n'),expected);
});
