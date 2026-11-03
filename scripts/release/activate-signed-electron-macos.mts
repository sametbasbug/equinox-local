import { execFile as execFileCallback } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { validateTrustedMainInstallPointer } from "../../src/equinox-local-main-install-pointer.js";
import { inspectEquinoxLocalMainNativeStoredRelease } from "../../src/equinox-local-main-native-state.js";
import { equinoxLocalManagedSourcePaths } from "../../src/equinox-local-managed-source-installation.js";
import { ELECTRON_DISTRIBUTIONS } from "../../src/equinox-local-runtime-versions.js";
import { inspectExtractedPinnedMacElectron } from "./inspect-extracted-electron-macos.mjs";

// Dormant installer-side admission. It never starts Electron or changes the
// selected Main native pointer; callers must already own the signed install
// transaction. Do not invoke from a source-checkout Factory runtime.
const execFile = promisify(execFileCallback);
const HOSTED_UI_ID = "dev.equinox.local.workspace-ui";

function isMissing(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

async function privateDirectory(directory: string, create = false): Promise<void> {
  if (create) {
    try { await fs.mkdir(directory, {mode: 0o700}); }
    catch (error) {
      if (error === null || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
    }
  }
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
      await fs.realpath(directory) !== directory) {
    throw new Error("Managed Electron UI runtime root is not canonical, private and user-owned.");
  }
}

async function signedUiIdentity(app: string): Promise<void> {
  await execFile("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], {
    timeout: 30_000, maxBuffer: 1024 * 1024,
  });
  const {stderr} = await execFile("/usr/bin/codesign", ["-dv", app], {
    timeout: 15_000, maxBuffer: 1024 * 1024,
  });
  if (!stderr.includes("Identifier=" + HOSTED_UI_ID) || !stderr.includes("Signature=adhoc")) {
    throw new Error("Managed Electron UI app signature or bundle identifier is not admitted.");
  }
}

// Production defaults enforce the pinned Ed25519 Main trust root and original
// immutable native-store manifest/tree fingerprint. Dependency overrides are
// only for disposable build-tool integration diagnostics.
export async function activateSignedMainMacElectronUi({
  signedPointer,
  installerOptIn = false,
  homeDir = os.homedir(),
  arch = process.arch,
  verifyPointerImpl = validateTrustedMainInstallPointer,
  inspectStoredImpl = inspectEquinoxLocalMainNativeStoredRelease,
}: {
  signedPointer: unknown;
  installerOptIn?: boolean;
  homeDir?: string;
  arch?: string;
  verifyPointerImpl?: typeof validateTrustedMainInstallPointer;
  inspectStoredImpl?: typeof inspectEquinoxLocalMainNativeStoredRelease;
}): Promise<Readonly<{target: string; sourceSha: string; installedPath: string; executablePath: string}>> {
  if (installerOptIn !== true) {
    throw new Error("Managed Electron UI installation is disabled unless the signed installer explicitly opts in.");
  }
  if (process.platform !== "darwin" || process.getuid?.() === 0 ||
      !["arm64", "x64"].includes(arch) ||
      !path.isAbsolute(homeDir) || path.normalize(homeDir) !== homeDir) {
    throw new Error("Managed Electron UI activation requires a canonical macOS home and CPU target.");
  }
  const pointer = verifyPointerImpl(signedPointer);
  const target = "darwin-" + arch;
  const row = pointer.targets.find((candidate) => candidate.target === target);
  const sourceSha = pointer.sourceSha;
  if (!row || !/^[a-f0-9]{40}$/u.test(sourceSha)) {
    throw new Error("Signed Main selector does not authorize this Electron target and source SHA.");
  }
  const root = equinoxLocalManagedSourcePaths({homeDir, platform: "darwin", arch}).mainTransactionRoot;
  await privateDirectory(root);
  const stored = await inspectStoredImpl({
    transactionRoot: root, target, sourceSha,
    expectedRuntimeContractSha256: row.runtimeContractSha256,
  });
  const releaseDir = path.join(root, "native-store", target, sourceSha, "release");
  if (stored.releaseDir !== releaseDir || stored.sourceSha !== sourceSha ||
      stored.target !== target ||
      stored.runtimeContractSha256 !== row.runtimeContractSha256 ||
      stored.manifest.artifactSha256 !== row.artifact.sha256 ||
      stored.manifest.artifactBytes !== row.artifact.bytes ||
      stored.manifest.payloadVersion !== pointer.version) {
    throw new Error("Signed Main immutable release differs from the authenticated selector.");
  }
  const sourceEntrypoint = path.join(releaseDir, "desktop", "electron", "main.cjs");
  const sourceHandle = await fs.open(sourceEntrypoint, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    if (!(await sourceHandle.stat()).isFile()) throw new Error("Signed Electron UI source entrypoint is not a normal file.");
  } finally { await sourceHandle.close(); }

  const pinned = ELECTRON_DISTRIBUTIONS[target as keyof typeof ELECTRON_DISTRIBUTIONS];
  if (!pinned) throw new Error("Signed Electron UI distribution is not pinned.");
  const archivePath = path.join(releaseDir, "runtime", "electron", pinned.filename);
  const uiRoot = path.join(root, "electron-ui");
  const targetRoot = path.join(uiRoot, target);
  await privateDirectory(uiRoot, true);
  await privateDirectory(targetRoot, true);
  const installedPath = path.join(targetRoot, sourceSha);
  const lockPath = path.join(targetRoot, ".activation.lock");
  const lock = await fs.open(lockPath, "wx", 0o600);
  let scratch: string | null = null;
  try {
    // There must be no overlapping Main install/update and no second UI
    // activation. A previous same-SHA tree is NOT overwritten or deleted.
    try {
      await fs.lstat(path.join(root, "active.json"));
      throw new Error("Main native transaction active; Electron UI admission is unavailable.");
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    try {
      await fs.lstat(installedPath);
      throw new Error("Electron UI release destination already exists; refusing overwrite.");
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    scratch = await fs.mkdtemp(path.join(targetRoot, ".ui-stage-"));
    const staged = await inspectExtractedPinnedMacElectron({
      archivePath, target, scratchRoot: scratch, stageHostedUi: true,
    });
    if (!staged.stagedPath || path.dirname(staged.stagedPath) !== scratch ||
        staged.hostedBundleIdentifier !== HOSTED_UI_ID) {
      throw new Error("Verified Electron UI was not staged at the admitted location.");
    }
    await privateDirectory(root);
    await privateDirectory(targetRoot);
    try {
      await fs.lstat(path.join(root, "active.json"));
      throw new Error("Main transaction began during Electron UI preparation.");
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    try {
      await fs.lstat(installedPath);
      throw new Error("Electron UI installation destination appeared during admission.");
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await fs.rename(staged.stagedPath, installedPath);
    try {
      await signedUiIdentity(path.join(installedPath, "Electron.app"));
    } catch (error) {
      // Only our newly admitted destination, under our exclusive owner lock.
      await fs.rm(installedPath, {recursive: true, force: true});
      throw error;
    }
    const executablePath = path.join(installedPath, "Electron.app", "Contents", "MacOS", "Electron");
    return Object.freeze({target, sourceSha, installedPath, executablePath});
  } finally {
    if (scratch) await fs.rm(scratch, {recursive: true, force: true});
    const inode = await lock.stat().catch(() => null);
    await lock.close();
    const current = await fs.lstat(lockPath).catch(() => null);
    if (current && inode && current.dev === inode.dev && current.ino === inode.ino) {
      await fs.rm(lockPath, {force: true});
    }
  }
}
