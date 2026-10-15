import assert from 'node:assert/strict';
import {createHash, createHmac} from 'node:crypto';
import {EventEmitter} from 'node:events';
import path from 'node:path';
import test from 'node:test';

import {requestEquinoxLocalGuardianOwnedStableATerminalCommit} from '../../src/equinox-local-windows-native-ab-stable-a-terminal-client.js';

const tx=`main-${'b'.repeat(32)}`;
const local='C:\\Users\\ci\\AppData\\Local';
const install=path.win32.join(local,'Equinox Local');
const root=path.win32.join(install,'state','main-update');
const token='f'.repeat(64);
const originalJournal={transactionId:tx,stage:'rollback_healthy',sequence:7,
  previousNative:{kind:'stable',version:'6.0.4'},currentSha:'a'.repeat(40),target:'win32-x64'};
const original=Buffer.from(JSON.stringify(originalJournal));
const digest=createHash('sha256').update(original).digest();
const ownerMarker={schemaVersion:1,transactionId:tx,stage:'rollback_healthy',sequence:7,
  guardianPid:111,journalSha256:digest.toString('hex')};
const priorStage6Bytes=Buffer.from(JSON.stringify({...originalJournal,stage:'rollback_native_restored',sequence:6}));
const stage6Marker={schemaVersion:1,transactionId:tx,stage:'rollback_native_restored',sequence:6,guardianPid:111,journalSha256:createHash('sha256').update(priorStage6Bytes).digest('hex')};
const wpf={schemaVersion:1,transactionId:tx,stableVersion:'6.0.4',sourceSha:'a'.repeat(40),
  shellPid:333,shellStartTimeUtcTicks:'638000000000000000',guardianPid:111,
  stage6JournalSha256:stage6Marker.journalSha256};
const stage7Journal={...originalJournal,stage:'rolled_back',sequence:8};
const stage7Bytes=Buffer.from(JSON.stringify(stage7Journal));
const stage7Marker={schemaVersion:1,transactionId:tx,stage:'rolled_back',sequence:8,
  guardianPid:111,journalSha256:createHash('sha256').update(stage7Bytes).digest('hex')};
const hmac=(domain,nonce)=>createHmac('sha256',Buffer.from(token,'hex')).update(domain,'ascii').update(nonce).update(digest).digest();

class GuardianPipe extends EventEmitter {
  constructor(options){super();this.options=options;this.nonce=Buffer.alloc(32,42);this.count=0;}
  setTimeout(ms){assert.equal(ms,55000);}
  write(bytes){
    if(++this.count===1){
      assert.deepEqual(bytes,hmac('equinox-local-guardian-ab-terminal-a-worker-v1:',this.nonce));
      const owner=hmac('equinox-local-guardian-ab-terminal-a-owner-v1:',this.nonce);
      if(this.options.badOwner)owner[0]^=1;
      const packet=Buffer.concat([owner,Buffer.from(this.options.badCommand?'S':'T')]);
      queueMicrotask(()=>this.emit('data',packet));
    }else if(bytes.equals(Buffer.from('t'))){
      queueMicrotask(()=>{if(!this.options.noAck)this.emit('data',Buffer.from('a'));queueMicrotask(()=>this.emit('end'));});
    }
  }
  destroy(error){queueMicrotask(()=>this.emit('error',error));}
}
function harness(options={}){
  const f={connected:0};
  const pipe=new GuardianPipe(options);
  const connect=(name)=>{f.connected++;assert.equal(name,`\\\\.\\pipe\\EquinoxLocalMainAB-TerminalStableA-${tx}`);
    queueMicrotask(()=>pipe.emit('data',pipe.nonce));return pipe;};
  const fsImpl={readFile:async file=>Buffer.from(file.endsWith('.rollback_native_restored.commit.json')?
    JSON.stringify(options.badStage6?{...stage6Marker,guardianPid:222}:stage6Marker):
    file.endsWith('.rollback_healthy.commit.json')?
      JSON.stringify(options.badMarker?{...ownerMarker,guardianPid:222}:ownerMarker):
    file.endsWith('.rolled_back.commit.json')?
      JSON.stringify(options.badStage7?{...stage7Marker,guardianPid:222}:stage7Marker):
    file.endsWith('.wpf-a-restarted.json')?JSON.stringify(options.badWpf?{...wpf,guardianPid:222}:wpf):
    options.badJournal?JSON.stringify({...originalJournal,sequence:5}):
    pipe.count>1?stage7Bytes:original)};
  const run=(overrides={})=>requestEquinoxLocalGuardianOwnedStableATerminalCommit({
    transactionId:tx,transactionRoot:root,workerToken:token,
    stage6Receipt:{transactionId:tx,stage:'rollback_native_restored',sequence:6,guardianPid:111},
    relaunchReceipt:{transactionId:tx,stage:'wpf_a_restarted_health_pending',shellPid:333,shellStartTimeUtcTicks:'638000000000000000'},
    stage7Receipt:{transactionId:tx,stage:'rollback_healthy',sequence:7,guardianPid:111},
    installation:{managed:true,selfUpdateSupported:true,installRoot:install,target:'win32-x64'},
    platform:'win32',env:{LOCALAPPDATA:local},fsImpl,connect,...overrides,
  });
  return {run,f};
}
test('only original Guardian fixed T and exact SHA/PID can terminally close stage8 without cleanup',async()=>{
  const {run,f}=harness();const r=await run();
  assert.equal(r.stage,'rolled_back');assert.equal(r.sequence,8);assert.equal(r.failedBQuarantineRetained,true);assert.equal(r.shellPid,333);assert.equal(f.connected,1);
});
test('forged original Guardian HMAC or wrong fixed T action never admits terminal stage8',async()=>{
  for(const options of [{badOwner:true},{badCommand:true}]){
    const {run}=harness(options);await assert.rejects(run(),/fixed T original Guardian HMAC grant/u);
  }
});
test('forged stage7 journal or Guardian PID is rejected before terminal IPC',async()=>{
  for(const options of [{badJournal:true},{badMarker:true}]){
    const {run,f}=harness(options);await assert.rejects(run(),/terminal requires stage6\+7 SHA\/PID ancestry and exact A WPF birth/u);
    assert.equal(f.connected,0);
  }
});
test('missing original OS terminal ACK cannot attest rolled_back',async()=>{
  const {run}=harness({noAck:true});await assert.rejects(run(),/terminal ended without independent stage8 receipt/u);
});
test('forged original A WPF birth receipt denies terminal stage8',async()=>{
  const {run}=harness({badWpf:true});await assert.rejects(run(),/terminal requires stage6\+7 SHA\/PID ancestry and exact A WPF birth/u);
});
test('no terminal without original stage7 and same Guardian SID proof',async()=>{
  const {run,f}=harness();await assert.rejects(run({stage6Receipt:{transactionId:tx,stage:'rollback_started',sequence:5}}),/terminal A requires original stage7 and same Guardian stage6\/WPF evidence/u);
  assert.equal(f.connected,0);
});

test('forged terminal stage8 owner PID does not certify rolled_back',async()=>{
  const {run}=harness({badStage7:true});
  await assert.rejects(run(),/terminal requires durable rolled_back\/8 SHA\/PID marker and unbroken A lineage/u);
});

test('wrong earlier stage6 owner PID cannot admit even initial T OS challenge',async()=>{
  const {run,f}=harness({badStage6:true});
  await assert.rejects(run(),/terminal requires stage6\+7 SHA\/PID ancestry and exact A WPF birth/u);
  assert.equal(f.connected,0);
});
