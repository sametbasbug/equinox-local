import assert from 'node:assert/strict';
import test from 'node:test';
import { probeWindowsTerminalExecution } from '../../src/equinox-local-windows-terminal-health.js';

function fixture({ exitCode = 17, running = false, stdout = 'EQUINOX_TERMINAL_PROBE_OK\n' } = {}) {
  const calls = [];
  const manager = {
    async start(input) { calls.push(['start', input]); return { processId: 'proc-probe' }; },
    async waitForExit(input) { calls.push(['wait', input]); return { running, exitCode }; },
    snapshotOutput(input) { calls.push(['output', input]); return { stdout }; },
    async stop(input) { calls.push(['stop', input]); },
  };
  return { calls, manager };
}
const env = { SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows\\System32' };

test('on-demand Windows Doctor tests the same finite PowerShell and preserves ownership cleanup', async () => {
  const { calls, manager } = fixture();
  assert.equal((await probeWindowsTerminalExecution({ processManager: manager, cwd: 'C:\\Temp', env, arch: 'x64' })).healthy, true);
  const shell = calls[0][1];
  assert.equal(shell.purpose, 'terminal_exec');
  assert.equal(shell.command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(shell.args.at(-2), '-EncodedCommand');
  assert.equal(Buffer.from(shell.args.at(-1), 'base64').toString('utf16le'), "$ProgressPreference = 'SilentlyContinue'; Write-Output 'EQUINOX_TERMINAL_PROBE_OK'; exit 17");
  assert.equal(calls[1][1].waitMs, 6_000);
  assert.deepEqual(calls.at(-1), ['stop', { processId: 'proc-probe', force: true, timeoutMs: 700, remove: true }]);
});

test('Windows terminal Doctor fails closed for lost stdout, wrong exit status, or timeout', async () => {
  for (const spec of [{ stdout: '' }, { exitCode: 0 }, { running: true }]) {
    const { calls, manager } = fixture(spec);
    assert.equal((await probeWindowsTerminalExecution({ processManager: manager, cwd: 'C:\\Temp', env, arch: 'arm64' })).healthy, false);
    assert.equal(calls.at(-1)[0], 'stop');
  }
});
