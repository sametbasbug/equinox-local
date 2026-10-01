import os from "node:os";
import path from "node:path";

export const EQUINOX_LOCAL_SUPPORTED_HOST_PLATFORMS = Object.freeze(["darwin", "win32"]);
export const EQUINOX_LOCAL_SUPPORTED_ARCHITECTURES = Object.freeze(["arm64", "x64"]);
export const EQUINOX_LOCAL_RELEASE_TARGET_MATRIX = Object.freeze([
  Object.freeze({ target: "darwin-arm64", platform: "darwin", arch: "arm64", artifactExtension: ".tar.gz", buildAuthority: "factory-native", nativeRunner: null }),
  Object.freeze({ target: "darwin-x64", platform: "darwin", arch: "x64", artifactExtension: ".tar.gz", buildAuthority: "github-native", nativeRunner: "macos-15-intel" }),
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
      nativeDesktopAutomation: platform === "darwin",
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

export function equinoxLocalFiniteShell({ platform = process.platform, arch = process.arch } = {}) {
  equinoxLocalReleaseTarget({ platform, arch });
  if (platform === "darwin") {
    return Object.freeze({
      command: "/bin/zsh",
      argsFor(command) { return ["-lc", command]; },
      pathPrefix: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
      pathDelimiter: ":",
    });
  }
  return Object.freeze({
    command: "powershell.exe",
    argsFor(command) {
      return ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command];
    },
    pathPrefix: "",
    pathDelimiter: ";",
  });
}

export function equinoxLocalInteractiveShells({ platform = process.platform, arch = process.arch } = {}) {
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
      powershell: Object.freeze({ command: "powershell.exe", args: Object.freeze(["-NoLogo", "-NoProfile"]) }),
    }),
  });
}
