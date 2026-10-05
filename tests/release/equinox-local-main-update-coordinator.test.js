import assert from "node:assert/strict";
import test from "node:test";

import { prepareAndScheduleEquinoxLocalMainUpdate } from "../../src/equinox-local-main-update-coordinator.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const TX = `main-${"c".repeat(32)}`;
const TARGET_ROOT = "/state/staging/transaction/source";
const DIGEST = "d".repeat(64);

function engineFixture(events) {
  return {
    initializeSourcePointer: async () => events.push("pointer"),
    stage: async ({ currentSha, targetSha }) => {
      events.push(["stage", currentSha, targetSha]);
      return { receipt: { transactionId: TX }, stagedSourceRoot: TARGET_ROOT };
    },
    preparePromotion: async (id) => {
      events.push(["prepare", id]);
      return { receipt: { transactionId: id }, targetSourceRoot: "/state/sources/target" };
    },
    abortStagedPreparation: async () => assert.fail("success path must not abort staged preparation"),
    abortPreparedPromotion: async () => assert.fail("success path must not abort prepared promotion"),
  };
}

function reuseTransition(target = "darwin-arm64") {
  return {
    mode: "reuse_native",
    target,
    currentSha: A,
    targetSha: B,
    currentRuntimeContractSha256: DIGEST,
    targetRuntimeContractSha256: DIGEST,
  };
}

test("coordinator reuses compatible native shell before preparing and scheduling durable target source", async () => {
  const events = [];
  const engine = engineFixture(events);
  const transition = reuseTransition();
  const result = await prepareAndScheduleEquinoxLocalMainUpdate({
    sourceRoot: "/active",
    transactionRoot: "/state",
    currentSha: A,
    targetSha: B,
    engineFactory: () => engine,
    resolveHostTarget: () => "darwin-arm64",
    planNativeTransition: async (options) => {
      events.push(["plan", options]);
      return transition;
    },
    stageNativeArtifact: async () => assert.fail("runtime-only transition must not fetch a native artifact"),
    scheduleWorker: async (options) => { events.push(["schedule", options]); return { scheduled: true }; },
  });

  assert.equal(result.status, "scheduled");
  assert.equal(result.transactionId, TX);
  assert.deepEqual(result.nativeTransition, transition);
  assert.deepEqual(events.map((entry) => Array.isArray(entry) ? entry[0] : entry), ["pointer", "stage", "plan", "prepare", "schedule"]);
  assert.deepEqual(events[2][1], {
    currentRoot: "/active",
    currentSha: A,
    targetRoot: TARGET_ROOT,
    targetSha: B,
    target: "darwin-arm64",
  });
  const options = events[4][1];
  assert.equal(options.workerPath, "/state/sources/target/src/equinox-local-main-update-worker.js");
  assert.equal(options.sourceRoot, "/active");
});

test("coordinator stages the exact host native snapshot before preparing a native-impact transition", async () => {
  const events = [];
  const engine = engineFixture(events);
  const targetDigest = "e".repeat(64);
  const transition = {
    mode: "artifact_required",
    target: "win32-x64",
    currentSha: A,
    targetSha: B,
    currentRuntimeContractSha256: DIGEST,
    targetRuntimeContractSha256: targetDigest,
  };
  const result = await prepareAndScheduleEquinoxLocalMainUpdate({
    sourceRoot: "/active",
    transactionRoot: "/state",
    currentSha: A,
    targetSha: B,
    engineFactory: () => engine,
    resolveHostTarget: () => "win32-x64",
    planNativeTransition: async (options) => { events.push(["plan", options]); return transition; },
    stageNativeArtifact: async (options) => { events.push(["native", options]); return { verified: true }; },
    scheduleWorker: async (options) => { events.push(["schedule", options]); return { scheduled: true }; },
  });

  assert.equal(result.status, "scheduled");
  assert.deepEqual(events.map((entry) => Array.isArray(entry) ? entry[0] : entry), ["pointer", "stage", "plan", "native", "prepare", "schedule"]);
  assert.deepEqual(events[3][1], {
    sourceSha: B,
    target: "win32-x64",
    expectedRuntimeContractSha256: targetDigest,
    transactionRoot: "/state",
    transactionId: TX,
  });
});

test("native planning or snapshot staging failure aborts the still-staged transaction", async () => {
  for (const failurePoint of ["plan", "native"]) {
    const events = [];
    const aborts = [];
    const engine = engineFixture(events);
    engine.abortStagedPreparation = async (id, failure) => aborts.push([id, failure]);
    engine.preparePromotion = async () => assert.fail("failed native preparation must not enter promotion");
    const transition = {
      mode: "artifact_required",
      target: "darwin-arm64",
      currentSha: A,
      targetSha: B,
      currentRuntimeContractSha256: DIGEST,
      targetRuntimeContractSha256: "f".repeat(64),
    };

    await assert.rejects(prepareAndScheduleEquinoxLocalMainUpdate({
      sourceRoot: "/active",
      transactionRoot: "/state",
      currentSha: A,
      targetSha: B,
      engineFactory: () => engine,
      resolveHostTarget: () => "darwin-arm64",
      planNativeTransition: async () => {
        if (failurePoint === "plan") throw new Error("native contract drift");
        return transition;
      },
      stageNativeArtifact: async () => {
        if (failurePoint === "native") throw new Error("snapshot digest mismatch");
        return { verified: true };
      },
      scheduleWorker: async () => assert.fail("failed native preparation must not schedule handoff"),
    }), new RegExp(failurePoint === "plan" ? "native contract drift" : "snapshot digest mismatch", "u"));

    assert.deepEqual(aborts, [[TX, failurePoint === "plan" ? "native contract drift" : "snapshot digest mismatch"]]);
  }
});

test("unsupported native transition mode fails closed while staged", async () => {
  const events = [];
  const aborts = [];
  const engine = engineFixture(events);
  engine.abortStagedPreparation = async (id, failure) => aborts.push([id, failure]);
  engine.preparePromotion = async () => assert.fail("unsupported native transition must not promote");
  await assert.rejects(prepareAndScheduleEquinoxLocalMainUpdate({
    sourceRoot: "/active",
    transactionRoot: "/state",
    currentSha: A,
    targetSha: B,
    engineFactory: () => engine,
    resolveHostTarget: () => "darwin-arm64",
    planNativeTransition: async () => ({ mode: "future_mode" }),
  }), /mode is unsupported/u);
  assert.deepEqual(aborts, [[TX, "Main native transition mode is unsupported."]]);
});

test("scheduler failure aborts only the still-unactivated prepared transaction", async () => {
  const events = [];
  const engine = engineFixture(events);
  engine.abortPreparedPromotion = async (id, failure) => events.push(["abort-prepared", id, failure]);
  await assert.rejects(prepareAndScheduleEquinoxLocalMainUpdate({
    sourceRoot: "/active", transactionRoot: "/state", currentSha: A, targetSha: B,
    engineFactory: () => engine,
    resolveHostTarget: () => "darwin-arm64",
    planNativeTransition: async () => reuseTransition(),
    scheduleWorker: async () => { throw new Error("launchd unavailable"); },
  }), /launchd unavailable/u);
  assert.deepEqual(events.at(-1), ["abort-prepared", TX, "launchd unavailable"]);
});
