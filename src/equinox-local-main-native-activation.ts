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
import { validateTrustedMainInstallPointer } from "./equinox-local-main-install-pointer.js";
import {
  promoteEquinoxLocalMainNativeCandidate,
  inspectEquinoxLocalMainNativeStoredRelease,
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
import { createSupervisorBoundWindowsNativeABLifecycle, requireWindowsNativeABSupervisor } from "./equinox-local-windows-native-ab-supervisor-bound.js";

type NativeFilesystem = typeof fs;
type NativeExec = typeof execFile;
type Installation = ReturnType<typeof resolveEquinoxLocalInstallation>;
type NativeTransition = {
  mode: string; target: string; currentSha: string; targetSha: string;
  currentRuntimeContractSha256: string; targetRuntimeContractSha256: string;
};
type NativeCandidate = {
  sourceSha: string; target: string; transactionId: string;
  runtimeContractSha256: string; artifactSha256: string;
  artifactBytes: number; payloadVersion: string; releaseDir: string;
};
type NativeStore = {
  sourceSha: string; target: string; runtimeContractSha256: string; releaseDir: string;
};
type SignedStoredCandidate = Readonly<{
  sourceSha:string;target:string;runtimeContractSha256:string;artifactSha256:string;
  artifactBytes:number;payloadVersion:string;
}>;
type NativePointer = Readonly<{
  sourceSha: string; target: string; runtimeContractSha256: string; releaseDir?: string;
}>;
type PromoteCandidate = (options: {
  candidate: NativeCandidate; transactionRoot: string; transactionId: string; fsImpl: NativeFilesystem;
}) => Promise<NativeStore>;
type ReadNativePointer = typeof readEquinoxLocalMainNativePointer;
type SnapshotDarwin = (options: {
  homeDir: string; snapshotPath: string; fsImpl: NativeFilesystem; execFileImpl: NativeExec;
}) => Promise<unknown>;
type RecoveryDescriptorWriter = typeof writeEquinoxLocalMainNativeRecoveryDescriptor;
type NativeActivationOptions = {
  transition?: NativeTransition; candidate?: NativeCandidate;
  storedCandidate?: SignedStoredCandidate; signedPointer?: unknown;
  transactionRoot?: string; transactionId?: string;
  installation?: Installation; fsImpl?: NativeFilesystem;
  execFileImpl?: NativeExec; env?: NodeJS.ProcessEnv; windowsAdmission?: unknown;
  createBoundWindowsABImpl?: (options: Record<string, unknown>) => unknown;
  promoteCandidateImpl?: PromoteCandidate;
  inspectStoredImpl?: typeof inspectEquinoxLocalMainNativeStoredRelease;
  verifySignedPointerImpl?: typeof validateTrustedMainInstallPointer;
  readPointerImpl?: ReadNativePointer;
  writePointerImpl?: typeof writeEquinoxLocalMainNativePointer;
  snapshotDarwinImpl?: SnapshotDarwin;
  inspectDarwinSnapshotImpl?: typeof inspectEquinoxLocalNativeAppHostSnapshot;
  activateDarwinImpl?: typeof synchronizeEquinoxLocalAppHostForRelease;
  restoreDarwinImpl?: typeof restoreEquinoxLocalNativeAppHostSnapshot;
  assertWindowsNativeHostImpl?: typeof assertWindowsNativeMessagingHostOwnership;
  registerWindowsNativeHostImpl?: typeof registerWindowsNativeMessagingHost;
  windowsLauncherPathImpl?: typeof windowsNativeMessagingLauncherPath;
  writeRecoveryDescriptorImpl?: RecoveryDescriptorWriter;
};
function hasErrorCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}

const execFile = promisify(execFileCallback);

function requireAbsolute(value: unknown, label: string, pathApi: typeof path = path): string {
  if (typeof value !== "string" || !pathApi.isAbsolute(value)) throw new Error(`${label} must be absolute.`);
  return pathApi.resolve(value);
}

async function readPreviousPointer(pointerPath: string, options: {transactionRoot: string; fsImpl: NativeFilesystem}, readPointerImpl: ReadNativePointer): Promise<NativePointer | null> {
  try {
    return await readPointerImpl(pointerPath, options);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  }
}

export async function prepareEquinoxLocalMainNativeLifecycle({
  transition,
  candidate,
  storedCandidate,
  signedPointer,
  transactionRoot,
  transactionId,
  installation = resolveEquinoxLocalInstallation(),
  fsImpl = fs,
  execFileImpl = execFile,
  env = process.env,
  windowsAdmission = null,
  createBoundWindowsABImpl = createSupervisorBoundWindowsNativeABLifecycle,
  promoteCandidateImpl = promoteEquinoxLocalMainNativeCandidate,
  inspectStoredImpl = inspectEquinoxLocalMainNativeStoredRelease,
  verifySignedPointerImpl = validateTrustedMainInstallPointer,
  readPointerImpl = readEquinoxLocalMainNativePointer,
  writePointerImpl = writeEquinoxLocalMainNativePointer,
  snapshotDarwinImpl = snapshotEquinoxLocalNativeAppHost,
  inspectDarwinSnapshotImpl = inspectEquinoxLocalNativeAppHostSnapshot,
  activateDarwinImpl = synchronizeEquinoxLocalAppHostForRelease,
  restoreDarwinImpl = restoreEquinoxLocalNativeAppHostSnapshot,
  assertWindowsNativeHostImpl = assertWindowsNativeMessagingHostOwnership,
  registerWindowsNativeHostImpl = registerWindowsNativeMessagingHost,
  windowsLauncherPathImpl = windowsNativeMessagingLauncherPath,
  writeRecoveryDescriptorImpl = writeEquinoxLocalMainNativeRecoveryDescriptor,
}: NativeActivationOptions = {}) {
  if (transition?.mode !== "artifact_required") throw new Error("Main native lifecycle requires an artifact-required transition.");
  if (Boolean(candidate) === Boolean(storedCandidate)) {
    throw new Error("Main native lifecycle requires exactly one transient or signed durable candidate.");
  }
  if (candidate && (candidate.sourceSha !== transition.targetSha || candidate.target !== transition.target ||
      candidate.runtimeContractSha256 !== transition.targetRuntimeContractSha256)) {
    throw new Error("Main native lifecycle candidate identity does not match the exact transition.");
  }
  if (storedCandidate) {
    // The independent external installer previously admitted this inactive
    // immutable release. Reauthenticate the ORIGINAL production-root selector
    // before touching any running WPF/app, pointer or rollback snapshot.
    const signed = verifySignedPointerImpl(signedPointer, {expectedSourceSha:transition.targetSha});
    const selected = signed.targets.find(entry=>entry.target===transition.target);
    if (!selected || storedCandidate.sourceSha !== signed.sourceSha ||
        storedCandidate.target !== transition.target ||
        storedCandidate.runtimeContractSha256 !== selected.runtimeContractSha256 ||
        storedCandidate.runtimeContractSha256 !== transition.targetRuntimeContractSha256 ||
        storedCandidate.artifactSha256 !== selected.artifact.sha256 ||
        storedCandidate.artifactBytes !== selected.artifact.bytes ||
        storedCandidate.payloadVersion !== signed.version) {
      throw new Error("Signed Main stored native candidate differs from exact production selector.");
    }
  }
  if (!installation?.managed || !installation?.selfUpdateSupported || installation.target !== transition.target) {
    throw new Error("Main native lifecycle requires the matching managed Equinox Local installation.");
  }
  // A native-impact Windows detached worker always has a journal admission.
  // Refuse absence of a separate OS supervisor before promoting even the
  // inactive payload; never fall back to the legacy ephemeral A backup.
  const id = transactionId!;
  if (transition.target.startsWith("win32-")) {
    // A verified detached Node worker is not an independent native WPF owner.
    // Refuse legacy A/B promotion BEFORE writing any inactive release content.
    requireWindowsNativeABSupervisor({ windowsAdmission, transition, transactionId: id });
  }
  const root = requireAbsolute(transactionRoot, "Main native transaction root");
  const durable = storedCandidate
    ? await inspectStoredImpl({transactionRoot:root,sourceSha:storedCandidate.sourceSha,
      target:storedCandidate.target,
      expectedRuntimeContractSha256:storedCandidate.runtimeContractSha256,fsImpl})
    : null;
  if (storedCandidate && durable && (
      durable.manifest.artifactSha256 !== storedCandidate.artifactSha256 ||
      durable.manifest.artifactBytes !== storedCandidate.artifactBytes ||
      durable.payloadVersion !== storedCandidate.payloadVersion)) {
    throw new Error("Signed Main durable native manifest does not match authenticated archive/version.");
  }
  const stored = durable ?? await promoteCandidateImpl({ candidate: candidate!, transactionRoot: root, transactionId: id, fsImpl });
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

  const rollbackRoot = path.join(root, "staging", id, "native-rollback");
  const pointerValue = Object.freeze({
    schemaVersion: 1,
    channel: "main",
    sourceSha: transition.targetSha,
    target: transition.target,
    runtimeContractSha256: transition.targetRuntimeContractSha256,
  });

  if (transition.target.startsWith("darwin-")) {
    const homeDir = requireAbsolute(installation.installRoot, "Managed installation root").replace(/\/Library\/Application Support\/Equinox Local$/u, "");
    if (!homeDir || path.join(homeDir, "Library", "Application Support", "Equinox Local") !== path.resolve(requireAbsolute(installation.installRoot, "Managed installation root"))) {
      throw new Error("Managed macOS installation root cannot be mapped to the user home directory.");
    }
    const snapshotPath = path.join(rollbackRoot, "Equinox Local.app");
    try {
      await snapshotDarwinImpl({ homeDir, snapshotPath, fsImpl, execFileImpl });
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
      await inspectDarwinSnapshotImpl({ snapshotPath, fsImpl, execFileImpl });
    }
    await writeRecoveryDescriptorImpl({ transition, previousPointer, installation, transactionRoot: root, transactionId: id, fsImpl });
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
  // The independent native supervisor owns exactly one A/B rollback slot.
  // Preserve the source receipt's recovery identity, but do not snapshot the
  // old WPF tree or create a second legacy pointer-transition state machine.
  await writeRecoveryDescriptorImpl({ transition, previousPointer, installation, transactionRoot: root, transactionId: id, fsImpl });
  return createBoundWindowsABImpl({ windowsAdmission, transition, transactionId: id, stored, previousPointer,
    previousReleaseDir: previousRelease, programRoot, manifestRoot, transactionRoot: root, pointerPath,
    fsImpl, execFileImpl, env, writePointerImpl, assertNativeHostImpl: assertWindowsNativeHostImpl,
    registerNativeHostImpl: registerWindowsNativeHostImpl, launcherPathImpl: windowsLauncherPathImpl });
}
