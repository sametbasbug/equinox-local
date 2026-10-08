import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

// Product workflow coverage belongs here, not in a private mirror.
test("Windows Release Validation writes canonical newline-delimited artifact metadata", () => {
  const workflow = fs.readFileSync(new URL("../../.github/workflows/release-validation.yml", import.meta.url), "utf8");
  assert.match(workflow, /@\(\n\s+"version=\$\(\$result\.version\)"\n\s+"target=\$\(\$result\.target\)"\n\s+"bytes=\$\(\$file\.Length\)"\n\s+"sha256=\$sha256"\n\s+\) \| Set-Content -LiteralPath \$metadata -Encoding ascii/u);
  assert.doesNotMatch(workflow, /@\('version=' \+ \$result\.version,/u);
});

// The release workflow must build from the same clean exact-SHA source that
// its package stamp verifies. The prior shallow Intel checkout could not push
// its SHA to the isolated smoke remote; Windows native .NET outputs could dirty
// Git and make the release packager fail closed on two architectures.
test("Release Validation Intel smoke gets complete canonical Git history", () => {
  const workflow = fs.readFileSync(new URL("../../.github/workflows/release-validation.yml", import.meta.url), "utf8");
  const intel = workflow.split("  intel-x64:")[1]?.split("  windows-native:")[0] ?? "";
  assert.match(intel, /uses: actions\/checkout@v7\n\s+with:\n\s+ref: \$\{\{ inputs\.commit \}\}\n\s+fetch-depth: 0/u);
});

test("Release Validation .NET native outputs cannot dirty canonical source identity", () => {
  const ignore = fs.readFileSync(new URL("../../.gitignore", import.meta.url), "utf8");
  assert.match(ignore, /^native\/windows\/\*\*\/bin\/$/mu);
  assert.match(ignore, /^native\/windows\/\*\*\/obj\/$/mu);
  assert.match(ignore, /^artifacts\/windows-shell\/$/mu);
});
