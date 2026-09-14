import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createTaskCapsuleStore } from "../../src/task-capsule-store.js";

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-task-capsule-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let sequence = 0;
  let clock = Date.parse("2026-09-12T00:00:00.000Z");
  const events = [];
  const store = createTaskCapsuleStore({
    rootDir: root,
    randomId: () => `testid-${String(++sequence).padStart(3, "0")}`,
    now: () => clock,
    onEvent: async (event) => events.push(event),
    ...options,
  });
  await store.initialize();
  return { root, store, events, tick: (ms = 1000) => { clock += ms; } };
}

const base = {
  title: "Auto Continue",
  objective: "Implement Task Capsules safely.",
  completed: ["Saved the plan"],
  next: ["Build the store"],
  references: [{ type: "branch", label: "Branch", value: "equinox/auto-continue-task-capsules" }],
};

test("Task Capsule persists bounded checkpoints and increments revisions", async (t) => {
  const { root, store, tick } = await fixture(t);
  const created = await store.checkpoint(base);
  assert.match(created.taskId, /^task-/u);
  assert.equal(created.checkpointRevision, 1);
  tick();
  const updated = await store.checkpoint({ ...base, taskId: created.taskId, next: ["Register tools"] });
  assert.equal(updated.checkpointRevision, 2);
  assert.deepEqual(updated.next, ["Register tools"]);
  assert.equal((await fs.stat(path.join(root, `${created.taskId}.json`))).mode & 0o777, 0o600);
  const reloaded = createTaskCapsuleStore({ rootDir: root });
  await reloaded.initialize();
  assert.equal((await reloaded.read(created.taskId)).checkpointRevision, 2);
});


test("checkpoint revision guard rejects stale human edits atomically", async (t) => {
  const { store } = await fixture(t);
  const created = await store.checkpoint(base);
  const updated = await store.checkpoint({ ...base, taskId: created.taskId, expectedRevision: 1, next: ["Second revision"] });
  assert.equal(updated.checkpointRevision, 2);
  await assert.rejects(
    () => store.checkpoint({ ...base, taskId: created.taskId, expectedRevision: 1, next: ["Stale overwrite"] }),
    (error) => error?.code === "TASK_CAPSULE_REVISION_CONFLICT",
  );
  assert.deepEqual((await store.read(created.taskId)).next, ["Second revision"]);
});

test("new checkpoint cancels an older continuation and terminal states stay terminal", async (t) => {
  const { store } = await fixture(t);
  const created = await store.checkpoint(base);
  const armed = await store.armContinuation({ taskId: created.taskId });
  assert.equal(armed.continuation.status, "armed");
  const updated = await store.checkpoint({ ...base, taskId: created.taskId, next: ["Different next step"] });
  assert.equal(updated.continuation.status, "cancelled");
  assert.equal(updated.continuation.reason, "checkpoint_changed");
  assert.equal((await store.finish(created.taskId)).status, "completed");
  await assert.rejects(() => store.checkpoint({ ...base, taskId: created.taskId }), /Only active/u);
  await assert.rejects(() => store.cancel(created.taskId), /completed/u);
});

test("Emergency Stop helper cancels every live continuation without changing task status", async (t) => {
  const { store } = await fixture(t);
  const first = await store.checkpoint(base);
  const second = await store.checkpoint({ ...base, title: "Second task" });
  await store.armContinuation({ taskId: first.taskId });
  await store.armContinuation({ taskId: second.taskId });
  assert.equal((await store.cancelAllContinuations("emergency_stop")).cancelled, 2);
  assert.equal((await store.read(first.taskId)).status, "active");
  assert.equal((await store.read(first.taskId)).continuation.reason, "emergency_stop");
});

test("Task Capsule validation rejects unsafe file references and oversized fields", async (t) => {
  const { store } = await fixture(t);
  await assert.rejects(() => store.checkpoint({ ...base, references: [{ type: "file", label: "Secret", value: "/Users/person/secret.txt" }] }), /safe relative file/u);
  await assert.rejects(() => store.checkpoint({ ...base, title: "x".repeat(161) }), /title exceeds/u);
});

test("retention removes only terminal tasks and refuses to evict active work", async (t) => {
  const { store } = await fixture(t, { maxRetained: 2 });
  const first = await store.checkpoint(base);
  await store.finish(first.taskId);
  await store.checkpoint({ ...base, title: "Second" });
  const third = await store.checkpoint({ ...base, title: "Third" });
  assert.equal((await store.list({ limit: 10 })).length, 2);
  assert.equal((await store.read(third.taskId)).status, "active");
  await assert.rejects(() => store.checkpoint({ ...base, title: "Fourth" }), /retention limit/u);
});

test("terminal Task Capsules can be deleted but active work cannot", async (t) => {
  const { root, store } = await fixture(t);
  const active = await store.checkpoint(base);
  await assert.rejects(() => store.remove(active.taskId), (error) => error.code === "TASK_CAPSULE_TERMINAL_REQUIRED" && /must be completed or cancelled/u.test(error.message));
  await fs.stat(path.join(root, `${active.taskId}.json`));

  const completed = await store.checkpoint({ ...base, title: "Completed" });
  await store.finish(completed.taskId);
  const cancelled = await store.checkpoint({ ...base, title: "Cancelled" });
  await store.cancel(cancelled.taskId);

  assert.deepEqual(await store.remove(completed.taskId), { taskId: completed.taskId, status: "completed", deleted: true });
  assert.deepEqual(await store.remove(cancelled.taskId), { taskId: cancelled.taskId, status: "cancelled", deleted: true });
  await assert.rejects(() => store.read(completed.taskId), /not found/u);
  await assert.rejects(() => store.read(cancelled.taskId), /not found/u);
  await assert.rejects(() => fs.stat(path.join(root, `${completed.taskId}.json`)), { code: "ENOENT" });
  await assert.rejects(() => fs.stat(path.join(root, `${cancelled.taskId}.json`)), { code: "ENOENT" });
});

test("default Task Capsule retention cap is 50 and never evicts active work", async (t) => {
  const { store } = await fixture(t);
  for (let index = 0; index < 50; index += 1) {
    await store.checkpoint({ ...base, title: `Active ${index + 1}` });
  }
  assert.equal((await store.list({ limit: 100 })).length, 50);
  await assert.rejects(() => store.checkpoint({ ...base, title: "Fifty first" }), /retention limit/u);
});

const continuationTarget = {
  browserContext: "user",
  browserInstanceId: "11111111-2222-4333-8444-555555555555",
  mode: "task-tab",
  tabId: 42,
  conversationId: "abcdef12-3456-7890-abcd-ef1234567890",
  canonicalUrl: "https://chatgpt.com/c/abcdef12-3456-7890-abcd-ef1234567890",
  title: "Task chat",
  userEpoch: "user-message-123",
  assistantTurnKey: "conversation-turn-8",
  autoContinueVersion: 1,
};

test("delivery reservation is durable, private target fields stay internal and restart never retries ambiguous delivery", async (t) => {
  const { root, store } = await fixture(t);
  const task = await store.checkpoint(base);
  const armed = await store.armContinuation({ taskId: task.taskId, target: continuationTarget });
  assert.equal(armed.continuation.target.browserContext, "user");
  assert.equal(armed.continuation.target.conversationId, undefined);
  const internal = await store.readInternal(task.taskId);
  assert.equal(internal.continuation.target.conversationId, continuationTarget.conversationId);
  await store.reserveContinuationDelivery(task.taskId, internal.continuation.continuationId);

  const reloaded = createTaskCapsuleStore({ rootDir: root });
  await reloaded.initialize();
  const reconciled = await reloaded.reconcileContinuationsAfterRestart();
  assert.equal(reconciled.retired.length, 1);
  const after = await reloaded.read(task.taskId);
  assert.equal(after.continuation.status, "failed");
  assert.equal(after.continuation.reason, "runtime_restart_ambiguous_delivery");
});

test("confirmed delivery settles exactly once and rejects a second reservation", async (t) => {
  const { store } = await fixture(t);
  const task = await store.checkpoint(base);
  await store.armContinuation({ taskId: task.taskId, target: continuationTarget });
  const internal = await store.readInternal(task.taskId);
  const id = internal.continuation.continuationId;
  await store.reserveContinuationDelivery(task.taskId, id);
  await assert.rejects(() => store.reserveContinuationDelivery(task.taskId, id), /cannot reserve/u);
  const delivered = await store.settleContinuationDelivery(task.taskId, id, "delivered");
  assert.equal(delivered.continuation.status, "delivered");
  assert.equal((await store.settleContinuationDelivery(task.taskId, id, "delivered")).continuation.status, "delivered");
});

const freshResumeSource = {
  browserContext: "user",
  browserInstanceId: "11111111-2222-4333-8444-555555555555",
  mode: "task-tab",
  tabId: 77,
  conversationId: "11111111-aaaa-bbbb-cccc-222222222222",
  canonicalUrl: "https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef/c/11111111-aaaa-bbbb-cccc-222222222222",
  title: "Project task",
  userEpoch: "user-message-source",
  assistantTurnKey: "conversation-turn-source",
  freshChatResumeVersion: 1,
};

const freshResumeDestination = {
  browserContext: "user",
  browserInstanceId: "11111111-2222-4333-8444-555555555555",
  tabId: 88,
  conversationId: "33333333-dddd-eeee-ffff-444444444444",
  canonicalUrl: "https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef-project/c/33333333-dddd-eeee-ffff-444444444444",
};

test("Fresh Chat Resume persists prepared state privately and binds only after confirmed destination", async (t) => {
  const { root, store } = await fixture(t);
  const task = await store.checkpoint(base);
  const prepared = await store.prepareFreshResume({ taskId: task.taskId, source: freshResumeSource });
  assert.equal(prepared.freshResume.status, "prepared");
  assert.equal(prepared.freshResume.source.browserContext, "user");
  assert.equal(prepared.freshResume.source.conversationId, undefined);
  assert.equal(prepared.chatBinding, null);

  const internal = await store.readInternal(task.taskId);
  assert.equal(internal.freshResume.source.conversationId, freshResumeSource.conversationId);
  const resumeId = internal.freshResume.resumeId;
  await store.reserveFreshResumeMutation(task.taskId, resumeId);
  const confirmed = await store.settleFreshResume(task.taskId, resumeId, "confirmed", { destination: freshResumeDestination });
  assert.equal(confirmed.freshResume.status, "confirmed");
  assert.deepEqual(confirmed.chatBinding, { browserContext: "user", tabId: 88 });

  const afterInternal = await store.readInternal(task.taskId);
  assert.equal(afterInternal.chatBinding.conversationId, freshResumeDestination.conversationId);
  assert.equal(afterInternal.freshResume.destination.canonicalUrl, freshResumeDestination.canonicalUrl);

  const reloaded = createTaskCapsuleStore({ rootDir: root });
  await reloaded.initialize();
  assert.equal((await reloaded.readInternal(task.taskId)).chatBinding.conversationId, freshResumeDestination.conversationId);
});

test("Fresh Chat Resume prepared state is safely cancellable but creating and ambiguous states block checkpoint mutation", async (t) => {
  const { store } = await fixture(t);
  const first = await store.checkpoint(base);
  await store.prepareFreshResume({ taskId: first.taskId, source: freshResumeSource });
  const changed = await store.checkpoint({ ...base, taskId: first.taskId, next: ["New checkpoint"] });
  assert.equal(changed.freshResume.status, "cancelled");
  assert.equal(changed.freshResume.reason, "checkpoint_changed");

  const second = await store.checkpoint({ ...base, title: "Creating resume" });
  await store.prepareFreshResume({ taskId: second.taskId, source: freshResumeSource });
  const secondInternal = await store.readInternal(second.taskId);
  await store.reserveFreshResumeMutation(second.taskId, secondInternal.freshResume.resumeId);
  await assert.rejects(() => store.checkpoint({ ...base, taskId: second.taskId }), /Fresh Chat Resume is creating/u);
  await store.cancelFreshResume(second.taskId, "emergency_stop");
  assert.equal((await store.read(second.taskId)).freshResume.status, "ambiguous");
  await assert.rejects(() => store.checkpoint({ ...base, taskId: second.taskId }), /Fresh Chat Resume is ambiguous/u);
  await store.abandonFreshResume(second.taskId, "human_abandoned");
  assert.equal((await store.checkpoint({ ...base, taskId: second.taskId, next: ["Recovered"] })).checkpointRevision, 2);
});

test("Fresh Chat Resume restart resumes only pre-mutation prepared state and retires creating as ambiguous", async (t) => {
  const { root, store } = await fixture(t);
  const preparedTask = await store.checkpoint(base);
  const creatingTask = await store.checkpoint({ ...base, title: "Creating task" });
  await store.prepareFreshResume({ taskId: preparedTask.taskId, source: freshResumeSource });
  await store.prepareFreshResume({ taskId: creatingTask.taskId, source: freshResumeSource });
  const creatingInternal = await store.readInternal(creatingTask.taskId);
  await store.reserveFreshResumeMutation(creatingTask.taskId, creatingInternal.freshResume.resumeId);

  const reloaded = createTaskCapsuleStore({ rootDir: root });
  await reloaded.initialize();
  const reconciled = await reloaded.reconcileFreshResumesAfterRestart();
  assert.deepEqual(reconciled.resumable.map((item) => item.taskId), [preparedTask.taskId]);
  assert.deepEqual(reconciled.retired, [creatingTask.taskId]);
  assert.equal((await reloaded.read(creatingTask.taskId)).freshResume.status, "ambiguous");
  assert.equal((await reloaded.read(creatingTask.taskId)).freshResume.reason, "runtime_restart_ambiguous_resume");
});

test("Emergency Stop cancels prepared Fresh Chat Resume and makes reserved browser mutation ambiguous", async (t) => {
  const { store } = await fixture(t);
  const preparedTask = await store.checkpoint(base);
  const creatingTask = await store.checkpoint({ ...base, title: "Creating task" });
  await store.prepareFreshResume({ taskId: preparedTask.taskId, source: freshResumeSource });
  await store.prepareFreshResume({ taskId: creatingTask.taskId, source: freshResumeSource });
  const creatingInternal = await store.readInternal(creatingTask.taskId);
  await store.reserveFreshResumeMutation(creatingTask.taskId, creatingInternal.freshResume.resumeId);

  const stopped = await store.cancelAllFreshResumes("emergency_stop");
  assert.equal(stopped.cancelled, 1);
  assert.equal(stopped.ambiguous, 1);
  assert.equal((await store.read(preparedTask.taskId)).freshResume.status, "cancelled");
  assert.equal((await store.read(creatingTask.taskId)).freshResume.status, "ambiguous");
  assert.match((await store.read(creatingTask.taskId)).freshResume.reason, /emergency_stop_during_creating/u);
});
