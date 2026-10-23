import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  switchWindowsNativeABSlot,
  restoreWindowsNativeABSlot,
  finalizeWindowsNativeABRollback,
  commitWindowsNativeABSlot,
} from '../../src/equinox-local-windows-native-ab-switch.js';
import { snapshotWindowsStableShellTree, sameWindowsStableShellTree } from '../../src/equinox-local-windows-stable-shell.js';

import { createSupervisorBoundWindowsNativeABLifecycle } from '../../src/equinox-local-windows-native-ab-supervisor-bound.js';
import { admitWindowsMainNativeWorkerJournal } from '../../src/equinox-local-windows-main-worker-admission.js';
import { inspectWindowsMainUpdateWorkerProcess } from '../../src/equinox-local-main-update-scheduler.js';
import { compareEquinoxVersions } from '../../src/equinox-local-updater.js';
import { createEquinoxLocalWindowsNativeTransitionJournal } from '../../src/equinox-local-windows-native-transition-journal.js';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { runEquinoxLocalMainUpdateHandoff } from '../../src/equinox-local-main-update-handoff.js';

const [releaseDir, target] = process.argv.slice(2);
if (process.platform !== 'win32' || !['win32-x64', 'win32-arm64'].includes(target) || !path.isAbsolute(releaseDir)) {
  throw new Error('Windows native A/B real installed-host smoke requires exact native release and target.');
}
// Use the test account's private home rather than the globally shared OS temp
// directory: hashing and verifying native files must never follow another
// user's opportunistically created temp paths.
const root = await fs.realpath(await fs.mkdtemp(path.join(os.homedir(), '.equinox-ab-real-')));
const previousReleaseDir = path.join(root, 'releases', 'A');
const targetReleaseDir = path.join(root, 'releases', 'B');
const programRoot = path.join(root, 'Programs', 'Equinox Local');
const transactionId = `main-${'c'.repeat(32)}`;
const options = { transactionId, previousReleaseDir, targetReleaseDir, programRoot };
const sourceShell = path.join(releaseDir, 'runtime', 'shell');
const readInstalled = () => snapshotWindowsStableShellTree(programRoot);
try {
  const installedRelease = JSON.parse(await fs.readFile(path.join(releaseDir, "release.json"), "utf8"));
  const hasNativeInspector = compareEquinoxVersions(installedRelease.version, "6.1.2") >= 0;
  const nativeHelper = path.join(releaseDir, "runtime", "job", "equinox-local-job-object-helper.exe");
  const nativeGateMarker = path.join(releaseDir, "runtime", "job", "owned-process-gate-v1.marker");
  assert.equal((await fs.stat(nativeHelper)).isFile(), true, "installed native helper must exist");
  // Immutable older A (e.g. 6.1.0) predates the compiled process gate marker.
  // Modern releases MUST retain it. The A/B native PE fixture and old-A worker
  // PID/birthtime/executable proof below still execute for vintage packages.
  if (hasNativeInspector) {
    assert.equal((await fs.readFile(nativeGateMarker, "utf8")).trim(), "equinox-owned-process-gate-v1",
      "extracted Windows managed installer ZIP must retain the matching no-console native gate marker");
  }
  // Exercise the REAL architecture-specific native helper, not a simulated
  // JS inspector: a Node process cannot impersonate the installed WPF shell
  // even if a caller supplies a fake expected image path. The positive live
  // WPF owner proof requires an installed-host GUI session in a separate gate.
  const runWpfWitness = async (pid, ticks, extras = {}) => {
    const result = await promisify(execFileCallback)(nativeHelper, ["--inspect-owned-wpf"], {
      timeout: 5_000, maxBuffer: 1024, windowsHide: true,
      env: {SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
        USERPROFILE: process.env.USERPROFILE, EQUINOX_LOCAL_CHECK_WPF_PID: pid,
        EQUINOX_LOCAL_CHECK_WPF_TICKS: ticks, ...extras},
    });
    return result.stdout.trim();
  };
  assert.equal(await runWpfWitness("", "638953728000000000"), "unknown",
    "WPF witness must fail closed without exact PID");
  assert.equal(await runWpfWitness(String(process.pid), "638953728000000000",
    {EQUINOX_LOCAL_CHECK_WPF_EXE: process.execPath}), "mismatch",
    "a real running owned Node must never be accepted as the installed WPF shell");
  for (const rootRelease of [previousReleaseDir, targetReleaseDir]) {
    await fs.mkdir(path.dirname(path.join(rootRelease, 'runtime', 'shell')), { recursive: true });
    await fs.cp(sourceShell, path.join(rootRelease, 'runtime', 'shell'), { recursive: true, force: false, errorOnExist: true, dereference: false });
  }
  // Force distinct native slot digests while keeping the actual verified WPF
  // PE/runtime files unchanged. Both trees still contain the release's native
  // architecture-specific executable and dependencies, not synthetic stubs.
  await fs.writeFile(path.join(targetReleaseDir, 'runtime', 'shell', 'equinox-test-main-b.txt'), `${target}\n`);
  await fs.mkdir(path.dirname(programRoot), { recursive: true });
  await fs.cp(path.join(previousReleaseDir, 'runtime', 'shell'), programRoot, { recursive: true });
  const originalA = await readInstalled();
  const aRef = await snapshotWindowsStableShellTree(path.join(previousReleaseDir, 'runtime', 'shell'));
  const bRef = await snapshotWindowsStableShellTree(path.join(targetReleaseDir, 'runtime', 'shell'));
  assert.ok(sameWindowsStableShellTree(originalA, aRef));
  assert.ok(!sameWindowsStableShellTree(originalA, bRef));
  const result = await switchWindowsNativeABSlot(options, { requestShutdown: async () => {} });
  assert.equal(result.stage, 'switched');
  assert.ok(sameWindowsStableShellTree(await readInstalled(), bRef));
  await assert.rejects(commitWindowsNativeABSlot(options, { verifyBHealth: async () => false }), /health/u);
  assert.ok(sameWindowsStableShellTree(await snapshotWindowsStableShellTree(result.backupRoot), aRef));
  const rollback = await restoreWindowsNativeABSlot(options);
  assert.equal(rollback.stage, 'restored');
  assert.ok(sameWindowsStableShellTree(await readInstalled(), aRef));
  await assert.rejects(finalizeWindowsNativeABRollback(options, { verifyAHealth: async () => false }), /health/u);
  await finalizeWindowsNativeABRollback(options, { verifyAHealth: async () => true });
  assert.ok(sameWindowsStableShellTree(await readInstalled(), aRef));
  const second = await switchWindowsNativeABSlot(options, { requestShutdown: async () => {} });
  assert.equal(second.stage, 'switched');
  await commitWindowsNativeABSlot(options, { verifyBHealth: async () => true });
  assert.ok(sameWindowsStableShellTree(await readInstalled(), bRef));
  // One shared handoff + durable journal transaction against the SAME real
  // architecture-specific WPF payload used above, not a synthetic exe.
  // Still a disposable installation: OS worker credentials, NM registry and
  // real WPF process health require separate native supervisor admission.
  await fs.rm(programRoot, { recursive: true, force: true });
  await fs.cp(path.join(previousReleaseDir, 'runtime', 'shell'), programRoot, { recursive: true });
  const jid = `main-${'d'.repeat(32)}`;
  const started = '2026-10-12T09:00:00.000Z';
  const shaA = 'a'.repeat(40), shaB = 'b'.repeat(40), contract = 'f'.repeat(64);
  const txroot = path.join(root, 'main-update');
  await fs.mkdir(txroot, { recursive: true });
  let receipt = { transactionId: jid, currentSha: shaA, targetSha: shaB, startedAt: started, status: 'promoting' };
  let nm = 'A', stopped = false, restarted = false, source = 'A';
  const journal = createEquinoxLocalWindowsNativeTransitionJournal({
    transactionRoot: txroot, platform: 'win32',
    // The disposable temp-root fixture does not possess installer-managed
    // private ACLs; production code must use the real ACL verifier.
    protectWindowsAcl: async () => ({ safe: true }), verifyWindowsAcl: async () => ({ safe: true }),
    inspectOwningReceipt: async () => receipt,
    verifyMilestone: async (_, stage) => {
      const active = await readInstalled();
      if (stage === 'shell_stopped') return stopped;
      if (['switched', 'restarted', 'healthy', 'committed'].includes(stage)) {
        return sameWindowsStableShellTree(active, bRef) && nm === 'B';
      }
      return true;
    },
  });
  await journal.create({ transactionId: jid, target, currentSha: shaA, targetSha: shaB,
    receiptStartedAt: started, previousNative: { kind: 'stable', version: '6.0.4' },
    targetRuntimeContractSha256: contract });
  const lifecycle = createSupervisorBoundWindowsNativeABLifecycle({
    transactionId: jid, transition: { mode: 'artifact_required', target, currentSha: shaA, targetSha: shaB,
      targetRuntimeContractSha256: contract },
    stored: { sourceSha: shaB, target, runtimeContractSha256: contract, releaseDir: targetReleaseDir },
    previousReleaseDir, programRoot, manifestRoot: path.join(root, 'disposable-manifest'),
    transactionRoot: txroot, pointerPath: path.join(txroot, 'current-native.json'),
    windowsAdmission: { admitted: true, journal,
      record: { transactionId: jid, target, currentSha: shaA, targetSha: shaB,
        targetRuntimeContractSha256: contract, receiptStartedAt: started },
      supervisor: { independentNativeOwner: true,
        assertWorkerOwnership: async () => true, // disposable fixture only
        shutdownOwnedWpf: async () => { stopped = true; },
        quiesceOwnedB: async () => true, // fixture-only simulated native B quiesce
        verifyNativeMessaging: async ({ release }) => nm === release,
        verifySustainedHealth: async ({ release, sourceSha }) => release === 'B' && sourceSha === shaB && source === 'B' && restarted,
      },
    },
    launcherPathImpl: (release) => path.join(release, 'runtime', 'browser', 'host.exe'),
    assertNativeHostImpl: async ({ acceptedLauncherPaths }) => {
      const selected = path.join(nm === 'A' ? previousReleaseDir : targetReleaseDir, 'runtime', 'browser', 'host.exe');
      if (!acceptedLauncherPaths.includes(selected)) throw Error('Disposable fixture has another Native Messaging owner.');
    },
    registerNativeHostImpl: async ({ launcherPath, expectedPreviousLauncherPath }) => {
      const prior = path.join(nm === 'A' ? previousReleaseDir : targetReleaseDir, 'runtime', 'browser', 'host.exe');
      assert.equal(expectedPreviousLauncherPath, prior);
      nm = launcherPath.startsWith(targetReleaseDir) ? 'B' : 'A';
    },
    writePointerImpl: async (_pointer, value) => { assert.equal(value.sourceSha, shaB); },
  });
  const base = { currentSha: shaA, targetSha: shaB, rollbackSha: shaA,
    rollbackSourceRoot: path.join(root, 'sourceA'), targetSourceRoot: path.join(root, 'sourceB') };
  const engine = {
    markNativeSwitched: async () => base,
    activatePromotion: async () => { source = 'B'; return base; },
    rollbackPromotion: async () => { source = 'A'; receipt = { ...receipt, status: 'verifying' }; return { ...base, stage: 'rollback_source_restored' }; },
    markNativeRollbackRestored: async () => ({ ...base, stage: 'rollback_native_restored' }),
    markRollbackSucceeded: async () => { receipt = { ...receipt, status: 'rolled_back' }; return { ...base, status: 'rolled_back' }; },
    markRollbackFailed: async () => {},
    markPromotionSucceeded: async () => { receipt = { ...receipt, status: 'succeeded' }; return { ...base, status: 'succeeded' }; },
    releaseStagedLock: async () => {},
  };
  const journaled = await runEquinoxLocalMainUpdateHandoff({
    engine, transactionId: jid, nativeLifecycle: lifecycle,
    initialReceipt: { ...base, stage: 'native_rollback_ready' },
    restartRuntime: async () => { restarted = true; },
    verifyRuntime: async () => true,
  });
  assert.equal(journaled.status, 'succeeded');
  assert.equal((await journal.read(jid)).stage, 'committed');
  assert.ok(sameWindowsStableShellTree(await readInstalled(), bRef));
  await assert.rejects(fs.lstat(path.join(root, 'Programs', `.equinox-shell-backup-${jid}`)), { code: 'ENOENT' });
  // Worker admission must prove a REAL running product-owned Node PID, its
  // Windows UTC birth ticks and exact executable, not only a unit mock.
  // This is a disposable ownership receipt and does NOT unlock production WPF.
  const execFile = promisify(execFileCallback);
  const workRoot = path.join(root, 'worker-admission');
  await fs.mkdir(path.join(workRoot, 'handoff'), { recursive: true });
  const aid = `main-${'f'.repeat(32)}`;
  const token = 'e'.repeat(64);
  // This fixture runs ONLY from the GitHub Windows package acceptance lane,
  // which already runs its steps under pwsh. Reuse the hosted PowerShell 7
  // command rather than cold-launching Windows PowerShell 5.1 under heavy
  // concurrent native workloads. The OS PID/start ticks and native helper
  // witness stay exact; the independent 20-second bound remains fail-closed.
  const birth = await execFile('pwsh.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    `(Get-Process -Id ${process.pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)`,
  ], { timeout: 20_000, windowsHide: true });
  const ticks = String(birth.stdout).trim();
  assert.match(ticks, /^[0-9]{1,19}$/u);
  const owner = { schemaVersion: 1, transactionId: aid, pid: process.pid,
    startTimeUtcTicks: ticks, token, nodePath: process.execPath };
  await fs.writeFile(path.join(workRoot, 'handoff', `${aid}.windows-worker.json`), JSON.stringify(owner));
  const currentSha = 'a'.repeat(40), targetSha = 'b'.repeat(40);
  const admissionReceipt = { transactionId: aid, status: 'promoting', stage: 'ready_to_switch',
    currentSha, targetSha, startedAt: started };
  const nativeTransition = { mode: 'artifact_required', target, currentSha, targetSha,
    currentRuntimeContractSha256: 'a'.repeat(64), targetRuntimeContractSha256: contract };
  const nativeHelperPath = path.join(releaseDir, 'runtime', 'job', 'equinox-local-job-object-helper.exe');
  // Historic signed A cannot have a future native inspector. Its isolated
  // fixture retains the old PowerShell probe; the new B candidate must use
  // the compiled native verifier through the real admission path.
  const oldInspector = hasNativeInspector ? {} : {
    inspectWorkerImpl: (ownership) => inspectWindowsMainUpdateWorkerProcess(ownership),
  };
  if (hasNativeInspector) {
    assert.equal((await inspectWindowsMainUpdateWorkerProcess(owner, { nativeHelperPath })).running, true);
    assert.equal((await inspectWindowsMainUpdateWorkerProcess({ ...owner,
      startTimeUtcTicks: (BigInt(ticks) + 1n).toString() }, { nativeHelperPath })).stale, true);
    assert.equal((await inspectWindowsMainUpdateWorkerProcess({ ...owner,
      nodePath: path.join(releaseDir, 'foreign-node.exe') }, { nativeHelperPath })).stale, true);
    assert.equal((await inspectWindowsMainUpdateWorkerProcess({ ...owner,
      pid: 2147483647 }, { nativeHelperPath })).stale, true);
    console.log(`Windows ${target} direct native API PID/birth/executable/reuse checks VERIFIED`);
  }
  const realAdmission = {
    receipt: admissionReceipt, transition: nativeTransition, transactionRoot: workRoot,
    installation: { managed: true, selfUpdateSupported: true, target, releaseDir },
    engine: { readActive: async () => admissionReceipt },
    workerToken: token, nativeHelperPath, ...oldInspector,
    readPointerImpl: async () => { throw Object.assign(new Error('Stable A has no main pointer'), { code: 'ENOENT' }); },
    journalFactory: (o) => createEquinoxLocalWindowsNativeTransitionJournal({
      ...o, protectWindowsAcl: async () => ({ safe: true }), verifyWindowsAcl: async () => ({ safe: true }),
    }),
  };
  const admitted = await admitWindowsMainNativeWorkerJournal(realAdmission);
  assert.equal(admitted.record.stage, 'prepared');
  assert.equal(admitted.ownedNode.toLowerCase(), process.execPath.toLowerCase());
  await assert.rejects(admitWindowsMainNativeWorkerJournal({ ...realAdmission, workerToken: '0'.repeat(64) }), /token\/PID/u);
  await assert.rejects(admitWindowsMainNativeWorkerJournal({ ...realAdmission,
    inspectWorkerImpl: async () => ({ running: false, stale: true }) }), /not independently verified/u);
  console.log(`Windows ${target} exact LIVE product Node PID/birthtime/executable/token → native journal admission VERIFIED`);
  console.log(`Windows ${target} shared handoff + persisted native journal + actual WPF PE A→B/health-gated commit VERIFIED`);
  console.log(`Windows ${target} real-native-PE immutable A→B / failed B→A / healthy B commit VERIFIED`);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
