import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

// Product workflow coverage belongs here, not in a private mirror.
test("Windows Release Validation writes canonical newline-delimited artifact metadata", () => {
  const workflow = fs.readFileSync(new URL("../../.github/workflows/release-validation.yml", import.meta.url), "utf8");
  assert.match(workflow, /@\(\n\s+"version=\$\(\$result\.version\)"\n\s+"target=\$\(\$result\.target\)"\n\s+"bytes=\$\(\$file\.Length\)"\n\s+"sha256=\$sha256"\n\s+\) \| Set-Content -LiteralPath \$metadata -Encoding ascii/u);
  assert.doesNotMatch(workflow, /@\('version=' \+ \$result\.version,/u);
});
