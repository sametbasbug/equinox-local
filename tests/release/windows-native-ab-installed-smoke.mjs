import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  switchWindowsNativeABSlot,
  restoreWindowsNativeABSlot,
  finalizeWindowsNativeABRollback,
  commitWindowsNativeABSlot,
} from '../../src/equinox-local-windows-native-ab-switch.js';
import { snapshotWindowsStableShellTree, sameWindowsStableShellTree } from '../../src/equinox-local-windows-stable-shell.js';

const [releaseDir, target] = process.argv.slice(2);
if (process.platform !== 'win32' || !['win32-x64', 'win32-arm64'].includes(target) || !path.isAbsolute(releaseDir)) {
  throw new Error('Windows native A/B real installed-host smoke requires exact native release and target.');
}
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'equinox-ab-real-')));
const previousReleaseDir = path.join(root, 'releases', 'A');
const targetReleaseDir = path.join(root, 'releases', 'B');
const programRoot = path.join(root, 'Programs', 'Equinox Local');
const transactionId = `main-${'c'.repeat(32)}`;
const options = { transactionId, previousReleaseDir, targetReleaseDir, programRoot };
const sourceShell = path.join(releaseDir, 'runtime', 'shell');
const readInstalled = () => snapshotWindowsStableShellTree(programRoot);
try {
  for (const rootRelease of [previousReleaseDir, targetReleaseDir]) {
    await fs.mkdir(path.dirname(path.join(rootRelease, 'runtime', 'shell')), { recursive: true });
    await fs.cp(sourceShell, path.join(rootRelease, 'runtime', 'shell'), { recursive: true, force: false, errorOnExist: true, dereference: false });
  }
  // Force distinct native slot digests while keeping the actual verified WPF
  // PE/runtime files unchanged. Both trees still contain the release's native
  // architecture-specific executable and dependencies, not synthetic stubs.
  await fs.writeFile(path.join(targetReleaseDir, 'runtime', 'shell', 'equinox-test-main-b.txt'), `${target}\n`);
  await fs.mkdir(path.dirname(programRoot), { recursive: true });
  await fs.cp(path.join(previousReleaseDir, 'runtime', 'shell'), programRoot, { recursive: true });
  const originalA = await readInstalled();
  const aRef = await snapshotWindowsStableShellTree(path.join(previousReleaseDir, 'runtime', 'shell'));
  const bRef = await snapshotWindowsStableShellTree(path.join(targetReleaseDir, 'runtime', 'shell'));
  assert.ok(sameWindowsStableShellTree(originalA, aRef));
  assert.ok(!sameWindowsStableShellTree(originalA, bRef));
  const result = await switchWindowsNativeABSlot(options, { requestShutdown: async () => {} });
  assert.equal(result.stage, 'switched');
  assert.ok(sameWindowsStableShellTree(await readInstalled(), bRef));
  await assert.rejects(commitWindowsNativeABSlot(options, { verifyBHealth: async () => false }), /health/u);
  assert.ok(sameWindowsStableShellTree(await snapshotWindowsStableShellTree(result.backupRoot), aRef));
  const rollback = await restoreWindowsNativeABSlot(options);
  assert.equal(rollback.stage, 'restored');
  assert.ok(sameWindowsStableShellTree(await readInstalled(), aRef));
  await assert.rejects(finalizeWindowsNativeABRollback(options, { verifyAHealth: async () => false }), /health/u);
  await finalizeWindowsNativeABRollback(options, { verifyAHealth: async () => true });
  assert.ok(sameWindowsStableShellTree(await readInstalled(), aRef));
  const second = await switchWindowsNativeABSlot(options, { requestShutdown: async () => {} });
  assert.equal(second.stage, 'switched');
  await commitWindowsNativeABSlot(options, { verifyBHealth: async () => true });
  assert.ok(sameWindowsStableShellTree(await readInstalled(), bRef));
  console.log(`Windows ${target} real-native-PE immutable A→B / failed B→A / healthy B commit VERIFIED`);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
