import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const ci = await fs.readFile(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
const jobs = new Map([...ci.matchAll(/^  ([\w-]+):\n([\s\S]*?)(?=^  [\w-]+:\n|$(?![\s\S]))/gmu)].map((match) => [match[1], match[2]]));
const arm64Lanes = ["windows-arm64-runtime", "windows-arm64-package", "windows-arm64-winapp", "windows-arm64-installer"];

function job(name) {
  assert.ok(jobs.has(name), `Missing CI job: ${name}`);
  return jobs.get(name);
}

function assertSuccessGate(block, name, dependencies) {
  assert.match(block, /if: \$\{\{ always\(\) \}\}/u);
  const needs = block.match(/^    needs: \[([^\]]+)\]/mu)?.[1].split(",").map((value) => value.trim());
  assert.deepEqual(needs, dependencies, `${name} must wait for every acceptance lane`);
  for (const dependency of dependencies) {
    const variable = block.match(new RegExp(`^          ([A-Z0-9_]+): \\$\\{\\{ needs\\.${dependency}\\.result \\}\\}`, "mu"))?.[1];
    assert.ok(variable, `${name} must inspect ${dependency}`);
    assert.ok(block.includes(`test "$${variable}" = success`), `${name} must reject failed, cancelled or skipped ${dependency}`);
  }
  assert.doesNotMatch(block, /continue-on-error:/u);
}

test("CI retains full PR and main validation without path-based skips", () => {
  assert.match(ci, /^on:\n  push:\n    branches: \[main\]\n  pull_request:\n  workflow_dispatch:/mu);
  assert.match(ci, /^permissions:\n  contents: read/mu);
  assert.doesNotMatch(ci, /pull_request_target:|paths-ignore:|continue-on-error:/u);
  assert.match(job("test"), /run: npm test\n/u);
});

test("native ARM64 runtime and package builds start independently", () => {
  for (const name of arm64Lanes) {
    const block = job(name);
    assert.match(block, /runs-on: windows-11-vs2026-arm/u);
    assert.doesNotMatch(block, /^    if:/mu);
  }
  for (const name of ["windows-arm64-runtime", "windows-arm64-package"]) {
    const block = job(name);
    assert.doesNotMatch(block, /^    needs:/mu);
    assert.match(block, /architecture: arm64/u);
    assert.match(block, /run: npm ci --prefer-offline --no-audit --no-fund/u);
  }
});

test("ARM64 runtime lane retains native lifecycle, PTY and messaging acceptance", () => {
  const block = job("windows-arm64-runtime");
  for (const command of [
    "node --test tests/unit/equinox-local-platform.test.js tests/release/equinox-local-windows-arm64-lifecycle.test.js",
    "npm run smoke:windows-headless",
    "node --test tests/release/equinox-local-windows-lifecycle.test.js",
    "node tests/release/windows-node-pty-smoke.mjs",
    "node tests/release/windows-native-messaging-smoke.mjs",
  ]) assert.ok(block.includes(command), `Missing native acceptance: ${command}`);
  assert.doesNotMatch(block, /package:windows|windows-winapp-smoke|windows-installer-real-package-smoke/u);
});

test("ARM64 package is built once and shared only within the current CI commit and run", () => {
  const block = job("windows-arm64-package");
  assert.equal(arm64Lanes.filter((name) => job(name).includes("npm run local:release:package:windows")).length, 1);
  assert.match(block, /0xAA64/u);
  assert.match(block, /EquinoxLocal\.WindowsShell\.UninstallHandoffHarness/u);
  assert.match(block, /Get-FileHash -LiteralPath \$artifact\.FullName -Algorithm SHA256/u);
  assert.match(block, /actions\/upload-artifact@v7/u);
  assert.match(block, /name: ci-arm64-package-\$\{\{ github\.sha \}\}/u);
  assert.match(block, /if-no-files-found: error/u);
  assert.match(block, /compression-level: 0/u);
  assert.match(block, /retention-days: 1/u);
  assert.match(block, /artifact-sha256: \$\{\{ steps\.package\.outputs\.sha256 \}\}/u);
  assert.match(block, /artifact-bytes: \$\{\{ steps\.package\.outputs\.bytes \}\}/u);
});

test("isolated ARM64 UIA and installer jobs fail closed on a missing or changed package", () => {
  for (const name of ["windows-arm64-winapp", "windows-arm64-installer"]) {
    const block = job(name);
    assert.match(block, /^    needs: windows-arm64-package/mu);
    assert.match(block, /actions\/download-artifact@v8/u);
    assert.match(block, /name: ci-arm64-package-\$\{\{ github\.sha \}\}/u);
    assert.match(block, /EXPECTED_PACKAGE_SHA256: \$\{\{ needs\.windows-arm64-package\.outputs\.artifact-sha256 \}\}/u);
    assert.match(block, /EXPECTED_PACKAGE_BYTES: \$\{\{ needs\.windows-arm64-package\.outputs\.artifact-bytes \}\}/u);
    assert.match(block, /Get-FileHash -LiteralPath \$artifacts\[0\]\.FullName -Algorithm SHA256/u);
    assert.match(block, /\$artifacts\.Count -ne 1/u);
    assert.match(block, /\$sha256 -cne \$env:EXPECTED_PACKAGE_SHA256/u);
    assert.match(block, /\$artifacts\[0\]\.Length -ne \[int64\]\$env:EXPECTED_PACKAGE_BYTES/u);
    assert.doesNotMatch(block, /github-token:|run-id:|repository:|npm ci|setup-node/u);
  }
  assert.match(job("windows-arm64-winapp"), /windows-winapp-smoke\.ps1/u);
  assert.match(job("windows-arm64-winapp"), /-DesktopHelperPath/u);
  assert.match(job("windows-arm64-installer"), /windows-installer-real-package-smoke\.ps1/u);
  assert.match(job("windows-arm64-installer"), /EQUINOX_WINDOWS_INSTALL_ARTIFACT/u);
});

test("stable ARM64 and Windows aggregate checks reject every non-success dependency", () => {
  const foundation = job("windows-arm64-foundation");
  assert.match(foundation, /name: Windows ARM64 foundation \/ Node 26/u);
  assertSuccessGate(foundation, "ARM64 foundation", arm64Lanes);
  assertSuccessGate(job("windows-headless"), "Windows aggregate", [
    "windows-runtime", "windows-shell", "windows-package", "windows-arm64-shared-core", "windows-arm64-bootstrap", "windows-arm64-foundation",
  ]);
});

test("package verification precedes every isolated ARM64 package consumer", () => {
  for (const [name, acceptance] of [
    ["windows-arm64-winapp", "Windows ARM64 packaged winapp UIA smoke"],
    ["windows-arm64-installer", "Windows ARM64 real public-installer fresh-install acceptance"],
  ]) {
    const block = job(name);
    const download = block.indexOf("      - name: Download current-run ARM64 CI package");
    const verify = block.indexOf("      - name: Verify exact ARM64 CI package bytes");
    const consume = block.indexOf(`      - name: ${acceptance}`);
    assert.ok(download >= 0 && verify > download && consume > verify, `${name} must verify before consuming package bytes`);
  }
});

test("native ARM64 acceptance cannot be disabled by step conditions or tolerated failures", () => {
  for (const name of arm64Lanes) {
    assert.doesNotMatch(job(name), /^\s+(?:if|continue-on-error):/mu, `${name} must run its acceptance unconditionally`);
  }
});

test("NuGet cache remains architecture scoped and never skips native build or smoke", () => {
  for (const name of ["windows-arm64-package", "windows-arm64-winapp"]) {
    const block = job(name);
    assert.match(block, /actions\/cache@v6/u);
    assert.match(block, /key: nuget-\$\{\{ runner\.os \}\}-\$\{\{ runner\.arch \}\}-dotnet10-\$\{\{ hashFiles/u);
    assert.doesNotMatch(block, /cache-hit|--no-build|--no-restore/u);
  }
});
