import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  replaceWindowsStableShellForRelease,
  snapshotWindowsStableShellTree,
} from "../../src/equinox-local-windows-stable-shell.js";

async function shellFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-stable-shell-"));
  const releases = path.join(root, "releases");
  const programRoot = path.join(root, "Programs", "Equinox Local");
  for (const [version, marker] of [["5.2.0", "old"], ["5.3.0", "new"]]) {
    const shell = path.join(releases, version, "runtime", "shell");
    await fs.mkdir(shell, { recursive: true });
    await fs.writeFile(path.join(shell, "EquinoxLocal.exe"), `${marker}-exe\n`);
    await fs.writeFile(path.join(shell, "coreclr.dll"), `${marker}-core\n`);
  }
  await fs.mkdir(path.dirname(programRoot), { recursive: true });
  await fs.cp(path.join(releases, "5.2.0", "runtime", "shell"), programRoot, { recursive: true });
  return { root, releases, programRoot };
}

test("Windows stable-shell update stages and replaces only the expected previous tree", async (t) => {
  const fixture = await shellFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  let shutdowns = 0;
  const result = await replaceWindowsStableShellForRelease({
    releaseDir: path.join(fixture.releases, "5.3.0"),
    previousReleaseDir: path.join(fixture.releases, "5.2.0"),
    programRoot: fixture.programRoot,
    requestShutdownImpl: async () => { shutdowns += 1; },
    sleepImpl: async () => {},
  });
  assert.equal(result.synchronized, true);
  assert.equal(shutdowns, 1);
  assert.equal(await fs.readFile(path.join(fixture.programRoot, "EquinoxLocal.exe"), "utf8"), "new-exe\n");
  assert.deepEqual(
    await snapshotWindowsStableShellTree(fixture.programRoot),
    await snapshotWindowsStableShellTree(path.join(fixture.releases, "5.3.0", "runtime", "shell")),
  );
});

test("Windows stable-shell update refuses foreign current tree before mutation", async (t) => {
  const fixture = await shellFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  await fs.writeFile(path.join(fixture.programRoot, "coreclr.dll"), "foreign\n");
  let shutdowns = 0;
  await assert.rejects(
    replaceWindowsStableShellForRelease({
      releaseDir: path.join(fixture.releases, "5.3.0"),
      previousReleaseDir: path.join(fixture.releases, "5.2.0"),
      programRoot: fixture.programRoot,
      requestShutdownImpl: async () => { shutdowns += 1; },
    }),
    /expected previous release/u,
  );
  assert.equal(shutdowns, 0);
  assert.equal(await fs.readFile(path.join(fixture.programRoot, "coreclr.dll"), "utf8"), "foreign\n");
});

test("Windows stable-shell replacement restores the exact previous tree when candidate promotion fails", async (t) => {
  const fixture = await shellFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const before = await snapshotWindowsStableShellTree(fixture.programRoot);
  let renameCount = 0;
  const fsImpl = {
    ...fs,
    rename: async (source, destination) => {
      renameCount += 1;
      if (renameCount === 2) throw Object.assign(new Error("forced candidate promotion failure"), { code: "EIO" });
      return fs.rename(source, destination);
    },
  };
  await assert.rejects(
    replaceWindowsStableShellForRelease({
      releaseDir: path.join(fixture.releases, "5.3.0"),
      previousReleaseDir: path.join(fixture.releases, "5.2.0"),
      programRoot: fixture.programRoot,
      requestShutdownImpl: async () => {},
      sleepImpl: async () => {},
      fsImpl,
    }),
    /forced candidate promotion failure/u,
  );
  assert.deepEqual(await snapshotWindowsStableShellTree(fixture.programRoot), before);
  assert.equal(await fs.readFile(path.join(fixture.programRoot, "EquinoxLocal.exe"), "utf8"), "old-exe\n");
});


test("Windows running stable shell is stopped before real NTFS replacement", { skip: process.platform !== "win32" }, async (t) => {
  const fixture = await shellFixture();
  const previousShell = path.join(fixture.releases, "5.2.0", "runtime", "shell");
  const targetShell = path.join(fixture.releases, "5.3.0", "runtime", "shell");
  await fs.copyFile(process.execPath, path.join(previousShell, "EquinoxLocal.exe"));
  await fs.copyFile(process.execPath, path.join(targetShell, "EquinoxLocal.exe"));
  await fs.rm(fixture.programRoot, { recursive: true, force: true });
  await fs.cp(previousShell, fixture.programRoot, { recursive: true });

  const runningExe = path.join(fixture.programRoot, "EquinoxLocal.exe");
  const child = spawn(runningExe, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  t.after(async () => {
    try { if (!child.killed) child.kill(); } catch {}
    await fs.rm(fixture.root, { recursive: true, force: true });
  });

  let shutdowns = 0;
  const result = await replaceWindowsStableShellForRelease({
    releaseDir: path.join(fixture.releases, "5.3.0"),
    previousReleaseDir: path.join(fixture.releases, "5.2.0"),
    programRoot: fixture.programRoot,
    requestShutdownImpl: async () => {
      shutdowns += 1;
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    },
  });
  assert.equal(result.synchronized, true);
  assert.equal(shutdowns, 1);
  assert.equal(child.exitCode !== null, true);
  assert.equal(await fs.readFile(path.join(fixture.programRoot, "coreclr.dll"), "utf8"), "new-core\n");
});
