import { createHash, randomBytes } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  EQUINOX_LOCAL_APP_BUNDLE_ID,
  EQUINOX_LOCAL_APP_NAME,
  equinoxLocalAppPath,
  validateEquinoxLocalAppHost,
} from "./equinox-local-app-host.js";
import { equinoxLocalNativeAppArtifactPaths } from "./equinox-local-native-app.js";

const execFile = promisify(execFileCallback);
const NATIVE_SHELL_PLIST_KEY = "EquinoxLocalNativeShellVersion";
const NATIVE_EXECUTABLE_SHA_PLIST_KEY = "EquinoxLocalNativeExecutableSha256";

function homeDirFromInstallation(installation) {
  if (typeof installation?.installRoot !== "string") throw new Error("Managed installation root is required for native app synchronization.");
  const homeDir = path.resolve(installation.installRoot, "../../..");
  if (path.join(homeDir, "Library", "Application Support", "Equinox Local") !== path.resolve(installation.installRoot)) {
    throw new Error("Managed installation root cannot be mapped to the user home directory.");
  }
  return homeDir;
}

async function sha256File(filePath, fsImpl = fs) {
  const data = await fsImpl.readFile(filePath);
  return createHash("sha256").update(data).digest("hex");
}

async function assertNormalFile(filePath, label, fsImpl = fs) {
  const stat = await fsImpl.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} is not a safe normal file.`);
  return stat;
}

async function readNativeMetadata(releaseDir, fsImpl = fs) {
  const paths = equinoxLocalNativeAppArtifactPaths(releaseDir);
  const raw = JSON.parse(await fsImpl.readFile(paths.metadata, "utf8"));
  if (
    raw?.schemaVersion !== 1
    || !Number.isSafeInteger(raw?.shellVersion)
    || raw.shellVersion < 1
    || raw?.executable !== "applet"
    || raw?.icon !== "EquinoxLocal.png"
    || !/^[a-f0-9]{64}$/u.test(raw?.executableSha256 ?? "")
    || !/^[a-f0-9]{64}$/u.test(raw?.iconSha256 ?? "")
  ) {
    throw new Error("Equinox Local native app metadata is invalid.");
  }
  await assertNormalFile(paths.executable, "Equinox Local native executable", fsImpl);
  await assertNormalFile(paths.icon, "Equinox Local native icon", fsImpl);
  if (await sha256File(paths.executable, fsImpl) !== raw.executableSha256) throw new Error("Equinox Local native executable digest mismatch.");
  if (await sha256File(paths.icon, fsImpl) !== raw.iconSha256) throw new Error("Equinox Local native icon digest mismatch.");
  return Object.freeze({ paths, metadata: Object.freeze(raw) });
}

async function readBundleNativeShellVersion(appPath, execFileImpl = execFile) {
  try {
    const { stdout } = await execFileImpl("/usr/libexec/PlistBuddy", ["-c", `Print :${NATIVE_SHELL_PLIST_KEY}`, path.join(appPath, "Contents", "Info.plist")], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 16 * 1024,
    });
    const value = Number.parseInt(String(stdout).trim(), 10);
    return Number.isSafeInteger(value) ? value : null;
  } catch {
    return null;
  }
}

function nativeInfoPlist(shellVersion, executableSha256) {
  if (!Number.isSafeInteger(shellVersion) || shellVersion < 1) throw new Error("Equinox Local native shell version is invalid.");
  if (!/^[a-f0-9]{64}$/u.test(executableSha256 ?? "")) throw new Error("Equinox Local native executable digest is invalid.");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>CFBundleDevelopmentRegion</key><string>en</string>\n  <key>CFBundleDisplayName</key><string>${EQUINOX_LOCAL_APP_NAME}</string>\n  <key>CFBundleExecutable</key><string>applet</string>\n  <key>CFBundleIconFile</key><string>EquinoxLocal</string>\n  <key>CFBundleIdentifier</key><string>${EQUINOX_LOCAL_APP_BUNDLE_ID}</string>\n  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>\n  <key>CFBundleName</key><string>${EQUINOX_LOCAL_APP_NAME}</string>\n  <key>CFBundlePackageType</key><string>APPL</string>\n  <key>CFBundleShortVersionString</key><string>${shellVersion}</string>\n  <key>CFBundleVersion</key><string>${shellVersion}</string>\n  <key>LSMinimumSystemVersion</key><string>13.0</string>\n  <key>${NATIVE_SHELL_PLIST_KEY}</key><integer>${shellVersion}</integer>\n  <key>${NATIVE_EXECUTABLE_SHA_PLIST_KEY}</key><string>${executableSha256}</string>\n  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>\n  <key>NSHighResolutionCapable</key><true/>\n</dict>\n</plist>\n`;
}

async function createIcns(sourcePng, destination, workingRoot, execFileImpl = execFile, fsImpl = fs) {
  const iconset = path.join(workingRoot, "EquinoxLocal.iconset");
  await fsImpl.mkdir(iconset, { recursive: true, mode: 0o700 });
  const sizes = [
    [16, "icon_16x16.png"], [32, "icon_16x16@2x.png"],
    [32, "icon_32x32.png"], [64, "icon_32x32@2x.png"],
    [128, "icon_128x128.png"], [256, "icon_128x128@2x.png"],
    [256, "icon_256x256.png"], [512, "icon_256x256@2x.png"],
    [512, "icon_512x512.png"], [1024, "icon_512x512@2x.png"],
  ];
  for (const [size, name] of sizes) {
    await execFileImpl("/usr/bin/sips", ["-z", String(size), String(size), sourcePng, "--out", path.join(iconset, name)], {
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
  }
  await execFileImpl("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", destination], {
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  await fsImpl.rm(iconset, { recursive: true, force: true });
}

function legacyBackupPath(homeDir) {
  return path.join(homeDir, "Library", "Application Support", "Equinox Local", "app-host-backup", "legacy-applescript.app");
}

async function backupLegacyAppIfNeeded(appPath, homeDir, { fsImpl = fs, execFileImpl = execFile } = {}) {
  const nativeVersion = await readBundleNativeShellVersion(appPath, execFileImpl);
  if (nativeVersion !== null) return null;
  const backup = legacyBackupPath(homeDir);
  try {
    const stat = await fsImpl.lstat(backup);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Equinox Local legacy app backup is unsafe.");
    return backup;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await fsImpl.mkdir(path.dirname(backup), { recursive: true, mode: 0o700 });
  await fsImpl.cp(appPath, backup, { recursive: true, dereference: false, errorOnExist: true });
  await validateEquinoxLocalAppHost(backup, { fsImpl, execFileImpl });
  return backup;
}

async function atomicReplaceApp(appPath, replacement, fsImpl = fs) {
  const previous = `${appPath}.previous-${process.pid}-${randomBytes(6).toString("hex")}`;
  let movedPrevious = false;
  try {
    try {
      await fsImpl.rename(appPath, previous);
      movedPrevious = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await fsImpl.rename(replacement, appPath);
    if (movedPrevious) await fsImpl.rm(previous, { recursive: true, force: true });
  } catch (error) {
    await fsImpl.rm(appPath, { recursive: true, force: true }).catch(() => {});
    if (movedPrevious) await fsImpl.rename(previous, appPath).catch(() => {});
    throw error;
  }
}

export async function synchronizeEquinoxLocalNativeAppHost({
  homeDir,
  releaseDir,
  fsImpl = fs,
  execFileImpl = execFile,
} = {}) {
  if (process.platform !== "darwin") throw new Error("Equinox Local native app synchronization is supported only on macOS.");
  if (typeof homeDir !== "string" || !path.isAbsolute(homeDir)) throw new Error("A trusted user home directory is required for native app synchronization.");
  const { paths, metadata } = await readNativeMetadata(releaseDir, fsImpl);
  const appPath = equinoxLocalAppPath(homeDir);

  try {
    await validateEquinoxLocalAppHost(appPath, { fsImpl, execFileImpl });
    const shellVersion = await readBundleNativeShellVersion(appPath, execFileImpl);
    if (shellVersion === metadata.shellVersion) {
      const installedExecutable = path.join(appPath, "Contents", "MacOS", "applet");
      try {
        await execFileImpl("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath], {
          timeout: 15_000,
          maxBuffer: 1024 * 1024,
        });
        // The stable native app is a macOS permission identity, not a release payload.
        // Preserve a valid installed bundle byte-for-byte until shellVersion explicitly changes.
        return Object.freeze({ appPath, executablePath: installedExecutable, shellVersion, changed: false, migratedLegacy: false });
      } catch {
        // Repair only a genuinely invalid installed bundle. Ordinary release/runtime changes must not re-sign it.
      }
    }
    await backupLegacyAppIfNeeded(appPath, homeDir, { fsImpl, execFileImpl });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const applicationsRoot = path.join(homeDir, "Applications");
  await fsImpl.mkdir(applicationsRoot, { recursive: true, mode: 0o700 });
  const temporary = path.join(applicationsRoot, `.Equinox-Local-native-${process.pid}-${randomBytes(8).toString("hex")}.app`);
  const contents = path.join(temporary, "Contents");
  const macos = path.join(contents, "MacOS");
  const resources = path.join(contents, "Resources");
  try {
    await fsImpl.mkdir(macos, { recursive: true, mode: 0o700 });
    await fsImpl.mkdir(resources, { recursive: true, mode: 0o700 });
    await fsImpl.copyFile(paths.executable, path.join(macos, "applet"));
    await fsImpl.chmod(path.join(macos, "applet"), 0o755);
    await createIcns(paths.icon, path.join(resources, "EquinoxLocal.icns"), contents, execFileImpl, fsImpl);
    await fsImpl.writeFile(path.join(contents, "Info.plist"), nativeInfoPlist(metadata.shellVersion, metadata.executableSha256), { mode: 0o644 });
    await execFileImpl("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", EQUINOX_LOCAL_APP_BUNDLE_ID, temporary], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    await execFileImpl("/usr/bin/codesign", ["--verify", "--deep", "--strict", temporary], { timeout: 15_000, maxBuffer: 1024 * 1024 });
    await validateEquinoxLocalAppHost(temporary, { fsImpl, execFileImpl });
    await atomicReplaceApp(appPath, temporary, fsImpl);
  } catch (error) {
    await fsImpl.rm(temporary, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return Object.freeze({ appPath, executablePath: path.join(appPath, "Contents", "MacOS", "applet"), shellVersion: metadata.shellVersion, changed: true, migratedLegacy: true });
}

export async function restoreLegacyEquinoxLocalAppHost({ homeDir, fsImpl = fs, execFileImpl = execFile } = {}) {
  const backup = legacyBackupPath(homeDir);
  const backupStat = await fsImpl.lstat(backup);
  if (!backupStat.isDirectory() || backupStat.isSymbolicLink()) throw new Error("Equinox Local legacy app backup is unavailable or unsafe.");
  await validateEquinoxLocalAppHost(backup, { fsImpl, execFileImpl });
  const appPath = equinoxLocalAppPath(homeDir);
  const replacement = `${appPath}.legacy-${process.pid}-${randomBytes(8).toString("hex")}`;
  await fsImpl.cp(backup, replacement, { recursive: true, dereference: false, errorOnExist: true });
  await atomicReplaceApp(appPath, replacement, fsImpl);
  return Object.freeze({ appPath, executablePath: path.join(appPath, "Contents", "MacOS", "applet"), restored: true });
}

export async function synchronizeEquinoxLocalAppHostForRelease({
  installation,
  releaseDir,
  fsImpl = fs,
  execFileImpl = execFile,
} = {}) {
  const homeDir = homeDirFromInstallation(installation);
  try {
    return await synchronizeEquinoxLocalNativeAppHost({ homeDir, releaseDir, fsImpl, execFileImpl });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    try {
      return await restoreLegacyEquinoxLocalAppHost({ homeDir, fsImpl, execFileImpl });
    } catch (restoreError) {
      if (restoreError?.code === "ENOENT") return Object.freeze({ appPath: equinoxLocalAppPath(homeDir), changed: false, legacy: true });
      throw restoreError;
    }
  }
}
