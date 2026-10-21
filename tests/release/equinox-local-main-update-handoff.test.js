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

test("Windows Main native ownership failure cannot commit a false-success receipt", async () => {
  const f = engineFixture();
  const actions = [];
  const result = await runEquinoxLocalMainUpdateHandoff({
    engine: f.engine, transactionId: f.receipt.transactionId,
    nativeLifecycle: {
      activate: async () => actions.push("activate-native-B"),
      rollback: async () => actions.push("restore-native-A"),
      verifyIntegration: async () => { actions.push("verify-installed-native-B"); throw new Error("WPF or Native Messaging still belongs to A"); },
      commit: async () => assert.fail("Unverified native B must not commit"),
    },
    restartRuntime: async ({ rollback }) => actions.push(rollback ? "restart-A" : "restart-B"),
    verifyRuntime: async ({ rollback }) => { actions.push(rollback ? "healthy-A" : "transient-healthy-B"); return true; },
  });
  assert.equal(result.status, "rolled_back");
  assert.match(result.targetError.message, /still belongs to A/u);
  assert.deepEqual(actions, ["activate-native-B", "restart-B", "transient-healthy-B", "verify-installed-native-B", "restore-native-A", "restart-A", "healthy-A"]);
  assert.equal(f.calls.some(([name]) => name === "success"), false);
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


test("journaled A/B handoff refuses partial milestone callbacks before native mutation", async () => {
  const f = engineFixture();
  await assert.rejects(runEquinoxLocalMainUpdateHandoff({
    engine: f.engine, transactionId: f.receipt.transactionId,
    nativeLifecycle: { journaledAB: true, activate: async () => assert.fail("must not start"), rollback: async () => {}, commit: async () => {} },
    restartRuntime: async () => {}, verifyRuntime: async () => true,
  }), /requires every verified milestone/u);
  assert.deepEqual(f.calls.map(([event]) => event), []);
});

test("native integration must re-check HEALTHY B; a reclaimed status port rolls back instead of committing", async () => {
  const fixture = engineFixture();
  const events = [];
  let checks = 0;
  const outcome = await runEquinoxLocalMainUpdateHandoff({
    engine: fixture.engine, transactionId: fixture.receipt.transactionId,
    nativeLifecycle: {
      activate: async () => events.push("activate B"),
      rollback: async () => events.push("restore A"),
      commit: async () => assert.fail("unhealthy B must not commit native pointer"),
      verifyIntegration: async () => { events.push("verify B shell and host"); return true; },
    },
    restartRuntime: async ({rollback}) => events.push(rollback ? "restart A" : "restart B"),
    verifyRuntime: async ({rollback}) => {
      if (rollback) { events.push("healthy A"); return true; }
      checks++;
      events.push(checks === 1 ? "initial healthy B" : "B lost HEALTHY");
      return checks === 1;
    },
  });
  assert.equal(outcome.status, "rolled_back");
  assert.match(outcome.targetError.message, /lost exact-source health/u);
  assert.deepEqual(events, [
    "activate B", "restart B", "initial healthy B", "verify B shell and host",
    "B lost HEALTHY", "restore A", "restart A", "healthy A",
  ]);
  assert.equal(fixture.calls.some(([name]) => name === "success"), false);
  assert.deepEqual(fixture.calls.map(([name]) => name),
    ["native_switched", "activate", "rollback", "native_restored", "rollback_success", "release"]);
});

test("terminal B receipt plus native cleanup failure never triggers destructive rollback", async () => {
  const fixture = engineFixture();
  const events = [];
  const journal = {
    journaledAB: true,
    activate: async () => events.push("native B"),
    rollback: async () => assert.fail("terminal B must never rollback"),
    commit: async () => events.push("native B commit"),
    recordRestarted: async () => events.push("restarted B"),
    recordHealthy: async () => events.push("healthy B"),
    recordRollbackHealthy: async () => assert.fail("no rollback"),
    finalizeCommitted: async () => { throw new Error("cannot remove A backup"); },
    finalizeRolledBack: async () => assert.fail("no rollback"),
  };
  await assert.rejects(runEquinoxLocalMainUpdateHandoff({
    engine: fixture.engine, transactionId: fixture.receipt.transactionId,
    nativeLifecycle: journal,
    restartRuntime: async () => events.push("restart B"),
    verifyRuntime: async () => true,
  }), (error) => {
    assert.equal(error.terminalReceipt, true);
    assert.match(error.message, /cleanup remains pending/u);
    return true;
  });
  assert.deepEqual(events, ["native B", "restart B", "restarted B", "healthy B", "native B commit"]);
  assert.deepEqual(fixture.calls.map(([name]) => name),
    ["native_switched", "activate", "success"]);
  assert.equal(fixture.calls.some(([name]) => name === "rollback" || name === "rollback_failed"), false);
});

test("missing admitted source root rejects B success and keeps owned A rollback explicit", async () => {
  const fixture = engineFixture();
  const engine = {...fixture.engine,
    activatePromotion: async (id) => {
      fixture.calls.push(["activate", id]);
      return {...fixture.receipt, targetSourceRoot: null};
    },
  };
  const seen = [];
  const result = await runEquinoxLocalMainUpdateHandoff({
    engine, transactionId: fixture.receipt.transactionId,
    restartRuntime: async ({sha,rollback}) => seen.push({sha,rollback}),
    verifyRuntime: async () => true,
  });
  assert.equal(result.status, "rolled_back");
  assert.match(result.targetError.message, /target source root is missing/u);
  assert.deepEqual(seen, [{sha:fixture.receipt.rollbackSha,rollback:true}]);
  assert.equal(fixture.calls.some(([name]) => name === "success"),false);
});
