import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { requestEquinoxLocalGuardianOwnedARollbackStart } from '../../src/equinox-local-windows-native-ab-rollback-client.js';

const appdata = 'C:\\Users\\fixture\\AppData\\Local';
const transactionRoot = path.win32.join(appdata, 'Equinox Local', 'state', 'main-update');
const transactionId = `main-${'6'.repeat(32)}`;
const workerToken = 'e'.repeat(64);
const sourceSha = 'b'.repeat(40);
const journalPath = path.win32.join(transactionRoot, 'guardian-journal', `${transactionId}.json`);
const proofPath = path.win32.join(transactionRoot, 'guardian-journal', `${transactionId}.retained-a.json`);
const started = { schemaVersion: 1, transactionId, stage: 'restarted', sequence: 4,
  targetSha: sourceSha, previousNative: { kind: 'stable', version: '6.0.4' } };
const options = { transactionId, transactionRoot, sourceSha, workerToken, platform: 'win32',
  env: { LOCALAPPDATA: appdata } };

function fixture({ stage = 'restarted', proofHash = null, ack = true, durable = true, challenge = Buffer.alloc(32, 0x42) } = {}) {
  const journal = { ...started, stage, sequence: stage === 'restarted' ? 4 : 5 };
  const journalBytes = Buffer.from(JSON.stringify(journal));
  const exactDigest = createHash('sha256').update(journalBytes).digest('hex');
  const proof = { schemaVersion: 1, transactionId,
    disposition: 'retained-a-verified-no-restore-authority', stableVersion: '6.0.4',
    journalSequence: 4, journalSha256: proofHash ?? exactDigest };
  const memory = new Map([[journalPath, journalBytes], [proofPath, Buffer.from(JSON.stringify(proof))]]);
  let count = 0;
  const fsImpl = { readFile: async (name) => {
    assert.ok(memory.has(name), `Unexpected Windows journal path ${name}`);
    return memory.get(name);
  } };
  function connect(endpoint) {
    count++;
    assert.equal(endpoint, `\\\\.\\pipe\\EquinoxLocalMainAB-Rollback-${transactionId}`);
    const stream = new EventEmitter();
    stream.setTimeout = () => stream;
    stream.destroy = (err) => queueMicrotask(() => stream.emit('error', err));
    stream.write = (proofBytes) => {
      const expected = createHmac('sha256', Buffer.from(workerToken, 'hex'))
        .update('equinox-local-guardian-ab-rollback-start-v1:', 'ascii')
        .update(challenge).update(Buffer.from(exactDigest, 'hex')).digest();
      assert.ok(proofBytes.equals(expected), 'The worker must HMAC the unique OS nonce plus exact restarted/4 journal SHA');
      if (durable) memory.set(journalPath, Buffer.from(JSON.stringify({ ...journal, stage: 'rollback_started', sequence: 5 })));
      queueMicrotask(() => {
        if (ack) stream.emit('data', Buffer.from('r'));
        stream.emit('end');
      });
    };
    queueMicrotask(() => stream.emit('data', challenge));
    return stream;
  }
  return { fsImpl, connect, get connects() { return count; } };
}

test('rollback-start refuses foreign OS, transaction root, token, journal and retained-A receipt before pipe connection', async () => {
  const valid = fixture();
  await assert.rejects(requestEquinoxLocalGuardianOwnedARollbackStart({ ...options, platform: 'darwin', ...valid }), /exact Windows worker/u);
  await assert.rejects(requestEquinoxLocalGuardianOwnedARollbackStart({ ...options, transactionRoot: 'C:\\Other', ...valid }), /canonical Main transaction root/u);
  await assert.rejects(requestEquinoxLocalGuardianOwnedARollbackStart({ ...options, workerToken: 'not-a-token', ...valid }), /exact Windows worker/u);
  const stale = fixture({ stage: 'rollback_started' });
  await assert.rejects(requestEquinoxLocalGuardianOwnedARollbackStart({ ...options, ...stale }), /exact Guardian-restarted B/u);
  const altered = fixture({ proofHash: 'f'.repeat(64) });
  await assert.rejects(requestEquinoxLocalGuardianOwnedARollbackStart({ ...options, ...altered }), /retained Stable A proof/u);
  assert.equal(valid.connects + stale.connects + altered.connects, 0, 'Unauthorized input never reaches a Guardian pipe');
});

test('rollback-start binds exact worker token to fresh nonce/journal SHA and waits for OS durable rollback_started/5', async () => {
  const verified = fixture();
  assert.deepEqual(await requestEquinoxLocalGuardianOwnedARollbackStart({ ...options, ...verified }),
    { transactionId, sourceSha, journalStage: 'rollback_started' });
  assert.equal(verified.connects, 1);
  await assert.rejects(requestEquinoxLocalGuardianOwnedARollbackStart({ ...options, ...fixture({ ack: false }) }),
    /Guardian did not persist rollback-start before disconnect/u);
  await assert.rejects(requestEquinoxLocalGuardianOwnedARollbackStart({ ...options, ...fixture({ durable: false }) }),
    /did not durably authorize exact rollback_started/u);
});

test('independent Guardian rollback-start admission is OS-owned, transaction-specific, and does not restore A yet', async () => {
  const native = await readFile(new URL('../../native/windows/EquinoxLocal.Guardian/MainNativeIntegratedABRollbackAdmission.cs', import.meta.url), 'utf8');
  const journal = await readFile(new URL('../../native/windows/EquinoxLocal.Guardian/MainNativeIntegratedABSupervisor.cs', import.meta.url), 'utf8');
  const rejection = await readFile(new URL('../../native/windows/EquinoxLocal.Guardian/MainNativeIntegratedABHealthRejection.cs', import.meta.url), 'utf8');
  const client = await readFile(new URL('../../src/equinox-local-windows-native-ab-rollback-client.js', import.meta.url), 'utf8');
  assert.match(native, /private static void AuthorizeOwnedIntegratedARollbackStart\(/u);
  assert.match(native, /InspectOwnedNativeWorkerProcess\(guardianHoldsJournalLease: true\)/u);
  assert.match(native, /GetNamedPipeClientProcessId\(endpoint\.SafePipeHandle/u);
  assert.match(native, /clientPid|pid != owner\.Pid/u);
  assert.match(native, /CryptographicOperations\.FixedTimeEquals\(expected, response\)/u);
  assert.match(native, /"restarted", 4, "rollback_started", 5/u);
  assert.match(native, /CompareNativeTrees\(aShell, backup\)/u);
  assert.match(native, /CompareNativeTrees\(Path\.Combine\(bRelease, "runtime", "shell"\), program\)/u);
  assert.match(native, /InspectOwnedMainNativeMessaging\(install, bRelease\)/u);
  assert.match(native, /RequireOwnedIntegratedBExitedAndUnhealthy\(owner, journalRoot, worker, targetSha\)/u);
  assert.match(rejection, /private static void RequireOwnedIntegratedBExitedAndUnhealthy\(/u);
  assert.match(rejection, /owner\.TransactionId \+ "\.wpf-b-restarted\.json"/u);
  assert.match(rejection, /shellPid = prior\.GetProperty\("shellPid"\)\.GetInt32\(\)/u);
  assert.match(rejection, /candidate\.StartTime\.ToUniversalTime\(\)\.Ticks != shellStartTicks/u);
  assert.match(rejection, /FindExactRunningWpfOrNull\(executable\)/u);
  assert.match(rejection, /UseProxy = false, AllowAutoRedirect = false/u);
  assert.match(rejection, /127\.0\.0\.1:24891\/api\/v1\/status/u);
  assert.match(rejection, /for \(var sample = 0; sample < 4; sample\+\+\)/u);
  assert.match(rejection, /new CancellationTokenSource\(TimeSpan\.FromMilliseconds\(1500\)\)/u);
  assert.match(rejection, /var bytes = new byte\[8193\]/u);
  assert.match(rejection, /health\.TryGetProperty\("state", out var state\) && state\.GetString\(\) == "HEALTHY"/u);
  assert.match(rejection, /Native rollback refuses an independently healthy B backend/u);
  assert.match(rejection, /originalJournalSha, SHA256\.HashData\(File\.ReadAllBytes\(journalPath\)\)/u);
  assert.doesNotMatch(rejection, /File\.Move|Directory\.Move|File\.Delete|Directory\.Delete|Process\.Kill/u);
  assert.match(native, /"sourceRoot=" \+ Path\.Combine\(txRoot, "sources", targetSha\)/u);
  assert.match(native, /selected\.GetProperty\("sourceSha"\)\.GetString\(\) != targetSha/u);
  assert.match(native, /selected\.GetProperty\("runtimeContractSha256"\)\.GetString\(\) !=/u);
  assert.match(journal, /from == "restarted" && originalSequence == 4 && to == "rollback_started" && nextSequence == 5/u);
  assert.match(client, /equinox-local-guardian-ab-rollback-start-v1:/u);
  assert.doesNotMatch(native, /Directory\.Move|File\.Move|Registry\.SetValue|Process\.Start|Process\.Kill|File\.Delete|Directory\.Delete/u);
  // Not wired to the live happy-path until independent rollback and A health
  // approval exists; no accidental B→A transition during healthy B startup.
  assert.doesNotMatch(journal, /AuthorizeOwnedIntegratedARollbackStart\(owner, journalRoot, worker\)/u);
});
