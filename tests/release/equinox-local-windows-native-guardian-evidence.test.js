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
