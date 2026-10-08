import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { bootstrapManagedEquinoxUser } from "../../src/equinox-local-bootstrap.js";
import { validateFirstInstallRelease } from "../../src/equinox-local-first-install.js";
import { equinoxLocalManagedLifecycle, equinoxLocalPlatformPaths } from "../../src/equinox-local-platform.js";
import { equinoxLocalReleaseRuntimeContract } from "../../src/equinox-local-release-runtime-contract.js";
import { extractEquinoxReleaseArchive, inspectEquinoxReleaseArchive } from "../../src/equinox-local-release-manager.js";

const VERSION = "5.2.1";
const TARGET = "win32-arm64";

async function makeArm64Release(releaseDir) {
  await fs.mkdir(releaseDir, { recursive: true });
  await fs.writeFile(path.join(releaseDir, "release.json"), `${JSON.stringify({
    schemaVersion: 1,
    version: VERSION,
    target: TARGET,
    nodeVersion: "26.11.1",
    tunnelClientVersion: "0.0.16",
    serverEntry: "server.js",
  })}\n`);
  const contract = equinoxLocalReleaseRuntimeContract({ target: TARGET, version: VERSION });
  const files = new Set([
    ...contract.runtimeExecutables,
    ...contract.runtimeDocuments,
    ...contract.requiredReleaseFiles,
    ...contract.nativeShellFiles,
  ]);
  for (const relative of files) {
    const absolute = path.join(releaseDir, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, `fixture:${relative}\n`);
  }
}

test("Windows ARM64 lifecycle advertises the accepted per-user Job Object contract", () => {
  const lifecycle = equinoxLocalManagedLifecycle({ platform: "win32", arch: "arm64" });
  assert.equal(lifecycle.host.target, TARGET);
  assert.equal(lifecycle.kind, "windows-user");
  assert.equal(lifecycle.implemented, true);
  assert.equal(lifecycle.currentPointerKind, "version-file");
  assert.equal(lifecycle.processOwnership, "job-object");
});

test("Windows ARM64 release ZIP inspect/extract routes through the bounded PowerShell helper", async () => {
  const calls = [];
  const execFileImpl = async (command, args, options) => {
    calls.push({ command, args: [...args], options: { ...options } });
    return { stdout: JSON.stringify({ entryCount: 7, extractedBytes: 4096 }), stderr: "" };
  };
  const inspected = await inspectEquinoxReleaseArchive("C:\\tmp\\release.zip", { target: TARGET, execFileImpl });
  const extracted = await extractEquinoxReleaseArchive("C:\\tmp\\release.zip", "C:\\tmp\\out", { target: TARGET, execFileImpl });
  assert.deepEqual(inspected, { entryCount: 7, extractedBytes: 4096 });
  assert.deepEqual(extracted, { entryCount: 7, extractedBytes: 4096 });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, "powershell.exe");
  assert.ok(calls[0].args.includes("Inspect"));
  assert.ok(calls[1].args.includes("Extract"));
});

test("Windows ARM64 first-install validation accepts the native release contract", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-arm64-release-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const releaseDir = path.join(root, "release");
  await makeArm64Release(releaseDir);
  const result = await validateFirstInstallRelease(releaseDir, { target: TARGET });
  assert.equal(result.target, TARGET);
  assert.equal(result.version, VERSION);
});

test("native Windows ARM64 bootstrap resolves its target-bound pointer and Native Messaging launcher", { skip: process.platform !== "win32" || process.arch !== "arm64" }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-arm64-bootstrap-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const homeDir = path.join(root, "ARM User Home");
  const localAppData = path.join(root, "Local App Data");
  const env = { ...process.env, LOCALAPPDATA: localAppData };
  await fs.mkdir(homeDir, { recursive: true });
  const paths = equinoxLocalPlatformPaths({ platform: "win32", arch: "arm64", homeDir, env });
  const releaseDir = path.join(paths.releasesRoot, VERSION);
  await makeArm64Release(releaseDir);
  await fs.mkdir(paths.appDataRoot, { recursive: true });
  await fs.writeFile(paths.currentPointer, `${JSON.stringify({ schemaVersion: 1, target: TARGET, version: VERSION }, null, 2)}\n`);
  const registrations = [];
  const result = await bootstrapManagedEquinoxUser({
    homeDir,
    platform: "win32",
    arch: "arm64",
    env,
    registerWindowsNativeMessagingHostImpl: async (options) => {
      registrations.push(options);
      return { manifestPath: path.join(options.manifestRoot, "dev.equinox.browser.json"), launcherPath: options.launcherPath, idempotent: false };
    },
  });
  assert.equal(result.version, VERSION);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].launcherPath, path.win32.join(releaseDir, "runtime", "browser", "equinox-browser-native-host.exe"));
});
