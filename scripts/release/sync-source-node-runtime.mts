import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { EQUINOX_LOCAL_NODE_VERSION, NODE_DISTRIBUTIONS } from "../../src/equinox-local-runtime-versions.js";

const execFile = promisify(execFileCallback);
const target = process.arch === "arm64" ? "darwin-arm64" : process.arch === "x64" ? "darwin-x64" : null;

async function privateDirectory(directory: string, create = false) {
  if (create) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o022) !== 0) {
    throw new Error("Developer Node runtime directory identity is unsafe.");
  }
}

async function verifyNodeBinary(directory: string) {
  if (!target) throw new Error("Unsupported Source Node architecture.");
  const node = path.join(directory, "bin", "node");
  const stat = await fs.lstat(node);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o022) !== 0 || (stat.mode & 0o111) === 0) {
    throw new Error("Developer Node executable identity is unsafe.");
  }
  const [version, architecture, npm] = await Promise.all([
    execFile(node, ["--version"], { timeout: 10_000, maxBuffer: 1024 * 1024 }),
    execFile("/usr/bin/file", [node], { timeout: 10_000, maxBuffer: 1024 * 1024 }),
    fs.lstat(path.join(directory, "lib", "node_modules", "npm", "bin", "npm-cli.js")),
  ]);
  if (version.stdout.trim() !== `v${EQUINOX_LOCAL_NODE_VERSION}` ||
      !architecture.stdout.includes(NODE_DISTRIBUTIONS[target].fileArchitecture) ||
      !npm.isFile() || npm.isSymbolicLink()) {
    throw new Error("Developer Node distribution does not match its pinned version, architecture and npm layout.");
  }
}

export async function syncSourceNodeRuntime({ homeDir = os.homedir() }: { homeDir?: string } = {}) {
  if (process.platform !== "darwin" || !target || homeDir !== os.homedir() || await fs.realpath(homeDir) !== homeDir) {
    throw new Error("Source Node synchronization requires the canonical macOS user and architecture.");
  }
  const distribution = NODE_DISTRIBUTIONS[target];
  const developer = path.join(homeDir, "Library", "Application Support", "Equinox Local Developer");
  const runtime = path.join(developer, "runtime");
  const nodeRoot = path.join(runtime, "node");
  const versions = path.join(nodeRoot, "versions");
  for (const dir of [developer, runtime, nodeRoot, versions]) await privateDirectory(dir);
  const pointer = path.join(nodeRoot, "current");
  const current = await fs.lstat(pointer);
  if (!current.isSymbolicLink() || current.uid !== process.getuid!()) throw new Error("Developer Node current pointer is unsafe.");
  const previous = await fs.readlink(pointer);
  if (!/^versions\/\d+\.\d+\.\d+-darwin-(?:arm64|x64)$/u.test(previous)) throw new Error("Developer Node current pointer is not an admitted version.");
  const relative = `versions/${EQUINOX_LOCAL_NODE_VERSION}-${target}`;
  const destination = path.join(versions, `${EQUINOX_LOCAL_NODE_VERSION}-${target}`);
  if (previous === relative) {
    await verifyNodeBinary(destination);
    return Object.freeze({ changed: false, version: EQUINOX_LOCAL_NODE_VERSION });
  }
  let existing = false;
  try { await fs.lstat(destination); existing = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (existing) {
    await privateDirectory(destination);
    const stamp = await fs.readFile(path.join(destination, ".equinox-node-sha256"), "utf8");
    if (stamp.trim() !== distribution.sha256) throw new Error("Existing Source Node distribution has no matching pin receipt.");
    await verifyNodeBinary(destination);
  } else {
    const stage = await fs.mkdtemp(path.join(versions, ".sync-node-"));
    try {
      const archive = path.join(stage, distribution.filename);
      const response = await fetch(`https://nodejs.org/dist/v${EQUINOX_LOCAL_NODE_VERSION}/${distribution.filename}`, {
        redirect: "error", signal: AbortSignal.timeout(120_000), headers: { accept: "application/gzip, application/octet-stream" },
      });
      if (!response.ok || !response.body) throw new Error("Pinned Source Node download failed.");
      const handle = await fs.open(archive, "wx", 0o600);
      const hash = createHash("sha256");
      let size = 0;
      try {
        for await (const chunk of response.body) {
          const bytes = Buffer.from(chunk);
          size += bytes.length;
          if (size > distribution.bytes) throw new Error("Pinned Source Node archive size exceeded its verified limit.");
          hash.update(bytes);
          await handle.write(bytes);
        }
        await handle.sync();
      } finally { await handle.close(); }
      if (size !== distribution.bytes || hash.digest("hex") !== distribution.sha256) {
        throw new Error("Pinned Source Node archive SHA-256 or size mismatch.");
      }
      await execFile("/usr/bin/tar", ["-xzf", archive, "-C", stage], { timeout: 90_000, maxBuffer: 1024 * 1024 });
      const extracted = path.join(stage, distribution.filename.replace(/\.tar\.gz$/u, ""));
      await verifyNodeBinary(extracted);
      await fs.writeFile(path.join(extracted, ".equinox-node-sha256"), `${distribution.sha256}\n`, { mode: 0o600, flag: "wx" });
      await fs.rename(extracted, destination);
    } finally { await fs.rm(stage, { recursive: true, force: true }); }
  }
  const pending = path.join(nodeRoot, `.current-${randomBytes(8).toString("hex")}`);
  try {
    await fs.symlink(relative, pending);
    if (await fs.readlink(pointer) !== previous) throw new Error("Developer Node current pointer changed during synchronization.");
    await fs.rename(pending, pointer);
  } finally { await fs.rm(pending, { force: true }); }
  return Object.freeze({ changed: true, version: EQUINOX_LOCAL_NODE_VERSION });
}
