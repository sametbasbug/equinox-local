import assert from "node:assert/strict";
import test from "node:test";

import { prepareAndScheduleEquinoxLocalMainUpdate } from "../../src/equinox-local-main-update-coordinator.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const TX = `main-${"c".repeat(32)}`;

test("coordinator initializes pointer, stages, prepares and schedules worker from durable target source", async () => {
  const events = [];
  const engine = {
    initializeSourcePointer: async () => events.push("pointer"),
    stage: async ({ currentSha, targetSha }) => { events.push(["stage", currentSha, targetSha]); return { receipt: { transactionId: TX } }; },
    preparePromotion: async (id) => { events.push(["prepare", id]); return { receipt: { transactionId: id }, targetSourceRoot: "/state/sources/target" }; },
    abortPreparedPromotion: async () => assert.fail("success path must not abort"),
  };
  const result = await prepareAndScheduleEquinoxLocalMainUpdate({
    sourceRoot: "/active",
    transactionRoot: "/state",
    currentSha: A,
    targetSha: B,
    engineFactory: () => engine,
    scheduleWorker: async (options) => { events.push(["schedule", options]); return { scheduled: true }; },
  });
  assert.equal(result.status, "scheduled");
  assert.equal(result.transactionId, TX);
  assert.deepEqual(events.map((entry) => Array.isArray(entry) ? entry[0] : entry), ["pointer", "stage", "prepare", "schedule"]);
  const options = events[3][1];
  assert.equal(options.workerPath, "/state/sources/target/src/equinox-local-main-update-worker.js");
  assert.equal(options.sourceRoot, "/active");
});

test("scheduler failure aborts only the still-unactivated prepared transaction", async () => {
  const events = [];
  const engine = {
    initializeSourcePointer: async () => {},
    stage: async () => ({ receipt: { transactionId: TX } }),
    preparePromotion: async () => ({ receipt: { transactionId: TX }, targetSourceRoot: "/state/sources/target" }),
    abortPreparedPromotion: async (id, failure) => events.push([id, failure]),
  };
  await assert.rejects(prepareAndScheduleEquinoxLocalMainUpdate({
    sourceRoot: "/active", transactionRoot: "/state", currentSha: A, targetSha: B,
    engineFactory: () => engine,
    scheduleWorker: async () => { throw new Error("launchd unavailable"); },
  }), /launchd unavailable/u);
  assert.deepEqual(events, [[TX, "launchd unavailable"]]);
});
