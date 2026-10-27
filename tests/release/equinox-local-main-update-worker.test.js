import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveEquinoxLocalMainWorkerNativeInstallation, restartEquinoxLocalMainSourceRuntime, runEquinoxLocalMainUpdateWorker, waitForExactSourceHealth, waitForExactNativeMainHealth } from "../../src/equinox-local-main-update-worker.js";

const TX = `main-${"a".repeat(32)}`;
const SOURCE = "/private/tmp/equinox-source-a";
const STATE = "/private/tmp/equinox-main-state";
const A = "1".repeat(40);
const B = "2".repeat(40);
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

function preparedReceipt(overrides = {}) {
  return { transactionId: TX, status: "promoting", stage: "ready_to_switch", currentSha: A, targetSha: B, rollbackSourceRoot: SOURCE, targetSourceRoot: "/target", ...overrides };
}

function reuseTransition() {
  return { mode: "reuse_native", target: "darwin-arm64", currentSha: A, targetSha: B, currentRuntimeContractSha256: DIGEST_A, targetRuntimeContractSha256: DIGEST_A };
}

function argv() {
  return ["--transaction-id", TX, "--source-root", SOURCE, "--transaction-root", STATE];
}

// Deterministic native-worker fixtures never access the network; specific
// tests override this seam to exercise real ordering and fail-closed abort.
function runWorkerFixture(options) {
  return runEquinoxLocalMainUpdateWorker({ provisionToolchainImpl: async () => ({ components: [] }), ...options });
}

test("Main worker runtime restart uses the Windows shell handoff without POSIX execution", async () => {
  const calls = [];
  const result = await restartEquinoxLocalMainSourceRuntime({
    platform: "win32",
    sourceRoot: "C:\Equinox\source",
    previousSourceRoot: "C:\Equinox\previous",
    execFileImpl: async () => assert.fail("Windows restart must not invoke /bin/bash"),
    fsImpl: { lstat: async () => assert.fail("Windows restart must not inspect a POSIX script") },
    requestWindowsRestartImpl: async (value) => calls.push(value),
  });
  assert.deepEqual(calls, [{ platform: "win32" }]);
  assert.deepEqual(result, { requested: true, platform: "win32" });
});

test("detached target worker provisions pinned B Git and Node before native diff (real external Windows update regression)", async () => {
  const events = [];
  const receipt = preparedReceipt();
  const result = await runWorkerFixture({
    argv: argv(), resolveHostTarget: () => "win32-x64",
    engineFactory: () => ({
      readActive: async () => { events.push("read-owned-receipt"); return receipt; },
      abortPreparedPromotion: async () => assert.fail("successful preflight must not abort"),
    }),
    provisionToolchainImpl: async ({target, runtimeRoot}) => {
      assert.equal(target, "win32-x64");
      assert.ok(runtimeRoot.endsWith("runtime"));
      events.push("provision-target-toolchain");
      return { components: [] };
    },
    planNativeTransition: async ({gitPath}) => {
      assert.match(gitPath, /2\.56\.0-1/u);
      events.push("plan-using-new-git");
      return { mode: "reuse_native", target: "win32-x64" };
    },
    handoffImpl: async () => { events.push("handoff"); return {status:"succeeded"}; },
    cleanupImpl: async () => events.push("cleanup"),
  });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(events, ["read-owned-receipt", "provision-target-toolchain", "plan-using-new-git", "handoff", "cleanup"]);
});

test("detached native worker fails closed on toolchain download and aborts only its owned pre-activation transaction", async () => {
  const events = [];
  await assert.rejects(runWorkerFixture({
    argv: argv(), resolveHostTarget: () => "win32-x64",
    engineFactory: () => ({
      readActive: async () => preparedReceipt(),
      abortPreparedPromotion: async (id, message, opts) => events.push(["abort",id,message,opts]),
    }),
    provisionToolchainImpl: async () => { events.push(["provision"]); throw new Error("pinned new Git unavailable"); },
    planNativeTransition: async () => assert.fail("never inspect target with missing Git"),
    handoffImpl: async () => assert.fail("never hand off native transition"),
    cleanupImpl: async () => events.push(["cleanup"]),
  }), /pinned new Git unavailable/u);
  assert.equal(events[0][0], "provision");
  assert.equal(events[1][0], "abort");
  assert.equal(events[1][1], TX);
  assert.deepEqual(events[1][3], {stage:"native_admission_failed"});
  assert.equal(events[2][0], "cleanup");
});

test("Windows native Main replacement relaunches only the verified new WPF shell when the old pipe is gone", async () => {
  const programRoot = "C:\\Users\\Example\\AppData\\Local\\Programs\\Equinox Local";
  const releaseDir = "C:\\Users\\Example\\AppData\\Local\\Equinox Local\\state\\main-update\\native-store\\target\\release";
  const shellExecutable = `${programRoot}\\EquinoxLocal.exe`;
  const calls = [];
  const result = await restartEquinoxLocalMainSourceRuntime({
    platform: "win32", windowsNativeShell: { programRoot, releaseDir },
    requestWindowsRestartImpl: async () => assert.fail("dead old WPF pipe must not be contacted"),
    verifyWindowsShellImpl: async (v) => { calls.push(["verify", v.programRoot, v.releaseDir]); return { owned: true, shellExecutable }; },
    launchWindowsShellImpl: async (file) => { calls.push(["launch", file]); return { launched: true }; },
  });
  assert.deepEqual(result, { requested: true, platform: "win32", directNativeLaunch: true });
  assert.deepEqual(calls, [["verify", programRoot, releaseDir], ["launch", shellExecutable]]);
});

test("Windows native Main rollback relaunch fails closed when restored shell cannot be verified", async () => {
  const programRoot = "C:\\Users\\Example\\AppData\\Local\\Programs\\Equinox Local";
  let launched = false;
  await assert.rejects(restartEquinoxLocalMainSourceRuntime({
    platform: "win32", windowsNativeShell: { programRoot, releaseDir: "C:\\Untrusted" },
    requestWindowsRestartImpl: async () => assert.fail("missing shell pipe must not be contacted"),
    verifyWindowsShellImpl: async () => ({ owned: false }),
    launchWindowsShellImpl: async () => { launched = true; },
  }), /integrity could not be verified/u);
  assert.equal(launched, false);
  await assert.rejects(restartEquinoxLocalMainSourceRuntime({
    platform: "win32", windowsNativeShell: { programRoot, releaseDir: "relative\\release" },
    verifyWindowsShellImpl: async () => assert.fail("unsafe path must be rejected before reading filesystem"),
  }), /trusted absolute/u);
});

test("Windows native worker handoff supplies exact candidate and rollback release identities to shell restart", async () => {
  const events = [];
  const rollbackPath = "C:\\native-rollback\\release";
  const targetRelease = "C:\\native-store\\release";
  const programRoot = "C:\\Programs\\Equinox Local";
  const transition = { mode: "artifact_required", target: "win32-x64", currentSha: A, targetSha: B, currentRuntimeContractSha256: DIGEST_A, targetRuntimeContractSha256: DIGEST_B };
  const receipt = preparedReceipt({ stage: "native_switched" });
  const journal = { source: "exact-admitted-native-journal" };
  const nativeLifecycle = { target: "win32-x64", journaledAB: true, journal, stored: { releaseDir: targetRelease }, rollbackPath, windowsProgramRoot: programRoot, activate: async () => {}, rollback: async () => {}, commit: async () => {} };
  const engine = { paths: { sourcePointerPath: "C:\\transaction\\current-source.conf" }, readActive: async () => receipt };
  await runWorkerFixture({
    argv: argv(), engineFactory: () => engine, resolveHostTarget: () => "win32-x64",
    planNativeTransition: async () => transition,
    resolveNativeInstallation: async () => ({ managed: true, selfUpdateSupported: true, target: "win32-x64" }),
    admitWindowsNativeWorker: async ({ nativeHelperPath }) => {
      assert.equal(nativeHelperPath, path.win32.join(targetRelease, 'runtime', 'job', 'equinox-local-job-object-helper.exe'));
      return { admitted: true, journal };
    },
    inspectStoredNativeRelease: async () => ({ releaseDir: targetRelease }),
    recoverNativeLifecycle: async () => nativeLifecycle,
    restartRuntimeImpl: async (v) => events.push(v),
    handoffImpl: async ({ restartRuntime }) => {
      await restartRuntime({ rollback: false, transactionId: TX });
      await restartRuntime({ rollback: true, transactionId: TX });
      return { status: "succeeded" };
    },
    cleanupImpl: async () => {},
  });
  assert.deepEqual(events[0].windowsNativeShell, { programRoot, releaseDir: targetRelease });
  assert.deepEqual(events[1].windowsNativeShell, { programRoot, releaseDir: rollbackPath });
});

test("Windows detached owner installs a fresh native release without a second Guardian journal", async () => {
  const events = [];
  const receipt = preparedReceipt();
  const transition = { mode: "artifact_required", target: "win32-x64", currentSha: A, targetSha: B,
    currentRuntimeContractSha256: DIGEST_A, targetRuntimeContractSha256: DIGEST_B };
  const lifecycle = { activate: async () => {}, rollback: async () => {}, commit: async () => {} };
  const engine = {
    paths: { sourcePointerPath: "C:\\state\\current-source.conf" },
    readActive: async () => receipt,
    markNativeRollbackReady: async () => ({ ...receipt, stage: "native_rollback_ready" }),
  };
  const result = await runWorkerFixture({
    argv: argv(), engineFactory: () => engine, resolveHostTarget: () => "win32-x64",
    planNativeTransition: async () => transition,
    resolveNativeInstallation: async () => ({ managed: true, selfUpdateSupported: true, target: "win32-x64" }),
    admitWindowsNativeWorker: async (options) => {
      events.push(["owner", options.ownerOnly]);
      const release = options.ownerOnly ? 'C:\\native-candidate\\release' : 'C:\\native-store\\release';
      assert.equal(options.nativeHelperPath, path.win32.join(release, 'runtime', 'job', 'equinox-local-job-object-helper.exe'));
      return options.ownerOnly ? { admitted: true, ownerOnly: true } :
        { admitted: true, supervisor:{independentNativeOwner:true}, journal:{read:async()=>{},advance:async()=>{}} };
    },
    promoteNativeCandidateImpl: async ({candidate}) => {
      events.push(["inactive-B",candidate.sourceSha]);
      return {sourceSha:B,target:"win32-x64",releaseDir:'C:\\native-store\\release'};
    },
    ensureNativeArtifact: async () => { events.push(["native-download", B]); },
    prepareNativeCandidate: async () => ({ sourceSha: B, target: "win32-x64", releaseDir: String.raw`C:\native-candidate\release` }),
    prepareNativeLifecycle: async (options) => {
      assert.equal(options.windowsAdmission.supervisor.independentNativeOwner,true);
      events.push(["fresh-native", options.candidate.sourceSha]);
      return lifecycle;
    },
    handoffImpl: async ({ nativeLifecycle }) => {
      assert.equal(nativeLifecycle, lifecycle);
      events.push(["handoff"]);
      return { status: "succeeded" };
    },
    cleanupImpl: async () => events.push(["cleanup"]),
  });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(events, [["native-download", B], ["owner", true], ["inactive-B", B], ["owner", false], ["fresh-native", B], ["handoff"], ["cleanup"]]);
});

test("target-owned detached worker stages a full native package when older A omitted it", async () => {
  const events = [];
  const receipt = preparedReceipt();
  const transition = { mode: "artifact_required", target: "darwin-arm64", currentSha: A, targetSha: B,
    currentRuntimeContractSha256: DIGEST_A, targetRuntimeContractSha256: DIGEST_A };
  await runWorkerFixture({
    argv: argv(), resolveHostTarget: () => "darwin-arm64",
    engineFactory: () => ({ readActive: async () => receipt,
      markNativeRollbackReady: async () => ({ ...receipt, stage: "native_rollback_ready" }) }),
    planNativeTransition: async () => transition,
    resolveNativeInstallation: async () => ({ managed: true, selfUpdateSupported: true, target: "darwin-arm64" }),
    ensureNativeArtifact: async (args) => { events.push(["stage", args.targetSha, args.expectedRuntimeContractSha256]); },
    prepareNativeCandidate: async () => { events.push(["candidate"]); return { sourceSha: B }; },
    prepareNativeLifecycle: async () => ({ activate: async () => {}, rollback: async () => {}, commit: async () => {} }),
    handoffImpl: async () => { events.push(["handoff"]); return { status: "succeeded" }; },
    cleanupImpl: async () => {},
  });
  assert.deepEqual(events, [["stage", B, DIGEST_A], ["candidate"], ["handoff"]]);
});

test("Windows clean replacement refuses missing detached worker ownership before native activation", async () => {
  const receipt = preparedReceipt();
  const calls = [];
  const transition = { mode: "artifact_required", target: "win32-x64", currentSha: A, targetSha: B,
    currentRuntimeContractSha256: DIGEST_A, targetRuntimeContractSha256: DIGEST_B };
  await assert.rejects(runWorkerFixture({
    argv: argv(), resolveHostTarget: () => "win32-x64",
    engineFactory: () => ({ readActive: async () => receipt,
      abortPreparedPromotion: async () => calls.push("abort") }),
    planNativeTransition: async () => transition,
    resolveNativeInstallation: async () => ({ managed: true, selfUpdateSupported: true, target: "win32-x64" }),
    admitWindowsNativeWorker: async () => ({ admitted: false }),
    ensureNativeArtifact: async () => {},
    prepareNativeCandidate: async () => ({ sourceSha: B, releaseDir: String.raw`C:\native-candidate\release` }),
    prepareNativeLifecycle: async () => assert.fail("unverified owner must not replace a native release"),
    cleanupImpl: async () => calls.push("cleanup"),
  }), /no verified detached WPF owner/u);
  assert.deepEqual(calls, ["abort", "cleanup"]);
});

test("Main worker runtime restart uses the managed Darwin LaunchAgent instead of developer source scripts", async () => {
  const calls = [];
  const result = await restartEquinoxLocalMainSourceRuntime({
    platform: "darwin",
    sourceRoot: "/target",
    previousSourceRoot: SOURCE,
    env: { HOME: "/Users/example" },
    uid: 501,
    fsImpl: { lstat: async () => assert.fail("managed restart must not inspect source restart scripts") },
    execFileImpl: async () => assert.fail("restart primitive owns launchctl execution"),
    restartDarwinImpl: async (installation, options) => calls.push([installation, options.uid]),
  });
  assert.deepEqual(calls, [[{
    launchAgentLabel: "dev.equinox.local",
    launchAgentPath: "/Users/example/Library/LaunchAgents/dev.equinox.local.plist",
  }, 501]]);
  assert.deepEqual(result, { requested: true, platform: "darwin" });
});

test("launchd worker consumes only the prepared transaction it owns and cleans up after success", async () => {
  const events = [];
  const engine = { paths: { sourcePointerPath: `${STATE}/current-source.conf` }, readActive: async () => preparedReceipt(), abortPreparedPromotion: async () => assert.fail("success must not abort") };
  const result = await runWorkerFixture({
    argv: argv(),
    engineFactory: (options) => { events.push(["engine", options]); return engine; },
    resolveHostTarget: () => "darwin-arm64",
    planNativeTransition: async (value) => { events.push(["plan", value]); return reuseTransition(); },
    prepareNativeCandidate: async () => assert.fail("reuse_native must not prepare an artifact"),
    prepareNativeLifecycle: async () => assert.fail("reuse_native must not prepare native lifecycle"),
    handoffImpl: async ({ transactionId, restartRuntime, verifyRuntime }) => {
      events.push(["handoff", transactionId]);
      await restartRuntime({ sourceRoot: "/target", previousSourceRoot: SOURCE, sha: "b".repeat(40), rollback: false });
      assert.equal(await verifyRuntime({ sourceRoot: "/target", sha: "b".repeat(40), rollback: false }), true);
      return { status: "succeeded" };
    },
    restartRuntimeImpl: async (value) => events.push(["restart", value]),
    verifyRuntimeImpl: async (value) => { events.push(["verify", value]); return true; },
    cleanupImpl: async (value) => events.push(["cleanup", value]),
  });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(events.map(([name]) => name), ["engine", "plan", "handoff", "restart", "verify", "cleanup"]);
  assert.equal(events[0][1].sourceRoot, SOURCE);
  assert.equal(events.at(-1)[1].transactionId, TX);
});

test("worker rejects an unprepared transaction but still removes launchd ownership", async () => {
  const events = [];
  await assert.rejects(runWorkerFixture({
    argv: argv(),
    engineFactory: () => ({ readActive: async () => ({ transactionId: TX, status: "staged", stage: "staged" }) }),
    cleanupImpl: async () => events.push("cleanup"),
  }), /requires a resumable promotion receipt/u);
  assert.deepEqual(events, ["cleanup"]);
});

test("worker rejects a foreign transaction owner and still cleans the one-shot job", async () => {
  let cleaned = false;
  await assert.rejects(runWorkerFixture({
    argv: argv(),
    engineFactory: () => ({ readActive: async () => preparedReceipt({ transactionId: `main-${"b".repeat(32)}` }) }),
    cleanupImpl: async () => { cleaned = true; },
  }), /does not own/u);
  assert.equal(cleaned, true);
});


test("detached old-A macOS launchd worker reconstructs trusted managed release without forwarded identity fields", async (t) => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "equinox-worker-native-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const homeDir = path.join(root, "home");
  const installRoot = path.join(homeDir, "Library", "Application Support", "Equinox Local");
  const releaseDir = path.join(installRoot, "releases", "5.2.1");
  await fs.mkdir(releaseDir, { recursive: true });
  await fs.symlink(path.join("releases", "5.2.1"), path.join(installRoot, "current"));
  const identity = await resolveEquinoxLocalMainWorkerNativeInstallation({
    transactionRoot: path.join(installRoot, "main-update"), env: { HOME: homeDir, PATH: "/usr/bin:/bin" },
    platform: "darwin", arch: "arm64",
  });
  assert.equal(identity.managed, true);
  assert.equal(identity.selfUpdateSupported, true);
  assert.equal(identity.target, "darwin-arm64");
  assert.equal(identity.installRoot, installRoot);
  assert.equal(identity.releaseDir, releaseDir);
  await assert.rejects(resolveEquinoxLocalMainWorkerNativeInstallation({
    transactionRoot: path.join(root, "other", "main-update"), env: { HOME: homeDir }, platform: "darwin", arch: "arm64",
  }), /transaction root/u);
  await fs.rm(path.join(installRoot, "current"));
  await fs.symlink(path.join(root, "outside"), path.join(installRoot, "current"));
  await assert.rejects(resolveEquinoxLocalMainWorkerNativeInstallation({
    transactionRoot: path.join(installRoot, "main-update"), env: { HOME: homeDir }, platform: "darwin", arch: "arm64",
  }));
});

test("worker prepares exact native candidate and durable rollback lifecycle before handoff", async () => {
  const events = [];
  const candidate = { sourceSha: B, target: "darwin-arm64", runtimeContractSha256: DIGEST_B, releaseDir: `${STATE}/staging/${TX}/native-candidate/release` };
  const lifecycle = { activate: async () => {}, rollback: async () => {}, commit: async () => {} };
  const transition = { mode: "artifact_required", target: "darwin-arm64", currentSha: A, targetSha: B, currentRuntimeContractSha256: DIGEST_A, targetRuntimeContractSha256: DIGEST_B };
  const engine = {
    paths: { sourcePointerPath: `${STATE}/current-source.conf` },
    readActive: async () => preparedReceipt(),
    abortPreparedPromotion: async () => assert.fail("valid native preparation must not abort"),
    markNativeRollbackReady: async (id) => { events.push(["rollback-ready", id]); return preparedReceipt({ stage: "native_rollback_ready" }); },
  };
  const result = await runWorkerFixture({
    argv: argv(),
    engineFactory: () => engine,
    resolveHostTarget: () => "darwin-arm64",
    planNativeTransition: async (value) => { events.push(["plan", value]); return transition; },
    resolveNativeInstallation: async () => ({ managed: true, selfUpdateSupported: true, target: "darwin-arm64" }),
    ensureNativeArtifact: async () => {},
    prepareNativeCandidate: async (value) => { events.push(["candidate", value]); return candidate; },
    prepareNativeLifecycle: async (value) => { events.push(["native-lifecycle", value]); return lifecycle; },
    handoffImpl: async (value) => { events.push(["handoff", value]); return { status: "succeeded" }; },
    cleanupImpl: async () => events.push(["cleanup"]),
  });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(events.map(([name]) => name), ["plan", "candidate", "native-lifecycle", "rollback-ready", "handoff", "cleanup"]);
  assert.equal(events[1][1].sourceSha, B);
  assert.equal(events[1][1].expectedRuntimeContractSha256, DIGEST_B);
  assert.equal(events[2][1].transition, transition);
  assert.equal(events[4][1].nativeLifecycle, lifecycle);
});

test("worker aborts its own prepared transaction when native admission revalidation fails", async () => {
  const events = [];
  const transition = { mode: "artifact_required", target: "darwin-arm64", currentSha: A, targetSha: B, currentRuntimeContractSha256: DIGEST_A, targetRuntimeContractSha256: DIGEST_B };
  const engine = {
    paths: { sourcePointerPath: `${STATE}/current-source.conf` },
    readActive: async () => preparedReceipt(),
    abortPreparedPromotion: async (...args) => events.push(["abort", ...args]),
  };
  await assert.rejects(runWorkerFixture({
    argv: argv(),
    engineFactory: () => engine,
    resolveHostTarget: () => "darwin-arm64",
    planNativeTransition: async () => transition,
    resolveNativeInstallation: async () => ({ managed: true, selfUpdateSupported: true, target: "darwin-arm64" }),
    ensureNativeArtifact: async () => {},
    prepareNativeCandidate: async () => { throw new Error("local artifact digest drift"); },
    handoffImpl: async () => assert.fail("admission failure must happen before handoff"),
    cleanupImpl: async () => events.push(["cleanup"]),
  }), /artifact digest drift/u);
  assert.equal(events[0][0], "abort");
  assert.equal(events[0][1], TX);
  assert.match(events[0][2], /artifact digest drift/u);
  assert.deepEqual(events[0][3], { stage: "native_admission_failed" });
  assert.equal(events.at(-1)[0], "cleanup");
});

test("worker resumes native_switched from durable native recovery without candidate extraction", async () => {
  const events = [];
  const transition = { mode: "artifact_required", target: "darwin-arm64", currentSha: A, targetSha: B, currentRuntimeContractSha256: DIGEST_A, targetRuntimeContractSha256: DIGEST_B };
  const lifecycle = { activate: async () => {}, rollback: async () => {}, commit: async () => {} };
  const receipt = preparedReceipt({ stage: "native_switched" });
  const engine = { paths: { sourcePointerPath: `${STATE}/current-source.conf` }, readActive: async () => receipt };
  const result = await runWorkerFixture({
    argv: argv(), engineFactory: () => engine, resolveHostTarget: () => "darwin-arm64",
    planNativeTransition: async () => transition,
    resolveNativeInstallation: async () => ({ managed: true, selfUpdateSupported: true, target: "darwin-arm64" }),
    prepareNativeCandidate: async () => assert.fail("recovery must not re-extract candidate"),
    prepareNativeLifecycle: async () => assert.fail("recovery must reconstruct durable lifecycle"),
    recoverNativeLifecycle: async (value) => { events.push(["recover-native", value]); return lifecycle; },
    handoffImpl: async (value) => { events.push(["handoff", value]); return { status: "succeeded" }; },
    cleanupImpl: async () => events.push(["cleanup"]),
  });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(events.map(([name]) => name), ["recover-native", "handoff", "cleanup"]);
  assert.equal(events[1][1].initialReceipt.stage, "native_switched");
  assert.equal(events[1][1].nativeLifecycle, lifecycle);
});

test("worker resumes source_switched reuse_native without touching native state", async () => {
  const events = [];
  const receipt = preparedReceipt({ status: "verifying", stage: "source_switched" });
  const engine = { paths: { sourcePointerPath: `${STATE}/current-source.conf` }, readActive: async () => receipt };
  await runWorkerFixture({
    argv: argv(), engineFactory: () => engine, resolveHostTarget: () => "darwin-arm64",
    planNativeTransition: async () => reuseTransition(),
    recoverNativeLifecycle: async () => assert.fail("reuse_native must not recover native state"),
    handoffImpl: async (value) => { events.push(value); return { status: "succeeded" }; }, cleanupImpl: async () => {},
  });
  assert.equal(events[0].initialReceipt.stage, "source_switched");
  assert.equal(events[0].nativeLifecycle, null);
});

test("worker retains ownership as rollback_failed when post-switch native recovery cannot be proven", async () => {
  const calls = [];
  const transition = { mode: "artifact_required", target: "darwin-arm64", currentSha: A, targetSha: B, currentRuntimeContractSha256: DIGEST_A, targetRuntimeContractSha256: DIGEST_B };
  const receipt = preparedReceipt({ stage: "native_switched" });
  const engine = {
    paths: { sourcePointerPath: `${STATE}/current-source.conf` }, readActive: async () => receipt,
    abortPreparedPromotion: async () => assert.fail("post-switch recovery must never use pre-switch abort"),
    markRollbackFailed: async (...args) => calls.push(["rollback-failed", ...args]),
  };
  await assert.rejects(runWorkerFixture({
    argv: argv(), engineFactory: () => engine, resolveHostTarget: () => "darwin-arm64", planNativeTransition: async () => transition,
    resolveNativeInstallation: async () => ({ managed: true, selfUpdateSupported: true, target: "darwin-arm64" }),
    recoverNativeLifecycle: async () => { throw new Error("rollback descriptor drift"); }, cleanupImpl: async () => calls.push(["cleanup"]),
  }), /descriptor drift/u);
  assert.equal(calls[0][0], "rollback-failed");
  assert.equal(calls[0][1], TX);
  assert.equal(calls.at(-1)[0], "cleanup");
});

test("worker releases a stale terminal success lock without replaying mutation", async () => {
  const calls = [];
  const receipt = preparedReceipt({ status: "succeeded", stage: "healthy" });
  const engine = { readActive: async () => receipt, releaseStagedLock: async (id) => calls.push(id) };
  const result = await runWorkerFixture({ argv: argv(), engineFactory: () => engine, planNativeTransition: async () => assert.fail("terminal receipt must not replan"), cleanupImpl: async () => {} });
  assert.equal(result.status, "succeeded");
  assert.equal(result.recovered, true);
  assert.deepEqual(calls, [TX]);
});


test("Main worker never reports success while signed Guardian terminal owner remains unresolved", async () => {
  const receipt = preparedReceipt({ status: "succeeded", stage: "healthy" });
  const engine = {
    readActive: async () => receipt,
    releaseStagedLock: async () => true,
  };
  await assert.rejects(runWorkerFixture({
    argv: argv(), engineFactory: () => engine, resolveHostTarget: () => "darwin-arm64",
    planNativeTransition: async () => assert.fail("resumed terminal receipt must not replay native B"),
    cleanupImpl: async () => ({ cleaned: false, pendingNativeOwner: true }),
  }), /signed native Guardian owner did not verify terminal A\/B completion/u);
  const recovered = await runWorkerFixture({
    argv: argv(), engineFactory: () => engine, resolveHostTarget: () => "darwin-arm64",
    planNativeTransition: async () => assert.fail("resumed terminal receipt must not replay native B"),
    cleanupImpl: async () => ({ cleaned: true, nativeOwner: true }),
  });
  assert.equal(recovered.status, "succeeded");

  await assert.rejects(runWorkerFixture({
    argv: argv(),
    engineFactory: () => ({ readActive: async () => { throw new Error("original transaction still broken"); } }),
    cleanupImpl: async () => ({ cleaned: false, pendingNativeOwner: true }),
  }), /original transaction still broken/u);
});

test("native health rejects healthy A until restarted Control Center actually serves exact source B", async () => {
  const states = [
    { server: { version: "6.1.0" }, health: { state: "HEALTHY" }, installation: { kind: "managed-source", sourceSha: A } },
    { server: { version: "6.1.1" }, health: { state: "HEALTHY" }, installation: { kind: "managed", sourceSha: B } },
    { server: { version: "6.1.1" }, health: { state: "HEALTHY" }, installation: { kind: "managed-source", sourceSha: B } },
  ];
  let requests = 0;
  const result = await waitForExactSourceHealth({
    sha: B, sourceRoot: SOURCE, pointerPath: `${STATE}/current-source.conf`, gitPath: "/pinned/git",
    attempts: states.length, sleepImpl: async () => {},
    readPointerImpl: async () => ({ sha: B, sourceRoot: SOURCE }),
    inspectCheckoutImpl: async () => ({ eligible: true, currentSha: B }),
    readVersionImpl: async () => "6.1.1",
    fetchImpl: async () => ({ ok: true, json: async () => ({ status: states[requests++] }) }),
  });
  assert.equal(result, true);
  assert.equal(requests, 3, "old A and Stable must never be mistaken for restarted managed-source B");
});

test("native health fails closed when old A remains HEALTHY after requested restart", async () => {
  let requests = 0;
  await assert.rejects(waitForExactSourceHealth({
    sha: B, sourceRoot: SOURCE, pointerPath: `${STATE}/current-source.conf`, attempts: 2,
    readPointerImpl: async () => ({ sha: B, sourceRoot: SOURCE }),
    inspectCheckoutImpl: async () => ({ eligible: true, currentSha: B }),
    readVersionImpl: async () => "6.1.1",
    sleepImpl: async () => {},
    fetchImpl: async () => { requests++; return { ok: true, json: async () => ({ status: { health: { state: "HEALTHY" }, installation: { kind: "managed-source", sourceSha: A } } }) }; },
  }), /has not converged/u);
  assert.equal(requests, 2);
});

test("Main health rejects old runtime version even when the source pointer and reported source SHA already say B", async () => {
  let requests = 0;
  await assert.rejects(waitForExactSourceHealth({
    sha: B, sourceRoot: SOURCE, pointerPath: `${STATE}/current-source.conf`, attempts: 2,
    readPointerImpl: async () => ({ sha: B, sourceRoot: SOURCE }),
    inspectCheckoutImpl: async () => ({ eligible: true, currentSha: B }),
    readVersionImpl: async () => "6.1.1",
    sleepImpl: async () => {},
    fetchImpl: async () => {
      requests++;
      return { ok: true, json: async () => ({ status: {
        server: { version: "6.1.0" }, health: { state: "HEALTHY" },
        installation: { kind: "managed-source", sourceSha: B },
      } }) };
    },
  }), /has not converged/u);
  assert.equal(requests, 2);
});

test("Main worker passes pinned Windows Git shell into recovery engine", async () => {
  let options;
  await runWorkerFixture({
    argv: argv(), resolveHostTarget: () => "win32-arm64",
    engineFactory: (input) => { options = input; return { readActive: async () => preparedReceipt({ status: "succeeded", stage: "healthy" }), releaseStagedLock: async () => true }; },
    cleanupImpl: async () => {},
  });
  assert.match(options.shellPath, /\\git\\[^\\]+\\win32-arm64\\usr\\bin\\sh\.exe$/iu);
  assert.match(options.gitPath, /\\cmd\\git\.exe$/iu);
});

test("detached worker rejects existing symlink native staging before trusting candidate or WPF owner", async () => {
  const events = [];
  const transition = {mode:"artifact_required",target:"win32-x64",currentSha:A,targetSha:B,
    currentRuntimeContractSha256:DIGEST_A,targetRuntimeContractSha256:DIGEST_B};
  const receipt = preparedReceipt();
  const engine = {
    readActive: async () => receipt,
    abortPreparedPromotion: async (id, message, options) => events.push(["abort",id,message,options]),
  };
  await assert.rejects(runWorkerFixture({
    argv:argv(), resolveHostTarget:()=> "win32-x64", engineFactory:()=>engine,
    planNativeTransition:async()=>transition,
    resolveNativeInstallation:async()=>({managed:true,selfUpdateSupported:true,target:"win32-x64"}),
    fsImpl:{lstat:async()=>({isDirectory:()=>true,isSymbolicLink:()=>true})},
    prepareNativeCandidate:async()=>assert.fail("symlinked native stage must not be admitted"),
    admitWindowsNativeWorker:async()=>assert.fail("symlinked native stage must not reach OS owner"),
    prepareNativeLifecycle:async()=>assert.fail("symlinked native stage must not activate native"),
    cleanupImpl:async()=>events.push(["cleanup"]),
  }), /artifact stage is not a safe directory/u);
  assert.deepEqual(events.map(([event])=>event),["abort","cleanup"]);
  assert.equal(events[0][1],TX);
  assert.deepEqual(events[0][3],{stage:"native_admission_failed"});
});

test("worker refuses a forensic rollback_failed receipt without replaying native mutation", async () => {
  const events=[];
  const receipt=preparedReceipt({status:"rollback_failed",stage:"rollback_failed"});
  await assert.rejects(runWorkerFixture({
    argv:argv(),engineFactory:()=>({readActive:async()=>receipt}),
    planNativeTransition:async()=>assert.fail("failed rollback must not be re-planned"),
    handoffImpl:async()=>assert.fail("failed rollback must not handoff"),
    cleanupImpl:async()=>events.push("cleanup"),
  }),/cannot resume a transaction whose rollback already failed/u);
  assert.deepEqual(events,["cleanup"],"forensic owner must be retained but detached job cleaned");
});

test("Git-free Main native health accepts exact B full SHA and rejects healthy same-version A and Stable",async()=>{
 const B_SHA="e".repeat(40);
 const contract="c".repeat(64);
 const version="6.2.1";
 const baseline={sourceSha:B_SHA,target:"win32-x64",runtimeContractSha256:contract,payloadVersion:version};
 const statuses=[
  {kind:"managed-main",sourceSha:A,mainNativeSha:A,target:"win32-x64"},
  {kind:"managed",sourceSha:B_SHA,mainNativeSha:B_SHA,target:"win32-x64"},
  {kind:"managed-main",sourceSha:B_SHA,mainNativeSha:B_SHA,target:"darwin-arm64"},
  {kind:"managed-main",sourceSha:B_SHA,mainNativeSha:B_SHA,target:"win32-x64"},
 ];
 let request=0;
 const result=await waitForExactNativeMainHealth({
  transactionRoot:STATE,sourceSha:B_SHA,target:"win32-x64",version,
  runtimeContractSha256:contract,attempts:4,sleepImpl:async()=>{},
  readNativePointerImpl:async()=>baseline,
  fetchImpl:async()=>({status:200,json:async()=>({status:{
    health:{state:"HEALTHY"},server:{version},
    installation:statuses[request++],
  }})}),
 });
 assert.equal(result,true);
 assert.equal(request,4,"only the exact B runtime may satisfy the native health gate");
});

test("Git-free native health rejects wrong durable B SHA, contract, target or version before touching status endpoint",async()=>{
 const input={transactionRoot:STATE,sourceSha:B,target:"darwin-arm64",
   version:"6.2.1",runtimeContractSha256:DIGEST_B,attempts:1};
 for(const pointer of [
  {sourceSha:A,target:"darwin-arm64",runtimeContractSha256:DIGEST_B,payloadVersion:"6.2.1"},
  {sourceSha:B,target:"win32-x64",runtimeContractSha256:DIGEST_B,payloadVersion:"6.2.1"},
  {sourceSha:B,target:"darwin-arm64",runtimeContractSha256:DIGEST_A,payloadVersion:"6.2.1"},
  {sourceSha:B,target:"darwin-arm64",runtimeContractSha256:DIGEST_B,payloadVersion:"6.2.0"},
 ]){
  await assert.rejects(waitForExactNativeMainHealth({
   ...input,readNativePointerImpl:async()=>pointer,
   fetchImpl:async()=>assert.fail("mismatched durable source identity must never call HTTP"),
  }),/Installed native pointer does not match/u);
 }
 for(const override of [{sourceSha:"bad"},{target:"linux-x64"},{version:"6.2.1-rc"},{runtimeContractSha256:"bad"},
   {attempts:0},{attempts:500},{transactionRoot:"relative"}]){
  await assert.rejects(waitForExactNativeMainHealth({...input,...override,
   readNativePointerImpl:async()=>assert.fail("invalid identity must not read durable native store"),
  }),/identity or bounded attempts are invalid/u);
 }
});

test("Git-free native health rejects healthy old A process and never compares manual versions alone",async()=>{
 const input={transactionRoot:STATE,sourceSha:B,target:"win32-x64",
  version:"6.2.1",runtimeContractSha256:DIGEST_B,attempts:2,sleepImpl:async()=>{},
  readNativePointerImpl:async()=>({sourceSha:B,target:"win32-x64",runtimeContractSha256:DIGEST_B,payloadVersion:"6.2.1"})};
 let calls=0;
 await assert.rejects(waitForExactNativeMainHealth({...input,fetchImpl:async()=>{
  calls++;
  return {status:200,json:async()=>({status:{health:{state:"HEALTHY"},server:{version:"6.2.1"},
    installation:{kind:"managed-main",sourceSha:A,mainNativeSha:A,target:"win32-x64"}}})};
 }}),/has not converged/u);
 assert.equal(calls,2);
});

test("Git-free native health detects native A/B pointer drift after a perfect B HTTP response",async()=>{
 const input={transactionRoot:STATE,sourceSha:B,target:"win32-x64",
  version:"6.2.1",runtimeContractSha256:DIGEST_B,attempts:1};
 let reads=0;
 await assert.rejects(waitForExactNativeMainHealth({...input,
  readNativePointerImpl:async()=>({sourceSha:++reads===1?B:A,
   target:"win32-x64",runtimeContractSha256:DIGEST_B,payloadVersion:"6.2.1"}),
  fetchImpl:async()=>({status:200,json:async()=>({status:{health:{state:"HEALTHY"},
   server:{version:"6.2.1"},installation:{kind:"managed-main",sourceSha:B,mainNativeSha:B,target:"win32-x64"}}})}),
 }),/has not converged/u);
 assert.equal(reads,2);
});
