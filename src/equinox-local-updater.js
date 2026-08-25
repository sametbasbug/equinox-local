import { verify as verifySignature } from "node:crypto";

export const EQUINOX_LOCAL_UPDATE_SCHEMA_VERSION = 1;
export const EQUINOX_LOCAL_UPDATE_CHANNEL = "stable";
export const EQUINOX_LOCAL_SUPPORTED_UPDATE_TARGETS = Object.freeze(["darwin-arm64", "darwin-x64"]);

const UPDATE_ORIGIN = "https://local.sametbasbug.dev";
const UPDATE_PATH_PREFIX = "/downloads/updates/";
const MAX_MANIFEST_BYTES = 64 * 1024;
const CHECK_TIMEOUT_MS = 8_000;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const UPDATE_TARGET_SET = new Set(EQUINOX_LOCAL_SUPPORTED_UPDATE_TARGETS);

export function equinoxLocalUpdateTarget({ platform = process.platform, arch = process.arch } = {}) {
  const target = `${platform}-${arch}`;
  if (!UPDATE_TARGET_SET.has(target)) {
    throw new Error(`Unsupported Equinox Local update target: ${target}`);
  }
  return target;
}

export function equinoxLocalUpdateManifestUrl(target) {
  if (!UPDATE_TARGET_SET.has(target)) throw new Error(`Unsupported Equinox Local update target: ${target}`);
  return `${UPDATE_ORIGIN}${UPDATE_PATH_PREFIX}stable-${target}.json`;
}

function boundedMessage(value) {
  return String(value ?? "")
    .replace(/[\r\n\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 300);
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value;
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} contains missing or unsupported fields.`);
  }
}

export function parseEquinoxVersion(value) {
  if (typeof value !== "string") throw new Error("Version must be text.");
  const match = VERSION_PATTERN.exec(value);
  if (!match) throw new Error(`Unsupported Equinox Local version: ${value}`);
  return Object.freeze({
    text: value,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  });
}

export function compareEquinoxVersions(left, right) {
  const a = typeof left === "string" ? parseEquinoxVersion(left) : left;
  const b = typeof right === "string" ? parseEquinoxVersion(right) : right;
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return 0;
}

function normalizeHttpsUpdateUrl(value, label) {
  if (typeof value !== "string" || value.length > 2048) throw new Error(`${label} is invalid.`);
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.origin !== UPDATE_ORIGIN ||
    !url.pathname.startsWith(UPDATE_PATH_PREFIX) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${label} must stay on the pinned Equinox Local HTTPS update path.`);
  }
  return url.href;
}

export function canonicalUpdateManifestPayload(manifest) {
  return JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    channel: manifest.channel,
    target: manifest.target,
    version: manifest.version,
    publishedAt: manifest.publishedAt,
    artifact: {
      url: manifest.artifact.url,
      sha256: manifest.artifact.sha256,
      bytes: manifest.artifact.bytes,
    },
  });
}

export function validateSignedUpdateManifest(raw, {
  publicKeys,
  target = equinoxLocalUpdateTarget(),
  manifestUrl = equinoxLocalUpdateManifestUrl(target),
} = {}) {
  const manifest = assertPlainObject(raw, "Update manifest");
  assertExactKeys(
    manifest,
    ["schemaVersion", "channel", "target", "version", "publishedAt", "artifact", "signature"],
    "Update manifest",
  );
  if (manifest.schemaVersion !== EQUINOX_LOCAL_UPDATE_SCHEMA_VERSION) {
    throw new Error("Unsupported update manifest schema.");
  }
  if (manifest.channel !== EQUINOX_LOCAL_UPDATE_CHANNEL) throw new Error("Unexpected update channel.");
  if (!UPDATE_TARGET_SET.has(target) || manifest.target !== target) {
    throw new Error("Update manifest target does not match this Equinox Local build.");
  }
  parseEquinoxVersion(manifest.version);
  if (typeof manifest.publishedAt !== "string" || Number.isNaN(Date.parse(manifest.publishedAt))) {
    throw new Error("Update publishedAt is invalid.");
  }

  const normalizedManifestUrl = normalizeHttpsUpdateUrl(manifestUrl, "Manifest URL");
  if (normalizedManifestUrl !== equinoxLocalUpdateManifestUrl(target)) {
    throw new Error("Update manifest URL is not the pinned stable manifest for this build target.");
  }

  const artifact = assertPlainObject(manifest.artifact, "Update artifact");
  assertExactKeys(artifact, ["url", "sha256", "bytes"], "Update artifact");
  const artifactUrl = normalizeHttpsUpdateUrl(artifact.url, "Artifact URL");
  if (!/^[a-f0-9]{64}$/u.test(artifact.sha256)) {
    throw new Error("Update artifact SHA-256 is invalid.");
  }
  if (
    !Number.isSafeInteger(artifact.bytes) ||
    artifact.bytes < 1 ||
    artifact.bytes > 1024 * 1024 * 1024
  ) {
    throw new Error("Update artifact byte size is invalid.");
  }

  const signature = assertPlainObject(manifest.signature, "Update signature");
  assertExactKeys(signature, ["algorithm", "keyId", "value"], "Update signature");
  if (signature.algorithm !== "ed25519") throw new Error("Unsupported update signature algorithm.");
  if (typeof signature.keyId !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(signature.keyId)) {
    throw new Error("Update signature key id is invalid.");
  }
  if (typeof signature.value !== "string" || signature.value.length < 40 || signature.value.length > 256) {
    throw new Error("Update signature value is invalid.");
  }

  const publicKey = publicKeys?.[signature.keyId];
  if (typeof publicKey !== "string" || !publicKey.includes("BEGIN PUBLIC KEY")) {
    throw new Error("Update signature key is not trusted by this Equinox Local build.");
  }

  const signatureBytes = Buffer.from(signature.value, "base64");
  if (signatureBytes.length !== 64 || signatureBytes.toString("base64") !== signature.value) {
    throw new Error("Update signature is not canonical Ed25519 base64.");
  }

  const normalized = Object.freeze({
    schemaVersion: manifest.schemaVersion,
    channel: manifest.channel,
    target: manifest.target,
    version: manifest.version,
    publishedAt: new Date(manifest.publishedAt).toISOString(),
    artifact: Object.freeze({
      url: artifactUrl,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
    }),
    signature: Object.freeze({
      algorithm: signature.algorithm,
      keyId: signature.keyId,
      value: signature.value,
    }),
  });

  const verified = verifySignature(
    null,
    Buffer.from(canonicalUpdateManifestPayload(normalized), "utf8"),
    publicKey,
    signatureBytes,
  );
  if (!verified) throw new Error("Update manifest signature verification failed.");
  return normalized;
}

async function fetchManifestText(fetchImpl, manifestUrl) {
  if (typeof fetchImpl !== "function") throw new Error("Update network client is unavailable.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
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
    if (!response?.ok) throw new Error(`Update server returned HTTP ${response?.status ?? "unknown"}.`);
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_MANIFEST_BYTES) {
      throw new Error("Update manifest exceeds the size limit.");
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

export function createEquinoxLocalUpdater({
  currentVersion,
  installation,
  publicKeys = {},
  target = equinoxLocalUpdateTarget(),
  manifestUrl = equinoxLocalUpdateManifestUrl(target),
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
} = {}) {
  parseEquinoxVersion(currentVersion);
  const trustedKeyCount = Object.keys(publicKeys).length;
  const configured = trustedKeyCount > 0;
  const selfUpdateSupported = Boolean(installation?.selfUpdateSupported && configured);
  const state = {
    checkedAt: null,
    latestVersion: null,
    updateAvailable: null,
    publishedAt: null,
    artifactBytes: null,
    lastError: null,
    candidate: null,
  };

  const snapshot = () => Object.freeze({
    currentVersion,
    channel: EQUINOX_LOCAL_UPDATE_CHANNEL,
    target,
    installationKind: installation?.kind ?? "source",
    managedInstallation: Boolean(installation?.managed),
    configured,
    selfUpdateSupported,
    trustedKeyCount,
    checkedAt: state.checkedAt,
    latestVersion: state.latestVersion,
    updateAvailable: state.updateAvailable,
    publishedAt: state.publishedAt,
    artifactBytes: state.artifactBytes,
    lastError: state.lastError,
    reason: !installation?.selfUpdateSupported
      ? boundedMessage(installation?.reason || "Self-update is unavailable for this installation.")
      : !configured
        ? "The stable update signing key has not been provisioned in this build yet."
        : null,
  });

  const check = async () => {
    if (!installation?.selfUpdateSupported || !configured) return snapshot();
    try {
      const text = await fetchManifestText(fetchImpl, manifestUrl);
      let raw;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new Error("Update server returned invalid JSON.");
      }
      const manifest = validateSignedUpdateManifest(raw, { publicKeys, target, manifestUrl });
      state.checkedAt = now().toISOString();
      state.latestVersion = manifest.version;
      state.updateAvailable = compareEquinoxVersions(currentVersion, manifest.version) < 0;
      state.publishedAt = manifest.publishedAt;
      state.artifactBytes = manifest.artifact.bytes;
      state.lastError = null;
      state.candidate = state.updateAvailable ? manifest : null;
      return snapshot();
    } catch (error) {
      state.checkedAt = now().toISOString();
      state.updateAvailable = null;
      state.candidate = null;
      state.lastError = boundedMessage(error instanceof Error ? error.message : error);
      throw error;
    }
  };

  const candidate = () => state.candidate;
  return Object.freeze({ snapshot, check, candidate });
}
