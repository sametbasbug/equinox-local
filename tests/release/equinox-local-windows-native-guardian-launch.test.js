import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { launchEquinoxLocalWindowsNativeMainGuardian } from '../../src/equinox-local-windows-native-guardian-launch.js';

const root = 'C:\\Users\\CI\\AppData\\Local\\Equinox Local';
const release = path.win32.join(root, 'releases', '6.0.4');
const guardian = path.win32.join(root, 'runtime', 'guardian', 'EquinoxLocalGuardian.exe');
const source = path.win32.join(release, 'runtime', 'guardian', 'EquinoxLocalGuardian.exe');
const tx = path.win32.join(root, 'state', 'main-update');
const shaA = 'a'.repeat(40);
const shaB = 'b'.repeat(40);
const token = 'c'.repeat(64);
const bin = Buffer.alloc(4096, 0x41);

function fixture() {
  const files = new Map([[guardian.toLowerCase(), bin], [source.toLowerCase(), bin]]);
  const spawnCalls = [];
  const fakeFs = {
    open: async (file) => {
      const bytes = files.get(file.toLowerCase());
      if (!bytes) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      return {
        stat: async () => ({ isFile: () => true, size: bytes.length, ino: 40, dev: 2 }),
        readFile: async () => Buffer.from(bytes), close: async () => {},
      };
    },
    lstat: async (file) => {
      const bytes = files.get(file.toLowerCase());
      if (!bytes) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      return { isFile: () => true, isSymbolicLink: () => false, size: bytes.length, ino: 40, dev: 2 };
    },
  };
  const spawnImpl = (file, args, options) => {
    spawnCalls.push({ file, args, options });
    return { pid: 50123, unref: () => {}, kill: () => {} };
  };
  const options = {
    transactionId: `main-${'e'.repeat(32)}`, transactionRoot: tx,
    currentSha: shaA, targetSha: shaB, workerToken: token,
    workerNodePath: path.win32.join(release, 'runtime', 'node', 'bin', 'node.exe'),
    installation: { managed: true, selfUpdateSupported: true, target: 'win32-x64',
      installRoot: root, releaseDir: release },
    platform: 'win32', env: {
      LOCALAPPDATA: path.win32.dirname(root), SystemRoot: 'C:\\Windows',
      EQUINOX_LOCAL_MAIN_WORKER_TOKEN: token, NODE_OPTIONS: '--require evil.js',
      DOTNET_ROOT: 'C:\\evil', PATH: 'C:\\evil',
    },
    fsImpl: fakeFs, spawnImpl,
  };
  return { files, spawnCalls, options, fakeFs };
}

test('launch only fixed installed release-identical native Guardian without leaking worker token or runtime overrides', async () => {
  const fixtureValue = fixture();
  const result = await launchEquinoxLocalWindowsNativeMainGuardian(fixtureValue.options);
  assert.deepEqual(result, { transactionId: fixtureValue.options.transactionId, guardianPid: 50123, launched: true });
  assert.equal(fixtureValue.spawnCalls.length, 1);
  const [call] = fixtureValue.spawnCalls;
  assert.equal(call.file, guardian);
  assert.deepEqual(call.args, ['--hold-native-integrated-ab']);
  assert.equal(call.options.cwd, path.win32.dirname(guardian));
  assert.equal(call.options.shell, false);
  assert.equal(call.options.detached, false);
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.stdio, 'ignore');
  assert.deepEqual(call.options.env, { SystemRoot: 'C:\\Windows' });
  assert.ok(!JSON.stringify(call).includes(token));
});

test('deny foreign installed Guardian bytes and link-substituted Guardian executable before spawn', async () => {
  const f = fixture();
  f.files.set(guardian.toLowerCase(), Buffer.alloc(4096, 0x55));
  await assert.rejects(launchEquinoxLocalWindowsNativeMainGuardian(f.options), /differs from product-owned/u);
  assert.equal(f.spawnCalls.length, 0);
  f.files.set(guardian.toLowerCase(), bin);
  const unsafeFs = { ...f.fakeFs, lstat: async (file) => ({ ...(await f.fakeFs.lstat(file)), isSymbolicLink: () => true }) };
  await assert.rejects(launchEquinoxLocalWindowsNativeMainGuardian({ ...f.options, fsImpl: unsafeFs }), /normal owned executable/u);
  assert.equal(f.spawnCalls.length, 0);
});

test('deny foreign transaction, release, worker executable, token and unsupported CPU without spawn', async () => {
  const f = fixture();
  for (const patch of [
    { transactionRoot: path.win32.join(root, 'state', 'other') },
    { transactionRoot: path.win32.join(root, 'state', 'main-update', '..') },
    { workerNodePath: 'C:\\Program Files\\nodejs\\node.exe' },
    { workerToken: '' },
    { targetSha: shaA },
    { installation: { ...f.options.installation, releaseDir: 'C:\\evil\\6.0.4' } },
    { installation: { ...f.options.installation, target: 'win32-ia32' } },
    { platform: 'darwin' },
  ]) {
    await assert.rejects(launchEquinoxLocalWindowsNativeMainGuardian({ ...f.options, ...patch }));
  }
  assert.equal(f.spawnCalls.length, 0);
});

test('deny launch without OS PID even when fixed Guardian bytes are identical', async () => {
  const f = fixture();
  let killed = false;
  await assert.rejects(launchEquinoxLocalWindowsNativeMainGuardian({ ...f.options,
    spawnImpl: () => ({ pid: undefined, kill: () => { killed = true; } }),
  }), /live OS process ID/u);
  assert.equal(killed, true);
});
