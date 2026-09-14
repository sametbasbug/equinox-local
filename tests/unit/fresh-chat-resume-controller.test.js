import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createFreshChatResumeController } from "../../src/fresh-chat-resume-controller.js";
import { createTaskCapsuleStore } from "../../src/task-capsule-store.js";

const base = {
  title: "Fresh resume controller",
  objective: "Move this task into a fresh chat safely.",
  completed: ["Checkpoint saved"],
  next: ["Continue in a fresh chat"],
  references: [],
};

async function makeStore(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-fresh-resume-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let sequence = 0;
  const store = createTaskCapsuleStore({ rootDir: root, randomId: () => `freshid-${String(++sequence).padStart(3, "0")}` });
  await store.initialize();
  return store;
}

function activeAgentControl() {
  return { snapshot: () => ({ paused: false }), assertMutationAllowed() {} };
}

function sourceTarget(overrides = {}) {
  return {
    browserContext: "user",
    browserInstanceId: "11111111-2222-4333-8444-555555555555",
    mode: "task-tab",
    tabId: 42,
    conversationId: "abcdef12-3456-7890-abcd-ef1234567890",
    canonicalUrl: "https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef/c/abcdef12-3456-7890-abcd-ef1234567890",
    title: "Task chat",
    userEpoch: "user-epoch-1",
    assistantTurnKey: "conversation-turn-8",
    autoContinueVersion: 1,
    ...overrides,
  };
}

function freshSnapshot(capability = 1) {
  return {
    contexts: {
      agent: { ready: false },
      user: {
        ready: true,
        extension: {
          instanceId: "11111111-2222-4333-8444-555555555555",
          capabilityVersions: { autoContinue: 1, freshChatResume: capability },
        },
      },
    },
  };
}

function inspectState(overrides = {}) {
  return {
    tabId: 42,
    conversationId: "abcdef12-3456-7890-abcd-ef1234567890",
    canonicalUrl: "https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef/c/abcdef12-3456-7890-abcd-ef1234567890",
    generationActive: false,
    userEpoch: "user-epoch-1",
    assistantTurnKey: "conversation-turn-8",
    composerReady: true,
    composerEmpty: true,
    ...overrides,
  };
}

async function waitFor(predicate, timeoutMs = 800) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for Fresh Chat Resume test state.");
}

test("Fresh Chat Resume reserves durable creating state before one confirmed browser transition", async (t) => {
  const store = await makeStore(t);
  const task = await store.checkpoint(base);
  let inspectCount = 0;
  const calls = [];
  const browserBridge = {
    snapshot: () => freshSnapshot(),
    call: async (method, args, { context, timeoutMs }) => {
      calls.push({ method, args, context, timeoutMs });
      if (method === "continuation.inspect") {
        inspectCount += 1;
        return inspectState({ generationActive: inspectCount === 1 });
      }
      if (method === "resume.create") {
        const internal = await store.readInternal(task.taskId);
        assert.equal(internal.freshResume.status, "creating");
        assert.match(args.prompt, new RegExp(task.taskId, "u"));
        assert.match(args.prompt, /do not depend on the previous chat transcript/iu);
        return {
          confirmed: true,
          destinationTabId: 91,
          destinationConversationId: "99999999-8888-7777-6666-555555555555",
          destinationCanonicalUrl: "https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef-project/c/99999999-8888-7777-6666-555555555555",
        };
      }
      throw new Error(`Unexpected method ${method}`);
    },
  };
  const controller = createFreshChatResumeController({
    store,
    browserBridge,
    autoContinueController: { resolveTarget: async () => sourceTarget() },
    agentControl: activeAgentControl(),
    pollMs: 5,
    quietMs: 10,
  });
  t.after(() => controller.shutdown());

  const prepared = await controller.prepare({ taskId: task.taskId });
  assert.equal(prepared.freshResume.status, "prepared");
  await waitFor(async () => (await store.read(task.taskId)).freshResume.status === "confirmed");
  await controller.shutdown();
  const resumeCalls = calls.filter((call) => call.method === "resume.create");
  assert.equal(resumeCalls.length, 1);
  assert.equal(resumeCalls[0].timeoutMs, 40_000);
  const final = await store.readInternal(task.taskId);
  assert.equal(final.chatBinding.conversationId, "99999999-8888-7777-6666-555555555555");
  assert.equal(final.chatBinding.browserContext, "user");
});

test("Fresh Chat Resume cancels prepared transition when the human changes the source user epoch", async (t) => {
  const store = await makeStore(t);
  const task = await store.checkpoint(base);
  let creates = 0;
  const browserBridge = {
    snapshot: () => freshSnapshot(),
    call: async (method) => {
      if (method === "continuation.inspect") return inspectState({ userEpoch: "human-new-message" });
      if (method === "resume.create") { creates += 1; return { confirmed: true }; }
      throw new Error(`Unexpected method ${method}`);
    },
  };
  const controller = createFreshChatResumeController({
    store,
    browserBridge,
    autoContinueController: { resolveTarget: async () => sourceTarget() },
    agentControl: activeAgentControl(),
    pollMs: 5,
    quietMs: 5,
  });
  t.after(() => controller.shutdown());
  await controller.prepare({ taskId: task.taskId });
  await waitFor(async () => (await store.read(task.taskId)).freshResume.status === "cancelled");
  await controller.shutdown();
  assert.equal((await store.read(task.taskId)).freshResume.reason, "human_interruption");
  assert.equal(creates, 0);
});

test("Fresh Chat Resume fails closed before persistence when selected extension lacks capability v1", async (t) => {
  const store = await makeStore(t);
  const task = await store.checkpoint(base);
  const browserBridge = { snapshot: () => freshSnapshot(0), call: async () => { throw new Error("should not mutate browser"); } };
  const controller = createFreshChatResumeController({
    store,
    browserBridge,
    autoContinueController: { resolveTarget: async () => sourceTarget() },
    agentControl: activeAgentControl(),
  });
  t.after(() => controller.shutdown());
  await assert.rejects(() => controller.prepare({ taskId: task.taskId }), /requires the current Equinox Browser extension/u);
  await controller.shutdown();
  assert.equal((await store.read(task.taskId)).freshResume, null);
});

test("Fresh Chat Resume persists browser timeout after mutation reservation as ambiguous and never retries", async (t) => {
  const store = await makeStore(t);
  const task = await store.checkpoint(base);
  let creates = 0;
  const browserBridge = {
    snapshot: () => freshSnapshot(),
    call: async (method) => {
      if (method === "continuation.inspect") return inspectState();
      if (method === "resume.create") { creates += 1; throw new Error("timeout after destination may have been submitted"); }
      throw new Error(`Unexpected method ${method}`);
    },
  };
  const controller = createFreshChatResumeController({
    store,
    browserBridge,
    autoContinueController: { resolveTarget: async () => sourceTarget() },
    agentControl: activeAgentControl(),
    pollMs: 5,
    quietMs: 5,
  });
  t.after(() => controller.shutdown());
  await controller.prepare({ taskId: task.taskId });
  await waitFor(async () => (await store.read(task.taskId)).freshResume.status === "ambiguous");
  await new Promise((resolve) => setTimeout(resolve, 30));
  await controller.shutdown();
  assert.equal(creates, 1);
  assert.equal((await store.read(task.taskId)).freshResume.reason, "browser_transition_ambiguous_error");
});

test("Fresh Chat Resume start reschedules only prepared transitions after restart reconciliation", async (t) => {
  const store = await makeStore(t);
  const task = await store.checkpoint(base);
  await store.prepareFreshResume({ taskId: task.taskId, source: { ...sourceTarget(), freshChatResumeVersion: 1 } });
  let inspected = 0;
  const browserBridge = {
    snapshot: () => freshSnapshot(),
    call: async (method) => {
      if (method === "continuation.inspect") { inspected += 1; return inspectState({ userEpoch: "human-new-message" }); }
      throw new Error(`Unexpected method ${method}`);
    },
  };
  const controller = createFreshChatResumeController({
    store,
    browserBridge,
    autoContinueController: { resolveTarget: async () => sourceTarget() },
    agentControl: activeAgentControl(),
    pollMs: 5,
    quietMs: 5,
  });
  t.after(() => controller.shutdown());
  const started = await controller.start();
  assert.equal(started.resumed, 1);
  await waitFor(async () => (await store.read(task.taskId)).freshResume.status === "cancelled");
  await controller.shutdown();
  assert.equal(inspected, 1);
});

test("Fresh Chat Resume quiesce preserves prepared state and a restarted controller resumes it once", async (t) => {
  const store = await makeStore(t);
  const task = await store.checkpoint(base);
  let creates = 0;
  const browserBridge = {
    snapshot: () => freshSnapshot(),
    call: async (method) => {
      if (method === "continuation.inspect") return inspectState();
      if (method === "resume.create") {
        creates += 1;
        return {
          confirmed: true,
          destinationTabId: 77,
          destinationConversationId: "77777777-8888-9999-aaaa-bbbbbbbbbbbb",
          destinationCanonicalUrl: "https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef-project/c/77777777-8888-9999-aaaa-bbbbbbbbbbbb",
        };
      }
      throw new Error(`Unexpected method ${method}`);
    },
  };
  const oldController = createFreshChatResumeController({
    store,
    browserBridge,
    autoContinueController: { resolveTarget: async () => sourceTarget() },
    agentControl: activeAgentControl(),
    pollMs: 50,
    quietMs: 50,
  });
  t.after(() => oldController.shutdown());

  const prepared = await oldController.prepare({ taskId: task.taskId });
  assert.equal(prepared.freshResume.status, "prepared");
  await oldController.shutdown();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(creates, 0);
  assert.equal((await store.read(task.taskId)).freshResume.status, "prepared");

  const restartedController = createFreshChatResumeController({
    store,
    browserBridge,
    autoContinueController: { resolveTarget: async () => sourceTarget() },
    agentControl: activeAgentControl(),
    pollMs: 5,
    quietMs: 5,
  });
  t.after(() => restartedController.shutdown());
  const started = await restartedController.start();
  assert.equal(started.resumed, 1);
  await waitFor(async () => (await store.read(task.taskId)).freshResume.status === "confirmed");
  await restartedController.shutdown();
  assert.equal(creates, 1);
  const final = await store.readInternal(task.taskId);
  assert.equal(final.chatBinding.tabId, 77);
  assert.equal(final.chatBinding.conversationId, "77777777-8888-9999-aaaa-bbbbbbbbbbbb");
});
