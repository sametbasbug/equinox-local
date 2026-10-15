import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const TX = /^main-[a-f0-9]{32}$/u;
const SHA = /^[a-f0-9]{40}$/u;
const TOKEN = /^[a-f0-9]{64}$/u;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const MAX_GUARDIAN_BYTES = 80 * 1024 * 1024;
const FIXED_COMMAND = '--hold-native-integrated-ab';

function canonicalWin(input) {
  return typeof input === 'string' && path.win32.isAbsolute(input) &&
    path.win32.normalize(input) === input && !input.includes('\0');
}
function sameWin(a, b) {
  return canonicalWin(a) && canonicalWin(b) && a.toLowerCase() === b.toLowerCase();
}
export async function exactOwnedGuardianDigest(file, fsImpl) {
  const handle = await fsImpl.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    const linked = await fsImpl.lstat(file);
    if (!stat.isFile() || !linked.isFile() || linked.isSymbolicLink() ||
        stat.size < 1024 || stat.size > MAX_GUARDIAN_BYTES ||
        linked.ino !== stat.ino || linked.dev !== stat.dev) {
      throw new Error('Windows independent Guardian is not a bounded normal owned executable.');
    }
    const bytes = await handle.readFile();
    const end = await handle.stat();
    const endLinked = await fsImpl.lstat(file);
    if (bytes.length !== stat.size || end.ino !== stat.ino || end.dev !== stat.dev ||
        endLinked.ino !== stat.ino || endLinked.dev !== stat.dev ||
        endLinked.isSymbolicLink()) {
      throw new Error('Windows independent Guardian changed during pinned executable inspection.');
    }
    return createHash('sha256').update(bytes).digest();
  } finally {
    await handle.close();
  }
}

/**
 * Launches ONLY the already-provisioned per-user release-identical native
 * Guardian executable for an OS-owned Windows Main transaction. Launch is NOT
 * native-update admission: the Guardian independently validates exact worker
 * PID/birthtime/argv, SID, logon LUID, pipe PID+HMAC and CREATE_NEW lease,
 * and itself rejects any foreign/stale transaction before touching WPF.
 * This does NOT supply a `windowsAdmission.supervisor` capability.
 */
export async function launchEquinoxLocalWindowsNativeMainGuardian({
  transactionId, transactionRoot, currentSha, targetSha, installation,
  workerToken = process.env.EQUINOX_LOCAL_MAIN_WORKER_TOKEN,
  workerNodePath = process.execPath, platform = process.platform,
  env = process.env, fsImpl = fs, spawnImpl = spawn,
} = {}) {
  if (platform !== 'win32' || !TX.test(transactionId ?? '') ||
      !SHA.test(currentSha ?? '') || !SHA.test(targetSha ?? '') || currentSha === targetSha ||
      !TOKEN.test(workerToken ?? '') || installation?.managed !== true ||
      installation?.selfUpdateSupported !== true ||
      !['win32-x64', 'win32-arm64'].includes(installation?.target) ||
      !canonicalWin(env.LOCALAPPDATA) || !canonicalWin(transactionRoot) ||
      !canonicalWin(installation.installRoot) || !canonicalWin(installation.releaseDir) ||
      !canonicalWin(workerNodePath) || typeof spawnImpl !== 'function') {
    throw new Error('Independent Windows Guardian launch requires exact owned native Main worker identity.');
  }
  const root = path.win32.join(env.LOCALAPPDATA, 'Equinox Local');
  const release = installation.releaseDir;
  const version = path.win32.basename(release);
  if (!VERSION.test(version) || !sameWin(root, installation.installRoot) ||
      !sameWin(transactionRoot, path.win32.join(root, 'state', 'main-update')) ||
      !sameWin(release, path.win32.join(root, 'releases', version)) ||
      !sameWin(workerNodePath, path.win32.join(release, 'runtime', 'node', 'bin', 'node.exe'))) {
    throw new Error('Independent Windows Guardian release, transaction or detached Node is outside its fixed installed owner.');
  }
  const live = path.win32.join(root, 'runtime', 'guardian', 'EquinoxLocalGuardian.exe');
  const reference = path.win32.join(release, 'runtime', 'guardian', 'EquinoxLocalGuardian.exe');
  const [liveHash, sourceHash] = await Promise.all([
    exactOwnedGuardianDigest(live, fsImpl), exactOwnedGuardianDigest(reference, fsImpl),
  ]);
  if (!timingSafeEqual(liveHash, sourceHash)) {
    throw new Error('Installed independent Guardian differs from product-owned Stable release bytes.');
  }
  // Deliberately do NOT pass detached worker HMAC, Node/Git/DOTNET overrides,
  // or arbitrary environment into Guardian. Kernel process ownership and the
  // Guardian's own Known Folder fixed-path checks are the authority.
  const childEnv = {};
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
    if (typeof env[key] === 'string' && env[key]) childEnv[key] = env[key];
  }
  const child = spawnImpl(live, [FIXED_COMMAND], {
    cwd: path.win32.dirname(live), shell: false, windowsHide: true,
    windowsVerbatimArguments: false, detached: false, stdio: 'ignore', env: childEnv,
  });
  // spawn() can report errors asynchronously (Windows AV or ACL denial).
  // Avoid an uncaught event that would take down the original Main worker;
  // the live native OS-owner admission still must fail independently.
  child?.on?.('error', () => {});
  if (!Number.isSafeInteger(child?.pid) || child.pid < 1) {
    child?.kill?.();
    throw new Error('Independent Windows Guardian did not yield a live OS process ID.');
  }
  child.unref?.();
  // Child PID is diagnostic ONLY. Actual native process ownership and lease
  // are proven by Guardian's kernel checks; never derive swap permission here.
  return Object.freeze({ transactionId, guardianPid: child.pid, launched: true });
}
