import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// TypeScript 7 ships the native tsc executable, not the legacy JS compiler API.
// Compile into an isolated scratch directory; never mutate the shipped MV3 JS
// while verifying byte-exact classic-script output.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'equinox-browser-ts-'));
try {
  // Execute the platform-neutral TypeScript 7 CLI through Node: on Windows,
  // node_modules/.bin/tsc is a .cmd shim and cannot be spawned like Unix tsc.
  const result = spawnSync(process.execPath, [
    path.join(root, 'node_modules/typescript/lib/tsc.js'),
    '--project', path.join(root, 'tsconfig.browser-extension.json'),
    '--outDir', scratch,
    '--pretty', 'false',
  ], { cwd: root, encoding: 'utf8', timeout: 120_000 });
  if (result.error || result.status !== 0) {
    throw new Error(`Browser TS compile failed: ${result.error?.message ?? result.stderr ?? result.stdout ?? result.status}`);
  }
  const expectedNames = ['bookmarks.js', 'chatgpt-continuation-state.js', 'popup.js'];
  assert.deepEqual(readdirSync(scratch).sort(), expectedNames, 'Unexpected emitted Browser artifacts.');
  for (const name of expectedNames) {
    assert.equal(readFileSync(path.join(scratch, name), 'utf8'),
      readFileSync(path.join(root, 'extension', name), 'utf8'),
      `Stale Browser output: npm run build:typed-browser (${name})`);
  }
  console.log(`Verified ${expectedNames.length} byte-exact classic Browser TypeScript JS artifacts.`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
