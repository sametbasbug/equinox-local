import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { validateTrustedMainInstallPointer } from "../../src/equinox-local-main-install-pointer.js";
import { inspectEquinoxLocalMainNativeStoredRelease } from "../../src/equinox-local-main-native-state.js";
import { equinoxLocalManagedSourcePaths } from "../../src/equinox-local-managed-source-installation.js";
import { verifyWindowsPrivateStateAcl, protectWindowsPrivateStatePath } from "../../src/equinox-local-private-state.js";
import { ELECTRON_DISTRIBUTIONS } from "../../src/equinox-local-runtime-versions.js";
import { readBoundedNormalFile } from "../../src/equinox-local-safe-file.js";
import { inspectPinnedElectronZip } from "./inspect-pinned-electron-zip.mjs";
import { inspectExtractedPinnedWindowsElectron } from "./inspect-extracted-electron-windows.mjs";

// Original external signed Main installer only. This prepares an independent,
// SHA-addressed UI binary tree; it never changes the native Main pointer,
// replaces an unknown existing directory, starts a process or repairs A/B.
export async function activateSignedMainWindowsElectronUi({
  signedPointer,
  installerOptIn = false,
  homeDir = os.homedir(),
  arch = process.arch,
  env = process.env,
}: {
  signedPointer: unknown;
  installerOptIn?: boolean;
  homeDir?: string;
  arch?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<Readonly<{target: string; sourceSha: string; installedPath: string; executablePath: string; reused: boolean}>> {
  if (installerOptIn !== true || process.platform !== "win32" ||
      !["arm64", "x64"].includes(arch) ||
      !path.win32.isAbsolute(homeDir) ||
      path.win32.normalize(homeDir) !== homeDir) {
    throw new Error("Managed Windows Electron admission is restricted to an opted-in signed Windows installer.");
  }
  const target = "win32-" + arch;
  const pointer = validateTrustedMainInstallPointer(signedPointer);
  const sourceSha = pointer.sourceSha;
  const row = pointer.targets.find((item) => item.target === target);
  if (!row || !/^[a-f0-9]{40}$/u.test(sourceSha)) {
    throw new Error("Signed Windows Main selector does not admit this exact UI target.");
  }
  const root = equinoxLocalManagedSourcePaths({homeDir, platform: "win32", arch, env}).mainTransactionRoot;
  const stored = await inspectEquinoxLocalMainNativeStoredRelease({
    transactionRoot: root, sourceSha, target,
    expectedRuntimeContractSha256: row.runtimeContractSha256,
  });
  const releaseDir = path.win32.join(root, "native-store", target, sourceSha, "release");
  if (stored.releaseDir.toLowerCase() !== releaseDir.toLowerCase() ||
      stored.sourceSha !== sourceSha || stored.target !== target ||
      stored.manifest.artifactSha256 !== row.artifact.sha256 ||
      stored.manifest.artifactBytes !== row.artifact.bytes ||
      stored.manifest.payloadVersion !== pointer.version) {
    throw new Error("Signed Windows Electron UI source is not the original immutable native release.");
  }
  // Original installer writes the EXACT durable signed Main receipt for SHA.
  const receiptPath = path.win32.join(root, "native-store", target, sourceSha, "signed-selector.json");
  const {data} = await readBoundedNormalFile(receiptPath, {
    platform: "win32", minBytes: 200, maxBytes: 16 * 1024,
    encoding: "utf8", label: "Immutable Windows Electron signed Main receipt",
  });
  let receipt: unknown;
  try { receipt = JSON.parse(data); }
  catch { throw new Error("Signed Windows Main receipt is malformed."); }
  if (JSON.stringify(validateTrustedMainInstallPointer(receipt, {expectedSourceSha: sourceSha})) !==
      JSON.stringify(pointer)) {
    throw new Error("Signed Windows Main receipt differs from the installer's verified selector.");
  }
  const pinned = ELECTRON_DISTRIBUTIONS[target as keyof typeof ELECTRON_DISTRIBUTIONS];
  if (!pinned) throw new Error("Unpinned Windows Electron target.");
  const archivePath = path.win32.join(releaseDir, "runtime", "electron", pinned.filename);

  async function requirePrivate(directory: string) {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Windows Electron private directory has an unsafe type.");
    }
    const acl = await verifyWindowsPrivateStateAcl({target: directory, type: "directory", env});
    if (!acl.safe) throw new Error("Windows Electron directory ACL is not private.");
  }
  await requirePrivate(root);
  const uiRoot = path.win32.join(root, "electron-ui");
  const targetRoot = path.win32.join(uiRoot, target);
  for (const directory of [uiRoot, targetRoot]) {
    const existed = await fs.lstat(directory).then(() => true, (error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
      throw error;
    });
    if (!existed) {
      try { await fs.mkdir(directory, {mode: 0o700}); }
      catch (error) {
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
      }
      // Never modify an already-existing directory that raced creation.
      // Only allow ACL protection for our just-created normal folder.
      const created = await fs.lstat(directory);
      if (!created.isDirectory() || created.isSymbolicLink()) {
        throw new Error("New Windows Electron UI directory is unsafe.");
      }
      await protectWindowsPrivateStatePath({target: directory, type: "directory", env});
    }
    await requirePrivate(directory);
  }
  const installedPath = path.win32.join(targetRoot, sourceSha);
  const lockPath = path.win32.join(targetRoot, ".activation.lock");
  // A lock belongs to this exact installer operation. NEVER delete foreign,
  // abandoned or live locks; manual signed installer recovery is required.
  const lock = await fs.open(lockPath, "wx", 0o600);
  let stagedPath: string | null = null;
  try {
    await lock.writeFile(JSON.stringify({schemaVersion: 1, target, sourceSha,
      pid: process.pid, nonce: randomBytes(16).toString("hex")}));
    await lock.sync();
    await protectWindowsPrivateStatePath({target: lockPath, type: "file", env});
    if (!(await verifyWindowsPrivateStateAcl({target: lockPath, type: "file", env})).safe) {
      throw new Error("Windows Electron admission lock ACL is unsafe.");
    }
    async function noMainTransaction() {
      try {
        await fs.lstat(path.win32.join(root, "active.json"));
        throw new Error("Main installer transaction is active; Electron UI admission refused.");
      } catch (error) {
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
      }
    }
    await noMainTransaction();
    const first = await fs.lstat(installedPath).then((stat) => stat, (error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
      throw error;
    });
    if (first) await requirePrivate(installedPath);

    const prepared = await inspectPinnedElectronZip({
      archivePath, target, stageWindowsTo: targetRoot,
    });
    if (!prepared.stagedPath || path.win32.dirname(prepared.stagedPath).toLowerCase() !== targetRoot.toLowerCase()) {
      throw new Error("Signed Windows Electron staging did not produce a contained tree.");
    }
    stagedPath = prepared.stagedPath;
    await protectWindowsPrivateStatePath({target: stagedPath, type: "directory", env});
    await requirePrivate(stagedPath);
    const derived = await inspectExtractedPinnedWindowsElectron({
      archivePath, target, extractedRoot: stagedPath,
    });
    if (derived.files < 3) throw new Error("Signed Windows Electron ZIP extraction is incomplete.");
    await noMainTransaction();
    const current = await fs.lstat(installedPath).then((stat) => stat, (error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
      throw error;
    });
    let reused = false;
    if (first && current && first.dev === current.dev && first.ino === current.ino) {
      // Reuse only fully unchanged signed content; never overwrite a modified
      // same-SHA destination while its WPF UI might still be running.
      await requirePrivate(installedPath);
      await inspectExtractedPinnedWindowsElectron({archivePath, target, extractedRoot: installedPath});
      reused = true;
    } else {
      if (first || current) {
        throw new Error("Signed Windows Electron destination changed; refusing overwrite.");
      }
      await fs.rename(stagedPath, installedPath);
      stagedPath = null;
      // The destination is ours ONLY in the first-install case. If anything
      // drifts here, fail closed without deleting unexpected user content.
      await requirePrivate(installedPath);
      await inspectExtractedPinnedWindowsElectron({archivePath, target, extractedRoot: installedPath});
    }
    await noMainTransaction();
    return Object.freeze({target, sourceSha, installedPath,
      executablePath: path.win32.join(installedPath, "electron.exe"), reused});
  } finally {
    if (stagedPath) await fs.rm(stagedPath, {recursive: true, force: true});
    const owned = await lock.stat().catch(() => null);
    await lock.close();
    const current = await fs.lstat(lockPath).catch(() => null);
    if (owned && current && owned.dev === current.dev && owned.ino === current.ino) {
      await fs.rm(lockPath, {force: true});
    }
  }
}
