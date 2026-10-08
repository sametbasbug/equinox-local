import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { EQUINOX_LOCAL_MAIN_REMOTE } from "../../src/equinox-local-main-update.js";
import { readEquinoxLocalMainSourcePointer, writeEquinoxLocalMainSourcePointer } from "../../src/equinox-local-main-source-pointer.js";

const SHA = "a".repeat(40);

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "equinox-pointer-"));
  const sourceRoot = path.join(root, "source");
  const pointerPath = path.join(root, "state", "current-source.conf");
  await fs.mkdir(sourceRoot);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [];
  const execFileImpl = async (command, args) => {
    calls.push([command, ...args]);
    const key = args.slice(2).join(" ");
    if (key === "rev-parse --show-toplevel") return { stdout: `${sourceRoot}\n`, stderr: "" };
    if (key === "rev-parse HEAD") return { stdout: `${SHA}\n`, stderr: "" };
    if (key === "symbolic-ref --quiet --short HEAD") return { stdout: "main\n", stderr: "" };
    if (key === "remote get-url origin") return { stdout: `${EQUINOX_LOCAL_MAIN_REMOTE}\n`, stderr: "" };
    if (key === "status --porcelain=v1 --untracked-files=normal") return { stdout: "", stderr: "" };
    throw new Error(`Unexpected command ${command} ${args.join(" ")}`);
  };
  return { root, sourceRoot, pointerPath, execFileImpl, calls };
}

test("main source pointer atomically records an exact canonical main checkout", async (t) => {
  const f = await fixture(t);
  const written = await writeEquinoxLocalMainSourcePointer(f.pointerPath, { sourceRoot: f.sourceRoot, sha: SHA }, { execFileImpl: f.execFileImpl });
  assert.equal(written.sourceRoot, f.sourceRoot);
  assert.equal(written.sha, SHA);
  assert.equal((await fs.stat(f.pointerPath)).mode & 0o077, 0);
  assert.equal((await fs.readdir(path.dirname(f.pointerPath))).filter((name) => name.includes(".tmp")).length, 0);
  assert.deepEqual(await readEquinoxLocalMainSourcePointer(f.pointerPath, { execFileImpl: f.execFileImpl }), written);
});

test("main source pointer refuses an exact-SHA mismatch before replacing the old pointer", async (t) => {
  const f = await fixture(t);
  await writeEquinoxLocalMainSourcePointer(f.pointerPath, { sourceRoot: f.sourceRoot, sha: SHA }, { execFileImpl: f.execFileImpl });
  const before = await fs.readFile(f.pointerPath, "utf8");
  await assert.rejects(writeEquinoxLocalMainSourcePointer(f.pointerPath, { sourceRoot: f.sourceRoot, sha: "b".repeat(40) }, { execFileImpl: f.execFileImpl }), /changed before activation/u);
  assert.equal(await fs.readFile(f.pointerPath, "utf8"), before);
});

test("main source pointer rejects permissive state-file permissions", async (t) => {
  if (process.platform === "win32") return;
  const f = await fixture(t);
  await writeEquinoxLocalMainSourcePointer(f.pointerPath, { sourceRoot: f.sourceRoot, sha: SHA }, { execFileImpl: f.execFileImpl });
  await fs.chmod(f.pointerPath, 0o644);
  await assert.rejects(readEquinoxLocalMainSourcePointer(f.pointerPath, { execFileImpl: f.execFileImpl }), /permissions must be private/u);
});

test("main source pointer rejects symlink substitution", async (t) => {
  if (process.platform === "win32") return;
  const f = await fixture(t);
  const real = path.join(f.root, "real.conf");
  await fs.mkdir(path.dirname(f.pointerPath), { recursive: true });
  await fs.writeFile(real, `schemaVersion=1\nsourceRoot=${f.sourceRoot}\nsha=${SHA}\n`, { mode: 0o600 });
  await fs.symlink(real, f.pointerPath);
  await assert.rejects(readEquinoxLocalMainSourcePointer(f.pointerPath, { execFileImpl: f.execFileImpl }));
});

test("Windows main source pointer receives explicit ACL before atomic publish", async (t) => {
  const f = await fixture(t);
  const protectedTargets = [];
  const written = await writeEquinoxLocalMainSourcePointer(f.pointerPath, { sourceRoot: f.sourceRoot, sha: SHA }, {
    execFileImpl: f.execFileImpl,
    platform: "win32",
    env: { SystemRoot: "C:\\Windows" },
    protectWindowsAcl: async ({ target, type }) => {
      protectedTargets.push([target, type]);
      return { safe: true };
    },
    verifyWindowsAcl: async () => ({ safe: true }),
  });
  assert.equal(written.sha, SHA);
  assert.equal(protectedTargets.length, 1);
  assert.equal(protectedTargets[0][1], "file");
  assert.match(path.basename(protectedTargets[0][0]), /^\.main-source-.*\.tmp$/u);
});
