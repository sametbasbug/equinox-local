import assert from "node:assert/strict";
import test from "node:test";

import { runEquinoxLocalMainUpdateHandoff } from "../../src/equinox-local-main-update-handoff.js";

function engineFixture({ rollbackThrows = null } = {}) {
  const calls = [];
  let status = "promoting";
  const receipt = {
    transactionId: "main-" + "a".repeat(32),
    currentSha: "1".repeat(40),
    targetSha: "2".repeat(40),
    rollbackSha: "1".repeat(40),
    rollbackSourceRoot: "/tmp/source-a",
    targetSourceRoot: "/tmp/source-b",
  };
  return {
    calls,
    engine: {
      async markNativeSwitched(id) { calls.push(["native_switched", id]); return { ...receipt, status: "promoting", stage: "native_switched" }; },
      async activatePromotion(id) { calls.push(["activate", id]); status = "verifying"; return { ...receipt, status, stage: "source_switched" }; },
      async rollbackPromotion(id, failure, options = {}) { calls.push(["rollback", id, failure, options]); if (rollbackThrows) throw rollbackThrows; status = options.nativeRollbackPending ? "verifying" : "rolled_back"; return { ...receipt, status, stage: "rollback_source_restored", lastError: failure }; },
      async markNativeRollbackRestored(id) { calls.push(["native_restored", id]); status = "verifying"; return { ...receipt, status, stage: "rollback_native_restored" }; },
      async markRollbackSucceeded(id) { calls.push(["rollback_success", id]); status = "rolled_back"; return { ...receipt, status, stage: "rollback_healthy" }; },
      async markPromotionSucceeded(id) { calls.push(["success", id]); status = "succeeded"; return { ...receipt, status, stage: "healthy" }; },
      async markRollbackFailed(id, failure) { calls.push(["rollback_failed", id, failure]); status = "rollback_failed"; return { ...receipt, status, stage: "rollback_failed", lastError: failure }; },
      async releaseStagedLock(id) { calls.push(["release", id]); return true; },
    },
    receipt,
  };
}

test("handoff accepts target only after restart and exact runtime health pass", async () => {
  const f = engineFixture();
  const restarts = [];
  const verifies = [];
  const result = await runEquinoxLocalMainUpdateHandoff({
    engine: f.engine,
    transactionId: f.receipt.transactionId,
    restartRuntime: async (value) => restarts.push(value),
    verifyRuntime: async (value) => { verifies.push(value); return true; },
  });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(f.calls.map(([name]) => name), ["activate", "success", "release"]);
  assert.equal(restarts.length, 1); assert.equal(restarts[0].sha, f.receipt.targetSha); assert.equal(restarts[0].rollback, false);
  assert.equal(verifies.length, 1); assert.equal(verifies[0].sha, f.receipt.targetSha);
});

test("target health failure restores old pointer then restarts and verifies rollback runtime", async () => {
  const f = engineFixture();
  const restarts = [];
  const result = await runEquinoxLocalMainUpdateHandoff({
    engine: f.engine,
    transactionId: f.receipt.transactionId,
    restartRuntime: async (value) => restarts.push(value),
    verifyRuntime: async ({ rollback }) => rollback === true,
  });
  assert.equal(result.status, "rolled_back");
  assert.match(result.targetError.message, /did not pass health/u);
  assert.deepEqual(f.calls.map(([name]) => name), ["activate", "rollback", "release"]);
  assert.deepEqual(restarts.map(({ sha, rollback }) => [sha, rollback]), [[f.receipt.targetSha, false], [f.receipt.rollbackSha, true]]);
});

test("rollback health failure is loud and keeps transaction locked as rollback_failed", async () => {
  const f = engineFixture();
  await assert.rejects(runEquinoxLocalMainUpdateHandoff({
    engine: f.engine,
    transactionId: f.receipt.transactionId,
    restartRuntime: async () => {},
    verifyRuntime: async () => false,
  }), /target failed and rollback did not recover/u);
  assert.deepEqual(f.calls.map(([name]) => name), ["activate", "rollback", "rollback_failed"]);
  assert.equal(f.calls.some(([name]) => name === "release"), false);
});

test("rollback pointer failure is loud and records rollback_failed without releasing ownership", async () => {
  const f = engineFixture({ rollbackThrows: new Error("pointer restore failed") });
  await assert.rejects(runEquinoxLocalMainUpdateHandoff({
    engine: f.engine,
    transactionId: f.receipt.transactionId,
    restartRuntime: async () => { throw new Error("target restart failed"); },
    verifyRuntime: async () => true,
  }), /pointer restore failed/u);
  assert.deepEqual(f.calls.map(([name]) => name), ["activate", "rollback", "rollback_failed"]);
});


test("native-impact handoff switches native before source and commits native identity only after target health", async () => {
  const f = engineFixture();
  const events = [];
  const result = await runEquinoxLocalMainUpdateHandoff({
    engine: f.engine,
    transactionId: f.receipt.transactionId,
    nativeLifecycle: {
      activate: async () => events.push("native-activate"),
      rollback: async () => assert.fail("healthy target must not rollback native"),
      commit: async () => events.push("native-commit"),
    },
    restartRuntime: async () => events.push("restart"),
    verifyRuntime: async () => { events.push("health"); return true; },
  });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(events, ["native-activate", "restart", "health", "native-commit"]);
  assert.deepEqual(f.calls.map(([name]) => name), ["native_switched", "activate", "success", "release"]);
});

test("native-impact target failure restores source and native before rollback health becomes terminal", async () => {
  const f = engineFixture();
  const events = [];
  const result = await runEquinoxLocalMainUpdateHandoff({
    engine: f.engine,
    transactionId: f.receipt.transactionId,
    nativeLifecycle: {
      activate: async () => events.push("native-activate"),
      rollback: async ({ nativeActivated }) => events.push(`native-rollback:${nativeActivated}`),
      commit: async () => assert.fail("failed target must not commit native pointer"),
    },
    restartRuntime: async ({ rollback }) => events.push(rollback ? "restart-rollback" : "restart-target"),
    verifyRuntime: async ({ rollback }) => rollback === true,
  });
  assert.equal(result.status, "rolled_back");
  assert.deepEqual(events, ["native-activate", "restart-target", "native-rollback:true", "restart-rollback"]);
  assert.deepEqual(f.calls.map(([name]) => name), ["native_switched", "activate", "rollback", "native_restored", "rollback_success", "release"]);
  assert.deepEqual(f.calls.find(([name]) => name === "rollback")[3], { nativeRollbackPending: true });
});

test("handoff resumes native_rollback_ready by ensuring native then switching source", async () => {
  const f = engineFixture();
  const events = [];
  const initial = { ...f.receipt, status: "promoting", stage: "native_rollback_ready" };
  await runEquinoxLocalMainUpdateHandoff({
    engine: f.engine, transactionId: f.receipt.transactionId, initialReceipt: initial,
    nativeLifecycle: { activate: async () => events.push("ensure-target-native"), rollback: async () => {}, commit: async () => events.push("commit-native") },
    restartRuntime: async () => events.push("restart-target"), verifyRuntime: async () => true,
  });
  assert.deepEqual(events, ["ensure-target-native", "restart-target", "commit-native"]);
  assert.deepEqual(f.calls.map(([name]) => name), ["native_switched", "activate", "success", "release"]);
});

test("handoff resumes native_switched without rewriting native receipt stage", async () => {
  const f = engineFixture();
  const initial = { ...f.receipt, status: "promoting", stage: "native_switched" };
  let ensured = 0;
  await runEquinoxLocalMainUpdateHandoff({
    engine: f.engine, transactionId: f.receipt.transactionId, initialReceipt: initial,
    nativeLifecycle: { activate: async () => { ensured += 1; }, rollback: async () => {}, commit: async () => {} },
    restartRuntime: async () => {}, verifyRuntime: async () => true,
  });
  assert.equal(ensured, 1);
  assert.deepEqual(f.calls.map(([name]) => name), ["activate", "success", "release"]);
});

test("handoff resumes source_switched without switching source twice", async () => {
  const f = engineFixture();
  const initial = { ...f.receipt, status: "verifying", stage: "source_switched" };
  const events = [];
  await runEquinoxLocalMainUpdateHandoff({
    engine: f.engine, transactionId: f.receipt.transactionId, initialReceipt: initial,
    nativeLifecycle: { activate: async () => events.push("ensure-target-native"), rollback: async () => {}, commit: async () => events.push("commit-native") },
    restartRuntime: async ({ sha }) => events.push(`restart:${sha}`), verifyRuntime: async () => true,
  });
  assert.deepEqual(f.calls.map(([name]) => name), ["success", "release"]);
  assert.deepEqual(events, ["ensure-target-native", `restart:${f.receipt.targetSha}`, "commit-native"]);
});

test("handoff resumes rollback_source_restored by restoring native then verifying rollback health", async () => {
  const f = engineFixture();
  const initial = { ...f.receipt, status: "verifying", stage: "rollback_source_restored", lastError: "target failed" };
  const events = [];
  const result = await runEquinoxLocalMainUpdateHandoff({
    engine: f.engine, transactionId: f.receipt.transactionId, initialReceipt: initial,
    nativeLifecycle: { activate: async () => {}, rollback: async () => events.push("ensure-old-native"), commit: async () => {} },
    restartRuntime: async ({ rollback }) => events.push(`restart:${rollback}`), verifyRuntime: async ({ rollback }) => rollback,
  });
  assert.equal(result.status, "rolled_back");
  assert.deepEqual(events, ["ensure-old-native", "restart:true"]);
  assert.deepEqual(f.calls.map(([name]) => name), ["native_restored", "rollback_success", "release"]);
});

test("handoff resumes rollback_native_restored with exact native revalidation", async () => {
  const f = engineFixture();
  const initial = { ...f.receipt, status: "verifying", stage: "rollback_native_restored", lastError: "target failed" };
  let restores = 0;
  await runEquinoxLocalMainUpdateHandoff({
    engine: f.engine, transactionId: f.receipt.transactionId, initialReceipt: initial,
    nativeLifecycle: { activate: async () => {}, rollback: async () => { restores += 1; }, commit: async () => {} },
    restartRuntime: async () => {}, verifyRuntime: async () => true,
  });
  assert.equal(restores, 1);
  assert.deepEqual(f.calls.map(([name]) => name), ["rollback_success", "release"]);
});
