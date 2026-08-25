import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const INSTALLER = path.join(ROOT, "scripts", "install-equinox-local.sh");

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
