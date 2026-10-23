import { createHash, randomBytes } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { equinoxLocalReleaseRuntimeContract } from "./equinox-local-release-runtime-contract.js";
import { parseEquinoxVersion } from "./equinox-local-updater.js";
import { walkBoundedReleaseTree } from "./equinox-local-release-tree.js";

const execFile = promisify(execFileCallback);
type ReleaseExec = (cmd:string,args:string[],options:{timeout:number;maxBuffer:number;windowsHide?:boolean})=>Promise<{stdout:string;stderr?:string}>;
type Artifact = {url:string;sha256:string;bytes:number};
type ReleaseMetadata = Readonly<Record<string,unknown>> & {schemaVersion:1;version:string;target:string;sourceSha?:string;nodeVersion:string;tunnelClientVersion:string;nativeAppShellVersion?:number;serverEntry:"server.js"};
type ExecOptions = {target?:string;execFileImpl?:ReleaseExec};
type DownloadOptions = {fetchImpl?:typeof fetch;timeoutMs?:number;retryDelayImpl?:(ms:number,signal:AbortSignal)=>Promise<unknown>};
type PrepareOptions = {installation?:{selfUpdateSupported:boolean;stagingRoot:string;releasesRoot:string};manifest?:{version:string;target:string;artifact:Artifact};fetchImpl?:typeof fetch;execFileImpl?:ReleaseExec};
function hasErrorCode(error:unknown,code:string){return error!==null&&typeof error==="object"&&"code" in error&&error.code===code;}
function isRecord(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==="object"&&!Array.isArray(value);}

const TAR_PATH = "/usr/bin/tar";
const WINDOWS_TARGET_PATTERN = /^win32-(?:arm64|x64)$/u;
const MANAGED_TARGET_PATTERN = /^(?:darwin-(?:arm64|x64)|win32-(?:arm64|x64))$/u;
const WINDOWS_ZIP_HELPER_PATH = fileURLToPath(new URL("./equinox-local-windows-release-zip.ps1", import.meta.url));
const MAX_ARCHIVE_ENTRIES = 20_000;
const MAX_EXTRACTED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ENTRY_NAME = 500;
const DEFAULT_ARTIFACT_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const TRANSIENT_ARTIFACT_HTTP_STATUSES = new Set([502, 503, 504]);
const ARTIFACT_HTTP_RETRY_DELAYS_MS = Object.freeze([500, 1_000, 2_000]);

function inside(parent:string,child:string) {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function validateArchiveEntryName(rawName:unknown) {
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

function parseVerboseEntries(output:string) {
  return output
    .split("\n")
    .map((line) => line.trimStart())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\S)\S*\s+\d+\s+\S+\s+\S+\s+(\d+)\s+/u);
      if (!match) throw new Error("Update archive verbose listing is invalid.");
      const size = Number(match[2]);
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new Error("Update archive entry size is invalid.");
      }
      return Object.freeze({ type: match[1], size });
    });
}

function parseWindowsZipSummary(stdout:unknown) {
  let value:unknown;
  try { value = JSON.parse(String(stdout ?? "").trim()); } catch { throw new Error("Windows release ZIP helper returned invalid JSON."); }
  if (!isRecord(value)) throw new Error("Windows release ZIP helper returned invalid fields.");
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "entryCount" || keys[1] !== "extractedBytes") throw new Error("Windows release ZIP helper returned invalid fields.");
  if (typeof value.entryCount !== "number" || !Number.isSafeInteger(value.entryCount) || value.entryCount < 1 || value.entryCount > MAX_ARCHIVE_ENTRIES) throw new Error("Windows release ZIP entry count is outside the allowed bounds.");
  if (typeof value.extractedBytes !== "number" || !Number.isSafeInteger(value.extractedBytes) || value.extractedBytes < 0 || value.extractedBytes > MAX_EXTRACTED_BYTES) throw new Error("Windows release ZIP extracted size is outside the allowed bounds.");
  return Object.freeze({ entryCount: value.entryCount, extractedBytes: value.extractedBytes });
}

async function runWindowsZipHelper(mode:string,archivePath:string,destinationPath:string|null,execFileImpl:ReleaseExec) {
  const args = [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", WINDOWS_ZIP_HELPER_PATH, "-Mode", mode, "-ArchivePath", archivePath,
  ];
  if (destinationPath) args.push("-DestinationPath", destinationPath);
  const { stdout } = await execFileImpl("powershell.exe", args, {
    timeout: mode === "Extract" ? 180_000 : 60_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  return parseWindowsZipSummary(stdout);
}

export async function inspectEquinoxReleaseArchive(archivePath:string, {
  target = "darwin-arm64",
  execFileImpl = execFile,
}:ExecOptions = {}) {
  if (WINDOWS_TARGET_PATTERN.test(target)) return runWindowsZipHelper("Inspect", archivePath, null, execFileImpl);
  if (!/^darwin-(?:arm64|x64)$/u.test(target)) throw new Error(`Managed release archive inspection is not implemented for ${target}.`);
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

  const verboseEntries = parseVerboseEntries(verboseOutput);
  if (verboseEntries.length !== names.length) {
    throw new Error("Update archive listing is inconsistent.");
  }
  if (verboseEntries.some(({ type }) => type !== "-" && type !== "d")) {
    throw new Error("Update archive may contain only regular files and directories.");
  }
  let extractedBytes = 0;
  for (const entry of verboseEntries) {
    if (entry.type !== "-") continue;
    if (entry.size > MAX_EXTRACTED_BYTES - extractedBytes) {
      throw new Error("Update archive exceeds the extracted size limit before extraction.");
    }
    extractedBytes += entry.size;
  }

  return Object.freeze({ entryCount: names.length, extractedBytes });
}

export async function extractEquinoxReleaseArchive(archivePath:string,destinationPath:string, {
  target = "darwin-arm64",
  execFileImpl = execFile,
}:ExecOptions = {}) {
  if (WINDOWS_TARGET_PATTERN.test(target)) return runWindowsZipHelper("Extract", archivePath, destinationPath, execFileImpl);
  if (!/^darwin-(?:arm64|x64)$/u.test(target)) throw new Error(`Managed release archive extraction is not implemented for ${target}.`);
  await fs.mkdir(destinationPath, { recursive: true, mode: 0o700 });
  await execFileImpl(TAR_PATH, ["-xzf", archivePath, "-C", destinationPath, "--no-same-owner"], {
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return null;
}

async function removeIfPresent(target:string) {
  await fs.rm(target, { recursive: true, force: true }).catch(() => {});
}

export async function downloadVerifiedUpdateArtifact(artifact:Artifact,destinationPath:string, {
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_ARTIFACT_DOWNLOAD_TIMEOUT_MS,
  retryDelayImpl = (durationMs, signal) => sleep(durationMs, undefined, { signal }),
}:DownloadOptions = {}) {
  if (!artifact || typeof artifact.url !== "string" || !/^[a-f0-9]{64}$/u.test(artifact.sha256)) {
    throw new Error("Verified update artifact metadata is required.");
  }
  if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1 || artifact.bytes > 1024 * 1024 * 1024) {
    throw new Error("Verified update artifact size is invalid.");
  }
  if (typeof fetchImpl !== "function") throw new Error("Update network client is unavailable.");
  if (typeof retryDelayImpl !== "function") throw new Error("Update artifact retry timer is unavailable.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30 * 60 * 1000) {
    throw new Error("Update artifact download timeout is invalid.");
  }

  await fs.mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
  const tempPath = `${destinationPath}.part-${randomBytes(8).toString("hex")}`;
  let handle:Awaited<ReturnType<typeof fs.open>>|null = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    let response:Response|undefined;
    for (let attempt = 0; attempt <= ARTIFACT_HTTP_RETRY_DELAYS_MS.length; attempt += 1) {
      if (controller.signal.aborted) throw new Error("Update artifact download deadline expired.");
      response = await fetchImpl(artifact.url, {
        method: "GET",
        redirect: "error",
        cache: "no-store",
        credentials: "omit",
        headers: { accept: "application/gzip, application/zip, application/octet-stream" },
        signal: controller.signal,
      });
      if (response?.ok) break;

      // Only transient gateway/availability responses are safe to retry. A
      // partial transfer, invalid signed size/hash, or client/auth failure is
      // never replayed; every attempt shares the original absolute deadline.
      const retryable = TRANSIENT_ARTIFACT_HTTP_STATUSES.has(response?.status)
        && attempt < ARTIFACT_HTTP_RETRY_DELAYS_MS.length;
      await response?.body?.cancel?.().catch(() => {});
      if (!retryable) throw new Error(`Update artifact server returned HTTP ${response?.status ?? "unknown"}.`);
      await retryDelayImpl(ARTIFACT_HTTP_RETRY_DELAYS_MS[attempt]!, controller.signal);
    }
    if (!response?.body) throw new Error(`Update artifact server returned HTTP ${response?.status ?? "unknown"}.`);
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
  } finally {
    clearTimeout(timer);
  }
}

async function validateExtractedTree(root:string, { fsImpl = fs }:{fsImpl?:typeof fs} = {}) {
  return walkBoundedReleaseTree(root, {
    fsImpl,
    countName: "fileCount",
    errors: {
      entryLimit: "Extracted update contains too many entries.",
      byteLimit: "Extracted update exceeds the size limit.",
      symlink: "Extracted update may not contain symbolic links.",
      unsupportedEntry: "Extracted update contains an unsupported filesystem entry.",
    },
  });
}

async function readReleaseMetadata(releaseDir:string,expectedVersion:string,expectedTarget:string):Promise<ReleaseMetadata> {
  const metadataPath = path.join(releaseDir, "release.json");
  const text = await fs.readFile(metadataPath, "utf8");
  const metadata:unknown = JSON.parse(text);
  if (!isRecord(metadata)) throw new Error("Release metadata contains missing or unsupported fields.");
  const keys = Object.keys(metadata).sort();
  const legacyKeys = ["nodeVersion", "schemaVersion", "serverEntry", "target", "tunnelClientVersion", "version"].sort();
  const nativeKeys = [...legacyKeys, "nativeAppShellVersion"].sort();
  // Canonical managed-source packages include an exact public source commit;
  // numbered historical Stable archives legitimately omit this newer field.
  const sourceKeys = Object.hasOwn(metadata, "sourceSha") ? ["sourceSha"] : [];
  const matches = (expected:string[]) => keys.length === expected.length && keys.every((key, index) => key === expected[index]);
  if (!matches([...legacyKeys, ...sourceKeys].sort()) && !matches([...nativeKeys, ...sourceKeys].sort())) {
    throw new Error("Release metadata contains missing or unsupported fields.");
  }
  if (
    metadata.schemaVersion !== 1 ||
    metadata.version !== expectedVersion ||
    metadata.target !== expectedTarget ||
    (metadata.sourceSha !== undefined && (typeof metadata.sourceSha !== "string" || !/^[a-f0-9]{40}$/u.test(metadata.sourceSha))) ||
    typeof metadata.nodeVersion !== "string" ||
    !/^\d+\.\d+\.\d+$/u.test(metadata.nodeVersion) ||
    typeof metadata.tunnelClientVersion !== "string" ||
    !/^\d+\.\d+\.\d+$/u.test(metadata.tunnelClientVersion) ||
    (metadata.nativeAppShellVersion !== undefined && (typeof metadata.nativeAppShellVersion !== "number" || !Number.isSafeInteger(metadata.nativeAppShellVersion) || metadata.nativeAppShellVersion < 1)) ||
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
  const runtimeContract = equinoxLocalReleaseRuntimeContract({ target: expectedTarget, version: metadata.version });
  for (const relative of runtimeContract.runtimeExecutables) {
    const executable = await fs.lstat(path.join(releaseDir, relative));
    if (
      !executable.isFile()
      || executable.isSymbolicLink()
      || (runtimeContract.executableModeRequired && (executable.mode & 0o111) === 0)
    ) {
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
  for (const relative of runtimeContract.runtimeDocuments) {
    const document = await fs.lstat(path.join(releaseDir, relative));
    if (!document.isFile() || document.isSymbolicLink()) {
      throw new Error(`Release must contain normal runtime document ${relative}.`);
    }
  }
  for (const relative of runtimeContract.nativeShellFiles) {
    const shellFile = await fs.lstat(path.join(releaseDir, relative));
    if (!shellFile.isFile() || shellFile.isSymbolicLink()) {
      throw new Error(`Release must contain normal native shell file ${relative}.`);
    }
  }
  return Object.freeze(metadata) as ReleaseMetadata;
}

export async function prepareManagedEquinoxRelease({
  installation,
  manifest,
  fetchImpl = globalThis.fetch,
  execFileImpl = execFile,
}:PrepareOptions = {}) {
  if (!installation?.selfUpdateSupported || typeof installation.stagingRoot !== "string" || typeof installation.releasesRoot !== "string") {
    throw new Error("A managed Equinox Local installation is required to prepare an update.");
  }
  if (!manifest?.artifact || typeof manifest.target !== "string" || !MANAGED_TARGET_PATTERN.test(manifest.target)) {
    throw new Error("A verified target-specific update manifest is required.");
  }
  const version = parseEquinoxVersion(manifest.version).text;
  const targetReleaseDir = path.join(installation.releasesRoot, version);
  if (!inside(installation.releasesRoot, targetReleaseDir)) throw new Error("Update release path escaped the managed releases root.");

  try {
    await fs.lstat(targetReleaseDir);
    throw new Error(`Equinox Local ${version} is already present in the managed releases directory.`);
  } catch (error) {
    if (!hasErrorCode(error,"ENOENT")) throw error;
  }

  await fs.mkdir(installation.stagingRoot, { recursive: true, mode: 0o700 });
  await fs.mkdir(installation.releasesRoot, { recursive: true, mode: 0o700 });
  const transactionRoot = path.join(installation.stagingRoot, `update-${version}-${randomBytes(8).toString("hex")}`);
  const archivePath = path.join(transactionRoot, WINDOWS_TARGET_PATTERN.test(manifest.target) ? "release.zip" : "release.tar.gz");
  const extractionRoot = path.join(transactionRoot, "extracted");

  try {
    await downloadVerifiedUpdateArtifact(manifest.artifact, archivePath, { fetchImpl });
    await inspectEquinoxReleaseArchive(archivePath, { target: manifest.target, execFileImpl });
    await extractEquinoxReleaseArchive(archivePath, extractionRoot, { target: manifest.target, execFileImpl });
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
