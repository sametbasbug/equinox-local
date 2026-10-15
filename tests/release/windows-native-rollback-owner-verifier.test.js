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
  assert.match(witness, /ServeOwnedStableAIdentitySelection\(owner, journalRoot, worker, lease, leaseAge, identityPipe\)/u);
  assert.match(witness, /while \(!worker.HasExited && leaseAge.Elapsed < TimeSpan.FromMinutes\(20\)\)/u);
  assert.match(witness, /native A restored at stage6; WPF A health and terminal rollback remain pending/u);
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

test('original Guardian post-physical A selection readiness binds OS lease, restored A, B quarantine and still-selected B pointers without mutation', async () => {
  const readiness = await readFile(new URL('../../native/windows/EquinoxLocal.Guardian/MainNativeRestoredASelectionReadiness.cs', import.meta.url), 'utf8');
  const physical = await readFile(new URL('../../native/windows/EquinoxLocal.Guardian/MainNativeRollbackPhysicalARestore.cs', import.meta.url), 'utf8');
  const afterPhysical = physical.indexOf('CompareNativeTrees(bShell, failedB)');
  const ready = physical.indexOf('RequireOwnedRestoredASelectionReadiness(owner, journalRoot, worker, lease, leaseAge)');
  const acknowledge = physical.indexOf("endpoint.WriteByte((byte)'a')");
  assert.ok(afterPhysical >= 0 && afterPhysical < ready && ready < acknowledge,
    'original Guardian must reject identity drift after physical rename and before ACK');
  assert.match(readiness, /lease\.SafeFileHandle\.IsClosed \|\| lease\.SafeFileHandle\.IsInvalid/u);
  assert.match(readiness, /leaseAge\.Elapsed >= TimeSpan\.FromMinutes\(20\)/u);
  assert.match(readiness, /InspectOwnedNativeWorkerProcess\(guardianHoldsJournalLease: true\)/u);
  assert.match(readiness, /CryptographicOperations\.ZeroMemory\(left\)/u);
  assert.match(readiness, /"rollback_started"/u);
  assert.match(readiness, /GetProperty\("sequence"\)\.GetInt32\(\) != 5/u);
  assert.match(readiness, /marker\.RootElement\.GetProperty\("guardianPid"\)\.GetInt32\(\) != Environment\.ProcessId/u);
  assert.match(readiness, /CompareNativeTrees\(Path\.Combine\(stable, "runtime", "shell"\), active\)/u);
  assert.match(readiness, /CompareNativeTrees\(Path\.Combine\(bRelease, "runtime", "shell"\), quarantine\)/u);
  assert.match(readiness, /Directory\.Exists\(backup\) \|\| File\.Exists\(backup\)/u);
  assert.match(readiness, /FindExactRunningWpfOrNull\(Path\.Combine\(active, "EquinoxLocal\.exe"\)\)/u);
  assert.match(readiness, /RequireNormalDirectory\(Path\.Combine\(txRoot, "sources", sourceA\)\)/u);
  assert.match(readiness, /stablePointer\.RootElement\.GetProperty\("version"\)\.GetString\(\) != version/u);
  assert.match(readiness, /InspectOwnedMainNativeMessaging\(install, bRelease\)/u);
  assert.match(readiness, /"sourceRoot=" \+ Path\.Combine\(txRoot, "sources", sourceB\)/u);
  assert.match(readiness, /selected\.GetProperty\("sourceSha"\)\.GetString\(\) != sourceB/u);
  assert.match(readiness, /FixedTimeEquals\(before, SHA256\.HashData\(File\.ReadAllBytes\(journalPath\)\)\)/u);
  assert.doesNotMatch(readiness, /Directory\.Move|File\.Move|Directory\.Delete|File\.Delete|WriteIntegratedOwnedNativeStage|Registry\.SetValue|Process\.Start|Process\.Kill/u);
});

test('independent original Guardian A identity witness requires all exact A pointers and quarantined B before future stage6', async () => {
  const native = await readFile(new URL('../../native/windows/EquinoxLocal.Guardian/MainNativeRestoredAIdentityWitness.cs', import.meta.url), 'utf8');
  assert.match(native, /lease\.SafeFileHandle\.IsClosed \|\| lease\.SafeFileHandle\.IsInvalid/u);
  assert.match(native, /leaseAge\.Elapsed >= TimeSpan\.FromMinutes\(20\)/u);
  assert.match(native, /InspectOwnedNativeWorkerProcess\(guardianHoldsJournalLease: true\)/u);
  assert.match(native, /"rollback_started"/u);
  assert.match(native, /requireDurableStage6 \? "rollback_native_restored" : "rollback_started"/u);
  assert.match(native, /requireDurableStage6 \? 6 : 5/u);
  assert.match(native, /GetProperty\("sequence"\)\.GetInt32\(\) != expectedSequence/u);
  assert.match(native, /marker\.RootElement\.GetProperty\("guardianPid"\)\.GetInt32\(\) != Environment\.ProcessId/u);
  assert.match(native, /CompareNativeTrees\(Path\.Combine\(stable, "runtime", "shell"\), program\)/u);
  assert.match(native, /CompareNativeTrees\(Path\.Combine\(bRelease, "runtime", "shell"\), failedB\)/u);
  assert.match(native, /stablePointer\.RootElement\.GetProperty\("version"\)\.GetString\(\) != stableVersion/u);
  assert.match(native, /InspectOwnedMainNativeMessaging\(install, stable\)/u);
  assert.match(native, /"sourceRoot=" \+ Path\.Combine\(txRoot, "sources", aSha\)/u);
  assert.match(native, /Directory\.EnumerateFileSystemEntries\(txRoot, "current-native\.json", SearchOption\.TopDirectoryOnly\)\.Any\(\)/u);
  assert.match(native, /FixedTimeEquals\(journalSha, SHA256\.HashData\(File\.ReadAllBytes\(journalPath\)\)\)/u);
  assert.doesNotMatch(native, /Directory\.Move|File\.Move|Directory\.Delete|File\.Delete|Registry\.SetValue|WriteIntegratedOwnedNativeStage|Process\.Start|Process\.Kill/u);
});


test('only original Guardian can open one fixed Stable-A selection action after physical restoration and rehash A before acknowledgement', async () => {
  const server = await readFile(new URL('../../native/windows/EquinoxLocal.Guardian/MainNativeStableAIdentitySelection.cs', import.meta.url), 'utf8');
  const loop = await readFile(new URL('../../native/windows/EquinoxLocal.Guardian/MainNativeRollbackOwnerWitness.cs', import.meta.url), 'utf8');
  assert.match(loop, /new NamedPipeServerStream\("EquinoxLocalMainAB-SelectStableA-" \+ owner\.TransactionId/u);
  assert.ok(loop.indexOf('ServeOwnedPhysicalARestore(owner, journalRoot, worker, lease, leaseAge, physical);') < loop.indexOf('ServeOwnedStableAIdentitySelection(owner, journalRoot, worker, lease, leaseAge, identityPipe);'));
  assert.match(server, /GetNamedPipeClientProcessId\(pipe\.SafePipeHandle, out var peerPid\)/u);
  assert.match(server, /peerPid != owner\.Pid/u);
  assert.match(server, /InspectOwnedNativeWorkerOsArguments\(guardianHoldsJournalLease: true\)/u);
  assert.match(server, /RequireOwnedRestoredASelectionReadiness\(owner, journalRoot, worker, lease, leaseAge\)/u);
  assert.match(server, /FixedTimeEquals\(workerMac, reply\)/u);
  assert.match(server, /"equinox-local-guardian-ab-select-stable-a-worker-v1:"/u);
  assert.match(server, /"equinox-local-guardian-ab-select-stable-a-owner-v1:"/u);
  assert.match(server, /fixedGrant\[32\] = \(byte\)'S'/u);
  assert.match(server, /ack\[0\] != \(byte\)'s'/u);
  assert.match(server, /RequireOwnedRestoredAIdentityWitness\(owner, journalRoot, worker, lease, leaseAge\)/u);
  assert.ok(server.indexOf('RequireOwnedRestoredAIdentityWitness(owner, journalRoot, worker, lease, leaseAge)') < server.indexOf("pipe.WriteByte((byte)'a')"));
  assert.match(server, /WriteIntegratedOwnedNativeStage\(owner, journalPath,/u);
  assert.match(server, /"rollback_started", 5, "rollback_native_restored", 6/u);
  assert.match(server, /commit\.RootElement\.GetProperty\("guardianPid"\)\.GetInt32\(\) != Environment\.ProcessId/u);
  assert.match(server, /native-integrated-a-restored-stage6-no-health/u);
  assert.doesNotMatch(server, /Registry\.SetValue|Directory\.Move|File\.Move|Process\.Start|File\.Delete/u);
});

test('original Guardian A relaunch requires stage6 SHA OS lease and one fixed mutual-HMAC L before WPF PID/birth attestation', async () => {
  const native = await readFile(new URL('../../native/windows/EquinoxLocal.Guardian/MainNativeRestoredAWpfRestart.cs', import.meta.url), 'utf8');
  const witness = await readFile(new URL('../../native/windows/EquinoxLocal.Guardian/MainNativeRollbackOwnerWitness.cs', import.meta.url), 'utf8');
  const selected = await readFile(new URL('../../native/windows/EquinoxLocal.Guardian/MainNativeRestoredAIdentityWitness.cs', import.meta.url), 'utf8');
  assert.match(witness,/new NamedPipeServerStream\("EquinoxLocalMainAB-RelaunchStableA-" \+ owner\.TransactionId/u);
  assert.ok(witness.indexOf('ServeOwnedStableAIdentitySelection(owner, journalRoot, worker, lease, leaseAge, identityPipe);') < witness.indexOf('RestartOwnedRestoredAWpf(owner, journalRoot, worker, lease, leaseAge, relaunchPipe);'));
  assert.match(native,/GetNamedPipeClientProcessId\(pipe\.SafePipeHandle, out var peerPid\)/u);
  assert.match(native,/peerPid != owner\.Pid/u);
  assert.match(native,/InspectOwnedNativeWorkerOsArguments\(guardianHoldsJournalLease: true\)/u);
  assert.match(native,/RequireOwnedRestoredAIdentityWitness\(owner, journalRoot, worker, lease, leaseAge, requireDurableStage6: true\)/u);
  assert.match(native,/RestoredARestartWorkerDomain = "equinox-local-guardian-ab-relaunch-a-worker-v1:"/u);
  assert.match(native,/RestoredARestartOwnerDomain = "equinox-local-guardian-ab-relaunch-a-owner-v1:"/u);
  assert.match(native,/FixedTimeEquals\(expected, response\)/u);
  assert.match(native,/fixedGrant\[32\] = \(byte\)'L'/u);
  assert.match(native,/grantAcknowledgement\[0\] != \(byte\)'l'/u);
  assert.match(native,/using var shell = Launch\(executable, null\)/u);
  assert.match(native,/GetNamedPipeServerProcessId\(wpfPipe\.SafePipeHandle, out var serverPid\)/u);
  assert.match(native,/serverPid != shell\.Id/u);
  assert.match(native,/ReadWindowsLogonAuthenticationId\(shellToken\)/u);
  assert.match(native,/ReadWindowsLogonAuthenticationId\(originalIdentity\.AccessToken\)/u);
  assert.match(native,/\.wpf-a-restarted\.json/u);
  assert.match(native,/writer\.WriteString\("stage6JournalSha256", Convert\.ToHexStringLower\(before\)\)/u);
  assert.match(native,/fd\.Flush\(flushToDisk: true\)/u);
  assert.match(native,/native-integrated-a-relaunched-stage6-await-four-health/u);
  assert.doesNotMatch(native,/WriteIntegratedOwnedNativeStage|Registry\.SetValue|Directory\.Move|File\.Move|Process\.Kill/u);
  assert.match(selected,/requireDurableStage6 \? "rollback_native_restored" : "rollback_started"/u);
  assert.match(selected,/requireDurableStage6 \? 6 : 5/u);
});


test('only the original OS Guardian promotes four independently SHA-bound A backend identities to durable stage7',async()=>{
  const health=await readFile(new URL('../../native/windows/EquinoxLocal.Guardian/MainNativeRestoredAHealth.cs',import.meta.url),'utf8');
  const server=await readFile(new URL('../../native/windows/EquinoxLocal.Guardian/MainNativeRestoredAHealthAdmission.cs',import.meta.url),'utf8');
  const loop=await readFile(new URL('../../native/windows/EquinoxLocal.Guardian/MainNativeRollbackOwnerWitness.cs',import.meta.url),'utf8');
  assert.match(loop,/new NamedPipeServerStream\("EquinoxLocalMainAB-HealthyStableA-" \+ owner\.TransactionId/u);
  assert.match(server,/GetNamedPipeClientProcessId\(pipe\.SafePipeHandle, out var pid\)/u);
  assert.match(server,/RequireOwnedRestoredAFourBackendHealthSamples\(owner, journalRoot, worker, lease, leaseAge\)/u);
  assert.match(server,/"rollback_native_restored", 6, "rollback_healthy", 7/u);
  assert.match(server,/rollback_healthy\.commit\.json/u);
  assert.match(server,/marker\.RootElement\.GetProperty\("guardianPid"\)\.GetInt32\(\) != Environment\.ProcessId/u);
  assert.match(server,/grant\[32\] = \(byte\)'H'/u);
  assert.match(server,/ack\[0\] != \(byte\)'h'/u);
  assert.match(health,/var consecutive = 0/u);
  assert.match(health,/consecutive = healthy \? consecutive \+ 1 : 0/u);
  assert.match(health,/healthClock\.Elapsed < TimeSpan\.FromSeconds\(75\)/u);
  assert.match(health,/TimeSpan\.FromSeconds\(3\)/u);
  assert.match(health,/new byte\[8193\]/u);
  assert.match(health,/Thread\.Sleep\(500\)/u);
  assert.match(health,/health\.TryGetProperty\("state", out var state\) && state\.GetString\(\) == "HEALTHY"/u);
  assert.match(health,/sha\.GetString\(\) == oldSha/u);
  assert.match(health,/release\.GetString\(\) == version/u);
  assert.match(health,/allowRestoredAWpf: true/u);
  assert.match(health,/FindExactRunningWpfOrNull\(executable\)/u);
  assert.match(health,/ReadWindowsLogonAuthenticationId\(token\)/u);
  assert.doesNotMatch(health,/WriteIntegratedOwnedNativeStage|Process\.Kill|Registry\.SetValue/u);
});


test('terminal old-A readiness is read-only and binds live original OS lease, both stage6 and stage7 Guardian SHA/PID and retained B quarantine',async()=>{
  const proof=await readFile(new URL('../../native/windows/EquinoxLocal.Guardian/MainNativeRestoredATerminalReadiness.cs',import.meta.url),'utf8');
  assert.match(proof,/RequireOwnedRestoredATerminalReadiness\(/u);
  const original=await readFile(new URL('../../native/windows/EquinoxLocal.Guardian/MainNativeRollbackOwnerWitness.cs',import.meta.url),'utf8');
  assert.ok(original.indexOf('ServeOwnedRestoredAHealthAdmission(owner, journalRoot, worker, lease, leaseAge, healthPipe)') < original.indexOf('RequireOwnedRestoredATerminalReadiness(owner, journalRoot, worker, lease, leaseAge)'));
  assert.match(original,/RequireOwnedRestoredATerminalReadiness\(owner, journalRoot, worker, lease, leaseAge\)/u);
  assert.match(proof,/InspectOwnedNativeWorkerProcess\(guardianHoldsJournalLease: true\)/u);
  assert.match(proof,/InspectOwnedNativeWorkerOsArguments\(guardianHoldsJournalLease: true\)/u);
  assert.match(proof,/lease\.SafeFileHandle\.IsClosed \|\| lease\.SafeFileHandle\.IsInvalid/u);
  assert.match(proof,/worker\.StartTime\.ToUniversalTime\(\)\.Ticks/u);
  assert.match(proof,/rollback_healthy\.commit\.json/u);
  assert.match(proof,/rollback_native_restored\.commit\.json/u);
  assert.match(proof,/marker7\.RootElement\.GetProperty\("guardianPid"\)\.GetInt32\(\) != Environment\.ProcessId/u);
  assert.match(proof,/marker6\.RootElement\.GetProperty\("guardianPid"\)\.GetInt32\(\) != Environment\.ProcessId/u);
  assert.match(proof,/GetProperty\("sequence"\)\.GetInt32\(\) != 7/u);
  assert.match(proof,/CompareNativeTrees\(Path\.Combine\(stable, "runtime", "shell"\), active\)/u);
  assert.match(proof,/CompareNativeTrees\(Path\.Combine\(candidateB, "runtime", "shell"\), quarantine\)/u);
  assert.match(proof,/InspectOwnedMainNativeMessaging\(install, stable\)/u);
  assert.match(proof,/Directory\.EnumerateFileSystemEntries\(transactionRoot, "current-native\.json", SearchOption\.TopDirectoryOnly\)\.Any\(\)/u);
  assert.match(proof,/RequireOriginalGuardianRestoredAWpfReceipt\(owner, journalRoot, worker, lease, leaseAge, active, oldStageSha\)/u);
  assert.match(proof,/Original stage7 or kernel worker changed during terminal-readiness witness/u);
  assert.doesNotMatch(proof,/WriteIntegratedOwnedNativeStage|Directory\.Move|File\.Move|File\.Delete|Registry\.SetValue|Process\.Start|Process\.Kill/u);
});


test('terminal original Guardian fixed T only after full stage7 readiness commits durable stage8 and retains failed B',async()=>{
  const native=await readFile(new URL('../../native/windows/EquinoxLocal.Guardian/MainNativeRestoredATerminalCommit.cs',import.meta.url),'utf8');
  const loop=await readFile(new URL('../../native/windows/EquinoxLocal.Guardian/MainNativeRollbackOwnerWitness.cs',import.meta.url),'utf8');
  const milestones=await readFile(new URL('../../native/windows/EquinoxLocal.Guardian/MainNativeIntegratedABSupervisor.cs',import.meta.url),'utf8');
  assert.match(loop,/new NamedPipeServerStream\("EquinoxLocalMainAB-TerminalStableA-" \+ owner\.TransactionId/u);
  assert.ok(loop.indexOf('RequireOwnedRestoredATerminalReadiness(owner, journalRoot, worker, lease, leaseAge);') < loop.indexOf('ServeOwnedRestoredATerminalCommit(owner, journalRoot, worker, lease, leaseAge, terminalPipe);'));
  assert.match(native,/GetNamedPipeClientProcessId\(pipe\.SafePipeHandle, out var pid\)/u);
  assert.match(native,/pid != owner\.Pid/u);
  assert.match(native,/InspectOwnedNativeWorkerOsArguments\(guardianHoldsJournalLease: true\)/u);
  assert.match(native,/RequireOwnedRestoredATerminalReadiness\(owner, journalRoot, worker, lease, leaseAge\)/u);
  assert.match(native,/"equinox-local-guardian-ab-terminal-a-worker-v1:"/u);
  assert.match(native,/"equinox-local-guardian-ab-terminal-a-owner-v1:"/u);
  assert.match(native,/FixedTimeEquals\(expected, response\)/u);
  assert.match(native,/grant\[32\] = \(byte\)'T'/u);
  assert.match(native,/ack\[0\] != \(byte\)'t'/u);
  assert.match(native,/"rollback_healthy", 7, "rolled_back", 8/u);
  assert.match(native,/rolled_back\.commit\.json/u);
  assert.match(native,/marker\.RootElement\.GetProperty\("guardianPid"\)\.GetInt32\(\) != Environment\.ProcessId/u);
  assert.match(native,/No B deletion or cleanup grant exists in this action/u);
  assert.match(milestones,/from == "rollback_healthy" && originalSequence == 7 && to == "rolled_back" && nextSequence == 8/u);
  assert.doesNotMatch(native,/Directory\.Delete|File\.Delete|Registry\.SetValue|Process\.Kill|Process\.Start/u);
});

test('same original OS Guardian revalidates durable terminal8 and B quarantine before terminal ACK, without delete authority', async()=>{
  const readiness=await readFile(new URL('../../native/windows/EquinoxLocal.Guardian/MainNativeRestoredATerminalReadiness.cs',import.meta.url),'utf8');
  const server=await readFile(new URL('../../native/windows/EquinoxLocal.Guardian/MainNativeRestoredATerminalCommit.cs',import.meta.url),'utf8');
  assert.match(readiness,/bool requireTerminalStage8 = false/u);
  assert.match(readiness,/expectedStage = requireTerminalStage8 \? "rolled_back" : "rollback_healthy"/u);
  assert.match(readiness,/expectedSequence = requireTerminalStage8 \? 8 : 7/u);
  assert.match(readiness,/\.rolled_back\.commit\.json/u);
  assert.match(readiness,/marker8\.RootElement\.GetProperty\("guardianPid"\)\.GetInt32\(\) != Environment\.ProcessId/u);
  assert.match(readiness,/marker8\.RootElement\.GetProperty\("journalSha256"\)\.GetString\(\) != Convert\.ToHexStringLower\(stage7Sha\)/u);
  assert.match(readiness,/marker7\.RootElement\.GetProperty\("guardianPid"\)\.GetInt32\(\) != Environment\.ProcessId/u);
  assert.match(readiness,/marker6\.RootElement\.GetProperty\("guardianPid"\)\.GetInt32\(\) != Environment\.ProcessId/u);
  assert.match(readiness,/CompareNativeTrees\(Path\.Combine\(stable, "runtime", "shell"\), active\)/u);
  assert.match(readiness,/CompareNativeTrees\(Path\.Combine\(candidateB, "runtime", "shell"\), quarantine\)/u);
  assert.match(readiness,/RequireOriginalGuardianRestoredAWpfReceipt\(owner, journalRoot, worker, lease, leaseAge, active, oldStageSha\)/u);
  assert.match(readiness,/native-integrated-a-post-terminal-cleanup-readiness-read-only-no-delete/u);
  const finalAudit=server.indexOf('requireTerminalStage8: true');
  const finalAck=server.indexOf("pipe.WriteByte((byte)'a')");
  assert.ok(finalAudit>=0 && finalAck>finalAudit);
  assert.doesNotMatch(readiness,/File\.Delete|Directory\.Delete|Directory\.Move|File\.Move|WriteIntegratedOwnedNativeStage|Registry\.SetValue/u);
  assert.doesNotMatch(server,/File\.Delete|Directory\.Delete|Directory\.Move|File\.Move/u);
});


test('only same original OS Guardian may retire exact SHA-quarantined failed B under fixed Q without deleting a single file',async()=>{
  const server=await readFile(new URL('../../native/windows/EquinoxLocal.Guardian/MainNativeFailedBQuarantineRetirement.cs',import.meta.url),'utf8');
  const mutation=await readFile(new URL('../../native/windows/EquinoxLocal.Guardian/MainNativeFailedBQuarantineRetirementProof.cs',import.meta.url),'utf8');
  const lease=await readFile(new URL('../../native/windows/EquinoxLocal.Guardian/MainNativeRollbackOwnerWitness.cs',import.meta.url),'utf8');
  const readiness=await readFile(new URL('../../native/windows/EquinoxLocal.Guardian/MainNativeRestoredATerminalReadiness.cs',import.meta.url),'utf8');
  assert.match(lease,/new NamedPipeServerStream\("EquinoxLocalMainAB-RetireFailedB-" \+ owner\.TransactionId/u);
  assert.ok(lease.indexOf('ServeOwnedRestoredATerminalCommit(owner, journalRoot, worker, lease, leaseAge, terminalPipe);') < lease.indexOf('ServeOwnedFailedBQuarantineRetirement(owner, journalRoot, worker, lease, leaseAge, retirementPipe);'));
  assert.match(server,/GetNamedPipeClientProcessId\(pipe\.SafePipeHandle, out var pid\)/u);
  assert.match(server,/pid != owner\.Pid/u);
  assert.match(server,/InspectOwnedNativeWorkerOsArguments\(guardianHoldsJournalLease: true\)/u);
  assert.match(server,/"equinox-local-guardian-ab-retire-b-worker-v1:"/u);
  assert.match(server,/"equinox-local-guardian-ab-retire-b-owner-v1:"/u);
  assert.match(server,/grant\[32\] = \(byte\)'Q'/u);
  assert.match(server,/ack\[0\] != \(byte\)'q'/u);
  assert.match(server,/FixedTimeEquals\(expected, response\)/u);
  assert.match(server,/RetireOwnedFailedBQuarantineWithoutDeletion\(owner, journalRoot, worker, lease, leaseAge, digest\)/u);
  assert.match(mutation,/FileMode\.CreateNew, FileAccess\.Write/u);
  assert.match(mutation,/FileOptions\.WriteThrough/u);
  assert.match(mutation,/fd\.Flush\(flushToDisk: true\)/u);
  assert.match(mutation,/failed-b-retire\.intent\.json/u);
  assert.match(mutation,/failed-b-retired\.commit\.json/u);
  assert.match(mutation,/Directory\.Move\(quarantine, retired\)/u);
  assert.match(mutation,/CompareNativeTrees\(candidate, quarantine\)/u);
  assert.match(mutation,/requireTerminalStage8: true, requireRetiredFailedB: true/u);
  assert.match(mutation,/intentSha256/u);
  assert.match(readiness,/requireRetiredFailedB && !requireTerminalStage8/u);
  assert.match(readiness,/CompareNativeTrees\(Path\.Combine\(candidateB, "runtime", "shell"\), retired\)/u);
  assert.match(readiness,/if \(Directory\.Exists\(quarantine\) \|\| File\.Exists\(quarantine\)\)/u);
  assert.doesNotMatch(server+mutation,/Directory\.Delete|File\.Delete|Remove-Item|Process\.Kill|Registry\.SetValue/u);
});
