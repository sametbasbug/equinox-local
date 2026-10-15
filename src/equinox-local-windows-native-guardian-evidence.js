import { createHash, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { validateEquinoxLocalWindowsNativeTransitionJournal } from './equinox-local-windows-native-transition-journal.js';

const TX = /^main-[a-f0-9]{32}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
// rollback_started/5 is read-only OS evidence, NOT an A-restore grant.
// Prepared-abort rollback_started/1 must never be confused with this stage.
const NATIVE_STAGES = Object.freeze({ native_staged: 1, shell_stopped: 2, switched: 3, restarted: 4, rollback_started: 5 });
const MARKER_KEYS = ['schemaVersion', 'transactionId', 'stage', 'sequence', 'guardianPid', 'journalSha256'].sort().join('\0');

async function readExactNormalFile(file, maxBytes, fsImpl) {
  const fd = await fsImpl.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = await fd.stat();
    if (!before.isFile() || before.size < 2 || before.size > maxBytes) {
      throw new Error('Native Guardian evidence file is not bounded and regular.');
    }
    const linked = await fsImpl.lstat(file);
    if (!linked.isFile() || linked.isSymbolicLink() || linked.dev !== before.dev || linked.ino !== before.ino) {
      throw new Error('Native Guardian evidence path is not the opened OS file.');
    }
    const raw = await fd.readFile();
    if (raw.length !== before.size || raw.length > maxBytes) {
      throw new Error('Native Guardian evidence bytes changed during read.');
    }
    const after = await fd.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) {
      throw new Error('Native Guardian evidence changed during read.');
    }
    const linkedAfter = await fsImpl.lstat(file);
    if (!linkedAfter.isFile() || linkedAfter.isSymbolicLink() || linkedAfter.dev !== before.dev || linkedAfter.ino !== before.ino) {
      throw new Error('Native Guardian evidence path was replaced during read.');
    }
    return raw;
  } finally { await fd.close(); }
}

/**
 * STRICTLY READ-ONLY view of the durable journal+SHA milestone written by the
 * independent OS native Guardian while it holds CREATE_NEW/FileShare.None.
 * Never grants JS permission to write journal stages, mutate WPF or registry.
 * The required caller callback must separately verify the native OS PID,
 * executable, birthtime, SID/session and held lease; a JSON/token isn't proof.
 */
export async function readEquinoxWindowsNativeGuardianMilestone({
  transactionRoot, transactionId, expected, stage, verifyGuardianOsOwner,
  fsImpl = fs, platform = process.platform,
} = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (!['win32', 'test'].includes(platform) || !TX.test(transactionId ?? '') ||
      !Object.hasOwn(NATIVE_STAGES, stage ?? '') ||
      typeof transactionRoot !== 'string' || !p.isAbsolute(transactionRoot) ||
      p.normalize(transactionRoot) !== transactionRoot ||
      typeof verifyGuardianOsOwner !== 'function' || expected?.transactionId !== transactionId ||
      !['win32-x64', 'win32-arm64'].includes(expected?.target) ||
      typeof expected?.receiptStartedAt !== 'string') {
    throw new Error('Native Guardian read-only observer lacks an exact Main identity and OS verifier.');
  }
  const root = p.join(transactionRoot, 'guardian-journal');
  const [rootStat, rootReal] = await Promise.all([fsImpl.lstat(root), fsImpl.realpath(root)]);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() ||
      p.normalize(rootReal).toLowerCase() !== p.normalize(root).toLowerCase()) {
    throw new Error('Native Guardian evidence root is not a canonical normal directory.');
  }
  const journalPath = p.join(root, `${transactionId}.json`);
  const markerPath = p.join(root, `${transactionId}.${stage}.commit.json`);
  const [journalBytes, markerBytes] = await Promise.all([
    readExactNormalFile(journalPath, 8192, fsImpl),
    readExactNormalFile(markerPath, 4096, fsImpl),
  ]);
  let journal, marker;
  try {
    journal = validateEquinoxLocalWindowsNativeTransitionJournal(JSON.parse(journalBytes.toString('utf8')), expected);
    marker = JSON.parse(markerBytes.toString('utf8'));
  } catch { throw new Error('Native Guardian evidence is not an exact validated Main transaction.'); }
  if (journal.stage !== stage || journal.sequence !== NATIVE_STAGES[stage] ||
      !marker || Array.isArray(marker) || typeof marker !== 'object' ||
      Object.keys(marker).sort().join('\0') !== MARKER_KEYS ||
      marker.schemaVersion !== 1 || marker.transactionId !== transactionId ||
      marker.stage !== stage || marker.sequence !== journal.sequence ||
      !Number.isSafeInteger(marker.guardianPid) || marker.guardianPid < 1 ||
      !DIGEST.test(marker.journalSha256 ?? '')) {
    throw new Error('Native Guardian committed milestone is stale or foreign.');
  }
  const digest = createHash('sha256').update(journalBytes).digest();
  if (!timingSafeEqual(digest, Buffer.from(marker.journalSha256, 'hex'))) {
    throw new Error('Native Guardian durable milestone SHA does not match the journal.');
  }
  // The restarted/4 observation must belong to this same OS Guardian and
  // immutable retained Stable A. A forged rollback_started/5 JSON and its
  // matching SHA are NOT sufficient on their own to prove original ancestry.
  let rollbackProof = null;
  if (stage === 'rollback_started') {
    if (journal.previousNative.kind !== 'stable') {
      throw new Error('Native Guardian rollback-start requires original Stable A.');
    }
    const restartedPath = p.join(root, `${transactionId}.restarted.commit.json`);
    const retainedPath = p.join(root, `${transactionId}.retained-a.json`);
    const [restartedBytes, retainedBytes] = await Promise.all([
      readExactNormalFile(restartedPath, 4096, fsImpl),
      readExactNormalFile(retainedPath, 8192, fsImpl),
    ]);
    let restarted, retained;
    try {
      restarted = JSON.parse(restartedBytes.toString('utf8'));
      retained = JSON.parse(retainedBytes.toString('utf8'));
    } catch { throw new Error('Native Guardian rollback-start ancestry is invalid.'); }
    const restartedKeys = ['schemaVersion', 'transactionId', 'stage', 'sequence', 'guardianPid', 'journalSha256'];
    const retainedKeys = ['schemaVersion', 'transactionId', 'disposition', 'stableVersion',
      'workerPid', 'guardianPid', 'journalSequence', 'journalSha256'];
    if (!restarted || Array.isArray(restarted) || typeof restarted !== 'object' ||
        Object.keys(restarted).sort().join('\0') !== restartedKeys.sort().join('\0') ||
        restarted.schemaVersion !== 1 || restarted.transactionId !== transactionId ||
        restarted.stage !== 'restarted' || restarted.sequence !== 4 ||
        restarted.guardianPid !== marker.guardianPid || !DIGEST.test(restarted.journalSha256 ?? '') ||
        !retained || Array.isArray(retained) || typeof retained !== 'object' ||
        Object.keys(retained).sort().join('\0') !== retainedKeys.sort().join('\0') ||
        retained.schemaVersion !== 1 || retained.transactionId !== transactionId ||
        retained.disposition !== 'retained-a-verified-no-restore-authority' ||
        retained.stableVersion !== journal.previousNative.version ||
        !Number.isSafeInteger(retained.workerPid) || retained.workerPid < 1 ||
        retained.guardianPid !== marker.guardianPid || retained.journalSequence !== 4 ||
        retained.journalSha256 !== restarted.journalSha256) {
      throw new Error('Native Guardian rollback-start is not bound to the original restarted B and retained A.');
    }
    rollbackProof = Object.freeze({ restartedPath, retainedPath,
      restartedDigest: createHash('sha256').update(restartedBytes).digest(),
      retainedDigest: createHash('sha256').update(retainedBytes).digest(),
      workerPid: retained.workerPid, restartedJournalSha256: restarted.journalSha256 });
  }
  if (await verifyGuardianOsOwner(Object.freeze({ transactionId, guardianPid: marker.guardianPid,
    journalSha256: marker.journalSha256, stage,
    ...(rollbackProof ? { workerPid: rollbackProof.workerPid,
      restartedJournalSha256: rollbackProof.restartedJournalSha256, requiresWriterLease: true } : {}) })) !== true) {
    throw new Error('Native Guardian live OS owner is not independently verified.');
  }
  // The source journal must still match the hash just admitted. No writes.
  const [latest, latestMarker] = await Promise.all([
    readExactNormalFile(journalPath, 8192, fsImpl),
    readExactNormalFile(markerPath, 4096, fsImpl),
  ]);
  if (latest.length !== journalBytes.length || latestMarker.length !== markerBytes.length ||
      !timingSafeEqual(createHash('sha256').update(latest).digest(), digest) ||
      !timingSafeEqual(createHash('sha256').update(latestMarker).digest(), createHash('sha256').update(markerBytes).digest())) {
    throw new Error('Native Guardian journal or milestone changed after OS ownership attestation.');
  }
  if (rollbackProof) {
    const [restartNow, retainedNow] = await Promise.all([
      readExactNormalFile(rollbackProof.restartedPath, 4096, fsImpl),
      readExactNormalFile(rollbackProof.retainedPath, 8192, fsImpl),
    ]);
    if (!timingSafeEqual(createHash('sha256').update(restartNow).digest(), rollbackProof.restartedDigest) ||
        !timingSafeEqual(createHash('sha256').update(retainedNow).digest(), rollbackProof.retainedDigest)) {
      throw new Error('Native Guardian rollback ancestry changed after OS ownership attestation.');
    }
  }
  return Object.freeze({ transactionId, target: journal.target, stage, sequence: journal.sequence,
    sourceSha: journal.targetSha, guardianPid: marker.guardianPid, journalSha256: marker.journalSha256 });
}
