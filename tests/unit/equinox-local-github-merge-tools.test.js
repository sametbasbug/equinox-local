import test from "node:test";
import assert from "node:assert/strict";
import * as z from "zod/v4";

import { registerGithubMergeTool } from "../../src/equinox-local-github-merge-tools.js";

function createPullRequest(overrides = {}) {
  return {
    number: 7,
    title: "Ready PR",
    url: "https://github.com/owner/repo/pull/7",
    state: "OPEN",
    isDraft: false,
    baseRefName: "main",
    baseRefOid: "b".repeat(40),
    headRefName: "equinox/test",
    headRefOid: "a".repeat(40),
    isCrossRepository: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    mergedAt: null,
    ...overrides,
  };
}

function createHarness(overrides = {}) {
  const tools = new Map();
  const gitCalls = [];
  const ghCalls = [];
  const safeCalls = [];
  const pullRequests = [
    createPullRequest(),
    createPullRequest({
      state: "MERGED",
      mergedAt: "2026-09-06T12:00:00Z",
    }),
  ];

  const dependencies = {
    registerTextTool(name, definition, handler, options) {
      tools.set(name, { definition, handler, options });
    },
    z,
    assertNoGitOperationInProgress: async () => {},
    assertCleanGitWorktree: async () => {},
    getCurrentGitBranch: async () => "main",
    getExactHeadCommit: async () => "b".repeat(40),
    runGitWithCode: async (args, timeout) => {
      gitCalls.push({ args, timeout });
      if (args[0] === "fetch") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "rev-parse") {
        return { code: 0, stdout: `${"b".repeat(40)}\n`, stderr: "" };
      }
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    },
    sanitizeGitNetworkOutput: (value) => String(value ?? "").trim(),
    assertGhAuthenticated: async () => {},
    getGitHubRepoSlug: async () => "owner/repo",
    readPullRequestByNumber: async () => pullRequests.shift(),
    assertSafeMutablePullRequest(pr, expectedHead) {
      safeCalls.push({ pr, expectedHead });
    },
    readPullRequestChecksForMerge: async () => [
      { workflow: "CI", name: "test", bucket: "pass", state: "SUCCESS" },
    ],
    runGhWithCode: async (args, input = "", timeout) => {
      ghCalls.push({ args, input, timeout });
      if (args.includes("--method") && args.includes("PUT")) {
        return {
          code: 0,
          stdout: JSON.stringify({ merged: true, message: "Pull Request successfully merged" }),
          stderr: "",
        };
      }
      if (args[0] === "api" && args.includes("--jq")) {
        return { code: 0, stdout: `${"c".repeat(40)}\n`, stderr: "" };
      }
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    },
    parseJsonOutput: (value) => JSON.parse(value),
    textResult: (text) => ({ text }),
    errorResult: (error) => ({ error: error instanceof Error ? error.message : String(error) }),
    ...overrides,
  };

  registerGithubMergeTool(dependencies);
  return { tools, gitCalls, ghCalls, safeCalls };
}

test("GitHub merge tool preserves destructive registration metadata", () => {
  const { tools } = createHarness();
  assert.deepEqual([...tools.keys()], ["merge_pull_request"]);
  const tool = tools.get("merge_pull_request");
  assert.equal(tool.definition.annotations.readOnlyHint, false);
  assert.equal(tool.definition.annotations.destructiveHint, true);
  assert.equal(tool.definition.annotations.idempotentHint, false);
  assert.equal(tool.definition.annotations.openWorldHint, true);
});

test("merge_pull_request preserves exact main/head guards and atomic squash REST merge", async () => {
  const expectedHead = "a".repeat(40);
  const expectedMain = "b".repeat(40);
  const { tools, gitCalls, ghCalls, safeCalls } = createHarness();

  const result = await tools.get("merge_pull_request").handler({
    pr_number: 7,
    expected_head_sha: expectedHead.toUpperCase(),
    expected_main_sha: expectedMain.toUpperCase(),
    allow_no_checks: false,
  });

  assert.deepEqual(gitCalls[0], {
    args: ["fetch", "--no-tags", "origin", "refs/heads/main:refs/remotes/origin/main"],
    timeout: 120_000,
  });
  assert.equal(safeCalls.length, 1);
  assert.equal(safeCalls[0].expectedHead, expectedHead);

  const mergeCall = ghCalls.find(({ args }) => args.includes("--method"));
  assert.deepEqual(mergeCall.args, [
    "api",
    "--method",
    "PUT",
    "-H",
    "Accept: application/vnd.github+json",
    "-H",
    "X-GitHub-Api-Version: 2022-11-28",
    "repos/owner/repo/pulls/7/merge",
    "--input",
    "-",
  ]);
  assert.deepEqual(JSON.parse(mergeCall.input), {
    sha: expectedHead,
    merge_method: "squash",
  });
  assert.equal(mergeCall.timeout, 180_000);
  assert.match(result.text, /Pull request squash merge edildi: #7/u);
  assert.match(result.text, /Admin, bypass, auto-merge, force veya branch silme kullanılmadı/u);
});

test("merge_pull_request refuses missing checks unless allow_no_checks is explicit", async () => {
  const ghCalls = [];
  const { tools } = createHarness({
    readPullRequestChecksForMerge: async () => [],
    runGhWithCode: async (args, input = "", timeout) => {
      ghCalls.push({ args, input, timeout });
      return { code: 0, stdout: JSON.stringify({ merged: true }), stderr: "" };
    },
  });

  const result = await tools.get("merge_pull_request").handler({
    pr_number: 7,
    expected_head_sha: "a".repeat(40),
    expected_main_sha: "b".repeat(40),
    allow_no_checks: false,
  });

  assert.match(result.error, /hiçbir CI kontrolü raporlanmadı/u);
  assert.equal(ghCalls.length, 0);
});

test("merge_pull_request reports completed remote mutation when final verification fails", async () => {
  let readCount = 0;
  const { tools } = createHarness({
    readPullRequestByNumber: async () => {
      readCount += 1;
      if (readCount === 1) return createPullRequest();
      throw new Error("final PR read unavailable");
    },
  });

  const result = await tools.get("merge_pull_request").handler({
    pr_number: 7,
    expected_head_sha: "a".repeat(40),
    expected_main_sha: "b".repeat(40),
    allow_no_checks: false,
  });

  assert.match(result.text, /GitHub merge komutu tamamlandı ancak son doğrulama/u);
  assert.match(result.text, /get_pull_request/u);
});
