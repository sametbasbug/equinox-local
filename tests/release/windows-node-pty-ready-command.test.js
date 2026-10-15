import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

test('hosted ARM64 ConPTY checks live PowerShell readiness before writing without relaxing child timeout or PTY ownership', async()=>{
  const source=await readFile(new URL('./windows-node-pty-smoke.mjs',import.meta.url),'utf8');
  const observed=source.indexOf('terminal.onData((data) => {');
  const ready=source.indexOf('trace("prompt:ready")');
  const write=source.indexOf("terminal.write('Write-Output");
  assert.ok(observed>=0 && observed<ready && ready<write);
  assert.match(source,/CHILD_TIMEOUT_MS = 20_000/u);
  assert.match(source,/spawnPty\("powershell.exe", \["-NoLogo", "-NoProfile"\]/u);
  assert.match(source,/useConpty: true/u);
  assert.match(source,/\(\?:\^\|\\n\)PS /u);
  assert.match(source,/terminal.onExit\(\(\{ exitCode \}\) =>/u);
  assert.match(source,/terminateChildTree\(child.pid\)/u);
  assert.match(source,/assert.match\(output, \/__EQUINOX_CONPTY_OK__\/u\)/u);
});
