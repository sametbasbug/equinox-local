import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createWorkflowManager } from "../../src/workflow-manager.js";

async function createTempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-workflows-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

async function waitForStatus(manager, workflowId, expected, timeoutMs = 3000) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const current = manager.status(workflowId);
    if (current.status === expected) {
      return current;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(
    `Workflow ${workflowId} ${expected} durumuna geçmedi; mevcut ${manager.status(workflowId).status}`,
  );
}

function sampleStart(overrides = {}) {
  return {
    recipeId: "checks",
    recipeLabel: "Checks",
    label: "test workflow",
    projectId: "demo",
    projectName: "Demo",
    projectRoot: "/tmp/demo",
    options: { timeoutSeconds: 60 },
    steps: [
      { id: "one", kind: "fake", label: "One" },
      { id: "two", kind: "fake", label: "Two" },
    ],
    ...overrides,
  };
}

test("workflow manager runs steps, persists state and exposes cursor logs", async (t) => {
  const root = await createTempRoot(t);
  const calls = [];
  const manager = createWorkflowManager({
    rootDir: root,
    executeStep: async ({ step, log }) => {
      calls.push(step.id);
      await log(`output:${step.id}`);
      return { id: step.id };
    },
  });

  await manager.initialize();
  const started = await manager.start(sampleStart());
  const completed = await waitForStatus(manager, started.workflowId, "completed");

  assert.deepEqual(calls, ["one", "two"]);
  assert.equal(completed.steps[0].status, "completed");
  assert.equal(completed.steps[1].status, "completed");

  const firstLogs = await manager.readLogs({
    workflowId: started.workflowId,
    cursor: 0,
    maxBytes: 120,
  });
  const secondLogs = await manager.readLogs({
    workflowId: started.workflowId,
    cursor: firstLogs.nextCursor,
    maxBytes: 10_000,
  });
  const combined = firstLogs.output + secondLogs.output;

  assert.match(combined, /output:one/u);
  assert.match(combined, /Workflow completed successfully/u);
  assert.ok(secondLogs.nextCursor >= firstLogs.nextCursor);

  const state = JSON.parse(
    await fs.readFile(path.join(root, `${started.workflowId}.json`), "utf8"),
  );
  assert.equal(state.status, "completed");
});

test("workflow manager emits lifecycle observability events", async (t) => {
  const root = await createTempRoot(t);
  const events = [];
  const manager = createWorkflowManager({
    rootDir: root,
    executeStep: async ({ step }) => ({ id: step.id }),
    onEvent: (event) => events.push(event),
  });

  await manager.initialize();
  const started = await manager.start(sampleStart({
    steps: [{ id: "one", kind: "fake", label: "One" }],
  }));
  await waitForStatus(manager, started.workflowId, "completed");
  for (let attempt = 0; attempt < 50 && !events.some((event) => event.type === "workflow.completed"); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(events.some((event) => event.type === "workflow.started"), true);
  const completed = events.find((event) => event.type === "workflow.completed");
  assert.ok(completed);
  assert.equal(completed.correlationId, started.workflowId);
  assert.equal(completed.projectId, "demo");
});

test("failed workflow resumes from the failed step without repeating completed steps", async (t) => {
  const root = await createTempRoot(t);
  const attempts = new Map();
  const manager = createWorkflowManager({
    rootDir: root,
    executeStep: async ({ step }) => {
      const count = (attempts.get(step.id) ?? 0) + 1;
      attempts.set(step.id, count);

      if (step.id === "two" && count === 1) {
        throw new Error("first failure");
      }

      return { count };
    },
  });

  await manager.initialize();
  const started = await manager.start(sampleStart());
  const failed = await waitForStatus(manager, started.workflowId, "failed");

  assert.equal(failed.steps[0].attempts, 1);
  assert.equal(failed.steps[1].attempts, 1);
  assert.equal(failed.resumable, true);

  await manager.resume(started.workflowId);
  const completed = await waitForStatus(manager, started.workflowId, "completed");

  assert.equal(completed.steps[0].attempts, 1);
  assert.equal(completed.steps[1].attempts, 2);
  assert.equal(attempts.get("one"), 1);
  assert.equal(attempts.get("two"), 2);
});

test("runtime shutdown pauses an active workflow and a new manager can resume it", async (t) => {
  const root = await createTempRoot(t);
  const blockingManager = createWorkflowManager({
    rootDir: root,
    executeStep: async ({ signal }) =>
      new Promise((resolve, reject) => {
        if (signal.aborted) {
          reject(new Error("aborted"));
          return;
        }
        const timer = setTimeout(resolve, 10_000);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          },
          { once: true },
        );
      }),
  });

  await blockingManager.initialize();
  const started = await blockingManager.start(
    sampleStart({
      steps: [{ id: "one", kind: "fake", label: "One" }],
    }),
  );
  await waitForStatus(blockingManager, started.workflowId, "running");

  const stepStartedAt = Date.now();
  while (
    blockingManager.status(started.workflowId).steps[0].status !== "running" &&
    Date.now() - stepStartedAt < 1000
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(
    blockingManager.status(started.workflowId).steps[0].status,
    "running",
  );
  await blockingManager.shutdown();

  const paused = blockingManager.status(started.workflowId);
  assert.equal(paused.status, "paused");
  assert.equal(paused.steps[0].status, "pending");

  const resumedManager = createWorkflowManager({
    rootDir: root,
    executeStep: async () => ({ resumed: true }),
  });
  await resumedManager.initialize();

  assert.equal(resumedManager.status(started.workflowId).status, "paused");
  await resumedManager.resume(started.workflowId);
  const completed = await waitForStatus(resumedManager, started.workflowId, "completed");

  assert.equal(completed.steps[0].attempts, 2);
});

test("manager prevents two active workflows for the same project and supports cancel", async (t) => {
  const root = await createTempRoot(t);
  const manager = createWorkflowManager({
    rootDir: root,
    executeStep: async ({ signal }) =>
      new Promise((resolve, reject) => {
        if (signal.aborted) {
          reject(new Error("aborted"));
          return;
        }
        const timer = setTimeout(resolve, 10_000);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          },
          { once: true },
        );
      }),
  });

  await manager.initialize();
  const first = await manager.start(
    sampleStart({ steps: [{ id: "one", kind: "fake", label: "One" }] }),
  );

  await assert.rejects(
    () => manager.start(sampleStart()),
    /zaten aktif workflow/u,
  );

  const cancelled = await manager.cancel(first.workflowId);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.resumable, false);
});

test("terminal workflow records can be removed but active records are protected", async (t) => {
  const root = await createTempRoot(t);
  let releaseStep;
  const manager = createWorkflowManager({
    rootDir: root,
    executeStep: async () => new Promise((resolve) => {
      releaseStep = resolve;
    }),
  });

  await manager.initialize();
  const started = await manager.start(
    sampleStart({ steps: [{ id: "one", kind: "fake", label: "One" }] }),
  );
  await waitForStatus(manager, started.workflowId, "running");
  for (let attempt = 0; attempt < 100 && typeof releaseStep !== "function"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(typeof releaseStep, "function");

  await assert.rejects(
    () => manager.removeTerminalRecord(started.workflowId),
    /Yalnız terminal durumdaki workflow kaydı temizlenebilir/u,
  );

  releaseStep({ ok: true });
  await waitForStatus(manager, started.workflowId, "completed");
  const removed = await manager.removeTerminalRecord(started.workflowId);
  assert.equal(removed.status, "completed");
  assert.equal(manager.list({ state: "all" }).some((item) => item.workflowId === started.workflowId), false);
  assert.throws(() => manager.status(started.workflowId), /Workflow bulunamadı/u);
  await assert.rejects(fs.access(path.join(root, `${started.workflowId}.json`)));
  await assert.rejects(fs.access(path.join(root, `${started.workflowId}.log`)));
});
