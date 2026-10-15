import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { exactOwnedGuardianDigest } from './equinox-local-windows-native-guardian-launch.js';

const TX = /^main-[a-f0-9]{32}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const COMMAND = '--audit-native-rollback-owner';

/**
 * Supplies the REQUIRED independent OS verifier callback for the strictly
 * read-only rollback_started/5 journal observer. The already-packaged
 * Guardian executable is invoked as a narrow READ-ONLY AUDITOR, not as a
 * second update supervisor, journal writer or A/B slot controller.
 *
 * Windows kernel verifies the ORIGINAL Guardian's named-pipe server PID,
 * live process executable, birth time, SID/logon/session, exclusive lock
 * sharing violation and fresh journal-bound owner HMAC. JSON is not proof.
 */
export function createEquinoxWindowsNativeRollbackOwnerVerifier({
  transactionId, installation, platform = process.platform, env = process.env,
  fsImpl = fs, spawnImpl = spawn,
} = {}) {
  const appdata = env.LOCALAPPDATA;
  const root = typeof appdata === 'string' ? path.win32.join(appdata, 'Equinox Local') : '';
  const live = root && path.win32.join(root, 'runtime', 'guardian', 'EquinoxLocalGuardian.exe');
  const release = installation?.releaseDir;
  const version = typeof release === 'string' ? path.win32.basename(release) : '';
  const stable = release && path.win32.join(release, 'runtime', 'guardian', 'EquinoxLocalGuardian.exe');
  const canonical = (input) => typeof input === 'string' && path.win32.isAbsolute(input) &&
    path.win32.normalize(input) === input && !input.includes('\0');
  const same = (a, b) => canonical(a) && canonical(b) && a.toLowerCase() === b.toLowerCase();

  return async function verifyGuardianOsOwner(owner) {
    if (platform !== 'win32' || !TX.test(transactionId ?? '') ||
        !same(root, installation?.installRoot) || !same(release, path.win32.join(root, 'releases', version)) ||
        !VERSION.test(version) || !canonical(appdata) || !canonical(live) || !canonical(stable) ||
        installation?.managed !== true || installation?.selfUpdateSupported !== true ||
        !['win32-x64', 'win32-arm64'].includes(installation?.target) ||
        owner?.transactionId !== transactionId || owner?.stage !== 'rollback_started' ||
        owner?.requiresWriterLease !== true || !Number.isSafeInteger(owner?.guardianPid) || owner.guardianPid < 1 ||
        !Number.isSafeInteger(owner?.workerPid) || owner.workerPid < 1 ||
        !SHA.test(owner?.journalSha256 ?? '') || !SHA.test(owner?.restartedJournalSha256 ?? '')) {
      return false;
    }
    let liveHash, releaseHash;
    try {
      [liveHash, releaseHash] = await Promise.all([
        exactOwnedGuardianDigest(live, fsImpl), exactOwnedGuardianDigest(stable, fsImpl),
      ]);
    } catch { return false; }
    if (!timingSafeEqual(liveHash, releaseHash)) return false;
    const childEnv = {};
    for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
      if (typeof env[key] === 'string' && env[key]) childEnv[key] = env[key];
    }
    return new Promise((resolve) => {
      let settled = false;
      let child;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok);
      };
      // A read-only bounded verification cannot hold the worker forever.
      const timer = setTimeout(() => { child?.kill?.(); done(false); }, 8000);
      try {
        child = spawnImpl(live, [COMMAND], {
          cwd: path.win32.dirname(live), shell: false, windowsHide: true,
          detached: false, windowsVerbatimArguments: false, stdio: 'ignore', env: childEnv,
        });
        if (!Number.isSafeInteger(child?.pid) || child.pid < 1) { child?.kill?.(); done(false); return; }
        child.once('error', () => done(false));
        child.once('exit', (code, signal) => done(code === 0 && signal === null));
      } catch { child?.kill?.(); done(false); }
    });
  };
}
