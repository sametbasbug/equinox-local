import { execFile as execFileCallback, spawn as spawnChild } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  bootstrapManagedEquinoxUser,
  EQUINOX_LOCAL_LAUNCH_AGENT_LABEL,
} from "./equinox-local-bootstrap.js";
import {
  activatePreparedEquinoxRelease,
  kickstartEquinoxLocalLaunchAgent,
  readManagedCurrentRelease,
  synchronizeManagedShellForRelease,
  waitForEquinoxLocalManagedSource,
  waitForEquinoxLocalVersion,
} from "./equinox-local-update-activation.js";
import {
  compareEquinoxVersions,
  equinoxLocalUpdateTarget,
  parseEquinoxVersion,
} from "./equinox-local-updater.js";
import { managedSupervisorPaths } from "./equinox-local-supervisor.js";
import { enrollEquinoxLocalManagedSource, rollbackEquinoxLocalManagedSourceEnrollment } from "./equinox-local-managed-source-enrollment.js";
import { equinoxLocalManagedSourcePaths } from "./equinox-local-managed-source-installation.js";
import { validateManagedSourceInstallStamp } from "./equinox-local-main-update.js";
import { readEquinoxLocalMainNativePointer } from "./equinox-local-main-native-state.js";
import { readEquinoxLocalMainSourcePointer } from "./equinox-local-main-source-pointer.js";
import {
  reconcileWindowsClassicRepairJournal,
  writeWindowsClassicRepairJournal,
} from "./equinox-local-windows-classic-repair-journal.js";
import { pruneInactiveManagedStableReleases } from "./equinox-local-release-retention.js";
import { readBoundedNormalFile } from "./equinox-local-safe-file.js";
import { assertWindowsNativeMessagingHostOwnership, windowsNativeMessagingLauncherPath } from "./equinox-browser-windows-native-messaging.js";
import { assertWindowsStableShellOwnedByRelease } from "./equinox-local-windows-stable-shell.js";
import { requestWindowsShellRuntimeRestart, requestWindowsShellUpdateShutdown, waitForWindowsShellPipeRelease } from "./equinox-local-windows-shell-control.js";
import { provisionWindowsGuardianFromRelease } from "./equinox-local-windows-guardian-provision.js";
import { readEquinoxLocalCurrentVersionPointer, writeEquinoxLocalCurrentVersionPointer } from "./equinox-local-current-release.js";
import { fingerprintEquinoxLocalNativeState } from "./equinox-local-native-state-fingerprint.js";
import { initializeManagedOnboardingState } from "./equinox-local-onboarding.js";
import { equinoxLocalReleaseRuntimeContract } from "./equinox-local-release-runtime-contract.js";
import { equinoxLocalToolchainContract } from "./equinox-local-toolchain-contract.js";
import {
  launchWindowsStableShell,
  renameWindowsPathWhenUnlocked,
  synchronizeFreshWindowsShell,
} from "./equinox-local-windows-stable-shell.js";
import { walkBoundedReleaseTree } from "./equinox-local-release-tree.js";
export {
  sameWindowsStableShellTree,
  snapshotWindowsStableShellTree,
  stageWindowsStableShellForRelease,
  synchronizeFreshWindowsShell,
} from "./equinox-local-windows-stable-shell.js";
export { launchWindowsStableShell as launchFreshWindowsShell } from "./equinox-local-windows-stable-shell.js";

const execFile = promisify(execFileCallback);
type FsImpl=typeof fs;
type ExecImpl=typeof execFile;
type Paths=ReturnType<typeof managedSupervisorPaths>;
type MainPaths=ReturnType<typeof equinoxLocalManagedSourcePaths>;
type Metadata={schemaVersion:number;version:string;target:string;serverEntry:string;sourceSha?:string;nodeVersion:string;tunnelClientVersion:string;nativeAppShellVersion?:number};
type Release=Readonly<{version:string;target:ReturnType<typeof equinoxLocalUpdateTarget>;releaseDir:string;metadata:Readonly<Metadata>;tree:Readonly<{entryCount:number;totalBytes:number}>}>;
type Install=Readonly<{kind:"managed";managed:true;selfUpdateSupported:true;platform:string;arch:string;target:string;installRoot:string;releasesRoot:string;releaseDir:string|null;currentLink:string|null;currentPointer:string;programRoot:string;nativeMessagingManifestRoot:string;stagingRoot:string;launchAgentPath:string|null;launchAgentLabel:string|null}>;
type ErrorCode={code?:string;message?:string};
type AsyncBridge=(...args:any[])=>Promise<any>;
type RepairRecord={schemaVersion:number;version:string;target:string;mainStamp:string;oldSha256:string;stableSha256:string;nativeSourceSha:string|null};
type RepairOptions={paths:Paths;mainPaths:MainPaths;installation:Install;candidate?:Release|null;mainStamp?:string|null;uid:number|null;platform:string;arch:string;target:string;fsImpl:FsImpl;execFileImpl:ExecImpl;syncManagedShellImpl:AsyncBridge;stopWindowsShellImpl:AsyncBridge;launchWindowsShellImpl:AsyncBridge;waitForVersionImpl:AsyncBridge;windowsRenameSleepImpl:(ms:number)=>Promise<unknown>;inspectLegacyMainHostImpl:AsyncBridge};
type FirstInstallOptions={stagedReleaseDir:string;homeDir?:string;uid?:number|null;platform?:string;arch?:string;target?:string|null;allowExistingStableToMainMigration?:boolean;env?:NodeJS.ProcessEnv;fsImpl?:FsImpl;execFileImpl?:ExecImpl;bootstrapImpl?:AsyncBridge;readCurrentImpl?:AsyncBridge;readMainSourcePointerImpl?:AsyncBridge;readMainNativePointerImpl?:AsyncBridge;pruneStableImpl?:AsyncBridge;activateImpl?:AsyncBridge;waitForVersionImpl?:AsyncBridge;waitForManagedSourceImpl?:AsyncBridge;enrollManagedSourceImpl?:AsyncBridge;rollbackManagedSourceImpl?:AsyncBridge;requestWindowsRestartImpl?:AsyncBridge;initializeOnboardingImpl?:AsyncBridge;syncWindowsShellImpl?:AsyncBridge;syncManagedShellImpl?:AsyncBridge;stopWindowsShellImpl?:AsyncBridge;launchWindowsShellImpl?:AsyncBridge;verifyWindowsShellOwnedImpl?:AsyncBridge;verifyWindowsNativeHostOwnedImpl?:AsyncBridge;waitWindowsPipeReleaseImpl?:AsyncBridge;windowsRenameSleepImpl?:(ms:number)=>Promise<unknown>;inspectLegacyMainHostImpl?:AsyncBridge};

const MAX_RELEASE_METADATA_BYTES = 16 * 1024;
const FIRST_INSTALL_HEALTH_ATTEMPTS = 120;
const FIRST_INSTALL_WINDOWS_HEALTH_ATTEMPTS = 180;
const FIRST_INSTALL_HEALTH_DELAY_MS = 500;
const FIRST_INSTALL_DIAGNOSTIC_BYTES = 12 * 1024;

export function equinoxLocalFirstInstallHealthBudget({ platform = process.platform, arch = process.arch }:{platform?:string;arch?:string}={}) {
  const attempts = platform === "win32" && ["x64", "arm64"].includes(arch)
    ? FIRST_INSTALL_WINDOWS_HEALTH_ATTEMPTS
    : FIRST_INSTALL_HEALTH_ATTEMPTS;
  return Object.freeze({ attempts, delayMs: FIRST_INSTALL_HEALTH_DELAY_MS });
}

function inside(parent:string,child:string,pathApi:typeof path=path) {
  const relative = pathApi.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !pathApi.isAbsolute(relative);
}

function exactKeys(value:unknown,expected:readonly string[],label:string) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} contains missing or unsupported fields.`);
  }
}

async function assertOwnedNormalDirectory(directory:string,{
  uid,
  platform = process.platform,
  fsImpl = fs,
  create = false,
  mode = 0o700,
}:{uid?:number|null;platform?:string;fsImpl?:FsImpl;create?:boolean;mode?:number}={}) {
  if (create) await fsImpl.mkdir(directory, { recursive: true, mode });
  const stat = await fsImpl.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe managed directory: ${directory}`);
  if (platform === "darwin") {
    if (Number.isInteger(uid) && Number.isInteger(stat.uid) && stat.uid !== uid) {
      throw new Error(`Managed directory is not owned by the current user: ${directory}`);
    }
    if ((stat.mode & 0o022) !== 0) throw new Error(`Managed directory is writable by group or other users: ${directory}`);
    await fsImpl.chmod(directory, mode).catch(() => {});
  }
  return stat;
}

async function assertNormalFile(filePath:string,label:string,{executable=false,maxBytes=null,fsImpl=fs}:{executable?:boolean;maxBytes?:number|null;fsImpl?:FsImpl}={}) {
  const stat = await fsImpl.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a normal file.`);
  if (Number.isFinite(maxBytes) && (stat.size < 1 || stat.size > maxBytes!)) throw new Error(`${label} has an invalid size.`);
  if (executable && (stat.mode & 0o111) === 0) throw new Error(`${label} must be executable.`);
  return stat;
}

async function validateReleaseTree(root:string,{fsImpl=fs}:{fsImpl?:FsImpl}={}) {
  return walkBoundedReleaseTree(root, {
    fsImpl,
    countName: "entryCount",
    errors: {
      entryLimit: "Staged Equinox Local release contains too many entries.",
      byteLimit: "Staged Equinox Local release exceeds the extracted size limit.",
      symlink: "Staged Equinox Local release may not contain symbolic links.",
      unsupportedEntry: "Staged Equinox Local release contains an unsupported filesystem entry.",
    },
  });
}

export async function validateFirstInstallRelease(releaseDir:string,{
  target = equinoxLocalUpdateTarget(),
  fsImpl = fs,
}:{target?:string;fsImpl?:FsImpl}={}):Promise<Release> {
  if (typeof releaseDir !== "string" || !path.isAbsolute(releaseDir)) {
    throw new Error("Staged Equinox Local release path must be absolute.");
  }
  const rootStat = await fsImpl.lstat(releaseDir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Staged Equinox Local release must be a normal directory.");
  const tree = await validateReleaseTree(releaseDir, { fsImpl });
  const metadataPath = path.join(releaseDir, "release.json");
  await assertNormalFile(metadataPath, "Release metadata", { maxBytes: MAX_RELEASE_METADATA_BYTES, fsImpl });
  const metadata:Metadata = JSON.parse(await fsImpl.readFile(metadataPath, "utf8"));
  const runtimeContract = equinoxLocalReleaseRuntimeContract({ target, version: metadata.version });
  const sourceIdentityKeys = Object.hasOwn(metadata, "sourceSha") ? ["sourceSha"] : [];
  const metadataKeys = runtimeContract.platform === "darwin"
    ? ["schemaVersion", "version", "target", ...sourceIdentityKeys, "nodeVersion", "tunnelClientVersion", "nativeAppShellVersion", "serverEntry"]
    : ["schemaVersion", "version", "target", ...sourceIdentityKeys, "nodeVersion", "tunnelClientVersion", "serverEntry"];
  exactKeys(metadata, metadataKeys, "Release metadata");
  if (
    metadata.schemaVersion !== 1 ||
    metadata.target !== target ||
    metadata.serverEntry !== "server.js" ||
    (metadata.sourceSha !== undefined && (typeof metadata.sourceSha !== "string" || !/^[a-f0-9]{40}$/u.test(metadata.sourceSha))) ||
    typeof metadata.nodeVersion !== "string" ||
    !/^\d+\.\d+\.\d+$/u.test(metadata.nodeVersion) ||
    typeof metadata.tunnelClientVersion !== "string" ||
    !/^\d+\.\d+\.\d+$/u.test(metadata.tunnelClientVersion) ||
    (runtimeContract.platform === "darwin" && (!Number.isSafeInteger(metadata.nativeAppShellVersion) || metadata.nativeAppShellVersion! < 1))
  ) {
    throw new Error(`Staged Equinox Local release metadata is invalid for ${target}.`);
  }
  parseEquinoxVersion(metadata.version);
  for (const relative of runtimeContract.runtimeExecutables) {
    await assertNormalFile(path.join(releaseDir, relative), `Runtime ${relative}`, { executable: runtimeContract.executableModeRequired, fsImpl });
  }
  for (const relative of runtimeContract.runtimeDocuments) {
    await assertNormalFile(path.join(releaseDir, relative), `Runtime ${relative}`, { fsImpl });
  }
  for (const relative of runtimeContract.nativeShellFiles) {
    await assertNormalFile(path.join(releaseDir, relative), `Native shell ${relative}`, { fsImpl });
  }
  if (runtimeContract.nativeAppKind === "macos-app") {
    await assertNormalFile(path.join(releaseDir, "runtime", "app", "applet"), "Native app executable", { executable: true, fsImpl });
    await assertNormalFile(path.join(releaseDir, "runtime", "app", "EquinoxLocal.png"), "Native app icon", { fsImpl });
    await assertNormalFile(path.join(releaseDir, "runtime", "app", "native-app.json"), "Native app metadata", { fsImpl });
  }
  for (const relative of runtimeContract.requiredReleaseFiles) {
    await assertNormalFile(path.join(releaseDir, relative), `Release ${relative}`, { fsImpl });
  }
  return Object.freeze({
    version: metadata.version,
    target: metadata.target as ReturnType<typeof equinoxLocalUpdateTarget>,
    releaseDir,
    metadata: Object.freeze({ ...metadata }),
    tree:tree as Release["tree"],
  });
}

function installationFor(paths:Paths,releaseDir:string|null,{
  platform = process.platform,
  arch = process.arch,
  target = equinoxLocalUpdateTarget({ platform, arch }),
}:{platform?:string;arch?:string;target?:string}={}):Install {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  return Object.freeze({
    kind: "managed",
    managed: true,
    selfUpdateSupported: true,
    platform,
    arch,
    target,
    lifecycleKind: platform === "win32" ? "windows-user" : "launch-agent",
    installRoot: paths.installRoot,
    releasesRoot: paths.releasesRoot,
    releaseDir,
    currentLink: platform === "darwin" ? paths.currentLink : null,
    currentPointer: paths.currentPointer,
    programRoot: paths.programRoot,
    nativeMessagingManifestRoot: paths.nativeMessagingManifestRoot,
    stagingRoot: pathApi.join(paths.installRoot, "staging"),
    launchAgentPath: platform === "darwin"
      ? path.posix.join(paths.homeDir, "Library", "LaunchAgents", `${EQUINOX_LOCAL_LAUNCH_AGENT_LABEL}.plist`)
      : null,
    launchAgentLabel: platform === "darwin" ? EQUINOX_LOCAL_LAUNCH_AGENT_LABEL : null,
  });
}

async function atomicInitialCurrentPointer(paths:Paths,targetRelease:string,candidate:Release,{
  platform = process.platform,
  target = candidate.target,
  fsImpl = fs,
}:{platform?:string;target?:string;fsImpl?:FsImpl}={}) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const pointerPath = platform === "win32" ? paths.currentPointer : paths.currentLink;
  try {
    await fsImpl.lstat(pointerPath!);
    throw new Error("Managed current pointer appeared during first-install promotion.");
  } catch (error) {
    if ((error as ErrorCode)?.code !== "ENOENT") throw error;
  }
  if (pathApi.dirname(targetRelease) !== paths.releasesRoot) {
    throw new Error("First-install current pointer target is unsafe.");
  }
  if (platform === "win32") {
    await writeEquinoxLocalCurrentVersionPointer(paths.currentPointer, {
      version: candidate.version,
      fsImpl,
      platform: "win32",
      target,
    });
    return;
  }
  const relative = path.posix.relative(paths.installRoot, targetRelease);
  if (!relative.startsWith("releases/")) throw new Error("First-install current pointer target is unsafe.");
  const temporary = path.posix.join(paths.installRoot, `.current-install-${process.pid}-${randomBytes(8).toString("hex")}`);
  try {
    await fsImpl.symlink(relative, temporary, "dir");
    await fsImpl.rename(temporary, paths.currentLink!);
  } catch (error) {
    await fsImpl.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function boundedDiagnostic(value:unknown,maxChars=1200) {
  return String(value ?? "")
    .replace(/[\r\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim()
    .slice(-maxChars);
}

async function readDiagnosticTail(filePath:string,{fsImpl=fs,maxBytes=FIRST_INSTALL_DIAGNOSTIC_BYTES}:{fsImpl?:FsImpl;maxBytes?:number}={}) {
  if (typeof fsImpl.open !== "function") return null;
  let handle:Awaited<ReturnType<FsImpl["open"]>>|null=null;
  try {
    handle = await fsImpl.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1) return null;
    const length = Math.min(stat.size, maxBytes);
    const offset = Math.max(0, stat.size - length);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return boundedDiagnostic(buffer.subarray(0, bytesRead).toString("utf8"));
  } catch {
    return null;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function windowsFirstInstallActivationDiagnostics({paths,fsImpl=fs}:{paths:Paths;fsImpl?:FsImpl}) {
  const errorLog = await readDiagnosticTail(path.win32.join(paths.logsRoot, "windows-shell-runtime.log"), { fsImpl });
  return errorLog ? boundedDiagnostic(`Windows shell runtime error log tail: ${errorLog}`, 1_800) : "";
}

async function firstInstallActivationDiagnostics({homeDir,uid,execFileImpl=execFile,fsImpl=fs}:{homeDir:string;uid:number|null;execFileImpl?:ExecImpl;fsImpl?:FsImpl}) {
  const parts:string[] = [];
  const service = `gui/${uid}/${EQUINOX_LOCAL_LAUNCH_AGENT_LABEL}`;
  try {
    const result = await execFileImpl("/bin/launchctl", ["print", service], {
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    const output = String(result?.stdout ?? "");
    const state = /^\s*state = (.+)$/mu.exec(output)?.[1]?.trim() ?? null;
    const pid = /^\s*pid = (\d+)$/mu.exec(output)?.[1] ?? null;
    const lastExit = /^\s*last exit code = (.+)$/mu.exec(output)?.[1]?.trim() ?? null;
    const summary = [state ? `state=${state}` : null, pid ? `pid=${pid}` : null, lastExit ? `lastExit=${lastExit}` : null].filter(Boolean).join(", ");
    if (summary) parts.push(`LaunchAgent ${summary}`);
  } catch (error) {
    parts.push(`LaunchAgent unavailable (${boundedDiagnostic(error instanceof Error ? error.message : error, 240)})`);
  }
  const errorLog = await readDiagnosticTail(path.join(homeDir, "Library", "Logs", "Equinox Local.error.log"), { fsImpl });
  if (errorLog) parts.push(`error log tail: ${errorLog}`);
  return boundedDiagnostic(parts.join(" | "), 1_800);
}

async function reloadLaunchAgent(installation:Install,{
  uid,
  execFileImpl = execFile,
}:{uid:number|null;execFileImpl?:ExecImpl}) {
  if (!Number.isInteger(uid) || uid! < 1) throw new Error("A non-root user id is required to load Equinox Local.");
  const service = `gui/${uid}/${EQUINOX_LOCAL_LAUNCH_AGENT_LABEL}`;
  await execFileImpl("/bin/launchctl", ["bootout", service], {
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  }).catch(() => ({ stdout: "", stderr: "" }));
  await execFileImpl("/bin/launchctl", ["bootstrap", `gui/${uid}`, installation.launchAgentPath!], {
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  await execFileImpl("/bin/launchctl", ["kickstart", service], {
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
}

// Older Main enrollment retains the signed Stable WPF/Native Messaging at the
// numbered release path and has no current-native.json until a native update.
// Accept that exact installation only after proving both existing native owners.
async function inspectLegacyWindowsMainHost(installation:Install,{version,releaseDir,verifyShell=false,fsImpl=fs}:{version:string;releaseDir:string;verifyShell?:boolean;fsImpl?:FsImpl}) {
  const original = path.win32.join(installation.releasesRoot, version);
  await assertWindowsNativeMessagingHostOwnership({
    manifestRoot: installation.nativeMessagingManifestRoot,
    acceptedLauncherPaths: [windowsNativeMessagingLauncherPath(original)],
    fsImpl,
  });
  if (verifyShell) {
    await assertWindowsStableShellOwnedByRelease({ releaseDir, programRoot: installation.programRoot, fsImpl });
  }
}

// The unchanged version pointer cannot distinguish Main A from signed Stable B.
// Keep A and a small identity record outside the numbered release until B is
// HEALTHY/managed. Presence of the parked stamp means rollback is still owed;
// deleting it is the commit point. No user-owned state is moved or removed.
async function repairSameVersionMain({
  paths, mainPaths, installation, candidate = null, mainStamp = null,
  uid, platform, arch, target, fsImpl, execFileImpl, syncManagedShellImpl,
  stopWindowsShellImpl, launchWindowsShellImpl, waitForVersionImpl, windowsRenameSleepImpl,
  inspectLegacyMainHostImpl,
}:RepairOptions) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const backupRoot = pathApi.join(paths.installRoot, ".stable-repair-backup");
  const recordPath = pathApi.join(backupRoot, "repair.json");
  const temporaryRecord = pathApi.join(backupRoot, ".repair-next.json");
  const oldRelease = pathApi.join(backupRoot, "release");
  const failedRelease = pathApi.join(backupRoot, "failed-release");
  const savedStamp = `${mainPaths.installStampPath}.stable-install-backup`;
  const statOrNull = (name:string) => fsImpl.lstat(name).catch((error) => {
    if ((error as ErrorCode)?.code === "ENOENT") return null;
    throw error;
  });
  const readStamp = async (name:string) => {
    const file = await readBoundedNormalFile(name, {
      fsImpl, platform, minBytes: 1, maxBytes: 8 * 1024, encoding: "utf8", label: "Stable repair Main identity",
    }).catch((error) => {
      if ((error as ErrorCode)?.code === "ENOENT") return null;
      throw error;
    });
    if (file) validateManagedSourceInstallStamp(JSON.parse(file.data));
    return file?.data ?? null;
  };
  const rename = (from:string,to:string) => platform === "win32"
    ? renameWindowsPathWhenUnlocked(from, to, { fsImpl, sleepImpl: windowsRenameSleepImpl })
    : fsImpl.rename(from, to);
  const fingerprint = async (root:string) => (await fingerprintEquinoxLocalNativeState(root, { fsImpl })).sha256;
  const assertFingerprint = async (root:string,expected:string) => {
    if (await fingerprint(root) !== expected) throw new Error("Stable repair release identity changed; refusing unexpected state.");
  };
  const nativePointer = async (version:string) => {
    const pointerPath = pathApi.join(mainPaths.mainTransactionRoot, "current-native.json");
    const pointer = await statOrNull(pointerPath) ? await readEquinoxLocalMainNativePointer(pointerPath, {
      transactionRoot: mainPaths.mainTransactionRoot, fsImpl,
    }) : null;
    if (pointer && (pointer.target !== target || pointer.payloadVersion !== version)) {
      throw new Error("Stable repair old Main native identity does not match the numbered release.");
    }
    if (platform === "win32" && !pointer) {
      // Only the first prepared swap requires the original WPF bytes. On
      // interrupted recovery the shell may legitimately be A or B, while the
      // HKCU manifest must still name this exact owned numbered launcher.
      await inspectLegacyMainHostImpl(installation, {
        version, releaseDir: pathApi.join(paths.releasesRoot, version),
        verifyShell: Boolean(candidate && !record), fsImpl,
      });
    }
    return pointer;
  };
  const assertPointer = async (version:string) => {
    const expected = pathApi.join(paths.releasesRoot, version);
    if (platform === "win32") {
      const pointer = await readEquinoxLocalCurrentVersionPointer(paths.currentPointer, { platform, target, fsImpl });
      if (pointer.version !== version) throw new Error("Stable repair current pointer changed.");
    } else {
      const stat = await fsImpl.lstat(paths.currentLink!);
      if (!stat.isSymbolicLink() || pathApi.resolve(paths.installRoot, await fsImpl.readlink(paths.currentLink!)) !== expected) {
        throw new Error("Stable repair current pointer changed.");
      }
    }
    return expected;
  };
  const stop = async () => {
    if (platform === "win32") {
      // Already stopped is normal on interruption recovery. Locked release
      // renames still fail boundedly rather than deleting a running payload.
      await stopWindowsShellImpl({ platform }).catch(() => null);
    } else {
      let loaded = false;
      try {
        await execFileImpl("/bin/launchctl", ["print", `gui/${uid}/${EQUINOX_LOCAL_LAUNCH_AGENT_LABEL}`], { timeout: 5_000, maxBuffer: 64 * 1024 });
        loaded = true;
      } catch (error) {
        if (![3, 113].includes((error as {code?:number}).code!) && (error as ErrorCode)?.code !== "ENOENT") throw error;
      }
      if (loaded) await execFileImpl("/bin/launchctl", ["bootout", `gui/${uid}/${EQUINOX_LOCAL_LAUNCH_AGENT_LABEL}`], { timeout: 15_000, maxBuffer: 64 * 1024 });
    }
  };
  const restart = async () => {
    if (platform === "win32") await launchWindowsShellImpl(pathApi.join(paths.programRoot, "EquinoxLocal.exe"));
    else await reloadLaunchAgent(installation, { uid, execFileImpl });
  };
  const health = (version:string,kind:string) => waitForVersionImpl(version, {
    ...equinoxLocalFirstInstallHealthBudget({ platform, arch }), expectedInstallationKind: kind,
  });
  const cleanup = async () => {
    // Keep the record until both trees are gone: an interrupted recursive rm
    // can be retried without demanding an intact, already-retired A payload.
    for (const root of [oldRelease, failedRelease]) {
      const stat = await statOrNull(root);
      if (stat) {
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Stable repair cleanup path is unsafe.");
        await validateReleaseTree(root, { fsImpl });
        await fsImpl.rm(root, { recursive: true });
      }
    }
    await fsImpl.rm(recordPath);
    await fsImpl.rmdir(backupRoot);
  };

  let record:RepairRecord;
  if (await statOrNull(backupRoot)) {
    await assertOwnedNormalDirectory(backupRoot, { uid, platform, fsImpl });
    if (await fsImpl.realpath(backupRoot) !== backupRoot) throw new Error("Stable repair backup path is not canonical.");
    const names = await fsImpl.readdir(backupRoot);
    if (names.some((name) => !["repair.json", ".repair-next.json", "release", "failed-release"].includes(name))) {
      throw new Error("Stable repair backup contains unexpected files.");
    }
    if (!names.includes("repair.json")) {
      // Preparation was interrupted before any live files could be moved.
      if (names.some((name) => name !== ".repair-next.json")) throw new Error("Stable repair backup has no identity record.");
      if (names.length) {
        await assertNormalFile(temporaryRecord, "Stable repair temporary record", { fsImpl });
        await fsImpl.rm(temporaryRecord);
      }
      await fsImpl.rmdir(backupRoot);
      return null;
    }
    if (names.includes(".repair-next.json")) throw new Error("Stable repair contains conflicting identity records.");
    const file = await readBoundedNormalFile(recordPath, { fsImpl, platform, minBytes: 1, maxBytes: 16 * 1024, encoding: "utf8", label: "Stable repair record" });
    record = JSON.parse(file.data);
    exactKeys(record, ["schemaVersion", "version", "target", "mainStamp", "oldSha256", "stableSha256", "nativeSourceSha"], "Stable repair record");
    parseEquinoxVersion(record.version);
    validateManagedSourceInstallStamp(JSON.parse(record.mainStamp));
    if (record.schemaVersion !== 1 || record.target !== target ||
        !/^[a-f0-9]{64}$/u.test(record.oldSha256) || !/^[a-f0-9]{64}$/u.test(record.stableSha256) ||
        (record.nativeSourceSha !== null && !/^[a-f0-9]{40}$/u.test(record.nativeSourceSha))) {
      throw new Error("Stable repair record identity is invalid.");
    }
  } else if (!candidate) {
    // A parked selector without our full-tree backup belongs to another
    // operation. Never silently treat that state as a fresh Stable install.
    if (await statOrNull(savedStamp)) throw new Error("Prior Stable replacement needs reconciliation before another attempt.");
    return null;
  } else {
    const targetRelease = await assertPointer(candidate.version);
    if (installation.releaseDir !== targetRelease) throw new Error("Same-version Main release path is inconsistent.");
    const old = await validateFirstInstallRelease(targetRelease, { target, fsImpl });
    if (old.version !== candidate.version) throw new Error("Same-version Main release identity is inconsistent.");
    if (await readStamp(mainPaths.installStampPath) !== mainStamp || await statOrNull(savedStamp)) throw new Error("Stable repair Main identity changed.");
    const native = await nativePointer(candidate.version);
    record = { schemaVersion: 1, version: candidate.version, target, mainStamp:mainStamp!,
      oldSha256: await fingerprint(targetRelease), stableSha256: await fingerprint(candidate.releaseDir), nativeSourceSha: native?.sourceSha ?? null };
    await fsImpl.mkdir(backupRoot, { mode: 0o700 });
    if (await fsImpl.realpath(backupRoot) !== backupRoot) throw new Error("Stable repair backup path is not canonical.");
    const handle = await fsImpl.open(temporaryRecord, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(record)}\n`); await handle.sync(); } finally { await handle.close(); }
    await fsImpl.rename(temporaryRecord, recordPath);
  }

  const targetRelease = await assertPointer(record.version);
  const liveStamp = await readStamp(mainPaths.installStampPath);
  const parkedStamp = await readStamp(savedStamp);
  if ((liveStamp && parkedStamp) || (liveStamp && liveStamp !== record.mainStamp) || (parkedStamp && parkedStamp !== record.mainStamp)) {
    throw new Error("Stable repair Main selector contains unexpected state.");
  }
  if (!liveStamp && !parkedStamp) {
    // B was committed; A may already be partially deleted. Never resurrect
    // Main just because post-HEALTHY housekeeping was interrupted.
    await assertFingerprint(targetRelease, record.stableSha256);
    await restart();
    await health(record.version, "managed");
    await cleanup();
    return { status: "activated", version: record.version, previousVersion: record.version, configCreated: false };
  }
  const native = await nativePointer(record.version);
  if ((native?.sourceSha ?? null) !== record.nativeSourceSha) throw new Error("Stable repair old native pointer changed.");
  const rollback = async () => {
    const backedUp = await statOrNull(oldRelease);
    await assertFingerprint(backedUp ? oldRelease : targetRelease, record.oldSha256);
    if (backedUp && await statOrNull(targetRelease)) {
      await assertFingerprint(targetRelease, record.stableSha256);
      if (await statOrNull(failedRelease)) throw new Error("Stable repair has duplicate candidate trees.");
    }
    await stop();
    const activeRelease = await statOrNull(targetRelease);
    // If interruption occurred between moving A out and promoting B, the
    // native host was never changed. On Windows the numbered A tree can
    // legitimately differ from the active Main native-store shell, so do not
    // treat that numbered tree as evidence of WPF or Native Messaging ownership.
    if (native && activeRelease) {
      await syncManagedShellImpl(installation, { version: record.version,
        releaseDir: native.releaseDir, previousReleaseDir: targetRelease });
    }
    if (backedUp) {
      if (activeRelease) await rename(targetRelease, failedRelease);
      await rename(oldRelease, targetRelease);
    }
    if (!native && platform === "win32" && await statOrNull(failedRelease)) {
      // A classic Main enrollment uses releases/<version> as its ONLY
      // native-host launcher. Restore A at that same address *before* the
      // native sync, so the manifest never points at a removed backup tree.
      await syncManagedShellImpl(installation, { version: record.version,
        releaseDir: targetRelease, previousReleaseDir: failedRelease });
    }
    if (await readStamp(savedStamp)) await fsImpl.rename(savedStamp, mainPaths.installStampPath);
    await restart();
    await health(record.version, "managed-source");
    await cleanup();
  };
  if (!candidate) {
    await rollback();
    return null;
  }
  try {
    await stop();
    await rename(targetRelease, oldRelease);
    await rename(candidate.releaseDir, targetRelease);
    await fsImpl.rename(mainPaths.installStampPath, savedStamp);
    await syncManagedShellImpl(installation, { version: record.version, releaseDir: targetRelease,
      previousReleaseDir: native?.releaseDir ?? oldRelease });
    await restart();
    await health(record.version, "managed");
  } catch (error) {
    try { await rollback(); } catch (recoveryError) {
      throw new AggregateError([error, recoveryError], "Same-version Stable repair failed; Main rollback needs recovery on the next installer invocation.");
    }
    throw new Error("Same-version Stable repair failed and was rolled back to Main.", { cause: error });
  }
  await fsImpl.rm(savedStamp);
  await cleanup();
  return { status: "activated", version: record.version, previousVersion: record.version, configCreated: false };
}

// Retain the existing API/CLI opt-in for fresh enrollment too.
// Provenance alone is never user consent to leave Stable.
export async function installManagedEquinoxRelease({
  stagedReleaseDir,
  homeDir = os.homedir(),
  uid = typeof process.getuid === "function" ? process.getuid() : null,
  platform = process.platform,
  arch = process.arch,
  target = null,
  allowExistingStableToMainMigration = false,
  env = process.env,
  fsImpl = fs,
  execFileImpl = execFile,
  bootstrapImpl = bootstrapManagedEquinoxUser,
  readCurrentImpl = readManagedCurrentRelease,
  readMainSourcePointerImpl = readEquinoxLocalMainSourcePointer,
  readMainNativePointerImpl = readEquinoxLocalMainNativePointer,
  pruneStableImpl = (installation) => pruneInactiveManagedStableReleases(installation, { readCurrent: readManagedCurrentRelease }),
  activateImpl = activatePreparedEquinoxRelease,
  waitForVersionImpl = waitForEquinoxLocalVersion,
  waitForManagedSourceImpl = waitForEquinoxLocalManagedSource,
  enrollManagedSourceImpl = enrollEquinoxLocalManagedSource,
  rollbackManagedSourceImpl = rollbackEquinoxLocalManagedSourceEnrollment,
  requestWindowsRestartImpl = requestWindowsShellRuntimeRestart,
  initializeOnboardingImpl = initializeManagedOnboardingState,
  syncWindowsShellImpl = synchronizeFreshWindowsShell,
  syncManagedShellImpl = synchronizeManagedShellForRelease,
  stopWindowsShellImpl = requestWindowsShellUpdateShutdown,
  launchWindowsShellImpl = launchWindowsStableShell,
  verifyWindowsShellOwnedImpl = assertWindowsStableShellOwnedByRelease,
  verifyWindowsNativeHostOwnedImpl = assertWindowsNativeMessagingHostOwnership,
  waitWindowsPipeReleaseImpl = waitForWindowsShellPipeRelease,
  windowsRenameSleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  inspectLegacyMainHostImpl = inspectLegacyWindowsMainHost,
}:FirstInstallOptions) {
  if (platform !== "darwin" && !(platform === "win32" && ["arm64", "x64"].includes(arch))) {
    throw new Error(`Equinox Local first install is not implemented for ${platform}-${arch}.`);
  }
  const nativeTarget = equinoxLocalUpdateTarget({ platform, arch });
  const expectedTarget = target || nativeTarget;
  if (platform === "win32" && expectedTarget !== nativeTarget) {
    throw new Error(`Windows first install target ${expectedTarget} does not match native ${nativeTarget}.`);
  }
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (platform === "darwin" && (!Number.isInteger(uid) || uid! < 1)) throw new Error("Do not run the Equinox Local installer with sudo or as root.");
  if (typeof homeDir !== "string" || !pathApi.isAbsolute(homeDir)) throw new Error("A trusted absolute HOME is required for Equinox Local first install.");

  const homeStat = await fsImpl.lstat(homeDir);
  if (!homeStat.isDirectory() || homeStat.isSymbolicLink()) throw new Error("The current HOME directory is unsafe.");
  if (platform === "darwin" && Number.isInteger(homeStat.uid) && homeStat.uid !== uid) throw new Error("The current HOME directory is not owned by the current user.");

  if (typeof allowExistingStableToMainMigration !== "boolean") {
    throw new Error("Existing Stable-to-Main migration requires an explicit boolean opt-in.");
  }
  const paths = managedSupervisorPaths(homeDir, { platform, arch, env });
  const stagingRoot = pathApi.join(paths.installRoot, "staging");
  await assertOwnedNormalDirectory(paths.installRoot, { uid, platform, fsImpl, create: true });
  await assertOwnedNormalDirectory(paths.releasesRoot, { uid, platform, fsImpl, create: true });
  await assertOwnedNormalDirectory(stagingRoot, { uid, platform, fsImpl, create: true });

  const baseInstallation = installationFor(paths, null, { platform, arch, target: expectedTarget });
  const mainPaths = equinoxLocalManagedSourcePaths({ platform, arch, homeDir, env });
  const repairOptions = { paths, mainPaths, installation: baseInstallation, uid, platform, arch, target: expectedTarget,
    fsImpl, execFileImpl, syncManagedShellImpl, stopWindowsShellImpl, launchWindowsShellImpl, waitForVersionImpl,
    windowsRenameSleepImpl, inspectLegacyMainHostImpl };
  const classicJournalPath = pathApi.join(mainPaths.mainTransactionRoot, "classic-repair.json");
  if (platform === "win32" && !allowExistingStableToMainMigration) {
    const readStoredStamp = async (filePath:string) => {
      const file = await readBoundedNormalFile(filePath, {
        fsImpl, platform, minBytes: 2, maxBytes: 8 * 1024,
        encoding: "utf8", label: "Windows classic Main recovery stamp",
      }).catch((error) => {
        if ((error as ErrorCode)?.code === "ENOENT") return null;
        throw error;
      });
      if (file) validateManagedSourceInstallStamp(JSON.parse(file.data));
      return file?.data ?? null;
    };
    const verifiedPrevious = async (record:{oldSourceSha:string;oldNativeSha:string;oldMainVersion:string}) => {
      const active = await fsImpl.lstat(pathApi.join(mainPaths.mainTransactionRoot, "active.json")).catch((error) => {
        if ((error as ErrorCode)?.code === "ENOENT") return null;
        throw error;
      });
      if (active) throw new Error("An active Main transaction must finish before recovering classic Stable repair.");
      const contract = equinoxLocalToolchainContract({
        runtimeRoot: path.win32.join(paths.installRoot, "runtime"), target: expectedTarget,
      });
      const source = await readMainSourcePointerImpl(mainPaths.sourcePointerPath, {
        fsImpl, execFileImpl, gitPath: contract.gitPath,
      });
      if (source.sha !== record.oldSourceSha ||
          path.win32.normalize(source.sourceRoot).toLowerCase() !==
            path.win32.join(mainPaths.mainTransactionRoot, "sources", record.oldSourceSha).toLowerCase()) {
        throw new Error("Classic repair rollback Main checkout SHA differs from its durable record.");
      }
      const pointer = await readMainNativePointerImpl(path.win32.join(mainPaths.mainTransactionRoot, "current-native.json"), {
        transactionRoot: mainPaths.mainTransactionRoot, fsImpl,
      });
      if (pointer.target !== expectedTarget || pointer.sourceSha !== record.oldNativeSha) {
        throw new Error("Classic repair native rollback SHA changed during interrupted handoff.");
      }
      const declarationPath = path.win32.join(source.sourceRoot, "src", "equinox-local-version.js");
      const file = await readBoundedNormalFile(declarationPath, {
        fsImpl, platform, minBytes: 25, maxBytes: 1024, encoding: "utf8",
        label: "Classic repair native Main source version",
      });
      const versionLine = /^export const EQUINOX_LOCAL_VERSION = "(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)";$/mu.exec(file.data);
      if (!versionLine || `${versionLine[1]}.${versionLine[2]}.${versionLine[3]}` !== record.oldMainVersion) {
        throw new Error("Classic repair source version differs from its recorded Main rollback.");
      }
      return pointer;
    };
    const recover = await reconcileWindowsClassicRepairJournal({
      journalPath: classicJournalPath, expectedTarget,
      fsImpl,
      readStamp: async () => ({
        live: await readStoredStamp(mainPaths.installStampPath),
        parked: await readStoredStamp(`${mainPaths.installStampPath}.stable-install-backup`),
      }),
      readCurrentVersion: async () => (await readEquinoxLocalCurrentVersionPointer(paths.currentPointer, {
        fsImpl, platform, target: expectedTarget,
      })).version,
      verifyPrevious: verifiedPrevious,
      isPreviousMainHealthy: async (record) => {
        try {
          const native = await verifiedPrevious(record);
          await verifyWindowsShellOwnedImpl({
            releaseDir: native.releaseDir, programRoot: paths.programRoot, fsImpl,
          });
          await verifyWindowsNativeHostOwnedImpl({
            manifestRoot: paths.nativeMessagingManifestRoot,
            acceptedLauncherPaths: [windowsNativeMessagingLauncherPath(native.releaseDir)],
            fsImpl,
          });
          await waitForManagedSourceImpl(record.oldMainVersion, record.oldSourceSha, {
            ...equinoxLocalFirstInstallHealthBudget({ platform, arch }), attempts: 4,
          });
          return true;
        } catch { return false; }
      },
      isCommittedStableHealthy: async (record) => {
        try {
          const signed = await readCurrentImpl(baseInstallation);
          if (signed.version !== record.targetVersion) return false;
          await verifyWindowsShellOwnedImpl({
            releaseDir: signed.releaseDir, programRoot: paths.programRoot, fsImpl,
          });
          await verifyWindowsNativeHostOwnedImpl({
            manifestRoot: paths.nativeMessagingManifestRoot,
            acceptedLauncherPaths: [windowsNativeMessagingLauncherPath(signed.releaseDir)],
            fsImpl,
          });
          await waitForVersionImpl(record.targetVersion, {
            ...equinoxLocalFirstInstallHealthBudget({ platform, arch }),
            attempts: 4, expectedInstallationKind: "managed",
          });
          return true;
        } catch { return false; }
      },
      rollbackPreviousMain: async (record, { parked }) => {
        const oldNative = await verifiedPrevious(record);
        const signedB = path.win32.join(paths.releasesRoot, record.targetVersion);
        await stopWindowsShellImpl({ platform: "win32" }).catch(() => null);
        await writeEquinoxLocalCurrentVersionPointer(paths.currentPointer, {
          fsImpl, platform, target: expectedTarget, version: record.oldStablePointerVersion,
        });
        if (parked) await fsImpl.rename(`${mainPaths.installStampPath}.stable-install-backup`, mainPaths.installStampPath);
        await syncManagedShellImpl(baseInstallation, {
          version: record.oldMainVersion, releaseDir: oldNative.releaseDir,
          previousReleaseDir: signedB,
        });
        await waitWindowsPipeReleaseImpl({ platform: "win32" });
        await launchWindowsShellImpl(path.win32.join(paths.programRoot, "EquinoxLocal.exe"));
        await waitForManagedSourceImpl(record.oldMainVersion, record.oldSourceSha,
          equinoxLocalFirstInstallHealthBudget({ platform, arch }));
      },
    });
    if (recover) {
      // Stop after safe recovery; a second explicit installer invocation may
      // install B. Never silently resume a partially interrupted replacement
      // with an unverified/stale staged candidate.
      return Object.freeze({
        status: recover.status, version: recover.version, configCreated: false,
        controlCenterUrl: "http://127.0.0.1:24891/",
      });
    }
  }

  // Recovery must precede even current-release resolution: the unchanged
  // pointer can temporarily name the missing directory between two renames.
  if (!allowExistingStableToMainMigration) {
    const recovered = await repairSameVersionMain(repairOptions);
    if (recovered) return Object.freeze({ ...recovered, controlCenterUrl: "http://127.0.0.1:24891/" });
  } else {
    const backup = await fsImpl.lstat(pathApi.join(paths.installRoot, ".stable-repair-backup")).catch((error) => {
      if ((error as ErrorCode)?.code === "ENOENT") return null;
      throw error;
    });
    if (backup) throw new Error("Classic Stable installer recovery must complete before Main enrollment.");
  }

  const stagedReal = await fsImpl.realpath(stagedReleaseDir);
  const stagingReal = await fsImpl.realpath(stagingRoot);
  if (!inside(stagingReal, stagedReal, pathApi)) throw new Error("Staged Equinox Local release escaped the managed staging directory.");
  const candidate = await validateFirstInstallRelease(stagedReal, { target: expectedTarget, fsImpl });
  const targetRelease = pathApi.join(paths.releasesRoot, candidate.version);
  if (pathApi.dirname(targetRelease) !== paths.releasesRoot) throw new Error("Candidate release path escaped the managed releases root.");

  let current:{version:string;releaseDir:string}|null = null;
  try {
    current = await readCurrentImpl(baseInstallation);
  } catch (error) {
    if ((error as ErrorCode)?.code !== "ENOENT") throw error;
  }

  if (!current && allowExistingStableToMainMigration && !candidate.metadata?.sourceSha) {
    throw new Error("Main enrollment requires exact source provenance in the requested Stable release.");
  }

  const startRuntime = async (installation:Install) => {
    if (platform === "darwin") {
      await reloadLaunchAgent(installation, { uid, execFileImpl });
      return;
    }
    const shell = await syncWindowsShellImpl({ releaseDir: installation.releaseDir, programRoot: installation.programRoot, fsImpl });
    await provisionWindowsGuardianFromRelease({ installation:installation as NonNullable<NonNullable<Parameters<typeof provisionWindowsGuardianFromRelease>[0]>["installation"]>, fsImpl });
    await launchWindowsShellImpl(shell.shellExecutable);
  };

  const enrollAfterStableHealth = async (installation:Install,candidateValue:Release) => {
    const bootstrapSha = candidateValue.metadata?.sourceSha ?? null;
    if (!bootstrapSha) return null;
    let enrollment;
    try {
      enrollment = await enrollManagedSourceImpl({
        bootstrapSha,
        target: expectedTarget,
        platform,
        arch,
        homeDir,
        env,
        fsImpl,
        execFileImpl,
        windowsZipHelperPath: platform === "win32"
          ? path.win32.join(installation.releaseDir!, "equinox-local-windows-release-zip.ps1")
          : undefined,
        windowsPrivateStateHelperPath: platform === "win32"
          ? path.win32.join(installation.releaseDir!, "equinox-local-windows-private-state.ps1")
          : undefined,
        stableReleaseDir: platform === "win32" ? installation.releaseDir : undefined,
      });
      if (platform === "darwin") await reloadLaunchAgent(installation, { uid, execFileImpl });
      else await requestWindowsRestartImpl({ platform: "win32" });
      await waitForManagedSourceImpl(candidateValue.version, bootstrapSha, equinoxLocalFirstInstallHealthBudget({ platform, arch }));
      return enrollment;
    } catch (error) {
      let rollback = null;
      try {
        rollback = await rollbackManagedSourceImpl({
          bootstrapSha, target: expectedTarget, platform, arch, homeDir, env, fsImpl, execFileImpl,
        });
        if (rollback?.rolledBack) {
          if (platform === "darwin") await reloadLaunchAgent(installation, { uid, execFileImpl });
          else await requestWindowsRestartImpl({ platform: "win32" });
          await waitForVersionImpl(candidateValue.version, equinoxLocalFirstInstallHealthBudget({ platform, arch }));
        }
      } catch (rollbackError) {
        const primary = error instanceof Error ? error.message : String(error);
        const recovery = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        throw new Error(`Managed-source enrollment failed and Stable recovery did not complete: ${primary}; recovery: ${recovery}`);
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${reason} Stable Equinox Local remains installed${rollback?.rolledBack ? " and was restored healthy" : " and healthy"}; managed-source enrollment can be retried.`);
    }
  };

  const savedMainStamp = `${mainPaths.installStampPath}.stable-install-backup`;
  let parkedMain = false;
  // Read identity through one checked file descriptor; lstat+readFile
  // permitted symlink/path replacement between the check and the read.
  const currentMainStamp = await readBoundedNormalFile(mainPaths.installStampPath, {
    fsImpl, platform, minBytes: 1, maxBytes: 8 * 1024,
    encoding: "utf8", label: "Existing Main install identity",
  }).catch((error) => {
    if ((error as ErrorCode)?.code === "ENOENT") return null;
    throw error;
  });
  if (currentMainStamp) {
    validateManagedSourceInstallStamp(JSON.parse(currentMainStamp.data));
    try {
      await fsImpl.lstat(savedMainStamp);
      throw new Error("Prior Stable replacement needs reconciliation before another attempt.");
    } catch (error) {
      if ((error as ErrorCode)?.code !== "ENOENT") throw error;
    }
  }

  let previousMainNativeReleaseDir:string|null = null;
  let previousManagedMain:{version:string;sourceSha:string;releaseDir:string;stablePointerVersion:string}|null = null;
  if (currentMainStamp && platform === "win32") {
    const pointerPath = path.win32.join(mainPaths.mainTransactionRoot, "current-native.json");
    const nativePointer = await readMainNativePointerImpl(pointerPath, {
      transactionRoot: mainPaths.mainTransactionRoot, fsImpl,
    }).catch((error) => {
      if ((error as ErrorCode)?.code === "ENOENT") return null;
      throw error;
    });
    if (nativePointer) {
      if (nativePointer.target !== expectedTarget) throw new Error("Existing Main native architecture differs from signed installer.");
      previousMainNativeReleaseDir = nativePointer.releaseDir;
      // The legacy numbered Stable current-version can lag a healthy Main B
      // checkout, while source-only updates can retain an even older native
      // payload. Neither is the version of the RUNNING Main server.
    }
    if (!allowExistingStableToMainMigration && nativePointer &&
        !(current && compareEquinoxVersions(current.version, candidate.version) === 0)) {
      // Legacy same-version Main repair has its own full-tree backup journal
      // and can legitimately predate source-pointer enrollment. Do not
      // require a nonexistent Main source checkout before that recovery path.
      // Use the exact authenticated Main source + native A as the rollback
      // identity whether the obsolete numbered Stable tree has already been
      // reclaimed OR still exists pending post-health cleanup.
      // The legacy Stable pointer is only the fallback pointer to restore.
      const lock = await fsImpl.lstat(path.win32.join(mainPaths.mainTransactionRoot, "active.json")).catch((error) => {
        if ((error as ErrorCode)?.code === "ENOENT") return null;
        throw error;
      });
      if (lock) throw new Error("Classic reinstall is blocked until the active Main transaction has been reconciled.");
      const legacyPointer = await readEquinoxLocalCurrentVersionPointer(paths.currentPointer, {
        platform, target: expectedTarget, fsImpl,
      });
      const legacyRoot = path.win32.join(paths.releasesRoot, legacyPointer.version);
      const legacyStat = await fsImpl.lstat(legacyRoot).catch((error) => {
        if ((error as ErrorCode)?.code === "ENOENT") return null;
        throw error;
      });
      if (legacyStat && (!legacyStat.isDirectory() || legacyStat.isSymbolicLink() ||
          !current || path.win32.normalize(current.releaseDir).toLowerCase() !==
            path.win32.normalize(legacyRoot).toLowerCase())) {
        throw new Error("Existing Main Stable baseline is inconsistent, foreign or unsafe.");
      }
      const productGit = equinoxLocalToolchainContract({
        runtimeRoot: path.win32.join(paths.installRoot, "runtime"), target: expectedTarget,
      }).gitPath;
      const source = await readMainSourcePointerImpl(mainPaths.sourcePointerPath, {
        fsImpl, execFileImpl, gitPath: productGit,
      });
      if (!/^[a-f0-9]{40}$/u.test(source?.sha ?? "") ||
          !path.win32.isAbsolute(source.sourceRoot) ||
          path.win32.normalize(source.sourceRoot).toLowerCase() !==
            path.win32.normalize(path.win32.join(mainPaths.mainTransactionRoot, "sources", source.sha)).toLowerCase()) {
        throw new Error("Installed Main source does not match the authenticated product-owned checkout.");
      }
      const versionFile = path.win32.join(source.sourceRoot, "src", "equinox-local-version.js");
      const { data: declaration } = await readBoundedNormalFile(versionFile, {
        fsImpl, platform, minBytes: 25, maxBytes: 1024,
        encoding: "utf8", label: "Installed Main version declaration",
      });
      const match = /^export const EQUINOX_LOCAL_VERSION = "(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)";$/mu.exec(declaration);
      if (!match) throw new Error("Installed Main version declaration is invalid.");
      const mainVersion = `${match[1]}.${match[2]}.${match[3]}`;
      previousManagedMain = Object.freeze({
        version: mainVersion, sourceSha: source.sha, releaseDir: nativePointer.releaseDir,
        stablePointerVersion: legacyPointer.version,
      });
      current = Object.freeze({ version: mainVersion, releaseDir: nativePointer.releaseDir });
    }
  }

  if (!current && currentMainStamp) {
    throw new Error("Existing Main identity has no verified rollback runtime; refusing destructive Stable repair.");
  }
  if (current) {
    const comparison = compareEquinoxVersions(current.version, candidate.version);
    if (allowExistingStableToMainMigration && comparison !== 0) {
      throw new Error("Upgrade the existing Stable release with the Stable updater before explicitly enrolling Main; installer migration cannot replace a different active Stable version.");
    }
    if (comparison > 0 && !currentMainStamp) {
      return Object.freeze({
        status: "newer-installed",
        version: current.version,
        requestedVersion: candidate.version,
        controlCenterUrl: "http://127.0.0.1:24891/",
      });
    }
    if (comparison === 0 && currentMainStamp && !allowExistingStableToMainMigration && !previousManagedMain) {
      const result = await repairSameVersionMain({ ...repairOptions, candidate, mainStamp: currentMainStamp!.data,
        installation: installationFor(paths, current.releaseDir, { platform, arch, target: expectedTarget }) });
      return Object.freeze({ ...result, controlCenterUrl: "http://127.0.0.1:24891/" });
    }
    if (comparison === 0 && !previousManagedMain) {
      // Re-running the website installer is not consent to move an existing
      // numbered Stable installation onto Main. Explicit migration requires
      // matching installed provenance, not just the staged download's stamp.
      if (allowExistingStableToMainMigration) {
        if (!candidate.metadata?.sourceSha) {
          throw new Error("Stable-to-Main migration requires exact source provenance in the requested Stable release.");
        }
        const installed = await validateFirstInstallRelease(current.releaseDir, { target: expectedTarget, fsImpl });
        if (installed.version !== current.version || installed.metadata.sourceSha !== candidate.metadata.sourceSha) {
          throw new Error("Existing Stable release source provenance does not match the requested Main enrollment.");
        }
      }
      const installation = installationFor(paths, current.releaseDir, { platform, arch, target: expectedTarget });
      const bootstrap = await bootstrapImpl({ homeDir, platform, arch, env, fsImpl });
      await initializeOnboardingImpl({ installation, homeDir });
      await startRuntime(installation);
      await waitForVersionImpl(current.version, equinoxLocalFirstInstallHealthBudget({ platform, arch }));
      const enrollment = allowExistingStableToMainMigration
        ? await enrollAfterStableHealth(installation, candidate)
        : null;
      return Object.freeze({
        status: "already-installed",
        version: current.version,
        managedSourceSha: enrollment?.bootstrapSha ?? null,
        configCreated: Boolean(bootstrap.configCreated),
        controlCenterUrl: bootstrap.controlCenterUrl || "http://127.0.0.1:24891/",
      });
    }
    // Both Windows and macOS use the existing signed native activation,
    // health check and automatic rollback below for a different version.
  }

  const existing = await fsImpl.lstat(targetRelease).catch((error) => {
    if ((error as ErrorCode)?.code === "ENOENT") return null;
    throw error;
  });
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error("Existing target release path is unsafe.");
    if (current?.releaseDir === targetRelease) throw new Error("Active target release state is inconsistent.");
    await fsImpl.rm(targetRelease, { recursive: true, force: false });
  }
  if (platform === "win32") {
    await renameWindowsPathWhenUnlocked(stagedReal, targetRelease, { fsImpl, sleepImpl: windowsRenameSleepImpl });
  } else {
    await fsImpl.rename(stagedReal, targetRelease);
  }

  if (current) {
    const currentInstallation = installationFor(paths, current.releaseDir, { platform, arch, target: expectedTarget });
    await bootstrapImpl({ homeDir, platform, arch, env, fsImpl });
    // Existing Main sources must not override the freshly installed Stable
    // runtime. Park ONLY the authenticated Main channel selector while B is
    // started; restore it before the old A is relaunched on failed B health.
    const restoreMainIdentity = async () => {
      if (!parkedMain) return;
      await fsImpl.rename(savedMainStamp, mainPaths.installStampPath);
      parkedMain = false;
    };
    let activation;
    if (previousManagedMain) {
      const priorNative = await readMainNativePointerImpl(
        path.win32.join(mainPaths.mainTransactionRoot, "current-native.json"),
        { transactionRoot: mainPaths.mainTransactionRoot, fsImpl },
      );
      await writeWindowsClassicRepairJournal(classicJournalPath, {
        schemaVersion: 1, target: expectedTarget,
        oldMainVersion: previousManagedMain.version,
        oldSourceSha: previousManagedMain.sourceSha,
        oldNativeSha: priorNative.sourceSha,
        oldStablePointerVersion: previousManagedMain.stablePointerVersion,
        targetVersion: candidate.version,
        mainStamp: currentMainStamp!.data,
      }, { fsImpl });
    }
    try {
      activation = await activateImpl({
        installation: currentInstallation,
        targetVersion: candidate.version,
        healthAttempts: equinoxLocalFirstInstallHealthBudget({ platform, arch }).attempts,
        ...(previousMainNativeReleaseDir ? { previousMainNativeReleaseDir } : {}),
        ...(previousManagedMain ? { previousManagedMain } : {}),
      ...(currentMainStamp ? { kickstartImpl: async (version:string) => {
        if (version === candidate.version && !parkedMain) {
          await fsImpl.rename(mainPaths.installStampPath, savedMainStamp);
          parkedMain = true;
        } else if (version === current.version) {
          await restoreMainIdentity();
        }
        if (platform === "darwin") {
          await kickstartEquinoxLocalLaunchAgent(currentInstallation as Parameters<typeof kickstartEquinoxLocalLaunchAgent>[0], { uid, execFileImpl });
        } else {
          // Old shipped WPF acknowledges the update shutdown request before
          // releasing its single-instance coordinator. Await actual pipe
          // release; otherwise a new WPF can exit as a duplicate.
          await waitForWindowsShellPipeRelease({ platform });
          return launchWindowsShellImpl(path.win32.join(paths.programRoot, "EquinoxLocal.exe"));
        }
      } } : {}),
      });
    } catch (error) {
      // Even if OS-native rollback failed before it could relaunch A,
      // do not strand A's original authenticated Main channel identity.
      await restoreMainIdentity();
      throw error;
    }
    if (parkedMain) {
      await fsImpl.rm(savedMainStamp);
      parkedMain = false;
    }
    if (previousManagedMain) await fsImpl.rm(classicJournalPath);
    const bootstrap = await bootstrapImpl({ homeDir, platform, arch, env, fsImpl });
    if (activation.status === "activated") {
      // Classic PowerShell reinstall is also a public update path. A signed
      // B which already passed WPF/Native Messaging and exact-version health
      // may reclaim old A bundles, exactly like the Control Center updater.
      // A failed or rolling-back update must NEVER remove A.
      try {
        await pruneStableImpl(installationFor(paths, targetRelease, {
          platform, arch, target: expectedTarget,
        }));
      } catch (error) {
        process.stderr.write(`[Equinox Local] Prior Stable release cleanup pending: ${String((error as ErrorCode)?.message ?? error).slice(0, 220)}\n`);
      }
    }
    return Object.freeze({
      status: activation.status,
      version: candidate.version,
      previousVersion: activation.previousVersion,
      configCreated: Boolean(bootstrap.configCreated),
      controlCenterUrl: bootstrap.controlCenterUrl || "http://127.0.0.1:24891/",
    });
  }

  await atomicInitialCurrentPointer(paths, targetRelease, candidate, {
    platform,
    target: expectedTarget,
    fsImpl,
  });
  const installation = installationFor(paths, targetRelease, { platform, arch, target: expectedTarget });
  const bootstrap = await bootstrapImpl({ homeDir, platform, arch, env, fsImpl });
  try {
    await initializeOnboardingImpl({ installation, homeDir });
    await startRuntime(installation);
    await waitForVersionImpl(candidate.version, equinoxLocalFirstInstallHealthBudget({ platform, arch }));
  } catch (error) {
    let diagnostics = "";
    if (platform === "darwin") {
      diagnostics = await firstInstallActivationDiagnostics({ homeDir, uid, execFileImpl, fsImpl });
      await execFileImpl("/bin/launchctl", ["bootout", `gui/${uid}/${EQUINOX_LOCAL_LAUNCH_AGENT_LABEL}`], {
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      }).catch(() => ({ stdout: "", stderr: "" }));
    } else if (platform === "win32") {
      diagnostics = await windowsFirstInstallActivationDiagnostics({ paths, fsImpl });
    }
    const reason = error instanceof Error ? error.message : String(error);
    const detail = diagnostics ? ` ${diagnostics}` : "";
    throw new Error(`${reason} First-install files were preserved so the verified release can be retried safely.${detail}`);
  }
  const enrollment = allowExistingStableToMainMigration
    ? await enrollAfterStableHealth(installation, candidate)
    : null;

  return Object.freeze({
    status: "installed",
    version: candidate.version,
    managedSourceSha: enrollment?.bootstrapSha ?? null,
    configCreated: Boolean(bootstrap.configCreated),
    controlCenterUrl: bootstrap.controlCenterUrl || "http://127.0.0.1:24891/",
  });
}

function parseCli(argv:string[]) {
  if ((argv.length !== 2 && argv.length !== 3) || argv[0] !== "--staged-release" || !path.isAbsolute(argv[1]!) ||
      (argv.length === 3 && argv[2] !== "--enroll-existing-main")) {
    throw new Error("Usage: equinox-local-first-install.js --staged-release /absolute/path/to/release [--enroll-existing-main]");
  }
  return { stagedReleaseDir: argv[1]!, allowExistingStableToMainMigration: argv.length === 3 };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && path.basename(invokedPath) === path.basename(fileURLToPath(import.meta.url))) {
  if (process.argv.length === 3 && process.argv[2] === "--help") {
    process.stdout.write("Usage: equinox-local-first-install.js --staged-release /absolute/path/to/release [--enroll-existing-main]\nBundled internal helper: --enroll-existing-main enrolls Main after signed Stable health.\nPublic installers enroll the admitted Main commit by default; this internal helper without the flag preserves legacy Stable-only recovery.\n");
  } else {
    installManagedEquinoxRelease(parseCli(process.argv.slice(2)))
      .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
      .catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      });
  }
}
