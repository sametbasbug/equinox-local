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

test("lexical worktree containment rejects traversal, sibling prefixes and other roots", () => {
  const root = path.resolve("/workspace/worktrees");
  assert.equal(isPathInside(root, root), true);
  assert.equal(isPathInside(root, path.join(root, "equinox", "feature")), true);
  assert.equal(isPathInside(root, path.resolve(root, "..", "worktrees-private")), false);
  assert.equal(isPathInside(root, path.resolve(root, "..", "private")), false);
  assert.equal(isPathInside(root, path.resolve("/unrelated/worktrees/equinox")), false);
  // This utility is intentionally lexical, not a substitute for realpath admission.
  assert.equal(isPathInside(root, path.join(root, "symlink", "child")), true);
});

test("untrusted worktree porcelain never converts stray lines into entries", () => {
  const parsed = parseGitWorktreePorcelain([
    "HEAD ignored-before-worktree",
    "branch refs/heads/ignored",
    "",
    "worktree /workspace/worktrees/app/fix",
    "HEAD aaaa",
    "branch refs/heads/equinox/fix",
    "locked",
    "prunable reason with spaces",
    "future-field ignored",
    "",
    "worktree",
    "HEAD bbbb",
    "",
    "worktree /outside/worktree",
    "bare",
  ].join("\n"));
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], {
    path: "/workspace/worktrees/app/fix",
    head: "aaaa",
    branch: "equinox/fix",
    bare: false,
    detached: false,
    locked: true,
    lockReason: null,
    prunable: true,
    pruneReason: "reason with spaces",
  });
  assert.equal(parsed[1].bare, true);
  assert.equal(parsed[1].path, "/outside/worktree");
});

test("public worktree metadata never claims sibling or escaped path as managed", () => {
  const workspaceRoot = "/workspace";
  const base = {
    path: "/workspace/worktrees/app/fix", head: null, branch: null,
    bare: false, detached: false, locked: false, lockReason: null,
    prunable: false, pruneReason: null,
  };
  assert.deepEqual(publicWorktreeRecord({ workspaceRoot, record: base }), {
    ...base, managed: true, workspaceRelativePath: path.join("worktrees", "app", "fix"),
  });
  for (const escaped of [
    "/workspace/worktrees-other/app", "/workspace/outside/app",
    "/workspace/worktrees/../../outside", "/foreign/worktrees/app",
  ]) {
    const published = publicWorktreeRecord({ workspaceRoot, record: { ...base, path: escaped } });
    assert.equal(published.managed, false);
    assert.equal(published.workspaceRelativePath, null);
  }
});
