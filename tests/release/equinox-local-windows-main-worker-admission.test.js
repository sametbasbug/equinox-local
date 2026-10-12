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
    workerToken: TOKEN, workerPid: 1234, workerNodePath: NODE,
    readWorkerImpl: async () => ({ ownership: { transactionId: ID, token, pid, nodePath: NODE, startTimeUtcTicks: '638958000000000000' } }),
    inspectWorkerImpl: async () => processOk ? { running: true, stale: false, uncertain: false } : { running: false, stale: true, uncertain: false },
    readPointerImpl: async () => previous ? { sourceSha: A, target: 'win32-x64', runtimeContractSha256: 'a'.repeat(64) } : Promise.reject(Object.assign(Error('none'), { code: 'ENOENT' })),
    journalFactory: () => journal,
  };
  return { options, journal, calls, getStored: () => stored, previousNative };
}

test('real Windows worker admission binds product Stable Node, PID, secret, receipt and creates journal once', async () => {
  const f = fixture();
  const value = await admitWindowsMainNativeWorkerJournal(f.options);
  assert.equal(value.admitted, true);
  assert.equal(value.journal, f.journal);
  assert.deepEqual(f.calls, ['create', 'read']);
  assert.deepEqual(f.getStored().previousNative, f.previousNative);
  const again = fixture({ journalRecord: f.getStored() });
  assert.equal((await admitWindowsMainNativeWorkerJournal(again.options)).admitted, true);
  assert.deepEqual(again.calls, ['create', 'read']);
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
