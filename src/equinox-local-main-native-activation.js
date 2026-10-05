import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  assertWindowsNativeMessagingHostOwnership,
  registerWindowsNativeMessagingHost,
  windowsNativeMessagingLauncherPath,
} from "./equinox-browser-windows-native-messaging.js";
import { resolveEquinoxLocalInstallation } from "./equinox-local-installation.js";
import {
  promoteEquinoxLocalMainNativeCandidate,
  readEquinoxLocalMainNativePointer,
  writeEquinoxLocalMainNativePointer,
} from "./equinox-local-main-native-state.js";
import {
  inspectEquinoxLocalNativeAppHostSnapshot,
  restoreEquinoxLocalNativeAppHostSnapshot,
  snapshotEquinoxLocalNativeAppHost,
  synchronizeEquinoxLocalAppHostForRelease,
} from "./equinox-local-native-app-host.js";
import { writeEquinoxLocalMainNativeRecoveryDescriptor } from "./equinox-local-main-native-recovery.js";
import {
  inspectWindowsStableShellRollbackSnapshot,
  replaceWindowsStableShellForRelease,
  restoreWindowsStableShellRollbackSnapshot,
  snapshotWindowsStableShellForRollback,
} from "./equinox-local-windows-stable-shell.js";

const execFile = promisify(execFileCallback);

function requireAbsolute(value, label, pathApi = path) {
  if (typeof value !== "string" || !pathApi.isAbsolute(value)) throw new Error(`${label} must be absolute.`);
  return pathApi.resolve(value);
}

async function readPreviousPointer(pointerPath, options, readPointerImpl) {
  try {
    return await readPointerImpl(pointerPath, options);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function prepareEquinoxLocalMainNativeLifecycle({
  transition,
  candidate,
  transactionRoot,
  transactionId,
  installation = resolveEquinoxLocalInstallation(),
  fsImpl = fs,
  execFileImpl = execFile,
  env = process.env,
  promoteCandidateImpl = promoteEquinoxLocalMainNativeCandidate,
  readPointerImpl = readEquinoxLocalMainNativePointer,
  writePointerImpl = writeEquinoxLocalMainNativePointer,
  snapshotDarwinImpl = snapshotEquinoxLocalNativeAppHost,
  inspectDarwinSnapshotImpl = inspectEquinoxLocalNativeAppHostSnapshot,
  activateDarwinImpl = synchronizeEquinoxLocalAppHostForRelease,
  restoreDarwinImpl = restoreEquinoxLocalNativeAppHostSnapshot,
  snapshotWindowsImpl = snapshotWindowsStableShellForRollback,
  inspectWindowsSnapshotImpl = inspectWindowsStableShellRollbackSnapshot,
  activateWindowsImpl = replaceWindowsStableShellForRelease,
  restoreWindowsImpl = restoreWindowsStableShellRollbackSnapshot,
  assertWindowsNativeHostImpl = assertWindowsNativeMessagingHostOwnership,
  registerWindowsNativeHostImpl = registerWindowsNativeMessagingHost,
  windowsLauncherPathImpl = windowsNativeMessagingLauncherPath,
  writeRecoveryDescriptorImpl = writeEquinoxLocalMainNativeRecoveryDescriptor,
} = {}) {
  if (transition?.mode !== "artifact_required") throw new Error("Main native lifecycle requires an artifact-required transition.");
  if (!candidate || candidate.sourceSha !== transition.targetSha || candidate.target !== transition.target || candidate.runtimeContractSha256 !== transition.targetRuntimeContractSha256) {
    throw new Error("Main native lifecycle candidate identity does not match the exact transition.");
  }
  if (!installation?.managed || !installation?.selfUpdateSupported || installation.target !== transition.target) {
    throw new Error("Main native lifecycle requires the matching managed Equinox Local installation.");
  }
  const root = requireAbsolute(transactionRoot, "Main native transaction root");
  const stored = await promoteCandidateImpl({ candidate, transactionRoot: root, transactionId, fsImpl });
  if (stored.sourceSha !== transition.targetSha || stored.target !== transition.target || stored.runtimeContractSha256 !== transition.targetRuntimeContractSha256) {
    throw new Error("Main native durable payload identity drifted from the exact transition.");
  }

  const pointerPath = path.join(root, "current-native.json");
  const previousPointer = await readPreviousPointer(pointerPath, { transactionRoot: root, fsImpl }, readPointerImpl);
  if (previousPointer && (previousPointer.target !== transition.target || previousPointer.runtimeContractSha256 !== transition.currentRuntimeContractSha256)) {
    throw new Error("Installed Main native pointer does not match the current source runtime contract.");
  }
  const previousReleaseDir = previousPointer?.releaseDir ?? installation.releaseDir;
  if (typeof previousReleaseDir !== "string") throw new Error("Previous managed native release is unavailable.");

  const rollbackRoot = path.join(root, "staging", transactionId, "native-rollback");
  const pointerValue = Object.freeze({
    schemaVersion: 1,
    channel: "main",
    sourceSha: transition.targetSha,
    target: transition.target,
    runtimeContractSha256: transition.targetRuntimeContractSha256,
  });

  if (transition.target.startsWith("darwin-")) {
    const homeDir = requireAbsolute(installation.installRoot, "Managed installation root").replace(/\/Library\/Application Support\/Equinox Local$/u, "");
    if (!homeDir || path.join(homeDir, "Library", "Application Support", "Equinox Local") !== path.resolve(installation.installRoot)) {
      throw new Error("Managed macOS installation root cannot be mapped to the user home directory.");
    }
    const snapshotPath = path.join(rollbackRoot, "Equinox Local.app");
    try {
      await snapshotDarwinImpl({ homeDir, snapshotPath, fsImpl, execFileImpl });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      await inspectDarwinSnapshotImpl({ snapshotPath, fsImpl, execFileImpl });
    }
    await writeRecoveryDescriptorImpl({ transition, previousPointer, installation, transactionRoot: root, transactionId, fsImpl });
    return Object.freeze({
      target: transition.target,
      stored,
      previousPointer,
      rollbackPath: snapshotPath,
      activate: async () => activateDarwinImpl({ installation, releaseDir: stored.releaseDir, fsImpl, execFileImpl, requirePayloadIdentity: true }),
      rollback: async () => restoreDarwinImpl({ homeDir, snapshotPath, fsImpl, execFileImpl }),
      commit: async () => writePointerImpl(pointerPath, pointerValue, { transactionRoot: root, fsImpl }),
    });
  }

  if (!transition.target.startsWith("win32-")) throw new Error("Main native lifecycle target is unsupported.");
  const programRoot = requireAbsolute(installation.programRoot, "Managed Windows program root", path.win32);
  const manifestRoot = requireAbsolute(installation.nativeMessagingManifestRoot, "Managed Windows Native Messaging root", path.win32);
  const previousRelease = requireAbsolute(previousReleaseDir, "Previous Windows native release", path.win32);
  const targetRelease = requireAbsolute(stored.releaseDir, "Target Windows native release", path.win32);
  const snapshotReleaseDir = path.join(rollbackRoot, "release");
  try {
    await snapshotWindowsImpl({ programRoot, snapshotReleaseDir, fsImpl });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    await inspectWindowsSnapshotImpl({ snapshotReleaseDir, fsImpl });
  }
  const previousLauncher = windowsLauncherPathImpl(previousRelease);
  const targetLauncher = windowsLauncherPathImpl(targetRelease);
  await writeRecoveryDescriptorImpl({ transition, previousPointer, installation, transactionRoot: root, transactionId, fsImpl });
  return Object.freeze({
    target: transition.target,
    stored,
    previousPointer,
    rollbackPath: snapshotReleaseDir,
    activate: async () => {
      await assertWindowsNativeHostImpl({ manifestRoot, acceptedLauncherPaths: [targetLauncher, previousLauncher], execFileAsync: execFileImpl, fsImpl, env });
      const shell = await activateWindowsImpl({ releaseDir: targetRelease, previousReleaseDir: previousRelease, programRoot, fsImpl });
      await registerWindowsNativeHostImpl({ manifestRoot, launcherPath: targetLauncher, expectedPreviousLauncherPath: previousLauncher, execFileAsync: execFileImpl, fsImpl, env });
      return shell;
    },
    rollback: async () => {
      const shell = await restoreWindowsImpl({ snapshotReleaseDir, currentReleaseDir: targetRelease, programRoot, fsImpl });
      await registerWindowsNativeHostImpl({ manifestRoot, launcherPath: previousLauncher, expectedPreviousLauncherPath: targetLauncher, execFileAsync: execFileImpl, fsImpl, env });
      return shell;
    },
    commit: async () => writePointerImpl(pointerPath, pointerValue, { transactionRoot: root, fsImpl }),
  });
}
