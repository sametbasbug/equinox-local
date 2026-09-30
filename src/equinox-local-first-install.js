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
  readManagedCurrentRelease,
  waitForEquinoxLocalVersion,
} from "./equinox-local-update-activation.js";
import {
  compareEquinoxVersions,
  equinoxLocalUpdateTarget,
  parseEquinoxVersion,
} from "./equinox-local-updater.js";
import { managedSupervisorPaths } from "./equinox-local-supervisor.js";
import { writeEquinoxLocalCurrentVersionPointer } from "./equinox-local-current-release.js";
import { initializeManagedOnboardingState } from "./equinox-local-onboarding.js";
import { equinoxLocalReleaseRuntimeContract } from "./equinox-local-release-runtime-contract.js";
import {
  launchWindowsStableShell,
  synchronizeFreshWindowsShell,
} from "./equinox-local-windows-stable-shell.js";
export {
  sameWindowsStableShellTree,
  snapshotWindowsStableShellTree,
  stageWindowsStableShellForRelease,
  synchronizeFreshWindowsShell,
} from "./equinox-local-windows-stable-shell.js";
export { launchWindowsStableShell as launchFreshWindowsShell } from "./equinox-local-windows-stable-shell.js";

const execFile = promisify(execFileCallback);
const MAX_RELEASE_METADATA_BYTES = 16 * 1024;
const MAX_RELEASE_ENTRIES = 20_000;
const MAX_RELEASE_BYTES = 2 * 1024 * 1024 * 1024;
const FIRST_INSTALL_HEALTH_ATTEMPTS = 120;
const FIRST_INSTALL_HEALTH_DELAY_MS = 500;
const FIRST_INSTALL_DIAGNOSTIC_BYTES = 12 * 1024;

function inside(parent, child, pathApi = path) {
  const relative = pathApi.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !pathApi.isAbsolute(relative);
}

function exactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} contains missing or unsupported fields.`);
  }
}

async function assertOwnedNormalDirectory(directory, {
  uid,
  platform = process.platform,
  fsImpl = fs,
  create = false,
  mode = 0o700,
} = {}) {
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

async function assertNormalFile(filePath, label, { executable = false, maxBytes = null, fsImpl = fs } = {}) {
  const stat = await fsImpl.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a normal file.`);
  if (Number.isFinite(maxBytes) && (stat.size < 1 || stat.size > maxBytes)) throw new Error(`${label} has an invalid size.`);
  if (executable && (stat.mode & 0o111) === 0) throw new Error(`${label} must be executable.`);
  return stat;
}

async function validateReleaseTree(root, { fsImpl = fs } = {}) {
  let entryCount = 0;
  let totalBytes = 0;
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop();
    const entries = await fsImpl.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      entryCount += 1;
      if (entryCount > MAX_RELEASE_ENTRIES) throw new Error("Staged Equinox Local release contains too many entries.");
      const absolute = path.join(directory, entry.name);
      const stat = await fsImpl.lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error("Staged Equinox Local release may not contain symbolic links.");
      if (stat.isDirectory()) {
        stack.push(absolute);
      } else if (stat.isFile()) {
        totalBytes += stat.size;
        if (totalBytes > MAX_RELEASE_BYTES) throw new Error("Staged Equinox Local release exceeds the extracted size limit.");
      } else {
        throw new Error("Staged Equinox Local release contains an unsupported filesystem entry.");
      }
    }
  }
  return Object.freeze({ entryCount, totalBytes });
}

export async function validateFirstInstallRelease(releaseDir, {
  target = equinoxLocalUpdateTarget(),
  fsImpl = fs,
} = {}) {
  if (typeof releaseDir !== "string" || !path.isAbsolute(releaseDir)) {
    throw new Error("Staged Equinox Local release path must be absolute.");
  }
  const rootStat = await fsImpl.lstat(releaseDir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Staged Equinox Local release must be a normal directory.");
  const tree = await validateReleaseTree(releaseDir, { fsImpl });
  const metadataPath = path.join(releaseDir, "release.json");
  await assertNormalFile(metadataPath, "Release metadata", { maxBytes: MAX_RELEASE_METADATA_BYTES, fsImpl });
  const metadata = JSON.parse(await fsImpl.readFile(metadataPath, "utf8"));
  const runtimeContract = equinoxLocalReleaseRuntimeContract({ target, version: metadata.version });
  const metadataKeys = runtimeContract.platform === "darwin"
    ? ["schemaVersion", "version", "target", "nodeVersion", "tunnelClientVersion", "nativeAppShellVersion", "serverEntry"]
    : ["schemaVersion", "version", "target", "nodeVersion", "tunnelClientVersion", "serverEntry"];
  exactKeys(metadata, metadataKeys, "Release metadata");
  if (
    metadata.schemaVersion !== 1 ||
    metadata.target !== target ||
    metadata.serverEntry !== "server.js" ||
    typeof metadata.nodeVersion !== "string" ||
    !/^\d+\.\d+\.\d+$/u.test(metadata.nodeVersion) ||
    typeof metadata.tunnelClientVersion !== "string" ||
    !/^\d+\.\d+\.\d+$/u.test(metadata.tunnelClientVersion) ||
    (runtimeContract.platform === "darwin" && (!Number.isSafeInteger(metadata.nativeAppShellVersion) || metadata.nativeAppShellVersion < 1))
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
    target: metadata.target,
    releaseDir,
    metadata: Object.freeze({ ...metadata }),
    tree,
  });
}

function installationFor(paths, releaseDir, {
  platform = process.platform,
  arch = process.arch,
  target = equinoxLocalUpdateTarget({ platform, arch }),
} = {}) {
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
    stagingRoot: pathApi.join(paths.installRoot, "staging"),
    launchAgentPath: platform === "darwin"
      ? path.posix.join(paths.homeDir, "Library", "LaunchAgents", `${EQUINOX_LOCAL_LAUNCH_AGENT_LABEL}.plist`)
      : null,
    launchAgentLabel: platform === "darwin" ? EQUINOX_LOCAL_LAUNCH_AGENT_LABEL : null,
  });
}

async function atomicInitialCurrentPointer(paths, targetRelease, candidate, {
  platform = process.platform,
  target = candidate.target,
  fsImpl = fs,
} = {}) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const pointerPath = platform === "win32" ? paths.currentPointer : paths.currentLink;
  try {
    await fsImpl.lstat(pointerPath);
    throw new Error("Managed current pointer appeared during first-install promotion.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
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
    await fsImpl.rename(temporary, paths.currentLink);
  } catch (error) {
    await fsImpl.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function boundedDiagnostic(value, maxChars = 1_200) {
  return String(value ?? "")
    .replace(/[\r\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim()
    .slice(-maxChars);
}

async function readDiagnosticTail(filePath, { fsImpl = fs, maxBytes = FIRST_INSTALL_DIAGNOSTIC_BYTES } = {}) {
  if (typeof fsImpl.open !== "function") return null;
  let handle = null;
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

async function firstInstallActivationDiagnostics({ homeDir, uid, execFileImpl = execFile, fsImpl = fs } = {}) {
  const parts = [];
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

async function reloadLaunchAgent(installation, {
  uid,
  execFileImpl = execFile,
} = {}) {
  if (!Number.isInteger(uid) || uid < 1) throw new Error("A non-root user id is required to load Equinox Local.");
  const service = `gui/${uid}/${EQUINOX_LOCAL_LAUNCH_AGENT_LABEL}`;
  await execFileImpl("/bin/launchctl", ["bootout", service], {
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  }).catch(() => ({ stdout: "", stderr: "" }));
  await execFileImpl("/bin/launchctl", ["bootstrap", `gui/${uid}`, installation.launchAgentPath], {
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  await execFileImpl("/bin/launchctl", ["kickstart", service], {
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
}

export async function installManagedEquinoxRelease({
  stagedReleaseDir,
  homeDir = os.homedir(),
  uid = typeof process.getuid === "function" ? process.getuid() : null,
  platform = process.platform,
  arch = process.arch,
  target = null,
  env = process.env,
  fsImpl = fs,
  execFileImpl = execFile,
  bootstrapImpl = bootstrapManagedEquinoxUser,
  readCurrentImpl = readManagedCurrentRelease,
  activateImpl = activatePreparedEquinoxRelease,
  waitForVersionImpl = waitForEquinoxLocalVersion,
  initializeOnboardingImpl = initializeManagedOnboardingState,
  syncWindowsShellImpl = synchronizeFreshWindowsShell,
  launchWindowsShellImpl = launchWindowsStableShell,
} = {}) {
  if (platform !== "darwin" && !(platform === "win32" && ["arm64", "x64"].includes(arch))) {
    throw new Error(`Equinox Local first install is not implemented for ${platform}-${arch}.`);
  }
  const nativeTarget = equinoxLocalUpdateTarget({ platform, arch });
  const expectedTarget = target || nativeTarget;
  if (platform === "win32" && expectedTarget !== nativeTarget) {
    throw new Error(`Windows first install target ${expectedTarget} does not match native ${nativeTarget}.`);
  }
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (platform === "darwin" && (!Number.isInteger(uid) || uid < 1)) throw new Error("Do not run the Equinox Local installer with sudo or as root.");
  if (typeof homeDir !== "string" || !pathApi.isAbsolute(homeDir)) throw new Error("A trusted absolute HOME is required for Equinox Local first install.");

  const homeStat = await fsImpl.lstat(homeDir);
  if (!homeStat.isDirectory() || homeStat.isSymbolicLink()) throw new Error("The current HOME directory is unsafe.");
  if (platform === "darwin" && Number.isInteger(homeStat.uid) && homeStat.uid !== uid) throw new Error("The current HOME directory is not owned by the current user.");

  const paths = managedSupervisorPaths(homeDir, { platform, arch, env });
  const stagingRoot = pathApi.join(paths.installRoot, "staging");
  await assertOwnedNormalDirectory(paths.installRoot, { uid, platform, fsImpl, create: true });
  await assertOwnedNormalDirectory(paths.releasesRoot, { uid, platform, fsImpl, create: true });
  await assertOwnedNormalDirectory(stagingRoot, { uid, platform, fsImpl, create: true });

  const stagedReal = await fsImpl.realpath(stagedReleaseDir);
  const stagingReal = await fsImpl.realpath(stagingRoot);
  if (!inside(stagingReal, stagedReal, pathApi)) throw new Error("Staged Equinox Local release escaped the managed staging directory.");
  const candidate = await validateFirstInstallRelease(stagedReal, { target: expectedTarget, fsImpl });
  const targetRelease = pathApi.join(paths.releasesRoot, candidate.version);
  if (pathApi.dirname(targetRelease) !== paths.releasesRoot) throw new Error("Candidate release path escaped the managed releases root.");

  const baseInstallation = installationFor(paths, null, { platform, arch, target: expectedTarget });
  let current = null;
  try {
    current = await readCurrentImpl(baseInstallation);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const startRuntime = async (installation) => {
    if (platform === "darwin") {
      await reloadLaunchAgent(installation, { uid, execFileImpl });
      return;
    }
    const shell = await syncWindowsShellImpl({ releaseDir: installation.releaseDir, programRoot: installation.programRoot, fsImpl });
    await launchWindowsShellImpl(shell.shellExecutable);
  };

  if (current) {
    const comparison = compareEquinoxVersions(current.version, candidate.version);
    if (comparison > 0) {
      return Object.freeze({
        status: "newer-installed",
        version: current.version,
        requestedVersion: candidate.version,
        controlCenterUrl: "http://127.0.0.1:24891/",
      });
    }
    if (comparison === 0) {
      const installation = installationFor(paths, current.releaseDir, { platform, arch, target: expectedTarget });
      const bootstrap = await bootstrapImpl({ homeDir, platform, arch, env, fsImpl });
      await initializeOnboardingImpl({ installation, homeDir });
      await startRuntime(installation);
      await waitForVersionImpl(current.version, {
        attempts: FIRST_INSTALL_HEALTH_ATTEMPTS,
        delayMs: FIRST_INSTALL_HEALTH_DELAY_MS,
      });
      return Object.freeze({
        status: "already-installed",
        version: current.version,
        configCreated: Boolean(bootstrap.configCreated),
        controlCenterUrl: bootstrap.controlCenterUrl || "http://127.0.0.1:24891/",
      });
    }
    if (platform === "win32") {
      throw new Error("Windows bootstrap update/reinstall is not enabled yet; use the installed updater once the stable-shell replacement checkpoint is complete.");
    }
  }

  const existing = await fsImpl.lstat(targetRelease).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error("Existing target release path is unsafe.");
    if (current?.releaseDir === targetRelease) throw new Error("Active target release state is inconsistent.");
    await fsImpl.rm(targetRelease, { recursive: true, force: false });
  }
  await fsImpl.rename(stagedReal, targetRelease);

  if (current) {
    const currentInstallation = installationFor(paths, current.releaseDir, { platform, arch, target: expectedTarget });
    await bootstrapImpl({ homeDir, platform, arch, env, fsImpl });
    const activation = await activateImpl({
      installation: currentInstallation,
      targetVersion: candidate.version,
    });
    const bootstrap = await bootstrapImpl({ homeDir, platform, arch, env, fsImpl });
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
    await waitForVersionImpl(candidate.version, {
      attempts: FIRST_INSTALL_HEALTH_ATTEMPTS,
      delayMs: FIRST_INSTALL_HEALTH_DELAY_MS,
    });
  } catch (error) {
    let diagnostics = "";
    if (platform === "darwin") {
      diagnostics = await firstInstallActivationDiagnostics({ homeDir, uid, execFileImpl, fsImpl });
      await execFileImpl("/bin/launchctl", ["bootout", `gui/${uid}/${EQUINOX_LOCAL_LAUNCH_AGENT_LABEL}`], {
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      }).catch(() => ({ stdout: "", stderr: "" }));
    }
    const reason = error instanceof Error ? error.message : String(error);
    const detail = diagnostics ? ` ${diagnostics}` : "";
    throw new Error(`${reason} First-install files were preserved so the verified release can be retried safely.${detail}`);
  }

  return Object.freeze({
    status: "installed",
    version: candidate.version,
    configCreated: Boolean(bootstrap.configCreated),
    controlCenterUrl: bootstrap.controlCenterUrl || "http://127.0.0.1:24891/",
  });
}

function parseCli(argv) {
  if (argv.length !== 2 || argv[0] !== "--staged-release" || !path.isAbsolute(argv[1])) {
    throw new Error("Usage: equinox-local-first-install.js --staged-release /absolute/path/to/release");
  }
  return argv[1];
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && path.basename(invokedPath) === path.basename(fileURLToPath(import.meta.url))) {
  installManagedEquinoxRelease({ stagedReleaseDir: parseCli(process.argv.slice(2)) })
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
