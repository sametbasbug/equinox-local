import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("Windows owned-process gate never echoes .NET async completion objects or PowerShell progress", async () => {
  const source = await fs.readFile(new URL("../../src/equinox-local-windows-process-gate.ps1", import.meta.url), "utf8");
  assert.match(source, /\$ProgressPreference = 'SilentlyContinue'/u);
  assert.match(source, /\$isBatch = \$extension -eq '\.cmd' -or \$extension -eq '\.bat'/u);
  assert.match(source, /\[Environment\]::SystemDirectory, 'cmd\.exe'/u);
  assert.match(source, /\/d \/v:off \/s \/c/u);
  assert.match(source, /Windows batch argument contains unsupported CMD expansion/u);
  assert.doesNotMatch(source, /& \$command @arguments/u);
  assert.match(source, /\$startInfo.CreateNoWindow = \$true/u);
  assert.match(source, /\$startInfo.WindowStyle = \[System.Diagnostics.ProcessWindowStyle\]::Hidden/u);
  assert.match(source, /\[void\]\$stdoutTask\.GetAwaiter\(\)\.GetResult\(\)/u);
  assert.match(source, /\[void\]\$stderrTask\.GetAwaiter\(\)\.GetResult\(\)/u);
});

test("Windows PTY gate reuses its hidden ConPTY shell with no nested native invocation", async () => {
  const source = await fs.readFile(new URL("../../src/equinox-local-windows-pty-gate.ps1", import.meta.url), "utf8");
  assert.match(source, /Unsupported Windows PTY shell flags/u);
  assert.match(source, /PowerShell 7 was requested but the interactive host is Windows PowerShell 5\.1/u);
  assert.match(source, /\$PSVersionTable\.PSVersion\.Major -lt 7/u);
  assert.match(source, /\[Console\]::Out.WriteLine\(\$readyMarker\)/u);
  assert.doesNotMatch(source, /& \$command @arguments/u);
  assert.doesNotMatch(source, /\$null -eq \$LASTEXITCODE/u);
});
