import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  assertWindowsNativeMessagingHostOwnership,
  windowsNativeMessagingLauncherPath,
} from "./equinox-browser-windows-native-messaging.js";
import { equinoxLocalHostDescriptor } from "./equinox-local-platform.js";
import { inspectPrivateStatePath } from "./equinox-local-private-state.js";
import { readManagedCurrentRelease } from "./equinox-local-update-activation.js";
import { readWindowsStartupRegistrationOwnership } from "./equinox-local-uninstall-helper.js";
import { assertWindowsStableShellOwnedByRelease } from "./equinox-local-windows-stable-shell.js";

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

function windowsDoctorProbeEnvironment(env = process.env) {
  const systemRootValue = env?.SystemRoot || env?.SYSTEMROOT;
  if (typeof systemRootValue !== "string" || !path.win32.isAbsolute(systemRootValue)) {
    throw new Error("Windows SystemRoot is unavailable for Doctor lifecycle verification.");
  }
  const systemRoot = path.win32.normalize(systemRootValue);
  const windirValue = env?.WINDIR;
  const windir = typeof windirValue === "string" && path.win32.isAbsolute(windirValue)
    ? path.win32.normalize(windirValue)
    : systemRoot;
  return Object.freeze({
    SystemRoot: systemRoot,
    WINDIR: windir,
    PATH: [
      path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0"),
      path.win32.join(systemRoot, "System32"),
      systemRoot,
    ].join(";"),
  });
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
  developmentPeekaboo = null,
  host = null,
  homeDir = os.homedir(),
  fsImpl = fs,
  verifyWindowsAcl = null,
  readCurrentReleaseImpl = readManagedCurrentRelease,
  assertWindowsStableShellImpl = assertWindowsStableShellOwnedByRelease,
  assertWindowsNativeHostImpl = assertWindowsNativeMessagingHostOwnership,
  readWindowsStartupImpl = readWindowsStartupRegistrationOwnership,
  runtimeEnv = process.env,
  now = () => new Date(),
} = {}) {
  const checks = [];
  const hostDescriptor = host || (() => {
    try {
      return equinoxLocalHostDescriptor();
    } catch {
      return Object.freeze({ platform: process.platform, arch: process.arch, target: null, displayName: process.platform, supported: false });
    }
  })();
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

    if ((installation.lifecycleKind || "launch-agent") === "launch-agent") {
      const [launchAgent, configFile, hostWrapper, hostManifest] = await Promise.all([
        inspectPrivateStatePath(installation.launchAgentPath, { platform: hostDescriptor.platform, type: "file", mode: "600", fsImpl, verifyWindowsAcl }),
        inspectPrivateStatePath(path.join(installation.installRoot, "config.json"), { platform: hostDescriptor.platform, type: "file", mode: "600", fsImpl, verifyWindowsAcl }),
        inspectPrivateStatePath(path.join(installation.installRoot, "equinox-browser-native-host"), { platform: hostDescriptor.platform, type: "file", mode: "700", fsImpl, verifyWindowsAcl }),
        typeof homeDir === "string" && path.isAbsolute(homeDir)
          ? inspectPrivateStatePath(path.join(homeDir, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`), { platform: hostDescriptor.platform, type: "file", mode: "600", fsImpl, verifyWindowsAcl })
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
    } else if (installation.lifecycleKind === "windows-user" && hostDescriptor.platform === "win32") {
      const releaseDir = installation.releaseDir;
      const programRoot = installation.programRoot;
      const manifestRoot = installation.nativeMessagingManifestRoot;
      const shellExecutable = typeof programRoot === "string"
        ? path.win32.join(programRoot, "EquinoxLocal.exe")
        : null;

      let shellOwned = false;
      if (typeof releaseDir === "string" && typeof programRoot === "string") {
        try {
          await assertWindowsStableShellImpl({ releaseDir, programRoot, fsImpl });
          shellOwned = true;
        } catch {
          shellOwned = false;
        }
      }
      checks.push(check(
        "windows-shell",
        "Windows native shell",
        shellOwned ? "pass" : "attention",
        shellOwned
          ? "The per-user Windows shell matches the active managed release."
          : "The Windows native shell is missing, unsafe, or does not match the active managed release.",
      ));

      let startupSafe = false;
      let startupEnabled = false;
      if (typeof shellExecutable === "string" && path.win32.isAbsolute(shellExecutable)) {
        try {
          const startup = await readWindowsStartupImpl({
            expectedCommand: `"${shellExecutable}" --startup`,
            env: windowsDoctorProbeEnvironment(runtimeEnv),
          });
          startupSafe = startup?.enabled === true || startup?.enabled === false;
          startupEnabled = startup?.enabled === true;
        } catch {
          startupSafe = false;
        }
      }
      checks.push(check(
        "windows-startup",
        "Windows start at login",
        startupSafe ? "pass" : "attention",
        startupSafe
          ? startupEnabled
            ? "Start at login is registered to the exact per-user Equinox Local shell."
            : "Start at login is disabled and no foreign registration owns the Equinox Local startup entry."
          : "The Equinox Local per-user startup registration is unreadable or owned by another command.",
      ));

      let nativeHostOwned = false;
      if (typeof releaseDir === "string" && typeof manifestRoot === "string") {
        try {
          await assertWindowsNativeHostImpl({
            manifestRoot,
            acceptedLauncherPaths: [windowsNativeMessagingLauncherPath(releaseDir)],
            fsImpl,
            env: windowsDoctorProbeEnvironment(runtimeEnv),
          });
          nativeHostOwned = true;
        } catch {
          nativeHostOwned = false;
        }
      }
      checks.push(check(
        "native-host",
        "Equinox Browser host",
        nativeHostOwned ? "pass" : "attention",
        nativeHostOwned
          ? "The Windows Native Messaging host is registered to the active managed release."
          : "The Equinox Browser Windows Native Messaging registration needs repair or reinstall.",
      ));
    } else {
      checks.push(check(
        "managed-lifecycle",
        "Managed lifecycle",
        "attention",
        "The managed lifecycle type does not match this supported host.",
      ));
    }

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

    if (installation?.kind === "source" && developmentPeekaboo) {
      if (developmentPeekaboo.configured === false) {
        checks.push(check(
          "development-peekaboo",
          "Development Peekaboo runtime",
          "optional",
          "No private source-runtime configuration is present, so Peekaboo version synchronization is not checked.",
        ));
      } else {
        const actual = developmentPeekaboo.actualVersion || "unknown";
        const expected = developmentPeekaboo.expectedVersion || "unknown";
        checks.push(check(
          "development-peekaboo",
          "Development Peekaboo runtime",
          developmentPeekaboo.synchronized === true ? "pass" : "attention",
          developmentPeekaboo.synchronized === true
            ? `Development Peekaboo ${actual} matches the pinned desktop runtime version.`
            : `Development Peekaboo ${actual} does not match pinned version ${expected}. Restart Equinox Local to synchronize it.`,
        ));
      }
    }
  }

  const browserRequired = installation?.managed === true;
  const browserUser = browser?.contexts?.user ?? browser?.user ?? browser ?? {};
  const browserAgent = browser?.contexts?.agent ?? browser?.agent ?? {};
  const agentBrowser = browser?.agentBrowser ?? {};
  if (!browserUser?.ready) {
    checks.push(check(
      "browser",
      "Equinox Browser · Your Browser",
      browserRequired ? "attention" : "optional",
      browserRequired
        ? "Equinox Browser is required but is not connected to Your Browser."
        : "Equinox Browser is not connected in Your Browser for this development runtime.",
    ));
  } else if (browserRequired && browserUser.consentAccepted !== true) {
    checks.push(check(
      "browser",
      "Equinox Browser · Your Browser",
      "attention",
      "Your Browser is connected, but the browser-data disclosure has not been accepted yet.",
    ));
  } else if (browserRequired && browserUser.controlEnabled !== true) {
    checks.push(check(
      "browser",
      "Equinox Browser · Your Browser",
      "attention",
      "Your Browser is connected and consented, but Browser Control is turned off.",
    ));
  } else {
    checks.push(check(
      "browser",
      "Equinox Browser · Your Browser",
      "pass",
      browserRequired
        ? "The required Your Browser context is connected, consented and Browser Control is enabled."
        : "Your Browser is connected in this development runtime.",
    ));
  }

  if (browserAgent?.ready) {
    const agentNeedsConsent = browserAgent.consentAccepted === false;
    const agentControlOff = browserAgent.controlEnabled === false;
    checks.push(check(
      "agent-browser",
      "Equinox Browser · Agent Browser",
      agentNeedsConsent || agentControlOff ? "attention" : "pass",
      agentNeedsConsent
        ? "Agent Browser is connected, but its browser-data disclosure has not been accepted yet."
        : agentControlOff
          ? "Agent Browser is connected, but Browser Control is turned off in the isolated profile."
          : "Agent Browser is connected as the isolated default browser context.",
    ));
  } else if (agentBrowser?.pairing) {
    checks.push(check(
      "agent-browser",
      "Equinox Browser · Agent Browser",
      "attention",
      "Agent Browser is open and waiting for the isolated Equinox Browser profile to finish pairing.",
    ));
  } else if (agentBrowser?.setupComplete) {
    checks.push(check(
      "agent-browser",
      "Equinox Browser · Agent Browser",
      "pass",
      "Agent Browser setup is complete and the isolated browser is currently closed; it will open on demand.",
    ));
  } else if (agentBrowser?.lastLaunchError) {
    checks.push(check(
      "agent-browser",
      "Equinox Browser · Agent Browser",
      "attention",
      "Agent Browser needs attention after its most recent launch attempt.",
    ));
  } else {
    checks.push(check(
      "agent-browser",
      "Equinox Browser · Agent Browser",
      "optional",
      agentBrowser?.supported === false
        ? "Agent Browser is not available on this host."
        : "Agent Browser has not been set up yet; it remains isolated from Your Browser and will be prepared on first use.",
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
    host: Object.freeze({
      platform: hostDescriptor.platform,
      arch: hostDescriptor.arch,
      target: hostDescriptor.target ?? null,
      displayName: hostDescriptor.displayName || hostDescriptor.platform,
      supported: hostDescriptor.supported !== false,
    }),
    summary,
    checks: Object.freeze(checks),
  });
}

export function registerSystemDoctorTool({
  registerTextTool,
  getDoctorStatus,
  textResult,
  errorResult,
} = {}) {
  registerTextTool(
    "system_doctor",
    {
      description:
        "Equinox Local kurulumunu, runtime sağlığını, yapılandırmayı, güvenli güncelleme hazırlığını, ChatGPT bağlantısını, zorunlu Equinox Browser köprüsünü ve isteğe bağlı Desktop köprüsünü ürün-dostu ve salt okunur biçimde denetler.",
      inputSchema: {},
      annotations: {
        title: "Equinox Local sağlık kontrolü",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const doctor = await getDoctorStatus();
        return textResult([
          `Equinox Local system doctor: ${doctor.state}`,
          `Checks: ${doctor.summary.pass} passed, ${doctor.summary.attention} need attention, ${doctor.summary.optional} optional.`,
          ...doctor.checks.map(
            (item) =>
              `${item.status === "pass" ? "OK" : item.status === "attention" ? "ATTENTION" : "OPTIONAL"} | ${item.label} | ${item.detail}`,
          ),
        ].join("\n"));
      } catch (error) {
        return errorResult(error);
      }
    },
    { projectAware: false },
  );
}
