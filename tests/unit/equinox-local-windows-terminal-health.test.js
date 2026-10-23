import assert from 'node:assert/strict';
import test from 'node:test';
import { probeWindowsTerminalExecution } from '../../src/equinox-local-windows-terminal-health.js';

function fixture({ exitCode = 17, running = false, stdout = 'EQUINOX_TERMINAL_PROBE_OK\nEQUINOX_NATIVE_PROBE_OK\n' } = {}) {
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
  const decoded = Buffer.from(shell.args.at(-1), 'base64').toString('utf16le');
  assert.match(decoded, /EQUINOX_TERMINAL_PROBE_OK/u);
  assert.match(decoded, /& \$env:ComSpec \/d \/c/u);
  assert.match(decoded, /\$LASTEXITCODE -ne 23/u);
  assert.match(decoded, /exit 17/u);
  assert.equal(calls[1][1].waitMs, 6_000);
  assert.deepEqual(calls.at(-1), ['stop', { processId: 'proc-probe', force: true, timeoutMs: 700, remove: true }]);
});

test('Windows terminal Doctor fails closed for lost stdout, wrong exit status, or timeout', async () => {
  for (const spec of [{ stdout: '' }, { stdout: 'EQUINOX_TERMINAL_PROBE_OK\n' }, { exitCode: 0 }, { running: true }]) {
    const { calls, manager } = fixture(spec);
    assert.equal((await probeWindowsTerminalExecution({ processManager: manager, cwd: 'C:\\Temp', env, arch: 'arm64' })).healthy, false);
    assert.equal(calls.at(-1)[0], 'stop');
  }
});

test("Windows terminal Doctor denies a missing process identity before waiting or cleaning unrelated jobs", async () => {
  for (const processId of [null, "", undefined, 0]) {
    const events = [];
    const manager = {
      start: async () => {events.push("start");return {processId}},
      waitForExit: async () => {events.push("wait");return {running:false,exitCode:17}},
      snapshotOutput: () => {events.push("output");return {stdout:"EQUINOX_TERMINAL_PROBE_OK\nEQUINOX_NATIVE_PROBE_OK\n"}},
      stop: async () => {events.push("stop")},
    };
    assert.deepEqual(await probeWindowsTerminalExecution({processManager:manager,cwd:"C:\\Temp",env,arch:"x64"}),{healthy:false});
    assert.deepEqual(events,["start"]);
  }
});

test("Windows terminal Doctor refuses false health if owned cleanup fails", async () => {
  const {calls,manager}=fixture();
  manager.stop=async input => {calls.push(["stop-failed",input]);throw Error("native job still running")};
  assert.deepEqual(await probeWindowsTerminalExecution({processManager:manager,cwd:"C:\\Temp",env,arch:"arm64"}),{healthy:false});
  assert.deepEqual(calls.at(-1),["stop-failed",{processId:"proc-probe",force:true,timeoutMs:700,remove:true}]);
});

test("Windows Doctor cleans its owned process when wait or output throws", async () => {
  for(const phase of ["wait","output"]){
    const {calls,manager}=fixture();
    manager[phase==="wait"?"waitForExit":"snapshotOutput"]=input=>{
      calls.push([phase+"-failed",input]);throw Error("broker interrupted");
    };
    const result=await probeWindowsTerminalExecution({processManager:manager,cwd:"C:\\Temp",env,arch:"x64"});
    assert.deepEqual(result,{healthy:false});
    assert.deepEqual(calls.at(-1),["stop",{processId:"proc-probe",force:true,timeoutMs:700,remove:true}]);
  }
});
