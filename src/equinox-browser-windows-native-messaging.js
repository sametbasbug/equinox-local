import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { EQUINOX_BROWSER_EXTENSION_ID, EQUINOX_BROWSER_HOST_NAME } from "./equinox-browser-bridge.js";
import { readBoundedNormalFile, writeBoundedUtf8File } from "./equinox-local-safe-file.js";

const execFile = promisify(execFileCallback);
export const EQUINOX_BROWSER_WINDOWS_REGISTRY_KEY = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${EQUINOX_BROWSER_HOST_NAME}`;
const REGISTRY_ENV_KEY = "EQUINOX_BROWSER_NATIVE_HOST_REGISTRY_KEY";
const READ_REGISTRY_SCRIPT = [
  "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
  "$key = Get-Item -LiteralPath ('Registry::' + $env:EQUINOX_BROWSER_NATIVE_HOST_REGISTRY_KEY) -ErrorAction SilentlyContinue",
  "if ($null -eq $key) { 'null' } else { $key.GetValue('') | ConvertTo-Json -Compress }",
].join("; ");

function requireAbsolute(value, label) {
  if (typeof value !== "string" || !value || !path.win32.isAbsolute(value)) throw new Error(`${label} must be an absolute Windows path.`);
  return path.win32.normalize(value);
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

export async function readWindowsNativeMessagingRegistryValue({
  execFileAsync = execFile,
  env = process.env,
} = {}) {
  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", READ_REGISTRY_SCRIPT,
    ], {
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
      env: { ...env, [REGISTRY_ENV_KEY]: EQUINOX_BROWSER_WINDOWS_REGISTRY_KEY },
    });
    const parsed = JSON.parse(String(stdout).trim() || "null");
    return typeof parsed === "string" && parsed ? path.win32.normalize(parsed) : null;
  } catch (error) {
    throw error;
  }
}

export async function registerWindowsNativeMessagingHost({
  manifestRoot,
  launcherPath,
  execFileAsync = execFile,
  fsImpl = fs,
  env = process.env,
  verifyLauncher = true,
} = {}) {
  if (typeof manifestRoot !== "string" || !manifestRoot) throw new Error("Windows Native Messaging manifest root is required.");
  const executable = requireAbsolute(launcherPath, "Windows Native Messaging launcher");
  if (verifyLauncher) await assertNormalFile(executable, "Windows Native Messaging launcher", fsImpl);
  await ensureNormalDirectory(manifestRoot, fsImpl);

  const manifestPath = path.join(manifestRoot, `${EQUINOX_BROWSER_HOST_NAME}.json`);
  const content = windowsNativeMessagingManifest(executable);
  let expectedSha256;
  try {
    const current = await readBoundedNormalFile(manifestPath, { fsImpl, platform: process.platform, maxBytes: 16 * 1024, label: "Windows Native Messaging manifest" });
    expectedSha256 = createHash("sha256").update(current.data).digest("hex");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await writeBoundedUtf8File(manifestPath, {
    content,
    ...(expectedSha256 ? { expectedSha256 } : {}),
    fsImpl,
    maxBytes: 16 * 1024,
    maxExistingBytes: 16 * 1024,
    label: "Windows Native Messaging manifest",
  });

  await execFileAsync("reg.exe", [
    "ADD", EQUINOX_BROWSER_WINDOWS_REGISTRY_KEY, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f",
  ], { timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true, env });

  return Object.freeze({ manifestPath, launcherPath: executable, registryKey: EQUINOX_BROWSER_WINDOWS_REGISTRY_KEY });
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
  if (registered !== null && registered.toLowerCase() !== expected.toLowerCase()) {
    return Object.freeze({ removed: false, reason: "foreign-registry-owner", registeredPath: registered });
  }
  if (registered !== null) {
    await execFileAsync("reg.exe", ["DELETE", EQUINOX_BROWSER_WINDOWS_REGISTRY_KEY, "/f"], {
      timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true, env,
    });
  }
  try {
    const stat = await fsImpl.lstat(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return Object.freeze({ removed: registered !== null, manifestRemoved: false, reason: "unsafe-manifest" });
    const raw = await readBoundedNormalFile(manifestPath, { fsImpl, platform: process.platform, maxBytes: 16 * 1024, encoding: "utf8", label: "Windows Native Messaging manifest" });
    const parsed = JSON.parse(raw.data);
    if (
      parsed?.name !== EQUINOX_BROWSER_HOST_NAME
      || typeof parsed?.path !== "string"
      || path.win32.normalize(parsed.path).toLowerCase() !== expectedLauncher.toLowerCase()
    ) {
      return Object.freeze({ removed: registered !== null, manifestRemoved: false, reason: "foreign-manifest" });
    }
    await fsImpl.rm(manifestPath, { force: false });
    return Object.freeze({ removed: registered !== null, manifestRemoved: true, reason: null });
  } catch (error) {
    if (error?.code === "ENOENT") return Object.freeze({ removed: registered !== null, manifestRemoved: false, reason: null });
    throw error;
  }
}
