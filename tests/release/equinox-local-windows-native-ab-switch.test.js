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
  assert.equal((await restoreWindowsNativeABSlot(f)).recovered, true, 'A plus quarantined B must be idempotent after a crash.');
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

test('native A/B rejects malformed transaction and unowned path identities before shutdown or writes',async(t)=>{
  const f=await fixture(t);
  let shutdown=0;
  for(const invalid of [
    {transactionId:'main-'+'F'.repeat(32)},
    {transactionId:'main-'+'3'.repeat(32)+'\n'},
    {programRoot:'relative/Equinox Local'},
    {targetReleaseDir:f.previousReleaseDir},
    {previousReleaseDir:f.previousReleaseDir+'/..'},
  ]){
    const unsafe={...f,...invalid};
    await assert.rejects(switchWindowsNativeABSlot(unsafe,{
      requestShutdown:async()=>{shutdown++;},
    }),/Windows immutable native A\/B slot identity is invalid/u);
  }
  assert.equal(shutdown,0);
  assert.equal(await liveExe(f),'verified-A-wpf-binary\n');
  await assert.rejects(fs.lstat(f.backupRoot),{code:'ENOENT'});
});

test('foreign quarantined candidate cannot be silently reused or deleted during rollback',async(t)=>{
  const f=await fixture(t);
  await switchWindowsNativeABSlot(f,{requestShutdown:async()=>{}});
  const foreign=path.join(path.dirname(f.programRoot),'foreign-user-bytes');
  await fs.writeFile(foreign,'user-owned profile');
  await fs.mkdir(f.quarantineRoot);
  await fs.symlink(foreign,path.join(f.quarantineRoot,'credential-link'));
  await assert.rejects(restoreWindowsNativeABSlot(f),/symbolic links or junctions/u);
  assert.equal(await liveExe(f),'verified-B-wpf-binary\n');
  assert.equal(await fs.readFile(path.join(f.backupRoot,'EquinoxLocal.exe'),'utf8'),'verified-A-wpf-binary\n');
  assert.equal(await fs.readFile(foreign,'utf8'),'user-owned profile');
});

test('independent health exception leaves old A backup and B candidate intact',async(t)=>{
  const f=await fixture(t);
  await switchWindowsNativeABSlot(f,{requestShutdown:async()=>{}});
  await assert.rejects(commitWindowsNativeABSlot(f,{verifyBHealth:async()=>{throw Error('B health broker offline')}}),
    /B health broker offline/u);
  assert.equal(await liveExe(f),'verified-B-wpf-binary\n');
  assert.equal(await fs.readFile(path.join(f.backupRoot,'EquinoxLocal.exe'),'utf8'),'verified-A-wpf-binary\n');
  await restoreWindowsNativeABSlot(f);
  await assert.rejects(finalizeWindowsNativeABRollback(f,{verifyAHealth:async()=>{throw Error('A health broker offline')}}),
    /A health broker offline/u);
  assert.equal(await liveExe(f),'verified-A-wpf-binary\n');
  assert.equal(await fs.readFile(path.join(f.quarantineRoot,'EquinoxLocal.exe'),'utf8'),'verified-B-wpf-binary\n');
});

test('B health wait must not delete old A when backup, active B or quarantine changes', async (t) => {
  for (const scenario of ['backup-replaced', 'active-B-mutated', 'foreign-quarantine-arrived']) {
    await t.test(scenario, async (caseT) => {
      const f = await fixture(caseT);
      await switchWindowsNativeABSlot(f, { requestShutdown: async () => {} });
      const retainedA = f.backupRoot + '.retained-original';
      await assert.rejects(commitWindowsNativeABSlot(f, { verifyBHealth: async () => {
        if (scenario === 'backup-replaced') {
          await fs.rename(f.backupRoot, retainedA);
          await fs.cp(path.join(f.targetReleaseDir, 'runtime', 'shell'), f.backupRoot, { recursive: true });
        } else if (scenario === 'active-B-mutated') {
          await fs.writeFile(path.join(f.programRoot, 'coreclr.dll'), 'foreign-content-after-health-start');
        } else {
          await fs.mkdir(f.quarantineRoot);
          await fs.writeFile(path.join(f.quarantineRoot, 'foreign-user-file.txt'), 'keep this');
        }
        return true;
      } }), /slot ownership changed while B health/u);
      const preservedA = scenario === 'backup-replaced' ? retainedA : f.backupRoot;
      assert.equal(await fs.readFile(path.join(preservedA, 'EquinoxLocal.exe'), 'utf8'), 'verified-A-wpf-binary\n');
      if (scenario === 'backup-replaced') {
        assert.equal(await fs.readFile(path.join(f.backupRoot, 'EquinoxLocal.exe'), 'utf8'), 'verified-B-wpf-binary\n');
      }
      if (scenario === 'foreign-quarantine-arrived') {
        assert.equal(await fs.readFile(path.join(f.quarantineRoot, 'foreign-user-file.txt'), 'utf8'), 'keep this');
      }
    });
  }
});

test('A health wait must not delete failed B when quarantine or live A changes', async (t) => {
  for (const scenario of ['quarantine-replaced', 'live-A-mutated', 'foreign-quarantine-arrived']) {
    await t.test(scenario, async (caseT) => {
      const f = await fixture(caseT);
      await switchWindowsNativeABSlot(f, { requestShutdown: async () => {} });
      await restoreWindowsNativeABSlot(f);
      const retainedB = f.quarantineRoot + '.retained-original';
      if (scenario === 'foreign-quarantine-arrived') await fs.rm(f.quarantineRoot, { recursive: true });
      await assert.rejects(finalizeWindowsNativeABRollback(f, { verifyAHealth: async () => {
        if (scenario === 'quarantine-replaced') {
          await fs.rename(f.quarantineRoot, retainedB);
          await fs.cp(path.join(f.previousReleaseDir, 'runtime', 'shell'), f.quarantineRoot, { recursive: true });
        } else if (scenario === 'live-A-mutated') {
          await fs.writeFile(path.join(f.programRoot, 'coreclr.dll'), 'foreign-A-after-health-start');
        } else {
          await fs.mkdir(f.quarantineRoot);
          await fs.writeFile(path.join(f.quarantineRoot, 'foreign-user-file.txt'), 'preserve');
        }
        return true;
      } }), /slot ownership changed while A health/u);
      if (scenario === 'quarantine-replaced') {
        assert.equal(await fs.readFile(path.join(retainedB, 'EquinoxLocal.exe'), 'utf8'), 'verified-B-wpf-binary\n');
      } else if (scenario === 'live-A-mutated') {
        assert.equal(await fs.readFile(path.join(f.quarantineRoot, 'EquinoxLocal.exe'), 'utf8'), 'verified-B-wpf-binary\n');
      } else {
        assert.equal(await fs.readFile(path.join(f.quarantineRoot, 'foreign-user-file.txt'), 'utf8'), 'preserve');
      }
    });
  }
});

test('Windows B→A rollback retries transient file locks on both physical renames', async (t) => {
  const f = await fixture(t);
  await switchWindowsNativeABSlot(f, { requestShutdown: async () => {} });
  const errors = new Map([
    [f.programRoot, ['EPERM', 'EBUSY']],
    [f.backupRoot, ['EACCES', 'EPERM', 'EBUSY']],
  ]);
  const calls = [];
  let waits = 0;
  const fsImpl = { ...fs, rename: async (source, dest) => {
    calls.push([source, dest]);
    const remaining = errors.get(source) ?? [];
    if (remaining.length > 0) throw Object.assign(new Error('transient Windows executable handle lock'), { code: remaining.shift() });
    return fs.rename(source, dest);
  } };
  const restored = await restoreWindowsNativeABSlot(f, {fsImpl, sleepImpl: async (ms) => {
    assert.equal(ms, 100);
    waits++;
  }});
  assert.equal(restored.stage, 'restored');
  assert.equal(waits, 5, 'each transient Windows lock delays only a bounded retry');
  assert.equal(calls.filter(([source]) => source === f.programRoot).length, 3);
  assert.equal(calls.filter(([source]) => source === f.backupRoot).length, 4);
  assert.equal(await liveExe(f), 'verified-A-wpf-binary\n');
  assert.equal(await fs.readFile(path.join(f.quarantineRoot, 'EquinoxLocal.exe'), 'utf8'), 'verified-B-wpf-binary\n');
});

test('persistent Windows B→A rename locks are bounded and preserve recoverable A and B', async (t) => {
  for (const locked of ['B-quarantine', 'A-restore']) {
    await t.test(locked, async (caseT) => {
      const f = await fixture(caseT);
      await switchWindowsNativeABSlot(f, { requestShutdown: async () => {} });
      const lockedSource = locked === 'B-quarantine' ? f.programRoot : f.backupRoot;
      let attempts = 0;
      let waits = 0;
      const fsImpl = { ...fs, rename: async (source, dest) => {
        if (source === lockedSource) {
          attempts++;
          throw Object.assign(new Error('still locked by Windows'), { code: 'EPERM' });
        }
        return fs.rename(source, dest);
      } };
      await assert.rejects(restoreWindowsNativeABSlot(f, {fsImpl, sleepImpl: async (ms) => {
        assert.equal(ms, 100);
        waits++;
      }}), /still locked by Windows/u);
      assert.equal(attempts, 100, 'must not retry forever when Windows refuses file release');
      assert.equal(waits, 99);
      assert.equal(await fs.readFile(path.join(f.backupRoot, 'EquinoxLocal.exe'), 'utf8'), 'verified-A-wpf-binary\n');
      if (locked === 'B-quarantine') {
        assert.equal(await liveExe(f), 'verified-B-wpf-binary\n');
        await assert.rejects(fs.lstat(f.quarantineRoot), {code:'ENOENT'});
      } else {
        await assert.rejects(fs.lstat(f.programRoot), {code:'ENOENT'});
        assert.equal(await fs.readFile(path.join(f.quarantineRoot, 'EquinoxLocal.exe'), 'utf8'), 'verified-B-wpf-binary\n');
      }
      const replay = await restoreWindowsNativeABSlot(f);
      assert.equal(replay.stage, 'restored');
      assert.equal(await liveExe(f), 'verified-A-wpf-binary\n');
    });
  }
});
