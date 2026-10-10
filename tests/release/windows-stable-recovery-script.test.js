import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

const script = await fs.readFile(new URL('../../scripts/diagnostics/recover-windows-stable-install.ps1', import.meta.url), 'utf8');

test('Windows recovery is an explicit per-user quarantine, not blanket deletion', () => {
  assert.match(script, /param\(\[switch\]\$Reset\)/u);
  assert.match(script, /if \(-not \$Reset\).*return/u);
  assert.match(script, /EquinoxLocalManagedInstall/u);
  assert.match(script, /UninstallString/u);
  assert.match(script, /Chrome Native Messaging launcher is foreign/u);
  assert.match(script, /Windows startup entry belongs to another command/u);
  assert.match(script, /Start Menu shortcut has foreign ownership/u);
  assert.match(script, /an EquinoxLocal process belongs to another installation/u);
  assert.match(script, /Rename-Item -LiteralPath \$programRoot/u);
  assert.match(script, /Rename-Item -LiteralPath \$root/u);
  assert.doesNotMatch(script, /Stop-Process\s+-Name\s+node|Remove-Item\s+-LiteralPath\s+\$root|Remove-Item\s+-LiteralPath\s+\$programRoot/u);
  assert.doesNotMatch(script, /Invoke-Expression|iex\b|ExecutionPolicy\s+Unrestricted/iu);
});

test('Windows PowerShell parses the recovery script without executing it', { skip: process.platform !== 'win32' }, async () => {
  const location = new URL('../../scripts/diagnostics/recover-windows-stable-install.ps1', import.meta.url);
  const scriptPath = decodeURIComponent(location.pathname).replace(/^\/([A-Za-z]:)/u, '$1');
  const command = `[System.Management.Automation.Language.Parser]::ParseFile($env:EQUINOX_RECOVERY_SCRIPT, [ref]$tokens, [ref]$errors) | Out-Null; if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_ }; exit 1 }`;
  const { stderr } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$tokens = $null; $errors = @(); ' + command], { env: { ...process.env, EQUINOX_RECOVERY_SCRIPT: scriptPath }, timeout: 15000 });
  assert.equal(stderr.trim(), '');
});
