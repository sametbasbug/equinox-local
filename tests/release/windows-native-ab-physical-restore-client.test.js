import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import test from 'node:test';

import { runEquinoxLocalWindowsGuardianOwnedPhysicalARestore } from '../../src/equinox-local-windows-native-ab-physical-restore-client.js';

const transactionId = `main-${'b'.repeat(32)}`;
const local = 'C:\\Users\\test\\AppData\\Local';
const app = path.win32.join(local, 'Equinox Local');
const transactionRoot = path.win32.join(app, 'state', 'main-update');
const workerToken = 'f'.repeat(64);
const journal = Object.freeze({transactionId, stage: 'rollback_started', sequence: 5,
  previousNative: {kind:'stable',version:'6.0.4'}, currentSha:'a'.repeat(40),
  targetSha:'c'.repeat(40),target:'win32-x64',receiptStartedAt:'2026-10-15T14:00:00.000Z'});
const contents = Buffer.from(JSON.stringify(journal));
const digest = createHash('sha256').update(contents).digest();
const installation = {managed:true,selfUpdateSupported:true,target:'win32-x64',installRoot:app,
  releaseDir:path.win32.join(app,'releases','6.0.4')};
const hmac = (domain, nonce) => createHmac('sha256',Buffer.from(workerToken,'hex')).update(domain,'ascii').update(nonce).update(digest).digest();
const CLIENT = 'equinox-local-guardian-ab-physical-restore-worker-v1:';
const OWNER = 'equinox-local-guardian-ab-physical-restore-owner-v1:';

class FixedGuardianPipe extends EventEmitter {
  constructor({badMac=false, badGrant=false, ownerAck=true, duplicateGrant=false}={}) {
    super();
    this.writes = [];
    this.badMac=badMac; this.badGrant=badGrant; this.ownerAck=ownerAck; this.duplicateGrant=duplicateGrant;
    this.nonce = Buffer.alloc(32,0x4a);
  }
  setTimeout(ms, callback) {this.timeoutCallback=callback; assert.equal(ms,45000);}
  write(bytes) {
    const copy=Buffer.from(bytes);this.writes.push(copy);
    if(this.writes.length===1){
      assert.deepEqual(copy,hmac(CLIENT,this.nonce));
      const mac=hmac(OWNER,this.nonce);
      if(this.badMac) mac[0] ^= 0x01;
      const grant=Buffer.concat([mac, Buffer.from(this.badGrant?'X':'R')]);
      queueMicrotask(()=>{this.emit('data',grant);if(this.duplicateGrant)this.emit('data',grant);});
    } else if(copy.equals(Buffer.from('r')) && this.ownerAck){
      queueMicrotask(()=>{this.emit('data',Buffer.from('a'));queueMicrotask(()=>this.emit('end'));});
    } else if(copy.equals(Buffer.from('r'))){
      queueMicrotask(()=>this.emit('end'));
    }
  }
  destroy(err){queueMicrotask(()=>this.emit('error',err));}
}
function harness({pipeOptions={},journalBytes=contents,observerResult=null,workerTokenOverride=workerToken}={}){
  const calls={restores:0,observes:0,verification:0,pipes:[],slots:[]};
  const fsImpl={readFile:async()=>Buffer.from(journalBytes)};
  const observer=async args=>{
    calls.observes++;
    assert.equal(args.stage,'rollback_started');
    assert.equal(args.expected.targetSha,journal.targetSha);
    assert.equal(typeof args.verifyGuardianOsOwner,'function');
    return observerResult ?? {transactionId,stage:'rollback_started',sequence:5,sourceSha:journal.targetSha,
      guardianPid:5678,journalSha256:createHash('sha256').update(journalBytes).digest('hex')};
  };
  const makeVerifier=()=>{calls.verification++;return async()=>true;};
  const pipe=new FixedGuardianPipe(pipeOptions);
  const connect=name=>{calls.pipes.push(name);queueMicrotask(()=>pipe.emit('data',pipe.nonce));return pipe;};
  const slotRestore=async slots=>{
    calls.restores++;calls.slots.push(slots);
    return {stage:'restored'};
  };
  const run=()=>runEquinoxLocalWindowsGuardianOwnedPhysicalARestore({
    transactionId,transactionRoot,workerToken:workerTokenOverride,installation,
    platform:'win32',env:{LOCALAPPDATA:local},fsImpl,observer,makeVerifier,connect,slotRestore,
  });
  return {run,calls,pipe};
}

test('only a fresh authenticated ORIGINAL Guardian grant executes the existing shared physical A restore exactly once', async()=>{
  const f=harness();
  const result=await f.run();
  assert.equal(result.stage,'physical_a_restored_pending_native_and_source_commit');
  assert.equal(f.calls.restores,1);
  assert.equal(f.calls.observes,1);
  assert.equal(f.calls.verification,1);
  assert.equal(f.calls.pipes[0],`\\\\.\\pipe\\EquinoxLocalMainAB-PhysicalRestore-${transactionId}`);
  assert.deepEqual(f.calls.slots[0],{
    transactionId,programRoot:path.win32.join(local,'Programs','Equinox Local'),
    previousReleaseDir:path.win32.join(app,'releases','6.0.4'),
    targetReleaseDir:path.win32.join(transactionRoot,'native-store','win32-x64',journal.targetSha,'release'),
  });
});

test('forged Guardian server HMAC and forged action cannot move physical A',async()=>{
  for(const key of ['badMac','badGrant']){
    const f=harness({pipeOptions:{[key]:true}});
    await assert.rejects(f.run(),/fresh server HMAC and fixed R grant/u);
    assert.equal(f.calls.restores,0);
  }
});

test('stale journal evidence fails BEFORE connection or physical A restore', async()=>{
  const f=harness({observerResult:{transactionId,stage:'rollback_started',sequence:5,
    guardianPid:5678,sourceSha:journal.targetSha,journalSha256:'0'.repeat(64)}});
  await assert.rejects(f.run(),/not independently attested/u);
  assert.equal(f.calls.restores,0);
  assert.equal(f.calls.pipes.length,0);
});

test('missing Guardian post-restore acknowledgment cannot be reported as successful, despite verified physical A',async()=>{
  const f=harness({pipeOptions:{ownerAck:false}});
  await assert.rejects(f.run(),/without verified owner acknowledgement/u);
  assert.equal(f.calls.restores,1);
});

test('foreign worker token never reaches Guardian action',async()=>{
  const f=harness({workerTokenOverride:'invalid'});
  await assert.rejects(f.run(),/exact Windows transaction identity/u);
  assert.equal(f.calls.restores,0);
});

test('replayed R grant during physical rename cannot cause a second A/B restore', async()=>{
  const f=harness({pipeOptions:{duplicateGrant:true}});
  await assert.rejects(f.run(),/Guardian did not acknowledge|Guardian physical A protocol|without verified owner acknowledgement/u);
  assert.equal(f.calls.restores,1,'a duplicated fixed grant must never replay the filesystem mutation');
});
