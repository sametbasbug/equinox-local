import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { admitWindowsMainNativeWorkerJournal } from '../../src/equinox-local-windows-main-worker-admission.js';

const ID = `main-${'e'.repeat(32)}`;
const A = 'a'.repeat(40), B = 'b'.repeat(40), CONTRACT = 'c'.repeat(64);
const TOKEN = 'd'.repeat(64), STARTED = '2026-10-12T11:00:00.000Z';
const RELEASE = String.raw`C:\Users\Test\AppData\Local\Equinox Local\releases\6.0.4`;
const ROOT = String.raw`C:\Users\Test\AppData\Local\Equinox Local\state\main-update`;
const NODE = path.win32.join(RELEASE, 'runtime', 'node', 'bin', 'node.exe');
const NATIVE_HELPER = path.win32.join(ROOT, 'native-store', 'win32-x64', B, 'release', 'runtime', 'job', 'equinox-local-job-object-helper.exe');

function fixture({ stage = 'ready_to_switch', token = TOKEN, pid = 1234, processOk = true, previous = null, journalRecord = null } = {}) {
  const receipt = { transactionId: ID, status: stage === 'source_switched' ? 'verifying' : 'promoting', stage,
    currentSha: A, targetSha: B, startedAt: STARTED };
  const transition = { mode: 'artifact_required', target: 'win32-x64', currentSha: A, targetSha: B,
    currentRuntimeContractSha256: 'a'.repeat(64), targetRuntimeContractSha256: CONTRACT };
  const previousNative = previous ? { kind: 'main', sourceSha: A, runtimeContractSha256: 'a'.repeat(64) }
    : { kind: 'stable', version: '6.0.4' };
  let stored = journalRecord;
  const calls = [];
  const journal = {
    create: async (data) => { calls.push('create'); if (stored) throw Object.assign(Error('already exists'), { code: 'EEXIST' }); stored = { ...data, previousNative: data.previousNative, targetRuntimeContractSha256: CONTRACT }; },
    read: async (_, expected) => { calls.push('read'); assert.equal(expected.targetSha, B); if (!stored) throw Object.assign(Error('missing'), { code: 'ENOENT' }); return stored; },
  };
  const options = {
    receipt, transition, installation: { releaseDir: RELEASE, target: 'win32-x64', managed: true, selfUpdateSupported: true },
    transactionRoot: ROOT, engine: { readActive: async () => receipt },
    workerToken: TOKEN, workerPid: 1234, workerNodePath: NODE, nativeHelperPath: NATIVE_HELPER,
    readWorkerImpl: async () => ({ ownership: { transactionId: ID, token, pid, nodePath: NODE, startTimeUtcTicks: '638958000000000000' } }),
    inspectWorkerImpl: async (_ownership, options) => { assert.equal(options.nativeHelperPath, NATIVE_HELPER); return processOk ? { running: true, stale: false, uncertain: false } : { running: false, stale: true, uncertain: false }; },
    readPointerImpl: async () => previous ? { sourceSha: A, target: 'win32-x64', runtimeContractSha256: 'a'.repeat(64) } : Promise.reject(Object.assign(Error('none'), { code: 'ENOENT' })),
    journalFactory: () => journal,
    // Unit fixture cannot spawn a signed Windows executable on macOS/Linux.
    // The PRODUCT DEFAULT is the real signed Guardian process/HMAC/OS lease.
    authenticateSignedGuardianImpl: async (identity) => {
      calls.push('signed-guardian');
      assert.equal(identity.transactionId, ID);
      assert.equal(identity.workerToken, TOKEN);
      return Object.freeze({originalSignedOwner:true, guardianPid:733,workerPid:1234,
        workerStartTimeUtcTicks:'638958000000000000'});
    },
  };
  return { options, journal, calls, getStored: () => stored, previousNative };
}

test('real Windows worker admission binds product Stable Node, PID, secret, receipt and creates journal once', async () => {
  const f = fixture();
  const value = await admitWindowsMainNativeWorkerJournal(f.options);
  assert.equal(value.admitted, true);
  assert.equal(value.journal, f.journal);
  assert.deepEqual(f.calls, ['create', 'read', 'signed-guardian']);
  assert.deepEqual(f.getStored().previousNative, f.previousNative);
  const again = fixture({ journalRecord: f.getStored() });
  assert.equal((await admitWindowsMainNativeWorkerJournal(again.options)).admitted, true);
  assert.deepEqual(again.calls, ['create', 'read', 'signed-guardian']);
});

test('resuming interrupted Windows worker never invents missing durable journal', async () => {
  const f = fixture({ stage: 'native_switched' });
  await assert.rejects(admitWindowsMainNativeWorkerJournal(f.options), { code: 'ENOENT' });
  assert.deepEqual(f.calls, ['read']);
});

test('bad secret, reused PID, foreign runtime and stale OS process refuse before journal creation', async () => {
  for (const options of [
    { token: 'e'.repeat(64) }, { pid: 4001 }, { processOk: false },
  ]) {
    const f = fixture(options);
    await assert.rejects(admitWindowsMainNativeWorkerJournal(f.options), /token\/PID|not independently verified/u);
    assert.deepEqual(f.calls, []);
  }
  const f = fixture();
  await assert.rejects(admitWindowsMainNativeWorkerJournal({ ...f.options, workerNodePath: String.raw`C:\Windows\System32\node.exe` }), /product-owned Stable Node/u);
  assert.deepEqual(f.calls, []);
});

test('stable and Main previous-native source mismatches and journal target drift fail closed', async () => {
  const f = fixture({ previous: true });
  assert.equal((await admitWindowsMainNativeWorkerJournal(f.options)).admitted, true);
  const changed = fixture({ journalRecord: { ...f.getStored(), targetRuntimeContractSha256: '0'.repeat(64) } });
  await assert.rejects(admitWindowsMainNativeWorkerJournal(changed.options), /contract drifted/u);
  const wrong = fixture({ previous: true });
  await assert.rejects(admitWindowsMainNativeWorkerJournal({ ...wrong.options, readPointerImpl: async () => ({ sourceSha: B, target: 'win32-x64', runtimeContractSha256: 'a'.repeat(64) }) }), /previous native A identity differs/u);
});


test('WPF-owned worker waits only for the bounded handoff record publication race', async () => {
  const f = fixture();
  let reads = 0, delays = 0;
  const readOriginal = f.options.readWorkerImpl;
  const input = { ...f.options, sleepImpl: async () => { delays++; },
    readWorkerImpl: async (...args) => (++reads < 3 ? { ownership: null } : readOriginal(...args)) };
  assert.equal((await admitWindowsMainNativeWorkerJournal(input)).admitted, true);
  assert.equal(reads, 3);
  assert.equal(delays, 2);
  const unclaimed = fixture();
  await assert.rejects(admitWindowsMainNativeWorkerJournal({
    ...unclaimed.options, ownershipAttempts: 2, sleepImpl: async () => {},
    readWorkerImpl: async () => ({ ownership: null }),
  }), /token\/PID/u);
  assert.deepEqual(unclaimed.calls, []);
});


test('clean-reinstall ownership admission checks OS PID/token/active transaction but creates no Guardian journal', async () => {
  const f = fixture();
  const admitted = await admitWindowsMainNativeWorkerJournal({ ...f.options, ownerOnly: true });
  assert.equal(admitted.admitted, true);
  assert.equal(admitted.ownerOnly, true);
  assert.equal(admitted.ownedNode, NODE);
  assert.equal(admitted.journal, undefined);
  assert.deepEqual(f.calls, []);
  const changed = fixture();
  await assert.rejects(admitWindowsMainNativeWorkerJournal({ ...changed.options, ownerOnly: true,
    engine: { readActive: async () => ({ ...changed.options.receipt, targetSha: A }) },
  }), /lost its exact active transaction/u);
  assert.deepEqual(changed.calls, []);
  const forged = fixture({ token: 'e'.repeat(64) });
  await assert.rejects(admitWindowsMainNativeWorkerJournal({ ...forged.options, ownerOnly: true }), /token\/PID/u);
  assert.deepEqual(forged.calls, []);
});


test('Windows native worker refuses missing validated native helper even with a matching token', async () => {
  const f = fixture();
  await assert.rejects(admitWindowsMainNativeWorkerJournal({ ...f.options, nativeHelperPath: null }), /no validated native identity helper/u);
  assert.deepEqual(f.calls, []);
});

test('existing foreign Windows owner is rejected immediately without retries or journal mutation', async () => {
  const f = fixture({ token: 'f'.repeat(64) });
  let reads = 0, sleeps = 0;
  await assert.rejects(admitWindowsMainNativeWorkerJournal({
    ...f.options, ownershipAttempts: 25,
    readWorkerImpl: async (...args) => { reads++; return f.options.readWorkerImpl(...args); },
    sleepImpl: async () => { sleeps++; },
  }), /token\/PID/u);
  assert.equal(reads, 1, 'a present mismatched owner must not be retried as a publication race');
  assert.equal(sleeps, 0);
  assert.deepEqual(f.calls, [], 'no native journal may be written for a foreign owner');
});

test('uncertain Windows process identity rejects both journal and ownerOnly before native action', async () => {
  for (const ownerOnly of [false, true]) {
    const f = fixture();
    let receiptReads = 0;
    await assert.rejects(admitWindowsMainNativeWorkerJournal({
      ...f.options, ownerOnly,
      engine: { readActive: async () => { receiptReads++; return f.options.receipt; } },
      inspectWorkerImpl: async () => ({ running: true, stale: false, uncertain: true }),
    }), /PID, OS creation timestamp or executable was not independently verified/u);
    assert.equal(receiptReads, 0);
    assert.deepEqual(f.calls, [], 'uncertain birth timestamp cannot get an owned journal');
  }
});

test('full native admission refuses any forged, missing or mismatched signed Guardian owner even with valid worker PID/token/journal',async()=>{
 for(const proof of [null, {originalSignedOwner:false,guardianPid:5,workerPid:1234,
   workerStartTimeUtcTicks:'638958000000000000'},
   {originalSignedOwner:true,guardianPid:5,workerPid:4001,
    workerStartTimeUtcTicks:'638958000000000000'},
   {originalSignedOwner:true,guardianPid:5,workerPid:1234,
    workerStartTimeUtcTicks:'638958000000000001'}]){
  const f=fixture();
  await assert.rejects(admitWindowsMainNativeWorkerJournal({...f.options,
    authenticateSignedGuardianImpl:async()=>proof,
  }),/Original signed Guardian OS owner is not independently admitted/u);
  assert.deepEqual(f.calls,['create','read']);
 }
 const ownerOnly=fixture();
 let attempts=0;
 const value=await admitWindowsMainNativeWorkerJournal({...ownerOnly.options,ownerOnly:true,
  authenticateSignedGuardianImpl:async()=>{attempts++;throw Error('must not start guardian for disabled product path');},
 });
 assert.equal(value.ownerOnly,true);
 assert.equal(attempts,0);
});
