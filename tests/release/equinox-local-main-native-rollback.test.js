import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  restoreEquinoxLocalNativeAppHostSnapshot,
  snapshotEquinoxLocalNativeAppHost,
  synchronizeEquinoxLocalNativeAppHost,
} from "../../src/equinox-local-native-app-host.js";
import { buildEquinoxLocalNativeAppArtifacts } from "../../src/equinox-local-native-app.js";
import {
  replaceWindowsStableShellForRelease,
  restoreWindowsStableShellRollbackSnapshot,
  snapshotWindowsStableShellForRollback,
  snapshotWindowsStableShellTree,
} from "../../src/equinox-local-windows-stable-shell.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const macTest = process.platform === "darwin" ? test : test.skip;

async function writeShellRelease(releaseDir, marker) {
  const shell = path.join(releaseDir, "runtime", "shell");
  await fs.mkdir(shell, { recursive: true });
  await fs.writeFile(path.join(shell, "EquinoxLocal.exe"), `shell-${marker}`);
  await fs.writeFile(path.join(shell, "helper.dll"), `helper-${marker}`);
  return shell;
}

macTest("Main rollback snapshot restores the previous macOS native app without a previous artifact", async (t) => {
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-main-app-rollback-"));
  const temp = await fs.realpath(raw);
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const homeDir = path.join(temp, "home");
  const oldRelease = path.join(temp, "old-release");
  const newRelease = path.join(temp, "new-release");
  const snapshotPath = path.join(temp, "transaction", "native-rollback", "Equinox Local.app");
  await fs.mkdir(homeDir, { recursive: true });
  await fs.mkdir(oldRelease, { recursive: true });
  await fs.mkdir(newRelease, { recursive: true });
  await buildEquinoxLocalNativeAppArtifacts({ rootDir: ROOT, releaseDir: oldRelease, target: `darwin-${process.arch}` });
  const oldMetadataPath = path.join(oldRelease, "runtime", "app", "native-app.json");
  const oldMetadata = JSON.parse(await fs.readFile(oldMetadataPath, "utf8"));
  oldMetadata.shellVersion += 100;
  await fs.writeFile(oldMetadataPath, `${JSON.stringify(oldMetadata, null, 2)}\n`);
  const oldInstalled = await synchronizeEquinoxLocalNativeAppHost({ homeDir, releaseDir: oldRelease });
  const oldBytes = await fs.readFile(oldInstalled.executablePath);
  await snapshotEquinoxLocalNativeAppHost({ homeDir, snapshotPath });

  await buildEquinoxLocalNativeAppArtifacts({ rootDir: ROOT, releaseDir: newRelease, target: `darwin-${process.arch}` });
  const newMetadataPath = path.join(newRelease, "runtime", "app", "native-app.json");
  const newMetadata = JSON.parse(await fs.readFile(newMetadataPath, "utf8"));
  newMetadata.shellVersion = oldMetadata.shellVersion + 1;
  await fs.writeFile(newMetadataPath, `${JSON.stringify(newMetadata, null, 2)}\n`);
  await synchronizeEquinoxLocalNativeAppHost({ homeDir, releaseDir: newRelease });
  assert.notDeepEqual(await fs.readFile(oldInstalled.executablePath), oldBytes);

  await restoreEquinoxLocalNativeAppHostSnapshot({ homeDir, snapshotPath });
  assert.deepEqual(await fs.readFile(oldInstalled.executablePath), oldBytes);
});

macTest("Main macOS rollback refuses a snapshot modified after capture", async (t) => {
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-main-app-tamper-"));
  const temp = await fs.realpath(raw);
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const homeDir = path.join(temp, "home");
  const releaseDir = path.join(temp, "release");
  const snapshotPath = path.join(temp, "snapshot.app");
  await fs.mkdir(homeDir, { recursive: true });
  await fs.mkdir(releaseDir, { recursive: true });
  await buildEquinoxLocalNativeAppArtifacts({ rootDir: ROOT, releaseDir, target: `darwin-${process.arch}` });
  const installed = await synchronizeEquinoxLocalNativeAppHost({ homeDir, releaseDir });
  await snapshotEquinoxLocalNativeAppHost({ homeDir, snapshotPath });
  await fs.appendFile(path.join(snapshotPath, "Contents", "MacOS", "applet"), Buffer.from([0]));
  await assert.rejects(restoreEquinoxLocalNativeAppHostSnapshot({ homeDir, snapshotPath }), /fingerprint mismatch/u);
  assert.equal((await fs.lstat(installed.appPath)).isDirectory(), true);
});

macTest("Main macOS native rollback snapshot refuses to overwrite an existing destination", async (t) => {
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-main-app-existing-"));
  const temp = await fs.realpath(raw);
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const homeDir = path.join(temp, "home");
  const releaseDir = path.join(temp, "release");
  const snapshotPath = path.join(temp, "snapshot.app");
  await fs.mkdir(homeDir, { recursive: true });
  await fs.mkdir(releaseDir, { recursive: true });
  await buildEquinoxLocalNativeAppArtifacts({ rootDir: ROOT, releaseDir, target: `darwin-${process.arch}` });
  await synchronizeEquinoxLocalNativeAppHost({ homeDir, releaseDir });
  await fs.mkdir(snapshotPath, { recursive: true });
  await assert.rejects(snapshotEquinoxLocalNativeAppHost({ homeDir, snapshotPath }), { code: "EEXIST" });
});

test("Windows Main rollback snapshot is a verified local previous-release shell and can restore after replacement", async (t) => {
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-main-win-shell-"));
  const temp = await fs.realpath(raw);
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const programRoot = path.join(temp, "program");
  const newRelease = path.join(temp, "new-release");
  const snapshotReleaseDir = path.join(temp, "transaction", "native-rollback", "previous-release");
  await writeShellRelease(path.join(temp, "old-release"), "old");
  await fs.cp(path.join(temp, "old-release", "runtime", "shell"), programRoot, { recursive: true });
  await writeShellRelease(newRelease, "new");

  const before = await snapshotWindowsStableShellTree(programRoot);
  await snapshotWindowsStableShellForRollback({ programRoot, snapshotReleaseDir });
  await replaceWindowsStableShellForRelease({
    releaseDir: newRelease,
    previousReleaseDir: snapshotReleaseDir,
    programRoot,
    requestShutdownImpl: async () => {},
    sleepImpl: async () => {},
  });
  assert.notDeepEqual(await snapshotWindowsStableShellTree(programRoot), before);

  await restoreWindowsStableShellRollbackSnapshot({
    snapshotReleaseDir,
    currentReleaseDir: newRelease,
    programRoot,
    requestShutdownImpl: async () => {},
    sleepImpl: async () => {},
  });
  assert.deepEqual(await snapshotWindowsStableShellTree(programRoot), before);
});

test("Windows Main rollback refuses a rollback snapshot modified after capture", async (t) => {
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-main-win-tamper-"));
  const temp = await fs.realpath(raw);
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const programRoot = path.join(temp, "program");
  const newRelease = path.join(temp, "new-release");
  const snapshotReleaseDir = path.join(temp, "snapshot");
  await fs.mkdir(programRoot, { recursive: true });
  await fs.writeFile(path.join(programRoot, "EquinoxLocal.exe"), "old");
  await writeShellRelease(newRelease, "new");
  await snapshotWindowsStableShellForRollback({ programRoot, snapshotReleaseDir });
  await fs.writeFile(path.join(snapshotReleaseDir, "runtime", "shell", "EquinoxLocal.exe"), "tampered");
  await assert.rejects(restoreWindowsStableShellRollbackSnapshot({
    snapshotReleaseDir, currentReleaseDir: newRelease, programRoot, requestShutdownImpl: async () => {}, sleepImpl: async () => {},
  }), /fingerprint mismatch/u);
  assert.equal(await fs.readFile(path.join(programRoot, "EquinoxLocal.exe"), "utf8"), "old");
});

test("Windows Main rollback snapshot refuses to overwrite a pre-existing destination", async (t) => {
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-main-win-existing-"));
  const temp = await fs.realpath(raw);
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const programRoot = path.join(temp, "program");
  const snapshotReleaseDir = path.join(temp, "snapshot");
  await fs.mkdir(programRoot, { recursive: true });
  await fs.writeFile(path.join(programRoot, "EquinoxLocal.exe"), "old");
  await fs.mkdir(snapshotReleaseDir, { recursive: true });
  await assert.rejects(snapshotWindowsStableShellForRollback({ programRoot, snapshotReleaseDir }), { code: "EEXIST" });
});
