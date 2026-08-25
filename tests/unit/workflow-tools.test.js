import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as z from "zod/v4";

import {
  __test,
  registerWorkflowTools,
} from "../../src/workflow-tools.js";

async function createHarness(t, scripts = {}) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-workflow-tools-"));
  t.after(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  const tools = new Map();
  const registerTextTool = (name, config, handler, options) => {
    tools.set(name, { config, handler, options });
  };
  const processManager = {
    start() { throw new Error("not used"); },
    list() { return []; },
    async readLogs() { throw new Error("not used"); },
    async stop() { return null; },
  };

  const manager = await registerWorkflowTools({
    rootDir,
    registerTextTool,
    z,
    getActiveProjectId: () => "demo",
    getActiveProjectName: () => "Demo",
    getActiveProjectRoot: () => "/tmp/demo",
    resolveProjectContext: async () => ({ rootRealPath: "/tmp/demo" }),
    readProjectPackageJson: async () => ({ scripts }),
    processManager,
    probeTcpPort: async () => ({ listening: false }),
    processJsonResult: (value) => value,
    errorResult: (error) => ({ error: error.message }),
  });

  return { tools, manager };
}

test("workflow module registers the complete v3.7 tool set", async (t) => {
  const { tools, manager } = await createHarness(t, {
    build: "astro build",
    preview: "astro preview",
  });

  assert.deepEqual([...tools.keys()], [
    "workflow_recipes",
    "workflow_start",
    "workflow_list",
    "workflow_status",
    "workflow_logs",
    "workflow_cancel",
    "workflow_resume",
  ]);
  assert.equal(manager.summary().total, 0);
});

test("workflow_recipes reports project-specific availability", async (t) => {
  const { tools } = await createHarness(t, {
    check: "astro check",
    build: "astro build",
    preview: "astro preview",
  });

  const result = await tools.get("workflow_recipes").handler({});
  assert.equal(result.projectId, "demo");
  assert.equal(result.recipes.find((item) => item.id === "checks").available, true);
  assert.equal(result.recipes.find((item) => item.id === "qa-and-preview").available, true);
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
