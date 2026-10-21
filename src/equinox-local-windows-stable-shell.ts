import { spawn as spawnChild } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { requestWindowsShellUpdateShutdown } from "./equinox-local-windows-shell-control.js";
import { fingerprintEquinoxLocalNativeState } from "./equinox-local-native-state-fingerprint.js";
import { readBoundedNormalFile } from "./equinox-local-safe-file.js";

type ShellFs = typeof fs;
type FsOptions = { fsImpl?: ShellFs };
type SnapshotOptions = FsOptions & { ignoreLegacyCache?: boolean };
type TreeRow = Readonly<{relative: string; bytes: number; sha256: string}>;
type ShellPaths = FsOptions & { releaseDir?: string; programRoot?: string };
type RollbackPaths = FsOptions & { programRoot?: string; snapshotReleaseDir?: string };
type ReplacePaths = ShellPaths & {previousReleaseDir?: string; requestShutdownImpl?: typeof requestWindowsShellUpdateShutdown; sleepImpl?: (ms: number) => Promise<unknown>};
type RestorePaths = RollbackPaths & {currentReleaseDir?: string; requestShutdownImpl?: typeof requestWindowsShellUpdateShutdown; sleepImpl?: (ms: number) => Promise<unknown>};
type RenameOptions = FsOptions & {sleepImpl?: (ms: number) => Promise<unknown>; attempts?: number};
type SpawnOptions = {spawnImpl?: typeof spawnChild};
function hasErrorCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}
const MAX_WINDOWS_SHELL_ENTRIES = 5_000;
const MAX_WINDOWS_SHELL_BYTES = 512 * 1024 * 1024;
const REPLACE_ATTEMPTS = 100;
const REPLACE_DELAY_MS = 100;
const RETRYABLE_RENAME_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);

async function sha256File(filePath: string, fsImpl: ShellFs = fs): Promise<string> {
  const digest = createHash("sha256");
  const handle = await fsImpl.open(filePath, "r");
  try {
    for await (const chunk of handle.createReadStream()) digest.update(chunk);
  } finally {
    await handle.close().catch(() => {});
  }
  return digest.digest("hex");
}

// 6.0.0-6.0.2 WPF accidentally created WebView2 and WinRT cache trees
// inside the installed shell. Ignore only these exact *top-level directory*
// names while checking an already installed shell. Signed release trees and
// freshly staged copies must still match byte-for-byte without exceptions.
const LEGACY_WINDOWS_SHELL_RUNTIME_CACHE = new Set(["EquinoxLocal.exe.WebView2", "%SystemDrive%"]);

async function assertLegacyShellCacheTree(directory: string, { fsImpl = fs }: FsOptions = {}): Promise<void> {
  // Ignoring runtime-only content must not turn an unexpected junction into
  // a trusted part of the installed application's ownership boundary.
  const pending: string[] = [directory];
  let count = 0;
  let bytes = 0;
  while (pending.length) {
    const current = pending.pop()!;
    for (const entry of await fsImpl.readdir(current)) {
      if (++count > MAX_WINDOWS_SHELL_ENTRIES) throw new Error("Windows legacy shell cache exceeds the entry limit.");
      const absolute = path.join(current, entry);
      const stat = await fsImpl.lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error("Windows legacy shell cache contains a symbolic link or junction.");
      if (stat.isDirectory()) pending.push(absolute);
      else if (stat.isFile()) {
        bytes += stat.size;
        if (bytes > MAX_WINDOWS_SHELL_BYTES) throw new Error("Windows legacy shell cache exceeds the byte limit.");
      } else throw new Error("Windows legacy shell cache contains an unsupported filesystem entry.");
    }
  }
}

export async function snapshotWindowsStableShellTree(root: string, { fsImpl = fs, ignoreLegacyCache = false }: SnapshotOptions = {}): Promise<readonly TreeRow[]> {
  const rootStat = await fsImpl.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`Windows stable shell root is unsafe: ${root}`);
  const rows: TreeRow[] = [];
  const stack: {absolute: string;relative: string}[] = [{ absolute: root, relative: "" }];
  let totalBytes = 0;
  while (stack.length) {
    const current = stack.pop()!;
    const entries = await fsImpl.readdir(current.absolute, { withFileTypes: true });
    for (const entry of entries) {
      if (rows.length >= MAX_WINDOWS_SHELL_ENTRIES) throw new Error("Windows stable shell contains too many entries.");
      const absolute = path.join(current.absolute, entry.name);
      const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      const stat = await fsImpl.lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error("Windows stable shell may not contain symbolic links or junctions.");
      if (ignoreLegacyCache && current.relative === "" && stat.isDirectory() && LEGACY_WINDOWS_SHELL_RUNTIME_CACHE.has(entry.name)) {
        await assertLegacyShellCacheTree(absolute, { fsImpl });
        continue;
      }
      if (stat.isDirectory()) {
        stack.push({ absolute, relative });
        continue;
      }
      if (!stat.isFile()) throw new Error("Windows stable shell contains an unsupported filesystem entry.");
      totalBytes += stat.size;
      if (totalBytes > MAX_WINDOWS_SHELL_BYTES) throw new Error("Windows stable shell exceeds the size limit.");
      rows.push(Object.freeze({ relative, bytes: stat.size, sha256: await sha256File(absolute, fsImpl) }));
    }
  }
  rows.sort((a, b) => a.relative.localeCompare(b.relative, "en"));
  return Object.freeze(rows);
}

export function sameWindowsStableShellTree(left: readonly TreeRow[], right: readonly TreeRow[]): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const other = right[index];
    return other !== undefined && entry.relative === other.relative && entry.bytes === other.bytes && entry.sha256 === other.sha256;
  });
}

async function verifiedReleaseShell(releaseDir: string, { fsImpl = fs }: FsOptions = {}) {
  const sourceRoot = path.join(releaseDir, "runtime", "shell");
  const sourceSnapshot = await snapshotWindowsStableShellTree(sourceRoot, { fsImpl });
  if (!sourceSnapshot.some((entry) => entry.relative === "EquinoxLocal.exe")) throw new Error("Verified Windows shell is missing EquinoxLocal.exe.");
  return Object.freeze({ sourceRoot, sourceSnapshot });
}

export async function stageWindowsStableShellForRelease({ releaseDir, programRoot, fsImpl = fs }: ShellPaths = {}) {
  if (typeof releaseDir !== "string" || typeof programRoot !== "string") throw new Error("Windows stable shell paths are required.");
  const { sourceRoot, sourceSnapshot } = await verifiedReleaseShell(releaseDir, { fsImpl });
  const parent = path.dirname(programRoot);
  await fsImpl.mkdir(parent, { recursive: true });
  const parentStat = await fsImpl.lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error("Windows stable program parent is unsafe.");
  const stagedRoot = path.join(parent, `.equinox-shell-next-${process.pid}-${randomBytes(8).toString("hex")}`);
  try {
    await fsImpl.cp(sourceRoot, stagedRoot, { recursive: true, force: false, errorOnExist: true, dereference: false });
    const copiedSnapshot = await snapshotWindowsStableShellTree(stagedRoot, { fsImpl });
    if (!sameWindowsStableShellTree(sourceSnapshot, copiedSnapshot)) throw new Error("Copied Windows stable shell failed integrity verification.");
    return Object.freeze({ stagedRoot, sourceRoot, sourceSnapshot, shellExecutable: path.join(stagedRoot, "EquinoxLocal.exe") });
  } catch (error) {
    await fsImpl.rm(stagedRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function snapshotWindowsStableShellForRollback({ programRoot, snapshotReleaseDir, fsImpl = fs }: RollbackPaths = {}) {
  if (typeof programRoot !== "string" || typeof snapshotReleaseDir !== "string") throw new Error("Windows stable shell snapshot paths are required.");
  // A running WPF can generate its two known legacy cache trees inside the
  // program directory. These are not release bytes and must never be sealed
  // into a rollback release: later live-shell verification intentionally
  // excludes them. Validate their structure, but snapshot only the actual
  // executable tree so every byte of the rollback remains fingerprinted.
  const sourceSnapshot = await snapshotWindowsStableShellTree(programRoot, { fsImpl, ignoreLegacyCache: true });
  const snapshotRoot = path.join(snapshotReleaseDir, "runtime", "shell");
  try {
    await fsImpl.lstat(snapshotReleaseDir);
    throw Object.assign(new Error("Windows stable shell snapshot destination already exists."), { code: "EEXIST" });
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
  await fsImpl.mkdir(path.dirname(snapshotRoot), { recursive: true });
  try {
    await fsImpl.cp(programRoot, snapshotRoot, {
      recursive: true, force: false, errorOnExist: true, dereference: false,
      filter: (source) => !LEGACY_WINDOWS_SHELL_RUNTIME_CACHE.has(path.relative(programRoot, source)),
    });
    const copiedSnapshot = await snapshotWindowsStableShellTree(snapshotRoot, { fsImpl });
    if (!sameWindowsStableShellTree(sourceSnapshot, copiedSnapshot)) throw new Error("Windows stable shell rollback snapshot failed integrity verification.");
    const fingerprint = await fingerprintEquinoxLocalNativeState(snapshotRoot, { fsImpl });
    const manifestPrefix: {schemaVersion:1;kind:"windows-shell"} = {schemaVersion:1,kind:"windows-shell"};
    await fsImpl.writeFile(path.join(snapshotReleaseDir, "rollback.json"), `${JSON.stringify({ ...manifestPrefix, ...fingerprint }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    await fsImpl.rm(snapshotReleaseDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return Object.freeze({ snapshotReleaseDir, snapshotRoot, sourceSnapshot });
}

export async function inspectWindowsStableShellRollbackSnapshot({ snapshotReleaseDir, fsImpl = fs }: RollbackPaths = {}) {
  if (typeof snapshotReleaseDir !== "string") throw new Error("Windows stable shell rollback snapshot path is required.");
  const manifestPath = path.join(snapshotReleaseDir, "rollback.json");
  const manifestFile = await readBoundedNormalFile(manifestPath, { fsImpl, minBytes: 1, maxBytes: 4096, encoding: "utf8", label: "Windows stable shell rollback manifest" });
  const manifest = JSON.parse(manifestFile.data);
  const snapshotRoot = path.join(snapshotReleaseDir, "runtime", "shell");
  const fingerprint = await fingerprintEquinoxLocalNativeState(snapshotRoot, { fsImpl });
  if (manifest?.schemaVersion !== 1 || manifest?.kind !== "windows-shell" || manifest?.sha256 !== fingerprint.sha256 || manifest?.entries !== fingerprint.entries || manifest?.bytes !== fingerprint.bytes) {
    throw new Error("Windows stable shell rollback snapshot fingerprint mismatch.");
  }
  return Object.freeze({ snapshotReleaseDir, snapshotRoot, manifestPath, fingerprint });
}

export async function restoreWindowsStableShellRollbackSnapshot({
  snapshotReleaseDir,
  currentReleaseDir,
  programRoot,
  fsImpl = fs,
  requestShutdownImpl = requestWindowsShellUpdateShutdown,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}: RestorePaths = {}) {
  if (typeof snapshotReleaseDir !== "string" || typeof currentReleaseDir !== "string" || typeof programRoot !== "string") {
    throw new Error("Windows stable shell rollback paths are required.");
  }
  await inspectWindowsStableShellRollbackSnapshot({ snapshotReleaseDir, fsImpl });
  return replaceWindowsStableShellForRelease({
    releaseDir: snapshotReleaseDir,
    previousReleaseDir: currentReleaseDir,
    programRoot,
    fsImpl,
    requestShutdownImpl,
    sleepImpl,
  });
}

export async function assertWindowsStableShellOwnedByRelease({ releaseDir, programRoot, fsImpl = fs }: ShellPaths = {}) {
  if (typeof releaseDir !== "string" || typeof programRoot !== "string") throw new Error("Windows stable shell paths are required.");
  const desired = await verifiedReleaseShell(releaseDir, { fsImpl });
  const installed = await snapshotWindowsStableShellTree(programRoot, { fsImpl, ignoreLegacyCache: true });
  if (!sameWindowsStableShellTree(desired.sourceSnapshot, installed)) {
    throw new Error("Existing Windows stable shell does not match the active managed release.");
  }
  return Object.freeze({ owned: true, shellExecutable: path.join(programRoot, "EquinoxLocal.exe") });
}

export async function synchronizeFreshWindowsShell({ releaseDir, programRoot, fsImpl = fs }: ShellPaths = {}) {
  if (typeof releaseDir !== "string" || typeof programRoot !== "string") throw new Error("Windows stable shell paths are required.");
  const { sourceSnapshot } = await verifiedReleaseShell(releaseDir, { fsImpl });
  try {
    const existing = await fsImpl.lstat(programRoot);
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error("Existing Windows stable shell root is unsafe.");
    const existingSnapshot = await snapshotWindowsStableShellTree(programRoot, { fsImpl, ignoreLegacyCache: true });
    if (!sameWindowsStableShellTree(sourceSnapshot, existingSnapshot)) throw new Error("Existing Windows stable shell does not match the verified release.");
    return Object.freeze({ synchronized: false, reused: true, shellExecutable: path.join(programRoot, "EquinoxLocal.exe") });
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }

  const staged = await stageWindowsStableShellForRelease({ releaseDir, programRoot, fsImpl });
  try {
    await fsImpl.rename(staged.stagedRoot, programRoot);
  } catch (error) {
    await fsImpl.rm(staged.stagedRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return Object.freeze({ synchronized: true, reused: false, shellExecutable: path.join(programRoot, "EquinoxLocal.exe") });
}

export async function renameWindowsPathWhenUnlocked(source: string, destination: string, {
  fsImpl = fs,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  attempts = REPLACE_ATTEMPTS,
}: RenameOptions = {}) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await fsImpl.rename(source, destination);
      return;
    } catch (error) {
      lastError = error;
      if (!(hasErrorCode(error, "EACCES") || hasErrorCode(error, "EBUSY") || hasErrorCode(error, "EPERM")) || attempt + 1 >= attempts) throw error;
      await sleepImpl(REPLACE_DELAY_MS);
    }
  }
  throw lastError ?? new Error("Windows stable shell rename did not complete.");
}

export async function replaceWindowsStableShellForRelease({
  releaseDir,
  previousReleaseDir,
  programRoot,
  fsImpl = fs,
  requestShutdownImpl = requestWindowsShellUpdateShutdown,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}: ReplacePaths = {}) {
  if (typeof previousReleaseDir !== "string") throw new Error("Previous Windows release path is required for stable-shell replacement.");
  if (typeof releaseDir !== "string" || typeof programRoot !== "string") throw new Error("Windows stable shell paths are required.");
  const desired = await verifiedReleaseShell(releaseDir, { fsImpl });
  const currentSnapshot = await snapshotWindowsStableShellTree(programRoot, { fsImpl, ignoreLegacyCache: true });
  if (sameWindowsStableShellTree(desired.sourceSnapshot, currentSnapshot)) {
    return Object.freeze({ synchronized: false, reused: true, shellExecutable: path.join(programRoot, "EquinoxLocal.exe") });
  }
  const previous = await verifiedReleaseShell(previousReleaseDir, { fsImpl });
  if (!sameWindowsStableShellTree(previous.sourceSnapshot, currentSnapshot)) {
    throw new Error("Existing Windows stable shell does not match the expected previous release.");
  }

  const staged = await stageWindowsStableShellForRelease({ releaseDir, programRoot, fsImpl });
  const backupRoot = path.join(path.dirname(programRoot), `.equinox-shell-backup-${process.pid}-${randomBytes(8).toString("hex")}`);
  let movedPrevious = false;
  try {
    await requestShutdownImpl({ platform: "win32" }).catch(() => null);
    await renameWindowsPathWhenUnlocked(programRoot, backupRoot, { fsImpl, sleepImpl });
    movedPrevious = true;
    await fsImpl.rename(staged.stagedRoot, programRoot);
    const installed = await snapshotWindowsStableShellTree(programRoot, { fsImpl, ignoreLegacyCache: true });
    if (!sameWindowsStableShellTree(desired.sourceSnapshot, installed)) throw new Error("Installed Windows stable shell failed integrity verification.");
    await fsImpl.rm(backupRoot, { recursive: true, force: false });
    return Object.freeze({ synchronized: true, reused: false, shellExecutable: path.join(programRoot, "EquinoxLocal.exe") });
  } catch (error) {
    await fsImpl.rm(staged.stagedRoot, { recursive: true, force: true }).catch(() => {});
    if (movedPrevious) {
      // The previous executable tree is the last runnable native shell. Never
      // erase a candidate or swallow a failed restore and pretend it rolled
      // back. Verify the backup before moving any live program directory.
      let quarantineRoot: string | null = null;
      try {
        const backupSnapshot = await snapshotWindowsStableShellTree(backupRoot, { fsImpl, ignoreLegacyCache: true });
        if (!sameWindowsStableShellTree(previous.sourceSnapshot, backupSnapshot)) {
          throw new Error("Windows shell backup identity changed after the native swap.");
        }
        let currentExists = false;
        try {
          const stat = await fsImpl.lstat(programRoot);
          if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw new Error("Windows shell candidate root is unsafe during native rollback.");
          }
          currentExists = true;
        } catch (inner) {
          if (!hasErrorCode(inner, "ENOENT")) throw inner;
        }
        if (currentExists) {
          quarantineRoot = path.join(path.dirname(programRoot), `.equinox-shell-failed-${process.pid}-${randomBytes(8).toString("hex")}`);
          await fsImpl.rename(programRoot, quarantineRoot);
        }
        await fsImpl.rename(backupRoot, programRoot);
        const restored = await snapshotWindowsStableShellTree(programRoot, { fsImpl, ignoreLegacyCache: true });
        if (!sameWindowsStableShellTree(previous.sourceSnapshot, restored)) {
          throw new Error("Restored Windows native shell failed rollback integrity verification.");
        }
      } catch (rollbackError) {
        // The old backup and (if renamed) quarantined candidate are deliberately
        // retained for an independently owned supervisor/operator to inspect.
        // This must not be reported as an ordinary candidate promotion error.
        throw new AggregateError([error, rollbackError], "Windows shell native rollback failed; verified backup must be recovered before another update.");
      }
      if (quarantineRoot) await fsImpl.rm(quarantineRoot, { recursive: true, force: true }).catch(() => {});
    }
    throw error;
  }
}

export async function launchWindowsStableShell(shellExecutable: string, { spawnImpl = spawnChild }: SpawnOptions = {}) {
  if (typeof shellExecutable !== "string" || !path.isAbsolute(shellExecutable)) throw new Error("Windows stable shell executable path must be absolute.");
  // Main's detached updater owns a temporary A-version Node bootstrap,
  // which must never leak into the new WPF shell. Otherwise WPF treats the
  // inherited release directory as a Stable override and boots the old app.
  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) {
    if (/^EQUINOX_LOCAL_(?:RELEASE_DIR|INSTALL_ROOT|MAIN_WORKER_TOKEN)$/iu.test(key)) delete childEnv[key];
  }
  const child = spawnImpl(shellExecutable, [], { cwd: path.dirname(shellExecutable), detached: true, stdio: "ignore", windowsHide: false, env: childEnv });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Windows stable shell launch did not start within 5 seconds.")), 5_000);
    timer.unref?.();
    child.once("spawn", () => { clearTimeout(timer); resolve(); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
  child.unref();
  return Object.freeze({ launched: true, pid: Number.isInteger(child.pid) ? child.pid : null });
}
