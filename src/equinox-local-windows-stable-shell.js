import { spawn as spawnChild } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { requestWindowsShellUpdateShutdown } from "./equinox-local-windows-shell-control.js";

const MAX_WINDOWS_SHELL_ENTRIES = 5_000;
const MAX_WINDOWS_SHELL_BYTES = 512 * 1024 * 1024;
const REPLACE_ATTEMPTS = 100;
const REPLACE_DELAY_MS = 100;
const RETRYABLE_RENAME_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);

async function sha256File(filePath, fsImpl = fs) {
  const digest = createHash("sha256");
  const handle = await fsImpl.open(filePath, "r");
  try {
    for await (const chunk of handle.createReadStream()) digest.update(chunk);
  } finally {
    await handle.close().catch(() => {});
  }
  return digest.digest("hex");
}

export async function snapshotWindowsStableShellTree(root, { fsImpl = fs } = {}) {
  const rootStat = await fsImpl.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`Windows stable shell root is unsafe: ${root}`);
  const rows = [];
  const stack = [{ absolute: root, relative: "" }];
  let totalBytes = 0;
  while (stack.length) {
    const current = stack.pop();
    const entries = await fsImpl.readdir(current.absolute, { withFileTypes: true });
    for (const entry of entries) {
      if (rows.length >= MAX_WINDOWS_SHELL_ENTRIES) throw new Error("Windows stable shell contains too many entries.");
      const absolute = path.join(current.absolute, entry.name);
      const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      const stat = await fsImpl.lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error("Windows stable shell may not contain symbolic links or junctions.");
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

export function sameWindowsStableShellTree(left, right) {
  return left.length === right.length && left.every((entry, index) => {
    const other = right[index];
    return entry.relative === other.relative && entry.bytes === other.bytes && entry.sha256 === other.sha256;
  });
}

async function verifiedReleaseShell(releaseDir, { fsImpl = fs } = {}) {
  const sourceRoot = path.join(releaseDir, "runtime", "shell");
  const sourceSnapshot = await snapshotWindowsStableShellTree(sourceRoot, { fsImpl });
  if (!sourceSnapshot.some((entry) => entry.relative === "EquinoxLocal.exe")) throw new Error("Verified Windows shell is missing EquinoxLocal.exe.");
  return Object.freeze({ sourceRoot, sourceSnapshot });
}

export async function stageWindowsStableShellForRelease({ releaseDir, programRoot, fsImpl = fs } = {}) {
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

export async function synchronizeFreshWindowsShell({ releaseDir, programRoot, fsImpl = fs } = {}) {
  if (typeof releaseDir !== "string" || typeof programRoot !== "string") throw new Error("Windows stable shell paths are required.");
  const { sourceSnapshot } = await verifiedReleaseShell(releaseDir, { fsImpl });
  try {
    const existing = await fsImpl.lstat(programRoot);
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error("Existing Windows stable shell root is unsafe.");
    const existingSnapshot = await snapshotWindowsStableShellTree(programRoot, { fsImpl });
    if (!sameWindowsStableShellTree(sourceSnapshot, existingSnapshot)) throw new Error("Existing Windows stable shell does not match the verified release.");
    return Object.freeze({ synchronized: false, reused: true, shellExecutable: path.join(programRoot, "EquinoxLocal.exe") });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
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

async function renameWhenUnlocked(source, destination, { fsImpl = fs, sleepImpl, attempts = REPLACE_ATTEMPTS } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await fsImpl.rename(source, destination);
      return;
    } catch (error) {
      lastError = error;
      if (!RETRYABLE_RENAME_CODES.has(error?.code) || attempt + 1 >= attempts) throw error;
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
} = {}) {
  if (typeof previousReleaseDir !== "string") throw new Error("Previous Windows release path is required for stable-shell replacement.");
  const desired = await verifiedReleaseShell(releaseDir, { fsImpl });
  const currentSnapshot = await snapshotWindowsStableShellTree(programRoot, { fsImpl });
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
    await renameWhenUnlocked(programRoot, backupRoot, { fsImpl, sleepImpl });
    movedPrevious = true;
    await fsImpl.rename(staged.stagedRoot, programRoot);
    const installed = await snapshotWindowsStableShellTree(programRoot, { fsImpl });
    if (!sameWindowsStableShellTree(desired.sourceSnapshot, installed)) throw new Error("Installed Windows stable shell failed integrity verification.");
    await fsImpl.rm(backupRoot, { recursive: true, force: false });
    return Object.freeze({ synchronized: true, reused: false, shellExecutable: path.join(programRoot, "EquinoxLocal.exe") });
  } catch (error) {
    await fsImpl.rm(staged.stagedRoot, { recursive: true, force: true }).catch(() => {});
    if (movedPrevious) {
      await fsImpl.rm(programRoot, { recursive: true, force: true }).catch(() => {});
      await fsImpl.rename(backupRoot, programRoot).catch(() => {});
    }
    throw error;
  }
}

export async function launchWindowsStableShell(shellExecutable, { spawnImpl = spawnChild } = {}) {
  if (typeof shellExecutable !== "string" || !path.isAbsolute(shellExecutable)) throw new Error("Windows stable shell executable path must be absolute.");
  const child = spawnImpl(shellExecutable, [], { cwd: path.dirname(shellExecutable), detached: true, stdio: "ignore", windowsHide: false });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Windows stable shell launch did not start within 5 seconds.")), 5_000);
    timer.unref?.();
    child.once("spawn", () => { clearTimeout(timer); resolve(); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
  child.unref();
  return Object.freeze({ launched: true, pid: Number.isInteger(child.pid) ? child.pid : null });
}
