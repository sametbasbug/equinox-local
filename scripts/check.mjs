import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkProject } from "./lib/factory-tooling.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JSON_FILES = Object.freeze([
  "package.json",
  "extension/manifest.json",
  "examples/equinox-local-config.example.json",
]);

export async function checkPublicProject({ rootDir = root, spawnSyncImpl, shellCommand } = {}) {
  return checkProject({
    rootDir,
    recursiveDirectories: ["src", "scripts", "extension"],
    jsonFiles: JSON_FILES,
    spawnSyncImpl,
    shellCommand,
  });
}

export function parseCheckShellCommand(argv = process.argv.slice(2)) {
  const options = argv.filter((value) => value.startsWith("--shell-command="));
  if (options.length > 1) throw new Error("Only one --shell-command option is allowed.");
  if (options.length === 0) return undefined;
  const shellCommand = options[0].slice("--shell-command=".length);
  if (!shellCommand || !path.isAbsolute(shellCommand)) throw new Error("--shell-command must be an absolute path.");
  return shellCommand;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = await checkPublicProject({ shellCommand: parseCheckShellCommand() });
  if (report.exitCode !== 0) process.exit(report.exitCode);
  console.log(`Checked ${report.javascriptFiles.length} JavaScript modules and ${report.shellFiles.length} shell scripts.`);
}
