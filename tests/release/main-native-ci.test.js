import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const workflow = fs.readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");

test("normal CI owns automatic Main snapshot production and optional manual recovery", () => {
  assert.match(workflow, /^on:\n  push:\n    branches: \[main\]/mu);
  assert.match(workflow, /  pull_request:\n    paths-ignore:/u);
  assert.match(workflow, /  workflow_dispatch:\n    inputs:\n      main_native_current:/u);
  assert.match(workflow, /main_native_target:/u);
  assert.match(workflow, /main-native-plan:\n    if: \$\{\{ github\.event_name == 'push'/u);
  assert.match(workflow, /name: Exact-SHA Main snapshot plan/u);
  assert.match(workflow, /CURRENT_SHA: \$\{\{ github\.event_name == 'push' && github\.event\.before \|\| inputs\.main_native_current \}\}/u);
  assert.match(workflow, /TARGET_SHA: \$\{\{ github\.event_name == 'push' && github\.sha \|\| inputs\.main_native_target \}\}/u);
  assert.match(workflow, /plan-main-native-artifacts\.mjs --current-sha/u);
});

test("every product-impacting Main CI push builds all four exact-SHA snapshot targets on GitHub", () => {
  assert.match(workflow, /main-native-build:\n    needs: main-native-plan/u);
  assert.match(workflow, /outputs:\n      main-update-impact: \$\{\{ steps\.plan\.outputs\.main-update-impact \}\}/u);
  assert.match(workflow, /`main-update-impact=\$\{plan\.mainUpdateImpact\}`/u);
  assert.match(workflow, /if: \$\{\{ needs\.main-native-plan\.result == 'success' && \(github\.event_name == 'workflow_dispatch' \|\| needs\.main-native-plan\.outputs\.main-update-impact == 'true'\) \}\}/u);
  assert.match(workflow, /matrix: \$\{\{ fromJSON\(needs\.main-native-plan\.outputs\.github-matrix\) \}\}/u);
  assert.match(workflow, /runs-on: \$\{\{ matrix\.runner \}\}/u);
  assert.match(workflow, /build-main-native-artifact\.mjs --source-sha "\$\{\{ needs\.main-native-plan\.outputs\.target-sha \}\}" --target "\$\{\{ matrix\.target \}\}"/u);
  assert.match(workflow, /name: main-native-\$\{\{ needs\.main-native-plan\.outputs\.target-sha \}\}-\$\{\{ matrix\.target \}\}/u);
  assert.match(workflow, /if \[ "\$GITHUB_COUNT" != "4" \]/u);
});

test("test CI and docs-only Main changes cannot build or publish a user-visible Main snapshot", () => {
  assert.match(workflow, /MAIN_UPDATE_IMPACT: \$\{\{ needs\.main-native-plan\.outputs\.main-update-impact \}\}/u);
  assert.match(workflow, /if \[ "\$MAIN_UPDATE_IMPACT" != "true" \] && \[ "\$FORCE_BUILD" != "true" \]/u);
  assert.match(workflow, /No user-visible Main update: changed paths are limited to tests\/CI\/docs metadata/u);
  assert.match(workflow, /main-snapshot-publish:[\s\S]*needs\.main-native-plan\.outputs\.main-update-impact == 'true'/u);
});

test("Main Snapshot publish waits for the complete product CI aggregate", () => {
  assert.match(workflow, /windows-arm64-foundation:[\s\S]*needs: \[windows-arm64-runtime, windows-arm64-package, windows-arm64-installer\]/u);
  assert.match(workflow, /windows-headless:[\s\S]*needs: \[windows-runtime, windows-shell, windows-package, windows-arm64-shared-core, windows-arm64-bootstrap, windows-arm64-foundation\]/u);
  assert.match(workflow, /main-snapshot-publish:[\s\S]*needs\.test\.result == 'success'[\s\S]*needs\.macos-x64\.result == 'success'[\s\S]*needs\.windows-headless\.result == 'success'/u);
});

test("Main Snapshot publish uses public R2 plus a tag-only pointer and never creates a GitHub Release", () => {
  assert.match(workflow, /main-snapshot-publish:\n    needs: \[test, macos-x64, windows-headless, main-native-plan, main-native-build, main-native-result\]/u);
  assert.match(workflow, /needs\.test\.result == 'success'/u);
  assert.match(workflow, /needs\.macos-x64\.result == 'success'/u);
  assert.match(workflow, /needs\.windows-headless\.result == 'success'/u);
  assert.match(workflow, /permissions:\n      contents: write/u);
  assert.match(workflow, /group: equinox-local-main-snapshot-publish\n      cancel-in-progress: false/u);
  assert.match(workflow, /pattern: main-native-\$\{\{ needs\.main-native-plan\.outputs\.target-sha \}\}-\*/u);
  assert.match(workflow, /secrets\.EQUINOX_MAIN_R2_ACCESS_KEY_ID/u);
  assert.match(workflow, /secrets\.EQUINOX_MAIN_R2_SECRET_ACCESS_KEY/u);
  assert.match(workflow, /aws s3api put-object/u);
  assert.match(workflow, /--bucket equinox-local-main/u);
  assert.match(workflow, /--key "snapshots\/\$TARGET_SHA\/\$name"/u);
  assert.match(workflow, /AWS_RETRY_MODE: standard/u);
  assert.match(workflow, /AWS_MAX_ATTEMPTS: '8'/u);
  assert.doesNotMatch(workflow, /aws s3 cp/u);
  assert.doesNotMatch(workflow, /--recursive/u);
  assert.match(workflow, /https:\/\/main\.local\.sametbasbug\.dev/u);
  assert.match(workflow, /jq -e --arg sha/u);
  assert.match(workflow, /--range 0-0/u);
  assert.match(workflow, /git\/refs\/tags\/main-snapshot/u);
  assert.match(workflow, /refs\/tags\/main-snapshot/u);
  assert.doesNotMatch(workflow, /gh release (?:create|upload|edit) main-snapshot/u);
  assert.match(workflow, /No GitHub Release was created/u);
});

test("main pushes are never cancelled by a newer push while PR runs remain cancelable", () => {
  assert.match(workflow, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/u);
});
