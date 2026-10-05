import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const workflow = fs.readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");

test("normal CI owns automatic Main native production and optional manual recovery", () => {
  assert.match(workflow, /^on:\n  push:\n    branches: \[main\]\n  pull_request:\n  workflow_dispatch:\n    inputs:\n      main_native_current:/mu);
  assert.match(workflow, /main_native_target:/u);
  assert.match(workflow, /main-native-plan:\n    if: \$\{\{ github\.event_name == 'push'/u);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/u);
  assert.match(workflow, /inputs\.main_native_current != ''/u);
  assert.match(workflow, /inputs\.main_native_target != ''/u);
  assert.match(workflow, /CURRENT_SHA: \$\{\{ github\.event_name == 'push' && github\.event\.before \|\| inputs\.main_native_current \}\}/u);
  assert.match(workflow, /TARGET_SHA: \$\{\{ github\.event_name == 'push' && github\.sha \|\| inputs\.main_native_target \}\}/u);
  assert.match(workflow, /plan-main-native-artifacts\.mjs --current-sha/u);
  assert.doesNotMatch(workflow, /factory-targets|FACTORY_TARGETS/u);
});

test("Main native jobs stay exact-SHA, impact planned and GitHub-only inside CI", () => {
  assert.match(workflow, /main-native-build:\n    needs: main-native-plan/u);
  assert.match(workflow, /needs\.main-native-plan\.result == 'success'/u);
  assert.match(workflow, /matrix: \$\{\{ fromJSON\(needs\.main-native-plan\.outputs\.github-matrix\) \}\}/u);
  assert.match(workflow, /runs-on: \$\{\{ matrix\.runner \}\}/u);
  assert.match(workflow, /ref: \$\{\{ needs\.main-native-plan\.outputs\.target-sha \}\}\n          fetch-depth: 0/u);
  assert.match(workflow, /EQUINOX_WINDOWS_SHELL_PUBLISH_DIR: \$\{\{ runner\.temp \}\}\/windows-shell\/\$\{\{ matrix\.shellRid \}\}/u);
  assert.match(workflow, /git status --porcelain=v1 --untracked-files=all/u);
  assert.match(workflow, /build-main-native-artifact\.mjs --source-sha "\$\{\{ needs\.main-native-plan\.outputs\.target-sha \}\}" --target "\$\{\{ matrix\.target \}\}"/u);
  assert.match(workflow, /name: main-native-\$\{\{ needs\.main-native-plan\.outputs\.target-sha \}\}-\$\{\{ matrix\.target \}\}/u);
  assert.match(workflow, /main-native-result:\n    needs: \[main-native-plan, main-native-build\]/u);
  assert.match(workflow, /Main native targets are built entirely on GitHub; no factory host is required/u);
});

test("main pushes are never cancelled by a newer push while PR runs remain cancelable", () => {
  assert.match(workflow, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/u);
});
