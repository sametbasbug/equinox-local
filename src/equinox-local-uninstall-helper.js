import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  equinoxLocalAppPath,
  equinoxLocalAppRuntimeWrapperPath,
  validateEquinoxLocalAppHost,
} from "./equinox-local-app-host.js";
import { resolveEquinoxLocalInstallation } from "./equinox-local-installation.js";
import { readBoundedNormalFile } from "./equinox-local-safe-file.js";
import {
  assertWindowsNativeMessagingHostOwnership,
  unregisterWindowsNativeMessagingHost,
  windowsNativeMessagingLauncherPath,
} from "./equinox-browser-windows-native-messaging.js";
import { equinoxLocalPlatformPaths } from "./equinox-local-platform.js";
import { readManagedCurrentRelease } from "./equinox-local-update-activation.js";
import { assertWindowsStableShellOwnedByRelease } from "./equinox-local-windows-stable-shell.js";

const execFile = promisify(execFileCallback);
const START_DELAY_MS = 1_500;
const NATIVE_HOST_NAME = "dev.equinox.browser";
const WINDOWS_STARTUP_REGISTRY_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const WINDOWS_STARTUP_VALUE_NAME = "Equinox Local";
const READ_WINDOWS_STARTUP_SCRIPT = [
  "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
  "$key = Get-Item -LiteralPath 'Registry::HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -ErrorAction SilentlyContinue",
  "$value = if ($null -eq $key) { $null } else { $key.GetValue($env:EQUINOX_LOCAL_STARTUP_VALUE_NAME, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }",
  "if ($null -eq $value) { 'null' } else { $value | ConvertTo-Json -Compress }",
].join("; ");

function parseMode(argv) {
  if (argv.length !== 2 || argv[0] !== "--uninstall") {
    throw new Error("Usage: equinox-local-uninstall-helper.js --uninstall --preserve-user-data|--remove-user-data");
  }
  if (argv[1] === "--preserve-user-data") return false;
  if (argv[1] === "--remove-user-data") return true;
  throw new Error("Unknown Equinox Local uninstall mode.");
}

async function removeIfExists(target, { recursive = false, fsImpl = fs } = {}) {
  try {
    await fsImpl.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  await fsImpl.rm(target, { recursive, force: false });
  return true;
}

async function removeOwnedNativeHostManifest({ homeDir, installRoot, fsImpl = fs }) {
  const manifestPath = path.join(
    homeDir,
    "Library",
    "Application Support",
    "Google",
    "Chrome",
    "NativeMessagingHosts",
    `${NATIVE_HOST_NAME}.json`,
  );
  try {
    const { data } = await readBoundedNormalFile(manifestPath, {
      fsImpl,
      minBytes: 1,
      maxBytes: 16 * 1024,
      encoding: "utf8",
      label: "Equinox Browser Native Messaging manifest",
    });
    const manifest = JSON.parse(data);
    if (path.resolve(manifest?.path || "") !== path.join(installRoot, "equinox-browser-native-host")) return false;
    await fsImpl.rm(manifestPath, { force: false });
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    return false;
  }
}

async function removeOwnedEquinoxLocalAppHost({ homeDir, fsImpl = fs, execFileImpl = execFile }) {
  const appPath = equinoxLocalAppPath(homeDir);
  try {
    await validateEquinoxLocalAppHost(appPath, { fsImpl, execFileImpl });
    await fsImpl.rm(appPath, { recursive: true, force: false });
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    return false;
  }
}

export async function readWindowsStartupRegistrationOwnership({
  expectedCommand, execFileImpl = execFile, env = process.env,
} = {}) {
  if (typeof expectedCommand !== "string" || !expectedCommand) throw new Error("Expected Windows startup command is required for uninstall.");
  const { stdout } = await execFileImpl("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", READ_WINDOWS_STARTUP_SCRIPT], {
    timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true,
    env: { ...env, EQUINOX_LOCAL_STARTUP_VALUE_NAME: WINDOWS_STARTUP_VALUE_NAME },
  });
  const parsed = JSON.parse(String(stdout).trim() || "null");
  if (parsed === null) return Object.freeze({ enabled: false, expectedCommand });
  if (typeof parsed !== "string" || parsed.toLowerCase() !== expectedCommand.toLowerCase()) {
    throw new Error("Windows startup registration is foreign; refusing managed uninstall.");
  }
  return Object.freeze({ enabled: true, expectedCommand });
}

export async function unregisterWindowsStartupRegistration({
  expectedCommand, execFileImpl = execFile, env = process.env, readImpl = readWindowsStartupRegistrationOwnership,
} = {}) {
  const current = await readImpl({ expectedCommand, execFileImpl, env });
  if (!current.enabled) return Object.freeze({ removed: false });
  await execFileImpl("reg.exe", ["DELETE", WINDOWS_STARTUP_REGISTRY_KEY, "/v", WINDOWS_STARTUP_VALUE_NAME, "/f"], {
    timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true, env,
  });
  const after = await readImpl({ expectedCommand, execFileImpl, env });
  if (after.enabled) throw new Error("Windows startup registration remained after uninstall removal.");
  return Object.freeze({ removed: true });
}

function sameWindowsPath(left, right) {
  return typeof left === "string" && typeof right === "string"
    && path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase();
}

async function waitForProcessExit(pid, {
  processAliveImpl = (value) => {
    try { process.kill(value, 0); return true; } catch (error) {
      if (error?.code === "ESRCH") return false;
      throw error;
    }
  },
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  attempts = 150,
} = {}) {
  if (!Number.isInteger(pid) || pid < 1) throw new Error("Windows uninstall requires the exact native shell pid.");
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!processAliveImpl(pid)) return;
    if (attempt + 1 < attempts) await sleepImpl(100);
  }
  throw new Error("Windows native shell did not exit before managed uninstall cleanup.");
}

async function removeNormalPath(target, { recursive = false, fsImpl = fs } = {}) {
  let stat;
  try { stat = await fsImpl.lstat(target); } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`Refusing to remove reparse/symlink uninstall target: ${target}`);
  if (recursive && !stat.isDirectory()) throw new Error(`Expected uninstall directory is not a normal directory: ${target}`);
  if (!recursive && !stat.isFile() && !stat.isDirectory()) throw new Error(`Unsupported uninstall target type: ${target}`);
  await fsImpl.rm(target, { recursive, force: false });
  return true;
}

export async function runWindowsEquinoxLocalUninstall({
  installation, removeUserData, env = process.env, homeDir = env.USERPROFILE,
  shellPid = Number(env.EQUINOX_LOCAL_UNINSTALL_SHELL_PID), fsImpl = fs,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), processAliveImpl,
  readCurrentImpl = readManagedCurrentRelease, assertStableShellImpl = assertWindowsStableShellOwnedByRelease,
  assertNativeMessagingImpl = assertWindowsNativeMessagingHostOwnership, unregisterNativeMessagingImpl = unregisterWindowsNativeMessagingHost,
  launcherPathImpl = windowsNativeMessagingLauncherPath, platformPathsImpl = equinoxLocalPlatformPaths, removePathImpl = removeNormalPath,
  readStartupImpl = readWindowsStartupRegistrationOwnership, unregisterStartupImpl = unregisterWindowsStartupRegistration, execFileImpl = execFile,
} = {}) {
  if (installation?.platform !== "win32" || installation?.arch !== "x64" || installation?.target !== "win32-x64") {
    throw new Error("Windows uninstall requires a managed win32-x64 installation.");
  }
  if (typeof removeUserData !== "boolean") throw new Error("Windows uninstall requires an explicit data policy.");
  await waitForProcessExit(shellPid, { processAliveImpl, sleepImpl });
  const current = await readCurrentImpl(installation);
  if (!sameWindowsPath(current.releaseDir, installation.releaseDir)) throw new Error("Windows uninstall release does not match the exact current-version pointer.");
  await assertStableShellImpl({ releaseDir: current.releaseDir, programRoot: installation.programRoot, fsImpl });
  const expectedStartupCommand = env.EQUINOX_LOCAL_EXPECTED_STARTUP_COMMAND;
  await readStartupImpl({ expectedCommand: expectedStartupCommand, execFileImpl, env });
  const launcherPath = launcherPathImpl(current.releaseDir);
  const ownership = await assertNativeMessagingImpl({
    manifestRoot: installation.nativeMessagingManifestRoot, acceptedLauncherPaths: [launcherPath], fsImpl, env,
  });
  await unregisterStartupImpl({ expectedCommand: expectedStartupCommand, execFileImpl, env });
  const removedNativeHost = await unregisterNativeMessagingImpl({ manifestPath: ownership.manifestPath, launcherPath, fsImpl, env });
  if (removedNativeHost.reason) throw new Error(`Windows Native Messaging ownership changed during uninstall: ${removedNativeHost.reason}`);

  const layout = platformPathsImpl({ platform: "win32", arch: "x64", homeDir, env });
  if (!sameWindowsPath(layout.appDataRoot, installation.installRoot)
      || !sameWindowsPath(layout.programRoot, installation.programRoot)
      || !sameWindowsPath(layout.nativeMessagingManifestRoot, installation.nativeMessagingManifestRoot)) {
    throw new Error("Windows uninstall managed layout changed unexpectedly.");
  }
  await removePathImpl(installation.programRoot, { recursive: true, fsImpl });
  if (removeUserData) {
    await removePathImpl(installation.installRoot, { recursive: true, fsImpl });
  } else {
    const directoryTargets = [installation.releasesRoot, installation.stagingRoot, layout.runtimeRoot, layout.logsRoot,
      path.win32.join(installation.installRoot, "secrets"), path.win32.join(installation.installRoot, "tunnel-profile")];
    const fileTargets = [installation.currentPointer, path.win32.join(installation.installRoot, "transport.json"), path.win32.join(installation.installRoot, "update-state.json")];
    for (const target of directoryTargets) await removePathImpl(target, { recursive: true, fsImpl });
    for (const target of fileTargets) await removePathImpl(target, { fsImpl });
  }
  return Object.freeze({ uninstalled: true, userDataRemoved: removeUserData, userDataPreserved: !removeUserData });
}

export async function runEquinoxLocalUninstallHelper({
  argv = process.argv.slice(2),
  env = process.env,
  homeDir = env.HOME,
  uid = typeof process.getuid === "function" ? process.getuid() : null,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  execFileImpl = execFile,
  fsImpl = fs,
  platform = process.platform,
  arch = process.arch,
  runWindowsImpl = runWindowsEquinoxLocalUninstall,
} = {}) {
  const removeUserData = parseMode(argv);
  homeDir = homeDir || (platform === "win32" ? env.USERPROFILE : env.HOME);
  const installation = resolveEquinoxLocalInstallation({ platform, arch, homeDir, env });
  if (!installation.managed || !installation.selfUpdateSupported) {
    throw new Error("Uninstall helper requires a managed Equinox Local installation.");
  }
  if (platform === "win32") {
    return runWindowsImpl({ installation, removeUserData, env, homeDir, fsImpl, sleepImpl });
  }
  if (!Number.isInteger(uid) || uid <= 0) throw new Error("A non-root user id is required for Equinox Local uninstall.");

  await sleepImpl(START_DELAY_MS);
  await execFileImpl("/bin/launchctl", [
    "bootout",
    `gui/${uid}/${installation.launchAgentLabel}`,
  ], { timeout: 15_000, maxBuffer: 1024 * 1024 }).catch(() => ({ stdout: "", stderr: "" }));

  await removeOwnedNativeHostManifest({ homeDir, installRoot: installation.installRoot, fsImpl });
  await removeIfExists(installation.launchAgentPath, { fsImpl });
  await removeOwnedEquinoxLocalAppHost({ homeDir, fsImpl, execFileImpl });
  for (const logName of ["Equinox Local.log", "Equinox Local.error.log"]) {
    await removeIfExists(path.join(homeDir, "Library", "Logs", logName), { fsImpl });
  }

  if (removeUserData) {
    await removeIfExists(installation.installRoot, { recursive: true, fsImpl });
  } else {
    for (const target of [
      installation.currentLink,
      installation.releasesRoot,
      installation.stagingRoot,
      path.join(installation.installRoot, "secrets"),
      path.join(installation.installRoot, "transport.json"),
      path.join(installation.installRoot, "tunnel-profile"),
      path.join(installation.installRoot, "equinox-browser-native-host"),
      equinoxLocalAppRuntimeWrapperPath(homeDir),
      path.join(installation.installRoot, "update-state.json"),
    ]) {
      await removeIfExists(target, {
        recursive: target === installation.releasesRoot || target === installation.stagingRoot || target.endsWith("/secrets") || target.endsWith("/tunnel-profile"),
        fsImpl,
      });
    }
  }

  return Object.freeze({
    uninstalled: true,
    userDataRemoved: removeUserData,
    userDataPreserved: !removeUserData,
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath && import.meta.url === invokedPath) {
  runEquinoxLocalUninstallHelper().catch(() => {
    process.exitCode = 1;
  });
}
