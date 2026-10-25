import assert from 'node:assert/strict';
import {createHash, createHmac} from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {proveEquinoxWindowsNativeJournalAuthority,proveEquinoxWindowsNativeBRollbackAuthority,requestEquinoxWindowsOwnedNativeShellShutdown,requestEquinoxWindowsOwnedNativeShellHealth,attestEquinoxWindowsOriginalGuardianSession} from '../../src/equinox-local-windows-native-journal-authority-client.js';

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

test('witness rejects symlinked journal without reading target',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'eq-journal-symlink-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const dir=path.join(root,'guardian-journal');
 await fs.mkdir(dir);
 const payload=JSON.stringify({transactionId:tx,stage:'prepared',sequence:0});
 const target=path.join(root,'other.json');
 await fs.writeFile(target,payload);
 await fs.symlink(target,path.join(dir,tx+'.json'));
 await assert.rejects(proveEquinoxWindowsNativeJournalAuthority({
  transactionId:tx,transactionRoot:root,workerToken:token,platform:'test',
  fixturePipePath:path.join(root,'absent.sock'),
 }),{code:'ELOOP'});
 assert.equal(await fs.readFile(target,'utf8'),payload);
});

test('witness denies oversize, directory and invalid JSON journal before socket',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'eq-journal-invalid-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const dir=path.join(root,'guardian-journal');
 await fs.mkdir(dir);
 const file=path.join(dir,tx+'.json');
 const args={transactionId:tx,transactionRoot:root,workerToken:token,
  platform:'test',fixturePipePath:path.join(root,'absent.sock')};
 await fs.writeFile(file,' '.repeat(8193));
 await assert.rejects(proveEquinoxWindowsNativeJournalAuthority(args),/size limit/u);
 await fs.rm(file);
 await fs.mkdir(file);
 await assert.rejects(proveEquinoxWindowsNativeJournalAuthority(args),/size limit/u);
 await fs.rm(file,{recursive:true});
 for(const value of ['null','[]','42','{bad',
    JSON.stringify({transactionId:tx,stage:'switched',sequence:0}),
    JSON.stringify({transactionId:tx,stage:'prepared',sequence:1})]){
  await fs.writeFile(file,value);
  await assert.rejects(proveEquinoxWindowsNativeJournalAuthority(args),/non-prepared|JSON/u);
 }
});

test('witness accepts fragmented challenge, rejects a 33-byte challenge',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'eq-journal-challenge-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const dir=path.join(root,'guardian-journal');
 await fs.mkdir(dir);
 const bytes=Buffer.from(JSON.stringify({transactionId:tx,stage:'prepared',sequence:0})+'\n');
 await fs.writeFile(path.join(dir,tx+'.json'),bytes);
 const nonce=Buffer.alloc(32,0xb3);
 const expected=createHmac('sha256',Buffer.from(token,'hex'))
  .update('equinox-local-guardian-journal-authority-v1:','ascii')
  .update(nonce).update(createHash('sha256').update(bytes).digest()).digest();
 const sock=path.join(root,'authority.sock');
 let count=0;
 const server=net.createServer(socket=>{
  count++;
  if(count===1){
   const chunks=[];
   socket.on('data',buf=>chunks.push(buf));
   socket.on('end',()=>{assert.deepEqual(Buffer.concat(chunks),expected);socket.end()});
   socket.write(nonce.subarray(0,8));
   setImmediate(()=>socket.write(nonce.subarray(8)));
  }else{
   socket.on('error',()=>{});
   socket.write(Buffer.alloc(33,5));
  }
 });
 await new Promise(resolve=>server.listen(sock,resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const opts={transactionId:tx,transactionRoot:root,workerToken:token,platform:'test',fixturePipePath:sock};
 await proveEquinoxWindowsNativeJournalAuthority(opts);
 await assert.rejects(proveEquinoxWindowsNativeJournalAuthority(opts),/challenge exceeded bound/u);
 assert.equal(count,2);
});


test('rollback witness uses a distinct native pipe challenge domain tied to exact rollback_started journal bytes',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'eq-native-b-rollback-proof-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const dir=path.join(root,'guardian-journal');await fs.mkdir(dir);
 const raw=Buffer.from(JSON.stringify({transactionId:tx,stage:'rollback_started',sequence:6})+'\n');
 await fs.writeFile(path.join(dir,tx+'.json'),raw);
 const socketPath=path.join(root,'rollback.sock');
 const nonce=Buffer.alloc(32,0x5e);
 const expected=createHmac('sha256',Buffer.from(token,'hex'))
  .update('equinox-local-guardian-b-rollback-authority-v1:','ascii')
  .update(nonce).update(createHash('sha256').update(raw).digest()).digest();
 const preparedMac=createHmac('sha256',Buffer.from(token,'hex'))
  .update('equinox-local-guardian-journal-authority-v1:','ascii')
  .update(nonce).update(createHash('sha256').update(raw).digest()).digest();
 assert.notDeepEqual(expected,preparedMac,'prepared proof must never replay as rollback proof');
 let received=null;
 const server=net.createServer(socket=>{
  const chunks=[];
  socket.on('data',chunk=>chunks.push(chunk));
  socket.on('end',()=>{received=Buffer.concat(chunks);socket.end();});
  socket.write(nonce.subarray(0,9));setImmediate(()=>socket.write(nonce.subarray(9)));
 });
 await new Promise(resolve=>server.listen(socketPath,resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 await proveEquinoxWindowsNativeBRollbackAuthority({transactionId:tx,transactionRoot:root,workerToken:token,platform:'test',fixturePipePath:socketPath});
 assert.deepEqual(received,expected);
});

test('native rollback witness fails closed on prepared, forged sequence, symlinked and oversized journal',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'eq-native-b-rollback-deny-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const dir=path.join(root,'guardian-journal');await fs.mkdir(dir);
 const file=path.join(dir,tx+'.json');
 const args={transactionId:tx,transactionRoot:root,workerToken:token,platform:'test',fixturePipePath:path.join(root,'unused.sock')};
 for(const [stage,sequence] of [['prepared',0],['switched',3],['rollback_started',0],['rollback_started',7],['rollback_started',1.5]]){
  await fs.writeFile(file,JSON.stringify({transactionId:tx,stage,sequence}));
  await assert.rejects(proveEquinoxWindowsNativeBRollbackAuthority(args),/invalid rollback_started generation/u);
 }
 await fs.writeFile(file,' '.repeat(8193));
 await assert.rejects(proveEquinoxWindowsNativeBRollbackAuthority(args),/size limit/u);
 await fs.rm(file);
 const foreign=path.join(root,'foreign-journal.json');await fs.writeFile(foreign,JSON.stringify({transactionId:tx,stage:'rollback_started',sequence:1}));
 await fs.symlink(foreign,file);
 await assert.rejects(proveEquinoxWindowsNativeBRollbackAuthority(args),{code:'ELOOP'});
});

test('same signed Guardian session checks stage-separated A and B shutdown HMAC before OS confirmation',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'equinox-native-live-stage-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.mkdir(path.join(root,'guardian-journal'));
 const socketPath=path.join(root,'stage.sock');
 const nonce=Buffer.alloc(32,19);
 const stages=[['A','native_staged',1,1],['B','rollback_started',5,2]];
 let index=0;
 const server=net.createServer(socket=>{
  const current=stages[index];
  const journal=Buffer.from(JSON.stringify({transactionId:tx,stage:current[1],sequence:current[2]}));
  const expected=createHmac('sha256',Buffer.from(token,'hex'))
   .update('equinox-local-guardian-native-stage-v1:')
   .update(Buffer.from([current[3]])).update(nonce)
   .update(createHash('sha256').update(journal).digest()).digest();
  let answer=Buffer.alloc(0);
  socket.on('data',chunk=>{
   answer=Buffer.concat([answer,chunk]);
   if(answer.length===33){
    assert.equal(answer[0],current[3]);
    assert.deepEqual(answer.subarray(1),expected);
    socket.write(Buffer.from([1]));
    index++;
   }
  });
  socket.write(nonce.subarray(0,8));setImmediate(()=>socket.write(nonce.subarray(8)));
 });
 await new Promise(resolve=>server.listen(socketPath,resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 for(const [release,stage,sequence] of stages){
  await fs.writeFile(path.join(root,'guardian-journal',tx+'.json'),
   JSON.stringify({transactionId:tx,stage,sequence}));
  await requestEquinoxWindowsOwnedNativeShellShutdown({
   transactionId:tx,transactionRoot:root,workerToken:token,platform:'test',
   fixturePipePath:socketPath,release,
  });
 }
 assert.equal(index,2);
});

test('live original Guardian stage refuses swapped generation, foreign worker and forged OS confirmation',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'eq-native-live-deny-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.mkdir(path.join(root,'guardian-journal'));
 const file=path.join(root,'guardian-journal',tx+'.json');
 const sock=path.join(root,'stage.sock');
 const args={transactionId:tx,transactionRoot:root,workerToken:token,platform:'test',fixturePipePath:sock};
 for(const [stage,sequence,release] of [['prepared',0,'A'],['native_staged',2,'A'],
   ['rollback_started',0,'B'],['rollback_started',7,'B'],['switched',4,'B']]){
  await fs.writeFile(file,JSON.stringify({transactionId:tx,stage,sequence}));
  await assert.rejects(requestEquinoxWindowsOwnedNativeShellShutdown({...args,release}),
   /unrelated native A\/B journal generation/u);
 }
 await fs.writeFile(file,JSON.stringify({transactionId:tx,stage:'native_staged',sequence:1}));
 await assert.rejects(requestEquinoxWindowsOwnedNativeShellShutdown({...args,workerToken:'bad',release:'A'}),
  /invalid exact worker identity/u);
 await assert.rejects(requestEquinoxWindowsOwnedNativeShellShutdown({...args,platform:'win32',release:'A'}),
  /invalid exact worker identity/u);
 let received=0;
 const server=net.createServer(socket=>{
  socket.on('data',chunk=>{received+=chunk.length;socket.write(Buffer.from([0]));});
  socket.write(Buffer.alloc(32,3));
 });
 await new Promise(resolve=>server.listen(sock,resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 await assert.rejects(requestEquinoxWindowsOwnedNativeShellShutdown({...args,release:'A'}),
  /did not confirm exact WPF OS shutdown/u);
 assert.equal(received,33);
});

test('the SAME live signed Guardian requires independent sustained B and restored A WPF OS HMAC proof',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'equinox-wpf-health-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.mkdir(path.join(root,'guardian-journal'));
 const file=path.join(root,'guardian-journal',tx+'.json');
 const pipe=path.join(root,'health.sock');
 const nonce=Buffer.alloc(32,25);
 const examples=[['B','restarted',4,3],['B','healthy',5,3],['B','committed',6,3],
  ['A','rollback_native_restored',7,4],['A','rollback_healthy',8,4],
  ['A','rolled_back',9,4]];
 let count=0;
 const server=net.createServer(socket=>{
  const [release,stage,sequence,opcode]=examples[count];
  const journal=Buffer.from(JSON.stringify({transactionId:tx,stage,sequence}));
  const expected=createHmac('sha256',Buffer.from(token,'hex'))
   .update('equinox-local-guardian-native-stage-v1:').update(Buffer.from([opcode]))
   .update(nonce).update(createHash('sha256').update(journal).digest()).digest();
  let response=Buffer.alloc(0);
  socket.on('data',chunk=>{
   response=Buffer.concat([response,chunk]);
   if(response.length===33){
    assert.equal(response[0],opcode);
    assert.deepEqual(response.subarray(1),expected);
    count++;
    socket.write(Buffer.from([1]));
  }});
  socket.write(nonce);
 });
 await new Promise(resolve=>server.listen(pipe,resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 for(const [release,stage,sequence] of examples) {
  await fs.writeFile(file,JSON.stringify({transactionId:tx,stage,sequence}));
  await requestEquinoxWindowsOwnedNativeShellHealth({
   transactionId:tx,transactionRoot:root,workerToken:token,release,
   platform:'test',fixturePipePath:pipe,
  });
 }
 assert.equal(count,examples.length);
 for(const [release,stage,sequence] of [['B','native_staged',1],['B','switched',3],
   ['A','rollback_started',5],['A','restarted',4]]){
  await fs.writeFile(file,JSON.stringify({transactionId:tx,stage,sequence}));
  await assert.rejects(requestEquinoxWindowsOwnedNativeShellHealth({
   transactionId:tx,transactionRoot:root,workerToken:token,release,
   platform:'test',fixturePipePath:pipe,
  }),/unrelated native A\/B journal generation/u);
 }
});

test('original Guardian read-only opcode zero authenticates fresh kernel owner at every legal journal stage, but never grants native shutdown',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'equinox-native-owner-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.mkdir(path.join(root,'guardian-journal'));
 const file=path.join(root,'guardian-journal',tx+'.json');
 const pipe=path.join(root,'read-owner.sock');
 const nonce=Buffer.alloc(32,29);
 let count=0;
 let raw=Buffer.alloc(0);
 const server=net.createServer(socket=>{
  const expected=createHmac('sha256',Buffer.from(token,'hex'))
   .update('equinox-local-guardian-native-stage-v1:')
   .update(Buffer.from([0])).update(nonce)
   .update(createHash('sha256').update(raw).digest()).digest();
  let bytes=Buffer.alloc(0);
  socket.on('data',chunk=>{
   bytes=Buffer.concat([bytes,chunk]);
   if(bytes.length===33){
    assert.equal(bytes[0],0);
    assert.deepEqual(bytes.subarray(1),expected);
    count++;
    socket.end(Buffer.from([1]));
   }
  });
  socket.write(nonce);
 });
 await new Promise(resolve=>server.listen(pipe,resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 for(const [stage,sequence] of [['prepared',0],['native_staged',1],['shell_stopped',2],
  ['switched',3],['restarted',4],['healthy',5],['committed',6],
  ['rollback_started',3],['rollback_native_restored',4],['rollback_healthy',5],['rolled_back',6]]){
  raw=Buffer.from(JSON.stringify({transactionId:tx,stage,sequence}));
  await fs.writeFile(file,raw);
  await attestEquinoxWindowsOriginalGuardianSession({
   transactionId:tx,transactionRoot:root,workerToken:token,platform:'test',
   fixturePipePath:pipe,
  });
 }
 assert.equal(count,11);
 for(const [stage,sequence] of [['prepared',1],['shell_stopped',3],['switched',2],['alien',4]]){
  await fs.writeFile(file,JSON.stringify({transactionId:tx,stage,sequence}));
  await assert.rejects(attestEquinoxWindowsOriginalGuardianSession({
   transactionId:tx,transactionRoot:root,workerToken:token,platform:'test',
   fixturePipePath:pipe,
  }),/unrelated native A\/B journal generation/u);
 }
 const guardian=await fs.readFile(new URL('../../native/windows/EquinoxLocal.Guardian/MainNativeGuardianSession.cs',import.meta.url),'utf8');
 assert.match(guardian,/opcode == 0/u);
 assert.match(guardian,/native-session-live-original-os-owner/u);
 assert.ok(guardian.indexOf('if (opcode == 0)')<guardian.indexOf('QuiesceOwnedStableShell(owner, root, worker, continuousNativeSession: true)'));
});
