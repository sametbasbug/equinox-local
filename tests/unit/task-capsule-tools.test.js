import assert from "node:assert/strict";
import test from "node:test";
import * as z from "zod/v4";

import { registerTaskCapsuleTools } from "../../src/task-capsule-tools.js";

test("Task Capsule tools register on the runtime capability surface with bounded read/write semantics", async () => {
  const registrations = new Map();
  const calls = [];
  const store = {
    checkpoint: async (input) => { calls.push(["checkpoint", input]); return { taskId: "task-abcdef", checkpointRevision: 1 }; },
    read: async (id) => ({ taskId: id }),
    list: async (input) => [{ status: input.status ?? "active" }],
    finish: async (id) => ({ taskId: id, status: "completed" }),
    cancel: async (id) => ({ taskId: id, status: "cancelled" }),
  };
  const autoContinueController = {
    captureBinding: async (id) => ({ taskId: id, checkpointRevision: 1 }),
    armBound: async (input) => { calls.push(["arm-bound", input]); return { taskId: input.taskId, continuation: { status: "armed" } }; },
    cancel: async (id, reason) => ({ taskId: id, continuation: { status: "cancelled", reason } }),
  };
  const freshChatResumeController = {
    prepare: async ({ taskId }) => ({ taskId, freshResume: { status: "prepared" } }),
    cancel: async (id, reason) => ({ taskId: id, freshResume: { status: "cancelled", reason } }),
    abandon: async (id, reason) => ({ taskId: id, freshResume: { status: "cancelled", reason } }),
  };
  const registerRawTool = (name, config, handler, options) => registrations.set(name, { config, handler, options });
  registerTaskCapsuleTools({ registerRawTool, z, store, autoContinueController, freshChatResumeController });

  assert.deepEqual([...registrations.keys()], [
    "task_checkpoint", "task_read", "task_list", "task_finish", "task_cancel", "continuation_arm", "continuation_cancel",
    "task_resume_fresh", "task_resume_cancel", "task_resume_abandon",
  ]);
  assert.equal(registrations.get("task_read").config.annotations.readOnlyHint, true);
  assert.equal(registrations.get("task_cancel").config.annotations.destructiveHint, true);
  for (const entry of registrations.values()) assert.equal(entry.options.capabilityDomain, "runtime");

  const result = await registrations.get("task_checkpoint").handler({
    task_id: undefined,
    title: "Task",
    objective: "Objective",
    completed: [],
    next: ["Continue"],
    references: [],
  });
  assert.match(result.content[0].text, /task-abcdef/u);
  assert.equal(calls[0][0], "checkpoint");
  assert.equal(calls[0][1].taskId, undefined);
  const armed = await registrations.get("continuation_arm").handler({ task_id: "task-abcdef", ttl_minutes: 15 });
  assert.match(armed.content[0].text, /armed/u);
  assert.deepEqual(calls.find((item) => item[0] === "arm-bound"), ["arm-bound", { taskId: "task-abcdef", ttlMinutes: 15 }]);
});

test("Task Capsule schemas reject invalid task identities, oversized snapshots and untrusted reference fields", () => {
  const registrations = new Map();
  const inert = async () => ({ taskId: "task-fixture" });
  registerTaskCapsuleTools({
    registerRawTool: (name, definition, handler, options) => registrations.set(name, { definition, handler, options }),
    z,
    store: { checkpoint: inert, read: inert, list: inert, finish: inert, cancel: inert },
    autoContinueController: { captureBinding: inert, armBound: inert, cancel: inert },
    freshChatResumeController: { prepare: inert, cancel: inert, abandon: inert },
  });
  const schemas = (name) => registrations.get(name).definition.inputSchema;
  const validate = (name, value) => z.object(schemas(name)).safeParse(value);
  const taskId = "task-valid-123";
  for (const name of ["task_read", "task_finish", "task_cancel", "continuation_cancel", "task_resume_fresh", "task_resume_cancel", "task_resume_abandon"]) {
    assert.equal(validate(name, { task_id: taskId }).success, true, name);
    for (const invalidId of ["task-", "task-UPPER", "wrong-123", "task-a", `task-${"a".repeat(81)}`]) {
      assert.equal(validate(name, { task_id: invalidId }).success, false, `${name}: ${invalidId}`);
    }
  }
  const arm = validate("continuation_arm", { task_id: taskId });
  assert.equal(arm.success, true);
  assert.equal(arm.data.ttl_minutes, 15);
  for (const minutes of [0, 61, -1, 1.1, "15"]) {
    assert.equal(validate("continuation_arm", { task_id: taskId, ttl_minutes: minutes }).success, false);
  }
  assert.equal(validate("continuation_arm", { task_id: taskId, ttl_minutes: 60 }).success, true);
  assert.equal(validate("task_list", {}).data.limit, 50);
  for (const limit of [0, 101, Infinity, "10"]) {
    assert.equal(validate("task_list", { limit }).success, false);
  }
  const snapshot = { title: "Task", objective: "Work" };
  const basic = validate("task_checkpoint", snapshot);
  assert.equal(basic.success, true);
  assert.deepEqual(basic.data.completed, []);
  assert.deepEqual(basic.data.next, []);
  assert.deepEqual(basic.data.references, []);
  assert.equal(validate("task_checkpoint", { ...snapshot, title: "x".repeat(161) }).success, false);
  assert.equal(validate("task_checkpoint", { ...snapshot, objective: "x".repeat(12 * 1024 + 1) }).success, false);
  assert.equal(validate("task_checkpoint", { ...snapshot, next: Array(65).fill("step") }).success, false);
  assert.equal(validate("task_checkpoint", { ...snapshot, completed: ["x".repeat(1025)] }).success, false);
  for (const reference of [
    { type: "secret", label: "name", value: "v" },
    { type: "note", label: "x", value: "v", extra: "no" },
    { type: "note", label: "x".repeat(121), value: "v" },
    { type: "note", label: "x", value: "v".repeat(2049) },
  ]) assert.equal(validate("task_checkpoint", { ...snapshot, references: [reference] }).success, false);
});

test("Task Capsule routes each bounded operation to the exact authority without extra lifecycle actions", async () => {
  const registrations = new Map();
  const calls = [];
  const store = {
    checkpoint: async (input) => { calls.push(["checkpoint", input.taskId]); return { taskId: "task-approved" }; },
    read: async (id) => { calls.push(["read", id]); return { id }; },
    list: async (options) => { calls.push(["list", options]); return [{ status: "active" }]; },
    finish: async (id) => { calls.push(["finish", id]); return { id }; },
    cancel: async (id) => { calls.push(["cancel", id]); return { id }; },
  };
  const autoContinueController = {
    captureBinding: async (id) => { calls.push(["capture", id]); return { id }; },
    armBound: async (input) => { calls.push(["arm", input]); return input; },
    cancel: async (id, reason) => { calls.push(["stop-auto", id, reason]); return { id, reason }; },
  };
  const freshChatResumeController = {
    prepare: async (input) => { calls.push(["prepare", input]); return input; },
    cancel: async (id, reason) => { calls.push(["stop-fresh", id, reason]); return { id, reason }; },
    abandon: async (id, reason) => { calls.push(["abandon", id, reason]); return { id, reason }; },
  };
  registerTaskCapsuleTools({
    registerRawTool: (name, definition, handler, options) => registrations.set(name, { definition, handler, options }),
    z, store, autoContinueController, freshChatResumeController,
  });
  const execute = async (name, input) => {
    const entry = registrations.get(name);
    assert.equal(entry.options.capabilityDomain, "runtime");
    assert.equal(entry.definition.annotations.openWorldHint, false);
    const result = await entry.handler(input);
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, "text");
    assert.doesNotThrow(() => JSON.parse(result.content[0].text));
  };
  const task_id = "task-approved";
  await execute("task_checkpoint", { title: "Safe", objective: "Work", completed: [], next: [], references: [] });
  await execute("task_read", { task_id });
  await execute("task_list", { status: "active", limit: 5 });
  await execute("task_finish", { task_id });
  await execute("task_cancel", { task_id });
  await execute("continuation_arm", { task_id, ttl_minutes: 15 });
  await execute("continuation_cancel", { task_id });
  await execute("task_resume_fresh", { task_id });
  await execute("task_resume_cancel", { task_id });
  await execute("task_resume_abandon", { task_id });
  assert.deepEqual(calls, [
    ["checkpoint", undefined],
    ["capture", task_id],
    ["read", task_id],
    ["list", { status: "active", limit: 5 }],
    ["finish", task_id],
    ["cancel", task_id],
    ["arm", { taskId: task_id, ttlMinutes: 15 }],
    ["stop-auto", task_id, "agent_cancelled"],
    ["prepare", { taskId: task_id }],
    ["stop-fresh", task_id, "agent_cancelled"],
    ["abandon", task_id, "agent_abandoned"],
  ]);
});

test("a failed checkpoint or binding capture never claims a successful Task Capsule result", async () => {
  const registrations = new Map();
  let captured = 0;
  let checked = 0;
  let failingAt = "checkpoint";
  registerTaskCapsuleTools({
    registerRawTool: (name, definition, handler) => registrations.set(name, handler),
    z,
    store: {
      checkpoint: async () => {
        checked += 1;
        if (failingAt === "checkpoint") throw new Error("checkpoint refused");
        return { taskId: "task-accepted" };
      },
    },
    autoContinueController: {
      captureBinding: async () => {
        captured += 1;
        if (failingAt === "binding") throw new Error("binding unavailable");
        return { taskId: "task-accepted" };
      },
    },
    freshChatResumeController: {},
  });
  const handler = registrations.get("task_checkpoint");
  const input = { title: "Safe", objective: "Task", completed: [], next: [], references: [] };
  await assert.rejects(handler(input), /checkpoint refused/u);
  assert.equal(checked, 1);
  assert.equal(captured, 0);
  failingAt = "binding";
  await assert.rejects(handler(input), /binding unavailable/u);
  assert.equal(checked, 2);
  assert.equal(captured, 1);
});
