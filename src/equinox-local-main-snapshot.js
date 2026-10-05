import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { EQUINOX_LOCAL_SUPPORTED_RELEASE_TARGETS } from "./equinox-local-platform.js";
import { validateEquinoxLocalMainNativeArtifactManifest } from "./equinox-local-main-native-admission.js";

const MAIN_SNAPSHOT_ORIGIN = "https://main.local.sametbasbug.dev";
const MAIN_SNAPSHOT_PREFIX = "/snapshots/";
const MAX_MANIFEST_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 8_000;
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const TARGETS = new Set(EQUINOX_LOCAL_SUPPORTED_RELEASE_TARGETS);
const TRANSACTION_ID_PATTERN = /^main-[a-f0-9]{32}$/u;
const ARTIFACT_TIMEOUT_MS = 10 * 60 * 1000;

function assertSnapshotIdentity(sourceSha, target) {
  if (!SHA_PATTERN.test(sourceSha ?? "")) throw new Error("Main snapshot source SHA is invalid.");
  if (!TARGETS.has(target)) throw new Error("Main snapshot target is unsupported.");
}

function snapshotArtifactExtension(target) {
  return target.startsWith("darwin-") ? ".tar.gz" : ".zip";
}

function snapshotManifestName(sourceSha, target) {
  return `equinox-local-main-${sourceSha}-${target}.json`;
}

export function equinoxLocalMainSnapshotManifestUrl(sourceSha, target) {
  assertSnapshotIdentity(sourceSha, target);
  return `${MAIN_SNAPSHOT_ORIGIN}${MAIN_SNAPSHOT_PREFIX}${sourceSha}/${snapshotManifestName(sourceSha, target)}`;
}

export function equinoxLocalMainSnapshotArtifactUrl(sourceSha, target) {
  assertSnapshotIdentity(sourceSha, target);
  return `${MAIN_SNAPSHOT_ORIGIN}${MAIN_SNAPSHOT_PREFIX}${sourceSha}/equinox-local-main-${sourceSha}-${target}${snapshotArtifactExtension(target)}`;
}

async function readBoundedManifestText(response) {
  const contentLength = response.headers?.get?.("content-length");
  if (contentLength !== null && contentLength !== undefined && contentLength !== "") {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_MANIFEST_BYTES) {
      throw new Error("Main snapshot manifest exceeds the size limit.");
    }
  }
  if (!response.body) throw new Error("Main snapshot manifest response body is unavailable.");

  const chunks = [];
  let bytes = 0;
  for await (const chunkValue of response.body) {
    const chunk = Buffer.from(chunkValue);
    bytes += chunk.length;
    if (bytes > MAX_MANIFEST_BYTES) throw new Error("Main snapshot manifest exceeds the size limit.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}

export async function fetchEquinoxLocalMainSnapshotManifest({
  sourceSha,
  target,
  expectedRuntimeContractSha256,
  fetchImpl = globalThis.fetch,
} = {}) {
  assertSnapshotIdentity(sourceSha, target);
  if (typeof fetchImpl !== "function") throw new Error("Main snapshot network client is unavailable.");

  const manifestUrl = equinoxLocalMainSnapshotManifestUrl(sourceSha, target);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetchImpl(manifestUrl, {
      method: "GET",
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response?.ok) throw new Error(`Main snapshot server returned HTTP ${response?.status ?? "unknown"}.`);
    const text = await readBoundedManifestText(response);
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("Main snapshot manifest is not valid JSON.");
    }
    const manifest = validateEquinoxLocalMainNativeArtifactManifest(parsed, {
      expectedSourceSha: sourceSha,
      expectedTarget: target,
      expectedRuntimeContractSha256,
    });
    const artifactUrl = equinoxLocalMainSnapshotArtifactUrl(sourceSha, target);
    if (!artifactUrl.endsWith(`/${manifest.artifact.name}`)) {
      throw new Error("Main snapshot artifact URL does not match the exact manifest artifact identity.");
    }
    return Object.freeze({ manifestUrl, artifactUrl, manifest });
  } finally {
    clearTimeout(timer);
  }
}


async function assertCanonicalExistingDirectory(directory, label, fsImpl) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) throw new Error(`${label} must be an absolute path.`);
  const resolved = path.resolve(directory);
  const [stat, real] = await Promise.all([fsImpl.lstat(resolved), fsImpl.realpath(resolved)]);
  if (!stat.isDirectory() || stat.isSymbolicLink() || real !== resolved) throw new Error(`${label} must be a canonical normal directory.`);
  return resolved;
}

async function syncDirectory(directory, fsImpl) {
  if (process.platform === "win32") return;
  const handle = await fsImpl.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function readBoundedLocalManifest(filePath, fsImpl) {
  let handle;
  try {
    handle = await fsImpl.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_MANIFEST_BYTES) throw new Error("Main snapshot staged manifest is not an admissible normal file.");
    const text = await handle.readFile("utf8");
    if (Buffer.byteLength(text, "utf8") > MAX_MANIFEST_BYTES) throw new Error("Main snapshot staged manifest exceeds the size limit.");
    try { return JSON.parse(text); } catch { throw new Error("Main snapshot staged manifest is not valid JSON."); }
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function hashExactNormalFile(filePath, expectedBytes, fsImpl) {
  let handle;
  try {
    handle = await fsImpl.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== expectedBytes) throw new Error("Main snapshot staged artifact byte size does not match the manifest.");
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    while (bytes < expectedBytes) {
      const length = Math.min(buffer.length, expectedBytes - bytes);
      const { bytesRead } = await handle.read(buffer, 0, length, bytes);
      if (bytesRead < 1) throw new Error("Main snapshot staged artifact ended before the manifest byte size.");
      digest.update(buffer.subarray(0, bytesRead));
      bytes += bytesRead;
    }
    return Object.freeze({ bytes, sha256: digest.digest("hex") });
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function inspectStagedEquinoxLocalMainSnapshotArtifact({
  sourceSha,
  target,
  expectedRuntimeContractSha256,
  transactionRoot,
  transactionId,
  fsImpl = fs,
} = {}) {
  assertSnapshotIdentity(sourceSha, target);
  if (!TRANSACTION_ID_PATTERN.test(transactionId ?? "")) throw new Error("Main snapshot transaction id is invalid.");
  const root = await assertCanonicalExistingDirectory(transactionRoot, "Main update transaction root", fsImpl);
  const stagingRoot = await assertCanonicalExistingDirectory(path.join(root, "staging"), "Main update staging root", fsImpl);
  const transactionDir = await assertCanonicalExistingDirectory(path.join(stagingRoot, transactionId), "Main update transaction directory", fsImpl);
  const nativeDir = await assertCanonicalExistingDirectory(path.join(transactionDir, "native"), "Main snapshot native staging directory", fsImpl);
  const manifestPath = path.join(nativeDir, snapshotManifestName(sourceSha, target));
  const manifest = validateEquinoxLocalMainNativeArtifactManifest(await readBoundedLocalManifest(manifestPath, fsImpl), {
    expectedSourceSha: sourceSha,
    expectedTarget: target,
    expectedRuntimeContractSha256,
  });
  const artifactPath = path.join(nativeDir, manifest.artifact.name);
  const artifact = await hashExactNormalFile(artifactPath, manifest.artifact.bytes, fsImpl);
  if (artifact.sha256 !== manifest.artifact.sha256) throw new Error("Main snapshot staged artifact SHA-256 does not match the manifest.");
  const entries = (await fsImpl.readdir(nativeDir)).sort();
  const expectedEntries = [manifest.artifact.name, path.basename(manifestPath)].sort();
  if (entries.length !== expectedEntries.length || entries.some((entry, index) => entry !== expectedEntries[index])) {
    throw new Error("Main snapshot native staging directory contains unexpected entries.");
  }
  return Object.freeze({ sourceSha, target, transactionId, manifest, manifestPath, artifactPath, ...artifact });
}

export async function stageEquinoxLocalMainSnapshotArtifact({
  sourceSha,
  target,
  expectedRuntimeContractSha256,
  transactionRoot,
  transactionId,
  fetchImpl = globalThis.fetch,
  fsImpl = fs,
  randomBytesImpl = randomBytes,
  timeoutMs = ARTIFACT_TIMEOUT_MS,
} = {}) {
  assertSnapshotIdentity(sourceSha, target);
  if (!TRANSACTION_ID_PATTERN.test(transactionId ?? "")) throw new Error("Main snapshot transaction id is invalid.");
  if (typeof fetchImpl !== "function") throw new Error("Main snapshot network client is unavailable.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30 * 60 * 1000) throw new Error("Main snapshot artifact timeout is invalid.");

  const root = await assertCanonicalExistingDirectory(transactionRoot, "Main update transaction root", fsImpl);
  const stagingRoot = await assertCanonicalExistingDirectory(path.join(root, "staging"), "Main update staging root", fsImpl);
  const transactionDir = await assertCanonicalExistingDirectory(path.join(stagingRoot, transactionId), "Main update transaction directory", fsImpl);
  const snapshot = await fetchEquinoxLocalMainSnapshotManifest({ sourceSha, target, expectedRuntimeContractSha256, fetchImpl });
  const nativeDir = path.join(transactionDir, "native");
  let nativeCreated = false;
  let handle = null;
  let tempPath = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    await fsImpl.mkdir(nativeDir, { recursive: false, mode: 0o700 });
    nativeCreated = true;
    const nativeReal = await fsImpl.realpath(nativeDir);
    if (nativeReal !== nativeDir) throw new Error("Main snapshot native staging directory is not canonical.");

    const response = await fetchImpl(snapshot.artifactUrl, {
      method: "GET",
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
      headers: { accept: target.startsWith("darwin-") ? "application/gzip, application/octet-stream" : "application/zip, application/octet-stream" },
      signal: controller.signal,
    });
    if (!response?.ok || !response.body) throw new Error(`Main snapshot artifact server returned HTTP ${response?.status ?? "unknown"}.`);
    const expectedBytes = snapshot.manifest.artifact.bytes;
    const declaredLength = response.headers?.get?.("content-length");
    if (declaredLength !== null && declaredLength !== undefined && declaredLength !== "") {
      const parsed = Number(declaredLength);
      if (!Number.isSafeInteger(parsed) || parsed !== expectedBytes) throw new Error("Main snapshot artifact Content-Length does not match the manifest.");
    }

    tempPath = path.join(nativeDir, `.artifact-part-${randomBytesImpl(8).toString("hex")}`);
    handle = await fsImpl.open(tempPath, "wx", 0o600);
    const digest = createHash("sha256");
    let bytes = 0;
    for await (const chunkValue of response.body) {
      const chunk = Buffer.from(chunkValue);
      bytes += chunk.length;
      if (bytes > expectedBytes) throw new Error("Main snapshot artifact exceeded the manifest byte size.");
      digest.update(chunk);
      await handle.write(chunk);
    }
    await handle.sync();
    await handle.close();
    handle = null;
    if (bytes !== expectedBytes) throw new Error("Main snapshot artifact byte size does not match the manifest.");
    const sha256 = digest.digest("hex");
    if (sha256 !== snapshot.manifest.artifact.sha256) throw new Error("Main snapshot artifact SHA-256 verification failed.");

    const artifactPath = path.join(nativeDir, snapshot.manifest.artifact.name);
    await fsImpl.link(tempPath, artifactPath);
    await fsImpl.unlink(tempPath);
    tempPath = null;
    await syncDirectory(nativeDir, fsImpl);
    const finalStat = await fsImpl.lstat(artifactPath);
    if (finalStat.isSymbolicLink() || !finalStat.isFile() || finalStat.size !== expectedBytes) throw new Error("Main snapshot staged artifact is not the verified normal file.");
    const manifestPath = path.join(nativeDir, snapshotManifestName(sourceSha, target));
    const manifestBody = `${JSON.stringify(snapshot.manifest, null, 2)}\n`;
    handle = await fsImpl.open(manifestPath, "wx", 0o600);
    await handle.writeFile(manifestBody, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await syncDirectory(nativeDir, fsImpl);
    return Object.freeze({
      sourceSha,
      target,
      transactionId,
      manifest: snapshot.manifest,
      manifestPath,
      manifestUrl: snapshot.manifestUrl,
      artifactUrl: snapshot.artifactUrl,
      artifactPath,
      bytes,
      sha256,
    });
  } catch (error) {
    await handle?.close().catch(() => {});
    if (tempPath) await fsImpl.rm(tempPath, { force: true }).catch(() => {});
    if (nativeCreated) await fsImpl.rm(nativeDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
