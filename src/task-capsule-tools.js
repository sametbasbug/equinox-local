export function registerTaskCapsuleTools({ registerRawTool, z, store, autoContinueController, freshChatResumeController } = {}) {
  if (typeof registerRawTool !== "function" || !z || !store || !autoContinueController || !freshChatResumeController) throw new Error("Task Capsule tool registration dependencies are missing.");
  const referenceSchema = z.object({
    type: z.enum(["project", "branch", "commit", "file", "url", "note"]),
    label: z.string().min(1).max(120),
    value: z.string().min(1).max(2048),
  }).strict();
  const taskIdSchema = z.string().regex(/^task-[a-z0-9-]{6,80}$/u);
  const snapshotSchema = {
    title: z.string().min(1).max(160),
    objective: z.string().min(1).max(12 * 1024),
    completed: z.array(z.string().min(1).max(1024)).max(64).default([]),
    next: z.array(z.string().min(1).max(1024)).max(64).default([]),
    references: z.array(referenceSchema).max(32).default([]),
  };
  const jsonResult = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });

  registerRawTool("task_checkpoint", {
    description: "Create or update a durable bounded Task Capsule checkpoint for long-running work. Updating an existing task invalidates any older pending continuation.",
    inputSchema: { task_id: taskIdSchema.optional(), ...snapshotSchema },
    annotations: { title: "Save task checkpoint", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input) => jsonResult(await store.checkpoint({ ...input, taskId: input.task_id })), { capabilityDomain: "runtime" });

  registerRawTool("task_read", {
    description: "Read one durable Task Capsule by id.",
    inputSchema: { task_id: taskIdSchema },
    annotations: { title: "Read task checkpoint", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ task_id }) => jsonResult(await store.read(task_id)), { capabilityDomain: "runtime" });

  registerRawTool("task_list", {
    description: "List bounded recent Task Capsules, newest first.",
    inputSchema: { status: z.enum(["active", "completed", "cancelled"]).optional(), limit: z.number().int().min(1).max(100).default(50) },
    annotations: { title: "List tasks", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => jsonResult(await store.list(input)), { capabilityDomain: "runtime" });

  registerRawTool("task_finish", {
    description: "Mark a Task Capsule completed and cancel any pending Auto Continue arm.",
    inputSchema: { task_id: taskIdSchema },
    annotations: { title: "Finish task", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ task_id }) => jsonResult(await store.finish(task_id)), { capabilityDomain: "runtime" });

  registerRawTool("task_cancel", {
    description: "Cancel an active Task Capsule and cancel any pending Auto Continue arm.",
    inputSchema: { task_id: taskIdSchema },
    annotations: { title: "Cancel task", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ task_id }) => jsonResult(await store.cancel(task_id)), { capabilityDomain: "runtime" });

  registerRawTool("continuation_arm", {
    description: "Arm one bounded next-turn Auto Continue for an active Task Capsule. Browser delivery is bound separately to a verified ChatGPT target; every automatic hop must be armed again.",
    inputSchema: { task_id: taskIdSchema, ttl_minutes: z.number().int().min(1).max(60).default(15) },
    annotations: { title: "Arm Auto Continue", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ task_id, ttl_minutes }) => jsonResult(await autoContinueController.arm({ taskId: task_id, ttlMinutes: ttl_minutes })), { capabilityDomain: "runtime" });

  registerRawTool("continuation_cancel", {
    description: "Cancel the pending Auto Continue arm for a Task Capsule without cancelling the task.",
    inputSchema: { task_id: taskIdSchema },
    annotations: { title: "Cancel Auto Continue", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ task_id }) => jsonResult(await autoContinueController.cancel(task_id, "agent_cancelled")), { capabilityDomain: "runtime" });


  registerRawTool("task_resume_fresh", {
    description: "Prepare one guarded Fresh Chat Resume for an active Task Capsule. The current ChatGPT task conversation is resolved with the same current/pinned target semantics as Auto Continue; after the current assistant turn finishes, Equinox opens one fresh chat in the same ChatGPT project scope when present and submits a deterministic Task Capsule handoff.",
    inputSchema: { task_id: taskIdSchema },
    annotations: { title: "Resume task in fresh chat", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ task_id }) => jsonResult(await freshChatResumeController.prepare({ taskId: task_id })), { capabilityDomain: "runtime" });

  registerRawTool("task_resume_cancel", {
    description: "Cancel a prepared Fresh Chat Resume before browser mutation. If mutation has already been reserved, the transition becomes ambiguous instead of being retried.",
    inputSchema: { task_id: taskIdSchema },
    annotations: { title: "Cancel fresh chat resume", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ task_id }) => jsonResult(await freshChatResumeController.cancel(task_id, "agent_cancelled")), { capabilityDomain: "runtime" });

  registerRawTool("task_resume_abandon", {
    description: "Explicitly abandon a cancelled or ambiguous Fresh Chat Resume recovery state so the Task Capsule can move forward. This never retries browser mutation and cannot abandon a confirmed or actively creating transition.",
    inputSchema: { task_id: taskIdSchema },
    annotations: { title: "Abandon fresh chat recovery", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ task_id }) => jsonResult(await freshChatResumeController.abandon(task_id, "agent_abandoned")), { capabilityDomain: "runtime" });
}
