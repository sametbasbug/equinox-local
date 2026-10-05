import { EQUINOX_LOCAL_SUPPORTED_RELEASE_TARGETS } from "./equinox-local-platform.js";
import { validateEquinoxLocalMainNativeArtifactManifest } from "./equinox-local-main-native-admission.js";

const MAIN_SNAPSHOT_ORIGIN = "https://main.local.sametbasbug.dev";
const MAIN_SNAPSHOT_PREFIX = "/snapshots/";
const MAX_MANIFEST_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 8_000;
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const TARGETS = new Set(EQUINOX_LOCAL_SUPPORTED_RELEASE_TARGETS);

function assertSnapshotIdentity(sourceSha, target) {
  if (!SHA_PATTERN.test(sourceSha ?? "")) throw new Error("Main snapshot source SHA is invalid.");
  if (!TARGETS.has(target)) throw new Error("Main snapshot target is unsupported.");
}

function snapshotArtifactExtension(target) {
  return target.startsWith("darwin-") ? ".tar.gz" : ".zip";
}

export function equinoxLocalMainSnapshotManifestUrl(sourceSha, target) {
  assertSnapshotIdentity(sourceSha, target);
  return `${MAIN_SNAPSHOT_ORIGIN}${MAIN_SNAPSHOT_PREFIX}${sourceSha}/equinox-local-main-${sourceSha}-${target}.json`;
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
