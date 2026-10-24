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
  assert.match(workflow, /windows-arm64-foundation:[\s\S]*needs: \[windows-arm64-runtime, windows-arm64-package, windows-arm64-installer, windows-arm64-repair\]/u);
  assert.match(workflow, /windows-headless:[\s\S]*needs: \[windows-runtime, windows-shell, windows-x64-package-build, windows-package, windows-x64-installer, windows-x64-guardian, windows-x64-repair, windows-arm64-shared-core, windows-arm64-bootstrap, windows-arm64-runtime, windows-arm64-package, windows-arm64-installer, windows-arm64-repair\]/u);
  assert.doesNotMatch(workflow.match(/windows-headless:[\s\S]*?(?=\n  main-native-plan:)/u)?.[0] ?? "", /windows-arm64-foundation/u);
  assert.match(workflow, /main-snapshot-publish:[\s\S]*needs\.test\.result == 'success'[\s\S]*needs\.macos-managed-source\.result == 'success'[\s\S]*needs\.macos-x64\.result == 'success'[\s\S]*needs\.windows-headless\.result == 'success'/u);
});

test("public Main snapshot CI has only READ-only authorization, never R2 or tag write authority", () => {
 const pub=workflow.slice(workflow.indexOf('  main-snapshot-publish:'));
 assert.match(pub, /name: Publish Main Snapshot/u);
 assert.match(pub, /permissions:\n      contents: read/u);
 assert.match(pub, /group: equinox-local-main-snapshot-publish\n      cancel-in-progress: false/u);
 assert.match(pub, /pattern: main-native-\$\{\{ needs\.main-native-plan\.outputs\.target-sha \}\}-\*/u);
 assert.doesNotMatch(pub, /secrets\.EQUINOX_MAIN_R2|AWS_ACCESS_KEY_ID|aws s3api put-object|--method PATCH|--method POST|git\/refs\/tags\/main-snapshot/u);
 assert.doesNotMatch(pub, /GH_TOKEN|contents: write|--force|force=true/u);
 assert.doesNotMatch(pub, /gh release (?:create|upload|edit)/u);
});

test("main pushes are never cancelled by a newer push while PR runs remain cancelable", () => {
  assert.match(workflow, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/u);
});


test("Main signed CI authorization requires four genuine factory Ed25519 sidecars before independent private promotion",()=>{
 const pub=workflow.slice(workflow.indexOf('  main-snapshot-publish:'));
 assert.match(pub,/equinox-local-main-\$TARGET_SHA-\$target\.b-authorization\.json/u);
 assert.match(pub,/test "\$count" = 12/u);
 assert.match(pub,/verify-main-native-signed-snapshot-set\.mjs --directory "\$SNAPSHOT_DIR" --source-sha "\$TARGET_SHA"/u);
 assert.match(pub,/Separate private factory promotion is still required/u);
 assert.doesNotMatch(pub,/aws s3api|git\/refs\/tags\/main-snapshot|gh api --method/u);
 assert.doesNotMatch(pub,/SIGNING_PRIVATE_KEY|SIGNING_KEY_PEM|--private-key|--key-file/u);
});

test("Main native SHA artifacts remain published to CI storage but NEVER directly to public R2 or moving Git ref",()=>{
 assert.match(workflow,/Upload exact-SHA Main native candidate[\s\S]*actions\/upload-artifact@v7/u);
 const pub=workflow.slice(workflow.indexOf('  main-snapshot-publish:'));
 assert.doesNotMatch(pub,/R2_ENDPOINT|--if-none-match|--metadata "sha256=|GitHub Release was created|tag-only Main Snapshot pointer/u);
 assert.match(pub,/github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/u);
});
