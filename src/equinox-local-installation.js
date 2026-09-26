import os from "node:os";
import path from "node:path";

import { equinoxLocalManagedLifecycle, equinoxLocalPlatformPaths } from "./equinox-local-platform.js";

export const EQUINOX_LOCAL_INSTALL_LABEL = "dev.equinox.local";

function isInside(parent, child, pathApi) {
  const relative = pathApi.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !pathApi.isAbsolute(relative));
}

function baseResult({ platform, arch, lifecycle, kind, reason }) {
  return Object.freeze({
    kind,
    managed: false,
    selfUpdateSupported: false,
    platform,
    arch,
    target: lifecycle.host.target,
    lifecycleKind: lifecycle.kind,
    reason,
    launchAgentLabel: platform === "darwin" ? EQUINOX_LOCAL_INSTALL_LABEL : null,
  });
}

export function resolveEquinoxLocalInstallation({
  platform = process.platform,
  arch = process.arch,
  homeDir = os.homedir(),
  env = process.env,
} = {}) {
  let layout;
  let lifecycle;
  try {
    layout = equinoxLocalPlatformPaths({ platform, arch, homeDir, env });
    lifecycle = equinoxLocalManagedLifecycle({ platform, arch });
  } catch (error) {
    return Object.freeze({
      kind: "source",
      managed: false,
      selfUpdateSupported: false,
      platform,
      arch,
      target: null,
      lifecycleKind: null,
      reason: error instanceof Error ? error.message : "A trusted user home directory is unavailable.",
      launchAgentLabel: platform === "darwin" ? EQUINOX_LOCAL_INSTALL_LABEL : null,
    });
  }

  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const expectedRoot = layout.appDataRoot;
  const configuredRoot = typeof env.EQUINOX_LOCAL_INSTALL_ROOT === "string"
    ? env.EQUINOX_LOCAL_INSTALL_ROOT.trim()
    : "";
  const configuredRelease = typeof env.EQUINOX_LOCAL_RELEASE_DIR === "string"
    ? env.EQUINOX_LOCAL_RELEASE_DIR.trim()
    : "";

  if (!configuredRoot || !configuredRelease) {
    return baseResult({
      platform, arch, lifecycle, kind: "source",
      reason: "This runtime is running from a source checkout, not a managed Equinox Local installation.",
    });
  }

  const installRoot = pathApi.resolve(configuredRoot);
  const releaseDir = pathApi.resolve(configuredRelease);
  const releasesRoot = pathApi.join(installRoot, "releases");

  if (installRoot !== expectedRoot) {
    return baseResult({
      platform, arch, lifecycle, kind: "unsupported",
      reason: "The managed installation root does not match the per-user Equinox Local location.",
    });
  }

  if (!isInside(releasesRoot, releaseDir, pathApi) || releaseDir === releasesRoot) {
    return baseResult({
      platform, arch, lifecycle, kind: "unsupported",
      reason: "The active release is outside the managed releases directory.",
    });
  }

  if (!lifecycle.implemented) {
    return Object.freeze({
      ...baseResult({
        platform, arch, lifecycle, kind: "unsupported",
        reason: "The Windows managed lifecycle is modeled but not implemented yet.",
      }),
      installRoot,
      releasesRoot,
      releaseDir,
      stagingRoot: pathApi.join(installRoot, "staging"),
      currentLink: null,
      currentPointer: pathApi.join(installRoot, "current.version"),
    });
  }

  return Object.freeze({
    kind: "managed",
    managed: true,
    selfUpdateSupported: true,
    platform,
    arch,
    target: lifecycle.host.target,
    lifecycleKind: lifecycle.kind,
    installRoot,
    releasesRoot,
    releaseDir,
    currentLink: pathApi.join(installRoot, "current"),
    currentPointer: pathApi.join(installRoot, "current"),
    stagingRoot: pathApi.join(installRoot, "staging"),
    launchAgentPath: pathApi.join(homeDir, "Library", "LaunchAgents", `${EQUINOX_LOCAL_INSTALL_LABEL}.plist`),
    launchAgentLabel: EQUINOX_LOCAL_INSTALL_LABEL,
  });
}
