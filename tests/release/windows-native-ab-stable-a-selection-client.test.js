import assert from 'node:assert/strict';
import {createHash, createHmac} from 'node:crypto';
import {EventEmitter} from 'node:events';
import path from 'node:path';
import test from 'node:test';

import {runEquinoxLocalWindowsGuardianOwnedStableASelection} from '../../src/equinox-local-windows-native-ab-stable-a-selection-client.js';

const transactionId = `main-${'b'.repeat(32)}`;
const local = 'C:\\Users\\test\\AppData\\Local';
const root = path.win32.join(local, 'Equinox Local');
const transactionRoot = path.win32.join(root, 'state', 'main-update');
const workerToken = 'f'.repeat(64);
const journal = {transactionId, stage:'rollback_started',sequence:5,
  previousNative:{kind:'stable',version:'6.0.4'},currentSha:'a'.repeat(40),
  targetSha:'c'.repeat(40),target:'win32-x64',targetRuntimeContractSha256:'f'.repeat(64)};
const bytes=Buffer.from(JSON.stringify(journal));
const digest=createHash('sha256').update(bytes).digest();
const physicalReceipt={transactionId,stage:'physical_a_restored_pending_native_and_source_commit'};
const installation={managed:true,selfUpdateSupported:true,installRoot:root,target:'win32-x64'};
const hmac=(domain,nonce)=>createHmac('sha256',Buffer.from(workerToken,'hex')).update(domain,'ascii').update(nonce).update(digest).digest();

class OriginalPipe extends EventEmitter {
  constructor({badOwner=false, badGrant=false, duplicateGrant=false, ack=true}={}) {
    super();this.nonce=Buffer.alloc(32,0x34);this.count=0;
    this.badOwner=badOwner;this.badGrant=badGrant;this.duplicateGrant=duplicateGrant;this.ack=ack;
  }
  setTimeout(ms){assert.equal(ms,45000);}
  write(buffer){
    this.count++;
    if(this.count===1){
      assert.deepEqual(buffer,hmac('equinox-local-guardian-ab-select-stable-a-worker-v1:',this.nonce));
      const mac=hmac('equinox-local-guardian-ab-select-stable-a-owner-v1:',this.nonce);
      if(this.badOwner)mac[0]^=0x01;
      const grant=Buffer.concat([mac,Buffer.from(this.badGrant?'R':'S')]);
      queueMicrotask(()=>{this.emit('data',grant);if(this.duplicateGrant)this.emit('data',grant);});
    }else if(buffer.equals(Buffer.from('s'))){
      queueMicrotask(()=>{if(this.ack)this.emit('data',Buffer.from('a'));queueMicrotask(()=>this.emit('end'));});
    }
  }
  destroy(error){queueMicrotask(()=>this.emit('error',error));}
}
function fixture(opts={}){
  const f={mutations:0,pipes:[],writes:[]};
  const pipe=new OriginalPipe(opts);
  const fsImpl={readFile:async()=>Buffer.from(opts.journalBytes??bytes)};
  const connect=name=>{f.pipes.push(name);queueMicrotask(()=>pipe.emit('data',pipe.nonce));return pipe;};
  const applySelection=async()=>{f.mutations++;return {status:'selected_a_identity_stage6_pending'};};
  const run=(overrides={})=>runEquinoxLocalWindowsGuardianOwnedStableASelection({
    transactionId,transactionRoot,workerToken,installation,physicalReceipt,
    platform:'win32',env:{LOCALAPPDATA:local},fsImpl,connect,applySelection,...overrides,
  });
  return {f,run};
}

test('only matching original Guardian mutual-HMAC S grant permits one A identity selection, not stage6',async()=>{
  const {f,run}=fixture();const r=await run();
  assert.equal(r.stage,'a_identity_selected_stage6_pending');
  assert.equal(f.mutations,1);
  assert.deepEqual(f.pipes,[`\\\\.\\pipe\\EquinoxLocalMainAB-SelectStableA-${transactionId}`]);
});

test('wrong Guardian owner HMAC or command refuses A pointer mutation',async()=>{
  for(const opt of [{badOwner:true},{badGrant:true}]){
    const {f,run}=fixture(opt);
    await assert.rejects(run(),/fixed S and live original Guardian server HMAC/u);
    assert.equal(f.mutations,0);
  }
});

test('missing physical restore proof refuses socket and all identity mutations',async()=>{
  const {f,run}=fixture();
  await assert.rejects(run({physicalReceipt:{transactionId,stage:'rollback_started'}}),/physical proof/u);
  assert.equal(f.mutations,0);assert.equal(f.pipes.length,0);
});

test('foreign journal or stale stage5 refuses before socket',async()=>{
  const {f,run}=fixture({journalBytes:Buffer.from(JSON.stringify({...journal,sequence:4}))});
  await assert.rejects(run(),/rollback_started\/5/u);
  assert.equal(f.mutations,0);assert.equal(f.pipes.length,0);
});

test('original Guardian disconnect without final identity ACK never reports selected A',async()=>{
  const {f,run}=fixture({ack:false});
  await assert.rejects(run(),/without authoritative ACK/u);
  assert.equal(f.mutations,1);
});

test('replayed S grant can never repeat partially applied identity selection',async()=>{
  const {f,run}=fixture({duplicateGrant:true});
  await assert.rejects(run(),/Original Guardian|unsolicited|ACK/u);
  assert.equal(f.mutations,1);
});

test('real Stable A action delegates all mutations to pinned product source and Native Messaging helpers', async()=>{
  const {readFile}=await import('node:fs/promises');
  const file=await readFile(new URL('../../src/equinox-local-windows-native-ab-stable-a-selection-client.js',import.meta.url),'utf8');
  assert.match(file,/EQUINOX_LOCAL_DUGITE_VERSION/u);
  assert.match(file,/readEquinoxLocalMainSourcePointer/u);
  assert.match(file,/writeEquinoxLocalMainSourcePointer/u);
  assert.match(file,/readEquinoxLocalMainNativePointer/u);
  assert.match(file,/assertWindowsNativeMessagingHostOwnership/u);
  assert.match(file,/registerWindowsNativeMessagingHost/u);
  assert.match(file,/source\.sha !== journal\.targetSha/u);
  assert.match(file,/await writeSource\(sourcePointer, \{sourceRoot: oldSource, sha: journal\.currentSha\}/u);
  assert.match(file,/await fsImpl\.unlink\(nativePointer\)/u);
  assert.match(file,/expectedPreviousLauncherPath: bLauncher/u);
  assert.match(file,/selected\.sha !== journal\.currentSha/u);
  assert.match(file,/selected_a_identity_stage6_pending/u);
  assert.doesNotMatch(file,/WriteIntegratedOwnedNativeStage|Process\.Kill|Process\.Start|rollback_native_restored/u);
});
