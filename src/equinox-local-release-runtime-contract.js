import path from "node:path";

import { EQUINOX_LOCAL_BUNDLED_PEEKABOO_SINCE_VERSION } from "./equinox-local-runtime-versions.js";
import { compareEquinoxVersions, parseEquinoxVersion } from "./equinox-local-updater.js";

const WINDOWS_X64_TARGET = "win32-x64";
const DARWIN_TARGET_PATTERN = /^darwin-(?:arm64|x64)$/u;

const DARWIN_BASE_EXECUTABLES = Object.freeze([
  path.join("runtime", "node", "bin", "node"),
  path.join("runtime", "tunnel", "tunnel-client"),
  path.join("runtime", "tunnel", "cloudflared"),
]);
const DARWIN_PEEKABOO_EXECUTABLES = Object.freeze([
  path.join("runtime", "peekaboo", "peekaboo"),
  path.join("runtime", "peekaboo", "libswiftCompatibilitySpan.dylib"),
]);
const DARWIN_PEEKABOO_DOCUMENTS = Object.freeze([
  path.join("runtime", "peekaboo", "LICENSE"),
  path.join("runtime", "peekaboo", "README.md"),
  path.join("runtime", "peekaboo", "VERSION"),
]);
const WINDOWS_EXECUTABLES = Object.freeze([
  path.join("runtime", "node", "bin", "node.exe"),
  path.join("runtime", "tunnel", "tunnel-client.exe"),
  path.join("runtime", "tunnel", "cloudflared.exe"),
  path.join("runtime", "browser", "equinox-browser-native-host.exe"),
]);
const SHARED_RUNTIME_DOCUMENTS = Object.freeze([
  path.join("runtime", "tunnel", "LICENSE"),
  path.join("runtime", "tunnel", "NOTICE"),
]);
const WINDOWS_SHELL_FILES = Object.freeze([
  path.join("runtime", "shell", "EquinoxLocal.exe"),
  path.join("runtime", "shell", "coreclr.dll"),
  path.join("runtime", "shell", "hostfxr.dll"),
  path.join("runtime", "shell", "Microsoft.Web.WebView2.Core.dll"),
]);
const DARWIN_RELEASE_FILES = Object.freeze([
  "server.js",
  "equinox-local-bootstrap.js",
  "equinox-local-supervisor.js",
  "equinox-local-first-install.js",
  "equinox-local-onboarding.js",
]);
const WINDOWS_RELEASE_FILES = Object.freeze([
  "server.js",
  "equinox-browser-native-host.js",
  "equinox-browser-native-host-runtime.js",
  "equinox-browser-socket.js",
  "equinox-local-windows-job-object.ps1",
  "equinox-local-windows-process-gate.ps1",
]);

export function equinoxLocalReleaseRuntimeContract({ target, version } = {}) {
  const normalizedVersion = parseEquinoxVersion(version).text;
  if (DARWIN_TARGET_PATTERN.test(target)) {
    const peekaboo = compareEquinoxVersions(
      normalizedVersion,
      EQUINOX_LOCAL_BUNDLED_PEEKABOO_SINCE_VERSION,
    ) >= 0;
    return Object.freeze({
      target,
      version: normalizedVersion,
      platform: "darwin",
      executableModeRequired: true,
      bundledPeekaboo: peekaboo,
      runtimeExecutables: Object.freeze([
        ...DARWIN_BASE_EXECUTABLES,
        ...(peekaboo ? DARWIN_PEEKABOO_EXECUTABLES : []),
      ]),
      runtimeDocuments: Object.freeze([
        ...SHARED_RUNTIME_DOCUMENTS,
        ...(peekaboo ? DARWIN_PEEKABOO_DOCUMENTS : []),
      ]),
      requiredReleaseFiles: DARWIN_RELEASE_FILES,
      nativeShellFiles: Object.freeze([]),
      nativeAppKind: "macos-app",
    });
  }
  if (target === WINDOWS_X64_TARGET) {
    return Object.freeze({
      target,
      version: normalizedVersion,
      platform: "win32",
      executableModeRequired: false,
      bundledPeekaboo: false,
      runtimeExecutables: WINDOWS_EXECUTABLES,
      runtimeDocuments: SHARED_RUNTIME_DOCUMENTS,
      requiredReleaseFiles: WINDOWS_RELEASE_FILES,
      nativeShellFiles: WINDOWS_SHELL_FILES,
      nativeAppKind: "windows-shell",
    });
  }
  throw new Error(`Managed Equinox Local release runtime is not implemented for ${target}.`);
}
