import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
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

const execFile = promisify(execFileCallback);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const macTest = process.platform === "darwin" ? test : test.skip;
const TARGET = process.arch === "x64" ? "darwin-x64" : "darwin-arm64";

async function nativeAppSignatureInfo(appPath) {
  const [requirementResult, verboseResult] = await Promise.all([
    execFile("/usr/bin/codesign", ["-d", "-r-", appPath], { encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024 }),
    execFile("/usr/bin/codesign", ["-d", "--verbose=4", appPath], { encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024 }),
  ]);
  const requirementOutput = `${requirementResult.stdout ?? ""}\n${requirementResult.stderr ?? ""}`;
  const verboseOutput = `${verboseResult.stdout ?? ""}\n${verboseResult.stderr ?? ""}`;
  const requirement = requirementOutput.split(/\r?\n/u).map((line) => line.trim()).find((line) => line.startsWith("designated =>")) ?? null;
  const cdHash = verboseOutput.match(/^CDHash=([a-f0-9]+)$/mu)?.[1] ?? null;
  return { requirement, cdHash };
}

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
  assert.match(source, /applicationShouldTerminate\(_ sender: NSApplication\)[\s\S]*?beginHardStopForTermination\(sender\)[\s\S]*?\.terminateLater/u);
  assert.match(source, /runLaunchctl\(\["bootout"/u);
  assert.match(source, /runLaunchctl\(\["bootstrap"/u);
  assert.match(source, /runLaunchctl\(\["kickstart"/u);
  const quitMethod = source.match(/@objc private func quitEquinoxLocal[\s\S]*?(?=\n    private func beginHardStopForTermination)/u)?.[0] ?? "";
  assert.match(quitMethod, /NSApp\.terminate\(sender\)/u);
  assert.doesNotMatch(quitMethod, /runtimeLifecycle\.hardStop/u);
  const terminationMethod = source.match(/private func beginHardStopForTermination[\s\S]*?(?=\n    private func configureMainMenu)/u)?.[0] ?? "";
  assert.match(terminationMethod, /runtimeLifecycle\.hardStop/u);
  assert.match(terminationMethod, /reply\(toApplicationShouldTerminate: true\)/u);
  assert.match(terminationMethod, /reply\(toApplicationShouldTerminate: false\)/u);
  assert.doesNotMatch(terminationMethod, /\/api\/v1\/agent\/pause/u);
  assert.match(source, /NSStatusItem\.variableLength/u);
  assert.match(source, /string: "EL"/u);
  assert.doesNotMatch(source, /string: "EL /u);
  assert.match(source, /NSFont\.systemFont\(ofSize: 12\.5, weight: \.semibold\)/u);
  assert.match(source, /import UserNotifications/u);
  assert.match(source, /UNUserNotificationCenterDelegate/u);
  assert.match(source, /lastNotificationCandidateId/u);
  assert.doesNotMatch(source, /Open Active Task/u);
  assert.doesNotMatch(source, /Cancel Active Task/u);
  assert.match(source, /controlCenterTaskURL/u);
  assert.match(source, /EquinoxFloatingPetPack/u);
  assert.match(source, /nyx-atlas-v2/u);
  assert.match(source, /EquinoxCompanionSpriteView/u);
  assert.match(source, /accessibilityDisplayShouldReduceMotion/u);
  assert.match(source, /completedCycles < 3/u);
  assert.match(source, /running-right/u);
  assert.match(source, /lookCell/u);
  assert.match(source, /NSPanel/u);
  assert.match(source, /styleMask: \[\.borderless, \.nonactivatingPanel\]/u);
  assert.match(source, /panel\.level = \.floating/u);
  assert.match(source, /panel\.isMovableByWindowBackground = true/u);
  assert.match(source, /EquinoxLocalFloatingPetVisible/u);
  assert.match(source, /EquinoxLocalFloatingPetFrame/u);
  assert.match(source, /Show Companion/u);
  assert.match(source, /Hide Companion/u);
  assert.doesNotMatch(source, /No active work/u);
  assert.doesNotMatch(source, /activeWorkMenuItem/u);
  assert.match(source, /WKScriptMessageHandler/u);
  assert.match(source, /equinoxNativeLanguage/u);
  assert.match(source, /EquinoxLocalNativeLanguage/u);
  assert.match(source, /Kontrol Merkezini Aç/u);
  assert.match(source, /Acil Durdur/u);
  assert.match(source, /Companion'ı Gizle/u);
  assert.match(source, /Companion'ı Göster/u);
  assert.match(source, /window\.performDrag\(with: event\)/u);
  assert.ok(source.includes("https://chatgpt.com/"));
  const quickActions = source.match(/private func configureFloatingPetActionsPanel\(\)[\s\S]*?(?=\n    private func positionFloatingPetActionsPanel)/u)?.[0] ?? "";
  assert.equal((quickActions.match(/makeCompanionActionRow\(/gu) ?? []).length, 3);
  assert.match(quickActions, /"New Chat"/u);
  assert.match(quickActions, /"Yeni Sohbet"/u);
  assert.match(quickActions, /"Control Center"/u);
  assert.match(quickActions, /"Kontrol Merkezi"/u);
  assert.match(quickActions, /"Hide Nyx"/u);
  assert.match(quickActions, /"Nyx'i Gizle"/u);
  assert.doesNotMatch(quickActions, /Emergency Stop/u);
  assert.match(quickActions, /material = \.popover/u);
  assert.match(quickActions, /blendingMode = \.behindWindow/u);
  assert.match(quickActions, /surface\.maskImage = companionPanelMask/u);
  assert.match(source, /EquinoxCompanionActionRow/u);
  assert.match(source, /configureCompanionSpeechPanel/u);
  assert.match(source, /EquinoxCompanionSpeechView/u);
  assert.match(source, /windowBackgroundColor\.withAlphaComponent\(0\.98\)/u);
  assert.match(source, /panel\.hasShadow = false/u);
  assert.match(source, /let centeredTextY = bodyOriginY \+ max\(0, \(bodyHeight - centeredTextHeight\) \/ 2\)/u);
  assert.match(source, /y: centeredTextY/u);
  assert.match(source, /height: centeredTextHeight/u);
  assert.doesNotMatch(source, /companionSpeechMask/u);
  assert.match(source, /handleCompanionLifecycle/u);
  assert.match(source, /companionLifecycleBaselineEstablished/u);
  assert.match(source, /continuationStatus == "delivered"/u);
  assert.match(source, /Finished “/u);
  assert.match(source, /Starting “/u);
  assert.match(source, /Continuing “/u);
  assert.match(source, /Günaydın/u);
  assert.match(source, /İyi geceler/u);
  assert.match(source, /showManualCompanionSpeech/u);
  assert.match(source, /dismissAfter: 4\.2/u);
  const primaryClick = source.match(/sprite\.onPrimaryClick[\s\S]*?root\.addSubview\(sprite\)/u)?.[0] ?? "";
  assert.match(primaryClick, /actionsWereVisible/u);
  assert.match(primaryClick, /toggleFloatingPetActions/u);
  assert.match(primaryClick, /if !actionsWereVisible \{[\s\S]*?showManualCompanionSpeech/u);
  assert.match(source, /NSTextView\(frame: \.zero\)/u);
  assert.match(source, /textContainer\?\.lineFragmentPadding = 0/u);
  assert.match(source, /companionTextHeight/u);
  assert.match(source, /NSLayoutManager/u);
  assert.match(source, /usedRect\(for: container\)/u);
  assert.match(source, /maxOuterWidth = min\(360/u);
  assert.doesNotMatch(source, /min\(148, contentHeight/u);
  assert.match(source, /setAccessibilityRole\(\.button\)/u);
  assert.match(source, /accessibilityPerformPress/u);
  assert.match(source, /--restart-shell/u);
  assert.match(source, /EquinoxLocalControlCenterVisible/u);
  assert.match(source, /NSRunningApplication\.runningApplications\(withBundleIdentifier:/u);
  assert.match(source, /launchForegroundShellIfNeeded/u);
  assert.match(source, /environment\.removeValue\(forKey: "EQUINOX_LOCAL_RUNTIME_HOST"\)/u);
  assert.match(source, /opener\.arguments = \["-gn", Bundle\.main\.bundlePath, "--args", "--restart-shell"\]/u);
  assert.match(source, /try process\.run\(\)[\s\S]*?launchForegroundShellIfNeeded\(\)[\s\S]*?process\.waitUntilExit\(\)/u);
  assert.match(source, /--internal-process-session-id/u);
  assert.match(source, /--internal-process-session-pids/u);
  assert.match(source, /getsid\(/u);
  assert.match(source, /EQUINOX_LOCAL_NATIVE_PROCESS_HELPER/u);
});



test("Nyx companion asset is a bounded Codex Atlas v2 WebP", async () => {
  const data = await fs.readFile(path.join(ROOT, "app", "EquinoxCompanionNyx.webp"));
  assert.equal(data.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(data.subarray(8, 12).toString("ascii"), "WEBP");
  assert.ok(data.length > 100_000);
  assert.ok(data.length < 8 * 1024 * 1024);
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
  assert.equal(firstMetadata.companionAssetSha256, secondMetadata.companionAssetSha256);
  assert.equal(firstMetadata.menuIcon, "EquinoxLocalMenuBar.png");
  assert.equal(firstMetadata.companionAsset, "EquinoxCompanionNyx.webp");
  assert.deepEqual(
    await fs.readFile(path.join(first, "runtime", "app", "applet")),
    await fs.readFile(path.join(second, "runtime", "app", "applet")),
  );
});

macTest("native app process-session helper reports inherited POSIX session members", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-native-session-helper-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const homeDir = path.join(temp, "home");
  const releaseDir = path.join(temp, "release");
  await fs.mkdir(homeDir, { recursive: true });
  await fs.mkdir(releaseDir, { recursive: true });

  await buildEquinoxLocalNativeAppArtifacts({ rootDir: ROOT, releaseDir, target: TARGET });
  const installed = await synchronizeEquinoxLocalNativeAppHost({ homeDir, releaseDir });
  const executable = installed.executablePath;
  const child = await spawnTrackedProcess(t, "/bin/sleep", ["60"], { stdio: "ignore" }, {
    label: "POSIX session helper child",
    startupMs: 100,
  });

  const ownSession = Number.parseInt((await execFile(executable, ["--internal-process-session-id", String(process.pid)], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  })).stdout.trim(), 10);
  const childSession = Number.parseInt((await execFile(executable, ["--internal-process-session-id", String(child.pid)], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  })).stdout.trim(), 10);
  assert.equal(Number.isInteger(ownSession) && ownSession > 0, true);
  assert.equal(childSession, ownSession);

  const memberOutput = (await execFile(executable, ["--internal-process-session-pids", String(ownSession)], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 512 * 1024,
  })).stdout;
  const members = memberOutput.split(/\r?\n/u)
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
  assert.equal(members.includes(process.pid), true);
  assert.equal(members.includes(child.pid), true);
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
  assert.match(infoPlist, /EquinoxLocalPermissionIdentity/u);
  assert.match(infoPlist, /NSAllowsLocalNetworking/u);
  assert.doesNotMatch(infoPlist, /NSCameraUsageDescription|NSMicrophoneUsageDescription|LSUIElement/u);
  assert.equal((await fs.lstat(path.join(migrated.appPath, "Contents", "Resources", "EquinoxLocal.icns"))).isFile(), true);
  assert.equal((await fs.lstat(path.join(migrated.appPath, "Contents", "Resources", "EquinoxLocalMenuBar.png"))).isFile(), true);
  assert.equal((await fs.lstat(path.join(migrated.appPath, "Contents", "Resources", "EquinoxCompanionNyx.webp"))).isFile(), true);

  const firstSignature = await nativeAppSignatureInfo(migrated.appPath);
  assert.equal(firstSignature.requirement, 'designated => identifier "dev.equinox.local" and info[EquinoxLocalPermissionIdentity] = v1');
  assert.ok(firstSignature.cdHash);

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

  const appInfoPlist = path.join(migrated.appPath, "Contents", "Info.plist");
  await execFile("/usr/libexec/PlistBuddy", ["-c", "Delete :EquinoxLocalPermissionIdentity", appInfoPlist]);
  await execFile("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", "dev.equinox.local", migrated.appPath]);
  const repairedIdentity = await synchronizeEquinoxLocalNativeAppHost({ homeDir, releaseDir });
  assert.equal(repairedIdentity.changed, true);
  const signatureAfterIdentityRepair = await nativeAppSignatureInfo(migrated.appPath);
  assert.equal(signatureAfterIdentityRepair.requirement, firstSignature.requirement);
  assert.notEqual(signatureAfterIdentityRepair.cdHash, firstSignature.cdHash);

  const metadataPath = path.join(releaseDir, "runtime", "app", "native-app.json");
  const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  metadata.shellVersion += 1;
  await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  const upgraded = await synchronizeEquinoxLocalNativeAppHost({ homeDir, releaseDir });
  assert.equal(upgraded.changed, true);
  const upgradedSignature = await nativeAppSignatureInfo(migrated.appPath);
  assert.equal(upgradedSignature.requirement, firstSignature.requirement);
  assert.notEqual(upgradedSignature.cdHash, signatureAfterIdentityRepair.cdHash);
  const stableAfterUpgrade = await synchronizeEquinoxLocalNativeAppHost({ homeDir, releaseDir });
  assert.equal(stableAfterUpgrade.changed, false);

  const restored = await restoreLegacyEquinoxLocalAppHost({ homeDir });
  assert.equal(restored.restored, true);
  assert.deepEqual(await fs.readFile(restored.executablePath), legacyBytes);
});
