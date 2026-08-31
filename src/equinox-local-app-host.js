import { execFile as execFileCallback } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export const EQUINOX_LOCAL_APP_NAME = "Equinox Local";
export const EQUINOX_LOCAL_APP_BUNDLE_ID = "dev.equinox.local";

export function equinoxLocalAppPath(homeDir = os.homedir()) {
  return path.join(homeDir, "Applications", `${EQUINOX_LOCAL_APP_NAME}.app`);
}

export function equinoxLocalAppExecutablePath(homeDir = os.homedir()) {
  return path.join(equinoxLocalAppPath(homeDir), "Contents", "MacOS", "applet");
}

export function equinoxLocalAppRuntimeWrapperPath(homeDir = os.homedir()) {
  return path.join(homeDir, "Library", "Application Support", "Equinox Local", "equinox-local-app-runtime");
}

export function equinoxLocalAppAppleScript() {
  return `on run\n  set homePath to POSIX path of (path to home folder)\n  set runnerPath to homePath & "Library/Application Support/Equinox Local/equinox-local-app-runtime"\n  do shell script quoted form of runnerPath\nend run\n`;
}

async function ensureDirectory(directory, mode = 0o700, fsImpl = fs) {
  await fsImpl.mkdir(directory, { recursive: true, mode });
  const stat = await fsImpl.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Equinox Local app host directory is unsafe.");
}

async function readBundleId(infoPlist, execFileImpl) {
  const { stdout } = await execFileImpl("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", infoPlist], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 16 * 1024,
  });
  return String(stdout).trim();
}

export async function validateEquinoxLocalAppHost(appPath, { fsImpl = fs, execFileImpl = execFile } = {}) {
  const stat = await fsImpl.lstat(appPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Existing Equinox Local.app is not a safe app bundle.");
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (Number.isInteger(uid) && Number.isInteger(stat.uid) && stat.uid !== uid) {
    throw new Error("Existing Equinox Local.app is not owned by the current user.");
  }
  const executable = path.join(appPath, "Contents", "MacOS", "applet");
  const executableStat = await fsImpl.lstat(executable);
  if (!executableStat.isFile() || executableStat.isSymbolicLink()) throw new Error("Existing Equinox Local.app executable is unsafe.");
  const infoPlist = path.join(appPath, "Contents", "Info.plist");
  const bundleId = await readBundleId(infoPlist, execFileImpl);
  if (bundleId !== EQUINOX_LOCAL_APP_BUNDLE_ID) throw new Error("Existing Equinox Local.app has an unexpected bundle identifier.");
  return Object.freeze({ appPath, executablePath: executable, created: false });
}

async function plutilReplaceOrInsert(infoPlist, key, type, value, execFileImpl) {
  try {
    await execFileImpl("/usr/bin/plutil", ["-replace", key, `-${type}`, String(value), infoPlist], { timeout: 10_000 });
  } catch {
    await execFileImpl("/usr/bin/plutil", ["-insert", key, `-${type}`, String(value), infoPlist], { timeout: 10_000 });
  }
}

export async function ensureEquinoxLocalAppHost({
  homeDir = os.homedir(),
  fsImpl = fs,
  execFileImpl = execFile,
} = {}) {
  if (process.platform !== "darwin") throw new Error("Equinox Local.app host is supported only on macOS.");
  const applicationsRoot = path.join(homeDir, "Applications");
  await ensureDirectory(applicationsRoot, 0o700, fsImpl);
  const appPath = equinoxLocalAppPath(homeDir);
  try {
    return await validateEquinoxLocalAppHost(appPath, { fsImpl, execFileImpl });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const temporary = path.join(applicationsRoot, `.Equinox-Local-${process.pid}-${randomBytes(8).toString("hex")}.app`);
  try {
    await execFileImpl("/usr/bin/osacompile", ["-o", temporary, "-e", equinoxLocalAppAppleScript()], {
      timeout: 30_000,
      maxBuffer: 128 * 1024,
    });
    const infoPlist = path.join(temporary, "Contents", "Info.plist");
    await plutilReplaceOrInsert(infoPlist, "CFBundleIdentifier", "string", EQUINOX_LOCAL_APP_BUNDLE_ID, execFileImpl);
    await plutilReplaceOrInsert(infoPlist, "CFBundleName", "string", EQUINOX_LOCAL_APP_NAME, execFileImpl);
    await plutilReplaceOrInsert(infoPlist, "CFBundleDisplayName", "string", EQUINOX_LOCAL_APP_NAME, execFileImpl);
    await plutilReplaceOrInsert(infoPlist, "LSUIElement", "bool", "true", execFileImpl);
    await execFileImpl("/usr/bin/codesign", ["--force", "--sign", "-", temporary], {
      timeout: 30_000,
      maxBuffer: 128 * 1024,
    });
    await fsImpl.rename(temporary, appPath);
  } catch (error) {
    await fsImpl.rm(temporary, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return validateEquinoxLocalAppHost(appPath, { fsImpl, execFileImpl }).then((result) => Object.freeze({ ...result, created: true }));
}
