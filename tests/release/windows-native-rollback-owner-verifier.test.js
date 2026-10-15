import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { createEquinoxWindowsNativeRollbackOwnerVerifier } from '../../src/equinox-local-windows-native-rollback-owner-verifier.js';

const tx = `main-${'a'.repeat(32)}`;
const appdata = 'C:\\Users\\test\\AppData\\Local';
const installRoot = path.win32.join(appdata, 'Equinox Local');
const releaseDir = path.win32.join(installRoot, 'releases', '6.0.4');
const installation = { installRoot, releaseDir, managed: true, selfUpdateSupported: true, target: 'win32-x64' };
const owner = { transactionId: tx, stage: 'rollback_started', requiresWriterLease: true,
  guardianPid: 1234, workerPid: 4321, journalSha256: 'c'.repeat(64), restartedJournalSha256: 'd'.repeat(64) };

function mocks({ same = true, exit = 0 } = {}) {
  const calls = [];
  const body = Buffer.alloc(2048, 0x42);
  const different = Buffer.alloc(2048, 0x43);
  const fsImpl = {
    async open(filename) {
      const chosen = filename.endsWith('runtime\\guardian\\EquinoxLocalGuardian.exe') &&
        filename.includes('\\releases\\') && !same ? different : body;
      const stat = { isFile: () => true, isSymbolicLink: () => false,
        ino: 13, dev: 4, size: chosen.length };
      return { stat: async () => stat, readFile: async () => chosen, close: async () => {} };
    },
    async lstat() {
      return { isFile: () => true, isSymbolicLink: () => false, ino: 13, dev: 4, size: body.length };
    },
  };
  const spawnImpl = (exe, args, options) => {
    calls.push({ exe, args, options });
    const child = new EventEmitter();
    child.pid = 5757;
    child.kill = () => {};
    queueMicrotask(() => child.emit('exit', exit, null));
    return child;
  };
  const verify = createEquinoxWindowsNativeRollbackOwnerVerifier({ transactionId: tx, installation,
    platform: 'win32', env: { LOCALAPPDATA: appdata, SystemRoot: 'C:\\Windows', SECRET: 'no' },
    fsImpl, spawnImpl });
  return { verify, calls };
}

test('read-only kernel auditor runs only pinned hash-identical Guardian with one fixed command and no secrets', async () => {
  const f = mocks();
  assert.equal(await f.verify(owner), true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].exe, path.win32.join(installRoot, 'runtime', 'guardian', 'EquinoxLocalGuardian.exe'));
  assert.deepEqual(f.calls[0].args, ['--audit-native-rollback-owner']);
  assert.equal(f.calls[0].options.shell, false);
  assert.equal(f.calls[0].options.detached, false);
  assert.equal(f.calls[0].options.windowsHide, true);
  assert.deepEqual(f.calls[0].options.env, { SystemRoot: 'C:\\Windows' });
});

test('verifier fails closed before OS audit on altered Guardian image, wrong journal stage, worker PID or foreign source', async () => {
  const different = mocks({ same: false });
  assert.equal(await different.verify(owner), false);
  assert.equal(different.calls.length, 0);
  const f = mocks();
  for (const candidate of [
    { ...owner, stage: 'restarted' }, { ...owner, requiresWriterLease: false },
    { ...owner, workerPid: 0 }, { ...owner, guardianPid: -1 },
    { ...owner, journalSha256: 'not-valid' },
    { ...owner, transactionId: `main-${'b'.repeat(32)}` },
  ]) assert.equal(await f.verify(candidate), false);
  assert.equal(f.calls.length, 0);
  const crashed = mocks({ exit: 70 });
  assert.equal(await crashed.verify(owner), false);
});

test('native read-only verifier probes OS kernel pipe server, live SID/logon/session/lease and fresh HMAC', async () => {
  const native = await readFile(new URL('../../native/windows/EquinoxLocal.Guardian/MainNativeRollbackOwnerWitness.cs', import.meta.url), 'utf8');
  const lease = await readFile(new URL('../../native/windows/EquinoxLocal.Guardian/MainNativeJournalLease.cs', import.meta.url), 'utf8');
  const entry = await readFile(new URL('../../native/windows/EquinoxLocal.Guardian/Program.cs', import.meta.url), 'utf8');
  assert.match(lease, /HoldOwnedRollbackOwnerWitness\(owner, root, worker, lease, leaseAge\)/u);
  assert.match(native, /lease\.SafeFileHandle\.IsClosed \|\| lease\.SafeFileHandle\.IsInvalid/u);
  assert.match(native, /GetNamedPipeClientProcessId\(endpoint\.SafePipeHandle, out var pid\)/u);
  assert.match(native, /GetNamedPipeServerProcessId\(pipe\.SafePipeHandle, out var serverPid\)/u);
  assert.match(native, /serverPid != marker\.RootElement\.GetProperty\("guardianPid"\)\.GetInt32\(\)/u);
  assert.match(native, /GetProcessById\(checked\(\(int\)serverPid\)\)/u);
  assert.match(native, /server\.StartTime\.ToUniversalTime\(\)\.Ticks/u);
  assert.match(native, /OpenProcessToken\(server\.Handle, TokenQuery, out var serverToken\)/u);
  assert.match(native, /ReadWindowsLogonAuthenticationId\(serverToken\)/u);
  assert.match(native, /ReadWindowsLogonAuthenticationId\(auditorToken\)/u);
  assert.match(native, /ex\.HResult & 0xffff\) == 32/u);
  assert.match(native, /FixedTimeEquals\(mac\.ComputeHash\(challenge\), response\)/u);
  assert.match(native, /FileMode\.Open, FileAccess\.Read, FileShare\.ReadWrite/u);
  assert.doesNotMatch(native, /FileMode\.CreateNew|File\.Delete|Directory\.Move|Process\.Kill|Registry\.SetValue/u);
  assert.match(entry, /"--audit-native-rollback-owner"/u);
  assert.match(entry, /AuditOwnedRollbackGuardianOsWitness\(\)/u);
});

test('original Guardian demands fresh post-stage5 physical A readiness before any future restore action', async () => {
  const readiness = await readFile(new URL('../../native/windows/EquinoxLocal.Guardian/MainNativeRollbackPhysicalAReadiness.cs', import.meta.url), 'utf8');
  const lease = await readFile(new URL('../../native/windows/EquinoxLocal.Guardian/MainNativeJournalLease.cs', import.meta.url), 'utf8');
  const stage5 = lease.indexOf('AuthorizeOwnedIntegratedARollbackStart(owner, root, worker, leaseAge)');
  const ready = lease.indexOf('RequireOwnedPhysicalARestoreReadiness(owner, root, worker, lease, leaseAge)');
  const witness = lease.indexOf('HoldOwnedRollbackOwnerWitness(owner, root, worker, lease, leaseAge)');
  assert.ok(stage5 >= 0 && stage5 < ready && ready < witness,
    'fresh readiness must run after the original OS owner committed stage5 and before the read-only witness');
  assert.match(readiness, /lease\.SafeFileHandle\.IsClosed \|\| lease\.SafeFileHandle\.IsInvalid/u);
  assert.match(readiness, /leaseAge\.Elapsed >= TimeSpan\.FromMinutes\(20\)/u);
  assert.match(readiness, /InspectOwnedNativeWorkerProcess\(guardianHoldsJournalLease: true\)/u);
  assert.match(readiness, /"rollback_started"/u);
  assert.match(readiness, /stage\.GetProperty\("sequence"\)\.GetInt32\(\) != 5/u);
  assert.match(readiness, /marker\.GetProperty\("guardianPid"\)\.GetInt32\(\) != Environment\.ProcessId/u);
  assert.match(readiness, /CompareNativeTrees\(priorShell, backup\)/u);
  assert.match(readiness, /CompareNativeTrees\(Path\.Combine\(bRelease, "runtime", "shell"\), program\)/u);
  assert.match(readiness, /FindExactRunningWpfOrNull\(Path\.Combine\(program, "EquinoxLocal\.exe"\)\)/u);
  assert.match(readiness, /InspectOwnedMainNativeMessaging\(install, bRelease\)/u);
  assert.match(readiness, /"sourceRoot=" \+ Path\.Combine\(txRoot, "sources", sourceSha\)/u);
  assert.match(readiness, /selected\.GetProperty\("sourceSha"\)\.GetString\(\) != sourceSha/u);
  assert.match(readiness, /FixedTimeEquals\(before, SHA256\.HashData\(File\.ReadAllBytes\(journalPath\)\)\)/u);
  assert.doesNotMatch(readiness, /Directory\.Move|File\.Move|Directory\.Delete|File\.Delete|Process\.Start|Process\.Kill|Registry\.SetValue|WriteIntegratedOwnedNativeStage/u);
});

test('single original Guardian handles owner OS audit and fixed mutual-HMAC physical A action under one live writer lease', async () => {
  const server = await readFile(new URL('../../native/windows/EquinoxLocal.Guardian/MainNativeRollbackPhysicalARestore.cs', import.meta.url), 'utf8');
  const witness = await readFile(new URL('../../native/windows/EquinoxLocal.Guardian/MainNativeRollbackOwnerWitness.cs', import.meta.url), 'utf8');
  const argumentsSource = await readFile(new URL('../../native/windows/EquinoxLocal.Guardian/MainNativeWorkerArguments.cs', import.meta.url), 'utf8');
  assert.match(witness, /new NamedPipeServerStream\("EquinoxLocalMainAB-PhysicalRestore-" \+ owner\.TransactionId/u);
  assert.match(witness, /Task\.WhenAny\(arrival, physicalArrival, exit\)/u);
  assert.match(witness, /ServeOwnedPhysicalARestore\(owner, journalRoot, worker, lease, leaseAge, physical\)/u);
  assert.match(witness, /physical\.Dispose\(\)/u);
  assert.ok(witness.indexOf('physical.Dispose();') > witness.indexOf('ServeOwnedPhysicalARestore(owner, journalRoot, worker, lease, leaseAge, physical);'));
  assert.ok(witness.indexOf('physical.Dispose();') < witness.indexOf('native-integrated-a-physical-restored-original-lease-held'));
  assert.match(witness, /"native-integrated-a-physical-restored-original-lease-held"/u);
  assert.match(witness, /while \(!worker.HasExited && leaseAge.Elapsed < TimeSpan.FromMinutes\(20\)\)/u);
  assert.match(witness, /A identity coordination remains pending/u);
  assert.match(witness, /HoldOwnedRollbackOwnerWitness\(/u);
  assert.match(server, /GetNamedPipeClientProcessId\(endpoint\.SafePipeHandle, out var clientPid\)/u);
  assert.match(server, /clientPid != owner\.Pid/u);
  assert.match(server, /InspectOwnedNativeWorkerProcess\(guardianHoldsJournalLease: true\)/u);
  assert.match(server, /InspectOwnedNativeWorkerOsArguments\(guardianHoldsJournalLease: true\)/u);
  assert.match(argumentsSource, /InspectOwnedNativeWorkerOsArguments\(bool guardianHoldsJournalLease = false\)/u);
  assert.match(server, /RequireOwnedPhysicalARestoreReadiness\(owner, journalRoot, worker, lease, leaseAge\)/u);
  assert.match(server, /lease\.SafeFileHandle\.IsClosed \|\| lease\.SafeFileHandle\.IsInvalid/u);
  assert.match(server, /"equinox-local-guardian-ab-physical-restore-worker-v1:"/u);
  assert.match(server, /"equinox-local-guardian-ab-physical-restore-owner-v1:"/u);
  assert.match(server, /FixedTimeEquals\(expected, response\)/u);
  assert.match(server, /grant\[32\] = \(byte\)'R'/u);
  assert.match(server, /acknowledgment\[0\] != \(byte\)'r'/u);
  assert.match(server, /CompareNativeTrees\(originalA, program\)/u);
  assert.match(server, /CompareNativeTrees\(bShell, failedB\)/u);
  assert.match(server, /endpoint\.WriteByte\(\(byte\)'a'\)/u);
  assert.doesNotMatch(server, /Directory\.Move|File\.Move|Directory\.Delete|File\.Delete|WriteIntegratedOwnedNativeStage|Registry\.SetValue|Process\.Start|Process\.Kill/u);
});
