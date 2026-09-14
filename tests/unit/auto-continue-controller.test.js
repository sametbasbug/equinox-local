import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAutoContinueController } from "../../src/auto-continue-controller.js";
import { createTaskCapsuleStore } from "../../src/task-capsule-store.js";

const base = {
  title: "Auto Continue test",
  objective: "Continue without human relay.",
  completed: ["Checkpoint saved"],
  next: ["Continue implementation"],
  references: [],
};

async function makeStore(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-auto-continue-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let sequence = 0;
  const store = createTaskCapsuleStore({
    rootDir: root,
    randomId: () => `autoid-${String(++sequence).padStart(3, "0")}`,
  });
  await store.initialize();
  return store;
}

function activeAgentControl() {
  return {
    snapshot: () => ({ paused: false }),
    assertMutationAllowed() {},
  };
}

function targetResult(overrides = {}) {
  return {
    autoContinueVersion: 1,
    mode: "task-tab",
    status: "ready",
    target: {
      autoContinueVersion: 1,
      tabId: 42,
      conversationId: "abcdef12-3456-7890-abcd-ef1234567890",
      canonicalUrl: "https://chatgpt.com/c/abcdef12-3456-7890-abcd-ef1234567890",
      title: "Task chat",
      generationActive: true,
      userEpoch: "user-epoch-1",
      assistantTurnKey: "conversation-turn-8",
      composerReady: true,
      composerEmpty: true,
      ...overrides,
    },
  };
}

async function waitFor(predicate, timeoutMs = 600) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for Auto Continue test state.");
}

test("Auto Continue binds the unique generating ChatGPT task and reserves before exactly-once delivery", async (t) => {
  const store = await makeStore(t);
  const task = await store.checkpoint(base);
  const calls = [];
  let inspectCount = 0;
  const browserBridge = {
    snapshot: () => ({
      contexts: {
        agent: { ready: false },
        user: { ready: true, extension: { instanceId: "11111111-2222-4333-8444-555555555555", capabilityVersions: { autoContinue: 1 } } },
      },
    }),
    call: async (method, args, { context }) => {
      calls.push({ method, args, context });
      if (method === "continuation.target.resolve") return targetResult();
      if (method === "continuation.inspect") {
        inspectCount += 1;
        return {
          ...targetResult().target,
          generationActive: inspectCount === 1,
          composerReady: true,
          composerEmpty: true,
        };
      }
      if (method === "continuation.deliver") {
        const internal = await store.readInternal(task.taskId);
        assert.equal(internal.continuation.status, "delivering");
        assert.match(args.prompt, new RegExp(task.taskId, "u"));
        return { confirmed: true };
      }
      throw new Error(`Unexpected method ${method}`);
    },
  };
  const controller = createAutoContinueController({ store, browserBridge, agentControl: activeAgentControl(), pollMs: 5, quietMs: 10 });
  t.after(() => controller.shutdown());
  const armed = await controller.arm({ taskId: task.taskId, ttlMinutes: 1 });
  assert.equal(armed.continuation.status, "armed");
  assert.equal(armed.continuation.target.browserContext, "user");
  await waitFor(async () => (await store.read(task.taskId)).continuation.status === "delivered");
  await controller.shutdown();
  assert.equal(calls.filter((call) => call.method === "continuation.deliver").length, 1);
});

test("Auto Continue cancels when a human message changes the user epoch", async (t) => {
  const store = await makeStore(t);
  const task = await store.checkpoint(base);
  let delivered = 0;
  const browserBridge = {
    snapshot: () => ({ contexts: { agent: { ready: false }, user: { ready: true, extension: { instanceId: "instance-user-123", capabilityVersions: { autoContinue: 1 } } } } }),
    call: async (method) => {
      if (method === "continuation.target.resolve") return targetResult();
      if (method === "continuation.inspect") return { ...targetResult().target, generationActive: false, userEpoch: "human-new-message" };
      if (method === "continuation.deliver") { delivered += 1; return { confirmed: true }; }
      throw new Error(`Unexpected method ${method}`);
    },
  };
  const controller = createAutoContinueController({ store, browserBridge, agentControl: activeAgentControl(), pollMs: 5, quietMs: 5 });
  t.after(() => controller.shutdown());
  await controller.arm({ taskId: task.taskId, ttlMinutes: 1 });
  await waitFor(async () => (await store.read(task.taskId)).continuation.status === "cancelled");
  await controller.shutdown();
  assert.equal((await store.read(task.taskId)).continuation.reason, "human_interruption");
  assert.equal(delivered, 0);
});

test("Auto Continue fails closed when the connected extension lacks the feature capability", async (t) => {
  const store = await makeStore(t);
  const task = await store.checkpoint(base);
  const browserBridge = {
    snapshot: () => ({ contexts: { agent: { ready: false }, user: { ready: true, extension: { instanceId: "instance-old", capabilityVersions: {} } } } }),
    call: async () => { throw new Error("should not call an outdated extension"); },
  };
  const controller = createAutoContinueController({ store, browserBridge, agentControl: activeAgentControl() });
  t.after(() => controller.shutdown());
  await assert.rejects(() => controller.arm({ taskId: task.taskId }), /requires the current Equinox Browser extension/u);
  await controller.shutdown();
  assert.equal((await store.read(task.taskId)).continuation, null);
});

test("an ambiguous browser delivery failure is persisted as failed and never retried", async (t) => {
  const store = await makeStore(t);
  const task = await store.checkpoint(base);
  let delivers = 0;
  const browserBridge = {
    snapshot: () => ({ contexts: { agent: { ready: false }, user: { ready: true, extension: { instanceId: "instance-user-456", capabilityVersions: { autoContinue: 1 } } } } }),
    call: async (method) => {
      if (method === "continuation.target.resolve") return targetResult();
      if (method === "continuation.inspect") return { ...targetResult().target, generationActive: false, composerReady: true, composerEmpty: true };
      if (method === "continuation.deliver") { delivers += 1; throw new Error("bridge timeout after send may have crossed"); }
      throw new Error(`Unexpected method ${method}`);
    },
  };
  const controller = createAutoContinueController({ store, browserBridge, agentControl: activeAgentControl(), pollMs: 5, quietMs: 5 });
  t.after(() => controller.shutdown());
  await controller.arm({ taskId: task.taskId, ttlMinutes: 1 });
  await waitFor(async () => (await store.read(task.taskId)).continuation.status === "failed");
  await new Promise((resolve) => setTimeout(resolve, 30));
  await controller.shutdown();
  assert.equal(delivers, 1);
  assert.equal((await store.read(task.taskId)).continuation.reason, "browser_delivery_ambiguous_error");
});
