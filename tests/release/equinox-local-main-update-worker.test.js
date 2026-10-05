import assert from "node:assert/strict";
import test from "node:test";

import { runEquinoxLocalMainUpdateWorker } from "../../src/equinox-local-main-update-worker.js";

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

test("launchd worker consumes only the prepared transaction it owns and cleans up after success", async () => {
  const events = [];
  const engine = { paths: { sourcePointerPath: `${STATE}/current-source.conf` }, readActive: async () => preparedReceipt(), abortPreparedPromotion: async () => assert.fail("success must not abort") };
  const result = await runEquinoxLocalMainUpdateWorker({
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
  await assert.rejects(runEquinoxLocalMainUpdateWorker({
    argv: argv(),
    engineFactory: () => ({ readActive: async () => ({ transactionId: TX, status: "staged", stage: "staged" }) }),
    cleanupImpl: async () => events.push("cleanup"),
  }), /requires a resumable promotion receipt/u);
  assert.deepEqual(events, ["cleanup"]);
});

test("worker rejects a foreign transaction owner and still cleans the one-shot job", async () => {
  let cleaned = false;
  await assert.rejects(runEquinoxLocalMainUpdateWorker({
    argv: argv(),
    engineFactory: () => ({ readActive: async () => preparedReceipt({ transactionId: `main-${"b".repeat(32)}` }) }),
    cleanupImpl: async () => { cleaned = true; },
  }), /does not own/u);
  assert.equal(cleaned, true);
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
  const result = await runEquinoxLocalMainUpdateWorker({
    argv: argv(),
    engineFactory: () => engine,
    resolveHostTarget: () => "darwin-arm64",
    planNativeTransition: async (value) => { events.push(["plan", value]); return transition; },
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
  await assert.rejects(runEquinoxLocalMainUpdateWorker({
    argv: argv(),
    engineFactory: () => engine,
    resolveHostTarget: () => "darwin-arm64",
    planNativeTransition: async () => transition,
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
  const result = await runEquinoxLocalMainUpdateWorker({
    argv: argv(), engineFactory: () => engine, resolveHostTarget: () => "darwin-arm64",
    planNativeTransition: async () => transition,
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
  await runEquinoxLocalMainUpdateWorker({
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
  await assert.rejects(runEquinoxLocalMainUpdateWorker({
    argv: argv(), engineFactory: () => engine, resolveHostTarget: () => "darwin-arm64", planNativeTransition: async () => transition,
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
  const result = await runEquinoxLocalMainUpdateWorker({ argv: argv(), engineFactory: () => engine, planNativeTransition: async () => assert.fail("terminal receipt must not replan"), cleanupImpl: async () => {} });
  assert.equal(result.status, "succeeded");
  assert.equal(result.recovered, true);
  assert.deepEqual(calls, [TX]);
});
