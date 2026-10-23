#!/usr/bin/env node
// Offline operator tool: dry run by default; never invoked by normal updates.
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { equinoxLocalPlatformPaths } from "../../src/equinox-local-platform.js";
import { readManagedCurrentRelease } from "../../src/equinox-local-update-activation.js";
import { resolveEquinoxLocalManagedSourceInstallation } from "../../src/equinox-local-managed-source-installation.js";
import { recoverVerifiedWindowsMainFailedRollback } from "../../src/equinox-local-main-failed-rollback-recovery.js";

type VerifiedRecoveryInstallation = NonNullable<NonNullable<Parameters<typeof recoverVerifiedWindowsMainFailedRollback>[0]>["installation"]>;

// The public CLI must not guess installed host paths, look for an ambient Git
// installation, or convert a diagnostic into a mutation without --apply.
// Keep entrypoint and resolver separately testable on non-Windows CI hosts.
export async function runWindowsMainFailedRollbackRecovery({
  args = process.argv.slice(2),
  platform = process.platform,
  arch = process.arch,
  homeDir = os.homedir(),
  env = process.env,
  readRelease = readManagedCurrentRelease,
  resolveInstallation = resolveEquinoxLocalManagedSourceInstallation,
  recover = recoverVerifiedWindowsMainFailedRollback,
} = {}) {
  if (platform !== "win32") throw new Error("This recovery tool supports Windows only.");
  if (!Array.isArray(args) || args.length > 1 || args.some((arg) => arg !== "--apply")) {
    throw new Error("Only the optional --apply argument is accepted.");
  }
  if (typeof homeDir !== "string" || !path.win32.isAbsolute(homeDir) ||
      path.win32.normalize(homeDir) !== homeDir || /[\r\n\0]/u.test(homeDir)) {
    throw new Error("Windows recovery home directory must be a canonical absolute path.");
  }
  if (!["x64", "arm64"].includes(arch)) throw new Error("Unsupported Windows recovery architecture.");
  const layout = equinoxLocalPlatformPaths({ platform, arch, homeDir, env });
  const base = Object.freeze({
    kind: "managed", managed: true, selfUpdateSupported: true,
    platform: "win32", arch, target: layout.host.target,
    installRoot: layout.appDataRoot, releasesRoot: layout.releasesRoot,
    currentPointer: layout.currentPointer, programRoot: layout.programRoot,
    nativeMessagingManifestRoot: layout.nativeMessagingManifestRoot,
  });
  const current = await readRelease(base);
  if (typeof current?.releaseDir !== "string" ||
      !path.win32.isAbsolute(current.releaseDir) ||
      path.win32.dirname(current.releaseDir).toLowerCase() !== layout.releasesRoot.toLowerCase()) {
    throw new Error("Windows recovery active managed release is outside the owned releases directory.");
  }
  const installation = await resolveInstallation({
    baseInstallation: { ...base, releaseDir: current.releaseDir },
    platform, arch, homeDir, env,
  });
  const expectedStateRoot = path.win32.join(layout.stateRoot, "main-update");
  const expectedSourceStore = path.win32.join(expectedStateRoot, "sources");
  const sourceSha = typeof installation?.sourceRoot === "string" ? path.win32.basename(installation.sourceRoot) : "";
  if (!installation || installation.kind !== "managed-source" || installation.managed !== true ||
      installation.selfUpdateSupported !== true || installation.releaseDir !== current.releaseDir ||
      typeof installation.sourceRoot !== "string" || !/^[a-f0-9]{40}$/u.test(sourceSha) ||
      path.win32.dirname(installation.sourceRoot).toLowerCase() !== expectedSourceStore.toLowerCase() ||
      installation.sourceSha !== sourceSha ||
      (typeof installation.mainTransactionRoot !== "string" || installation.mainTransactionRoot.toLowerCase() !== expectedStateRoot.toLowerCase()) ||
      typeof installation.gitPath !== "string" || !path.win32.isAbsolute(installation.gitPath) ||
      !("programRoot" in installation) || typeof installation.programRoot !== "string" || installation.programRoot !== base.programRoot ||
      !("nativeMessagingManifestRoot" in installation) || typeof installation.nativeMessagingManifestRoot !== "string" ||
      installation.nativeMessagingManifestRoot !== base.nativeMessagingManifestRoot) {
    throw new Error("Windows recovery refuses non-managed-source, incomplete, or changed installed ownership.");
  }
  // The preceding ownership checks validate each required recovery field; the
  // managed-source resolver's public return type is intentionally broader.
  return recover({ installation: installation as VerifiedRecoveryInstallation, apply: args.includes("--apply") });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runWindowsMainFailedRollbackRecovery().then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => {
    process.stderr.write(`Recovery refused: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
