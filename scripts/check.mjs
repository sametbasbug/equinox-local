import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const javascript = [];
const shell = [];

async function walk(relative) {
  const directory = path.join(root, relative);
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const childRelative = path.join(relative, entry.name);
    if (entry.isDirectory()) await walk(childRelative);
    else if (entry.isFile() && /\.(?:js|mjs)$/u.test(entry.name)) javascript.push(childRelative);
    else if (entry.isFile() && entry.name.endsWith(".sh")) shell.push(childRelative);
  }
}

for (const relative of ["src", "scripts", "extension"]) await walk(relative);

for (const file of javascript.sort()) {
  const result = spawnSync(process.execPath, ["--check", file], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
for (const file of shell.sort()) {
  const result = spawnSync("/bin/bash", ["-n", file], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
for (const file of [
  "package.json",
  "extension/manifest.json",
  "examples/equinox-local-config.example.json",
]) {
  JSON.parse(await fs.readFile(path.join(root, file), "utf8"));
}

console.log(`Checked ${javascript.length} JavaScript modules and ${shell.length} shell scripts.`);
