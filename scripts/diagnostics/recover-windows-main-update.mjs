#!/usr/bin/env node
// Offline operator tool: dry run by default; never invoked by normal updates.
import os from "node:os";

import { equinoxLocalPlatformPaths } from "../../src/equinox-local-platform.js";
import { readManagedCurrentRelease } from "../../src/equinox-local-update-activation.js";
import { resolveEquinoxLocalManagedSourceInstallation } from "../../src/equinox-local-managed-source-installation.js";
import { recoverVerifiedWindowsMainFailedRollback } from "../../src/equinox-local-main-failed-rollback-recovery.js";

async function main(args = process.argv.slice(2)) {
  if (process.platform !== "win32") throw new Error("This recovery tool supports Windows only.");
  if (args.length > 1 || args.some((arg) => arg !== "--apply")) {
    throw new Error("Only the optional --apply argument is accepted.");
  }
  const layout = equinoxLocalPlatformPaths({ platform: "win32", arch: process.arch, homeDir: os.homedir() });
  const base = {
    kind: "managed", managed: true, selfUpdateSupported: true,
    platform: "win32", arch: process.arch, target: layout.host.target,
    installRoot: layout.appDataRoot, releasesRoot: layout.releasesRoot,
    currentPointer: layout.currentPointer, programRoot: layout.programRoot,
    nativeMessagingManifestRoot: layout.nativeMessagingManifestRoot,
  };
  const current = await readManagedCurrentRelease(base);
  const installation = await resolveEquinoxLocalManagedSourceInstallation({
    baseInstallation: { ...base, releaseDir: current.releaseDir },
    platform: "win32", arch: process.arch, homeDir: os.homedir(),
  });
  const result = await recoverVerifiedWindowsMainFailedRollback({
    installation, apply: args[0] === "--apply",
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  process.stderr.write(`Recovery refused: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
