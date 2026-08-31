import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ensureEquinoxLocalAppHost } from "../../src/equinox-local-app-host.js";
import {
  buildEquinoxLocalNativeAppArtifacts,
  EQUINOX_LOCAL_NATIVE_APP_SHELL_VERSION,
} from "../../src/equinox-local-native-app.js";
import {
  restoreLegacyEquinoxLocalAppHost,
  synchronizeEquinoxLocalNativeAppHost,
} from "../../src/equinox-local-native-app-host.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const macTest = process.platform === "darwin" ? test : test.skip;
const TARGET = process.arch === "x64" ? "darwin-x64" : "darwin-arm64";

macTest("native app build is deterministic and target-native", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-native-app-build-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const first = path.join(temp, "first");
  const second = path.join(temp, "second");
  await fs.mkdir(first, { recursive: true });
  await fs.mkdir(second, { recursive: true });

  const firstMetadata = await buildEquinoxLocalNativeAppArtifacts({ rootDir: ROOT, releaseDir: first, target: TARGET });
  const secondMetadata = await buildEquinoxLocalNativeAppArtifacts({ rootDir: ROOT, releaseDir: second, target: TARGET });
  assert.equal(firstMetadata.shellVersion, EQUINOX_LOCAL_NATIVE_APP_SHELL_VERSION);
  assert.equal(firstMetadata.executableSha256, secondMetadata.executableSha256);
  assert.equal(firstMetadata.iconSha256, secondMetadata.iconSha256);
  assert.deepEqual(
    await fs.readFile(path.join(first, "runtime", "app", "applet")),
    await fs.readFile(path.join(second, "runtime", "app", "applet")),
  );
});

macTest("native app host migrates legacy bundle once and restores it for rollback", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-native-app-host-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const homeDir = path.join(temp, "home");
  const releaseDir = path.join(temp, "release");
  await fs.mkdir(homeDir, { recursive: true });
  await fs.mkdir(releaseDir, { recursive: true });

  const legacy = await ensureEquinoxLocalAppHost({ homeDir });
  const legacyBytes = await fs.readFile(legacy.executablePath);
  await buildEquinoxLocalNativeAppArtifacts({ rootDir: ROOT, releaseDir, target: TARGET });

  const migrated = await synchronizeEquinoxLocalNativeAppHost({ homeDir, releaseDir });
  assert.equal(migrated.changed, true);
  assert.equal(migrated.shellVersion, EQUINOX_LOCAL_NATIVE_APP_SHELL_VERSION);
  const infoPlist = await fs.readFile(path.join(migrated.appPath, "Contents", "Info.plist"), "utf8");
  assert.match(infoPlist, /EquinoxLocalNativeShellVersion/u);
  assert.match(infoPlist, /EquinoxLocalNativeExecutableSha256/u);
  assert.match(infoPlist, /NSAllowsLocalNetworking/u);
  assert.doesNotMatch(infoPlist, /NSCameraUsageDescription|NSMicrophoneUsageDescription|LSUIElement/u);
  assert.equal((await fs.lstat(path.join(migrated.appPath, "Contents", "Resources", "EquinoxLocal.icns"))).isFile(), true);

  const second = await synchronizeEquinoxLocalNativeAppHost({ homeDir, releaseDir });
  assert.equal(second.changed, false);

  const installedExecutable = path.join(migrated.appPath, "Contents", "MacOS", "applet");
  const stableInstalledBytes = await fs.readFile(installedExecutable);
  const alternateRoot = path.join(temp, "alternate-root");
  const alternateSourceDir = path.join(alternateRoot, "equinox-local-app");
  await fs.mkdir(alternateRoot, { recursive: true });
  await fs.cp(path.join(ROOT, "equinox-local-app"), alternateSourceDir, { recursive: true });
  const alternateSource = path.join(alternateSourceDir, "EquinoxLocalApp.swift");
  const alternateText = await fs.readFile(alternateSource, "utf8");
  await fs.writeFile(alternateSource, alternateText.replace('window.title = "Equinox Local"', 'window.title = "Equinox Local Test Artifact"'));
  await buildEquinoxLocalNativeAppArtifacts({ rootDir: alternateRoot, releaseDir, target: TARGET });
  const sameShellChangedArtifact = await synchronizeEquinoxLocalNativeAppHost({ homeDir, releaseDir });
  assert.equal(sameShellChangedArtifact.changed, false);
  assert.deepEqual(await fs.readFile(installedExecutable), stableInstalledBytes);

  await fs.appendFile(installedExecutable, Buffer.from([0]));
  const repaired = await synchronizeEquinoxLocalNativeAppHost({ homeDir, releaseDir });
  assert.equal(repaired.changed, true);
  const stableAfterRepair = await synchronizeEquinoxLocalNativeAppHost({ homeDir, releaseDir });
  assert.equal(stableAfterRepair.changed, false);

  const restored = await restoreLegacyEquinoxLocalAppHost({ homeDir });
  assert.equal(restored.restored, true);
  assert.deepEqual(await fs.readFile(restored.executablePath), legacyBytes);
});
