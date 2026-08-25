import { execFile as execFileCallback } from "node:child_process";
import { randomBytes } from "node:crypto";
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
  waitForEquinoxLocalVersion,
} from "./equinox-local-update-activation.js";
import {
  compareEquinoxVersions,
  equinoxLocalUpdateTarget,
  parseEquinoxVersion,
} from "./equinox-local-updater.js";
import {
  managedSupervisorPaths,
  resolveSupervisorRelease,
} from "./equinox-local-supervisor.js";

const execFile = promisify(execFileCallback);
const MAX_RELEASE_METADATA_BYTES = 16 * 1024;
const MAX_RELEASE_ENTRIES = 20_000;
const MAX_RELEASE_BYTES = 2 * 1024 * 1024 * 1024;
const REQUIRED_RUNTIME_FILES = Object.freeze([
  path.join("runtime", "node", "bin", "node"),
  path.join("runtime", "tunnel", "tunnel-client"),
  path.join("runtime", "tunnel", "cloudflared"),
]);
const REQUIRED_RELEASE_FILES = Object.freeze([
  "server.js",
  "equinox-local-bootstrap.js",
  "equinox-local-supervisor.js",
  "equinox-local-first-install.js",
]);

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
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

async function assertOwnedNormalDirectory(directory, { uid, fsImpl = fs, create = false, mode = 0o700 } = {}) {
  if (create) await fsImpl.mkdir(directory, { recursive: true, mode });
  const stat = await fsImpl.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe managed directory: ${directory}`);
  if (Number.isInteger(uid) && Number.isInteger(stat.uid) && stat.uid !== uid) {
    throw new Error(`Managed directory is not owned by the current user: ${directory}`);
  }
  if ((stat.mode & 0o022) !== 0) throw new Error(`Managed directory is writable by group or other users: ${directory}`);
  await fsImpl.chmod(directory, mode).catch(() => {});
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
  exactKeys(metadata, ["schemaVersion", "version", "target", "nodeVersion", "tunnelClientVersion", "serverEntry"], "Release metadata");
  if (
    metadata.schemaVersion !== 1 ||
    metadata.target !== target ||
    metadata.serverEntry !== "server.js" ||
    typeof metadata.nodeVersion !== "string" ||
    !/^\d+\.\d+\.\d+$/u.test(metadata.nodeVersion) ||
    typeof metadata.tunnelClientVersion !== "string" ||
    !/^\d+\.\d+\.\d+$/u.test(metadata.tunnelClientVersion)
  ) {
    throw new Error(`Staged Equinox Local release metadata is invalid for ${target}.`);
  }
  parseEquinoxVersion(metadata.version);
  for (const relative of REQUIRED_RUNTIME_FILES) {
    await assertNormalFile(path.join(releaseDir, relative), `Runtime ${relative}`, { executable: true, fsImpl });
  }
  for (const relative of REQUIRED_RELEASE_FILES) {
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

async function readCurrentReleaseOrNull(paths, { fsImpl = fs } = {}) {
  try {
    return await resolveSupervisorRelease(paths);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function installationFor(paths, releaseDir) {
  return Object.freeze({
    kind: "managed",
    managed: true,
    selfUpdateSupported: true,
    installRoot: paths.installRoot,
    releasesRoot: paths.releasesRoot,
    releaseDir,
    currentLink: paths.currentLink,
    stagingRoot: path.join(paths.installRoot, "staging"),
    launchAgentPath: path.join(paths.homeDir, "Library", "LaunchAgents", `${EQUINOX_LOCAL_LAUNCH_AGENT_LABEL}.plist`),
    launchAgentLabel: EQUINOX_LOCAL_LAUNCH_AGENT_LABEL,
  });
}

async function atomicInitialCurrentLink(paths, targetRelease, { fsImpl = fs } = {}) {
  try {
    await fsImpl.lstat(paths.currentLink);
    throw new Error("Managed current pointer appeared during first-install promotion.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const relative = path.relative(paths.installRoot, targetRelease);
  if (!relative.startsWith(`releases${path.sep}`) || path.dirname(targetRelease) !== paths.releasesRoot) {
    throw new Error("First-install current pointer target is unsafe.");
  }
  const temporary = path.join(paths.installRoot, `.current-install-${process.pid}-${randomBytes(8).toString("hex")}`);
  try {
    await fsImpl.symlink(relative, temporary, "dir");
    await fsImpl.rename(temporary, paths.currentLink);
  } catch (error) {
    await fsImpl.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
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
  await execFileImpl("/bin/launchctl", ["kickstart", "-k", service], {
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
}

export async function installManagedEquinoxRelease({
  stagedReleaseDir,
  homeDir = os.homedir(),
  uid = typeof process.getuid === "function" ? process.getuid() : null,
  platform = process.platform,
  target = equinoxLocalUpdateTarget(),
  fsImpl = fs,
  execFileImpl = execFile,
  bootstrapImpl = bootstrapManagedEquinoxUser,
  readCurrentImpl = readCurrentReleaseOrNull,
  activateImpl = activatePreparedEquinoxRelease,
  waitForVersionImpl = waitForEquinoxLocalVersion,
} = {}) {
  if (platform !== "darwin") throw new Error("Equinox Local first install is supported only on macOS.");
  if (!Number.isInteger(uid) || uid < 1) throw new Error("Do not run the Equinox Local installer with sudo or as root.");
  if (typeof homeDir !== "string" || !path.isAbsolute(homeDir)) throw new Error("A trusted absolute HOME is required for Equinox Local first install.");

  const homeStat = await fsImpl.lstat(homeDir);
  if (!homeStat.isDirectory() || homeStat.isSymbolicLink()) throw new Error("The current HOME directory is unsafe.");
  if (Number.isInteger(homeStat.uid) && homeStat.uid !== uid) throw new Error("The current HOME directory is not owned by the current user.");

  const paths = managedSupervisorPaths(homeDir);
  const stagingRoot = path.join(paths.installRoot, "staging");
  await assertOwnedNormalDirectory(paths.installRoot, { uid, fsImpl, create: true });
  await assertOwnedNormalDirectory(paths.releasesRoot, { uid, fsImpl, create: true });
  await assertOwnedNormalDirectory(stagingRoot, { uid, fsImpl, create: true });

  const stagedReal = await fsImpl.realpath(stagedReleaseDir);
  const stagingReal = await fsImpl.realpath(stagingRoot);
  if (!inside(stagingReal, stagedReal)) throw new Error("Staged Equinox Local release escaped the managed staging directory.");
  const candidate = await validateFirstInstallRelease(stagedReal, { target, fsImpl });
  const targetRelease = path.join(paths.releasesRoot, candidate.version);
  if (path.dirname(targetRelease) !== paths.releasesRoot) throw new Error("Candidate release path escaped the managed releases root.");

  const current = await readCurrentImpl(paths, { fsImpl });
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
      const installation = installationFor(paths, current.releaseDir);
      const bootstrap = await bootstrapImpl({ homeDir });
      await reloadLaunchAgent(installation, { uid, execFileImpl });
      await waitForVersionImpl(current.version);
      return Object.freeze({
        status: "already-installed",
        version: current.version,
        configCreated: Boolean(bootstrap.configCreated),
        controlCenterUrl: bootstrap.controlCenterUrl || "http://127.0.0.1:24891/",
      });
    }
  }

  let promoted = false;
  try {
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
    promoted = true;

    if (current) {
      const currentInstallation = installationFor(paths, current.releaseDir);
      await bootstrapImpl({ homeDir });
      const activation = await activateImpl({
        installation: currentInstallation,
        targetVersion: candidate.version,
      });
      const activeInstallation = installationFor(paths, targetRelease);
      const bootstrap = await bootstrapImpl({ homeDir });
      return Object.freeze({
        status: activation.status,
        version: candidate.version,
        previousVersion: activation.previousVersion,
        configCreated: Boolean(bootstrap.configCreated),
        controlCenterUrl: bootstrap.controlCenterUrl || "http://127.0.0.1:24891/",
      });
    }

    await atomicInitialCurrentLink(paths, targetRelease, { fsImpl });
    const installation = installationFor(paths, targetRelease);
    const bootstrap = await bootstrapImpl({ homeDir });
    try {
      await reloadLaunchAgent(installation, { uid, execFileImpl });
      await waitForVersionImpl(candidate.version);
    } catch (error) {
      await execFileImpl("/bin/launchctl", ["bootout", `gui/${uid}/${EQUINOX_LOCAL_LAUNCH_AGENT_LABEL}`], {
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      }).catch(() => ({ stdout: "", stderr: "" }));
      await fsImpl.rm(paths.currentLink, { force: true }).catch(() => {});
      if (promoted) await fsImpl.rm(targetRelease, { recursive: true, force: true }).catch(() => {});
      throw error;
    }

    return Object.freeze({
      status: "installed",
      version: candidate.version,
      configCreated: Boolean(bootstrap.configCreated),
      controlCenterUrl: bootstrap.controlCenterUrl || "http://127.0.0.1:24891/",
    });
  } catch (error) {
    throw error;
  }
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
