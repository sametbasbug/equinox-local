import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const INSTALLER = path.join(ROOT, "scripts", "install-equinox-local.sh");
const WINDOWS_INSTALLER = path.join(ROOT, "scripts", "install-equinox-local.ps1");

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
  assert.doesNotMatch(source, /Expand-Archive/u);
  assert.doesNotMatch(source, /Start-Process[^\n]+-Verb\s+RunAs/u);
  assert.doesNotMatch(source, /\bsudo\b/u);
});
