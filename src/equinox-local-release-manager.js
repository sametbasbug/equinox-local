import { createHash, randomBytes } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { EQUINOX_LOCAL_BUNDLED_PEEKABOO_SINCE_VERSION } from "./equinox-local-runtime-versions.js";
import { compareEquinoxVersions, parseEquinoxVersion } from "./equinox-local-updater.js";

const execFile = promisify(execFileCallback);
const TAR_PATH = "/usr/bin/tar";
const MAX_ARCHIVE_ENTRIES = 20_000;
const MAX_EXTRACTED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ENTRY_NAME = 500;

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function validateArchiveEntryName(rawName) {
  if (typeof rawName !== "string" || rawName.length < 1 || rawName.length > MAX_ENTRY_NAME) {
    throw new Error("Update archive contains an invalid entry name.");
  }
  if (rawName.includes("\\") || rawName.includes("\0")) {
    throw new Error("Update archive contains an unsupported entry path.");
  }
  const name = rawName.endsWith("/") ? rawName.slice(0, -1) : rawName;
  if (!name || path.posix.isAbsolute(name)) {
    throw new Error("Update archive entries must be relative paths.");
  }
  const parts = name.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("Update archive contains an unsafe path traversal entry.");
  }
  if (parts[0] !== "release") {
    throw new Error("Update archive must contain only the release/ tree.");
  }
  return name;
}

function parseVerboseEntryTypes(output) {
  return output
    .split("\n")
    .map((line) => line.trimStart())
    .filter(Boolean)
    .map((line) => line[0]);
}

export async function inspectEquinoxReleaseArchive(archivePath, {
  execFileImpl = execFile,
} = {}) {
  const [{ stdout: namesOutput }, { stdout: verboseOutput }] = await Promise.all([
    execFileImpl(TAR_PATH, ["-tzf", archivePath], {
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024,
    }),
    execFileImpl(TAR_PATH, ["-tvzf", archivePath], {
      timeout: 20_000,
      maxBuffer: 8 * 1024 * 1024,
    }),
  ]);

  const names = namesOutput.split("\n").filter(Boolean);
  if (names.length < 1 || names.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error("Update archive entry count is outside the allowed bounds.");
  }
  for (const name of names) validateArchiveEntryName(name);

  const types = parseVerboseEntryTypes(verboseOutput);
  if (types.length !== names.length) {
    throw new Error("Update archive listing is inconsistent.");
  }
  if (types.some((type) => type !== "-" && type !== "d")) {
    throw new Error("Update archive may contain only regular files and directories.");
  }

  return Object.freeze({ entryCount: names.length });
}

async function removeIfPresent(target) {
  await fs.rm(target, { recursive: true, force: true }).catch(() => {});
}

export async function downloadVerifiedUpdateArtifact(artifact, destinationPath, {
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!artifact || typeof artifact.url !== "string" || !/^[a-f0-9]{64}$/u.test(artifact.sha256)) {
    throw new Error("Verified update artifact metadata is required.");
  }
  if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1 || artifact.bytes > 1024 * 1024 * 1024) {
    throw new Error("Verified update artifact size is invalid.");
  }
  if (typeof fetchImpl !== "function") throw new Error("Update network client is unavailable.");

  await fs.mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
  const tempPath = `${destinationPath}.part-${randomBytes(8).toString("hex")}`;
  let handle = null;
  try {
    const response = await fetchImpl(artifact.url, {
      method: "GET",
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
      headers: { accept: "application/gzip, application/octet-stream" },
    });
    if (!response?.ok || !response.body) {
      throw new Error(`Update artifact server returned HTTP ${response?.status ?? "unknown"}.`);
    }
    const declaredLength = response.headers?.get?.("content-length");
    if (declaredLength !== null && declaredLength !== undefined && declaredLength !== "") {
      const parsed = Number(declaredLength);
      if (!Number.isSafeInteger(parsed) || parsed !== artifact.bytes) {
        throw new Error("Update artifact Content-Length does not match the signed manifest.");
      }
    }

    handle = await fs.open(tempPath, "wx", 0o600);
    const digest = createHash("sha256");
    let bytes = 0;
    for await (const chunkValue of response.body) {
      const chunk = Buffer.from(chunkValue);
      bytes += chunk.length;
      if (bytes > artifact.bytes) throw new Error("Update artifact exceeded the signed byte size.");
      digest.update(chunk);
      await handle.write(chunk);
    }
    await handle.sync();
    await handle.close();
    handle = null;

    if (bytes !== artifact.bytes) throw new Error("Update artifact byte size does not match the signed manifest.");
    if (digest.digest("hex") !== artifact.sha256) throw new Error("Update artifact SHA-256 verification failed.");
    await fs.rename(tempPath, destinationPath);
    return Object.freeze({ path: destinationPath, bytes, sha256: artifact.sha256 });
  } catch (error) {
    await handle?.close().catch(() => {});
    await removeIfPresent(tempPath);
    throw error;
  }
}

async function validateExtractedTree(root) {
  let fileCount = 0;
  let totalBytes = 0;
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop();
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      fileCount += 1;
      if (fileCount > MAX_ARCHIVE_ENTRIES) throw new Error("Extracted update contains too many entries.");
      const absolutePath = path.join(directory, entry.name);
      const stat = await fs.lstat(absolutePath);
      if (stat.isSymbolicLink()) throw new Error("Extracted update may not contain symbolic links.");
      if (stat.isDirectory()) {
        stack.push(absolutePath);
      } else if (stat.isFile()) {
        totalBytes += stat.size;
        if (totalBytes > MAX_EXTRACTED_BYTES) throw new Error("Extracted update exceeds the size limit.");
      } else {
        throw new Error("Extracted update contains an unsupported filesystem entry.");
      }
    }
  }
  return Object.freeze({ fileCount, totalBytes });
}

async function readReleaseMetadata(releaseDir, expectedVersion, expectedTarget) {
  const metadataPath = path.join(releaseDir, "release.json");
  const text = await fs.readFile(metadataPath, "utf8");
  const metadata = JSON.parse(text);
  const keys = Object.keys(metadata).sort();
  const legacyKeys = ["nodeVersion", "schemaVersion", "serverEntry", "target", "tunnelClientVersion", "version"].sort();
  const nativeKeys = [...legacyKeys, "nativeAppShellVersion"].sort();
  const matches = (expected) => keys.length === expected.length && keys.every((key, index) => key === expected[index]);
  if (!matches(legacyKeys) && !matches(nativeKeys)) {
    throw new Error("Release metadata contains missing or unsupported fields.");
  }
  if (
    metadata.schemaVersion !== 1 ||
    metadata.version !== expectedVersion ||
    metadata.target !== expectedTarget ||
    typeof metadata.nodeVersion !== "string" ||
    !/^\d+\.\d+\.\d+$/u.test(metadata.nodeVersion) ||
    typeof metadata.tunnelClientVersion !== "string" ||
    !/^\d+\.\d+\.\d+$/u.test(metadata.tunnelClientVersion) ||
    (metadata.nativeAppShellVersion !== undefined && (!Number.isSafeInteger(metadata.nativeAppShellVersion) || metadata.nativeAppShellVersion < 1)) ||
    metadata.serverEntry !== "server.js"
  ) {
    throw new Error("Release metadata does not match the expected Equinox Local release.");
  }

  for (const required of ["server.js", "package.json", "equinox-local-version.js"]) {
    const stat = await fs.lstat(path.join(releaseDir, required));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Release is missing required file ${required}.`);
  }
  const modules = await fs.lstat(path.join(releaseDir, "node_modules"));
  if (!modules.isDirectory() || modules.isSymbolicLink()) {
    throw new Error("Release must contain its production node_modules tree.");
  }
  const requiredExecutables = [
    path.join("runtime", "node", "bin", "node"),
    path.join("runtime", "tunnel", "tunnel-client"),
    path.join("runtime", "tunnel", "cloudflared"),
  ];
  const requiresBundledPeekaboo = compareEquinoxVersions(
    metadata.version,
    EQUINOX_LOCAL_BUNDLED_PEEKABOO_SINCE_VERSION,
  ) >= 0;
  if (requiresBundledPeekaboo) {
    requiredExecutables.push(
      path.join("runtime", "peekaboo", "peekaboo"),
      path.join("runtime", "peekaboo", "libswiftCompatibilitySpan.dylib"),
    );
  }
  for (const relative of requiredExecutables) {
    const executable = await fs.lstat(path.join(releaseDir, relative));
    if (!executable.isFile() || executable.isSymbolicLink() || (executable.mode & 0o111) === 0) {
      throw new Error(`Release must contain executable runtime file ${relative}.`);
    }
  }
  if (metadata.nativeAppShellVersion !== undefined) {
    const appExecutable = await fs.lstat(path.join(releaseDir, "runtime", "app", "applet"));
    if (!appExecutable.isFile() || appExecutable.isSymbolicLink() || (appExecutable.mode & 0o111) === 0) {
      throw new Error("Release must contain the executable Equinox Local native app shell.");
    }
    for (const relative of [
      path.join("runtime", "app", "EquinoxLocal.png"),
      path.join("runtime", "app", "native-app.json"),
    ]) {
      const appFile = await fs.lstat(path.join(releaseDir, relative));
      if (!appFile.isFile() || appFile.isSymbolicLink()) throw new Error(`Release must contain native app file ${relative}.`);
    }
  }
  const requiredDocuments = [
    path.join("runtime", "tunnel", "LICENSE"),
    path.join("runtime", "tunnel", "NOTICE"),
  ];
  if (requiresBundledPeekaboo) {
    requiredDocuments.push(
      path.join("runtime", "peekaboo", "LICENSE"),
      path.join("runtime", "peekaboo", "README.md"),
      path.join("runtime", "peekaboo", "VERSION"),
    );
  }
  for (const relative of requiredDocuments) {
    const document = await fs.lstat(path.join(releaseDir, relative));
    if (!document.isFile() || document.isSymbolicLink()) {
      throw new Error(`Release must contain normal runtime document ${relative}.`);
    }
  }
  return Object.freeze(metadata);
}

export async function prepareManagedEquinoxRelease({
  installation,
  manifest,
  fetchImpl = globalThis.fetch,
  execFileImpl = execFile,
} = {}) {
  if (!installation?.selfUpdateSupported || typeof installation.stagingRoot !== "string" || typeof installation.releasesRoot !== "string") {
    throw new Error("A managed Equinox Local installation is required to prepare an update.");
  }
  if (!manifest?.artifact || typeof manifest.target !== "string" || !/^darwin-(?:arm64|x64)$/u.test(manifest.target)) {
    throw new Error("A verified target-specific update manifest is required.");
  }
  const version = parseEquinoxVersion(manifest.version).text;
  const targetReleaseDir = path.join(installation.releasesRoot, version);
  if (!inside(installation.releasesRoot, targetReleaseDir)) throw new Error("Update release path escaped the managed releases root.");

  try {
    await fs.lstat(targetReleaseDir);
    throw new Error(`Equinox Local ${version} is already present in the managed releases directory.`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  await fs.mkdir(installation.stagingRoot, { recursive: true, mode: 0o700 });
  await fs.mkdir(installation.releasesRoot, { recursive: true, mode: 0o700 });
  const transactionRoot = path.join(installation.stagingRoot, `update-${version}-${randomBytes(8).toString("hex")}`);
  const archivePath = path.join(transactionRoot, "release.tar.gz");
  const extractionRoot = path.join(transactionRoot, "extracted");
  await fs.mkdir(extractionRoot, { recursive: true, mode: 0o700 });

  try {
    await downloadVerifiedUpdateArtifact(manifest.artifact, archivePath, { fetchImpl });
    await inspectEquinoxReleaseArchive(archivePath, { execFileImpl });
    await execFileImpl(TAR_PATH, ["-xzf", archivePath, "-C", extractionRoot, "--no-same-owner"], {
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const releaseDir = path.join(extractionRoot, "release");
    const tree = await validateExtractedTree(releaseDir);
    const metadata = await readReleaseMetadata(releaseDir, version, manifest.target);
    await fs.rename(releaseDir, targetReleaseDir);
    await removeIfPresent(transactionRoot);
    return Object.freeze({
      version,
      targetReleaseDir,
      fileCount: tree.fileCount,
      extractedBytes: tree.totalBytes,
      metadata,
    });
  } catch (error) {
    await removeIfPresent(transactionRoot);
    throw error;
  }
}
