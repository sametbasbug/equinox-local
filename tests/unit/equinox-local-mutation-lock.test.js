import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createMutationPathLockManager,
  mutationPathsOverlap,
  resolveGitCommonDirectory,
} from "../../src/equinox-local-mutation-lock.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("linked worktrees resolve to the same common Git metadata directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-git-common-lock-"));
  try {
    const main = path.join(root, "main");
    const child = path.join(root, "child");
    const worktreeGitDir = path.join(main, ".git", "worktrees", "child");
    await fs.mkdir(worktreeGitDir, { recursive: true });
    await fs.mkdir(child, { recursive: true });
    await fs.writeFile(path.join(child, ".git"), `gitdir: ${worktreeGitDir}\n`);
    await fs.writeFile(path.join(worktreeGitDir, "commondir"), "../..\n");

    const mainCommon = await resolveGitCommonDirectory(main);
    const childCommon = await resolveGitCommonDirectory(child);
    assert.equal(mainCommon, await fs.realpath(path.join(main, ".git")));
    assert.equal(childCommon, mainCommon);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("mutation path overlap detects aliases and nested roots without conflating siblings", () => {
  assert.equal(mutationPathsOverlap("/tmp/repo", "/tmp/repo"), true);
  assert.equal(mutationPathsOverlap("/tmp/repo", "/tmp/repo/packages/app"), true);
  assert.equal(mutationPathsOverlap("/tmp/repo/packages/app", "/tmp/repo"), true);
  assert.equal(mutationPathsOverlap("/tmp/repo/a", "/tmp/repo/b"), false);
});

test("same and nested mutation roots serialize through one canonical path lane", async () => {
  const manager = createMutationPathLockManager({ waitMs: 1000 });
  const releaseParent = deferred();
  const parentEntered = deferred();
  const events = [];

  const parent = manager.withLock("/tmp/repo", async () => {
    events.push("parent:start");
    parentEntered.resolve();
    await releaseParent.promise;
    events.push("parent:end");
  });
  await parentEntered.promise;

  const nested = manager.withLock("/tmp/repo/packages/app", async () => {
    events.push("nested:start");
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(events, ["parent:start"]);

  releaseParent.resolve();
  await Promise.all([parent, nested]);
  assert.deepEqual(events, ["parent:start", "parent:end", "nested:start"]);
});

test("sibling mutation roots can proceed concurrently", async () => {
  const manager = createMutationPathLockManager({ waitMs: 1000 });
  const releaseFirst = deferred();
  const firstEntered = deferred();
  const secondEntered = deferred();

  const first = manager.withLock("/tmp/repo/a", async () => {
    firstEntered.resolve();
    await releaseFirst.promise;
  });
  await firstEntered.promise;

  const second = manager.withLock("/tmp/repo/b", async () => {
    secondEntered.resolve();
  });
  await Promise.race([
    secondEntered.promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("sibling lock was unnecessarily serialized")), 100)),
  ]);

  releaseFirst.resolve();
  await Promise.all([first, second]);
});
