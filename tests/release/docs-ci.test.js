import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const DOC_PATHS = [
  "docs/**",
  "README.md",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "SECURITY.md",
  "CHANGELOG.md",
  ".github/CODEOWNERS",
  ".github/FUNDING.yml",
  ".github/ISSUE_TEMPLATE/**",
  ".github/pull_request_template.md",
];

async function read(relative) {
  return fs.readFile(new URL(`../../${relative}`, import.meta.url), "utf8");
}

function quoteRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

test("docs-only paths skip product CI and CodeQL but run the lightweight Docs workflow", async () => {
  const [ci, codeql, docs] = await Promise.all([
    read(".github/workflows/ci.yml"),
    read(".github/workflows/codeql.yml"),
    read(".github/workflows/docs.yml"),
  ]);

  for (const path of DOC_PATHS) {
    const quoted = new RegExp(`- '${quoteRegex(path)}'`, "u");
    assert.match(ci, quoted);
    assert.match(codeql, quoted);
    assert.match(docs, quoted);
  }
  assert.match(ci, /paths-ignore:/u);
  assert.match(codeql, /paths-ignore:/u);
  assert.match(docs, /name: Docs/u);
  assert.match(docs, /name: Docs \/ metadata/u);
  assert.match(docs, /git diff --check/u);
  assert.doesNotMatch(ci, /THIRD_PARTY_NOTICES\.md/u);
});
