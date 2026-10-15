import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readEquinoxWindowsNativeGuardianMilestone } from '../../src/equinox-local-windows-native-guardian-evidence.js';

const ID = `main-${'7'.repeat(32)}`;
const A = 'a'.repeat(40), B = 'b'.repeat(40);
const expected = { transactionId: ID, target: 'win32-x64', currentSha: A,
  targetSha: B, receiptStartedAt: '2026-10-12T16:00:00.000Z' };

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'equinox-native-guardian-evidence-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'guardian-journal');
  await fs.mkdir(dir);
  const journalPath = path.join(dir, `${ID}.json`);
  const markerPath = path.join(dir, `${ID}.switched.commit.json`);
  const journal = { schemaVersion: 1, channel: 'main', ...expected,
    previousNative: { kind: 'stable', version: '6.0.4' },
    targetRuntimeContractSha256: 'c'.repeat(64),
    stage: 'switched', sequence: 3,
    createdAt: '2026-10-12T16:00:00.000Z', updatedAt: '2026-10-12T16:00:02.000Z' };
  async function persist(record = journal, details = {}) {
    const bytes = Buffer.from(JSON.stringify(record));
    await fs.writeFile(journalPath, bytes);
    await fs.writeFile(markerPath, JSON.stringify({ schemaVersion: 1, transactionId: ID,
      stage: 'switched', sequence: 3, guardianPid: 4567,
      journalSha256: createHash('sha256').update(bytes).digest('hex'), ...details }));
  }
  await persist();
  const options = { transactionRoot: root, transactionId: ID, expected, stage: 'switched',
    verifyGuardianOsOwner: async (owner) => owner.guardianPid === 4567, platform: 'test' };
  return { options, persist, journal, journalPath, markerPath };
}

test('read-only Guardian milestone matches exact native durable journal SHA and independent OS owner', async (t) => {
  const f = await fixture(t);
  const result = await readEquinoxWindowsNativeGuardianMilestone(f.options);
  assert.deepEqual(result, { transactionId: ID, target: 'win32-x64', stage: 'switched', sequence: 3,
    sourceSha: B, guardianPid: 4567,
    journalSha256: createHash('sha256').update(await fs.readFile(f.journalPath)).digest('hex') });
  assert.equal((await fs.readFile(f.journalPath)).toString(), JSON.stringify(f.journal));
});

test('observer refuses spoofed Guardian PID, foreign Main identities and unauthenticated OS owner', async (t) => {
  const f = await fixture(t);
  await assert.rejects(readEquinoxWindowsNativeGuardianMilestone({ ...f.options,
    verifyGuardianOsOwner: async () => false }), /OS owner/u);
  await assert.rejects(readEquinoxWindowsNativeGuardianMilestone({ ...f.options,
    expected: { ...expected, targetSha: A } }), /exact validated Main transaction/u);
  await f.persist(f.journal, { guardianPid: 0 });
  await assert.rejects(readEquinoxWindowsNativeGuardianMilestone(f.options), /stale or foreign/u);
  await f.persist(f.journal, { unexpected: true });
  await assert.rejects(readEquinoxWindowsNativeGuardianMilestone(f.options), /stale or foreign/u);
});

test('observer denies journal tampering and mismatched native milestone generation', async (t) => {
  const f = await fixture(t);
  await f.persist(f.journal, { journalSha256: 'e'.repeat(64) });
  await assert.rejects(readEquinoxWindowsNativeGuardianMilestone(f.options), /milestone SHA/u);
  await f.persist({ ...f.journal, stage: 'restarted', sequence: 4 });
  await assert.rejects(readEquinoxWindowsNativeGuardianMilestone(f.options), /stale or foreign/u);
  await f.persist(f.journal, { sequence: 4 });
  await assert.rejects(readEquinoxWindowsNativeGuardianMilestone(f.options), /stale or foreign/u);
});

test('observer rejects symlink evidence and noncanonical or missing owner validation', async (t) => {
  const f = await fixture(t);
  await assert.rejects(readEquinoxWindowsNativeGuardianMilestone({ ...f.options,
    verifyGuardianOsOwner: null }), /OS verifier/u);
  await assert.rejects(readEquinoxWindowsNativeGuardianMilestone({ ...f.options,
    transactionId: `main-${'9'.repeat(32)}` }), /OS verifier/u);
  const shadow = f.markerPath + '.shadow';
  await fs.rename(f.markerPath, shadow);
  await fs.symlink(shadow, f.markerPath);
  await assert.rejects(readEquinoxWindowsNativeGuardianMilestone(f.options), /normal|opened OS file|ELOOP|symlink/iu);
});

test('observer denies a journal changed while independently checking Guardian OS identity', async (t) => {
  const f = await fixture(t);
  await assert.rejects(readEquinoxWindowsNativeGuardianMilestone({ ...f.options,
    verifyGuardianOsOwner: async () => {
      await fs.writeFile(f.journalPath, JSON.stringify({ ...f.journal, updatedAt: '2026-10-12T16:00:03.000Z' }));
      return true;
    } }), /changed after OS ownership/u);
});

test('observer refuses an alternate symlinked Guardian journal root', async (t) => {
  const f = await fixture(t);
  const rootAlias = f.options.transactionRoot + '-alias';
  await fs.symlink(f.options.transactionRoot, rootAlias);
  t.after(() => fs.unlink(rootAlias));
  await assert.rejects(readEquinoxWindowsNativeGuardianMilestone({ ...f.options,
    transactionRoot: rootAlias }), /canonical normal directory/u);
});

test('observer detects a milestone receipt replaced during independent OS owner proof', async (t) => {
  const f = await fixture(t);
  await assert.rejects(readEquinoxWindowsNativeGuardianMilestone({ ...f.options,
    verifyGuardianOsOwner: async () => {
      const body = JSON.parse(await fs.readFile(f.markerPath, 'utf8'));
      await fs.writeFile(f.markerPath, JSON.stringify({ ...body, guardianPid: 8001 }));
      return true;
    } }), /changed after OS ownership/u);
});

async function rollbackStartedFixture(t) {
  const f = await fixture(t);
  const dir = path.dirname(f.journalPath);
  const restartedPath = path.join(dir, `${ID}.restarted.commit.json`);
  const retainedPath = path.join(dir, `${ID}.retained-a.json`);
  const rollbackPath = path.join(dir, `${ID}.rollback_started.commit.json`);
  const restarted = { ...f.journal, stage: 'restarted', sequence: 4 };
  const restartedSha = createHash('sha256').update(Buffer.from(JSON.stringify(restarted))).digest('hex');
  const previousMarker = { schemaVersion: 1, transactionId: ID, stage: 'restarted', sequence: 4,
    guardianPid: 4567, journalSha256: restartedSha };
  const retained = { schemaVersion: 1, transactionId: ID,
    disposition: 'retained-a-verified-no-restore-authority', stableVersion: '6.0.4',
    workerPid: 3281, guardianPid: 4567, journalSequence: 4, journalSha256: restartedSha };
  const current = { ...f.journal, stage: 'rollback_started', sequence: 5,
    updatedAt: '2026-10-12T16:00:03.000Z' };
  async function persist(record = current, marker = {}) {
    const bytes = Buffer.from(JSON.stringify(record));
    await fs.writeFile(f.journalPath, bytes);
    await fs.writeFile(rollbackPath, JSON.stringify({ schemaVersion: 1, transactionId: ID,
      stage: 'rollback_started', sequence: 5, guardianPid: 4567,
      journalSha256: createHash('sha256').update(bytes).digest('hex'), ...marker }));
  }
  await fs.writeFile(restartedPath, JSON.stringify(previousMarker));
  await fs.writeFile(retainedPath, JSON.stringify(retained));
  await persist();
  return { ...f, options: { ...f.options, stage: 'rollback_started' }, current,
    persist, restartedPath, retainedPath, rollbackPath, restartedSha, previousMarker, retained };
}

test('read-only rollback_started/5 observes OS-owned exact B journal, original worker and retained Stable A ancestry', async (t) => {
  const f = await rollbackStartedFixture(t);
  let verification = null;
  const first = await Promise.all([f.journalPath, f.rollbackPath, f.restartedPath, f.retainedPath].map(p => fs.readFile(p)));
  const result = await readEquinoxWindowsNativeGuardianMilestone({ ...f.options,
    verifyGuardianOsOwner: async (owner) => { verification = owner; return owner.guardianPid === 4567 &&
      owner.workerPid === 3281 && owner.requiresWriterLease === true &&
      owner.restartedJournalSha256 === f.restartedSha && owner.stage === 'rollback_started'; } });
  assert.deepEqual(result, { transactionId: ID, target: 'win32-x64', stage: 'rollback_started', sequence: 5,
    sourceSha: B, guardianPid: 4567,
    journalSha256: createHash('sha256').update(first[0]).digest('hex') });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(verification));
  assert.deepEqual(verification, { transactionId: ID, guardianPid: 4567,
    journalSha256: result.journalSha256, stage: 'rollback_started', workerPid: 3281,
    restartedJournalSha256: f.restartedSha, requiresWriterLease: true });
  const last = await Promise.all([f.journalPath, f.rollbackPath, f.restartedPath, f.retainedPath].map(p => fs.readFile(p)));
  assert.deepEqual(last, first, 'OS rollback observation is strictly read-only');
});

test('rollback_started/5 never accepts prepared-abort rollback_started/1 or a forged terminal sequence', async (t) => {
  const f = await rollbackStartedFixture(t);
  await f.persist({ ...f.current, sequence: 1 }, { sequence: 1 });
  await assert.rejects(readEquinoxWindowsNativeGuardianMilestone(f.options), /stale or foreign/u);
  await f.persist({ ...f.current, sequence: 6 }, { sequence: 6 });
  await assert.rejects(readEquinoxWindowsNativeGuardianMilestone(f.options), /stale or foreign/u);
});

test('rollback_started/5 denies spoofed B journal, original Guardian, worker and retained A proof', async (t) => {
  const f = await rollbackStartedFixture(t);
  await assert.rejects(readEquinoxWindowsNativeGuardianMilestone({ ...f.options,
    verifyGuardianOsOwner: async () => false }), /OS owner/u);
  await f.persist(f.current, { guardianPid: 7 });
  await assert.rejects(readEquinoxWindowsNativeGuardianMilestone(f.options), /original restarted B and retained A/u);
  await f.persist();
  await fs.writeFile(f.retainedPath, JSON.stringify({ ...f.retained, workerPid: 0 }));
  await assert.rejects(readEquinoxWindowsNativeGuardianMilestone(f.options), /original restarted B and retained A/u);
  await fs.writeFile(f.retainedPath, JSON.stringify({ ...f.retained, stableVersion: '6.0.5' }));
  await assert.rejects(readEquinoxWindowsNativeGuardianMilestone(f.options), /original restarted B and retained A/u);
  await fs.writeFile(f.retainedPath, JSON.stringify({ ...f.retained, journalSha256: 'f'.repeat(64) }));
  await assert.rejects(readEquinoxWindowsNativeGuardianMilestone(f.options), /original restarted B and retained A/u);
  await fs.writeFile(f.retainedPath, JSON.stringify(f.retained));
  await fs.writeFile(f.restartedPath, JSON.stringify({ ...f.previousMarker, guardianPid: 70 }));
  await assert.rejects(readEquinoxWindowsNativeGuardianMilestone(f.options), /original restarted B and retained A/u);
});

test('rollback_started/5 denies missing or symlinked ancestry, and any ancestry mutation during OS attestation', async (t) => {
  const f = await rollbackStartedFixture(t);
  const original = await fs.readFile(f.retainedPath);
  await fs.unlink(f.retainedPath);
  await assert.rejects(readEquinoxWindowsNativeGuardianMilestone(f.options));
  await fs.symlink(f.restartedPath, f.retainedPath);
  await assert.rejects(readEquinoxWindowsNativeGuardianMilestone(f.options), /normal|opened OS file|ELOOP|symlink/iu);
  await fs.unlink(f.retainedPath);
  await fs.writeFile(f.retainedPath, original);
  await assert.rejects(readEquinoxWindowsNativeGuardianMilestone({ ...f.options,
    verifyGuardianOsOwner: async () => {
      await fs.writeFile(f.retainedPath, JSON.stringify({ ...f.retained, guardianPid: 5001 }));
      return true;
    } }), /rollback ancestry changed after OS ownership/u);
  await fs.writeFile(f.retainedPath, original);
  await assert.rejects(readEquinoxWindowsNativeGuardianMilestone({ ...f.options,
    verifyGuardianOsOwner: async () => {
      await fs.writeFile(f.restartedPath, JSON.stringify({ ...f.previousMarker, guardianPid: 6001 }));
      return true;
    } }), /rollback ancestry changed after OS ownership/u);
});

test('rollback_started/5 denies foreign transaction source identity before even contacting OS verifier', async (t) => {
  const f = await rollbackStartedFixture(t);
  let calls = 0;
  await assert.rejects(readEquinoxWindowsNativeGuardianMilestone({ ...f.options,
    expected: { ...expected, targetSha: '1'.repeat(40) },
    verifyGuardianOsOwner: async () => { calls++; return true; } }), /exact validated Main transaction/u);
  assert.equal(calls, 0);
});
