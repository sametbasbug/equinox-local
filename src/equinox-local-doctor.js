import fs from "node:fs/promises";
import path from "node:path";

import { readManagedCurrentRelease } from "./equinox-local-update-activation.js";

const NATIVE_HOST_NAME = "dev.equinox.browser";

function unixMode(mode) {
  return (mode & 0o777).toString(8).padStart(3, "0");
}

async function inspectPath(target, {
  type,
  mode,
  fsImpl = fs,
} = {}) {
  try {
    const stat = await fsImpl.lstat(target);
    const actualType = stat.isFile() ? "file" : stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "other";
    const actualMode = unixMode(stat.mode);
    return Object.freeze({
      exists: true,
      safe: actualType === type && actualType !== "symlink" && (mode === undefined || actualMode === mode),
      type: actualType,
      mode: actualMode,
    });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return Object.freeze({ exists: false, safe: false, type: null, mode: null });
    }
    return Object.freeze({ exists: false, safe: false, type: null, mode: null });
  }
}

function check(id, label, status, detail) {
  return Object.freeze({ id, label, status, detail });
}

function summarize(checks) {
  const pass = checks.filter((item) => item.status === "pass").length;
  const attention = checks.filter((item) => item.status === "attention").length;
  const optional = checks.filter((item) => item.status === "optional").length;
  return Object.freeze({ pass, attention, optional, total: checks.length });
}

export async function getEquinoxLocalDoctorStatus({
  installation,
  config,
  runtimeHealthState,
  runtimeVersion,
  sourceCheckoutVersion = null,
  browser = {},
  peekaboo = {},
  update = {},
  onboarding = {},
  developmentTunnel = null,
  homeDir = process.env.HOME,
  fsImpl = fs,
  readCurrentReleaseImpl = readManagedCurrentRelease,
  now = () => new Date(),
} = {}) {
  const checks = [];
  const healthyRuntime = runtimeHealthState === "HEALTHY";
  checks.push(check(
    "runtime",
    "Local runtime",
    healthyRuntime ? "pass" : "attention",
    healthyRuntime
      ? `Equinox Local ${runtimeVersion || "is running"} and reports healthy.`
      : "The local runtime is not reporting a healthy state.",
  ));

  const workspaceId = config?.runtime?.workspaceProject;
  const workspace = workspaceId ? config?.projects?.[workspaceId] : null;
  const configValid = config?.version === 1 && typeof workspace?.root === "string";
  checks.push(check(
    "config",
    "Configuration",
    configValid ? "pass" : "attention",
    configValid
      ? "The versioned Equinox Local configuration loaded successfully."
      : "The Equinox Local configuration needs attention.",
  ));

  if (configValid) {
    const workspaceState = await inspectPath(workspace.root, { type: "directory", fsImpl });
    checks.push(check(
      "workspace",
      "Equinox Workspace",
      workspaceState.safe ? "pass" : "attention",
      workspaceState.safe
        ? "The managed workspace directory is available."
        : "The configured workspace directory is unavailable or unsafe.",
    ));
  }

  if (installation?.managed && installation?.selfUpdateSupported) {
    checks.push(check(
      "installation",
      "Managed installation",
      "pass",
      "Equinox Local is running from the per-user managed release layout.",
    ));

    try {
      const current = await readCurrentReleaseImpl(installation);
      checks.push(check(
        "release",
        "Active release",
        "pass",
        `Managed release ${current.version} passed layout and runtime validation.`,
      ));
    } catch {
      checks.push(check(
        "release",
        "Active release",
        "attention",
        "The managed current release pointer or bundled runtime needs attention.",
      ));
    }

    const [launchAgent, configFile, hostWrapper, hostManifest] = await Promise.all([
      inspectPath(installation.launchAgentPath, { type: "file", mode: "600", fsImpl }),
      inspectPath(path.join(installation.installRoot, "config.json"), { type: "file", mode: "600", fsImpl }),
      inspectPath(path.join(installation.installRoot, "equinox-browser-native-host"), { type: "file", mode: "700", fsImpl }),
      typeof homeDir === "string" && path.isAbsolute(homeDir)
        ? inspectPath(path.join(homeDir, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`), { type: "file", mode: "600", fsImpl })
        : Promise.resolve(Object.freeze({ exists: false, safe: false })),
    ]);

    checks.push(check(
      "launch-agent",
      "LaunchAgent",
      launchAgent.safe ? "pass" : "attention",
      launchAgent.safe
        ? "The per-user LaunchAgent is installed with private permissions."
        : "The per-user LaunchAgent is missing, unsafe, or has unexpected permissions.",
    ));
    checks.push(check(
      "config-file",
      "Private config file",
      configFile.safe ? "pass" : "attention",
      configFile.safe
        ? "The managed config file is private to the user."
        : "The managed config file is missing, unsafe, or has unexpected permissions.",
    ));
    checks.push(check(
      "native-host",
      "Equinox Browser host",
      hostWrapper.safe && hostManifest.safe ? "pass" : "attention",
      hostWrapper.safe && hostManifest.safe
        ? "The Native Messaging host is installed with bounded per-user files."
        : "The Equinox Browser Native Messaging host needs repair or reinstall.",
    ));

    checks.push(check(
      "updates",
      "Secure updates",
      update?.selfUpdateSupported === true && update?.configured === true ? "pass" : "attention",
      update?.selfUpdateSupported === true && update?.configured === true
        ? "Signed Control Center updates are available for this managed installation."
        : "The managed updater is not fully provisioned for signed stable releases.",
    ));

    if (onboarding?.needsAttention) {
      checks.push(check(
        "chatgpt-connection",
        "ChatGPT connection",
        "attention",
        onboarding.issue || "The saved tunnel connection needs attention.",
      ));
    } else if (onboarding?.connectedThroughTunnel) {
      checks.push(check(
        "chatgpt-connection",
        "ChatGPT connection",
        "pass",
        "Equinox Local is running through the configured private tunnel.",
      ));
    } else if (onboarding?.transportConfigured) {
      checks.push(check(
        "chatgpt-connection",
        "ChatGPT connection",
        "attention",
        "Tunnel settings are saved, but this runtime is not connected through them yet.",
      ));
    } else {
      checks.push(check(
        "chatgpt-connection",
        "ChatGPT connection",
        "attention",
        "Finish first-time setup by adding the tunnel credentials in Control Center.",
      ));
    }
  } else {
    checks.push(check(
      "installation",
      "Development installation",
      installation?.kind === "unsupported" ? "attention" : "pass",
      installation?.kind === "unsupported"
        ? installation.reason || "This installation layout is unsupported."
        : "This runtime is intentionally running from a source checkout; managed self-update is disabled.",
    ));

    if (installation?.kind === "source" && sourceCheckoutVersion) {
      const sourceMatchesRuntime = sourceCheckoutVersion === runtimeVersion;
      checks.push(check(
        "source-version",
        "Source checkout version",
        sourceMatchesRuntime ? "pass" : "attention",
        sourceMatchesRuntime
          ? `Running process matches source checkout version ${sourceCheckoutVersion}.`
          : `Source checkout is version ${sourceCheckoutVersion}, but the running process is ${runtimeVersion || "unknown"}. Restart Equinox Local to load the current source.`,
      ));
    }

    if (installation?.kind === "source" && developmentTunnel) {
      if (developmentTunnel.configured === false) {
        checks.push(check(
          "development-tunnel",
          "Development tunnel runtime",
          "optional",
          "No private source-runtime tunnel configuration is present, so version synchronization is not checked.",
        ));
      } else {
        const actual = developmentTunnel.actualVersion || "unknown";
        const expected = developmentTunnel.expectedVersion || "unknown";
        checks.push(check(
          "development-tunnel",
          "Development tunnel runtime",
          developmentTunnel.synchronized === true ? "pass" : "attention",
          developmentTunnel.synchronized === true
            ? `Development tunnel-client ${actual} matches the pinned runtime version.`
            : `Development tunnel-client ${actual} does not match pinned version ${expected}. Restart Equinox Local to synchronize it.`,
        ));
      }
    }
  }

  if (browser?.ready) {
    checks.push(check(
      "browser",
      "Equinox Browser",
      "pass",
      browser.consentAccepted === false
        ? "The extension is connected; browser automation remains off until the user accepts browser-data consent."
        : "The first-party Equinox Browser bridge is connected.",
    ));
  } else {
    checks.push(check(
      "browser",
      "Equinox Browser",
      "optional",
      "The Chrome extension is not connected. Core Equinox Local can still run without browser automation.",
    ));
  }

  const peekabooReady = peekaboo?.ready === true || (peekaboo?.ready === undefined && peekaboo?.active === true);
  const peekabooNeedsAttention = peekaboo?.needsAttention === true;
  checks.push(check(
    "peekaboo",
    "Desktop bridge",
    peekabooNeedsAttention ? "attention" : peekabooReady ? "pass" : "optional",
    peekabooNeedsAttention
      ? "Peekaboo is installed, but Equinox Local compatibility or required macOS permissions need attention."
      : peekabooReady
        ? "Peekaboo desktop automation is available."
        : "Peekaboo is optional and is not currently available.",
  ));

  const summary = summarize(checks);
  return Object.freeze({
    state: summary.attention > 0 ? "ATTENTION" : "HEALTHY",
    checkedAt: now().toISOString(),
    installationKind: installation?.kind ?? "source",
    managed: Boolean(installation?.managed),
    summary,
    checks: Object.freeze(checks),
  });
}
