import fs from "node:fs/promises";
import path from "node:path";

import { validateManagedSourceInstallStamp } from "./equinox-local-main-update.js";
import { readEquinoxLocalMainSourcePointer } from "./equinox-local-main-source-pointer.js";
import { equinoxLocalPlatformPaths } from "./equinox-local-platform.js";
import { equinoxLocalToolchainContract } from "./equinox-local-toolchain-contract.js";
import { inspectPrivateStatePath, verifyWindowsPrivateStateAcl } from "./equinox-local-private-state.js";
import { readBoundedNormalFile } from "./equinox-local-safe-file.js";

const MAX_STAMP_BYTES = 8 * 1024;

export function equinoxLocalManagedSourcePaths({
  platform = process.platform,
  arch = process.arch,
  homeDir,
  env = process.env,
} = {}) {
  const layout = equinoxLocalPlatformPaths({ platform, arch, homeDir, env });
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const mainTransactionRoot = pathApi.join(layout.stateRoot, "main-update");
  return Object.freeze({
    mainTransactionRoot,
    installStampPath: pathApi.join(mainTransactionRoot, "install.json"),
    sourcePointerPath: pathApi.join(mainTransactionRoot, "current-source.conf"),
  });
}

export async function resolveEquinoxLocalManagedSourceInstallation({
  baseInstallation,
  platform = baseInstallation?.platform ?? process.platform,
  arch = baseInstallation?.arch ?? process.arch,
  homeDir,
  env = process.env,
  fsImpl = fs,
  verifyWindowsAcl = verifyWindowsPrivateStateAcl,
  readPointerImpl = readEquinoxLocalMainSourcePointer,
} = {}) {
  if (!baseInstallation || baseInstallation.kind !== "managed" || baseInstallation.managed !== true || baseInstallation.selfUpdateSupported !== true) {
    return baseInstallation;
  }

  const paths = equinoxLocalManagedSourcePaths({ platform, arch, homeDir, env });
  const layout = equinoxLocalPlatformPaths({ platform, arch, homeDir, env });
  const toolchain = equinoxLocalToolchainContract({ runtimeRoot: layout.runtimeRoot, target: `${platform}-${arch}` });
  let managedGitPath = null;
  try {
    const gitStat = await fsImpl.lstat(toolchain.gitPath);
    if (!gitStat.isFile() || gitStat.isSymbolicLink()) throw new Error("Managed Git executable is unsafe.");
    if (platform !== "win32" && (gitStat.mode & 0o111) === 0) throw new Error("Managed Git executable is not executable.");
    managedGitPath = toolchain.gitPath;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const directorySecurity = await inspectPrivateStatePath(paths.mainTransactionRoot, {
    platform, type: "directory", mode: "700", fsImpl, verifyWindowsAcl,
  });
  if (!directorySecurity.exists) return baseInstallation;
  if (!directorySecurity.safe) throw new Error("Managed-source state directory is not private.");

  const stampSecurity = await inspectPrivateStatePath(paths.installStampPath, {
    platform, type: "file", mode: "600", fsImpl, verifyWindowsAcl,
  });
  if (!stampSecurity.exists) return baseInstallation;
  if (!stampSecurity.safe) throw new Error("Managed-source install stamp is not private.");

  const { data } = await readBoundedNormalFile(paths.installStampPath, {
    platform,
    fsImpl,
    minBytes: 2,
    maxBytes: MAX_STAMP_BYTES,
    encoding: "utf8",
    label: "Managed-source install stamp",
  });
  let parsed;
  try { parsed = JSON.parse(data); }
  catch { throw new Error("Managed-source install stamp is not valid JSON."); }
  const stamp = validateManagedSourceInstallStamp(parsed);

  const pointer = await readPointerImpl(paths.sourcePointerPath, {
    fsImpl,
    ...(managedGitPath ? { gitPath: managedGitPath } : {}),
  });
  return Object.freeze({
    ...baseInstallation,
    kind: "managed-source",
    channel: "main",
    mainUpdateSupported: true,
    mainUpdateReason: null,
    sourceRoot: pointer.sourceRoot,
    sourceSha: pointer.sha,
    mainTransactionRoot: paths.mainTransactionRoot,
    mainInstallStamp: stamp,
    gitPath: managedGitPath,
    nodePath: managedGitPath ? toolchain.nodePath : null,
    npmPath: managedGitPath ? toolchain.npmPath : null,
    toolchainRoot: managedGitPath ? toolchain.toolchainRoot : null,
  });
}
