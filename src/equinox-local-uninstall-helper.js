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
import { validateManagedSourceInstallStamp } from "./equinox-local-main-update.js";
import { equinoxLocalManagedSourcePaths } from "./equinox-local-managed-source-installation.js";
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
const WINDOWS_STARTUP_SUBKEY_ENV_KEY = "EQUINOX_LOCAL_STARTUP_REGISTRY_SUBKEY";
const WINDOWS_STARTUP_VALUE_ENV_KEY = "EQUINOX_LOCAL_STARTUP_VALUE_NAME";
const WINDOWS_STARTUP_REGISTRY_SUBKEY = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const WINDOWS_SHELL_REGISTRATION_CLEANUP_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$exe = Join-Path $env:EQUINOX_LOCAL_EXPECTED_PROGRAM_ROOT 'EquinoxLocal.exe'",
  "$expectedUninstall = '" + '"' + "' + $exe + '" + '"' + " --uninstall'",
  "$subkey = 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Equinox Local'",
  "$registry = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($subkey, $true)",
  "if ($null -ne $registry) {",
  "  try {",
  "    if ($registry.GetValue('EquinoxLocalManagedInstall') -ne 1 -or $registry.GetValue('DisplayName') -cne 'Equinox Local' -or $registry.GetValue('InstallLocation') -ne $env:EQUINOX_LOCAL_EXPECTED_PROGRAM_ROOT -or $registry.GetValue('UninstallString') -cne $expectedUninstall) { throw 'Foreign Windows app uninstall registration; refusing cleanup' }",
  "  } finally { $registry.Dispose() }",
  "}",
  "$programs = [Environment]::GetFolderPath('Programs')",
  "if ([string]::IsNullOrWhiteSpace($programs)) {",
  "  $appData = $env:APPDATA",
  "  if ([string]::IsNullOrWhiteSpace($appData)) {",
  "    if ([string]::IsNullOrWhiteSpace($env:USERPROFILE)) { throw 'Windows user profile is unavailable' }",
  "    $appData = Join-Path (Join-Path $env:USERPROFILE 'AppData') 'Roaming'",
  "  }",
  "  if (-not [IO.Path]::IsPathRooted($appData)) { throw 'Windows Start Menu path is not absolute' }",
  "  $programs = Join-Path (Join-Path (Join-Path (Join-Path $appData 'Microsoft') 'Windows') 'Start Menu') 'Programs'",
  "}",
  "$shortcutPath = Join-Path $programs 'Equinox Local.lnk'",
  "if ([IO.File]::Exists($shortcutPath)) {",
  "  $info = New-Object IO.FileInfo($shortcutPath)",
  "  if (($info.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Start Menu shortcut is not owned' }",
  "  $shell = New-Object -ComObject WScript.Shell",
  "  try {",
  "    $shortcut = $shell.CreateShortcut($shortcutPath)",
  "    if (-not [string]::Equals([IO.Path]::GetFullPath($shortcut.TargetPath), [IO.Path]::GetFullPath($exe), [StringComparison]::OrdinalIgnoreCase)) { throw 'Start Menu shortcut is foreign' }",
  "  } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }",
  "  [IO.File]::Delete($shortcutPath)",
  "}",
  "if ([Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($subkey) -ne $null) {",
  "  [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKey($subkey, $false)",
  "}",
].join("\n");

export async function removeWindowsShellRegistration({ programRoot, execFileImpl = execFile, env = process.env } = {}) {
  if (typeof programRoot !== 'string' || !path.win32.isAbsolute(programRoot) ||
      !path.win32.basename(programRoot).toLowerCase().endsWith('equinox local')) {
    throw new Error('Windows shell integration cleanup requires the validated program root.');
  }
  const spawnEnv = { ...windowsStartupRegistryReadEnvironment(env), EQUINOX_LOCAL_EXPECTED_PROGRAM_ROOT: programRoot };
  const encodedScript = Buffer.from(WINDOWS_SHELL_REGISTRATION_CLEANUP_SCRIPT, "utf16le").toString("base64");
  await execFileImpl(windowsPowerShellPath(env), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedScript], {
    env: spawnEnv, timeout: 60_000, maxBuffer: 4096, windowsHide: true,
  });
  return Object.freeze({ cleaned: true });
}

const READ_WINDOWS_STARTUP_SCRIPT = [
  "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($env:EQUINOX_LOCAL_STARTUP_REGISTRY_SUBKEY, $false)",
  "if ($null -eq $key) { [Console]::Out.WriteLine('missing'); exit 0 }",
  "try {",
  "  $value = $key.GetValue($env:EQUINOX_LOCAL_STARTUP_VALUE_NAME, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
  "  if ($null -eq $value) { [Console]::Out.WriteLine('missing'); exit 0 }",
  "  if ($value -isnot [string]) { [Console]::Out.WriteLine('invalid'); exit 0 }",
  "  $hex = [BitConverter]::ToString([Text.Encoding]::UTF8.GetBytes($value)).Replace('-', '')",
  "  [Console]::Out.WriteLine('value:' + $hex)",
  "} finally { $key.Dispose() }",
].join("; ");

function windowsPowerShellPath(env = process.env) {
  const root = env?.SystemRoot || env?.SYSTEMROOT;
  if (typeof root === "string" && path.win32.isAbsolute(root)) {
    return path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  }
  if (process.platform !== "win32") return "powershell.exe";
  throw new Error("Windows SystemRoot is unavailable for uninstall registry access.");
}

function windowsStartupRegistryReadEnvironment(env = process.env) {
  const entries = {
    SystemRoot: env?.SystemRoot || env?.SYSTEMROOT,
    WINDIR: env?.WINDIR || env?.SystemRoot || env?.SYSTEMROOT,
    USERPROFILE: env?.USERPROFILE,
    LOCALAPPDATA: env?.LOCALAPPDATA,
    APPDATA: env?.APPDATA,
    TEMP: env?.TEMP,
    TMP: env?.TMP,
    [WINDOWS_STARTUP_SUBKEY_ENV_KEY]: WINDOWS_STARTUP_REGISTRY_SUBKEY,
    [WINDOWS_STARTUP_VALUE_ENV_KEY]: WINDOWS_STARTUP_VALUE_NAME,
  };
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => typeof value === "string" && value.length > 0));
}

function parseMode(argv) {
  if (argv.length !== 2 || argv[0] !== "--uninstall") {
    throw new Error("Usage: equinox-local-uninstall-helper.js --uninstall --preserve-user-data|--remove-user-data");
  }
  if (argv[1] === "--preserve-user-data") return false;
  if (argv[1] === "--remove-user-data") return true;
  throw new Error("Unknown Equinox Local uninstall mode.");
}

async function removeIfExists(target, { recursive = false, fsImpl = fs } = {}) {
  let stat;
  try {
    stat = await fsImpl.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (recursive && (!stat.isDirectory() || stat.isSymbolicLink())) {
    throw new Error("Refusing recursive uninstall of an unowned directory or symlink.");
  }
  await fsImpl.rm(target, { recursive, force: false });
  return true;
}

async function verifyUninstallDirectoryIfPresent(target, { fsImpl = fs } = {}) {
  try {
    const stat = await fsImpl.lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe uninstall directory: ${target}`);
  } catch (error) { if (error?.code !== "ENOENT") throw error; }
}

// Preserve-mode uninstall must not mistake legacy 5.2.x data (or a foreign
// directory with the same name) for an admitted managed-source enrollment.
const OWNED_MAIN_ENTRIES = new Set([
  "install.json", "current-source.conf", "sources", "enrollment-staging", "active.json",
  "receipts", "staging", "handoff", "current-native.json", "native-store",
]);
const MAIN_SOURCE_SHA = /^[a-f0-9]{40}$/u;

export async function inspectOwnedMainUninstallState({ platform, arch, homeDir, env, fsImpl = fs } = {}) {
  const paths = equinoxLocalManagedSourcePaths({ platform, arch, homeDir, env });
  const root = paths.mainTransactionRoot;
  let stat;
  try { stat = await fsImpl.lstat(root); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Main uninstall state root is not a normal owned directory.");
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  await verifyUninstallDirectoryIfPresent(pathApi.dirname(root), { fsImpl });
  const realRoot = await fsImpl.realpath(root);
  const expectedRealRoot = pathApi.join(await fsImpl.realpath(pathApi.dirname(root)), pathApi.basename(root));
  if ((platform === "win32" ? pathApi.normalize(realRoot).toLowerCase() : realRoot)
      !== (platform === "win32" ? pathApi.normalize(expectedRealRoot).toLowerCase() : expectedRealRoot)) {
    throw new Error("Main uninstall state root has an unsafe path identity.");
  }
  // Legacy Stable installations carry no managed-source stamp. In that case
  // leave any unclaimed update state alone instead of adopting it as ours.
  let stampData;
  try {
    ({ data: stampData } = await readBoundedNormalFile(paths.installStampPath, {
      fsImpl, minBytes: 2, maxBytes: 8 * 1024, encoding: "utf8", label: "Main uninstall install stamp",
    }));
  } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  try { validateManagedSourceInstallStamp(JSON.parse(stampData)); }
  catch { throw new Error("Main uninstall state has an invalid managed-source install stamp."); }
  const { data: pointer } = await readBoundedNormalFile(paths.sourcePointerPath, {
    fsImpl, minBytes: 1, maxBytes: 8 * 1024, encoding: "utf8", label: "Main uninstall source pointer",
  });
  const fields = pointer.trimEnd().split(/\r?\n/u).map((entry) => entry.split("="));
  if (fields.length !== 3 || fields.some(([key, value], index) => !value ||
    key !== ["schemaVersion", "sourceRoot", "sha"][index])) {
    throw new Error("Main uninstall source pointer is malformed.");
  }
  const sha = fields[2][1];
  if (fields[0][1] !== "1" || !MAIN_SOURCE_SHA.test(sha) ||
      fields[1].slice(1).join("=") !== pathApi.join(root, "sources", sha)) {
    throw new Error("Main uninstall source pointer is not product-owned.");
  }
  for (const name of await fsImpl.readdir(root)) {
    if (!OWNED_MAIN_ENTRIES.has(name)) throw new Error("Main uninstall state contains a foreign entry; refusing cleanup.");
    if (name === "active.json") throw new Error("Main update is active or interrupted; refusing concurrent uninstall.");
  }
  const sourcesRoot = pathApi.join(root, "sources");
  let sourcesStat;
  try { sourcesStat = await fsImpl.lstat(sourcesRoot); }
  catch (error) { if (error?.code === "ENOENT") throw new Error("Main uninstall owned sources are missing."); throw error; }
  if (!sourcesStat.isDirectory() || sourcesStat.isSymbolicLink()) throw new Error("Main uninstall owned sources directory is unsafe.");
  for (const name of await fsImpl.readdir(sourcesRoot)) {
    if (!MAIN_SOURCE_SHA.test(name)) throw new Error("Main uninstall source store contains foreign data.");
    const entry = await fsImpl.lstat(pathApi.join(sourcesRoot, name));
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Main uninstall source store contains an unsafe checkout.");
  }
  return root;
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
  const { stdout } = await execFileImpl(windowsPowerShellPath(env), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", READ_WINDOWS_STARTUP_SCRIPT], {
    timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true,
    env: windowsStartupRegistryReadEnvironment(env),
  });
  const output = String(stdout).trim();
  if (output === "missing") return Object.freeze({ enabled: false, expectedCommand });
  if (!output.startsWith("value:")) throw new Error("Windows startup registration is malformed; refusing managed uninstall.");
  const hex = output.slice("value:".length);
  if (!hex || hex.length % 2 !== 0 || !/^[0-9A-F]+$/u.test(hex)) {
    throw new Error("Windows startup registration is malformed; refusing managed uninstall.");
  }
  const parsed = Buffer.from(hex, "hex").toString("utf8");
  if (!parsed || parsed.toLowerCase() !== expectedCommand.toLowerCase()) {
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
  readStartupImpl = readWindowsStartupRegistrationOwnership, unregisterStartupImpl = unregisterWindowsStartupRegistration,
  cleanupShellRegistrationImpl = removeWindowsShellRegistration,
  inspectOwnedMainStateImpl = inspectOwnedMainUninstallState, execFileImpl = execFile,
} = {}) {
  const expectedTarget = installation?.arch === "x64" ? "win32-x64"
    : installation?.arch === "arm64" ? "win32-arm64" : null;
  if (installation?.platform !== "win32" || expectedTarget === null || installation?.target !== expectedTarget) {
    throw new Error("Windows uninstall requires an exact native win32-x64 or win32-arm64 managed installation.");
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
  const layout = platformPathsImpl({ platform: "win32", arch: installation.arch, homeDir, env });
  if (!sameWindowsPath(layout.appDataRoot, installation.installRoot)
      || !sameWindowsPath(layout.programRoot, installation.programRoot)
      || !sameWindowsPath(layout.nativeMessagingManifestRoot, installation.nativeMessagingManifestRoot)) {
    throw new Error("Windows uninstall managed layout changed unexpectedly.");
  }
  const mainRoot = removeUserData ? null : await inspectOwnedMainStateImpl({
    platform: "win32", arch: installation.arch, homeDir, env, fsImpl,
  });
  if (!removeUserData) await verifyUninstallDirectoryIfPresent(layout.runtimeRoot, { fsImpl });
  await cleanupShellRegistrationImpl({ programRoot: installation.programRoot, execFileImpl, env });
  await unregisterStartupImpl({ expectedCommand: expectedStartupCommand, execFileImpl, env });
  const removedNativeHost = await unregisterNativeMessagingImpl({ manifestPath: ownership.manifestPath, launcherPath, fsImpl, env });
  if (removedNativeHost.reason) throw new Error(`Windows Native Messaging ownership changed during uninstall: ${removedNativeHost.reason}`);

  await removePathImpl(installation.programRoot, { recursive: true, fsImpl });
  if (removeUserData) {
    await removePathImpl(installation.installRoot, { recursive: true, fsImpl });
  } else {
    const directoryTargets = [installation.releasesRoot, installation.stagingRoot, layout.runtimeRoot, layout.logsRoot,
      path.win32.join(installation.installRoot, "secrets"), path.win32.join(installation.installRoot, "tunnel-profile")];
    const fileTargets = [installation.currentPointer, path.win32.join(installation.installRoot, "transport.json"), path.win32.join(installation.installRoot, "update-state.json")];
    if (mainRoot) directoryTargets.push(mainRoot);
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

  const layout = equinoxLocalPlatformPaths({ platform, arch, homeDir, env });
  const mainRoot = removeUserData ? null : await inspectOwnedMainUninstallState({ platform, arch, homeDir, env, fsImpl });
  if (!removeUserData) await verifyUninstallDirectoryIfPresent(layout.runtimeRoot, { fsImpl });
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
      layout.runtimeRoot,
      ...(mainRoot ? [mainRoot] : []),
      path.join(installation.installRoot, "secrets"),
      path.join(installation.installRoot, "transport.json"),
      path.join(installation.installRoot, "tunnel-profile"),
      path.join(installation.installRoot, "equinox-browser-native-host"),
      equinoxLocalAppRuntimeWrapperPath(homeDir),
      path.join(installation.installRoot, "update-state.json"),
    ]) {
      await removeIfExists(target, {
        recursive: target === installation.releasesRoot || target === installation.stagingRoot || target === layout.runtimeRoot || target === mainRoot || target.endsWith("/secrets") || target.endsWith("/tunnel-profile"),
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
