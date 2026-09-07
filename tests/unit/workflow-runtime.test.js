import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  __test,
  createWorkflowRuntime,
} from "../../src/workflow-runtime.js";

async function createHarness(t) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-workflow-runtime-"));
  t.after(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  const processManager = {
    start() { throw new Error("not used"); },
    list() { return []; },
    async readLogs() { throw new Error("not used"); },
    async stop() { return null; },
  };

  const manager = await createWorkflowRuntime({
    rootDir,
    processManager,
    probeTcpPort: async () => ({ listening: false }),
  });

  return { manager };
}

test("workflow runtime initializes the internal durable manager without public registrations", async (t) => {
  const { manager } = await createHarness(t);
  assert.equal(manager.summary().total, 0);
});

test("preview npm arguments are fixed by the detected adapter", () => {
  assert.deepEqual(
    __test.buildPreviewNpmArgs(
      { adapter: "host-port", script: "preview" },
      4321,
    ),
    ["run", "preview", "--", "--host", "127.0.0.1", "--port", "4321"],
  );
  assert.deepEqual(
    __test.buildPreviewNpmArgs(
      { adapter: "next-start", script: "start" },
      4322,
    ),
    ["run", "start", "--", "-H", "127.0.0.1", "-p", "4322"],
  );
});

test("preview port selector honors explicit free ports and rejects occupied ports", async () => {
  assert.equal(
    await __test.choosePreviewPort({
      requestedPort: 4444,
      probeTcpPort: async () => ({ listening: false }),
    }),
    4444,
  );

  await assert.rejects(
    () => __test.choosePreviewPort({
      requestedPort: 4444,
      probeTcpPort: async () => ({ listening: true }),
    }),
    /zaten kullanımda/u,
  );
});

test("workflow step executor delegates v3.8 extension steps", async () => {
  const calls = [];
  const executor = __test.createWorkflowStepExecutor({
    processManager: {},
    probeTcpPort: async () => ({ listening: false }),
    extraStepExecutor: async (context) => {
      calls.push(context.step.kind);
      return {
        handled: context.step.kind === "release-readiness",
        result: { verdict: "GREEN" },
      };
    },
  });

  const result = await executor({
    workflow: { projectId: "demo", projectName: "Demo", projectRoot: "/tmp/demo" },
    step: { kind: "release-readiness", label: "Readiness" },
    signal: new AbortController().signal,
    log: async () => {},
  });

  assert.deepEqual(calls, ["release-readiness"]);
  assert.deepEqual(result, { verdict: "GREEN" });
});
