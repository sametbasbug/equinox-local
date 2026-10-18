import os from "node:os";
import { lstatSync } from "node:fs";
import path from "node:path";

export const EQUINOX_LOCAL_SUPPORTED_HOST_PLATFORMS = Object.freeze(["darwin", "win32"]);
export const EQUINOX_LOCAL_SUPPORTED_ARCHITECTURES = Object.freeze(["arm64", "x64"]);
export const EQUINOX_LOCAL_RELEASE_TARGET_MATRIX = Object.freeze([
  Object.freeze({ target: "darwin-arm64", platform: "darwin", arch: "arm64", artifactExtension: ".tar.gz", buildAuthority: "factory-native", nativeRunner: null }),
  Object.freeze({ target: "darwin-x64", platform: "darwin", arch: "x64", artifactExtension: ".tar.gz", buildAuthority: "github-native", nativeRunner: "macos-26-intel" }),
  Object.freeze({ target: "win32-arm64", platform: "win32", arch: "arm64", artifactExtension: ".zip", buildAuthority: "github-native", nativeRunner: "windows-11-vs2026-arm" }),
  Object.freeze({ target: "win32-x64", platform: "win32", arch: "x64", artifactExtension: ".zip", buildAuthority: "github-native", nativeRunner: "windows-latest" }),
]);
export const EQUINOX_LOCAL_SUPPORTED_RELEASE_TARGETS = Object.freeze(EQUINOX_LOCAL_RELEASE_TARGET_MATRIX.map((entry) => entry.target));

const TARGET_SET = new Set(EQUINOX_LOCAL_SUPPORTED_RELEASE_TARGETS);
const TARGET_CONTRACTS = new Map(EQUINOX_LOCAL_RELEASE_TARGET_MATRIX.map((entry) => [entry.target, entry]));

export function equinoxLocalReleaseTargetContract(target) {
  const contract = TARGET_CONTRACTS.get(target);
  if (!contract) throw new Error(`Unsupported Equinox Local release target: ${target}`);
  return contract;
}

export function equinoxLocalReleaseArtifactName(version, target) {
  if (typeof version !== "string" || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(version)) {
    throw new Error("Equinox Local release artifact version is invalid.");
  }
  const contract = equinoxLocalReleaseTargetContract(target);
  return `equinox-local-${version}-${target}${contract.artifactExtension}`;
}

function requireAbsolute(value, pathApi, label) {
  if (typeof value !== "string" || !value || !pathApi.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path.`);
  }
  return pathApi.normalize(value);
}

export function equinoxLocalReleaseTarget({ platform = process.platform, arch = process.arch } = {}) {
  const target = `${platform}-${arch}`;
  if (!TARGET_SET.has(target)) throw new Error(`Unsupported Equinox Local release target: ${target}`);
  return target;
}

export function equinoxLocalHostDescriptor({ platform = process.platform, arch = process.arch } = {}) {
  const target = equinoxLocalReleaseTarget({ platform, arch });
  const windows = platform === "win32";
  return Object.freeze({
    platform,
    family: platform,
    arch,
    target,
    displayName: windows ? "Windows" : "macOS",
    pathFlavor: windows ? "win32" : "posix",
    executableSuffix: windows ? ".exe" : "",
    features: Object.freeze({
      nativeShell: true,
      nativeDesktopAutomation: true,
      launchAgent: platform === "darwin",
      windowsUserLifecycle: windows,
      unixDomainSocket: platform === "darwin",
      namedPipe: windows,
      nativeMessagingRegistry: windows,
    }),
  });
}

export function equinoxLocalPlatformPaths({
  platform = process.platform,
  arch = process.arch,
  homeDir = os.homedir(),
  env = process.env,
} = {}) {
  const host = equinoxLocalHostDescriptor({ platform, arch });
  if (platform === "darwin") {
    const home = requireAbsolute(homeDir, path.posix, "Equinox Local home directory");
    const appDataRoot = path.posix.join(home, "Library", "Application Support", "Equinox Local");
    return Object.freeze({
      host,
      homeDir: home,
      appDataRoot,
      releasesRoot: path.posix.join(appDataRoot, "releases"),
      stateRoot: appDataRoot,
      logsRoot: path.posix.join(home, "Library", "Logs"),
      runtimeRoot: path.posix.join(appDataRoot, "runtime"),
      browserRoot: path.posix.join(appDataRoot, "Agent Browser"),
      downloadsRoot: path.posix.join(home, "Downloads"),
      programRoot: path.posix.join(home, "Applications"),
      configPath: path.posix.join(appDataRoot, "config.json"),
      turnBudgetPath: path.posix.join(appDataRoot, "turn-budget.json"),
      nativeMessagingManifestRoot: path.posix.join(home, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts"),
      currentPointer: path.posix.join(appDataRoot, "current"),
    });
  }

  const localAppData = requireAbsolute(env?.LOCALAPPDATA, path.win32, "LOCALAPPDATA");
  const home = requireAbsolute(homeDir, path.win32, "Equinox Local home directory");
  const appDataRoot = path.win32.join(localAppData, "Equinox Local");
  const stateRoot = path.win32.join(appDataRoot, "state");
  return Object.freeze({
    host,
    homeDir: home,
    appDataRoot,
    releasesRoot: path.win32.join(appDataRoot, "releases"),
    stateRoot,
    logsRoot: path.win32.join(appDataRoot, "logs"),
    runtimeRoot: path.win32.join(appDataRoot, "runtime"),
    browserRoot: path.win32.join(appDataRoot, "browser"),
    downloadsRoot: path.win32.join(home, "Downloads"),
    programRoot: path.win32.join(localAppData, "Programs", "Equinox Local"),
    configPath: path.win32.join(stateRoot, "config.json"),
    turnBudgetPath: path.win32.join(stateRoot, "turn-budget.json"),
    nativeMessagingManifestRoot: path.win32.join(appDataRoot, "browser", "native-messaging"),
    currentPointer: path.win32.join(appDataRoot, "current-version.json"),
  });
}

export function equinoxLocalManagedLifecycle({ platform = process.platform, arch = process.arch } = {}) {
  const host = equinoxLocalHostDescriptor({ platform, arch });
  if (platform === "darwin") {
    return Object.freeze({
      host,
      kind: "launch-agent",
      implemented: true,
      currentPointerKind: "symlink",
      processOwnership: "posix-session",
    });
  }
  return Object.freeze({
    host,
    kind: "windows-user",
    implemented: true,
    currentPointerKind: "version-file",
    processOwnership: "job-object",
  });
}

// The Windows managed runtime deliberately runs with a restricted PATH.
// ConPTY's relative executable resolver can return an EMPTY path despite a
// perfectly healthy OS; resolve the fixed Microsoft shell under SystemRoot.
export function equinoxLocalWindowsPowerShellPath(env = process.env) {
  const systemRoot = env?.SystemRoot || env?.SYSTEMROOT || env?.WINDIR || "C:\\Windows";
  if (typeof systemRoot !== "string" || !path.win32.isAbsolute(systemRoot)) {
    throw new Error("Windows PowerShell requires an absolute SystemRoot.");
  }
  return path.win32.join(path.win32.normalize(systemRoot), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

// PowerShell 7 is optional. Probe OS-known directories, not executable PATH.
export function equinoxLocalWindowsPowerShell7Path(env = process.env, { statFile = lstatSync } = {}) {
  const systemRoot = equinoxLocalWindowsPowerShellPath(env);
  const defaultProgramFiles = path.win32.join(path.win32.parse(systemRoot).root, "Program Files");
  const roots = [env?.ProgramW6432, env?.ProgramFiles, env?.PROGRAMFILES, defaultProgramFiles];
  const seen = new Set();
  for (const root of roots) {
    if (typeof root !== "string" || !path.win32.isAbsolute(root)) continue;
    const candidate = path.win32.join(root, "PowerShell", "7", "pwsh.exe");
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if (statFile(candidate).isFile()) return candidate;
    } catch { /* Not installed here. */ }
  }
  return null;
}

export function equinoxLocalFiniteShell({ platform = process.platform, arch = process.arch, env = process.env, shell = platform === "win32" ? "powershell" : "zsh", statFile = lstatSync } = {}) {
  equinoxLocalReleaseTarget({ platform, arch });
  if (platform === "darwin") {
    if (shell !== "zsh") throw new Error("Unsupported macOS finite shell: " + shell);
    return Object.freeze({
      command: "/bin/zsh",
      argsFor(command) { return ["-lc", command]; },
      pathPrefix: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
      pathDelimiter: ":",
    });
  }
  if (shell !== "powershell" && shell !== "pwsh") throw new Error("Unsupported Windows finite shell: " + shell);
  const selectedCommand = shell === "pwsh"
    ? equinoxLocalWindowsPowerShell7Path(env, { statFile })
    : equinoxLocalWindowsPowerShellPath(env);
  if (!selectedCommand) throw new Error("PowerShell 7 (pwsh) is not installed; install it separately or use powershell (5.1).");
  return Object.freeze({
    command: selectedCommand,
    argsFor(commandText) {
      // A nested PowerShell process is launched through an owned-process gate.
      // UTF-16LE encoding avoids Windows PowerShell 5.1 command-line quoting
      // ambiguity and keeps an unrequested console window off the desktop.
      // WinPS writes serialized CLIXML progress to stderr when commands
      // auto-load modules, even for successful noninteractive execution.
      const encoded = Buffer.from(`$ProgressPreference = 'SilentlyContinue'; ${commandText}`, "utf16le").toString("base64");
      return ["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", encoded];
    },
    pathPrefix: "",
    pathDelimiter: ";",
  });
}

export function equinoxLocalInteractiveShells({ platform = process.platform, arch = process.arch, env = process.env, statFile = lstatSync } = {}) {
  equinoxLocalReleaseTarget({ platform, arch });
  if (platform === "darwin") {
    return Object.freeze({
      defaultShell: "zsh",
      shells: Object.freeze({
        zsh: Object.freeze({ command: "/bin/zsh", args: Object.freeze(["-l"]) }),
        bash: Object.freeze({ command: "/bin/bash", args: Object.freeze(["-l"]) }),
      }),
    });
  }
  return Object.freeze({
    defaultShell: "powershell",
    shells: Object.freeze({
      powershell: Object.freeze({ command: equinoxLocalWindowsPowerShellPath(env), args: Object.freeze(["-NoLogo", "-NoProfile"]) }),
      pwsh: Object.freeze({ command: equinoxLocalWindowsPowerShell7Path(env, { statFile }), args: Object.freeze(["-NoLogo", "-NoProfile"]) }),
    }),
  });
}
