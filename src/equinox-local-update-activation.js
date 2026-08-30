import { randomBytes } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { equinoxLocalUpdateTarget, parseEquinoxVersion } from "./equinox-local-updater.js";

const execFile = promisify(execFileCallback);
export const EQUINOX_LOCAL_CONTROL_CENTER_STATUS_URL = "http://127.0.0.1:24891/api/v1/status";
const HEALTH_ATTEMPTS = 30;
const HEALTH_DELAY_MS = 500;

function boundedMessage(value) {
  return String(value ?? "")
    .replace(/[\r\n\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 300);
}

function releasePathFor(installation, version) {
  const normalized = parseEquinoxVersion(version).text;
  const target = path.join(installation.releasesRoot, normalized);
  if (path.dirname(target) !== installation.releasesRoot) {
    throw new Error("Managed release path escaped the releases root.");
  }
  return target;
}

async function assertReleaseDirectory(installation, version) {
  const target = releasePathFor(installation, version);
  const stat = await fs.lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Managed release ${version} is not a normal directory.`);
  }
  const metadata = JSON.parse(await fs.readFile(path.join(target, "release.json"), "utf8"));
  const expectedTarget = equinoxLocalUpdateTarget();
  if (
    metadata?.schemaVersion !== 1 ||
    metadata?.version !== version ||
    metadata?.target !== expectedTarget ||
    typeof metadata?.nodeVersion !== "string" ||
    !/^\d+\.\d+\.\d+$/u.test(metadata.nodeVersion) ||
    typeof metadata?.tunnelClientVersion !== "string" ||
    !/^\d+\.\d+\.\d+$/u.test(metadata.tunnelClientVersion) ||
    metadata?.serverEntry !== "server.js"
  ) {
    throw new Error(`Managed release ${version} metadata is invalid for ${expectedTarget}.`);
  }
  for (const relative of [
    path.join("runtime", "node", "bin", "node"),
    path.join("runtime", "tunnel", "tunnel-client"),
    path.join("runtime", "tunnel", "cloudflared"),
  ]) {
    const executable = await fs.lstat(path.join(target, relative));
    if (!executable.isFile() || executable.isSymbolicLink() || (executable.mode & 0o111) === 0) {
      throw new Error(`Managed release ${version} runtime executable is invalid: ${relative}.`);
    }
  }
  return target;
}

export async function readManagedCurrentRelease(installation) {
  if (!installation?.selfUpdateSupported || typeof installation.currentLink !== "string") {
    throw new Error("A managed Equinox Local installation is required.");
  }
  const linkStat = await fs.lstat(installation.currentLink);
  if (!linkStat.isSymbolicLink()) throw new Error("Managed current pointer must be a symbolic link.");
  const rawTarget = await fs.readlink(installation.currentLink);
  const resolved = path.resolve(path.dirname(installation.currentLink), rawTarget);
  if (path.dirname(resolved) !== installation.releasesRoot) {
    throw new Error("Managed current pointer escaped the releases root.");
  }
  const version = path.basename(resolved);
  parseEquinoxVersion(version);
  const target = await assertReleaseDirectory(installation, version);
  return Object.freeze({ version, releaseDir: target });
}

async function syncDirectory(directory) {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function atomicSwitchCurrentRelease(installation, targetVersion) {
  const targetReleaseDir = await assertReleaseDirectory(installation, targetVersion);
  const previous = await readManagedCurrentRelease(installation);
  if (previous.releaseDir === targetReleaseDir) {
    return Object.freeze({ previous, current: previous, changed: false });
  }

  const tempLink = path.join(
    installation.installRoot,
    `.current-next-${process.pid}-${randomBytes(8).toString("hex")}`,
  );
  const relativeTarget = path.relative(installation.installRoot, targetReleaseDir);
  if (!relativeTarget.startsWith("releases/")) throw new Error("Managed release link target is invalid.");

  try {
    await fs.symlink(relativeTarget, tempLink, "dir");
    await fs.rename(tempLink, installation.currentLink);
    await syncDirectory(installation.installRoot);
  } catch (error) {
    await fs.rm(tempLink, { force: true }).catch(() => {});
    throw error;
  }

  return Object.freeze({
    previous,
    current: Object.freeze({ version: targetVersion, releaseDir: targetReleaseDir }),
    changed: true,
  });
}

export async function kickstartEquinoxLocalLaunchAgent(installation, {
  execFileImpl = execFile,
  uid = process.getuid?.(),
} = {}) {
  if (!Number.isInteger(uid) || uid < 1) throw new Error("A non-root user id is required to restart Equinox Local.");
  if (typeof installation?.launchAgentLabel !== "string" || installation.launchAgentLabel !== "dev.equinox.local") {
    throw new Error("Unexpected Equinox Local LaunchAgent label.");
  }
  await execFileImpl("/bin/launchctl", ["kickstart", "-k", `gui/${uid}/${installation.launchAgentLabel}`], {
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
}

export async function waitForEquinoxLocalVersion(expectedVersion, {
  fetchImpl = globalThis.fetch,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  attempts = HEALTH_ATTEMPTS,
  delayMs = HEALTH_DELAY_MS,
} = {}) {
  parseEquinoxVersion(expectedVersion);
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchImpl(EQUINOX_LOCAL_CONTROL_CENTER_STATUS_URL, {
        method: "GET",
        redirect: "error",
        cache: "no-store",
        credentials: "omit",
        headers: { accept: "application/json" },
      });
      if (!response?.ok) throw new Error(`Health endpoint returned HTTP ${response?.status ?? "unknown"}.`);
      const body = await response.json();
      const reportedVersion = body?.status?.server?.version ?? null;
      const healthState = body?.status?.health?.state ?? null;
      if (reportedVersion === expectedVersion && healthState === "HEALTHY") return true;
      throw new Error(`Health endpoint reported Equinox Local ${reportedVersion ?? "unknown"} with health ${healthState ?? "unknown"}.`);
    } catch (error) {
      lastError = error;
    }
    if (attempt + 1 < attempts) await sleepImpl(delayMs);
  }
  throw new Error(`Equinox Local ${expectedVersion} did not become healthy: ${boundedMessage(lastError instanceof Error ? lastError.message : lastError)}`);
}

async function writeActivationState(installation, state) {
  const target = path.join(installation.installRoot, "update-state.json");
  const temp = `${target}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  await fs.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await fs.rename(temp, target);
  await syncDirectory(installation.installRoot);
}

export async function activatePreparedEquinoxRelease({
  installation,
  targetVersion,
  kickstartImpl = () => kickstartEquinoxLocalLaunchAgent(installation),
  fetchImpl = globalThis.fetch,
  sleepImpl,
  healthAttempts = HEALTH_ATTEMPTS,
  now = () => new Date(),
} = {}) {
  if (!installation?.selfUpdateSupported) throw new Error("A managed Equinox Local installation is required for activation.");
  parseEquinoxVersion(targetVersion);
  const switchResult = await atomicSwitchCurrentRelease(installation, targetVersion);
  if (!switchResult.changed) {
    return Object.freeze({ status: "already-active", version: targetVersion, previousVersion: targetVersion });
  }

  try {
    await kickstartImpl(targetVersion);
    await waitForEquinoxLocalVersion(targetVersion, {
      fetchImpl,
      sleepImpl,
      attempts: healthAttempts,
    });
    await writeActivationState(installation, {
      schemaVersion: 1,
      status: "activated",
      version: targetVersion,
      previousVersion: switchResult.previous.version,
      updatedAt: now().toISOString(),
    });
    return Object.freeze({
      status: "activated",
      version: targetVersion,
      previousVersion: switchResult.previous.version,
    });
  } catch (activationError) {
    try {
      await atomicSwitchCurrentRelease(installation, switchResult.previous.version);
      await kickstartImpl(switchResult.previous.version);
      await waitForEquinoxLocalVersion(switchResult.previous.version, {
        fetchImpl,
        sleepImpl,
        attempts: healthAttempts,
      });
      await writeActivationState(installation, {
        schemaVersion: 1,
        status: "rolled-back",
        failedVersion: targetVersion,
        version: switchResult.previous.version,
        failure: "activation-health-check-failed",
        updatedAt: now().toISOString(),
      });
      throw new Error(`Equinox Local ${targetVersion} activation failed and was rolled back to ${switchResult.previous.version}.`);
    } catch (rollbackError) {
      if (rollbackError instanceof Error && rollbackError.message.includes("was rolled back to")) throw rollbackError;
      await writeActivationState(installation, {
        schemaVersion: 1,
        status: "rollback-failed",
        failedVersion: targetVersion,
        previousVersion: switchResult.previous.version,
        activationFailure: "activation-health-check-failed",
        rollbackFailure: "rollback-health-check-failed",
        updatedAt: now().toISOString(),
      }).catch(() => {});
      throw new Error(`Equinox Local ${targetVersion} activation failed and automatic rollback also failed.`);
    }
  }
}
