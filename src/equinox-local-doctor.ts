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
import { readEquinoxLocalMainNativePointer } from "./equinox-local-main-native-state.js";
import { readEquinoxLocalMainSourcePointer } from "./equinox-local-main-source-pointer.js";
import { readWindowsStartupRegistrationOwnership } from "./equinox-local-uninstall-helper.js";
import { assertWindowsStableShellOwnedByRelease } from "./equinox-local-windows-stable-shell.js";

type DoctorStatus = "pass" | "attention" | "optional";
type DoctorCheck = Readonly<{id:string;label:string;status:DoctorStatus;detail:string}>;
type DoctorSummary = Readonly<{pass:number;attention:number;optional:number;total:number}>;
type DoctorHost = {
  platform:string;arch:string;target?:string | null;displayName?:string;supported?:boolean;
};
type DoctorInstallation = {
  kind?:string;managed?:boolean;selfUpdateSupported?:boolean;
  mainTransactionRoot?:string;sourceRoot?:string;sourceSha?:string;
  mainNativeSha?:string;gitPath?:string;releaseDir?:string;installRoot?:string;
  lifecycleKind?:string;launchAgentPath?:string;programRoot?:string;
  nativeMessagingManifestRoot?:string;reason?:string;
};
type DoctorWorkspace = {root?:string};
type DoctorConfig = {version?:number;runtime?:{workspaceProject?:string};projects?:Record<string,DoctorWorkspace>};
type DoctorBrowserContext = {ready?:boolean;consentAccepted?:boolean | null;controlEnabled?:boolean | null};
type DoctorBrowser = DoctorBrowserContext & {
  contexts?:{user?:DoctorBrowserContext;agent?:DoctorBrowserContext};
  user?:DoctorBrowserContext;agent?:DoctorBrowserContext;
  agentBrowser?:{pairing?:boolean;setupComplete?:boolean;lastLaunchError?:string;supported?:boolean};
};
type DoctorStatusResult = Readonly<{
  state:"HEALTHY"|"ATTENTION";checkedAt:string;installationKind:string;managed:boolean;
  host:Readonly<{platform:string;arch:string;target:string | null;displayName:string;supported:boolean}>;
  summary:DoctorSummary;checks:ReadonlyArray<DoctorCheck>;
}>;
type DoctorOptions = {
  installation?:DoctorInstallation;config?:DoctorConfig;
  runtimeHealthState?:string;runtimeVersion?:string;sourceCheckoutVersion?:string | null;
  browser?:DoctorBrowser;peekaboo?:{ready?:boolean;active?:boolean;needsAttention?:boolean};
  desktop?:{engine?:string;active?:boolean;version?:string;compatibility?:{ok?:boolean}};
  update?:{selfUpdateSupported?:boolean;configured?:boolean};
  onboarding?:{needsAttention?:boolean;issue?:string;connectedThroughTunnel?:boolean;transportConfigured?:boolean};
  developmentTunnel?:{configured?:boolean;actualVersion?:string;expectedVersion?:string;synchronized?:boolean} | null;
  developmentPeekaboo?:{configured?:boolean;actualVersion?:string;expectedVersion?:string;synchronized?:boolean} | null;
  host?:DoctorHost | null;homeDir?:string;fsImpl?:typeof fs;
  verifyWindowsAcl?:((input:{target:string;type:"file"|"directory"})=>Promise<boolean | {safe:boolean;reason?:string | null}>) | null;
  readCurrentReleaseImpl?:typeof readManagedCurrentRelease;
  readMainNativePointerImpl?:typeof readEquinoxLocalMainNativePointer;
  readMainSourcePointerImpl?:typeof readEquinoxLocalMainSourcePointer;
  assertWindowsStableShellImpl?:typeof assertWindowsStableShellOwnedByRelease;
  assertWindowsNativeHostImpl?:typeof assertWindowsNativeMessagingHostOwnership;
  readWindowsStartupImpl?:typeof readWindowsStartupRegistrationOwnership;
  runtimeEnv?:NodeJS.ProcessEnv;
  terminalExecution?:{healthy?:boolean} | null;
  now?:()=>Date;
};
type DoctorToolOptions = {
  registerTextTool:(name:string,config:{
    description:string;inputSchema:Record<string,unknown>;
    annotations:{title:string;readOnlyHint:boolean;destructiveHint:boolean;idempotentHint:boolean;openWorldHint:boolean};
  },handler:()=>Promise<unknown>,options:{projectAware:boolean})=>unknown;
  getDoctorStatus:()=>Promise<DoctorStatusResult>;
  textResult:(content:string)=>unknown;
  errorResult:(error:unknown)=>unknown;
};
type ErrorCode={code?:string};

const NATIVE_HOST_NAME = "dev.equinox.browser";

function unixMode(mode:number):string {
  return (mode & 0o777).toString(8).padStart(3, "0");
}

async function inspectPath(target:string, {
  type,
  mode,
  fsImpl = fs,
}: {type?:string;mode?:string;fsImpl?:typeof fs} = {}) {
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
    if ((error as ErrorCode)?.code === "ENOENT") {
      return Object.freeze({ exists: false, safe: false, type: null, mode: null });
    }
    return Object.freeze({ exists: false, safe: false, type: null, mode: null });
  }
}

function check(id:string,label:string,status:DoctorStatus,detail:string):DoctorCheck {
  return Object.freeze({ id, label, status, detail });
}

function summarize(checks:ReadonlyArray<DoctorCheck>):DoctorSummary {
  const pass = checks.filter((item) => item.status === "pass").length;
  const attention = checks.filter((item) => item.status === "attention").length;
  const optional = checks.filter((item) => item.status === "optional").length;
  return Object.freeze({ pass, attention, optional, total: checks.length });
}

function windowsDoctorProbeEnvironment(env:NodeJS.ProcessEnv = process.env) {
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
  desktop = {},
  update = {},
  onboarding = {},
  developmentTunnel = null,
  developmentPeekaboo = null,
  host = null,
  homeDir = os.homedir(),
  fsImpl = fs,
  verifyWindowsAcl = null,
  readCurrentReleaseImpl = readManagedCurrentRelease,
  readMainNativePointerImpl = readEquinoxLocalMainNativePointer,
  readMainSourcePointerImpl = readEquinoxLocalMainSourcePointer,
  assertWindowsStableShellImpl = assertWindowsStableShellOwnedByRelease,
  assertWindowsNativeHostImpl = assertWindowsNativeMessagingHostOwnership,
  readWindowsStartupImpl = readWindowsStartupRegistrationOwnership,
  runtimeEnv = process.env,
  terminalExecution = null,
  now = () => new Date(),
}: DoctorOptions = {}):Promise<DoctorStatusResult> {
  const checks:DoctorCheck[] = [];
  const hostDescriptor:DoctorHost = host || (() => {
    try {
      return equinoxLocalHostDescriptor();
    } catch {
      return Object.freeze({ platform: process.platform, arch: process.arch, target: null, displayName: process.platform, supported: false });
    }
  })();
  // Main native state is fingerprinted and content-addressed. A managed Main
  // update may reclaim its old Stable A release directory, so the legacy
  // numbered current-version pointer cannot attest the active Main runtime.
  // Cache this expensive integrity check within one Doctor invocation: Windows
  // shell/Browser ownership must use exactly the same verified native identity.
  let mainNativePromise:ReturnType<typeof readEquinoxLocalMainNativePointer> | undefined;
  const readActiveMainNative = ():ReturnType<typeof readEquinoxLocalMainNativePointer> => {
    if (!mainNativePromise) {
      const transactionRoot = installation?.mainTransactionRoot;
      const pointerPath = (hostDescriptor.platform === "win32" ? path.win32 : path.posix)
        .join(transactionRoot!, "current-native.json");
      mainNativePromise = readMainNativePointerImpl(pointerPath, { transactionRoot: transactionRoot!, fsImpl });
    }
    return mainNativePromise;
  };
  const healthyRuntime = runtimeHealthState === "HEALTHY";
  checks.push(check(
    "runtime",
    "Local runtime",
    healthyRuntime ? "pass" : "attention",
    healthyRuntime
      ? `Equinox Local ${runtimeVersion || "is running"} and reports healthy.`
      : "The local runtime is not reporting a healthy state.",
  ));

  if (terminalExecution && hostDescriptor.platform === "win32") {
    checks.push(check(
      "windows-terminal-execution",
      "Windows terminal execution",
      terminalExecution.healthy === true ? "pass" : "attention",
      terminalExecution.healthy === true
        ? "PowerShell output and nonzero exit status passed the managed Job Object test."
        : "Managed Windows terminal output or exit status failed. Check terminal diagnostics.",
    ));
  }

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
    const workspaceState = await inspectPath(workspace!.root!, { type: "directory", fsImpl });
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
      if (installation.kind === "managed-source") {
        const transactionRoot = installation.mainTransactionRoot;
        const pathApi = hostDescriptor.platform === "win32" ? path.win32 : path.posix;
        if (typeof transactionRoot !== "string" || !pathApi.isAbsolute(transactionRoot) ||
            typeof installation.sourceRoot !== "string" || !pathApi.isAbsolute(installation.sourceRoot) ||
            !/^[a-f0-9]{40}$/u.test(installation.sourceSha ?? "")) {
          throw new Error("Verified Main installation identity is unavailable.");
        }
        const source = await readMainSourcePointerImpl(pathApi.join(transactionRoot, "current-source.conf"), {
          fsImpl, ...(installation.gitPath ? { gitPath: installation.gitPath } : {}),
        });
        const equivalent = (a:string,b:string) => hostDescriptor.platform === "win32"
          ? pathApi.normalize(a).toLowerCase() === pathApi.normalize(b).toLowerCase()
          : pathApi.normalize(a) === pathApi.normalize(b);
        if (source.sha !== installation.sourceSha || !equivalent(source.sourceRoot, installation.sourceRoot)) {
          throw new Error("Active Main source pointer changed after verified boot.");
        }
        let payload = "";
        if (installation.mainNativeSha) {
          const native = await readActiveMainNative();
          if (native.sourceSha !== installation.sourceSha || native.sourceSha !== installation.mainNativeSha ||
              native.target !== hostDescriptor.target || !equivalent(native.releaseDir, installation.releaseDir!)) {
            throw new Error("Active Main native release does not match the verified source.");
          }
          payload = ` and native ${native.payloadVersion}`;
        }
        checks.push(check("release", "Active release", "pass",
          `Main ${installation.sourceSha.slice(0, 12)}${payload} passed source and runtime identity validation.`));
      } else {
        const current = await readCurrentReleaseImpl(installation);
        checks.push(check("release", "Active release", "pass",
          `Managed release ${current.version} passed layout and runtime validation.`));
      }
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
        inspectPrivateStatePath(installation.launchAgentPath!, { platform: hostDescriptor.platform, type: "file", mode: "600", fsImpl, verifyWindowsAcl }),
        inspectPrivateStatePath(path.join(installation.installRoot!, "config.json"), { platform: hostDescriptor.platform, type: "file", mode: "600", fsImpl, verifyWindowsAcl }),
        inspectPrivateStatePath(path.join(installation.installRoot!, "equinox-browser-native-host"), { platform: hostDescriptor.platform, type: "file", mode: "700", fsImpl, verifyWindowsAcl }),
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

      // Once Main activates a native release, the numbered Stable bootstrap A
      // remains for recovery. Doctor must verify the active B shell and browser
      // host, not report those intact files as foreign to the old A package.
      // Never trust a pathname from an unvalidated pointer: readMainNativePointer
      // verifies the canonical store manifest, source SHA, runtime contract and
      // exact file fingerprint. A present but corrupt pointer fails closed.
      let ownedReleaseDir:string | null | undefined = releaseDir;
      if (typeof installation.installRoot === "string" && path.win32.isAbsolute(installation.installRoot)) {
        const transactionRoot = path.win32.join(installation.installRoot, "state", "main-update");
        const pointerPath = path.win32.join(transactionRoot!, "current-native.json");
        let pointerPresent = false;
        try {
          await fsImpl.lstat(pointerPath);
          pointerPresent = true;
        } catch (error) {
          if ((error as ErrorCode)?.code !== "ENOENT") pointerPresent = true;
        }
        if (pointerPresent) {
          ownedReleaseDir = null;
          try {
            const current = installation.kind === "managed-source" && installation.mainNativeSha
              ? await readActiveMainNative()
              : await readMainNativePointerImpl(pointerPath, { transactionRoot: transactionRoot!, fsImpl });
            if (current.target === hostDescriptor.target && path.win32.isAbsolute(current.releaseDir)) {
              ownedReleaseDir = current.releaseDir;
            }
          } catch { /* Unsafe native pointers must never fall back to the old Stable release. */ }
        }
      }

      let shellOwned = false;
      if (typeof ownedReleaseDir === "string" && typeof programRoot === "string") {
        try {
          await assertWindowsStableShellImpl({ releaseDir: ownedReleaseDir, programRoot, fsImpl });
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
      if (typeof ownedReleaseDir === "string" && typeof manifestRoot === "string") {
        try {
          await assertWindowsNativeHostImpl({
            manifestRoot,
            acceptedLauncherPaths: [windowsNativeMessagingLauncherPath(ownedReleaseDir)],
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
      "optional",
      "Your Browser is currently disconnected (normal when personal Chrome is closed). Open Chrome and Equinox Browser when you want to use that browser context.",
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

  if (hostDescriptor.platform === "win32") {
    const winappReady = desktop?.engine === "winapp" && desktop?.active === true && desktop?.compatibility?.ok !== false;
    checks.push(check(
      "desktop",
      "Windows desktop · winapp",
      winappReady ? "pass" : "attention",
      winappReady
        ? `Microsoft winapp ${desktop.version ?? "desktop bridge"} is available.`
        : "Required Windows desktop automation is unavailable; check the pinned Microsoft winapp runtime.",
    ));
  } else {
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

  }

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
}:DoctorToolOptions = {} as DoctorToolOptions):void {
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
