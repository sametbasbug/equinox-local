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
