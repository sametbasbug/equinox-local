import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

type GuardianFs = typeof fs;
type GuardianInstallation = Readonly<{
  platform?:string;target?:string;installRoot?:string;releaseDir?:string;
}>;
type GuardianOptions = Readonly<{installation?:GuardianInstallation;fsImpl?:GuardianFs}>;
function errorCode(error:unknown,code:string):boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}

const MAX_GUARDIAN_SIZE = 80 * 1024 * 1024;
// Main A may have reclaimed its old numbered Stable native tree. The
// immutable source A native-store is its only correct Guardian provenance.
function isOwnedNativeOrStableRelease(installation:GuardianInstallation):boolean {
  const root=installation.installRoot!, release=installation.releaseDir!;
  if (path.dirname(release)===path.join(root,'releases')) return true;
  const store=path.join(root,'state','main-update','native-store',installation.target!);
  const relative=path.relative(store,release).split(path.sep);
  return relative.length===2 && /^[a-f0-9]{40}$/u.test(relative[0]??'') &&
    relative[1]==='release' && release===path.join(store,relative[0]!,relative[1]!);
}


async function normalDir(dir:string,fsImpl:GuardianFs) {
  const stat = await fsImpl.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Windows Guardian destination is not a normal owned directory.");
}

async function normalFile(file:string,fsImpl:GuardianFs) {
  const stat = await fsImpl.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1024 || stat.size > MAX_GUARDIAN_SIZE) {
    throw new Error("Windows Guardian is not a bounded normal executable.");
  }
  return stat;
}

async function digestFile(file:string,fsImpl:GuardianFs) {
  // Use the opened handle rather than reopening a path for each read.
  const handle = await fsImpl.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size < 1024 || opened.size > MAX_GUARDIAN_SIZE) {
      throw new Error("Windows Guardian changed during integrity inspection.");
    }
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
    return Object.freeze({ sha256: hash.digest("hex"), size: opened.size });
  } finally { await handle.close().catch(() => {}); }
}

// A release-local Guardian is admitted only after the enclosing managed
// package has been validated. This operation never edits Start Menu/ARP/Run
// entries or activates the Guardian as the updater. Older Stable releases
// without a Guardian are explicitly supported.
export async function provisionWindowsGuardianFromRelease({
  installation,
  fsImpl = fs,
}:GuardianOptions = {}) {
  if (!installation || installation.platform !== "win32" || typeof installation.target !== "string" || !["win32-x64", "win32-arm64"].includes(installation.target) ||
      typeof installation.installRoot !== "string" || typeof installation.releaseDir !== "string" ||
      !path.isAbsolute(installation.installRoot) || !path.isAbsolute(installation.releaseDir) ||
      path.normalize(installation.installRoot) !== installation.installRoot ||
      path.normalize(installation.releaseDir) !== installation.releaseDir ||
      !isOwnedNativeOrStableRelease(installation)) {
    throw new Error("Windows Guardian requires an exact owned managed release.");
  }
  const releaseDir = installation.releaseDir;
  const sourceDir = path.join(releaseDir, "runtime", "guardian");
  const source = path.join(sourceDir, "EquinoxLocalGuardian.exe");
  await normalDir(releaseDir, fsImpl);
  await normalDir(path.join(releaseDir, "runtime"), fsImpl);
  let present;
  try { present = await fsImpl.lstat(sourceDir); }
  catch (error) {
    if (errorCode(error,"ENOENT")) return Object.freeze({ status: "legacy-release", installed: false });
    throw error;
  }
  if (!present.isDirectory() || present.isSymbolicLink()) throw new Error("Windows Guardian release directory is unsafe.");
  await normalDir(sourceDir, fsImpl);
  await normalFile(source, fsImpl);
  const reference = await digestFile(source, fsImpl);
  const runtimeDir = path.join(installation.installRoot, "runtime");
  await normalDir(installation.installRoot, fsImpl);
  await fsImpl.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  await normalDir(runtimeDir, fsImpl);
  const targetDir = path.join(runtimeDir, "guardian");
  try { await fsImpl.mkdir(targetDir, { mode: 0o700 }); }
  catch (error) { if (!errorCode(error,"EEXIST")) throw error; }
  await normalDir(targetDir, fsImpl);
  const target = path.join(targetDir, "EquinoxLocalGuardian.exe");
  try {
    await normalFile(target, fsImpl);
    const existing = await digestFile(target, fsImpl);
    if (existing.sha256 !== reference.sha256 || existing.size !== reference.size) {
      throw new Error("Existing independent Windows Guardian differs from the trusted release; refusing replacement.");
    }
    return Object.freeze({ status: "already-provisioned", installed: true, sha256: existing.sha256 });
  } catch (error) {
    if (!errorCode(error,"ENOENT")) throw error;
  }
  const temp = path.join(targetDir, `.guardian-${randomBytes(8).toString("hex")}.tmp`);
  let handle:Awaited<ReturnType<GuardianFs["open"]>>|null = null;
  try {
    handle = await fsImpl.open(temp, "wx", 0o600);
    const sourceHandle = await fsImpl.open(source, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const buffer = Buffer.allocUnsafe(128 * 1024);
      while (true) {
        const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        let offset = 0;
        while (offset < bytesRead) {
          const { bytesWritten } = await handle.write(buffer, offset, bytesRead - offset);
          if (!bytesWritten) throw new Error("Windows Guardian staged copy made no progress.");
          offset += bytesWritten;
        }
      }
    } finally { await sourceHandle.close(); }
    await handle.sync(); await handle.close(); handle = null;
    const staged = await digestFile(temp, fsImpl);
    const confirmedSource = await digestFile(source, fsImpl);
    if (staged.sha256 !== reference.sha256 || staged.size !== reference.size ||
        confirmedSource.sha256 !== reference.sha256 || confirmedSource.size !== reference.size) {
      throw new Error("Windows Guardian release or staged bytes changed during copy.");
    }
    // Exclusive hard-link publication: on Windows same-volume link is atomic
    // and fails rather than overwriting an already owned Guardian executable.
    await fsImpl.link(temp, target);
    const installed = await digestFile(target, fsImpl);
    if (installed.sha256 !== reference.sha256 || installed.size !== reference.size) {
      throw new Error("New Windows Guardian failed post-publication integrity check.");
    }
    return Object.freeze({ status: "provisioned", installed: true, sha256: installed.sha256 });
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fsImpl.rm(temp, { force: true }).catch(() => {});
  }
}
