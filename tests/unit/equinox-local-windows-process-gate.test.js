import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("Windows owned-process gate never echoes .NET async completion objects or PowerShell progress", async () => {
  const source = await fs.readFile(new URL("../../src/equinox-local-windows-process-gate.ps1", import.meta.url), "utf8");
  assert.match(source, /\$ProgressPreference = 'SilentlyContinue'/u);
  assert.match(source, /\[void\]\$stdoutTask\.GetAwaiter\(\)\.GetResult\(\)/u);
  assert.match(source, /\[void\]\$stderrTask\.GetAwaiter\(\)\.GetResult\(\)/u);
});
