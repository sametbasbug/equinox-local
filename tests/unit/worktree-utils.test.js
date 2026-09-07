import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  isPathInside,
  parseGitWorktreePorcelain,
  publicWorktreeRecord,
} from "../../src/worktree-utils.js";

test("git worktree porcelain output is parsed", () => {
  const records = parseGitWorktreePorcelain(
    [
      "worktree /repo",
      "HEAD 0123456789012345678901234567890123456789",
      "branch refs/heads/main",
      "",
      "worktree /workspace/worktrees/blog/footer-fix",
      "HEAD abcdefabcdefabcdefabcdefabcdefabcdefabcd",
      "branch refs/heads/equinox/footer-fix",
      "locked agent running",
      "",
      "worktree /repo/detached",
      "HEAD 1111111111111111111111111111111111111111",
      "detached",
      "prunable gitdir file points to non-existent location",
      "",
    ].join("\n"),
  );

  assert.equal(records.length, 3);
  assert.equal(records[0].branch, "main");
  assert.equal(records[1].locked, true);
  assert.equal(records[1].lockReason, "agent running");
  assert.equal(records[2].detached, true);
  assert.equal(records[2].prunable, true);
});

test("public worktree record identifies managed paths", () => {
  const workspaceRoot = "/workspace";
  const result = publicWorktreeRecord({
    workspaceRoot,
    record: {
      path: "/workspace/worktrees/orbit/test",
      head: "abc",
      branch: "equinox/test",
      bare: false,
      detached: false,
      locked: false,
      lockReason: null,
      prunable: false,
      pruneReason: null,
    },
  });

  assert.equal(result.managed, true);
  assert.equal(
    result.workspaceRelativePath,
    path.join("worktrees", "orbit", "test"),
  );
});
