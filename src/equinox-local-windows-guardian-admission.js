import fs from "node:fs/promises";
import path from "node:path";

import { assertWindowsNativeMessagingHostOwnership, windowsNativeMessagingLauncherPath } from "./equinox-browser-windows-native-messaging.js";
import { createEquinoxLocalMainUpdateTransactionEngine } from "./equinox-local-main-update-transaction.js";
import { readEquinoxLocalMainNativePointer } from "./equinox-local-main-native-state.js";
import { readEquinoxLocalMainSourcePointer } from "./equinox-local-main-source-pointer.js";
import { readManagedCurrentRelease } from "./equinox-local-update-activation.js";
import { equinoxLocalToolchainContract } from "./equinox-local-toolchain-contract.js";
import { assertWindowsStableShellOwnedByRelease } from "./equinox-local-windows-stable-shell.js";

const SHA = /^[a-f0-9]{40}$/u;
const TARGETS = new Set(["win32-x64", "win32-arm64"]);
const ALLOWED_ORPHAN_NAME = /^main-[a-f0-9]{32}\.windows-worker\.json$/u;

function absoluteNormal(value, name) {
  if (typeof value !== "string" || !path.win32.isAbsolute(value) || path.win32.normalize(value) !== value ||
      /[\r\n\0]/u.test(value) || value.includes("..\\")) {
    throw new Error(`Windows guardian ${name} must be an absolute normalized path.`);
  }
  return value;
}
function same(left, right) {
  return typeof left === "string" && typeof right === "string" &&
    path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase();
}

// This is a read-only admission boundary for a future independent, product-owned
// Windows launcher. It does not auto-replay failed swaps, execute an arbitrary
// path, create a new server, or migrate old Start Menu / Installed Apps records.
export async function inspectEquinoxLocalWindowsGuardianAdmission({
  installation,
  localAppData = process.env.LOCALAPPDATA,
  fsImpl = fs,
  engineFactory = createEquinoxLocalMainUpdateTransactionEngine,
  readPointer = readEquinoxLocalMainSourcePointer,
  readNativePointer = readEquinoxLocalMainNativePointer,
  readCurrentRelease = readManagedCurrentRelease,
  verifyShell = assertWindowsStableShellOwnedByRelease,
  verifyNativeHost = assertWindowsNativeMessagingHostOwnership,
  windowsLauncherPath = windowsNativeMessagingLauncherPath,
} = {}) {
  if (!installation || installation.platform !== "win32" || installation.kind !== "managed-source" ||
      installation.managed !== true || installation.selfUpdateSupported !== true ||
      !TARGETS.has(installation.target) || !SHA.test(installation.sourceSha ?? "")) {
    throw new Error("Windows guardian requires an owned, supported managed-source installation.");
  }
  const ownedLocal = absoluteNormal(localAppData, "user LOCALAPPDATA");
  const installRoot = absoluteNormal(installation.installRoot, "installed root");
  const programRoot = absoluteNormal(installation.programRoot, "program root");
  const sourceRoot = absoluteNormal(installation.sourceRoot, "source root");
  const transactionRoot = absoluteNormal(installation.mainTransactionRoot, "transaction root");
  const manifestRoot = absoluteNormal(installation.nativeMessagingManifestRoot, "Native Messaging root");
  const gitPath = absoluteNormal(installation.gitPath, "product Git executable");
  const releaseDir = absoluteNormal(installation.releaseDir, "Stable release");
  const expectedTransaction = path.win32.join(installRoot, "state", "main-update");
  const expectedGit = equinoxLocalToolchainContract({ runtimeRoot: path.win32.join(installRoot, "runtime"), target: installation.target }).gitPath;
  const expectedCurrentPointer = path.win32.join(installRoot, "current-version.json");
  const expectedProgram = path.win32.join(path.win32.dirname(installRoot), "Programs", "Equinox Local");
  const expectedSource = path.win32.join(expectedTransaction, "sources", installation.sourceSha);
  const expectedManifest = path.win32.join(installRoot, "browser", "native-messaging");
  const expectedStableRelease = path.win32.join(installRoot, "releases", path.win32.basename(releaseDir));
  // A source-only Main update advances its checkout SHA while the last
  // authenticated native snapshot legitimately remains at an older SHA.
  // Validate the immutable native slot independently of the source pointer;
  // the exact selected current-native pointer must still own this path.
  const nativeSlotSha = path.win32.basename(path.win32.dirname(releaseDir));
  const expectedMainRelease = path.win32.join(transactionRoot, "native-store", installation.target,
    nativeSlotSha, "release");
  const validStablePath = same(releaseDir, expectedStableRelease) &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(path.win32.basename(releaseDir));
  const validMainPath = SHA.test(nativeSlotSha) && same(releaseDir, expectedMainRelease);
  if (!same(installRoot, path.win32.join(ownedLocal, "Equinox Local")) ||
      !same(gitPath, expectedGit) ||
      !same(transactionRoot, expectedTransaction) || !same(programRoot, expectedProgram) ||
      !same(sourceRoot, expectedSource) || !same(manifestRoot, expectedManifest) ||
      (!validStablePath && !validMainPath) || !same(installation.currentPointer, expectedCurrentPointer)) {
    throw new Error("Windows guardian refuses a foreign installed source, Stable release, WPF or Native Messaging path.");
  }
  const engine = engineFactory({ sourceRoot, transactionRoot, gitPath });
  const active = await engine.readActive();
  if (active) {
    // Even a terminal receipt must be archived/released by the exact owning
    // transaction engine first. Never guess that an interrupted swap finished.
    return Object.freeze({ state: "blocked", reason: "owned-transaction-requires-reconciliation", transactionId: active.transactionId });
  }
  const handoffDir = path.win32.join(transactionRoot, "handoff");
  try {
    const entries = await fsImpl.readdir(handoffDir, { withFileTypes: true });
    if (entries.some((entry) => ALLOWED_ORPHAN_NAME.test(entry.name))) {
      return Object.freeze({ state: "blocked", reason: "orphaned-detached-worker-ownership" });
    }
    // Other files may exist here (logs, previous launchd plists); an unknown
    // Windows worker-like record is never an empty/healthy ownership proof.
    if (entries.some((entry) => /\.windows-worker\.json$/iu.test(entry.name))) {
      throw new Error("Windows guardian found an unrecognized detached worker ownership filename.");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const pointer = await readPointer(path.win32.join(transactionRoot, "current-source.conf"), { gitPath });
  if (!same(pointer.sourceRoot, sourceRoot) || pointer.sha !== installation.sourceSha) {
    throw new Error("Windows guardian source pointer does not match the owned active Main checkout.");
  }
  let nativePointer;
  try {
    nativePointer = await readNativePointer(path.win32.join(transactionRoot, "current-native.json"), { transactionRoot });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (!nativePointer) {
    if (!validStablePath) throw new Error("Windows guardian cannot fall back from a missing Main native pointer to a native-store path.");
    const current = await readCurrentRelease(installation);
    if (!same(current?.releaseDir, releaseDir)) {
      throw new Error("Windows guardian Stable baseline changed during admission.");
    }
  } else if (!validMainPath || !same(nativePointer.releaseDir, releaseDir)) {
    throw new Error("Windows guardian selected Main native-store identity differs from the current process runtime.");
  }
  if (nativePointer && (nativePointer.sourceSha !== nativeSlotSha || nativePointer.target !== installation.target ||
      typeof nativePointer.runtimeContractSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(nativePointer.runtimeContractSha256))) {
    throw new Error("Windows guardian native snapshot identity differs from the selected immutable native slot.");
  }
  if (nativePointer && !same(nativePointer.releaseDir,
      path.win32.join(transactionRoot, "native-store", installation.target, nativePointer.sourceSha, "release"))) {
    throw new Error("Windows guardian Main native release is outside its exact immutable source slot.");
  }
  const effectiveRelease = nativePointer?.releaseDir ?? releaseDir;
  if (typeof effectiveRelease !== "string" || !path.win32.isAbsolute(effectiveRelease)) {
    throw new Error("Windows guardian native release is unavailable or untrusted.");
  }
  const shell = await verifyShell({ releaseDir: effectiveRelease, programRoot });
  const expectedShell = path.win32.join(programRoot, "EquinoxLocal.exe");
  if (shell?.owned !== true || !same(shell.shellExecutable, expectedShell)) {
    throw new Error("Windows guardian native WPF shell ownership is unverified.");
  }
  const expectedLauncher = windowsLauncherPath(effectiveRelease);
  const host = await verifyNativeHost({ manifestRoot, acceptedLauncherPaths: [expectedLauncher] });
  if (!same(host?.launcherPath, expectedLauncher)) {
    throw new Error("Windows guardian Native Messaging registration is foreign or unverified.");
  }
  // A future fixed native launcher may use only this verified *fixed* WPF
  // entrypoint. Never return an unchecked program name or caller path.
  return Object.freeze({
    state: "admitted",
    sourceSha: pointer.sha,
    target: installation.target,
    native: nativePointer ? "main" : "stable",
    shellExecutable: expectedShell,
    releaseDir: effectiveRelease,
  });
}
