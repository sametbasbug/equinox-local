import fs from "node:fs/promises";
import path from "node:path";

import {
  assertWindowsNativeMessagingHostOwnership,
  registerWindowsNativeMessagingHost,
  windowsNativeMessagingLauncherPath,
} from "./equinox-browser-windows-native-messaging.js";
import { resolveEquinoxLocalInstallation } from "./equinox-local-installation.js";
import {
  inspectEquinoxLocalMainNativeStoredRelease,
  writeEquinoxLocalMainNativePointer,
} from "./equinox-local-main-native-state.js";
import {
  inspectEquinoxLocalNativeAppHostSnapshot,
  restoreEquinoxLocalNativeAppHostSnapshot,
  synchronizeEquinoxLocalAppHostForRelease,
} from "./equinox-local-native-app-host.js";
import { readBoundedNormalFile, writeBoundedUtf8File } from "./equinox-local-safe-file.js";
import { parseEquinoxVersion } from "./equinox-local-updater.js";
import {
  inspectWindowsStableShellRollbackSnapshot,
  replaceWindowsStableShellForRelease,
  restoreWindowsStableShellRollbackSnapshot,
} from "./equinox-local-windows-stable-shell.js";

const MAX_DESCRIPTOR_BYTES = 8 * 1024;
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const TX_PATTERN = /^main-[a-f0-9]{32}$/u;

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid.`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new Error(`${label} contains missing or unsupported fields.`);
}
function assertSha(value, label) {
  if (!SHA_PATTERN.test(value ?? "")) throw new Error(`${label} is invalid.`);
  return value;
}
function assertDigest(value, label) {
  if (!DIGEST_PATTERN.test(value ?? "")) throw new Error(`${label} is invalid.`);
  return value;
}
function assertTransactionId(value) {
  if (!TX_PATTERN.test(value ?? "")) throw new Error("Main native recovery transaction id is invalid.");
  return value;
}
function requireAbsolute(value, label, pathApi = path) {
  if (typeof value !== "string" || !pathApi.isAbsolute(value) || /[\r\n\0]/u.test(value)) throw new Error(`${label} must be absolute.`);
  return pathApi.resolve(value);
}
function recoveryPath(transactionRoot, transactionId) {
  const root = requireAbsolute(transactionRoot, "Main native recovery transaction root");
  return Object.freeze({
    root,
    rollbackRoot: path.join(root, "staging", assertTransactionId(transactionId), "native-rollback"),
    descriptorPath: path.join(root, "staging", transactionId, "native-rollback", "native-recovery.json"),
    pointerPath: path.join(root, "current-native.json"),
  });
}
function validatePrevious(value) {
  if (value?.kind === "main") {
    exactKeys(value, ["kind", "sourceSha", "target", "runtimeContractSha256"], "Main native previous identity");
    assertSha(value.sourceSha, "Main native previous source SHA");
    assertDigest(value.runtimeContractSha256, "Main native previous runtime contract");
    if (typeof value.target !== "string" || !value.target) throw new Error("Main native previous target is invalid.");
    return Object.freeze({ ...value });
  }
  if (value?.kind === "stable") {
    exactKeys(value, ["kind", "version"], "Main native previous stable identity");
    return Object.freeze({ kind: "stable", version: parseEquinoxVersion(value.version).text });
  }
  throw new Error("Main native previous identity is invalid.");
}
function validateDescriptor(value, expected = {}) {
  exactKeys(value, ["schemaVersion", "channel", "targetSha", "target", "targetRuntimeContractSha256", "previous"], "Main native recovery descriptor");
  if (value.schemaVersion !== 1 || value.channel !== "main") throw new Error("Main native recovery descriptor identity is invalid.");
  assertSha(value.targetSha, "Main native recovery target SHA");
  assertDigest(value.targetRuntimeContractSha256, "Main native recovery target runtime contract");
  if (typeof value.target !== "string" || !value.target) throw new Error("Main native recovery target is invalid.");
  const previous = validatePrevious(value.previous);
  if (expected.targetSha && value.targetSha !== expected.targetSha) throw new Error("Main native recovery target SHA mismatch.");
  if (expected.target && value.target !== expected.target) throw new Error("Main native recovery target mismatch.");
  if (expected.targetRuntimeContractSha256 && value.targetRuntimeContractSha256 !== expected.targetRuntimeContractSha256) throw new Error("Main native recovery runtime contract mismatch.");
  return Object.freeze({ ...value, previous });
}

export function equinoxLocalMainNativeRecoveryDescriptor({ transition, previousPointer, installation } = {}) {
  if (transition?.mode !== "artifact_required") throw new Error("Main native recovery descriptor requires an artifact transition.");
  const previous = previousPointer
    ? Object.freeze({ kind: "main", sourceSha: previousPointer.sourceSha, target: previousPointer.target, runtimeContractSha256: previousPointer.runtimeContractSha256 })
    : Object.freeze({ kind: "stable", version: parseEquinoxVersion(path.basename(installation?.releaseDir ?? "")).text });
  return validateDescriptor({
    schemaVersion: 1,
    channel: "main",
    targetSha: transition.targetSha,
    target: transition.target,
    targetRuntimeContractSha256: transition.targetRuntimeContractSha256,
    previous,
  });
}

export async function writeEquinoxLocalMainNativeRecoveryDescriptor({
  transition,
  previousPointer,
  installation,
  transactionRoot,
  transactionId,
  fsImpl = fs,
} = {}) {
  const paths = recoveryPath(transactionRoot, transactionId);
  const descriptor = equinoxLocalMainNativeRecoveryDescriptor({ transition, previousPointer, installation });
  await fsImpl.mkdir(paths.rollbackRoot, { recursive: true, mode: 0o700 });
  try {
    const existing = await readEquinoxLocalMainNativeRecoveryDescriptor({
      transactionRoot,
      transactionId,
      expected: { targetSha: descriptor.targetSha, target: descriptor.target, targetRuntimeContractSha256: descriptor.targetRuntimeContractSha256 },
      fsImpl,
    });
    if (JSON.stringify(existing) !== JSON.stringify(descriptor)) throw new Error("Main native recovery descriptor immutable identity mismatch.");
    return existing;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const content = `${JSON.stringify(descriptor, null, 2)}\n`;
  await writeBoundedUtf8File(paths.descriptorPath, { content, fsImpl, maxBytes: MAX_DESCRIPTOR_BYTES, label: "Main native recovery descriptor" });
  return await readEquinoxLocalMainNativeRecoveryDescriptor({
    transactionRoot,
    transactionId,
    expected: { targetSha: descriptor.targetSha, target: descriptor.target, targetRuntimeContractSha256: descriptor.targetRuntimeContractSha256 },
    fsImpl,
  });
}

export async function readEquinoxLocalMainNativeRecoveryDescriptor({ transactionRoot, transactionId, expected = {}, fsImpl = fs } = {}) {
  const paths = recoveryPath(transactionRoot, transactionId);
  const file = await readBoundedNormalFile(paths.descriptorPath, { fsImpl, minBytes: 1, maxBytes: MAX_DESCRIPTOR_BYTES, encoding: "utf8", label: "Main native recovery descriptor" });
  let raw;
  try { raw = JSON.parse(file.data); } catch { throw new Error("Main native recovery descriptor is not valid JSON."); }
  return validateDescriptor(raw, expected);
}

async function previousReleaseFromDescriptor({ descriptor, transactionRoot, installation, fsImpl, inspectStoredReleaseImpl }) {
  if (descriptor.previous.kind === "main") {
    if (descriptor.previous.target !== descriptor.target) throw new Error("Main native previous target does not match recovery target.");
    const stored = await inspectStoredReleaseImpl({
      transactionRoot,
      sourceSha: descriptor.previous.sourceSha,
      target: descriptor.previous.target,
      expectedRuntimeContractSha256: descriptor.previous.runtimeContractSha256,
      fsImpl,
    });
    return stored.releaseDir;
  }
  const releasesRoot = requireAbsolute(installation?.releasesRoot, "Managed stable releases root", installation?.platform === "win32" ? path.win32 : path);
  const pathApi = installation?.platform === "win32" ? path.win32 : path;
  const releaseDir = pathApi.join(releasesRoot, descriptor.previous.version);
  if (pathApi.dirname(releaseDir) !== releasesRoot) throw new Error("Stable native recovery release escaped the managed releases root.");
  return releaseDir;
}

export async function recoverEquinoxLocalMainNativeLifecycle({
  transition,
  transactionRoot,
  transactionId,
  installation = resolveEquinoxLocalInstallation(),
  fsImpl = fs,
  execFileImpl,
  env = process.env,
  readDescriptorImpl = readEquinoxLocalMainNativeRecoveryDescriptor,
  inspectStoredReleaseImpl = inspectEquinoxLocalMainNativeStoredRelease,
  writePointerImpl = writeEquinoxLocalMainNativePointer,
  inspectDarwinSnapshotImpl = inspectEquinoxLocalNativeAppHostSnapshot,
  activateDarwinImpl = synchronizeEquinoxLocalAppHostForRelease,
  restoreDarwinImpl = restoreEquinoxLocalNativeAppHostSnapshot,
  inspectWindowsSnapshotImpl = inspectWindowsStableShellRollbackSnapshot,
  activateWindowsImpl = replaceWindowsStableShellForRelease,
  restoreWindowsImpl = restoreWindowsStableShellRollbackSnapshot,
  assertWindowsNativeHostImpl = assertWindowsNativeMessagingHostOwnership,
  registerWindowsNativeHostImpl = registerWindowsNativeMessagingHost,
  windowsLauncherPathImpl = windowsNativeMessagingLauncherPath,
} = {}) {
  if (transition?.mode !== "artifact_required") throw new Error("Main native recovery requires an artifact transition.");
  if (!installation?.managed || !installation?.selfUpdateSupported || installation.target !== transition.target) throw new Error("Main native recovery requires the matching managed installation.");
  const paths = recoveryPath(transactionRoot, transactionId);
  const descriptor = await readDescriptorImpl({
    transactionRoot: paths.root,
    transactionId,
    expected: { targetSha: transition.targetSha, target: transition.target, targetRuntimeContractSha256: transition.targetRuntimeContractSha256 },
    fsImpl,
  });
  const stored = await inspectStoredReleaseImpl({ transactionRoot: paths.root, sourceSha: transition.targetSha, target: transition.target, expectedRuntimeContractSha256: transition.targetRuntimeContractSha256, fsImpl });
  const previousReleaseDir = await previousReleaseFromDescriptor({ descriptor, transactionRoot: paths.root, installation, fsImpl, inspectStoredReleaseImpl });
  const pointerValue = Object.freeze({ schemaVersion: 1, channel: "main", sourceSha: transition.targetSha, target: transition.target, runtimeContractSha256: transition.targetRuntimeContractSha256 });

  if (transition.target.startsWith("darwin-")) {
    const homeDir = requireAbsolute(installation.installRoot, "Managed installation root").replace(/\/Library\/Application Support\/Equinox Local$/u, "");
    if (!homeDir || path.join(homeDir, "Library", "Application Support", "Equinox Local") !== path.resolve(installation.installRoot)) throw new Error("Managed macOS installation root cannot be mapped to the user home directory.");
    const snapshotPath = path.join(paths.rollbackRoot, "Equinox Local.app");
    await inspectDarwinSnapshotImpl({ snapshotPath, fsImpl, execFileImpl });
    return Object.freeze({
      target: transition.target,
      stored,
      descriptor,
      rollbackPath: snapshotPath,
      activate: async () => activateDarwinImpl({ installation, releaseDir: stored.releaseDir, fsImpl, execFileImpl, requirePayloadIdentity: true }),
      rollback: async () => restoreDarwinImpl({ homeDir, snapshotPath, fsImpl, execFileImpl }),
      commit: async () => writePointerImpl(paths.pointerPath, pointerValue, { transactionRoot: paths.root, fsImpl }),
    });
  }

  if (!transition.target.startsWith("win32-")) throw new Error("Main native recovery target is unsupported.");
  const programRoot = requireAbsolute(installation.programRoot, "Managed Windows program root", path.win32);
  const manifestRoot = requireAbsolute(installation.nativeMessagingManifestRoot, "Managed Windows Native Messaging root", path.win32);
  const previousRelease = requireAbsolute(previousReleaseDir, "Previous Windows native release", path.win32);
  const targetRelease = requireAbsolute(stored.releaseDir, "Target Windows native release", path.win32);
  const snapshotReleaseDir = path.join(paths.rollbackRoot, "release");
  await inspectWindowsSnapshotImpl({ snapshotReleaseDir, fsImpl });
  const previousLauncher = windowsLauncherPathImpl(previousRelease);
  const targetLauncher = windowsLauncherPathImpl(targetRelease);
  return Object.freeze({
    target: transition.target,
    stored,
    descriptor,
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
    commit: async () => writePointerImpl(paths.pointerPath, pointerValue, { transactionRoot: paths.root, fsImpl }),
  });
}
