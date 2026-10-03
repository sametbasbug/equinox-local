import path from "node:path";
import { fileURLToPath } from "node:url";

import { discoverTests, parseTestProfile, runNodeTests } from "./lib/factory-tooling.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_PROFILE_DIRECTORIES = Object.freeze({
  full: Object.freeze(["tests"]),
  fast: Object.freeze(["tests/unit", "tests/browser"]),
});

export async function discoverPublicTestFiles({
  rootDir = root,
  profile = "full",
} = {}) {
  return discoverTests({ rootDir, profile, profileDirectories: TEST_PROFILE_DIRECTORIES });
}

export async function runPublicTests({
  profile = "full",
  rootDir = root,
  stdio = "inherit",
} = {}) {
  const files = await discoverPublicTestFiles({ rootDir, profile });
  if (files.length === 0) throw new Error(`No public tests were discovered for profile ${profile}.`);
  return runNodeTests({ files, cwd: rootDir, profile, stdio });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const profile = parseTestProfile(process.argv.slice(2));
  process.exitCode = await runPublicTests({ profile });
}
