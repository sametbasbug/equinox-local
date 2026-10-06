import assert from "node:assert/strict";
import test from "node:test";

import { reconcileEquinoxLocalMainUpdate } from "../../src/equinox-local-main-update-recovery.js";

const TX = `main-${"a".repeat(32)}`;
const A = "1".repeat(40);
const B = "2".repeat(40);
const STATE = "/private/tmp/equinox-main-state";
const OLD = `${STATE}/sources/${A}`;
const NEW = `${STATE}/sources/${B}`;
function receipt(overrides = {}) { return { transactionId: TX, status: "promoting", stage: "native_switched", rollbackSha: A, currentSha: A, targetSha: B, rollbackSourceRoot: OLD, targetSourceRoot: NEW, ...overrides }; }
function engineWith(active, calls = []) { return { readActive: async () => active, releaseStagedLock: async (id) => calls.push(["release", id]) }; }
const exactInspect = async (root) => ({ eligible: true, currentSha: root === OLD ? A : B });

test("reconciler is idle without an active transaction", async () => {
  const result = await reconcileEquinoxLocalMainUpdate({ sourceRoot: OLD, transactionRoot: STATE, engineFactory: () => engineWith(null), inspectWorker: async () => ({ running: false }) });
  assert.deepEqual(result, { status: "idle" });
});

test("reconciler schedules one resumable worker only after exact rollback and target source validation", async () => {
  const calls = [];
  const active = receipt({ status: "verifying", stage: "source_switched" });
  const result = await reconcileEquinoxLocalMainUpdate({
    sourceRoot: NEW, transactionRoot: STATE, engineFactory: () => engineWith(active), inspectWorker: async () => ({ running: false }),
    inspectCheckout: async (root) => { calls.push(["inspect", root]); return await exactInspect(root); },
    cleanupWorker: async (value) => calls.push(["cleanup", value]),
    scheduleWorker: async (value) => { calls.push(["schedule", value]); return { scheduled: true }; },
  });
  assert.equal(result.status, "scheduled");
  assert.deepEqual(calls.slice(0, 2), [["inspect", OLD], ["inspect", NEW]]);
  assert.equal(calls[2][0], "cleanup");
  assert.equal(calls[3][0], "schedule");
  assert.equal(calls[3][1].sourceRoot, OLD);
  assert.equal(calls[3][1].workerPath, `${NEW}/src/equinox-local-main-update-worker.js`);
});

test("reconciler refuses source SHA drift before cleanup or scheduling", async () => {
  const calls = [];
  await assert.rejects(reconcileEquinoxLocalMainUpdate({
    sourceRoot: OLD, transactionRoot: STATE, engineFactory: () => engineWith(receipt()), inspectWorker: async () => ({ running: false }),
    inspectCheckout: async (root) => ({ eligible: true, currentSha: root === OLD ? A : A }),
    cleanupWorker: async () => calls.push("cleanup"), scheduleWorker: async () => calls.push("schedule"),
  }), /source identity/u);
  assert.deepEqual(calls, []);
});

test("rollback_failed stays locked and is never rescheduled", async () => {
  const calls = [];
  const result = await reconcileEquinoxLocalMainUpdate({
    sourceRoot: OLD, transactionRoot: STATE, engineFactory: () => engineWith(receipt({ status: "rollback_failed", stage: "rollback_failed" }), calls), inspectWorker: async () => ({ running: false }),
    cleanupWorker: async () => calls.push(["cleanup"]), scheduleWorker: async () => calls.push(["schedule"]),
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "rollback_failed");
  assert.deepEqual(calls, []);
});

test("terminal receipt cleans stale worker ownership and releases stale transaction lock", async () => {
  const calls = [];
  const active = receipt({ status: "succeeded", stage: "healthy" });
  const result = await reconcileEquinoxLocalMainUpdate({ sourceRoot: NEW, transactionRoot: STATE, engineFactory: () => engineWith(active, calls), inspectWorker: async () => ({ running: false }), cleanupWorker: async () => calls.push(["cleanup"]), scheduleWorker: async () => assert.fail("terminal receipt must not schedule") });
  assert.equal(result.status, "settled");
  assert.deepEqual(calls, [["cleanup"], ["release", TX]]);
});

test("pre-promotion interruption remains blocked instead of inventing unsafe replay", async () => {
  const result = await reconcileEquinoxLocalMainUpdate({ sourceRoot: OLD, transactionRoot: STATE, engineFactory: () => engineWith(receipt({ status: "staged", stage: "staged" })), inspectWorker: async () => ({ running: false }) });
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "not_resumable");
});


test("reconciler never interrupts an already running exact transaction worker", async () => {
  const calls = [];
  const result = await reconcileEquinoxLocalMainUpdate({
    sourceRoot: NEW, transactionRoot: STATE, engineFactory: () => engineWith(receipt({ status: "verifying", stage: "source_switched" })),
    inspectWorker: async () => ({ loaded: true, running: true }),
    inspectCheckout: async () => { calls.push("inspect"); return { eligible: true, currentSha: B }; },
    cleanupWorker: async () => calls.push("cleanup"), scheduleWorker: async () => calls.push("schedule"),
  });
  assert.equal(result.status, "worker_active");
  assert.deepEqual(calls, []);
});


test("reconciler blocks instead of double-scheduling when Windows ownership identity is uncertain", async () => {
  const calls = [];
  const result = await reconcileEquinoxLocalMainUpdate({
    sourceRoot: NEW,
    transactionRoot: STATE,
    engineFactory: () => engineWith(receipt({ status: "verifying", stage: "source_switched" })),
    inspectWorker: async (value) => {
      calls.push(["inspect-worker", value]);
      return { running: false, uncertain: true };
    },
    inspectCheckout: async () => { calls.push(["inspect-checkout"]); return { eligible: true, currentSha: B }; },
    cleanupWorker: async () => calls.push(["cleanup"]),
    scheduleWorker: async () => calls.push(["schedule"]),
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "worker_identity_uncertain");
  assert.equal(calls[0][1].transactionRoot, STATE);
  assert.equal(calls.some(([name]) => name === "inspect-checkout"), false);
  assert.equal(calls.some(([name]) => name === "schedule"), false);
});

test("reconciler cannot schedule a second worker when ownership cleanup refuses", async () => {
  const calls = [];
  const result = await reconcileEquinoxLocalMainUpdate({
    sourceRoot: NEW,
    transactionRoot: STATE,
    engineFactory: () => engineWith(receipt({ status: "verifying", stage: "source_switched" })),
    inspectWorker: async () => ({ running: false, stale: true, uncertain: false }),
    inspectCheckout: async (root) => { calls.push(["inspect", root]); return await exactInspect(root); },
    cleanupWorker: async () => { calls.push(["cleanup"]); return { cleaned: false, running: true }; },
    scheduleWorker: async () => { calls.push(["schedule"]); return { scheduled: true }; },
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "worker_active");
  assert.equal(calls.some(([name]) => name === "schedule"), false);
});
