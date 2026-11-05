import fs from "node:fs/promises";
import path from "node:path";

import {
  EQUINOX_LOCAL_BUNDLED_PEEKABOO_SINCE_VERSION,
  EQUINOX_LOCAL_BUNDLED_WINAPP_SINCE_VERSION,
  EQUINOX_LOCAL_NATIVE_JOB_OBJECT_HELPER_SINCE_VERSION,
  EQUINOX_LOCAL_NODE_RUNTIME_GATE_SINCE_VERSION,
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
// Read-only compatibility for retained signed WPF archives; publishers use Electron.
const LEGACY_WINDOWS_SHELL_FILES = Object.freeze([
  path.join("runtime", "shell", "EquinoxLocal.exe"),
  path.join("runtime", "shell", "coreclr.dll"),
  path.join("runtime", "shell", "hostfxr.dll"),
  path.join("runtime", "shell", "Microsoft.Web.WebView2.Core.dll"),
]);
const WINDOWS_SHELL_FILES = Object.freeze([
  path.join("runtime", "shell", "EquinoxLocal.exe"),
  path.join("runtime", "shell", "chrome_100_percent.pak"),
  path.join("runtime", "shell", "chrome_200_percent.pak"),
  path.join("runtime", "shell", "d3dcompiler_47.dll"),
  path.join("runtime", "shell", "dxcompiler.dll"),
  path.join("runtime", "shell", "electron_wer.dll"),
  path.join("runtime", "shell", "ffmpeg.dll"),
  path.join("runtime", "shell", "icudtl.dat"),
  path.join("runtime", "shell", "resources.pak"),
  path.join("runtime", "shell", "snapshot_blob.bin"),
  path.join("runtime", "shell", "v8_context_snapshot.bin"),
  path.join("runtime", "shell", "version"),
  path.join("runtime", "shell", "vk_swiftshader.dll"),
  path.join("runtime", "shell", "vk_swiftshader_icd.json"),
  path.join("runtime", "shell", "vulkan-1.dll"),
  path.join("runtime", "shell", "locales", "en-US.pak"),
  path.join("runtime", "shell", "resources", "app.asar"),
  path.join("runtime", "shell", "LICENSE"),
  path.join("runtime", "shell", "LICENSES.chromium.html"),
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

type ReleaseContractOptions = { target?: string; version?: unknown };
export type ReleaseRuntimeContract = Readonly<{
  target: string;
  version: string;
  platform: "darwin" | "win32";
  executableModeRequired: boolean;
  bundledPeekaboo: boolean;
  bundledWinapp?: boolean;
  nativeJobObjectHelper?: boolean;
  nodeRuntimeGate?: boolean;
  runtimeExecutables: readonly string[];
  runtimeDocuments: readonly string[];
  requiredReleaseFiles: readonly string[];
  nativeShellFiles: readonly string[];
  nativeAppKind: "macos-app" | "windows-shell";
}>;

// Select shape only: callers must retain their normal-tree and signed-byte audits.
// Version cannot discriminate the migration: both formats can share a product version.
export async function readEquinoxLocalReleaseRuntimeContract(
  releaseDir: string,
  options: ReleaseContractOptions & { fsImpl?: typeof fs } = {},
): Promise<ReleaseRuntimeContract> {
  const { fsImpl = fs } = options;
  const contract = equinoxLocalReleaseRuntimeContract(options);
  if (contract.platform !== "win32") return contract;
  if (!path.isAbsolute(releaseDir)) throw new Error("Release shell root must be absolute.");
  const components = [releaseDir, "runtime", "shell", "resources", "app.asar"];
  let current = releaseDir;
  for (let index = 0; index < components.length; index += 1) {
    if (index > 0) current = path.join(current, components[index]!);
    let stat;
    try {
      stat = await fsImpl.lstat(current);
    } catch (error) {
      // Only absent resources/app.asar (or its optional resources directory)
      // selects legacy. Permission, traversal and other failures are fatal.
      if (index >= 3 && (error as NodeJS.ErrnoException).code === "ENOENT") {
        return Object.freeze({ ...contract, nativeShellFiles: LEGACY_WINDOWS_SHELL_FILES });
      }
      throw error;
    }
    if (stat.isSymbolicLink() || (index === 4 ? !stat.isFile() : !stat.isDirectory())) {
      throw new Error("Release shell sentinel and its parents must be normal files/directories.");
    }
  }
  return contract;
}

export function equinoxLocalReleaseRuntimeContract({ target, version }: ReleaseContractOptions = {}): ReleaseRuntimeContract {
  const normalizedVersion = parseEquinoxVersion(version).text;
  if (target !== undefined && DARWIN_TARGET_PATTERN.test(target)) {
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
  if (target !== undefined && WINDOWS_TARGET_PATTERN.test(target)) {
    const winapp = compareEquinoxVersions(normalizedVersion, EQUINOX_LOCAL_BUNDLED_WINAPP_SINCE_VERSION) >= 0;
    const nativeJobObjectHelper = compareEquinoxVersions(normalizedVersion, EQUINOX_LOCAL_NATIVE_JOB_OBJECT_HELPER_SINCE_VERSION) >= 0;
    const nodeRuntimeGate = compareEquinoxVersions(normalizedVersion, EQUINOX_LOCAL_NODE_RUNTIME_GATE_SINCE_VERSION) >= 0;
    return Object.freeze({
      target,
      version: normalizedVersion,
      platform: "win32",
      executableModeRequired: false,
      bundledPeekaboo: false,
      bundledWinapp: winapp,
      nativeJobObjectHelper,
      nodeRuntimeGate,
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
        ...(nodeRuntimeGate ? ["equinox-local-windows-runtime-gate.mjs"] : []),
        ...(!nativeJobObjectHelper ? ["equinox-local-windows-job-object.ps1"] : []),
      ]),
      nativeShellFiles: WINDOWS_SHELL_FILES,
      nativeAppKind: "windows-shell",
    });
  }
  throw new Error(`Managed Equinox Local release runtime is not implemented for ${target}.`);
}
