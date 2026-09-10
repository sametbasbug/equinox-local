import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { spawnTrackedProcess } from "../helpers/native-process-harness.mjs";

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

test("native app source keeps the menu-bar safety lifecycle", async () => {
  const source = await fs.readFile(path.join(ROOT, "app", "EquinoxLocalApp.swift"), "utf8");
  assert.match(source, /NSStatusBar\.system\.statusItem/u);
  assert.match(source, /applicationShouldTerminateAfterLastWindowClosed[\s\S]*?false/u);
  assert.match(source, /windowWillClose[\s\S]*?setActivationPolicy\(\.accessory\)/u);
  assert.match(source, /isReleasedWhenClosed = false/u);
  assert.match(source, /openControlCenter[\s\S]*?setActivationPolicy\(\.regular\)/u);
  assert.match(source, /Emergency Stop/u);
  assert.match(source, /Resume Agent/u);
  assert.match(source, /\/api\/v1\/agent\/pause/u);
  assert.match(source, /\/api\/v1\/agent\/resume/u);
  assert.match(source, /\/api\/v1\/browser\/agent\/open/u);
  assert.match(source, /\/api\/v1\/runtime\/restart/u);
  assert.match(source, /Quit Equinox Local/u);
  assert.match(source, /quitEquinoxLocal[\s\S]*?runtimeLifecycle\.hardStop/u);
  assert.match(source, /runLaunchctl\(\["bootout"/u);
  assert.match(source, /runLaunchctl\(\["bootstrap"/u);
  assert.match(source, /runLaunchctl\(\["kickstart"/u);
  const quitMethod = source.match(/@objc private func quitEquinoxLocal[\s\S]*?(?=\n    private func configureMainMenu)/u)?.[0] ?? "";
  assert.match(quitMethod, /runtimeLifecycle\.hardStop/u);
  assert.doesNotMatch(quitMethod, /\/api\/v1\/agent\/pause/u);
  assert.match(source, /NSStatusItem\.variableLength/u);
  assert.match(source, /string: "EL"/u);
  assert.match(source, /NSFont\.systemFont\(ofSize: 12\.5, weight: \.semibold\)/u);
});

test("native menu-bar template asset is a bounded transparent 64x64 PNG", async () => {
  const data = await fs.readFile(path.join(ROOT, "app", "EquinoxLocalMenuBar.png"));
  assert.equal(data.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(data.readUInt32BE(16), 64);
  assert.equal(data.readUInt32BE(20), 64);
  assert.equal(data[25], 6); // RGBA color type.
  assert.ok(data.length <= 16 * 1024);
});

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
  assert.equal(firstMetadata.menuIconSha256, secondMetadata.menuIconSha256);
  assert.equal(firstMetadata.menuIcon, "EquinoxLocalMenuBar.png");
  assert.deepEqual(
    await fs.readFile(path.join(first, "runtime", "app", "applet")),
    await fs.readFile(path.join(second, "runtime", "app", "applet")),
  );
});

macTest("fresh native app foreground launch is tracked and fully cleaned up", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-native-app-launch-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const homeDir = path.join(temp, "home");
  const releaseDir = path.join(temp, "release");
  await fs.mkdir(homeDir, { recursive: true });
  await fs.mkdir(releaseDir, { recursive: true });

  await buildEquinoxLocalNativeAppArtifacts({ rootDir: ROOT, releaseDir, target: TARGET });
  const installed = await synchronizeEquinoxLocalNativeAppHost({ homeDir, releaseDir });
  const user = process.env.USER || process.env.LOGNAME || "equinox-test";
  const child = await spawnTrackedProcess(t, installed.executablePath, [], {
    env: {
      HOME: homeDir,
      USER: user,
      LOGNAME: user,
      TMPDIR: "/tmp",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    },
    stdio: "ignore",
  }, {
    label: "fresh Equinox Local native app",
    startupMs: 1_000,
  });

  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
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
  assert.equal((await fs.lstat(path.join(migrated.appPath, "Contents", "Resources", "EquinoxLocalMenuBar.png"))).isFile(), true);

  const second = await synchronizeEquinoxLocalNativeAppHost({ homeDir, releaseDir });
  assert.equal(second.changed, false);

  const installedExecutable = path.join(migrated.appPath, "Contents", "MacOS", "applet");
  const stableInstalledBytes = await fs.readFile(installedExecutable);
  const alternateRoot = path.join(temp, "alternate-root");
  const alternateSourceDir = path.join(alternateRoot, "app");
  await fs.mkdir(alternateRoot, { recursive: true });
  await fs.cp(path.join(ROOT, "app"), alternateSourceDir, { recursive: true });
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
