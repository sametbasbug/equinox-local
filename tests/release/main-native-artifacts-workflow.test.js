import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const workflow = fs.readFileSync(new URL("../../.github/workflows/main-native-artifacts.yml", import.meta.url), "utf8");

test("Main native artifact workflow is exact-SHA dispatch-only and impact planned", () => {
  assert.match(workflow, /^on:\n  workflow_dispatch:\n    inputs:\n      current:/mu);
  assert.doesNotMatch(workflow, /\n  push:/u);
  assert.doesNotMatch(workflow, /\n  pull_request:/u);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}\n          fetch-depth: 0/u);
  assert.match(workflow, /git fetch --no-tags origin \+refs\/heads\/main:refs\/remotes\/origin\/main/u);
  assert.match(workflow, /plan-main-native-artifacts\.mjs --current-sha/u);
  assert.match(workflow, /githubTargets/u);
  assert.match(workflow, /factoryTargets/u);
});

test("Main native artifact workflow runs only planned native targets and materializes SHA-bound candidates", () => {
  assert.match(workflow, /if: \$\{\{ needs\.plan\.outputs\.github-count != '0' \}\}/u);
  assert.match(workflow, /matrix: \$\{\{ fromJSON\(needs\.plan\.outputs\.github-matrix\) \}\}/u);
  assert.match(workflow, /runs-on: \$\{\{ matrix\.runner \}\}/u);
  assert.match(workflow, /- name: Verify native host target\n\s+run: \|\n\s+node -e/u);
  assert.match(workflow, /ref: \$\{\{ inputs\.target \}\}\n          fetch-depth: 0/u);
  assert.match(workflow, /EQUINOX_WINDOWS_SHELL_PUBLISH_DIR: \$\{\{ runner\.temp \}\}\/windows-shell\/\$\{\{ matrix\.shellRid \}\}/u);
  assert.ok(workflow.includes('--output "$env:EQUINOX_WINDOWS_SHELL_PUBLISH_DIR"'));
  assert.ok(workflow.includes('EQUINOX_WINDOWS_SHELL_BIN_DIR: ${{ runner.temp }}/windows-shell-bin/${{ matrix.shellRid }}/'));
  assert.ok(workflow.includes('EQUINOX_WINDOWS_SHELL_OBJ_DIR: ${{ runner.temp }}/windows-shell-obj/${{ matrix.shellRid }}/'));
  assert.ok(workflow.includes('-p:BaseOutputPath=\"$env:EQUINOX_WINDOWS_SHELL_BIN_DIR\"'));
  assert.ok(workflow.includes('-p:BaseIntermediateOutputPath=\"$env:EQUINOX_WINDOWS_SHELL_OBJ_DIR\"'));
  assert.match(workflow, /git status --porcelain=v1 --untracked-files=all/u);
  assert.doesNotMatch(workflow, /EQUINOX_WINDOWS_SHELL_PUBLISH_DIR: artifacts\/windows-shell/u);
  assert.match(workflow, /build-main-native-artifact\.mjs --source-sha "\$\{\{ inputs\.target \}\}" --target "\$\{\{ matrix\.target \}\}"/u);
  assert.match(workflow, /name: main-native-\$\{\{ inputs\.target \}\}-\$\{\{ matrix\.target \}\}/u);
  assert.doesNotMatch(workflow, /build-main-native-artifact\.mjs[^\n]*--root/u);
  assert.doesNotMatch(workflow, /build-main-native-artifact\.mjs[^\n]*--output-dir/u);
  assert.match(workflow, /does not by itself admit a Main SHA or replace Stable releases/u);
});
