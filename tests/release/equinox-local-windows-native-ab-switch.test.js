import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  commitWindowsNativeABSlot,
  finalizeWindowsNativeABRollback,
  restoreWindowsNativeABSlot,
  switchWindowsNativeABSlot,
} from '../../src/equinox-local-windows-native-ab-switch.js';

const TX = `main-${'3'.repeat(32)}`;
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'equinox-native-ab-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const previousReleaseDir = path.join(root, 'releases', 'A');
  const targetReleaseDir = path.join(root, 'releases', 'B');
  const programRoot = path.join(root, 'Programs', 'Equinox Local');
  for (const [release, label] of [[previousReleaseDir, 'A'], [targetReleaseDir, 'B']]) {
    const shell = path.join(release, 'runtime', 'shell');
    await fs.mkdir(shell, { recursive: true });
    await fs.writeFile(path.join(shell, 'EquinoxLocal.exe'), `verified-${label}-wpf-binary\n`);
    await fs.writeFile(path.join(shell, 'coreclr.dll'), `verified-${label}-runtime\n`);
  }
  await fs.mkdir(path.dirname(programRoot), { recursive: true });
  await fs.cp(path.join(previousReleaseDir, 'runtime', 'shell'), programRoot, { recursive: true });
  const options = { transactionId: TX, programRoot, previousReleaseDir, targetReleaseDir };
  return {
    ...options,
    backupRoot: path.join(path.dirname(programRoot), `.equinox-shell-backup-${TX}`),
    quarantineRoot: path.join(path.dirname(programRoot), `.equinox-shell-failed-${TX}`),
  };
}
const liveExe = (f) => fs.readFile(path.join(f.programRoot, 'EquinoxLocal.exe'), 'utf8');

test('Windows A→B physical directory rename retains exact A until verified healthy B commit', async (t) => {
  const f = await fixture(t);
  let shutdowns = 0;
  const switched = await switchWindowsNativeABSlot(f, { requestShutdown: async () => { shutdowns++; } });
  assert.equal(switched.stage, 'switched');
  assert.equal(shutdowns, 1);
  assert.equal(await liveExe(f), 'verified-B-wpf-binary\n');
  assert.equal(await fs.readFile(path.join(f.backupRoot, 'EquinoxLocal.exe'), 'utf8'), 'verified-A-wpf-binary\n');
  const resumed = await switchWindowsNativeABSlot(f, { requestShutdown: async () => { throw Error('must not repeat shutdown'); } });
  assert.equal(resumed.recovered, true);
  await assert.rejects(commitWindowsNativeABSlot(f, { verifyBHealth: async () => false }), /health/u);
  assert.equal(await fs.readFile(path.join(f.backupRoot, 'EquinoxLocal.exe'), 'utf8'), 'verified-A-wpf-binary\n');
  const commit = await commitWindowsNativeABSlot(f, { verifyBHealth: async () => true });
  assert.equal(commit.stage, 'committed');
  await assert.rejects(fs.stat(f.backupRoot), { code: 'ENOENT' });
  assert.equal(await liveExe(f), 'verified-B-wpf-binary\n');
});

test('Windows rejected B→A rollback preserves B quarantine until A health verified', async (t) => {
  const f = await fixture(t);
  await switchWindowsNativeABSlot(f, { requestShutdown: async () => {} });
  const rollback = await restoreWindowsNativeABSlot(f);
  assert.equal(rollback.stage, 'restored');
  assert.equal(await liveExe(f), 'verified-A-wpf-binary\n');
  assert.equal(await fs.readFile(path.join(f.quarantineRoot, 'EquinoxLocal.exe'), 'utf8'), 'verified-B-wpf-binary\n');
  await assert.rejects(finalizeWindowsNativeABRollback(f, { verifyAHealth: async () => false }), /health/u);
  assert.equal(await fs.readFile(path.join(f.quarantineRoot, 'EquinoxLocal.exe'), 'utf8'), 'verified-B-wpf-binary\n');
  const final = await finalizeWindowsNativeABRollback(f, { verifyAHealth: async () => true });
  assert.equal(final.stage, 'rolled_back');
  await assert.rejects(fs.stat(f.quarantineRoot), { code: 'ENOENT' });
});

test('interruption after old A renamed is recovered using deterministic backup, not a random orphan', async (t) => {
  const f = await fixture(t);
  let renameCount = 0;
  const fsImpl = {
    ...fs,
    rename: async (...args) => {
      renameCount++;
      if (renameCount === 2) throw Object.assign(Error('simulated power cut after A moved'), { code: 'EIO' });
      return fs.rename(...args);
    },
  };
  await assert.rejects(switchWindowsNativeABSlot(f, { fsImpl, requestShutdown: async () => {} }), /simulated power cut/u);
  assert.equal(await fs.readFile(path.join(f.backupRoot, 'EquinoxLocal.exe'), 'utf8'), 'verified-A-wpf-binary\n');
  await assert.rejects(fs.stat(f.programRoot), { code: 'ENOENT' });
  const recovered = await switchWindowsNativeABSlot(f, { requestShutdown: async () => {} });
  assert.equal(recovered.recovered, true);
  assert.equal(await liveExe(f), 'verified-B-wpf-binary\n');
  const reverted = await restoreWindowsNativeABSlot(f);
  assert.equal(reverted.stage, 'restored');
  assert.equal(await liveExe(f), 'verified-A-wpf-binary\n');
});

test('interrupted rollback after quarantining B can replay using verified old A', async (t) => {
  const f = await fixture(t);
  await switchWindowsNativeABSlot(f, { requestShutdown: async () => {} });
  const fsImpl = { ...fs, rename: async (source, destination) => {
    if (source === f.backupRoot) throw Object.assign(Error('simulated crash before restore A'), { code: 'EIO' });
    return fs.rename(source, destination);
  } };
  await assert.rejects(restoreWindowsNativeABSlot(f, { fsImpl }), /simulated crash/u);
  await assert.rejects(fs.stat(f.programRoot), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(f.backupRoot, 'EquinoxLocal.exe'), 'utf8'), 'verified-A-wpf-binary\n');
  assert.equal(await fs.readFile(path.join(f.quarantineRoot, 'EquinoxLocal.exe'), 'utf8'), 'verified-B-wpf-binary\n');
  assert.equal((await restoreWindowsNativeABSlot(f)).recovered, true);
  assert.equal(await liveExe(f), 'verified-A-wpf-binary\n');
});

test('foreign tree, symlink backup and premature B commit are fail-closed', async (t) => {
  const f = await fixture(t);
  await assert.rejects(commitWindowsNativeABSlot(f, { verifyBHealth: async () => true }), /recoverable old A/u);
  await fs.writeFile(path.join(f.programRoot, 'coreclr.dll'), 'tampered');
  let touched = false;
  await assert.rejects(switchWindowsNativeABSlot(f, { requestShutdown: async () => { touched = true; } }), /previous release/u);
  assert.equal(touched, false);
  await fs.rm(f.programRoot, { recursive: true, force: true });
  await fs.cp(path.join(f.previousReleaseDir, 'runtime', 'shell'), f.programRoot, { recursive: true });
  await fs.symlink(f.previousReleaseDir, f.backupRoot, 'dir');
  await assert.rejects(switchWindowsNativeABSlot(f, { requestShutdown: async () => {} }), /foreign filesystem entry/u);
});
