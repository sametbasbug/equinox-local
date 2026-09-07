import test from "node:test";
import assert from "node:assert/strict";
import * as z from "zod/v4";

import { registerGithubReadonlyTools } from "../../src/equinox-local-github-readonly-tools.js";

function createHarness(overrides = {}) {
  const tools = new Map();
  const ghCalls = [];

  const dependencies = {
    registerTextTool(name, definition, handler, options) {
      tools.set(name, { definition, handler, options });
    },
    z,
    assertGhAuthenticated: async () => {},
    getGitHubRepoSlug: async () => "samet/repo",
    readPullRequestByNumber: async (_repo, number) => ({
      number,
      title: "Test PR",
      url: "https://example.invalid/pr/7",
      state: "OPEN",
      isDraft: false,
      baseRefName: "main",
      baseRefOid: "a".repeat(40),
      headRefName: "equinox/test",
      headRefOid: "b".repeat(40),
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: "",
      changedFiles: 3,
      additions: 20,
      deletions: 4,
      createdAt: "2026-09-06T00:00:00Z",
      updatedAt: "2026-09-06T01:00:00Z",
      mergedAt: null,
      closedAt: null,
      maintainerCanModify: true,
      body: "Body",
    }),
    runGhWithCode: async (args, input = "", timeout) => {
      ghCalls.push({ args, input, timeout });
      return { code: 0, stdout: "[]", stderr: "" };
    },
    parsePullRequestChecksResult: () => [],
    parseJsonOutput: (text) => JSON.parse(text),
    readWorkflowRunById: async (_repo, runId) => ({
      databaseId: runId,
      workflowName: "CI",
      displayTitle: "Build",
      status: "completed",
      conclusion: "success",
      event: "push",
      headBranch: "equinox/test",
      headSha: "c".repeat(40),
      attempt: 1,
      startedAt: "2026-09-06T02:00:00Z",
      createdAt: "2026-09-06T02:00:00Z",
      updatedAt: "2026-09-06T02:10:00Z",
      url: "https://example.invalid/run/9",
      jobs: [{ name: "test" }],
    }),
    formatWorkflowJobs: () => "job-summary",
    sanitizeGitNetworkOutput: (value) => value,
    textResult: (text) => ({ text }),
    errorResult: (error) => ({
      error: error instanceof Error ? error.message : String(error),
    }),
    ...overrides,
  };

  registerGithubReadonlyTools(dependencies);
  return { tools, ghCalls };
}

test("GitHub readonly tools preserve registration metadata and pull request formatting", async () => {
  const { tools } = createHarness();

  assert.deepEqual([...tools.keys()], [
    "get_pull_request",
    "get_pull_request_checks",
    "list_workflow_runs",
    "get_workflow_run",
  ]);
  for (const tool of tools.values()) {
    assert.equal(tool.definition.annotations.readOnlyHint, true);
    assert.equal(tool.definition.annotations.destructiveHint, false);
    assert.equal(tool.definition.annotations.openWorldHint, true);
  }

  const result = await tools.get("get_pull_request").handler({ pr_number: 7 });
  assert.match(result.text, /PR #7: Test PR/u);
  assert.match(result.text, /Base: main \(a{40}\)/u);
  assert.match(result.text, /Head: equinox\/test \(b{40}\)/u);
  assert.match(result.text, /Değişiklik: 3 dosya, \+20 \/ -4/u);
  assert.match(result.text, /Maintainer düzenlemesi: Açık/u);
});

test("pull request checks preserve required filtering and bucket summary", async () => {
  const { tools, ghCalls } = createHarness({
    parsePullRequestChecksResult: () => [
      { bucket: "pass", name: "test", state: "SUCCESS", workflow: "CI", description: "ok", link: "https://example.invalid/check" },
      { bucket: "fail", name: "lint", state: "FAILURE", workflow: "CI", description: "bad", link: "" },
      { bucket: "mystery", name: "other", state: "UNKNOWN", workflow: "", description: "", link: "" },
    ],
  });

  const result = await tools.get("get_pull_request_checks").handler({
    pr_number: 8,
    required_only: true,
  });

  assert.equal(ghCalls.length, 1);
  assert.deepEqual(ghCalls[0].args.slice(0, 6), ["pr", "checks", "8", "--repo", "samet/repo", "--json"]);
  assert.equal(ghCalls[0].args.at(-1), "--required");
  assert.match(result.text, /kontrol sayısı: 3/u);
  assert.match(result.text, /pass=1, fail=1, pending=0, skipping=0, cancel=0, other=1/u);
});

test("workflow run listing preserves bounded filters and lowercases commit SHA", async () => {
  const runs = [{
    databaseId: 42,
    workflowName: "CI",
    displayTitle: "Build",
    status: "completed",
    conclusion: "success",
    headBranch: "equinox/test",
    headSha: "d".repeat(40),
    event: "push",
    attempt: 2,
    startedAt: "2026-09-06T03:00:00Z",
    createdAt: "2026-09-06T03:00:00Z",
    url: "https://example.invalid/run/42",
  }];
  const { tools, ghCalls } = createHarness({
    runGhWithCode: async (args, input = "", timeout) => {
      ghCalls.push({ args, input, timeout });
      return { code: 0, stdout: JSON.stringify(runs), stderr: "" };
    },
  });

  const result = await tools.get("list_workflow_runs").handler({
    limit: 7,
    branch: "equinox/test",
    status: "success",
    workflow: "CI",
    commit_sha: "A".repeat(40),
  });

  const args = ghCalls[0].args;
  assert.ok(args.includes("7"));
  assert.deepEqual(args.slice(args.indexOf("--branch"), args.indexOf("--branch") + 2), ["--branch", "equinox/test"]);
  assert.deepEqual(args.slice(args.indexOf("--status"), args.indexOf("--status") + 2), ["--status", "success"]);
  assert.deepEqual(args.slice(args.indexOf("--workflow"), args.indexOf("--workflow") + 2), ["--workflow", "CI"]);
  assert.deepEqual(args.slice(args.indexOf("--commit"), args.indexOf("--commit") + 2), ["--commit", "a".repeat(40)]);
  assert.match(result.text, /Workflow run sayısı: 1/u);
  assert.match(result.text, /#42 \| CI/u);
});

test("workflow run detail preserves optional failed-log retrieval and bounded timeout", async () => {
  const { tools, ghCalls } = createHarness({
    runGhWithCode: async (args, input = "", timeout) => {
      ghCalls.push({ args, input, timeout });
      return { code: 0, stdout: "failed-step-log token=redacted", stderr: "" };
    },
    sanitizeGitNetworkOutput: (value) => value.replace("token=redacted", "token=[REDACTED]"),
  });

  const result = await tools.get("get_workflow_run").handler({
    run_id: 9,
    include_failed_logs: true,
  });

  assert.equal(ghCalls.length, 1);
  assert.deepEqual(ghCalls[0].args, ["run", "view", "9", "--repo", "samet/repo", "--log-failed"]);
  assert.equal(ghCalls[0].input, "");
  assert.equal(ghCalls[0].timeout, 180_000);
  assert.match(result.text, /Workflow run: #9/u);
  assert.match(result.text, /Job'lar:\njob-summary/u);
  assert.match(result.text, /token=\[REDACTED\]/u);
});
