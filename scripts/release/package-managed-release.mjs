import { createHash, randomBytes } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { readBoundedNormalFile } from "../../src/equinox-local-safe-file.js";
import {
  EQUINOX_LOCAL_NODE_VERSION,
  EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION,
  NODE_DISTRIBUTIONS,
  TUNNEL_CLIENT_DISTRIBUTIONS,
} from "../../src/equinox-local-runtime-versions.js";
import { EQUINOX_LOCAL_VERSION } from "../../src/equinox-local-version.js";
import { buildEquinoxLocalNativeAppArtifacts } from "../../src/equinox-local-native-app.js";
import { equinoxLocalUpdateTarget } from "../../src/equinox-local-updater.js";

const execFile = promisify(execFileCallback);
const TAR_PATH = "/usr/bin/tar";
const FILE_PATH = "/usr/bin/file";
const UNZIP_PATH = "/usr/bin/unzip";
const MAX_NODE_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_TUNNEL_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_RELEASE_SOURCE_BYTES = 2 * 1024 * 1024;
const LOCAL_MODULE_PATTERN = /(?:from\s+|import\s*\(\s*)["'](\.\.?\/[^"']+)["']/gu;
const STATIC_RELEASE_FILES = Object.freeze([
  "src/equinox-control-center.html",
  "src/equinox-control-center.css",
  "src/equinox-control-center.js",
  "package.json",
  "package-lock.json",
]);
const RELEASE_ENTRYPOINTS = Object.freeze([
  "src/server.js",
  "src/equinox-local-bootstrap.js",
  "src/equinox-local-first-install.js",
  "src/equinox-browser-native-host.js",
  "src/equinox-local-update-helper.js",
  "src/equinox-local-restart-helper.js",
  "src/equinox-local-uninstall-helper.js",
  "src/equinox-local-supervisor.js",
]);

export {
  EQUINOX_LOCAL_NODE_VERSION,
  EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION,
  NODE_DISTRIBUTIONS,
  TUNNEL_CLIENT_DISTRIBUTIONS,
};
const TUNNEL_ARCHIVE_FILES = Object.freeze([
  "tunnel-client",
  "cloudflared",
  "cloudflared-manifest.json",
  "LICENSE",
  "NOTICE",
]);

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function extractLocalModuleSpecifiers(source) {
  const values = new Set();
  for (const match of source.matchAll(LOCAL_MODULE_PATTERN)) values.add(match[1]);
  return [...values].sort();
}

async function resolveLocalModule(rootDir, importer, specifier) {
  const base = path.resolve(path.dirname(importer), specifier);
  if (!inside(rootDir, base) && base !== rootDir) throw new Error(`Release import escaped repository root: ${specifier}`);
  for (const candidate of [base, `${base}.js`, `${base}.mjs`]) {
    try {
      const stat = await fs.lstat(candidate);
      if (stat.isFile() && !stat.isSymbolicLink()) return candidate;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  throw new Error(`Release local import could not be resolved: ${specifier}`);
}

export async function collectManagedReleaseSourceFiles(rootDir) {
  const root = path.resolve(rootDir);
  const queue = [];
  const included = new Set();
  for (const entry of RELEASE_ENTRYPOINTS) queue.push(path.join(root, entry));

  while (queue.length > 0) {
    const absolute = queue.shift();
    const relative = path.relative(root, absolute);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Release source traversal escaped repository root.");
    }
    if (included.has(relative)) continue;
    const stat = await fs.lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Release source is not a normal file: ${relative}`);
    included.add(relative);
    if (!/\.(?:js|mjs)$/u.test(relative)) continue;
    const { data: source } = await readBoundedNormalFile(absolute, {
      maxBytes: MAX_RELEASE_SOURCE_BYTES,
      encoding: "utf8",
      label: `Release source ${relative}`,
    });
    for (const specifier of extractLocalModuleSpecifiers(source)) {
      const resolved = await resolveLocalModule(root, absolute, specifier);
      queue.push(resolved);
    }
  }

  for (const relative of STATIC_RELEASE_FILES) {
    const absolute = path.join(root, relative);
    const stat = await fs.lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Static release file is unavailable: ${relative}`);
    included.add(relative);
  }

  const files = [...included].sort();
  if (files.some((relative) => relative.includes(".test.") || relative.includes("reviewer") || relative.includes("backup"))) {
    throw new Error("Release source graph unexpectedly contains test, reviewer or backup files.");
  }
  return Object.freeze(files);
}

async function copyFileTree(rootDir, releaseDir, files) {
  for (const relative of files) {
    const source = path.join(rootDir, relative);
    const releaseRelative = relative.startsWith("src/") ? relative.slice(4) : relative;
    const destination = path.join(releaseDir, releaseRelative);
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await fs.copyFile(source, destination);
  }
}

async function copyProductionNodeModules(rootDir, releaseDir) {
  const source = path.join(rootDir, "node_modules");
  const destination = path.join(releaseDir, "node_modules");
  const sourceStat = await fs.lstat(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error("Production node_modules is unavailable.");
  await fs.cp(source, destination, {
    recursive: true,
    dereference: false,
    filter: (candidate) => {
      const relative = path.relative(source, candidate);
      return relative !== ".bin" && !relative.startsWith(`.bin${path.sep}`);
    },
  });
}

async function assertNoSymlinks(root) {
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop();
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error(`Managed release contains a symbolic link: ${path.relative(root, absolute)}`);
      if (stat.isDirectory()) stack.push(absolute);
      else if (!stat.isFile()) throw new Error(`Managed release contains an unsupported entry: ${path.relative(root, absolute)}`);
    }
  }
}

export const EQUINOX_LOCAL_RELEASE_EPOCH_MS = Date.UTC(2000, 0, 1, 0, 0, 0);

export async function normalizeManagedReleaseTree(releaseDir, {
  epochMs = EQUINOX_LOCAL_RELEASE_EPOCH_MS,
} = {}) {
  if (!Number.isFinite(epochMs) || epochMs < 0) throw new Error("Managed release epoch is invalid.");
  const releaseRoot = path.resolve(releaseDir);
  const entries = [];

  async function walk(absolute, relative) {
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Managed release contains a symbolic link: ${relative || "."}`);
    if (!stat.isDirectory() && !stat.isFile()) throw new Error(`Managed release contains an unsupported entry: ${relative || "."}`);
    entries.push(Object.freeze({ absolute, relative, directory: stat.isDirectory() }));
    if (!stat.isDirectory()) return;
    const children = (await fs.readdir(absolute)).sort();
    for (const child of children) {
      const childRelative = relative ? `${relative}/${child}` : child;
      await walk(path.join(absolute, child), childRelative);
    }
  }

  await walk(releaseRoot, "release");
  const fixed = new Date(epochMs);
  for (const entry of [...entries].reverse()) {
    await fs.utimes(entry.absolute, fixed, fixed);
  }
  return Object.freeze(entries.map((entry) => entry.relative));
}

export async function createDeterministicManagedReleaseArchive({
  transaction,
  releaseDir,
  artifactPath,
  execFileImpl = execFile,
} = {}) {
  const transactionRoot = path.resolve(transaction);
  const releaseRoot = path.resolve(releaseDir);
  if (!inside(transactionRoot, releaseRoot) || path.dirname(releaseRoot) !== transactionRoot) {
    throw new Error("Managed release archive root must be the direct release child of its transaction.");
  }
  const entries = await normalizeManagedReleaseTree(releaseRoot);
  const manifestPath = path.join(transactionRoot, ".release-files.list");
  await fs.writeFile(manifestPath, `${entries.join("\0")}\0`, { mode: 0o600 });
  await fs.rm(artifactPath, { force: true });
  await execFileImpl(TAR_PATH, [
    "-czf", artifactPath,
    "--format", "ustar",
    "--options", "gzip:!timestamp",
    "--uid", "0",
    "--gid", "0",
    "--uname", "root",
    "--gname", "wheel",
    "--no-acls",
    "--no-fflags",
    "--no-mac-metadata",
    "--no-xattrs",
    "--no-recursion",
    "--null",
    "-C", transactionRoot,
    "-T", manifestPath,
  ], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  return Object.freeze({ entryCount: entries.length });
}

async function downloadPinnedNodeArchive(target, destination, { fetchImpl = globalThis.fetch } = {}) {
  const distribution = NODE_DISTRIBUTIONS[target];
  if (!distribution) throw new Error(`No pinned Node distribution exists for ${target}.`);
  const url = `https://nodejs.org/dist/v${EQUINOX_LOCAL_NODE_VERSION}/${distribution.filename}`;
  const response = await fetchImpl(url, {
    method: "GET",
    redirect: "error",
    cache: "no-store",
    credentials: "omit",
    headers: { accept: "application/gzip, application/octet-stream" },
  });
  if (!response?.ok || !response.body) throw new Error(`Node distribution server returned HTTP ${response?.status ?? "unknown"}.`);

  const temporary = `${destination}.part-${randomBytes(8).toString("hex")}`;
  const handle = await fs.open(temporary, "wx", 0o600);
  const digest = createHash("sha256");
  let bytes = 0;
  try {
    for await (const value of response.body) {
      const chunk = Buffer.from(value);
      bytes += chunk.length;
      if (bytes > MAX_NODE_ARCHIVE_BYTES) throw new Error("Pinned Node distribution exceeded the download size limit.");
      digest.update(chunk);
      await handle.write(chunk);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (digest.digest("hex") !== distribution.sha256) {
    await fs.rm(temporary, { force: true });
    throw new Error("Pinned Node distribution SHA-256 verification failed.");
  }
  await fs.rename(temporary, destination);
  return Object.freeze({ url, bytes, sha256: distribution.sha256 });
}

async function installPinnedNodeBinary(target, releaseDir, options = {}) {
  const transaction = path.join(path.dirname(releaseDir), `node-${randomBytes(8).toString("hex")}`);
  const archive = path.join(transaction, "node.tar.gz");
  const extracted = path.join(transaction, "extracted");
  await fs.mkdir(extracted, { recursive: true, mode: 0o700 });
  try {
    await downloadPinnedNodeArchive(target, archive, options);
    await execFile(TAR_PATH, ["-xzf", archive, "-C", extracted], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    const distribution = NODE_DISTRIBUTIONS[target];
    const rootName = distribution.filename.replace(/\.tar\.gz$/u, "");
    const nodeSource = path.join(extracted, rootName, "bin", "node");
    const licenseSource = path.join(extracted, rootName, "LICENSE");
    const nodeDestination = path.join(releaseDir, "runtime", "node", "bin", "node");
    const licenseDestination = path.join(releaseDir, "runtime", "node", "LICENSE");
    await fs.mkdir(path.dirname(nodeDestination), { recursive: true, mode: 0o700 });
    await fs.copyFile(nodeSource, nodeDestination);
    await fs.chmod(nodeDestination, 0o755);
    await fs.copyFile(licenseSource, licenseDestination);
    const { stdout } = await execFile(FILE_PATH, [nodeDestination], { timeout: 5_000, maxBuffer: 1024 * 1024 });
    if (!stdout.includes(distribution.fileArchitecture)) throw new Error(`Pinned Node binary architecture does not match ${target}.`);
  } finally {
    await fs.rm(transaction, { recursive: true, force: true });
  }
}

async function downloadPinnedTunnelArchive(target, destination, { fetchImpl = globalThis.fetch } = {}) {
  const distribution = TUNNEL_CLIENT_DISTRIBUTIONS[target];
  if (!distribution) throw new Error(`No pinned tunnel-client distribution exists for ${target}.`);
  const url = `https://github.com/openai/tunnel-client/releases/download/v${EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION}/${distribution.filename}`;
  const response = await fetchImpl(url, {
    method: "GET",
    redirect: "follow",
    cache: "no-store",
    credentials: "omit",
    headers: { accept: "application/zip, application/octet-stream" },
  });
  if (!response?.ok || !response.body) throw new Error(`tunnel-client release server returned HTTP ${response?.status ?? "unknown"}.`);

  const temporary = `${destination}.part-${randomBytes(8).toString("hex")}`;
  const handle = await fs.open(temporary, "wx", 0o600);
  const digest = createHash("sha256");
  let bytes = 0;
  try {
    for await (const value of response.body) {
      const chunk = Buffer.from(value);
      bytes += chunk.length;
      if (bytes > MAX_TUNNEL_ARCHIVE_BYTES) throw new Error("Pinned tunnel-client distribution exceeded the download size limit.");
      digest.update(chunk);
      await handle.write(chunk);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (digest.digest("hex") !== distribution.sha256) {
    await fs.rm(temporary, { force: true });
    throw new Error("Pinned tunnel-client distribution SHA-256 verification failed.");
  }
  await fs.rename(temporary, destination);
  return Object.freeze({ url, bytes, sha256: distribution.sha256 });
}

export async function installPinnedTunnelRuntime(target, releaseDir, options = {}) {
  const distribution = TUNNEL_CLIENT_DISTRIBUTIONS[target];
  if (!distribution) throw new Error(`No pinned tunnel-client distribution exists for ${target}.`);
  const transaction = path.join(path.dirname(releaseDir), `tunnel-${randomBytes(8).toString("hex")}`);
  const archive = path.join(transaction, "tunnel.zip");
  const extracted = path.join(transaction, "extracted");
  await fs.mkdir(extracted, { recursive: true, mode: 0o700 });
  try {
    await downloadPinnedTunnelArchive(target, archive, options);
    const { stdout: listing } = await execFile(UNZIP_PATH, ["-Z1", archive], { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 });
    const licenseStem = `tunnel-client-v${EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION}-${distribution.assetTag}`;
    const expected = [
      ...TUNNEL_ARCHIVE_FILES,
      `${licenseStem}-licenses.txt`,
      `${licenseStem}.spdx.json`,
    ].sort();
    const actual = listing.split(/\r?\n/u).filter(Boolean).sort();
    if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
      throw new Error("Pinned tunnel-client archive contains missing or unexpected files.");
    }
    await execFile(UNZIP_PATH, ["-q", archive, "-d", extracted], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    const destination = path.join(releaseDir, "runtime", "tunnel");
    await fs.mkdir(destination, { recursive: true, mode: 0o700 });
    for (const relative of expected) {
      const source = path.join(extracted, relative);
      const stat = await fs.lstat(source);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Pinned tunnel-client file is unsafe: ${relative}`);
      await fs.copyFile(source, path.join(destination, relative));
    }
    const tunnelBinary = path.join(destination, "tunnel-client");
    const cloudflaredBinary = path.join(destination, "cloudflared");
    await fs.chmod(tunnelBinary, 0o755);
    await fs.chmod(cloudflaredBinary, 0o755);
    const { stdout: tunnelFile } = await execFile(FILE_PATH, [tunnelBinary], { timeout: 5_000, maxBuffer: 1024 * 1024 });
    const { stdout: cloudflaredFile } = await execFile(FILE_PATH, [cloudflaredBinary], { timeout: 5_000, maxBuffer: 1024 * 1024 });
    if (!tunnelFile.includes(distribution.fileArchitecture) || !cloudflaredFile.includes(distribution.fileArchitecture)) {
      throw new Error(`Pinned tunnel runtime architecture does not match ${target}.`);
    }
    const { stdout: versionText } = await execFile(tunnelBinary, ["--version"], { timeout: 5_000, maxBuffer: 1024 * 1024 });
    if (!versionText.trim().startsWith(`${EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION}+`)) {
      throw new Error(`Pinned tunnel-client version mismatch: ${versionText.trim()}`);
    }
  } finally {
    await fs.rm(transaction, { recursive: true, force: true });
  }
}

async function sha256File(target) {
  const handle = await fs.open(target, "r");
  const digest = createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of handle.createReadStream()) {
      bytes += chunk.length;
      digest.update(chunk);
    }
  } finally {
    await handle.close().catch(() => {});
  }
  return Object.freeze({ sha256: digest.digest("hex"), bytes });
}

export async function packageManagedEquinoxRelease({
  rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
  target = equinoxLocalUpdateTarget(),
  outputDir = path.join(rootDir, "backups", "local-packages"),
  fetchImpl = globalThis.fetch,
} = {}) {
  const hostTarget = equinoxLocalUpdateTarget();
  if (target !== hostTarget) {
    throw new Error(`Cross-target release builds are disabled because node_modules is target-native (${hostTarget}).`);
  }
  const sourceFiles = await collectManagedReleaseSourceFiles(rootDir);
  const transaction = await fs.mkdtemp(path.join(outputDir, `.build-${EQUINOX_LOCAL_VERSION}-${target}-`)).catch(async (error) => {
    if (error?.code !== "ENOENT") throw error;
    await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
    return fs.mkdtemp(path.join(outputDir, `.build-${EQUINOX_LOCAL_VERSION}-${target}-`));
  });
  const releaseDir = path.join(transaction, "release");
  const artifactPath = path.join(outputDir, `equinox-local-${EQUINOX_LOCAL_VERSION}-${target}.tar.gz`);
  await fs.mkdir(releaseDir, { recursive: true, mode: 0o700 });

  try {
    await copyFileTree(rootDir, releaseDir, sourceFiles);
    await copyProductionNodeModules(rootDir, releaseDir);
    await installPinnedNodeBinary(target, releaseDir, { fetchImpl });
    await installPinnedTunnelRuntime(target, releaseDir, { fetchImpl });
    const nativeApp = await buildEquinoxLocalNativeAppArtifacts({ rootDir, releaseDir, target });
    await fs.writeFile(path.join(releaseDir, "release.json"), `${JSON.stringify({
      schemaVersion: 1,
      version: EQUINOX_LOCAL_VERSION,
      target,
      nodeVersion: EQUINOX_LOCAL_NODE_VERSION,
      tunnelClientVersion: EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION,
      nativeAppShellVersion: nativeApp.shellVersion,
      serverEntry: "server.js",
    }, null, 2)}\n`, { mode: 0o644 });
    await assertNoSymlinks(releaseDir);
    await createDeterministicManagedReleaseArchive({
      transaction,
      releaseDir,
      artifactPath,
    });
    const digest = await sha256File(artifactPath);
    return Object.freeze({
      version: EQUINOX_LOCAL_VERSION,
      target,
      nodeVersion: EQUINOX_LOCAL_NODE_VERSION,
      tunnelClientVersion: EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION,
      artifactPath,
      ...digest,
      sourceFileCount: sourceFiles.length,
    });
  } finally {
    await fs.rm(transaction, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath && import.meta.url === invokedPath) {
  packageManagedEquinoxRelease()
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
