import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const ci = await fs.readFile(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
const prepare = await fs.readFile(new URL("../../.github/actions/prepare-arm64-package/action.yml", import.meta.url), "utf8").catch((error) => {
  if (error.code !== "ENOENT") throw error;
  return "";
});
const inputs = await fs.readFile(new URL("../../.github/actions/prepare-arm64-package/prepare-inputs.ps1", import.meta.url), "utf8").catch((error) => {
  if (error.code !== "ENOENT") throw error;
  return "";
});
const jobs = new Map([...ci.matchAll(/^  ([\w-]+):\n([\s\S]*?)(?=^  [\w-]+:\n|$(?![\s\S]))/gmu)].map((match) => [match[1], match[2]]));
const arm64Lanes = ["windows-arm64-runtime", "windows-arm64-package", "windows-arm64-installer"];

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

test("CI retains full product validation while skipping only the explicit docs-only allowlist", () => {
  assert.match(ci, /^on:\n  push:\n    branches: \[main\]\n    paths-ignore:/mu);
  assert.match(ci, /  pull_request:\n    paths-ignore:/u);
  assert.match(ci, /  workflow_dispatch:/u);
  assert.match(ci, /^permissions:\n  contents: read/mu);
  assert.doesNotMatch(ci, /pull_request_target:|continue-on-error:/u);
  assert.match(ci, /- 'docs\/\*\*'/u);
  assert.doesNotMatch(ci, /- 'THIRD_PARTY_NOTICES\.md'/u);
  assert.match(job("test"), /name: macOS ARM64 \/ Node 26/u);
  assert.match(job("test"), /darwin-arm64/u);
  assert.match(job("test"), /parallel:[\s\S]*run: npm test\n/u);
  const managedSource = job("macos-managed-source");
  assert.match(managedSource, /name: macOS ARM64 managed-source fresh install/u);
  assert.match(managedSource, /runs-on: macos-latest/u);
  assert.match(managedSource, /npm run local:release:package/u);
  assert.match(managedSource, /node tests\/release\/smoke-managed-install\.mjs/u);
  assert.doesNotMatch(managedSource, /^    (?:needs|if):/mu);
  assert.match(job("macos-x64"), /name: macOS x64 \/ Node 26/u);
  assert.match(job("macos-x64"), /runs-on: macos-15-intel/u);
  assert.match(job("macos-x64"), /architecture: x64/u);
  assert.match(job("macos-x64"), /darwin-x64/u);
  assert.match(job("macos-x64"), /parallel:[\s\S]*run: npm run test:fast\n/u);
  assert.doesNotMatch(job("macos-x64"), /run: npm test\n/u);
});

test("ARM64 package is built once on fast x64 Windows and exact-byte native consumers fan out in parallel", () => {
  const producer = job("windows-arm64-package-build");
  assert.match(producer, /runs-on: windows-latest/u);
  assert.doesNotMatch(producer, /^    (?:needs|if):/mu);
  assert.match(producer, /uses: \.\/\.github\/actions\/prepare-arm64-package/u);
  assert.match(producer, /actions\/upload-artifact@v7/u);
  assert.match(producer, /compression-level: 0/u);
  assert.match(producer, /Get-ChildItem backups\/local-packages -Filter 'equinox-local-\*-win32-arm64\.zip'/u);
  assert.doesNotMatch(producer, /Get-ChildItem \(Join-Path \$env:RUNNER_TEMP 'arm64-package'\)/u);
  for (const name of ["windows-arm64-package", "windows-arm64-installer"]) {
    const block = job(name);
    assert.match(block, /runs-on: windows-11-vs2026-arm/u);
    assert.match(block, /^    needs: \[windows-arm64-package-build\]/mu);
    assert.match(block, /actions\/download-artifact@v7/u);
    assert.match(block, /path: \$\{\{ runner\.temp \}\}\/arm64-package/u);
    assert.match(block, /Join-Path \$env:RUNNER_TEMP 'arm64-package'/u);
    assert.doesNotMatch(block, /uses: \.\/\.github\/actions\/prepare-arm64-package/u);
  }
  assert.doesNotMatch(job("windows-arm64-runtime"), /^    (?:needs|if):/mu);
});

test("ARM64 installer has a tighter bound after duplicate package construction is removed", () => {
  assert.match(job("windows-arm64-installer"), /timeout-minutes: 7/u);
});

test("ARM64 runtime retains native lifecycle, PTY and messaging acceptance", () => {
  const block = job("windows-arm64-runtime");
  assert.match(block, /architecture: arm64/u);
  assert.match(block, /run: npm ci --prefer-offline --no-audit --no-fund/u);
  for (const command of [
    "node --test tests/unit/equinox-local-platform.test.js tests/release/equinox-local-windows-arm64-lifecycle.test.js",
    "npm run smoke:windows-headless",
    "node --test tests/release/equinox-local-windows-lifecycle.test.js",
    "node tests/release/windows-node-pty-smoke.mjs",
    "node tests/release/windows-native-messaging-smoke.mjs",
  ]) assert.ok(block.includes(command), `Missing native acceptance: ${command}`);
});

test("Main snapshot publication waits for real macOS managed-source fresh-install acceptance", () => {
  const publish = job("main-snapshot-publish");
  assert.match(publish, /needs: \[test, macos-managed-source, macos-x64, windows-headless, main-native-plan, main-native-build, main-native-result\]/u);
  assert.match(publish, /needs\.macos-managed-source\.result == 'success'/u);
});

test("real public installer enters managed-source on native Windows x64 and ARM64", async () => {
  const smoke = await fs.readFile(new URL("./windows-installer-real-package-smoke.ps1", import.meta.url), "utf8");
  const x64 = job("windows-x64-installer");
  const arm64 = job("windows-arm64-installer");
  assert.match(x64, /name: Windows x64 public installer acceptance/u);
  assert.match(x64, /runs-on: windows-latest/u);
  assert.match(x64, /win-x64/u);
  assert.match(x64, /windows-installer-real-package-smoke\.ps1/u);
  assert.match(arm64, /windows-installer-real-package-smoke\.ps1/u);
  assert.match(smoke, /installation\.kind -ceq 'managed-source'/u);
  assert.match(smoke, /installation\.sourceSha -ceq \$FixtureSourceSha/u);
  assert.match(smoke, /EQUINOX_WINDOWS_INSTALL_SOURCE_SHA/u);
  assert.match(smoke, /EQUINOX_WINDOWS_INSTALL_SHA256/u);
  assert.match(smoke, /New-Item -ItemType HardLink/u);
  assert.match(smoke, /runtime\\toolchain\\git\\2\.53\.0-4/u);
  assert.match(smoke, /runtime\\toolchain\\node\\26\.10\.0/u);
});

test("managed-source runtime acceptance runs on real Windows x64 and ARM64 hosts", () => {
  const x64 = job("windows-shell");
  const arm64 = job("windows-arm64-package");
  assert.match(x64, /Windows x64 managed-source runtime acceptance/u);
  assert.match(x64, /EquinoxLocal\.WindowsShell\.ManagedSourceHarness/u);
  assert.match(x64, /-p:Platform=x64/u);
  assert.match(arm64, /Windows ARM64 stateful shell lifecycle acceptance/u);
  assert.match(arm64, /EquinoxLocal\.WindowsShell\.ManagedSourceHarness/u);
  assert.match(arm64, /-p:Platform=ARM64/u);
});

test("one maintained ARM64 package producer exposes exact artifact identity", () => {
  const producer = job("windows-arm64-package-build");
  assert.match(producer, /id: package\n\s+uses: \.\/\.github\/actions\/prepare-arm64-package/u);
  assert.match(prepare, /using: composite/u);
  assert.match(prepare, /architecture: x64/u);
  assert.match(prepare, /process\.platform/u);
  assert.match(prepare, /process\.arch/u);
  assert.match(prepare, /v26\.10\.0/u);
  assert.match(inputs, /ci --prefer-offline --no-audit --no-fund/u);
  assert.match(prepare, /npm run local:release:package:windows/u);
  assert.match(prepare, /0xAA64/u);
  assert.match(prepare, /release\/runtime\/winapp\/LICENSE/u);
  assert.match(prepare, /metadata\.target -ne 'win32-arm64'/u);
  for (const output of ["sha256", "bytes", "version", "target", "source_sha"]) {
    assert.ok(producer.includes("      " + output + ": ${{ steps.package.outputs." + output + " }}"), `producer must expose ${output}`);
  }
});

test("ARM64 artifact consumers verify producer identity before acceptance", () => {
  const packageLane = job("windows-arm64-package");
  const installer = job("windows-arm64-installer");
  assert.match(packageLane, /EXPECTED_PACKAGE_SHA256: \$\{\{ needs\.windows-arm64-package-build\.outputs\.sha256 \}\}/u);
  assert.match(packageLane, /Get-FileHash -LiteralPath \$artifacts\[0\]\.FullName -Algorithm SHA256/u);
  assert.ok(packageLane.indexOf("EquinoxLocal.WindowsShell.UninstallHandoffHarness") < packageLane.indexOf("EquinoxLocal.WindowsShell.ManagedSourceHarness"));
  assert.match(packageLane, /parallel:[\s\S]*Windows ARM64 stateful shell lifecycle acceptance[\s\S]*EquinoxLocal\.WindowsShell\.UninstallHandoffHarness[\s\S]*EquinoxLocal\.WindowsShell\.ManagedSourceHarness[\s\S]*Windows ARM64 packaged winapp UIA smoke/u);
  assert.match(installer, /EQUINOX_WINDOWS_INSTALL_SHA256: \$\{\{ needs\.windows-arm64-package-build\.outputs\.sha256 \}\}/u);
  assert.match(installer, /EQUINOX_WINDOWS_INSTALL_SOURCE_SHA: \$\{\{ needs\.windows-arm64-package-build\.outputs\.source_sha \}\}/u);
  assert.match(installer, /Get-FileHash -LiteralPath \$artifact\.FullName -Algorithm SHA256/u);
  assert.match(installer, /EQUINOX_WINDOWS_INSTALL_ARTIFACT/u);
  assert.match(prepare, /source_sha:\n\s+description:[^\n]+\n\s+value: \$\{\{ steps\.package\.outputs\.source_sha \}\}/u);
});

test("stable ARM64 and Windows aggregate checks reject every non-success dependency", () => {
  const foundation = job("windows-arm64-foundation");
  assert.match(foundation, /name: Windows ARM64 foundation \/ Node 26/u);
  assertSuccessGate(foundation, "ARM64 foundation", arm64Lanes);
  assertSuccessGate(job("windows-headless"), "Windows aggregate", [
    "windows-runtime", "windows-shell", "windows-package", "windows-x64-installer", "windows-arm64-shared-core", "windows-arm64-bootstrap", "windows-arm64-foundation",
  ]);
});

test("native ARM64 acceptance and preparation cannot tolerate failures or be skipped", () => {
  for (const block of [...arm64Lanes.map(job), prepare]) {
    assert.doesNotMatch(block, /^\s+(?:if|continue-on-error):/mu);
    assert.doesNotMatch(block, /--no-build|--no-restore/u);
  }
});

test("NuGet cache is architecture scoped and preserves native build execution", () => {
  assert.match(prepare, /actions\/cache@v6/u);
  assert.match(prepare, /key: nuget-\$\{\{ runner\.os \}\}-target-arm64-dotnet10-\$\{\{ hashFiles/u);
  assert.match(prepare, /restore-keys:\s*\|\n\s+nuget-\$\{\{ runner\.os \}\}-target-arm64-dotnet10-/u);
  assert.match(prepare, /runner\.temp \}\}\/windows-shell\/win-arm64/u);
  assert.match(inputs, /RUNNER_TEMP/u);
  assert.match(inputs, /BaseOutputPath/u);
  assert.match(inputs, /BaseIntermediateOutputPath/u);
  assert.match(inputs, /dotnet publish native\/windows\/EquinoxLocal\.WindowsShell/u);
});

test("parallel input preparation requires both native commands and cleans up its own job", async () => {
  const smoke = await fs.readFile(new URL("./windows-ci-input-preparation-smoke.ps1", import.meta.url), "utf8");
  assert.match(smoke, /exit 0\s*$/u);
  assert.match(job("windows-arm64-runtime"), /windows-ci-input-preparation-smoke\.ps1/u);
  assert.match(prepare, /PREPARE_INPUTS_SCRIPT: \$\{\{ github\.action_path \}\}\/prepare-inputs\.ps1/u);
  assert.match(inputs, /Start-Job/u);
  assert.match(inputs, /npm\.cmd/u);
  assert.match(inputs, /ci --prefer-offline --no-audit --no-fund/u);
  assert.match(inputs, /\$LASTEXITCODE -ne 0/u);
  assert.match(inputs, /Wait-Job -Job \$installJob/u);
  assert.match(inputs, /\$installJob\.State -ne 'Completed'/u);
  assert.match(inputs, /Receive-Job -Job \$installJob -ErrorAction Stop/u);
  assert.match(inputs, /finally \{/u);
  assert.match(inputs, /Stop-Job -Job \$installJob/u);
  assert.match(inputs, /Remove-Job -Job \$installJob/u);
});


test("CI parallelizes independent macOS gates and x64 installer preparation", () => {
  const arm = job("test");
  const intel = job("macos-x64");
  const installer = job("windows-x64-installer");
  assert.match(arm, /- parallel:[\s\S]*Static checks[\s\S]*Verify ARM64 host[\s\S]*Full test suite/u);
  assert.match(intel, /- parallel:[\s\S]*Verify x64 host[\s\S]*Static checks[\s\S]*Fast architecture parity suite/u);
  assert.match(installer, /- parallel:[\s\S]*Set up Node\.js[\s\S]*Set up \.NET SDK/u);
  assert.match(installer, /- parallel:[\s\S]*Install dependencies[\s\S]*Publish native x64 shell/u);
  assert.match(installer, /Build native x64 managed package[\s\S]*EQUINOX_WINDOWS_SHELL_PUBLISH_DIR: \$\{\{ runner\.temp \}\}\/windows-shell\/win-x64/u);
});
