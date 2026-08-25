import path from "node:path";

export const EQUINOX_LOCAL_INSTALL_LABEL = "dev.equinox.local";

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function resolveEquinoxLocalInstallation({
  homeDir = process.env.HOME,
  env = process.env,
} = {}) {
  if (typeof homeDir !== "string" || !path.isAbsolute(homeDir)) {
    return Object.freeze({
      kind: "source",
      managed: false,
      selfUpdateSupported: false,
      reason: "A trusted user home directory is unavailable.",
      launchAgentLabel: EQUINOX_LOCAL_INSTALL_LABEL,
    });
  }

  const expectedRoot = path.join(homeDir, "Library", "Application Support", "Equinox Local");
  const configuredRoot = typeof env.EQUINOX_LOCAL_INSTALL_ROOT === "string"
    ? env.EQUINOX_LOCAL_INSTALL_ROOT.trim()
    : "";
  const configuredRelease = typeof env.EQUINOX_LOCAL_RELEASE_DIR === "string"
    ? env.EQUINOX_LOCAL_RELEASE_DIR.trim()
    : "";

  if (!configuredRoot || !configuredRelease) {
    return Object.freeze({
      kind: "source",
      managed: false,
      selfUpdateSupported: false,
      reason: "This runtime is running from a source checkout, not a managed Equinox Local installation.",
      launchAgentLabel: EQUINOX_LOCAL_INSTALL_LABEL,
    });
  }

  const installRoot = path.resolve(configuredRoot);
  const releaseDir = path.resolve(configuredRelease);
  const releasesRoot = path.join(installRoot, "releases");

  if (installRoot !== expectedRoot) {
    return Object.freeze({
      kind: "unsupported",
      managed: false,
      selfUpdateSupported: false,
      reason: "The managed installation root does not match the per-user Equinox Local location.",
      launchAgentLabel: EQUINOX_LOCAL_INSTALL_LABEL,
    });
  }

  if (!isInside(releasesRoot, releaseDir) || releaseDir === releasesRoot) {
    return Object.freeze({
      kind: "unsupported",
      managed: false,
      selfUpdateSupported: false,
      reason: "The active release is outside the managed releases directory.",
      launchAgentLabel: EQUINOX_LOCAL_INSTALL_LABEL,
    });
  }

  return Object.freeze({
    kind: "managed",
    managed: true,
    selfUpdateSupported: true,
    installRoot,
    releasesRoot,
    releaseDir,
    currentLink: path.join(installRoot, "current"),
    stagingRoot: path.join(installRoot, "staging"),
    launchAgentPath: path.join(homeDir, "Library", "LaunchAgents", `${EQUINOX_LOCAL_INSTALL_LABEL}.plist`),
    launchAgentLabel: EQUINOX_LOCAL_INSTALL_LABEL,
  });
}
