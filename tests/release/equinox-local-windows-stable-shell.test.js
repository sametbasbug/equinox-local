import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  renameWindowsPathWhenUnlocked,
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


test("Windows path rename retries only bounded transient lock errors", async () => {
  const transientCodes = ["EPERM", "EBUSY", "EACCES"];
  const sleeps = [];
  let attempts = 0;
  const fsImpl = {
    rename: async () => {
      attempts += 1;
      const code = transientCodes[attempts - 1];
      if (code) throw Object.assign(new Error(`transient ${code}`), { code });
    },
  };
  await renameWindowsPathWhenUnlocked("source", "destination", {
    fsImpl,
    sleepImpl: async (ms) => { sleeps.push(ms); },
    attempts: 4,
  });
  assert.equal(attempts, 4);
  assert.deepEqual(sleeps, [100, 100, 100]);

  let fatalAttempts = 0;
  await assert.rejects(
    renameWindowsPathWhenUnlocked("source", "destination", {
      fsImpl: {
        rename: async () => {
          fatalAttempts += 1;
          throw Object.assign(new Error("fatal rename"), { code: "EIO" });
        },
      },
      sleepImpl: async () => { throw new Error("non-retryable rename must not sleep"); },
    }),
    /fatal rename/u,
  );
  assert.equal(fatalAttempts, 1);
});

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


test("Windows native swap rollback preserves verified backup when restore rename fails", async (t) => {
  const fixture = await shellFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  let renameCount = 0;
  const fsImpl = {
    ...fs,
    rename: async (source, destination) => {
      renameCount += 1;
      if (renameCount === 2) throw Object.assign(new Error("candidate rename injected"), { code: "EIO" });
      if (renameCount === 3) throw Object.assign(new Error("rollback rename injected"), { code: "EACCES" });
      return fs.rename(source, destination);
    },
  };
  await assert.rejects(
    replaceWindowsStableShellForRelease({
      releaseDir: path.join(fixture.releases, "5.3.0"), previousReleaseDir: path.join(fixture.releases, "5.2.0"),
      programRoot: fixture.programRoot, requestShutdownImpl: async () => {}, fsImpl,
    }),
    (error) => error instanceof AggregateError && /rollback failed/u.test(error.message) && error.errors.length === 2,
  );
  const parent = path.dirname(fixture.programRoot);
  const backups = (await fs.readdir(parent)).filter((name) => name.startsWith(".equinox-shell-backup-"));
  assert.equal(backups.length, 1);
  assert.equal(await fs.readFile(path.join(parent, backups[0], "EquinoxLocal.exe"), "utf8"), "old-exe\n");
});

test("Windows native swap fails closed when backup contents change during failed promotion", async (t) => {
  const fixture = await shellFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  let renameCount = 0;
  const fsImpl = {
    ...fs,
    rename: async (source, destination) => {
      renameCount += 1;
      if (renameCount === 1) {
        await fs.rename(source, destination);
        await fs.writeFile(path.join(destination, "coreclr.dll"), "tampered\n");
        return;
      }
      if (renameCount === 2) throw Object.assign(new Error("candidate rename injected"), { code: "EIO" });
      return fs.rename(source, destination);
    },
  };
  await assert.rejects(
    replaceWindowsStableShellForRelease({
      releaseDir: path.join(fixture.releases, "5.3.0"), previousReleaseDir: path.join(fixture.releases, "5.2.0"),
      programRoot: fixture.programRoot, requestShutdownImpl: async () => {}, fsImpl,
    }),
    (error) => error instanceof AggregateError && /rollback failed/u.test(error.message),
  );
  const backups = (await fs.readdir(path.dirname(fixture.programRoot))).filter((name) => name.startsWith(".equinox-shell-backup-"));
  assert.equal(backups.length, 1);
  assert.equal(await fs.readFile(path.join(path.dirname(fixture.programRoot), backups[0], "coreclr.dll"), "utf8"), "tampered\n");
});

test("Windows native swap keeps the exact previous shell on a post-promotion integrity error", async (t) => {
  const fixture = await shellFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  let renamed = false;
  const fsImpl = {
    ...fs,
    rename: async (source, destination) => {
      await fs.rename(source, destination);
      if (!renamed && destination === fixture.programRoot) {
        renamed = true;
        await fs.writeFile(path.join(fixture.programRoot, "coreclr.dll"), "post-promotion-tampered\n");
      }
    },
  };
  await assert.rejects(
    replaceWindowsStableShellForRelease({
      releaseDir: path.join(fixture.releases, "5.3.0"), previousReleaseDir: path.join(fixture.releases, "5.2.0"),
      programRoot: fixture.programRoot, requestShutdownImpl: async () => {}, fsImpl,
    }), /integrity verification/u,
  );
  assert.equal(await fs.readFile(path.join(fixture.programRoot, "EquinoxLocal.exe"), "utf8"), "old-exe\n");
  assert.equal(await fs.readFile(path.join(fixture.programRoot, "coreclr.dll"), "utf8"), "old-core\n");
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
  assert.equal(child.exitCode !== null || child.signalCode !== null, true);
  assert.equal(await fs.readFile(path.join(fixture.programRoot, "coreclr.dll"), "utf8"), "new-core\n");
});
