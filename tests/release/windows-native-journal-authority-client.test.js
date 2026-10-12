import assert from 'node:assert/strict';
import {createHash, createHmac} from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {proveEquinoxWindowsNativeJournalAuthority} from '../../src/equinox-local-windows-native-journal-authority-client.js';

const tx = `main-${'a'.repeat(32)}`;
const token = 'e'.repeat(64);

test('journal authority worker client binds a fresh challenge to the exact prepared journal digest', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'win-journal-proof-'));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  const dir = path.join(root,'guardian-journal');
  await fs.mkdir(dir);
  const journalFile = path.join(dir,`${tx}.json`);
  const source = Buffer.from(JSON.stringify({transactionId:tx,stage:'prepared',sequence:0})+'\n');
  await fs.writeFile(journalFile,source);
  const sock = path.join(root,'c.sock');
  const nonce = Buffer.alloc(32,4);
  const expected = createHmac('sha256', Buffer.from(token,'hex'))
    .update('equinox-local-guardian-journal-authority-v1:','ascii')
    .update(nonce).update(createHash('sha256').update(source).digest()).digest();
  const server = net.createServer(socket => {
    const chunks = [];
    socket.on('data', chunk => chunks.push(chunk));
    socket.on('end', () => {
      const actual = Buffer.concat(chunks);
      assert.deepEqual(actual,expected);
      socket.end();
    });
    socket.write(nonce);
  });
  await new Promise(resolve => server.listen(sock,resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await proveEquinoxWindowsNativeJournalAuthority({transactionId:tx,transactionRoot:root,workerToken:token,platform:'test',fixturePipePath:sock});
});

test('journal authority client refuses non-prepared stage, bad identity, and user pipe overrides',async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'win-journal-deny-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'guardian-journal'));
  await fs.writeFile(path.join(root,'guardian-journal',`${tx}.json`),JSON.stringify({transactionId:tx,stage:'switched',sequence:3}));
  await assert.rejects(proveEquinoxWindowsNativeJournalAuthority({transactionId:tx,transactionRoot:root,workerToken:token,platform:'test',fixturePipePath:path.join(root,'unused')}),/non-prepared/u);
  await assert.rejects(proveEquinoxWindowsNativeJournalAuthority({transactionId:tx,transactionRoot:root,workerToken:'wrong',platform:'test',fixturePipePath:path.join(root,'unused')}),/invalid exact identity/u);
  await assert.rejects(proveEquinoxWindowsNativeJournalAuthority({transactionId:tx,transactionRoot:root,workerToken:token,platform:'win32',fixturePipePath:path.join(root,'unsafe')}),/invalid exact identity/u);
});
