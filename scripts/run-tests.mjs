import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseProfile(argv) {
  const argument = argv.find((value) => value.startsWith("--profile="));
  return argument ? argument.slice("--profile=".length) : "full";
}

async function collectTests(directory, files) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await collectTests(absolute, files);
    else if (entry.isFile() && entry.name.endsWith(".test.js")) files.push(absolute);
  }
}

const profile = parseProfile(process.argv.slice(2));
if (!["fast", "full"].includes(profile)) throw new Error(`Unknown test profile: ${profile}`);

const files = [];
if (profile === "full") {
  await collectTests(path.join(root, "tests"), files);
} else {
  await collectTests(path.join(root, "tests", "unit"), files);
  await collectTests(path.join(root, "tests", "browser"), files);
}
files.sort();
if (files.length === 0) throw new Error(`No public tests were discovered for profile ${profile}.`);

const child = spawn(process.execPath, ["--test", ...files], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    EQUINOX_TEST_PROFILE: profile,
  },
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
