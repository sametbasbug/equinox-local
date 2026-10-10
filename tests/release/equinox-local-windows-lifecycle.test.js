import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { installManagedEquinoxRelease } from "../../src/equinox-local-first-install.js";
import { equinoxLocalReleaseRuntimeContract } from "../../src/equinox-local-release-runtime-contract.js";
import { resolveEquinoxLocalInstallation } from "../../src/equinox-local-installation.js";
import { equinoxLocalPlatformPaths } from "../../src/equinox-local-platform.js";
import { activatePreparedEquinoxRelease, readManagedCurrentRelease } from "../../src/equinox-local-update-activation.js";
import { runWindowsEquinoxLocalUninstall } from "../../src/equinox-local-uninstall-helper.js";
import {
  readWindowsNativeMessagingRegistryValue,
  unregisterWindowsNativeMessagingHost,
  windowsNativeMessagingLauncherPath,
} from "../../src/equinox-browser-windows-native-messaging.js";

const execFile = promisify(execFileCallback);
const STARTUP_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const STARTUP_VALUE = "Equinox Local";
const NATIVE_KEY = "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\dev.equinox.browser";
const WINDOWS_ARCH = process.arch === "arm64" ? "arm64" : "x64";
const WINDOWS_TARGET = `win32-${WINDOWS_ARCH}`;

async function exists(target) {
  try { await fs.lstat(target); return true; } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function deleteRegistryFixture() {
  await execFile("reg.exe", ["DELETE", STARTUP_KEY, "/v", STARTUP_VALUE, "/f"], { windowsHide: true }).catch(() => {});
  await execFile("reg.exe", ["DELETE", NATIVE_KEY, "/f"], { windowsHide: true }).catch(() => {});
}

async function setStartup(command) {
  await execFile("reg.exe", ["ADD", STARTUP_KEY, "/v", STARTUP_VALUE, "/t", "REG_SZ", "/d", command, "/f"], { windowsHide: true });
}

async function readStartup() {
  const script = "$k=Get-Item -LiteralPath 'Registry::HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -ErrorAction SilentlyContinue; $v=if($null -eq $k){$null}else{$k.GetValue('Equinox Local',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)}; if($null -eq $v){'null'}else{$v|ConvertTo-Json -Compress}";
  const { stdout } = await execFile("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
  return JSON.parse(String(stdout).trim() || "null");
}

async function createStagedRelease({ installRoot, version }) {
  const releaseDir = path.join(installRoot, "staging", `accept-${version}-${Math.random().toString(16).slice(2)}`, "release");
  await fs.mkdir(releaseDir, { recursive: true });
  await fs.writeFile(path.join(releaseDir, "release.json"), `${JSON.stringify({
    schemaVersion: 1,
    version,
    target: WINDOWS_TARGET,
    nodeVersion: "26.11.1",
    tunnelClientVersion: "0.0.16",
    serverEntry: "server.js",
  })}\n`);
  const contract = equinoxLocalReleaseRuntimeContract({ target: WINDOWS_TARGET, version });
  const files = new Set([
    ...contract.runtimeExecutables,
    ...contract.runtimeDocuments,
    ...contract.requiredReleaseFiles,
    ...contract.nativeShellFiles,
  ]);
  for (const relative of files) {
    const absolute = path.join(releaseDir, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, `fixture:${version}:${relative}\n`);
  }
  return releaseDir;
}

async function installFixture({ homeDir, env, version }) {
  const layout = equinoxLocalPlatformPaths({ platform: "win32", arch: WINDOWS_ARCH, homeDir, env });
  const stagedReleaseDir = await createStagedRelease({ installRoot: layout.appDataRoot, version });
  return installManagedEquinoxRelease({
    stagedReleaseDir,
    homeDir,
    platform: "win32",
    arch: WINDOWS_ARCH,
    target: WINDOWS_TARGET,
    env,
    initializeOnboardingImpl: async () => ({ created: true }),
    launchWindowsShellImpl: async () => ({ launched: true }),
    waitForVersionImpl: async () => true,
  });
}

function installationFor({ homeDir, env, version }) {
  const layout = equinoxLocalPlatformPaths({ platform: "win32", arch: WINDOWS_ARCH, homeDir, env });
  return resolveEquinoxLocalInstallation({
    platform: "win32",
    arch: WINDOWS_ARCH,
    homeDir,
    env: {
      ...env,
      EQUINOX_LOCAL_INSTALL_ROOT: layout.appDataRoot,
      EQUINOX_LOCAL_RELEASE_DIR: path.join(layout.releasesRoot, version),
    },
  });
}

async function addCandidateRelease({ homeDir, env, version }) {
  const layout = equinoxLocalPlatformPaths({ platform: "win32", arch: WINDOWS_ARCH, homeDir, env });
  const staged = await createStagedRelease({ installRoot: layout.appDataRoot, version });
  const target = path.join(layout.releasesRoot, version);
  await fs.rename(staged, target);
  return target;
}

async function cleanupNativeMessaging(homeDir, env, versions) {
  const layout = equinoxLocalPlatformPaths({ platform: "win32", arch: WINDOWS_ARCH, homeDir, env });
  const manifestPath = path.join(layout.nativeMessagingManifestRoot, "dev.equinox.browser.json");
  for (const version of versions) {
    await unregisterWindowsNativeMessagingHost({
      manifestPath,
      launcherPath: windowsNativeMessagingLauncherPath(path.join(layout.releasesRoot, version)),
      env,
    }).catch(() => {});
  }
}

test("Windows clean-machine lifecycle preserves user state across uninstall/reinstall and leaves no owned residue after full uninstall", { skip: process.platform !== "win32" }, async (t) => {
  await deleteRegistryFixture();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-win-lifecycle-"));
  const homeDir = path.join(root, "Türk User Home");
  const localAppData = path.join(root, "Local App Data");
  await fs.mkdir(homeDir, { recursive: true });
  const env = { ...process.env, USERPROFILE: homeDir, LOCALAPPDATA: localAppData };
  const versions = ["5.2.1", "5.3.0", "5.4.0"];
  t.after(async () => {
    await cleanupNativeMessaging(homeDir, env, versions);
    await deleteRegistryFixture();
    await fs.rm(root, { recursive: true, force: true });
  });

  const first = await installFixture({ homeDir, env, version: versions[0] });
  assert.equal(first.status, "installed");
  const layout = equinoxLocalPlatformPaths({ platform: "win32", arch: WINDOWS_ARCH, homeDir, env });
  const configPath = layout.configPath;
  const workspaceMarker = path.join(layout.appDataRoot, "workspace", "preserve-marker.txt");
  await fs.writeFile(workspaceMarker, "keep-me\n");
  const configBefore = await fs.readFile(configPath, "utf8");

  const retryStage = await createStagedRelease({ installRoot: layout.appDataRoot, version: versions[0] });
  const retryMetadataPath = path.join(retryStage, "release.json");
  const retryMetadata = JSON.parse(await fs.readFile(retryMetadataPath, "utf8"));
  await fs.writeFile(retryMetadataPath, `${JSON.stringify({ ...retryMetadata, sourceSha: "a".repeat(40) })}\n`);
  const retry = await installManagedEquinoxRelease({
    stagedReleaseDir: retryStage,
    homeDir,
    platform: "win32",
    arch: WINDOWS_ARCH,
    target: WINDOWS_TARGET,
    env,
    initializeOnboardingImpl: async () => ({ created: false }),
    launchWindowsShellImpl: async () => ({ launched: true }),
    waitForVersionImpl: async () => true,
  });
  assert.equal(retry.status, "already-installed");
  assert.equal(retry.managedSourceSha, null, "Windows Stable 5.2.x must never silently switch to Main");
  await assert.rejects(installManagedEquinoxRelease({
    stagedReleaseDir: retryStage,
    homeDir, platform: "win32", arch: WINDOWS_ARCH, target: WINDOWS_TARGET, env,
    allowExistingStableToMainMigration: true,
    initializeOnboardingImpl: async () => { throw new Error("Migration must fail before onboarding mutation"); },
  }), /source provenance does not match/u);
  assert.equal((await readManagedCurrentRelease(installationFor({ homeDir, env, version: versions[0] }))).version, versions[0]);
  await fs.rm(path.dirname(retryStage), { recursive: true, force: true });

  await addCandidateRelease({ homeDir, env, version: versions[1] });
  let installation = installationFor({ homeDir, env, version: versions[0] });
  const updated = await activatePreparedEquinoxRelease({
    installation,
    targetVersion: versions[1],
    kickstartImpl: async () => {},
    fetchImpl: async () => new Response(JSON.stringify({ status: { server: { version: versions[1] }, health: { state: "HEALTHY" } } }), { status: 200 }),
    sleepImpl: async () => {},
    healthAttempts: 1,
  });
  assert.equal(updated.status, "activated");
  assert.equal((await readManagedCurrentRelease(installationFor({ homeDir, env, version: versions[1] }))).version, versions[1]);

  await addCandidateRelease({ homeDir, env, version: versions[2] });
  installation = installationFor({ homeDir, env, version: versions[1] });
  await assert.rejects(activatePreparedEquinoxRelease({
    installation,
    targetVersion: versions[2],
    kickstartImpl: async () => {},
    fetchImpl: async () => {
      const active = (await readManagedCurrentRelease(installationFor({ homeDir, env, version: versions[1] }))).version;
      if (active === versions[2]) throw new Error("forced candidate health failure");
      return new Response(JSON.stringify({ status: { server: { version: active }, health: { state: "HEALTHY" } } }), { status: 200 });
    },
    sleepImpl: async () => {},
    healthAttempts: 1,
  }), /rolled back to 5\.3\.0/u);
  assert.equal((await readManagedCurrentRelease(installationFor({ homeDir, env, version: versions[1] }))).version, versions[1]);

  const expectedStartup = `"${path.join(layout.programRoot, "EquinoxLocal.exe")}" --startup`;
  await setStartup(expectedStartup);
  installation = installationFor({ homeDir, env, version: versions[1] });
  const preserved = await runWindowsEquinoxLocalUninstall({
    installation,
    removeUserData: false,
    env: { ...env, EQUINOX_LOCAL_EXPECTED_STARTUP_COMMAND: expectedStartup },
    homeDir,
    shellPid: 424242,
    processAliveImpl: () => false,
    sleepImpl: async () => {},
    // Legacy fixture never launches the native WPF shell and therefore has
    // no installed-app/Start Menu ownership to remove. Real entries are
    // exercised separately by the genuine Windows public installer gate.
    cleanupShellRegistrationImpl: async () => ({ cleaned: true }),
  });
  assert.equal(preserved.userDataPreserved, true);
  assert.equal(await exists(configPath), true);
  assert.equal(await fs.readFile(configPath, "utf8"), configBefore);
  assert.equal(await fs.readFile(workspaceMarker, "utf8"), "keep-me\n");
  assert.equal(await exists(layout.currentPointer), false);
  assert.equal(await exists(layout.releasesRoot), false);
  assert.equal(await exists(layout.programRoot), false);
  assert.equal(await readStartup(), null);
  assert.equal(await readWindowsNativeMessagingRegistryValue({ env }), null);

  const reinstalled = await installFixture({ homeDir, env, version: versions[1] });
  assert.equal(reinstalled.status, "installed");
  assert.equal(await fs.readFile(configPath, "utf8"), configBefore);
  assert.equal(await fs.readFile(workspaceMarker, "utf8"), "keep-me\n");

  await setStartup(expectedStartup);
  installation = installationFor({ homeDir, env, version: versions[1] });
  const removed = await runWindowsEquinoxLocalUninstall({
    installation,
    removeUserData: true,
    env: { ...env, EQUINOX_LOCAL_EXPECTED_STARTUP_COMMAND: expectedStartup },
    homeDir,
    shellPid: 424243,
    processAliveImpl: () => false,
    sleepImpl: async () => {},
    // Legacy fixture never launches the native WPF shell and therefore has
    // no installed-app/Start Menu ownership to remove. Real entries are
    // exercised separately by the genuine Windows public installer gate.
    cleanupShellRegistrationImpl: async () => ({ cleaned: true }),
  });
  assert.equal(removed.userDataRemoved, true);
  assert.equal(await exists(layout.appDataRoot), false);
  assert.equal(await exists(layout.programRoot), false);
  assert.equal(await readStartup(), null);
  assert.equal(await readWindowsNativeMessagingRegistryValue({ env }), null);
  console.log(`Windows ${WINDOWS_TARGET} clean-machine lifecycle acceptance passed: install/retry/update/rollback/preserve-reinstall/full-uninstall with no owned residue.`);
});

test("Windows uninstall refuses foreign startup and Native Messaging ownership before destructive cleanup", { skip: process.platform !== "win32" }, async (t) => {
  await deleteRegistryFixture();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-win-foreign-uninstall-"));
  const homeDir = path.join(root, "User Home");
  const localAppData = path.join(root, "Local App Data");
  await fs.mkdir(homeDir, { recursive: true });
  const env = { ...process.env, USERPROFILE: homeDir, LOCALAPPDATA: localAppData };
  const version = "5.2.1";
  t.after(async () => {
    await cleanupNativeMessaging(homeDir, env, [version]);
    await deleteRegistryFixture();
    await fs.rm(root, { recursive: true, force: true });
  });
  await installFixture({ homeDir, env, version });
  const layout = equinoxLocalPlatformPaths({ platform: "win32", arch: WINDOWS_ARCH, homeDir, env });
  const installation = installationFor({ homeDir, env, version });
  const expectedStartup = `"${path.join(layout.programRoot, "EquinoxLocal.exe")}" --startup`;

  await setStartup('"C:\\Foreign\\Other.exe" --startup');
  await assert.rejects(runWindowsEquinoxLocalUninstall({
    installation, removeUserData: true, env: { ...env, EQUINOX_LOCAL_EXPECTED_STARTUP_COMMAND: expectedStartup }, homeDir,
    shellPid: 424244, processAliveImpl: () => false, sleepImpl: async () => {},
  }), /startup registration is foreign/u);
  assert.equal(await exists(layout.currentPointer), true);
  assert.equal(await exists(layout.programRoot), true);
  assert.equal(await readStartup(), '"C:\\Foreign\\Other.exe" --startup');

  await setStartup(expectedStartup);
  await execFile("reg.exe", ["ADD", NATIVE_KEY, "/ve", "/t", "REG_SZ", "/d", "C:\\Foreign\\manifest.json", "/f"], { windowsHide: true });
  await assert.rejects(runWindowsEquinoxLocalUninstall({
    installation, removeUserData: true, env: { ...env, EQUINOX_LOCAL_EXPECTED_STARTUP_COMMAND: expectedStartup }, homeDir,
    shellPid: 424245, processAliveImpl: () => false, sleepImpl: async () => {},
  }), /another manifest|ownership|registry/u);
  assert.equal(await exists(layout.currentPointer), true);
  assert.equal(await exists(layout.programRoot), true);
  assert.equal(await readStartup(), expectedStartup);
  const { stdout } = await execFile("reg.exe", ["QUERY", NATIVE_KEY, "/ve"], { windowsHide: true });
  assert.match(stdout, /C:\\Foreign\\manifest\.json/iu);
  console.log(`Windows ${WINDOWS_TARGET} foreign-state uninstall acceptance passed: startup and Native Messaging foreign owners survived untouched.`);
});
