import path from "node:path";

import {
  EQUINOX_LOCAL_BUNDLED_PEEKABOO_SINCE_VERSION,
  EQUINOX_LOCAL_BUNDLED_WINAPP_SINCE_VERSION,
  EQUINOX_LOCAL_NATIVE_JOB_OBJECT_HELPER_SINCE_VERSION,
} from "./equinox-local-runtime-versions.js";
import { compareEquinoxVersions, parseEquinoxVersion } from "./equinox-local-updater.js";

const WINDOWS_TARGET_PATTERN = /^win32-(?:arm64|x64)$/u;
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
const WINDOWS_BASE_EXECUTABLES = Object.freeze([
  path.join("runtime", "node", "bin", "node.exe"),
  path.join("runtime", "tunnel", "tunnel-client.exe"),
  path.join("runtime", "tunnel", "cloudflared.exe"),
  path.join("runtime", "browser", "equinox-browser-native-host.exe"),
]);
const WINDOWS_JOB_OBJECT_EXECUTABLES = Object.freeze([
  path.join("runtime", "job", "equinox-local-job-object-helper.exe"),
]);
const WINDOWS_WINAPP_EXECUTABLES = Object.freeze([
  path.join("runtime", "winapp", "winapp.exe"),
  path.join("runtime", "winapp", "libHarfBuzzSharp.dll"),
  path.join("runtime", "winapp", "libSkiaSharp.dll"),
]);
const WINDOWS_WINAPP_DOCUMENTS = Object.freeze([
  path.join("runtime", "winapp", "LICENSE"),
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
  "equinox-local-windows-clipboard.ps1",
  "equinox-local-windows-desktop.ps1",
  "equinox-local-windows-private-state.ps1",
  "equinox-local-windows-process-gate.ps1",
  "equinox-local-windows-release-zip.ps1",
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
  if (WINDOWS_TARGET_PATTERN.test(target)) {
    const winapp = compareEquinoxVersions(normalizedVersion, EQUINOX_LOCAL_BUNDLED_WINAPP_SINCE_VERSION) >= 0;
    const nativeJobObjectHelper = compareEquinoxVersions(normalizedVersion, EQUINOX_LOCAL_NATIVE_JOB_OBJECT_HELPER_SINCE_VERSION) >= 0;
    return Object.freeze({
      target,
      version: normalizedVersion,
      platform: "win32",
      executableModeRequired: false,
      bundledPeekaboo: false,
      bundledWinapp: winapp,
      nativeJobObjectHelper,
      runtimeExecutables: Object.freeze([
        ...WINDOWS_BASE_EXECUTABLES,
        ...(nativeJobObjectHelper ? WINDOWS_JOB_OBJECT_EXECUTABLES : []),
        ...(winapp ? WINDOWS_WINAPP_EXECUTABLES : []),
      ]),
      runtimeDocuments: Object.freeze([
        ...SHARED_RUNTIME_DOCUMENTS,
        ...(winapp ? WINDOWS_WINAPP_DOCUMENTS : []),
      ]),
      requiredReleaseFiles: Object.freeze([
        ...WINDOWS_RELEASE_FILES,
        ...(!nativeJobObjectHelper ? ["equinox-local-windows-job-object.ps1"] : []),
      ]),
      nativeShellFiles: WINDOWS_SHELL_FILES,
      nativeAppKind: "windows-shell",
    });
  }
  throw new Error(`Managed Equinox Local release runtime is not implemented for ${target}.`);
}
