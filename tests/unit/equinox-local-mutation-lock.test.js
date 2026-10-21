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


test("Git metadata reads reject symlink swaps through no-follow file handles", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-git-metadata-nofollow-"));
  try {
    const worktree = path.join(root, "worktree");
    const realMetadata = path.join(root, "metadata");
    await fs.mkdir(worktree, { recursive: true });
    await fs.writeFile(realMetadata, "gitdir: /tmp/elsewhere\n");
    await fs.symlink(realMetadata, path.join(worktree, ".git"));
    await assert.rejects(
      resolveGitCommonDirectory(worktree),
      /Git metadata path may not be a symlink/u,
    );

    const main = path.join(root, "main");
    const gitDir = path.join(main, ".git");
    const externalCommon = path.join(root, "external-common");
    await fs.mkdir(gitDir, { recursive: true });
    await fs.mkdir(externalCommon, { recursive: true });
    await fs.symlink(path.join(root, "commondir-target"), path.join(gitDir, "commondir"));
    await fs.writeFile(path.join(root, "commondir-target"), `${externalCommon}\n`);
    await assert.rejects(
      resolveGitCommonDirectory(main),
      /Git commondir metadata may not be a symlink/u,
    );
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

test("timed-out mutation lock never starts the waiting task and leaves no stale owner", async () => {
  const manager = createMutationPathLockManager({waitMs:20});
  const entered=deferred(),release=deferred();
  const calls=[];
  const first=manager.withLock("/tmp/owned-repo",async()=>{
    calls.push("owner:enter");
    entered.resolve();
    await release.promise;
    calls.push("owner:exit");
  });
  await entered.promise;
  await assert.rejects(manager.withLock("/tmp/owned-repo/src",async()=>{
    calls.push("expired:must-not-enter");
  }),/Yazma kilidi bekleme süresi aşıldı/u);
  assert.deepEqual(calls,["owner:enter"]);
  release.resolve();
  await first;
  await manager.withLock("/tmp/owned-repo",async()=>calls.push("later:entered"));
  assert.deepEqual(calls,["owner:enter","owner:exit","later:entered"]);
});

test("failed locked task releases overlap serialization without cross-root blockage", async () => {
  const manager=createMutationPathLockManager({waitMs:1000});
  const entered=deferred(),allowFail=deferred(),trace=[];
  const failing=manager.withLock("/tmp/owner",async()=>{
    trace.push("first-enter");
    entered.resolve();
    await allowFail.promise;
    throw Error("fixture failure does not poison lock");
  });
  await entered.promise;
  const subsequent=manager.withLock("/tmp/owner/nested",async()=>trace.push("second-enter"));
  await manager.withLock("/tmp/independent",async()=>trace.push("sibling-enter"));
  assert.deepEqual(trace,["first-enter","sibling-enter"]);
  allowFail.resolve();
  await assert.rejects(failing,/fixture failure/u);
  await subsequent;
  assert.deepEqual(trace,["first-enter","sibling-enter","second-enter"]);
});

test("Git worktree metadata refuses oversized and malformed gitdir before path traversal",async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"equinox-mutlock-invalid-gitdir-"));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const project=path.join(root,"project");
  await fs.mkdir(project);
  const dotgit=path.join(project,".git");
  await fs.writeFile(dotgit,"x".repeat(4097));
  await assert.rejects(resolveGitCommonDirectory(project),/outside the allowed bounds/u);
  await fs.writeFile(dotgit,"gitdir: \u0000bad-path\n");
  await assert.rejects(resolveGitCommonDirectory(project),/Git worktree metadata file is invalid/u);
});
