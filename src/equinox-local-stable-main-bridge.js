import fs from "node:fs/promises";
import path from "node:path";

import { readManagedCurrentRelease, kickstartEquinoxLocalLaunchAgent, waitForEquinoxLocalManagedSource, waitForEquinoxLocalVersion } from "./equinox-local-update-activation.js";
import { enrollEquinoxLocalManagedSource, rollbackEquinoxLocalManagedSourceEnrollment } from "./equinox-local-managed-source-enrollment.js";
import { resolveEquinoxLocalManagedSourceInstallation } from "./equinox-local-managed-source-installation.js";
import { requestWindowsShellRuntimeRestart } from "./equinox-local-windows-shell-control.js";

const SHA = /^[a-f0-9]{40}$/u;
const MAX_RELEASE_JSON_BYTES = 16 * 1024;

export async function readVerifiedBridgeSourceIdentity(installation, targetVersion, { fsImpl = fs, readCurrentImpl = readManagedCurrentRelease } = {}) {
  if (!installation?.managed || !installation.selfUpdateSupported) throw new Error("Stable-to-Main bridge requires an installed managed release.");
  const current = await readCurrentImpl(installation);
  if (current.version !== targetVersion) throw new Error("Stable-to-Main bridge refuses a nonactive signed Stable version.");
  const pathApi = installation.platform === "win32" ? path.win32 : path.posix;
  const metadataPath = pathApi.join(current.releaseDir, "release.json");
  const stat = await fsImpl.lstat(metadataPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > MAX_RELEASE_JSON_BYTES) {
    throw new Error("Stable-to-Main bridge release metadata is unavailable or unsafe.");
  }
  const metadata = JSON.parse(await fsImpl.readFile(metadataPath, "utf8"));
  if (metadata?.version !== targetVersion || metadata?.target !== installation.target || !SHA.test(metadata.sourceSha ?? "")) {
    throw new Error("Stable-to-Main bridge requires matching, exact signed source provenance.");
  }
  return Object.freeze({ sourceSha: metadata.sourceSha, releaseDir: current.releaseDir });
}

export async function bridgeActivatedStableToMain({
  installation,
  version,
  homeDir,
  env = process.env,
  readIdentityImpl = readVerifiedBridgeSourceIdentity,
  inspectInstallationImpl = resolveEquinoxLocalManagedSourceInstallation,
  enrollImpl = enrollEquinoxLocalManagedSource,
  rollbackImpl = rollbackEquinoxLocalManagedSourceEnrollment,
  restartImpl = async () => installation.platform === "win32"
    ? requestWindowsShellRuntimeRestart({ platform: "win32" })
    : kickstartEquinoxLocalLaunchAgent(installation),
  waitForMainImpl = waitForEquinoxLocalManagedSource,
  waitForStableImpl = waitForEquinoxLocalVersion,
} = {}) {
  if (!installation?.managed || !installation.selfUpdateSupported || !["darwin", "win32"].includes(installation.platform)) {
    throw new Error("Stable-to-Main bridge requires a supported managed installation.");
  }
  const existing = await inspectInstallationImpl({
    baseInstallation: installation, platform: installation.platform, arch: installation.arch, homeDir, env,
  });
  if (existing?.kind === "managed-source") return Object.freeze({ status: "already-enrolled", sourceSha: existing.sourceSha ?? null });
  if (existing?.kind !== "managed") throw new Error("Stable-to-Main bridge cannot use an unsafe existing installation.");

  const identity = await readIdentityImpl(installation, version);
  const enrollmentOptions = {
    bootstrapSha: identity.sourceSha,
    target: installation.target,
    platform: installation.platform,
    arch: installation.arch,
    homeDir,
    env,
    ...(installation.platform === "win32" ? {
      windowsZipHelperPath: path.win32.join(identity.releaseDir, "equinox-local-windows-release-zip.ps1"),
      windowsPrivateStateHelperPath: path.win32.join(identity.releaseDir, "equinox-local-windows-private-state.ps1"),
      stableReleaseDir: identity.releaseDir,
    } : {}),
  };
  let enrolled = false;
  try {
    const result = await enrollImpl(enrollmentOptions);
    if (result?.bootstrapSha !== identity.sourceSha || !["enrolled", "already-enrolled"].includes(result.status)) {
      throw new Error("Stable-to-Main enrollment did not confirm the exact signed source.");
    }
    enrolled = true;
    await restartImpl();
    await waitForMainImpl(version, identity.sourceSha);
    return Object.freeze({ status: "main-activated", sourceSha: identity.sourceSha });
  } catch (error) {
    // Fail closed. Only roll back a verified, exact-sha enrollment; never
    // delete workspace, profile, tunnel keys, native host or preexisting Main.
    let rolledBack = false;
    try {
      const rollback = await rollbackImpl({
        bootstrapSha: identity.sourceSha,
        target: installation.target, platform: installation.platform,
        arch: installation.arch, homeDir, env,
      });
      rolledBack = rollback?.rolledBack === true;
      if (rolledBack || enrolled) {
        await restartImpl();
        await waitForStableImpl(version);
      }
    } catch {
      throw new Error("Stable-to-Main migration failed; Stable recovery needs attention.");
    }
    // Do not report success because the signed Stable baseline still runs.
    throw new Error(rolledBack
      ? "Stable-to-Main migration failed; the signed Stable baseline was restored."
      : "Stable-to-Main enrollment did not complete; the signed Stable baseline remains installed.");
  }
}
