import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const INSTALLER = path.join(ROOT, "scripts", "install-equinox-local.sh");
const WINDOWS_INSTALLER = path.join(ROOT, "scripts", "install-equinox-local.ps1");

test("macOS installer forwards zero or one Main argument safely under system Bash nounset", { skip: process.platform !== "darwin" }, async () => {
  const source = await fs.readFile(INSTALLER, "utf8");
  const parser = source.slice(source.indexOf("MAIN_ARGS=()"), source.indexOf('[ "$(/usr/bin/uname -s)"'));
  const forwarded = source.match(/--staged-release "\$SOURCE_RELEASE" (.+)\)" \|\| fail/u)[1];
  const harness = `set -eu\nfail() { exit 2; }\n${parser}\nprintf '%s\\n' stable ${forwarded}`;
  assert.equal(execFileSync("/bin/bash", ["-c", harness, "installer"], { encoding: "utf8" }), "stable\n");
  assert.equal(execFileSync("/bin/bash", ["-c", harness, "installer", "--enroll-existing-main"], { encoding: "utf8" }), "stable\n--enroll-existing-main\n");
});

test("public installers expose explicit Main choice while defaulting to Stable", async () => {
  const mac = await fs.readFile(INSTALLER, "utf8");
  const windows = await fs.readFile(WINDOWS_INSTALLER, "utf8");
  assert.match(mac, /MAIN_ARGS=\(\)/u);
  assert.match(mac, /--enroll-existing-main\) MAIN_ARGS=\(--enroll-existing-main\)/u);
  assert.ok(mac.includes('"$SOURCE_RELEASE" ${MAIN_ARGS[@]+"${MAIN_ARGS[@]}"}'));
  assert.match(mac, /Stable \(default\)/u);
  assert.match(windows, /param\(\[switch\]\$EnrollExistingMain, \[switch\]\$Help\)/u);
  assert.match(windows, /if \(\$EnrollExistingMain\) \{ \$psi\.Arguments \+= ' --enroll-existing-main' \}/u);
  assert.match(windows, /Stable \(default\)/u);
});

test("public shell installer stays user-level, pinned to Equinox HTTPS and bounded", async () => {
  const source = await fs.readFile(INSTALLER, "utf8");
  assert.match(source, /^#!\/bin\/bash\nset -euo pipefail\n/u);
  assert.match(source, /UPDATE_BASE="https:\/\/local\.sametbasbug\.dev\/downloads\/updates"/u);
  assert.match(source, /--proto '=https' --tlsv1\.2/u);
  assert.match(source, /--max-filesize "\$MAX_MANIFEST_BYTES"/u);
  assert.match(source, /--max-filesize "\$ARTIFACT_BYTES"/u);
  assert.match(source, /downloaded release size does not match/u);
  assert.match(source, /downloaded release SHA-256 verification failed/u);
  assert.match(source, /bootstrap artifact URL escaped the pinned Equinox Local HTTPS path/u);
  assert.match(source, /do not run this installer with sudo or as root/u);
  assert.match(source, /\/usr\/bin\/env -i/u);
  assert.match(source, /\/usr\/bin\/grep \/usr\/bin\/awk/u);
  assert.match(source, /CONTROL_CENTER_URL="http:\/\/127\.0\.0\.1:24891\/"/u);
  assert.match(source, /CONTROL_CENTER_APP="\$HOME_DIR\/Applications\/Equinox Local\.app"/u);
  assert.match(source, /installation is ready; opening Equinox Local/u);
  assert.match(source, /\/usr\/bin\/open "\$CONTROL_CENTER_APP"/u);
  assert.match(source, /native app reopen was unavailable; opening the localhost fallback/u);
  assert.match(source, /\/usr\/bin\/open "\$CONTROL_CENTER_URL"/u);
  const appOpen = source.indexOf('/usr/bin/open "$CONTROL_CENTER_APP"');
  const browserFallback = source.indexOf('/usr/bin/open "$CONTROL_CENTER_URL"');
  assert.equal(appOpen >= 0, true);
  assert.equal(browserFallback > appOpen, true);
  assert.doesNotMatch(source, /\/usr\/bin\/open -n/u);
  assert.doesNotMatch(source, /CONTROL_CENTER_EXECUTABLE|NATIVE_APP_PID/u);
  assert.doesNotMatch(source, /\/usr\/bin\/nohup/u);
  assert.doesNotMatch(source, /Contents\/MacOS\/applet/u);
  assert.match(source, /trap cleanup EXIT/u);
  assert.match(source, /trap handle_signal HUP INT TERM/u);
  assert.doesNotMatch(source, /\bsudo\b(?! or as root)/u);
  assert.doesNotMatch(source, /pkgbuild|notarytool|Developer ID|\.pkg/u);
  assert.doesNotMatch(source, /curl[^\n]*\|[^\n]*(?:sh|bash)/u);
});

test("public shell installer supports only the two managed macOS release targets", async () => {
  const source = await fs.readFile(INSTALLER, "utf8");
  assert.match(source, /arm64\) TARGET="darwin-arm64"/u);
  assert.match(source, /x86_64\) TARGET="darwin-x64"/u);
  assert.match(source, /unsupported Mac architecture/u);
  assert.match(source, /bootstrap-\$TARGET\.txt/u);
});


test("public Windows installer selects only native x64/ARM64 targets, stays fixed-origin and delegates ZIP extraction to the pinned helper", async () => {
  const source = await fs.readFile(WINDOWS_INSTALLER, "utf8");
  assert.match(source, /\$UpdateBase = 'https:\/\/local\.sametbasbug\.dev\/downloads\/updates'/u);
  assert.match(source, /\$Target = \$null/u);
  assert.match(source, /function Get-NativeWindowsTarget/u);
  assert.match(source, /Is64BitProcess/u);
  assert.match(source, /'AMD64' \{ return 'win32-x64' \}/u);
  assert.match(source, /'ARM64' \{ return 'win32-arm64' \}/u);
  assert.match(source, /PROCESSOR_ARCHITEW6432/u);
  assert.match(source, /native 64-bit Windows PowerShell is required/u);
  assert.match(source, /unsupported Windows architecture/u);
  assert.match(source, /Save-BoundedHttpsFile/u);
  assert.match(source, /ContentLength -gt \$MaxBytes/u);
  assert.match(source, /\$total -gt \$MaxBytes/u);
  assert.match(source, /bootstrap-\$Target\.txt/u);
  assert.match(source, /function Assert-ExistingStableUpgradeRoute/u);
  assert.match(source, /Assert-ExistingStableUpgradeRoute \$installRoot \$manifest\.Version \$Target/u);
  assert.match(source, /current-version\.json/u);
  assert.match(source, /The website installer is only for first install or same-version repair/u);
  assert.ok(source.indexOf("Assert-ExistingStableUpgradeRoute $installRoot $manifest.Version $Target") < source.indexOf("Write-Info 'downloading the verified ZIP helper'"));
  assert.match(source, /equinox-local-\$\(\$values\.version\)-\$Target\.zip/u);
  assert.match(source, /Get-FileHash -LiteralPath \$Path -Algorithm SHA256/u);
  assert.match(source, /__EQUINOX_ZIP_HELPER_SHA256__/u);
  assert.match(source, /__EQUINOX_ZIP_HELPER_BYTES__/u);
  assert.match(source, /function Assert-NormalDirectory/u);
  assert.match(source, /\$installRoot = Join-Path \$localAppData 'Equinox Local'/u);
  assert.match(source, /\$stagingRoot = Join-Path \$installRoot 'staging'/u);
  assert.match(source, /Assert-NormalDirectory \$stagingRoot \$true/u);
  assert.match(source, /\$stage = Join-Path \$stagingRoot \('bootstrap-' \+ \[Guid\]::NewGuid\(\)\.ToString\('N'\)\)/u);
  assert.match(source, /ReparsePoint/u);
  assert.doesNotMatch(source, /-Mode Inspect -ArchivePath \$artifactPath/u);
  assert.match(source, /-Mode Extract -ArchivePath \$artifactPath -DestinationPath \$stage/u);
  assert.match(source, /Extract performs the same bounded central-directory validation/u);
  assert.match(source, /runtime\\node\\bin\\node\.exe/u);
  assert.match(source, /equinox-local-first-install\.js/u);
  assert.match(source, /EnvironmentVariables\.Clear\(\)/u);
  assert.match(source, /\$extractionOutput = @\(& \$powerShellHost/u);
  assert.match(source, /\$extractExitCode = \$LASTEXITCODE/u);
  assert.match(source, /Check your security product detection logs/u);
  assert.match(source, /Windows denied access to a file/u);
  assert.match(source, /a staged file was unavailable/u);
  assert.doesNotMatch(source, /\$extractionOutput.*Write-Host/u);
  assert.doesNotMatch(source, /Expand-Archive/u);
  assert.doesNotMatch(source, /Start-Process[^\n]+-Verb\s+RunAs/u);
  assert.doesNotMatch(source, /\bsudo\b/u);
});
