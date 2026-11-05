import { createHash, randomBytes } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { list as listTar } from "tar";

import {
  EQUINOX_LOCAL_APP_BUNDLE_ID,
  EQUINOX_LOCAL_APP_NAME,
  equinoxLocalAppPath,
  validateEquinoxLocalAppHost,
} from "./equinox-local-app-host.js";
import { equinoxLocalNativeAppArtifactPaths, validateEquinoxLocalDesktopAppMetadata, type DesktopAppMetadata } from "./equinox-local-native-app.js";
import { extractDesktopBundle, sealDesktopBundle } from "./equinox-local-desktop-bundle.js";
import { fingerprintEquinoxLocalNativeState } from "./equinox-local-native-state-fingerprint.js";
import { readBoundedNormalFile } from "./equinox-local-safe-file.js";

const execFile = promisify(execFileCallback);
type HostFs = typeof fs;
export type NativeHostExec = typeof execFile;
type HostExec = NativeHostExec;
type HostOptions = {fsImpl?:HostFs;execFileImpl?:HostExec|undefined};
type HostPaths = HostOptions & {homeDir?:string|undefined; releaseDir?:string|undefined};
type SnapshotPaths = HostOptions & {homeDir?:string|undefined; snapshotPath?:string|undefined};
type InspectPaths = HostOptions & {snapshotPath?:string|undefined};
type ReleaseSync = HostPaths & {installation?:unknown;requirePayloadIdentity?:boolean};
type NativeMetadata = {
  shellVersion:number;target:string;executable:string;icon:string;
  executableSha256:string;iconSha256:string;
  menuIcon?:string;menuIconSha256?:string;companionAsset?:string;companionAssetSha256?:string;
};
function hasErrorCode(error:unknown,code:string):boolean {
  return error!==null&&typeof error==="object"&&"code" in error&&error.code===code;
}
function isRecord(value:unknown):value is Record<string,unknown> {
  return value!==null&&typeof value==="object"&&!Array.isArray(value);
}

const NATIVE_SHELL_PLIST_KEY = "EquinoxLocalNativeShellVersion";
const NATIVE_EXECUTABLE_SHA_PLIST_KEY = "EquinoxLocalNativeExecutableSha256";
const NATIVE_PAYLOAD_SHA_PLIST_KEY = "EquinoxLocalNativePayloadSha256";
const NATIVE_PERMISSION_IDENTITY_PLIST_KEY = "EquinoxLocalPermissionIdentity";
const NATIVE_PERMISSION_IDENTITY_VERSION = "v1";

// Public/source installs intentionally use ad-hoc signing instead of a paid Developer ID.
// Without an explicit designated requirement, macOS derives a CDHash-only identity and
// invalidates TCC grants whenever the native shell binary changes. Keep this requirement
// stable across shell versions; release authenticity remains enforced by the existing
// signed release/update pipeline rather than by this local permission identity.
export function nativePermissionIdentityInfoPlist(): Readonly<Record<string, string>> {
  return Object.freeze({ [NATIVE_PERMISSION_IDENTITY_PLIST_KEY]: NATIVE_PERMISSION_IDENTITY_VERSION });
}

export function nativePermissionDesignatedRequirementSource() {
  return `designated => identifier "${EQUINOX_LOCAL_APP_BUNDLE_ID}" and info[${NATIVE_PERMISSION_IDENTITY_PLIST_KEY}] = "${NATIVE_PERMISSION_IDENTITY_VERSION}"`;
}

function normalizedNativePermissionDesignatedRequirement() {
  return `designated => identifier "${EQUINOX_LOCAL_APP_BUNDLE_ID}" and info[${NATIVE_PERMISSION_IDENTITY_PLIST_KEY}] = ${NATIVE_PERMISSION_IDENTITY_VERSION}`;
}

function homeDirFromInstallation(installation:unknown):string {
  if (!isRecord(installation) || typeof installation.installRoot !== "string") throw new Error("Managed installation root is required for native app synchronization.");
  const homeDir = path.resolve(installation.installRoot, "../../..");
  if (path.join(homeDir, "Library", "Application Support", "Equinox Local") !== path.resolve(installation.installRoot)) {
    throw new Error("Managed installation root cannot be mapped to the user home directory.");
  }
  return homeDir;
}

async function sha256File(filePath:string, fsImpl:HostFs = fs):Promise<string> {
  const data = await fsImpl.readFile(filePath);
  return createHash("sha256").update(data).digest("hex");
}

async function assertNormalFile(filePath:string,label:string, fsImpl:HostFs = fs) {
  const stat = await fsImpl.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} is not a safe normal file.`);
  return stat;
}

function nativePayloadIdentity(metadata:NativeMetadata):string {
  const digest = createHash("sha256");
  digest.update("equinox-local-native-app-payload-v1\0");
  for (const value of [
    metadata.shellVersion,
    metadata.target,
    metadata.executableSha256,
    metadata.iconSha256,
    metadata.menuIconSha256 ?? "",
    metadata.companionAssetSha256 ?? "",
  ]) digest.update(`${String(value)}\0`);
  return digest.digest("hex");
}

async function readNativeMetadata(releaseDir:string, fsImpl:HostFs = fs) {
  const paths = equinoxLocalNativeAppArtifactPaths(releaseDir);
  const raw:unknown = JSON.parse(await fsImpl.readFile(paths.metadata, "utf8"));
  if (
    !isRecord(raw) || raw.schemaVersion !== 1
    || typeof raw.shellVersion !== "number" || !Number.isSafeInteger(raw.shellVersion)
    || raw.shellVersion < 1
    || typeof raw.target !== "string" || !["darwin-arm64", "darwin-x64"].includes(raw.target)
    || raw.executable !== "applet"
    || raw.icon !== "EquinoxLocal.png"
    || typeof raw.executableSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(raw.executableSha256)
    || typeof raw.iconSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(raw.iconSha256)
    || (raw.shellVersion >= 4 && raw?.menuIcon !== "EquinoxLocalMenuBar.png")
    || (raw.shellVersion >= 4 && (typeof raw.menuIconSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(raw.menuIconSha256)))
    || (raw.shellVersion >= 11 && raw?.companionAsset !== "EquinoxCompanionNyx.webp")
    || (raw.shellVersion >= 11 && (typeof raw.companionAssetSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(raw.companionAssetSha256)))
  ) {
    throw new Error("Equinox Local native app metadata is invalid.");
  }
  const metadata = raw as NativeMetadata;
  await assertNormalFile(paths.executable, "Equinox Local native executable", fsImpl);
  await assertNormalFile(paths.icon, "Equinox Local native icon", fsImpl);
  if (raw.shellVersion >= 4) await assertNormalFile(paths.menuIcon, "Equinox Local native menu-bar icon", fsImpl);
  if (raw.shellVersion >= 11) await assertNormalFile(paths.companionAsset, "Equinox Local companion asset", fsImpl);
  if (await sha256File(paths.executable, fsImpl) !== raw.executableSha256) throw new Error("Equinox Local native executable digest mismatch.");
  if (await sha256File(paths.icon, fsImpl) !== raw.iconSha256) throw new Error("Equinox Local native icon digest mismatch.");
  if (raw.shellVersion >= 4 && await sha256File(paths.menuIcon, fsImpl) !== raw.menuIconSha256) throw new Error("Equinox Local native menu-bar icon digest mismatch.");
  if (raw.shellVersion >= 11 && await sha256File(paths.companionAsset, fsImpl) !== raw.companionAssetSha256) throw new Error("Equinox Local companion asset digest mismatch.");
  return Object.freeze({ paths, metadata: Object.freeze(metadata) });
}

async function readBundleNativeShellVersion(appPath:string,execFileImpl:HostExec = execFile) {
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

async function readBundleNativePayloadIdentity(appPath:string,execFileImpl:HostExec = execFile) {
  try {
    const { stdout } = await execFileImpl("/usr/libexec/PlistBuddy", ["-c", `Print :${NATIVE_PAYLOAD_SHA_PLIST_KEY}`, path.join(appPath, "Contents", "Info.plist")], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 16 * 1024,
    });
    const value = String(stdout).trim();
    return /^[a-f0-9]{64}$/u.test(value) ? value : null;
  } catch {
    return null;
  }
}

async function readBundlePermissionIdentity(appPath:string,execFileImpl:HostExec = execFile) {
  try {
    const { stdout } = await execFileImpl("/usr/libexec/PlistBuddy", ["-c", `Print :${NATIVE_PERMISSION_IDENTITY_PLIST_KEY}`, path.join(appPath, "Contents", "Info.plist")], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 16 * 1024,
    });
    return String(stdout).trim();
  } catch {
    return null;
  }
}

async function readBundleDesignatedRequirement(appPath:string,execFileImpl:HostExec = execFile) {
  try {
    const { stdout = "", stderr = "" } = await execFileImpl("/usr/bin/codesign", ["-d", "-r-", appPath], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    return `${stdout}\n${stderr}`.split(/\r?\n/u).map((line) => line.trim()).find((line) => line.startsWith("designated =>")) ?? null;
  } catch {
    return null;
  }
}

async function hasStableNativePermissionIdentity(appPath:string,execFileImpl:HostExec = execFile) {
  const permissionIdentity = await readBundlePermissionIdentity(appPath, execFileImpl);
  if (permissionIdentity !== NATIVE_PERMISSION_IDENTITY_VERSION) return false;
  const designatedRequirement = await readBundleDesignatedRequirement(appPath, execFileImpl);
  return designatedRequirement === normalizedNativePermissionDesignatedRequirement();
}

function nativeInfoPlist(shellVersion:number,executableSha256:string,payloadSha256:string):string {
  if (!Number.isSafeInteger(shellVersion) || shellVersion < 1) throw new Error("Equinox Local native shell version is invalid.");
  if (!/^[a-f0-9]{64}$/u.test(executableSha256 ?? "")) throw new Error("Equinox Local native executable digest is invalid.");
  if (!/^[a-f0-9]{64}$/u.test(payloadSha256 ?? "")) throw new Error("Equinox Local native payload digest is invalid.");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>CFBundleDevelopmentRegion</key><string>en</string>\n  <key>CFBundleDisplayName</key><string>${EQUINOX_LOCAL_APP_NAME}</string>\n  <key>CFBundleExecutable</key><string>applet</string>\n  <key>CFBundleIconFile</key><string>EquinoxLocal</string>\n  <key>CFBundleIdentifier</key><string>${EQUINOX_LOCAL_APP_BUNDLE_ID}</string>\n  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>\n  <key>CFBundleName</key><string>${EQUINOX_LOCAL_APP_NAME}</string>\n  <key>CFBundlePackageType</key><string>APPL</string>\n  <key>CFBundleShortVersionString</key><string>${shellVersion}</string>\n  <key>CFBundleVersion</key><string>${shellVersion}</string>\n  <key>LSMinimumSystemVersion</key><string>13.0</string>\n  <key>${NATIVE_SHELL_PLIST_KEY}</key><integer>${shellVersion}</integer>\n  <key>${NATIVE_EXECUTABLE_SHA_PLIST_KEY}</key><string>${executableSha256}</string>\n  <key>${NATIVE_PAYLOAD_SHA_PLIST_KEY}</key><string>${payloadSha256}</string>\n  <key>${NATIVE_PERMISSION_IDENTITY_PLIST_KEY}</key><string>${NATIVE_PERMISSION_IDENTITY_VERSION}</string>\n  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>\n  <key>NSHighResolutionCapable</key><true/>\n</dict>\n</plist>\n`;
}

export async function createIcns(sourcePng:string,destination:string,workingRoot:string,execFileImpl:HostExec = execFile,fsImpl:HostFs = fs) {
  const iconset = path.join(workingRoot, "EquinoxLocal.iconset");
  await fsImpl.mkdir(iconset, { recursive: true, mode: 0o700 });
  const sizes: readonly (readonly [number,string])[] = [
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

function legacyBackupPath(homeDir:string) {
  return path.join(homeDir, "Library", "Application Support", "Equinox Local", "app-host-backup", "legacy-applescript.app");
}

async function backupLegacyAppIfNeeded(appPath:string,homeDir:string,{fsImpl=fs,execFileImpl=execFile}:HostOptions = {}) {
  const nativeVersion = await readBundleNativeShellVersion(appPath, execFileImpl);
  if (nativeVersion !== null) return null;
  const backup = legacyBackupPath(homeDir!);
  try {
    const stat = await fsImpl.lstat(backup);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Equinox Local legacy app backup is unsafe.");
    return backup;
  } catch (error) {
    if (!hasErrorCode(error,"ENOENT")) throw error;
  }
  await fsImpl.mkdir(path.dirname(backup), { recursive: true, mode: 0o700 });
  await fsImpl.cp(appPath, backup, { recursive: true, dereference: false, errorOnExist: true });
  await validateEquinoxLocalAppHost(backup, { fsImpl, execFileImpl });
  return backup;
}

async function atomicReplaceApp(appPath:string,replacement:string,fsImpl:HostFs = fs) {
  const previous = `${appPath}.previous-${process.pid}-${randomBytes(6).toString("hex")}`;
  let movedPrevious = false;
  try {
    try {
      await fsImpl.rename(appPath, previous);
      movedPrevious = true;
    } catch (error) {
      if (!hasErrorCode(error,"ENOENT")) throw error;
    }
    await fsImpl.rename(replacement, appPath);
    if (movedPrevious) await fsImpl.rm(previous, { recursive: true, force: true });
  } catch (error) {
    await fsImpl.rm(appPath, { recursive: true, force: true }).catch(() => {});
    if (movedPrevious) await fsImpl.rename(previous, appPath).catch(() => {});
    throw error;
  }
}

/** Bounded metadata and complete sealed-archive authentication for admission. */
export async function readEquinoxLocalNativeAppMetadata(releaseDir:string, fsImpl:HostFs = fs) {
  const paths = equinoxLocalNativeAppArtifactPaths(releaseDir);
  const file = await readBoundedNormalFile(paths.metadata, { fsImpl, minBytes: 1, maxBytes: 16 * 1024, encoding: "utf8", label: "Native app metadata" });
  const raw:unknown = JSON.parse(file.data);
  if (isRecord(raw) && raw.schemaVersion === 2) {
    const metadata = validateEquinoxLocalDesktopAppMetadata(raw);
    const archive = path.join(paths.root, metadata.archive);
    const handle = await fsImpl.open(archive, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      const real = await fsImpl.realpath(archive);
      const canonical = process.platform === "win32" ? real.toLowerCase() === archive.toLowerCase() : real === archive;
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== metadata.bytes || !canonical ||
          (process.platform === "darwin" && (stat.uid !== process.getuid!() || (stat.mode & 0o022) !== 0))) {
        throw new Error("Sealed desktop archive is not a normal owned payload.");
      }
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(64 * 1024);
      let bytes = 0;
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        bytes += bytesRead;
        if (bytes > metadata.bytes) throw new Error("Sealed desktop archive exceeded its authenticated size.");
        hash.update(buffer.subarray(0, bytesRead));
      }
      const after = await handle.stat();
      if (bytes !== metadata.bytes || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || hash.digest("hex") !== metadata.sha256) {
        throw new Error("Sealed desktop archive authentication failed.");
      }
    } finally { await handle.close(); }
    return metadata;
  }
  // Preserve all historical schema-1 validation and payload authentication.
  return (await readNativeMetadata(releaseDir, fsImpl)).metadata;
}

function isDesktopMetadata(metadata: NativeMetadata | DesktopAppMetadata): metadata is DesktopAppMetadata {
  return "schemaVersion" in metadata && metadata.schemaVersion === 2;
}

function desktopPayloadIdentity(metadata:DesktopAppMetadata):string {
  return createHash("sha256").update(`equinox-local-desktop-payload-v2\0${JSON.stringify(metadataFields(metadata))}`).digest("hex");
}
function metadataFields(m:DesktopAppMetadata) {
  return [m.schemaVersion,m.kind,m.sourceSha,m.target,m.shellVersion,m.archive,m.sha256,m.bytes];
}

async function desktopPlist(appPath:string,key:string,execFileImpl:HostExec):Promise<string> {
  const {stdout} = await execFileImpl("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, path.join(appPath,"Contents","Info.plist")], {encoding:"utf8",timeout:5000,maxBuffer:16384});
  return String(stdout).trim();
}

async function validateDesktopHost(appPath:string,metadata:DesktopAppMetadata,fsImpl:HostFs,execFileImpl:HostExec) {
  for (const directory of [appPath,path.join(appPath,"Contents"),path.join(appPath,"Contents","MacOS")]) {
    const stat = await fsImpl.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!()) throw new Error("Unsafe Electron bundle directory.");
  }
  await assertNormalFile(path.join(appPath,"Contents","Info.plist"),"Electron Info.plist",fsImpl);
  if (await desktopPlist(appPath,"CFBundleIdentifier",execFileImpl) !== EQUINOX_LOCAL_APP_BUNDLE_ID ||
      await desktopPlist(appPath,"EquinoxLocalSourceSha",execFileImpl) !== metadata.sourceSha ||
      await readBundleNativeShellVersion(appPath,execFileImpl) !== metadata.shellVersion ||
      !(await hasStableNativePermissionIdentity(appPath,execFileImpl))) throw new Error("Electron bundle identity mismatch.");
  const executable = await desktopPlist(appPath,"CFBundleExecutable",execFileImpl);
  if (executable !== "applet") throw new Error("Electron executable must preserve the installed applet contract.");
  const executablePath = path.join(appPath,"Contents","MacOS",executable);
  await assertNormalFile(executablePath,"Electron executable",fsImpl);
  const {stdout} = await execFileImpl("/usr/bin/lipo",["-archs",executablePath],{encoding:"utf8",timeout:5000,maxBuffer:16384});
  if (String(stdout).trim() !== (metadata.target === "darwin-arm64" ? "arm64" : "x86_64")) throw new Error("Electron executable architecture mismatch.");
  await execFileImpl("/usr/bin/codesign",["--verify","--deep","--strict",appPath],{timeout:60000,maxBuffer:1024*1024});
  return executablePath;
}

async function stampDesktopHost(bundle:string,payload:string,execFileImpl:HostExec) {
  const plist = path.join(bundle,"Contents","Info.plist");
  // Preserve the complete Electron plist; re-sign only the outer bundle.
  try { await execFileImpl("/usr/bin/plutil",["-replace",NATIVE_PAYLOAD_SHA_PLIST_KEY,"-string",payload,plist],{timeout:5000}); }
  catch { await execFileImpl("/usr/bin/plutil",["-insert",NATIVE_PAYLOAD_SHA_PLIST_KEY,"-string",payload,plist],{timeout:5000}); }
  await execFileImpl("/usr/bin/codesign",["--force","--sign","-","--identifier",EQUINOX_LOCAL_APP_BUNDLE_ID,"-r",`=${nativePermissionDesignatedRequirementSource()}`,bundle],{timeout:60000,maxBuffer:1024*1024});
}

// Only consume archives just produced and validated by the bundle-only sealer.
// Tar timestamps/uid are not payload; paths, types, modes, links and every byte are.
async function sealedDesktopContentIdentity(archive:string):Promise<string> {
  const entries: string[] = [];
  await listTar({file:archive,strict:true,onReadEntry(entry) {
    const hash = createHash("sha256");
    entry.on("data",(chunk:Buffer) => hash.update(chunk));
    entry.on("end",() => entries.push(JSON.stringify([entry.path,entry.type,entry.mode,entry.size,entry.linkpath,hash.digest("hex")])));
    entry.resume();
  }});
  return createHash("sha256").update(entries.sort().join("\n")).digest("hex");
}
// Bundle-only sealing validates framework links; never use the generic expanded-tree fingerprint.
async function sameCompleteDesktopPayload(installed:string,candidate:string,stage:string):Promise<boolean> {
  const expected = path.join(stage,"expected.tar.gz");
  const actual = path.join(stage,"installed.tar.gz");
  await sealDesktopBundle(candidate,expected);
  await sealDesktopBundle(installed,actual);
  return await sealedDesktopContentIdentity(actual) === await sealedDesktopContentIdentity(expected);
}

async function synchronizeDesktopHost(homeDir:string,releaseDir:string,metadata:DesktopAppMetadata,fsImpl:HostFs,execFileImpl:HostExec) {
  if (metadata.target !== `darwin-${process.arch}`) throw new Error("Electron payload requires its native target host.");
  const appPath = equinoxLocalAppPath(homeDir);
  const payload = desktopPayloadIdentity(metadata);
  // Always authenticate the complete candidate before reuse, even for legacy callers.
  const applications = path.dirname(appPath);
  await fsImpl.mkdir(applications,{recursive:true,mode:0o700});
  const stage = path.join(applications,`.Equinox-Local-electron-${process.pid}-${randomBytes(8).toString("hex")}`);
  const archive = path.join(path.dirname(equinoxLocalNativeAppArtifactPaths(releaseDir).metadata),metadata.archive);
  let stageOwned = false;
  try {
    const bundle = await extractDesktopBundle(archive,stage,metadata);
    stageOwned = true;
    await validateDesktopHost(bundle,metadata,fsImpl,execFileImpl);
    await stampDesktopHost(bundle,payload,execFileImpl);
    await validateDesktopHost(bundle,metadata,fsImpl,execFileImpl);
    try {
      const executablePath = await validateDesktopHost(appPath,metadata,fsImpl,execFileImpl);
      if (await readBundleNativePayloadIdentity(appPath,execFileImpl) === payload && await sameCompleteDesktopPayload(appPath,bundle,stage)) return Object.freeze({appPath,executablePath,shellVersion:metadata.shellVersion,changed:false,migratedLegacy:false});
    } catch {
      // A foreign bundle must not be replaced; accept only an owned stable legacy host.
      try { await fsImpl.lstat(appPath); } catch (error) { if (!hasErrorCode(error,"ENOENT")) throw error; }
    }
    try {
      const stat = await fsImpl.lstat(appPath);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || await desktopPlist(appPath,"CFBundleIdentifier",execFileImpl) !== EQUINOX_LOCAL_APP_BUNDLE_ID) throw new Error("Refusing foreign Electron replacement target.");
    } catch (error) { if (!hasErrorCode(error,"ENOENT")) throw error; }
    const executable = await desktopPlist(bundle,"CFBundleExecutable",execFileImpl);
    await atomicReplaceApp(appPath,bundle,fsImpl);
    return Object.freeze({appPath,executablePath:path.join(appPath,"Contents","MacOS",executable),shellVersion:metadata.shellVersion,changed:true,migratedLegacy:true});
  } finally { if (stageOwned) await fsImpl.rm(stage,{recursive:true,force:true}); }
}

export async function synchronizeEquinoxLocalNativeAppHost({
  homeDir,
  releaseDir,
  fsImpl = fs,
  execFileImpl = execFile,
  requirePayloadIdentity = false,
}:HostPaths & {requirePayloadIdentity?:boolean} = {}) {
  if (process.platform !== "darwin") throw new Error("Equinox Local native app synchronization is supported only on macOS.");
  if (typeof homeDir !== "string" || !path.isAbsolute(homeDir)) throw new Error("A trusted user home directory is required for native app synchronization.");
  const selected = await readEquinoxLocalNativeAppMetadata(releaseDir!, fsImpl);
  if (isDesktopMetadata(selected)) {
    try { return await synchronizeDesktopHost(homeDir,releaseDir!,selected,fsImpl,execFileImpl); }
    catch (cause) { throw new Error("Electron sealed payload synchronization failed; legacy fallback is forbidden.", {cause}); }
  }
  const { paths, metadata } = await readNativeMetadata(releaseDir!, fsImpl);
  const payloadSha256 = nativePayloadIdentity(metadata);
  const appPath = equinoxLocalAppPath(homeDir!);

  try {
    await validateEquinoxLocalAppHost(appPath, { fsImpl, execFileImpl });
    const shellVersion = await readBundleNativeShellVersion(appPath, execFileImpl);
    const payloadMatches = !requirePayloadIdentity || await readBundleNativePayloadIdentity(appPath, execFileImpl) === payloadSha256;
    if (shellVersion === metadata.shellVersion && payloadMatches && await hasStableNativePermissionIdentity(appPath, execFileImpl)) {
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
    if (!hasErrorCode(error,"ENOENT")) throw error;
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
    if (metadata.shellVersion >= 4) await fsImpl.copyFile(paths.menuIcon, path.join(resources, "EquinoxLocalMenuBar.png"));
    if (metadata.shellVersion >= 11) await fsImpl.copyFile(paths.companionAsset, path.join(resources, "EquinoxCompanionNyx.webp"));
    await fsImpl.writeFile(path.join(contents, "Info.plist"), nativeInfoPlist(metadata.shellVersion, metadata.executableSha256, payloadSha256), { mode: 0o644 });
    await execFileImpl("/usr/bin/codesign", [
      "--force",
      "--sign",
      "-",
      "--identifier",
      EQUINOX_LOCAL_APP_BUNDLE_ID,
      "-r",
      `=${nativePermissionDesignatedRequirementSource()}`,
      temporary,
    ], {
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

// A failed genuinely clean Main first install may remove only the apphost
// created from the original immutable B. Never remove a foreign or modified
// app bundle under the user's ~/Applications.
export async function assertEquinoxLocalFreshNativeAppHostOwned({
  homeDir,releaseDir,fsImpl=fs,execFileImpl=execFile,
}:HostPaths={}) {
  if(process.platform!=="darwin" || typeof homeDir!=="string" ||
     typeof releaseDir!=="string" || !path.isAbsolute(homeDir) ||
     !path.isAbsolute(releaseDir)){
    throw new Error("Clean Main native app ownership requires canonical macOS paths.");
  }
  const selected=await readEquinoxLocalNativeAppMetadata(releaseDir,fsImpl);
  const appPath=equinoxLocalAppPath(homeDir);
  if (isDesktopMetadata(selected)) {
    await validateDesktopHost(appPath,selected,fsImpl,execFileImpl);
    if (await readBundleNativePayloadIdentity(appPath,execFileImpl) !== desktopPayloadIdentity(selected)) throw new Error("Clean Main Electron app no longer matches original full payload.");
    const archive = path.join(path.dirname(equinoxLocalNativeAppArtifactPaths(releaseDir).metadata),selected.archive);
    const stage = path.join(path.dirname(appPath),`.Equinox-Local-owned-${process.pid}-${randomBytes(8).toString("hex")}`);
    let stageOwned = false;
    try {
      const candidate = await extractDesktopBundle(archive,stage,selected);
      stageOwned = true;
      await validateDesktopHost(candidate,selected,fsImpl,execFileImpl);
      await stampDesktopHost(candidate,desktopPayloadIdentity(selected),execFileImpl);
      await validateDesktopHost(candidate,selected,fsImpl,execFileImpl);
      if (!(await sameCompleteDesktopPayload(appPath,candidate,stage))) throw new Error("Clean Main Electron full bundle bytes no longer match original payload.");
    } finally { if (stageOwned) await fsImpl.rm(stage,{recursive:true,force:true}); }
    return Object.freeze({appPath,owned:true});
  }
  const {metadata}=await readNativeMetadata(releaseDir,fsImpl);
  await validateEquinoxLocalAppHost(appPath,{fsImpl,execFileImpl});
  if(await readBundleNativePayloadIdentity(appPath,execFileImpl)!==nativePayloadIdentity(metadata) ||
     await readBundleNativeShellVersion(appPath,execFileImpl)!==metadata.shellVersion ||
     !(await hasStableNativePermissionIdentity(appPath,execFileImpl))){
    throw new Error("Clean Main apphost no longer matches original signed native B payload.");
  }
  await execFileImpl("/usr/bin/codesign",["--verify","--deep","--strict",appPath],{
    timeout:15_000,maxBuffer:1024*1024,
  });
  return Object.freeze({appPath,owned:true});
}

export async function snapshotEquinoxLocalNativeAppHost({
  homeDir,
  snapshotPath,
  fsImpl = fs,
  execFileImpl = execFile,
}:SnapshotPaths = {}) {
  if (process.platform !== "darwin") throw new Error("Equinox Local native app snapshot is supported only on macOS.");
  if (typeof homeDir !== "string" || !path.isAbsolute(homeDir)) throw new Error("A trusted user home directory is required for native app snapshotting.");
  if (typeof snapshotPath !== "string" || !path.isAbsolute(snapshotPath)) throw new Error("A trusted native app snapshot path is required.");
  const appPath = equinoxLocalAppPath(homeDir!);
  await validateEquinoxLocalAppHost(appPath, { fsImpl, execFileImpl });
  const manifestPath = `${snapshotPath}.rollback.json`;
  for (const destination of [snapshotPath, manifestPath]) {
    try {
      await fsImpl.lstat(destination);
      throw Object.assign(new Error("Equinox Local native app snapshot destination already exists."), { code: "EEXIST" });
    } catch (error) {
      if (!hasErrorCode(error,"ENOENT")) throw error;
    }
  }
  await fsImpl.mkdir(path.dirname(snapshotPath), { recursive: true, mode: 0o700 });
  try {
    await fsImpl.cp(appPath, snapshotPath, { recursive: true, dereference: false, errorOnExist: true });
    await validateEquinoxLocalAppHost(snapshotPath, { fsImpl, execFileImpl });
    const fingerprint = await fingerprintEquinoxLocalNativeState(snapshotPath, { fsImpl });
    const manifestPrefix: {schemaVersion:1;kind:"darwin-app"} = {schemaVersion:1,kind:"darwin-app"};
    await fsImpl.writeFile(manifestPath, `${JSON.stringify({ ...manifestPrefix, ...fingerprint }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    return Object.freeze({ appPath, snapshotPath, manifestPath, fingerprint });
  } catch (error) {
    await fsImpl.rm(snapshotPath, { recursive: true, force: true }).catch(() => {});
    await fsImpl.rm(manifestPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function inspectEquinoxLocalNativeAppHostSnapshot({
  snapshotPath,
  fsImpl = fs,
  execFileImpl = execFile,
}:InspectPaths = {}) {
  if (process.platform !== "darwin") throw new Error("Equinox Local native app snapshot inspection is supported only on macOS.");
  if (typeof snapshotPath !== "string" || !path.isAbsolute(snapshotPath)) throw new Error("A trusted native app snapshot path is required.");
  await validateEquinoxLocalAppHost(snapshotPath, { fsImpl, execFileImpl });
  const manifestPath = `${snapshotPath}.rollback.json`;
  const manifestFile = await readBoundedNormalFile(manifestPath, { fsImpl, minBytes: 1, maxBytes: 4096, encoding: "utf8", label: "Equinox Local native app rollback manifest" });
  const manifest = JSON.parse(manifestFile.data);
  const fingerprint = await fingerprintEquinoxLocalNativeState(snapshotPath, { fsImpl });
  if (manifest?.schemaVersion !== 1 || manifest?.kind !== "darwin-app" || manifest?.sha256 !== fingerprint.sha256 || manifest?.entries !== fingerprint.entries || manifest?.bytes !== fingerprint.bytes) {
    throw new Error("Equinox Local native app rollback snapshot fingerprint mismatch.");
  }
  return Object.freeze({ snapshotPath, manifestPath, fingerprint });
}

export async function restoreEquinoxLocalNativeAppHostSnapshot({
  homeDir,
  snapshotPath,
  fsImpl = fs,
  execFileImpl = execFile,
}:SnapshotPaths = {}) {
  if (process.platform !== "darwin") throw new Error("Equinox Local native app snapshot restore is supported only on macOS.");
  if (typeof homeDir !== "string" || !path.isAbsolute(homeDir)) throw new Error("A trusted user home directory is required for native app snapshot restore.");
  await inspectEquinoxLocalNativeAppHostSnapshot({ snapshotPath, fsImpl, execFileImpl });
  const appPath = equinoxLocalAppPath(homeDir!);
  const replacement = path.join(path.dirname(appPath), `.Equinox-Local-rollback-${process.pid}-${randomBytes(8).toString("hex")}.app`);
  try {
    await fsImpl.cp(snapshotPath!, replacement, { recursive: true, dereference: false, errorOnExist: true });
    await validateEquinoxLocalAppHost(replacement, { fsImpl, execFileImpl });
    await atomicReplaceApp(appPath, replacement, fsImpl);
    await validateEquinoxLocalAppHost(appPath, { fsImpl, execFileImpl });
  } catch (error) {
    await fsImpl.rm(replacement, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return Object.freeze({ appPath, executablePath: path.join(appPath, "Contents", "MacOS", "applet"), restored: true });
}

export async function restoreLegacyEquinoxLocalAppHost({ homeDir, fsImpl = fs, execFileImpl = execFile }:HostOptions & {homeDir?:string} = {}) {
  const backup = legacyBackupPath(homeDir!);
  const backupStat = await fsImpl.lstat(backup);
  if (!backupStat.isDirectory() || backupStat.isSymbolicLink()) throw new Error("Equinox Local legacy app backup is unavailable or unsafe.");
  await validateEquinoxLocalAppHost(backup, { fsImpl, execFileImpl });
  const appPath = equinoxLocalAppPath(homeDir!);
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
  requirePayloadIdentity = false,
}:ReleaseSync = {}) {
  const homeDir = homeDirFromInstallation(installation);
  try {
    return await synchronizeEquinoxLocalNativeAppHost({ homeDir, releaseDir, fsImpl, execFileImpl, requirePayloadIdentity });
  } catch (error) {
    if (!hasErrorCode(error,"ENOENT")) throw error;
    try {
      return await restoreLegacyEquinoxLocalAppHost({ homeDir, fsImpl, execFileImpl });
    } catch (restoreError) {
      if (hasErrorCode(restoreError,"ENOENT")) return Object.freeze({ appPath: equinoxLocalAppPath(homeDir), changed: false, legacy: true });
      throw restoreError;
    }
  }
}
