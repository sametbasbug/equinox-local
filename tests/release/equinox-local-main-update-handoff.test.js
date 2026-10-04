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
      async activatePromotion(id) { calls.push(["activate", id]); status = "verifying"; return { ...receipt, status, stage: "source_switched" }; },
      async rollbackPromotion(id, failure) { calls.push(["rollback", id, failure]); if (rollbackThrows) throw rollbackThrows; status = "rolled_back"; return { ...receipt, status, stage: "rollback_source_restored", lastError: failure }; },
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
