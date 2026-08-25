import { spawn as spawnChild } from "node:child_process";
import { fileURLToPath } from "node:url";

import { prepareManagedEquinoxRelease } from "./equinox-local-release-manager.js";
import { compareEquinoxVersions, parseEquinoxVersion } from "./equinox-local-updater.js";

const DEFAULT_HELPER_PATH = fileURLToPath(new URL("./equinox-local-update-helper.js", import.meta.url));

function helperEnvironment(installation, sourceEnv = process.env) {
  const env = {
    HOME: sourceEnv.HOME,
    USER: sourceEnv.USER,
    LOGNAME: sourceEnv.LOGNAME,
    TMPDIR: sourceEnv.TMPDIR,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    EQUINOX_LOCAL_INSTALL_ROOT: installation.installRoot,
    EQUINOX_LOCAL_RELEASE_DIR: installation.releaseDir,
  };
  return Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === "string" && value.length > 0));
}

export function scheduleEquinoxLocalActivation({
  installation,
  version,
  spawnImpl = spawnChild,
  nodePath = process.execPath,
  helperPath = DEFAULT_HELPER_PATH,
  sourceEnv = process.env,
} = {}) {
  if (!installation?.selfUpdateSupported) throw new Error("A managed Equinox Local installation is required to schedule activation.");
  const normalizedVersion = parseEquinoxVersion(version).text;
  const child = spawnImpl(nodePath, [helperPath, "--activate", normalizedVersion], {
    detached: true,
    stdio: "ignore",
    env: helperEnvironment(installation, sourceEnv),
  });
  if (!child || typeof child.unref !== "function") throw new Error("Equinox Local update helper failed to start.");
  child.unref();
  return Object.freeze({ scheduled: true, version: normalizedVersion });
}

export function createEquinoxLocalUpdateCoordinator({
  installation,
  updater,
  prepareRelease = prepareManagedEquinoxRelease,
  spawnImpl = spawnChild,
  nodePath = process.execPath,
  helperPath = DEFAULT_HELPER_PATH,
  sourceEnv = process.env,
} = {}) {
  if (!updater || typeof updater.snapshot !== "function" || typeof updater.candidate !== "function") {
    throw new Error("Equinox Local updater is required by the update coordinator.");
  }
  let applying = false;
  let restartScheduledFor = null;

  const snapshot = () => Object.freeze({
    ...updater.snapshot(),
    applying,
    restartScheduledFor,
  });

  const apply = async () => {
    if (applying) throw new Error("An Equinox Local update is already being prepared.");
    const status = updater.snapshot();
    if (!installation?.selfUpdateSupported || !status.selfUpdateSupported) {
      throw new Error("Self-update is unavailable for this Equinox Local installation.");
    }
    const candidate = updater.candidate();
    if (!candidate || status.updateAvailable !== true) {
      throw new Error("Check for updates and verify a newer signed release before installing.");
    }
    if (compareEquinoxVersions(status.currentVersion, candidate.version) >= 0) {
      throw new Error("The verified update candidate is not newer than the running Equinox Local version.");
    }

    applying = true;
    try {
      const prepared = await prepareRelease({ installation, manifest: candidate });
      scheduleEquinoxLocalActivation({
        installation,
        version: candidate.version,
        spawnImpl,
        nodePath,
        helperPath,
        sourceEnv,
      });
      restartScheduledFor = candidate.version;
      return Object.freeze({
        scheduled: true,
        currentVersion: status.currentVersion,
        targetVersion: candidate.version,
        fileCount: prepared.fileCount,
        extractedBytes: prepared.extractedBytes,
      });
    } finally {
      applying = false;
    }
  };

  return Object.freeze({ snapshot, apply });
}
