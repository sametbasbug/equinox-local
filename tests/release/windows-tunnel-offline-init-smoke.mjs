#!/usr/bin/env node
// Offline acceptance of actual Windows tunnel-client and product CLI contract.
// No real credentials, tunnel ID or control-plane requests are used.
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const [, , sourceRoot, installedReleaseDir] = process.argv;
if (process.platform !== 'win32' || !path.win32.isAbsolute(sourceRoot || '') ||
    !path.win32.isAbsolute(installedReleaseDir || '')) {
  throw new Error('Offline Windows tunnel init requires absolute source and release roots.');
}
const mod = pathToFileURL(path.win32.join(sourceRoot, 'src', 'equinox-local-windows-runtime-supervisor.js'));
const { windowsTunnelInitArguments } = await import(mod.href);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'Equinox tunnel init acceptance '));
try {
  const profileDir = path.join(root, 'profile');
  await fs.mkdir(profileDir);
  const fakeKeyRef = path.join(root, 'not-a-real-key-ref');
  await fs.writeFile(fakeKeyRef, 'THIS_IS_A_TEST_REFERENCE_ONLY', { flag: 'wx' });
  const tunnel = path.join(installedReleaseDir, 'runtime', 'tunnel', 'tunnel-client.exe');
  const node = path.join(installedReleaseDir, 'runtime', 'node', 'bin', 'node.exe');
  const server = path.join(installedReleaseDir, 'server.js');
  const args = windowsTunnelInitArguments({
    paths: { profileDir, runtimeKeyPath: fakeKeyRef }, nodePath: node, serverPath: server,
    tunnelId: 'tunnel_00000000000000000000000000000000',
  });
  await execFile(tunnel, args, {
    cwd: installedReleaseDir,
    env: { ...process.env, CONTROL_PLANE_API_KEY: '', OPENAI_API_KEY: '' },
    timeout: 15_000, maxBuffer: 32 * 1024, windowsHide: true,
  });
  const profileFiles = (await fs.readdir(profileDir)).filter(name => /\.ya?ml$/iu.test(name));
  assert.ok(profileFiles.length > 0, 'Real tunnel-client did not create offline YAML profile');
  process.stdout.write('Windows bundled tunnel-client offline profile initialization passed.\n');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
