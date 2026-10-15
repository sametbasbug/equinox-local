import assert from 'node:assert/strict';
import {createHash, createHmac} from 'node:crypto';
import {EventEmitter} from 'node:events';
import path from 'node:path';
import test from 'node:test';

import {requestEquinoxLocalGuardianOwnedStableAWpfRelaunch} from '../../src/equinox-local-windows-native-ab-stable-a-relaunch-client.js';

const tx=`main-${'b'.repeat(32)}`;
const local='C:\\Users\\ci\\AppData\\Local';
const install=path.win32.join(local,'Equinox Local');
const root=path.win32.join(install,'state','main-update');
const token='f'.repeat(64);
const originalJournal={transactionId:tx,stage:'rollback_native_restored',sequence:6,
  previousNative:{kind:'stable',version:'6.0.4'},currentSha:'a'.repeat(40),target:'win32-x64'};
const original=Buffer.from(JSON.stringify(originalJournal));
const digest=createHash('sha256').update(original).digest();
const ownerMarker={schemaVersion:1,transactionId:tx,stage:'rollback_native_restored',sequence:6,
  guardianPid:111,journalSha256:digest.toString('hex')};
const wpf={schemaVersion:1,transactionId:tx,stableVersion:'6.0.4',sourceSha:'a'.repeat(40),
  shellPid:333,shellStartTimeUtcTicks:'638000000000000000',guardianPid:111,
  stage6JournalSha256:digest.toString('hex')};
const hmac=(domain,nonce)=>createHmac('sha256',Buffer.from(token,'hex')).update(domain,'ascii').update(nonce).update(digest).digest();

class GuardianPipe extends EventEmitter {
  constructor(options){super();this.options=options;this.nonce=Buffer.alloc(32,42);this.count=0;}
  setTimeout(ms){assert.equal(ms,65000);}
  write(bytes){
    if(++this.count===1){
      assert.deepEqual(bytes,hmac('equinox-local-guardian-ab-relaunch-a-worker-v1:',this.nonce));
      const owner=hmac('equinox-local-guardian-ab-relaunch-a-owner-v1:',this.nonce);
      if(this.options.badOwner)owner[0]^=1;
      const packet=Buffer.concat([owner,Buffer.from(this.options.badCommand?'S':'L')]);
      queueMicrotask(()=>this.emit('data',packet));
    }else if(bytes.equals(Buffer.from('l'))){
      queueMicrotask(()=>{if(!this.options.noAck)this.emit('data',Buffer.from('a'));queueMicrotask(()=>this.emit('end'));});
    }
  }
  destroy(error){queueMicrotask(()=>this.emit('error',error));}
}
function harness(options={}){
  const f={connected:0};
  const pipe=new GuardianPipe(options);
  const connect=(name)=>{f.connected++;assert.equal(name,`\\\\.\\pipe\\EquinoxLocalMainAB-RelaunchStableA-${tx}`);
    queueMicrotask(()=>pipe.emit('data',pipe.nonce));return pipe;};
  const fsImpl={readFile:async file=>Buffer.from(file.endsWith('rollback_native_restored.commit.json')?
    JSON.stringify(options.badMarker?{...ownerMarker,guardianPid:222}:ownerMarker):
    file.endsWith('.wpf-a-restarted.json')?JSON.stringify(options.badWpf?{...wpf,guardianPid:222}:wpf):
    options.badJournal?JSON.stringify({...originalJournal,sequence:5}):original)};
  const run=(overrides={})=>requestEquinoxLocalGuardianOwnedStableAWpfRelaunch({
    transactionId:tx,transactionRoot:root,workerToken:token,
    stage6Receipt:{transactionId:tx,stage:'rollback_native_restored',sequence:6,guardianPid:111},
    installation:{managed:true,selfUpdateSupported:true,installRoot:install,target:'win32-x64'},
    platform:'win32',env:{LOCALAPPDATA:local},fsImpl,connect,...overrides,
  });
  return {run,f};
}
test('original Guardian mutual HMAC L and exact SHA WPF process receipt prove relaunch only, no A health',async()=>{
  const {run,f}=harness();const r=await run();
  assert.equal(r.stage,'wpf_a_restarted_health_pending');assert.equal(r.shellPid,333);assert.equal(f.connected,1);
});
test('original Guardian forged HMAC or wrong action prevents OS launch receipt',async()=>{
  for(const options of [{badOwner:true},{badCommand:true}]){
    const {run}=harness(options);await assert.rejects(run(),/fixed L original Guardian HMAC grant/u);
  }
});
test('stage6 journal or forged sidecar rejected without connecting to a named pipe',async()=>{
  for(const options of [{badJournal:true},{badMarker:true}]){
    const {run,f}=harness(options);await assert.rejects(run(),/original Guardian durable stage6 SHA\/PID receipt/u);
    assert.equal(f.connected,0);
  }
});
test('missing original OS Guardian final attestation is not relaunch proof',async()=>{
  const {run}=harness({noAck:true});await assert.rejects(run(),/ended without OS WPF attestation/u);
});
test('mismatched original Guardian PID in post-launch WPF receipt cannot prove healthy A',async()=>{
  const {run}=harness({badWpf:true});await assert.rejects(run(),/exact Stable A WPF OS process and stage6 receipt/u);
});
test('no relaunch without authenticated stage6 from exact transaction',async()=>{
  const {run,f}=harness();await assert.rejects(run({stage6Receipt:{transactionId:tx,stage:'rollback_started',sequence:5}}),/OS-owned stage6 identity/u);
  assert.equal(f.connected,0);
});
