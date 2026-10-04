import assert from "node:assert/strict";
import test from "node:test";

import { runEquinoxLocalMainUpdateWorker } from "../../src/equinox-local-main-update-worker.js";

const TX = `main-${"a".repeat(32)}`;
const SOURCE = "/private/tmp/equinox-source-a";
const STATE = "/private/tmp/equinox-main-state";

function argv() {
  return ["--transaction-id", TX, "--source-root", SOURCE, "--transaction-root", STATE];
}

test("launchd worker consumes only the prepared transaction it owns and cleans up after success", async () => {
  const events = [];
  const engine = { paths: { sourcePointerPath: `${STATE}/current-source.conf` }, readActive: async () => ({ transactionId: TX, status: "promoting", stage: "ready_to_switch" }) };
  const result = await runEquinoxLocalMainUpdateWorker({
    argv: argv(),
    engineFactory: (options) => { events.push(["engine", options]); return engine; },
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
  assert.deepEqual(events.map(([name]) => name), ["engine", "handoff", "restart", "verify", "cleanup"]);
  assert.equal(events[0][1].sourceRoot, SOURCE);
  assert.equal(events.at(-1)[1].transactionId, TX);
});

test("worker rejects an unprepared transaction but still removes launchd ownership", async () => {
  const events = [];
  await assert.rejects(runEquinoxLocalMainUpdateWorker({
    argv: argv(),
    engineFactory: () => ({ readActive: async () => ({ transactionId: TX, status: "staged", stage: "staged" }) }),
    cleanupImpl: async () => events.push("cleanup"),
  }), /requires a prepared promotion receipt/u);
  assert.deepEqual(events, ["cleanup"]);
});

test("worker rejects a foreign transaction owner and still cleans the one-shot job", async () => {
  let cleaned = false;
  await assert.rejects(runEquinoxLocalMainUpdateWorker({
    argv: argv(),
    engineFactory: () => ({ readActive: async () => ({ transactionId: `main-${"b".repeat(32)}`, status: "promoting", stage: "ready_to_switch" }) }),
    cleanupImpl: async () => { cleaned = true; },
  }), /does not own/u);
  assert.equal(cleaned, true);
});
