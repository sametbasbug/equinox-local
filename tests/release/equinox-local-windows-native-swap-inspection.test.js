import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { inspectEquinoxLocalWindowsNativeSwap } from "../../src/equinox-local-windows-native-swap-inspection.js";

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "equinox-native-recovery-audit-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const programRoot = path.join(root, "Programs", "Equinox Local");
  const previousReleaseDir = path.join(root, "releases", "6.0.4");
  const targetReleaseDir = path.join(root, "releases", "6.0.5");
  const previousShell = path.join(previousReleaseDir, "runtime", "shell");
  const targetShell = path.join(targetReleaseDir, "runtime", "shell");
  for (const [dir, data] of [[previousShell, "before"], [targetShell, "after"]]) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "EquinoxLocal.exe"), data);
    await fs.writeFile(path.join(dir, "coreclr.dll"), data);
  }
  await fs.mkdir(path.dirname(programRoot), { recursive: true });
  await fs.cp(previousShell, programRoot, { recursive: true });
  const opts = { programRoot, previousReleaseDir, targetReleaseDir };
  const backupRoot = path.join(path.dirname(programRoot), ".equinox-shell-backup-2468-0123456789abcdef");
  const nextRoot = path.join(path.dirname(programRoot), ".equinox-shell-next-2468-fedcba9876543210");
  return { opts, previousShell, targetShell, backupRoot, nextRoot };
}

const inspect = async (f) => inspectEquinoxLocalWindowsNativeSwap(f.opts);

test("read-only Windows native recovery differentiates pristine A and admitted-looking B without mutating files", async (t) => {
  const f = await fixture(t);
  assert.deepEqual((await inspect(f)).status, "previous-intact");
  await fs.rm(f.opts.programRoot, { recursive: true });
  await fs.cp(f.targetShell, f.opts.programRoot, { recursive: true });
  assert.deepEqual((await inspect(f)).status, "target-intact");
  assert.equal(await fs.readFile(path.join(f.opts.programRoot, "EquinoxLocal.exe"), "utf8"), "after");
});

test("read-only audit detects crash after old executable tree moved out", async (t) => {
  const f = await fixture(t);
  await fs.rename(f.opts.programRoot, f.backupRoot);
  const result = await inspect(f);
  assert.equal(result.status, "previous-backup-ready");
  assert.equal(result.installedIdentity, "missing");
  assert.equal(result.backupRoot, f.backupRoot);
  await assert.rejects(fs.lstat(f.opts.programRoot), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(f.backupRoot, "EquinoxLocal.exe"), "utf8"), "before");
});

test("read-only audit detects crash after target promoted while old backup remains", async (t) => {
  const f = await fixture(t);
  await fs.rename(f.opts.programRoot, f.backupRoot);
  await fs.cp(f.targetShell, f.opts.programRoot, { recursive: true });
  assert.equal((await inspect(f)).status, "target-with-previous-backup");
});

test("read-only audit refuses to guess when extra staged candidate is present", async (t) => {
  const f = await fixture(t);
  await fs.cp(f.targetShell, f.nextRoot, { recursive: true });
  assert.equal((await inspect(f)).status, "blocked");
});

test("read-only audit blocks foreign active tree and mismatched backup", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.opts.programRoot, "EquinoxLocal.exe"), "untrusted");
  assert.equal((await inspect(f)).status, "blocked");
  await fs.rename(f.opts.programRoot, f.backupRoot);
  await assert.rejects(inspect(f), /backup differs/u);
});

test("read-only audit refuses ambiguous multiple backups and path tampering", async (t) => {
  const f = await fixture(t);
  await fs.rename(f.opts.programRoot, f.backupRoot);
  const extra = path.join(path.dirname(f.backupRoot), ".equinox-shell-backup-2469-fedcba9876543210");
  await fs.cp(f.previousShell, extra, { recursive: true });
  await assert.rejects(inspect(f), /ambiguous/u);
  await fs.rm(extra, { recursive: true });
  await fs.rm(f.backupRoot, { recursive: true });
  await fs.symlink(f.previousShell, f.backupRoot, "dir");
  await assert.rejects(inspect(f), /unowned backup entry|unsafe/u);
});

test("read-only audit rejects missing old release, symlinked active tree and unsafe roots", async (t) => {
  const f = await fixture(t);
  await fs.rm(f.opts.programRoot, { recursive: true });
  await fs.symlink(f.previousShell, f.opts.programRoot, "dir");
  await assert.rejects(inspect(f), /unsafe/u);
  await fs.rm(f.opts.programRoot);
  await fs.rm(f.previousShell, { recursive: true });
  await assert.rejects(inspect(f), { code: "ENOENT" });
  await assert.rejects(inspectEquinoxLocalWindowsNativeSwap({ ...f.opts, programRoot: "." }), /canonical absolute/u);
  await assert.rejects(inspectEquinoxLocalWindowsNativeSwap({ ...f.opts, programRoot: path.join(f.opts.previousReleaseDir, "other") }), /fixed Equinox Local/u);
});
