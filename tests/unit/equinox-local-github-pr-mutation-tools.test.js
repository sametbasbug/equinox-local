import test from "node:test";
import assert from "node:assert/strict";
import * as z from "zod/v4";

import { registerGithubPrMutationTools } from "../../src/equinox-local-github-pr-mutation-tools.js";

function createPr(overrides = {}) {
  return {
    number: 7,
    title: "Old title",
    body: "Old body",
    url: "https://github.com/owner/repo/pull/7",
    state: "OPEN",
    isDraft: false,
    baseRefName: "main",
    headRefName: "equinox/test",
    headRefOid: "a".repeat(40),
    isCrossRepository: false,
    ...overrides,
  };
}

function createHarness(overrides = {}) {
  const tools = new Map();
  const ghCalls = [];
  const safeCalls = [];
  let authCalls = 0;

  const dependencies = {
    registerTextTool(name, definition, handler, options) {
      tools.set(name, { definition, handler, options });
    },
    z,
    assertGhAuthenticated: async () => {
      authCalls += 1;
    },
    assertNoGitOperationInProgress: async () => {},
    assertCleanGitWorktree: async () => {},
    getCurrentGitBranch: async () => "equinox/test",
    assertPushableEquinoxBranch: () => {},
    getExactHeadCommit: async () => "a".repeat(40),
    runGitWithCode: async (args) => {
      if (args[0] === "rev-parse") {
        return { code: 0, stdout: `${"b".repeat(40)}\n`, stderr: "" };
      }
      if (args[0] === "merge-base") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "rev-list") {
        return { code: 0, stdout: "3\n", stderr: "" };
      }
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    },
    assertRemoteBranchAtHead: async (_branch, expectedHead) => expectedHead,
    getGitHubRepoSlug: async () => "owner/repo",
    readPullRequestByNumber: async () => createPr(),
    assertSafeMutablePullRequest(pr, expectedHead) {
      safeCalls.push({ pr, expectedHead });
    },
    runGhWithCode: async (args, input = "", timeout) => {
      ghCalls.push({ args, input, timeout });
      return { code: 0, stdout: "", stderr: "" };
    },
    parseJsonOutput: (value) => JSON.parse(value),
    sanitizeGitNetworkOutput: (value) => String(value ?? "").trim(),
    textResult: (text) => ({ text }),
    errorResult: (error) => ({ error: error instanceof Error ? error.message : String(error) }),
    ...overrides,
  };

  registerGithubPrMutationTools(dependencies);
  return {
    tools,
    ghCalls,
    safeCalls,
    counters: {
      get authCalls() {
        return authCalls;
      },
    },
  };
}

test("GitHub PR mutation tools preserve destructive registration metadata", () => {
  const { tools } = createHarness();

  assert.deepEqual(
    [...tools.keys()],
    ["create_pull_request", "update_pull_request", "set_pull_request_draft", "close_pull_request"],
  );

  for (const tool of tools.values()) {
    assert.equal(tool.definition.annotations.readOnlyHint, false);
    assert.equal(tool.definition.annotations.openWorldHint, true);
  }

  assert.equal(tools.get("create_pull_request").definition.annotations.destructiveHint, false);
  assert.equal(tools.get("create_pull_request").definition.annotations.idempotentHint, false);
  assert.equal(tools.get("update_pull_request").definition.annotations.destructiveHint, true);
  assert.equal(tools.get("update_pull_request").definition.annotations.idempotentHint, true);
  assert.equal(tools.get("set_pull_request_draft").definition.annotations.destructiveHint, true);
  assert.equal(tools.get("set_pull_request_draft").definition.annotations.idempotentHint, true);
  assert.equal(tools.get("close_pull_request").definition.annotations.destructiveHint, true);
  assert.equal(tools.get("close_pull_request").definition.annotations.idempotentHint, false);
});

test("create_pull_request preserves branch, SHA, duplicate-PR and post-create verification guards", async () => {
  const expected = "a".repeat(40);
  const { tools, ghCalls } = createHarness({
    runGhWithCode: async (args, input = "", timeout) => {
      ghCalls.push({ args, input, timeout });
      if (args[0] === "auth") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "pr" && args[1] === "list") {
        return { code: 0, stdout: "[]", stderr: "" };
      }
      if (args[0] === "pr" && args[1] === "create") {
        return { code: 0, stdout: "https://github.com/owner/repo/pull/8\n", stderr: "" };
      }
      if (args[0] === "pr" && args[1] === "view") {
        return {
          code: 0,
          stdout: JSON.stringify({
            number: 8,
            url: "https://github.com/owner/repo/pull/8",
            title: "Create guarded PR",
            state: "OPEN",
            isDraft: true,
            headRefName: "equinox/test",
            headRefOid: expected,
            baseRefName: "main",
            maintainerCanModify: false,
          }),
          stderr: "",
        };
      }
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    },
  });

  const result = await tools.get("create_pull_request").handler({
    expected_head_sha: expected.toUpperCase(),
    title: "Create guarded PR",
    body: "  bounded body  ",
  });

  const createCall = ghCalls.find(({ args }) => args[0] === "pr" && args[1] === "create");
  assert.deepEqual(createCall.args, [
    "pr", "create", "--repo", "owner/repo", "--base", "main", "--head", "equinox/test",
    "--title", "Create guarded PR", "--body-file", "-", "--no-maintainer-edit", "--draft",
  ]);
  assert.equal(createCall.input, "bounded body");
  assert.equal(createCall.timeout, 120_000);
  assert.match(result.text, /Pull request oluşturuldu: #8/u);
  assert.match(result.text, /Maintainer düzenlemesi: Kapalı/u);
});

test("create_pull_request reports a completed remote mutation when only final verification fails", async () => {
  const expected = "a".repeat(40);
  const { tools } = createHarness({
    runGhWithCode: async (args) => {
      if (args[0] === "auth") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "pr" && args[1] === "list") return { code: 0, stdout: "[]", stderr: "" };
      if (args[0] === "pr" && args[1] === "create") return { code: 0, stdout: "ok", stderr: "" };
      if (args[0] === "pr" && args[1] === "view") return { code: 1, stdout: "", stderr: "not visible yet" };
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    },
  });

  const result = await tools.get("create_pull_request").handler({
    expected_head_sha: expected,
    title: "Create guarded PR",
    draft: false,
  });

  assert.match(result.text, /Pull request GitHub üzerinde oluşturuldu/u);
  assert.match(result.text, /yeniden create_pull_request çağırma/u);
});

test("update_pull_request preserves HEAD guard, stdin body editing and post-write verification", async () => {
  const expected = "a".repeat(40);
  const before = createPr();
  const after = createPr({ title: "Updated title", body: "Updated body" });
  const reads = [before, after];
  const { tools, ghCalls, safeCalls, counters } = createHarness({
    readPullRequestByNumber: async () => reads.shift(),
  });

  const result = await tools.get("update_pull_request").handler({
    pr_number: 7,
    expected_head_sha: expected.toUpperCase(),
    title: "Updated title",
    body: "Updated body",
  });

  assert.equal(counters.authCalls, 1);
  assert.equal(safeCalls.length, 2);
  assert.equal(safeCalls[0].expectedHead, expected);
  assert.equal(safeCalls[1].expectedHead, expected);
  assert.deepEqual(ghCalls[0].args, [
    "pr",
    "edit",
    "7",
    "--repo",
    "owner/repo",
    "--title",
    "Updated title",
    "--body-file",
    "-",
  ]);
  assert.equal(ghCalls[0].input, "Updated body");
  assert.match(result.text, /PR #7 güncellendi/u);
  assert.match(result.text, /Base branch değiştirilmedi/u);
});

test("set_pull_request_draft preserves no-op and --undo draft transition semantics", async () => {
  const expected = "a".repeat(40);
  const alreadyDraft = createPr({ isDraft: true });
  const noOp = createHarness({
    readPullRequestByNumber: async () => alreadyDraft,
  });

  const noOpResult = await noOp.tools.get("set_pull_request_draft").handler({
    pr_number: 7,
    expected_head_sha: expected,
    draft: true,
  });
  assert.equal(noOp.ghCalls.length, 0);
  assert.match(noOpResult.text, /zaten draft durumda/u);

  const reads = [createPr({ isDraft: false }), createPr({ isDraft: true })];
  const changed = createHarness({
    readPullRequestByNumber: async () => reads.shift(),
  });

  const result = await changed.tools.get("set_pull_request_draft").handler({
    pr_number: 7,
    expected_head_sha: expected,
    draft: true,
  });

  assert.deepEqual(changed.ghCalls[0].args, [
    "pr",
    "ready",
    "7",
    "--repo",
    "owner/repo",
    "--undo",
  ]);
  assert.equal(changed.safeCalls.length, 2);
  assert.match(result.text, /Draft: Evet/u);
});

test("close_pull_request trims optional comment and verifies CLOSED state plus exact HEAD", async () => {
  const expected = "a".repeat(40);
  const reads = [createPr(), createPr({ state: "CLOSED" })];
  const { tools, ghCalls, safeCalls } = createHarness({
    readPullRequestByNumber: async () => reads.shift(),
  });

  const result = await tools.get("close_pull_request").handler({
    pr_number: 7,
    expected_head_sha: expected.toUpperCase(),
    comment: "  closing note  ",
  });

  assert.equal(safeCalls.length, 1);
  assert.equal(safeCalls[0].expectedHead, expected);
  assert.deepEqual(ghCalls[0].args, [
    "pr",
    "close",
    "7",
    "--repo",
    "owner/repo",
    "--comment",
    "closing note",
  ]);
  assert.match(result.text, /PR #7 kapatıldı/u);
  assert.match(result.text, /Branch silinmedi ve merge yapılmadı/u);
});
