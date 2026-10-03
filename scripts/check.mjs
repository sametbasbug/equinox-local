import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkProject } from "./lib/factory-tooling.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JSON_FILES = Object.freeze([
  "package.json",
  "extension/manifest.json",
  "examples/equinox-local-config.example.json",
]);

export async function checkPublicProject({ rootDir = root, spawnSyncImpl } = {}) {
  return checkProject({
    rootDir,
    recursiveDirectories: ["src", "scripts", "extension"],
    jsonFiles: JSON_FILES,
    spawnSyncImpl,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = await checkPublicProject();
  if (report.exitCode !== 0) process.exit(report.exitCode);
  console.log(`Checked ${report.javascriptFiles.length} JavaScript modules and ${report.shellFiles.length} shell scripts.`);
}
