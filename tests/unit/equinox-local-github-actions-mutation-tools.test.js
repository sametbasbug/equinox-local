import test from "node:test";
import assert from "node:assert/strict";
import * as z from "zod/v4";

import { registerGithubActionsMutationTools } from "../../src/equinox-local-github-actions-mutation-tools.js";

const HEAD_SHA = "a".repeat(40);

function createRun(overrides = {}) {
  return {
    databaseId: 55,
    workflowName: "CI",
    name: "CI",
    headSha: HEAD_SHA,
    attempt: 3,
    status: "completed",
    conclusion: "failure",
    ...overrides,
  };
}

function createHarness(overrides = {}) {
  const tools = new Map();
  const ghCalls = [];
  const delays = [];
  const runs = [createRun(), createRun({ attempt: 4, status: "queued", conclusion: "" })];
  let authCalls = 0;

  const dependencies = {
    registerTextTool(name, definition, handler, options) {
      tools.set(name, { definition, handler, options });
    },
    z,
    assertGhAuthenticated: async () => {
      authCalls += 1;
    },
    getGitHubRepoSlug: async () => "owner/repo",
    readWorkflowRunById: async () => runs.shift() ?? createRun(),
    normalizeWorkflowHeadSha: (run) => String(run.headSha ?? "").toLowerCase(),
    runGhWithCode: async (args) => {
      ghCalls.push(args);
      return { code: 0, stdout: "", stderr: "" };
    },
    delayMilliseconds: async (ms) => {
      delays.push(ms);
    },
    sanitizeGitNetworkOutput: (value) => String(value ?? "").trim(),
    textResult: (text) => ({ text }),
    errorResult: (error) => ({ error: error instanceof Error ? error.message : String(error) }),
    ...overrides,
  };

  registerGithubActionsMutationTools(dependencies);
  return {
    tools,
    ghCalls,
    delays,
    counters: {
      get authCalls() {
        return authCalls;
      },
    },
  };
}

test("GitHub Actions mutation tools preserve registration metadata", () => {
  const { tools } = createHarness();
  assert.deepEqual([...tools.keys()], ["rerun_failed_workflow", "cancel_workflow_run"]);

  const rerun = tools.get("rerun_failed_workflow").definition.annotations;
  assert.equal(rerun.readOnlyHint, false);
  assert.equal(rerun.destructiveHint, false);
  assert.equal(rerun.idempotentHint, false);
  assert.equal(rerun.openWorldHint, true);

  const cancel = tools.get("cancel_workflow_run").definition.annotations;
  assert.equal(cancel.readOnlyHint, false);
  assert.equal(cancel.destructiveHint, true);
  assert.equal(cancel.idempotentHint, false);
  assert.equal(cancel.openWorldHint, true);
});

test("rerun_failed_workflow preserves exact SHA and attempt guards plus failed-only rerun", async () => {
  const reads = [
    createRun(),
    createRun({ attempt: 4, status: "queued", conclusion: "" }),
  ];
  const { tools, ghCalls, delays, counters } = createHarness({
    readWorkflowRunById: async () => reads.shift(),
  });

  const result = await tools.get("rerun_failed_workflow").handler({
    run_id: 55,
    expected_head_sha: HEAD_SHA.toUpperCase(),
    expected_attempt: 3,
  });

  assert.equal(counters.authCalls, 1);
  assert.deepEqual(ghCalls, [["run", "rerun", "55", "--repo", "owner/repo", "--failed"]]);
  assert.deepEqual(delays, [2000]);
  assert.match(result.text, /Workflow yeniden çalıştırma isteği gönderildi: #55/u);
  assert.match(result.text, /Yalnızca başarısız job'lar/u);
  assert.match(result.text, /attempt 4/u);
});

test("rerun_failed_workflow refuses changed attempt before GitHub mutation", async () => {
  const { tools, ghCalls } = createHarness({
    readWorkflowRunById: async () => createRun({ attempt: 4 }),
  });

  const result = await tools.get("rerun_failed_workflow").handler({
    run_id: 55,
    expected_head_sha: HEAD_SHA,
    expected_attempt: 3,
  });

  assert.match(result.error, /attempt değeri değişmiş/u);
  assert.equal(ghCalls.length, 0);
});

test("cancel_workflow_run uses normal cancel and bounded polling without force", async () => {
  const reads = [
    createRun({ status: "in_progress", conclusion: "" }),
    createRun({ status: "in_progress", conclusion: "" }),
    createRun({ status: "completed", conclusion: "cancelled" }),
  ];
  const { tools, ghCalls, delays } = createHarness({
    readWorkflowRunById: async () => reads.shift(),
  });

  const result = await tools.get("cancel_workflow_run").handler({
    run_id: 55,
    expected_head_sha: HEAD_SHA.toUpperCase(),
    expected_attempt: 3,
  });

  assert.deepEqual(ghCalls, [["run", "cancel", "55", "--repo", "owner/repo"]]);
  assert.deepEqual(delays, [2000, 2000]);
  assert.match(result.text, /Workflow iptal isteği gönderildi: #55/u);
  assert.match(result.text, /completed\/cancelled/u);
  assert.match(result.text, /Force cancel kullanılmadı/u);
});

test("cancel_workflow_run refuses a completed run before mutation", async () => {
  const { tools, ghCalls } = createHarness({
    readWorkflowRunById: async () => createRun({ status: "completed", conclusion: "success" }),
  });

  const result = await tools.get("cancel_workflow_run").handler({
    run_id: 55,
    expected_head_sha: HEAD_SHA,
    expected_attempt: 3,
  });

  assert.match(result.error, /aktif ve iptal edilebilir durumda değil/u);
  assert.equal(ghCalls.length, 0);
});
