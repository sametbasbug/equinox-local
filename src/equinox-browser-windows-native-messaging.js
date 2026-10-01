import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { EQUINOX_BROWSER_EXTENSION_ID, EQUINOX_BROWSER_HOST_NAME } from "./equinox-browser-bridge.js";
import { readBoundedNormalFile, writeBoundedUtf8File } from "./equinox-local-safe-file.js";

const execFile = promisify(execFileCallback);
export const EQUINOX_BROWSER_WINDOWS_REGISTRY_KEY = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${EQUINOX_BROWSER_HOST_NAME}`;
const REGISTRY_SUBKEY_ENV_KEY = "EQUINOX_BROWSER_NATIVE_HOST_REGISTRY_SUBKEY";
const WINDOWS_NATIVE_MESSAGING_REGISTRY_SUBKEY = `Software\\Google\\Chrome\\NativeMessagingHosts\\${EQUINOX_BROWSER_HOST_NAME}`;
const READ_REGISTRY_SCRIPT = [
  "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($env:EQUINOX_BROWSER_NATIVE_HOST_REGISTRY_SUBKEY, $false)",
  "if ($null -eq $key) { [Console]::Out.WriteLine('missing'); exit 0 }",
  "try {",
  "  $value = $key.GetValue($null, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
  "  if ($null -eq $value) { [Console]::Out.WriteLine('missing'); exit 0 }",
  "  if ($value -isnot [string]) { [Console]::Out.WriteLine('invalid'); exit 0 }",
  "  $hex = [BitConverter]::ToString([Text.Encoding]::UTF8.GetBytes($value)).Replace('-', '')",
  "  [Console]::Out.WriteLine('value:' + $hex)",
  "} finally { $key.Dispose() }",
].join("; ");
const MANIFEST_MAX_BYTES = 16 * 1024;

function windowsPowerShellPath(env = process.env) {
  const root = env?.SystemRoot || env?.SYSTEMROOT;
  if (typeof root === "string" && path.win32.isAbsolute(root)) {
    return path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  }
  if (process.platform !== "win32") return "powershell.exe";
  throw new Error("Windows SystemRoot is unavailable for Native Messaging registry access.");
}

function windowsRegistryReadEnvironment(env = process.env) {
  const entries = {
    SystemRoot: env?.SystemRoot || env?.SYSTEMROOT,
    WINDIR: env?.WINDIR || env?.SystemRoot || env?.SYSTEMROOT,
    USERPROFILE: env?.USERPROFILE,
    LOCALAPPDATA: env?.LOCALAPPDATA,
    TEMP: env?.TEMP,
    TMP: env?.TMP,
    [REGISTRY_SUBKEY_ENV_KEY]: WINDOWS_NATIVE_MESSAGING_REGISTRY_SUBKEY,
  };
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => typeof value === "string" && value.length > 0));
}

function requireAbsolute(value, label) {
  if (typeof value !== "string" || !value || !path.win32.isAbsolute(value)) throw new Error(`${label} must be an absolute Windows path.`);
  return path.win32.normalize(value);
}

function sameWindowsPath(left, right) {
  return typeof left === "string"
    && typeof right === "string"
    && path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase();
}

async function assertNormalFile(filePath, label, fsImpl = fs) {
  const stat = await fsImpl.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a normal, non-symlink file.`);
}

async function ensureNormalDirectory(directory, fsImpl = fs) {
  await fsImpl.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fsImpl.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Windows Native Messaging manifest root is unsafe.");
}

export function windowsNativeMessagingLauncherPath(releaseDir) {
  const releaseRoot = requireAbsolute(releaseDir, "Windows release directory");
  return path.win32.join(releaseRoot, "runtime", "browser", "equinox-browser-native-host.exe");
}

export function windowsNativeMessagingManifest(launcherPath) {
  const executable = requireAbsolute(launcherPath, "Windows Native Messaging launcher");
  return `${JSON.stringify({
    name: EQUINOX_BROWSER_HOST_NAME,
    description: "Equinox Browser native messaging bridge",
    path: executable,
    type: "stdio",
    allowed_origins: [`chrome-extension://${EQUINOX_BROWSER_EXTENSION_ID}/`],
  }, null, 2)}\n`;
}

async function readManifestState(manifestPath, {
  launcherPath,
  expectedPreviousLauncherPath = null,
  fsImpl = fs,
} = {}) {
  let current;
  try {
    current = await readBoundedNormalFile(manifestPath, {
      fsImpl,
      platform: process.platform,
      maxBytes: MANIFEST_MAX_BYTES,
      encoding: "utf8",
      label: "Windows Native Messaging manifest",
    });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const data = current.data;
  const sha256 = createHash("sha256").update(data, "utf8").digest("hex");
  if (data === windowsNativeMessagingManifest(launcherPath)) {
    return Object.freeze({ kind: "desired", sha256 });
  }
  if (expectedPreviousLauncherPath && data === windowsNativeMessagingManifest(expectedPreviousLauncherPath)) {
    return Object.freeze({ kind: "previous", sha256 });
  }
  throw new Error("Windows Native Messaging manifest is foreign or malformed; refusing to overwrite it.");
}

export async function readWindowsNativeMessagingRegistryValue({
  execFileAsync = execFile,
  env = process.env,
} = {}) {
  const { stdout } = await execFileAsync(windowsPowerShellPath(env), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", READ_REGISTRY_SCRIPT,
  ], {
    timeout: 15_000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
    env: windowsRegistryReadEnvironment(env),
  });
  const output = String(stdout).trim();
  if (output === "missing") return null;
  if (!output.startsWith("value:")) {
    throw new Error("Windows Native Messaging registry default value is malformed.");
  }
  const hex = output.slice("value:".length);
  if (!hex || hex.length % 2 !== 0 || !/^[0-9A-F]+$/u.test(hex)) {
    throw new Error("Windows Native Messaging registry default value is malformed.");
  }
  const decoded = Buffer.from(hex, "hex").toString("utf8");
  if (!decoded) throw new Error("Windows Native Messaging registry default value is malformed.");
  return path.win32.normalize(decoded);
}

export async function assertWindowsNativeMessagingHostOwnership({
  manifestRoot,
  acceptedLauncherPaths,
  execFileAsync = execFile,
  fsImpl = fs,
  env = process.env,
} = {}) {
  if (typeof manifestRoot !== "string" || !manifestRoot) throw new Error("Windows Native Messaging manifest root is required.");
  if (!Array.isArray(acceptedLauncherPaths) || acceptedLauncherPaths.length < 1 || acceptedLauncherPaths.length > 2) {
    throw new Error("Windows Native Messaging ownership check requires one or two accepted launchers.");
  }
  const accepted = acceptedLauncherPaths.map((value) => requireAbsolute(value, "Accepted Windows Native Messaging launcher"));
  const manifestPath = path.join(manifestRoot, `${EQUINOX_BROWSER_HOST_NAME}.json`);
  const registered = await readWindowsNativeMessagingRegistryValue({ execFileAsync, env });
  if (registered === null) throw new Error("Windows Native Messaging registry ownership is missing during managed update.");
  if (!sameWindowsPath(registered, manifestPath)) {
    throw new Error(`Windows Native Messaging registry is owned by another manifest: ${registered}`);
  }
  const { data } = await readBoundedNormalFile(manifestPath, {
    fsImpl,
    platform: process.platform,
    maxBytes: MANIFEST_MAX_BYTES,
    encoding: "utf8",
    label: "Windows Native Messaging manifest",
  });
  const matched = accepted.find((launcherPath) => data === windowsNativeMessagingManifest(launcherPath));
  if (!matched) throw new Error("Windows Native Messaging manifest is foreign or outside the accepted update ownership set.");
  return Object.freeze({ manifestPath, launcherPath: matched, registryKey: EQUINOX_BROWSER_WINDOWS_REGISTRY_KEY });
}

export async function registerWindowsNativeMessagingHost({
  manifestRoot,
  launcherPath,
  expectedPreviousLauncherPath = null,
  execFileAsync = execFile,
  fsImpl = fs,
  env = process.env,
  verifyLauncher = true,
} = {}) {
  if (typeof manifestRoot !== "string" || !manifestRoot) throw new Error("Windows Native Messaging manifest root is required.");
  const executable = requireAbsolute(launcherPath, "Windows Native Messaging launcher");
  const previousExecutable = expectedPreviousLauncherPath === null
    ? null
    : requireAbsolute(expectedPreviousLauncherPath, "Expected previous Windows Native Messaging launcher");
  if (previousExecutable && sameWindowsPath(previousExecutable, executable)) {
    throw new Error("Expected previous Windows Native Messaging launcher must differ from the desired launcher.");
  }
  if (verifyLauncher) await assertNormalFile(executable, "Windows Native Messaging launcher", fsImpl);
  await ensureNormalDirectory(manifestRoot, fsImpl);

  const manifestPath = path.join(manifestRoot, `${EQUINOX_BROWSER_HOST_NAME}.json`);
  const registered = await readWindowsNativeMessagingRegistryValue({ execFileAsync, env });
  if (registered !== null && !sameWindowsPath(registered, manifestPath)) {
    throw new Error(`Windows Native Messaging registry is owned by another manifest: ${registered}`);
  }

  const manifestState = await readManifestState(manifestPath, {
    launcherPath: executable,
    expectedPreviousLauncherPath: previousExecutable,
    fsImpl,
  });
  if (registered !== null && manifestState === null) {
    throw new Error("Windows Native Messaging registry points to a missing manifest; refusing to repair ambiguous ownership.");
  }

  let manifestChanged = false;
  if (manifestState === null || manifestState.kind === "previous") {
    await writeBoundedUtf8File(manifestPath, {
      content: windowsNativeMessagingManifest(executable),
      ...(manifestState ? { expectedSha256: manifestState.sha256 } : {}),
      fsImpl,
      maxBytes: MANIFEST_MAX_BYTES,
      maxExistingBytes: MANIFEST_MAX_BYTES,
      label: "Windows Native Messaging manifest",
    });
    manifestChanged = true;
  }

  let registryChanged = false;
  if (registered === null) {
    const beforeMutation = await readWindowsNativeMessagingRegistryValue({ execFileAsync, env });
    if (beforeMutation !== null) {
      if (!sameWindowsPath(beforeMutation, manifestPath)) {
        throw new Error(`Windows Native Messaging registry changed to another owner before registration: ${beforeMutation}`);
      }
      const concurrentManifest = await readManifestState(manifestPath, { launcherPath: executable, fsImpl });
      if (!concurrentManifest || concurrentManifest.kind !== "desired") {
        throw new Error("Windows Native Messaging registration changed concurrently to an unexpected manifest.");
      }
    } else {
      await execFileAsync("reg.exe", [
        "ADD", EQUINOX_BROWSER_WINDOWS_REGISTRY_KEY, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f",
      ], { timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true, env });
      registryChanged = true;
    }
  }

  return Object.freeze({
    manifestPath,
    launcherPath: executable,
    registryKey: EQUINOX_BROWSER_WINDOWS_REGISTRY_KEY,
    manifestChanged,
    registryChanged,
    idempotent: !manifestChanged && !registryChanged,
  });
}

export async function unregisterWindowsNativeMessagingHost({
  manifestPath,
  launcherPath,
  execFileAsync = execFile,
  fsImpl = fs,
  env = process.env,
} = {}) {
  if (typeof manifestPath !== "string" || !manifestPath) throw new Error("Windows Native Messaging manifest path is required.");
  const expectedLauncher = requireAbsolute(launcherPath, "Windows Native Messaging launcher");
  const registered = await readWindowsNativeMessagingRegistryValue({ execFileAsync, env });
  const expected = path.win32.normalize(manifestPath);
  if (registered !== null && !sameWindowsPath(registered, expected)) {
    return Object.freeze({ removed: false, manifestRemoved: false, reason: "foreign-registry-owner", registeredPath: registered });
  }

  let manifestState;
  try {
    manifestState = await readManifestState(manifestPath, { launcherPath: expectedLauncher, fsImpl });
  } catch (error) {
    return Object.freeze({ removed: false, manifestRemoved: false, reason: "foreign-manifest" });
  }
  if (registered !== null && manifestState === null) {
    return Object.freeze({ removed: false, manifestRemoved: false, reason: "missing-manifest" });
  }
  if (manifestState === null) {
    return Object.freeze({ removed: false, manifestRemoved: false, reason: null });
  }

  if (registered !== null) {
    await execFileAsync("reg.exe", ["DELETE", EQUINOX_BROWSER_WINDOWS_REGISTRY_KEY, "/f"], {
      timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true, env,
    });
  }
  await fsImpl.rm(manifestPath, { force: false });
  return Object.freeze({ removed: registered !== null, manifestRemoved: true, reason: null });
}
