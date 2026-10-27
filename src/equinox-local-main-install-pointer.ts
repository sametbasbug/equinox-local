import { sign as signBytes, verify as verifyBytes, type KeyObject } from "node:crypto";

import { validateEquinoxLocalMainNativeArtifactManifest } from "./equinox-local-main-native-admission.js";
import { EQUINOX_LOCAL_SUPPORTED_RELEASE_TARGETS } from "./equinox-local-platform.js";
import { parseEquinoxVersion } from "./equinox-local-updater.js";

const SHA = /^[a-f0-9]{40}$/u;
const KEY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const PUBLIC_BASE = "https://main.local.sametbasbug.dev/snapshots/";
const TARGETS = [...EQUINOX_LOCAL_SUPPORTED_RELEASE_TARGETS];

type NativeManifest = ReturnType<typeof validateEquinoxLocalMainNativeArtifactManifest>;
type SignedTarget = Readonly<{
  target: string;
  runtimeContractSha256: string;
  artifact: Readonly<{ url: string; sha256: string; bytes: number }>;
}>;
type PointerPayload = Readonly<{
  schemaVersion: 1;
  channel: "main";
  sourceSha: string;
  version: string;
  publishedAt: string;
  targets: readonly SignedTarget[];
}>;
type SignedPointer = PointerPayload & Readonly<{
  signature: Readonly<{ algorithm: "ed25519"; keyId: string; value: string }>;
}>;

function fields(raw: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(label + " must be an object.");
  const object = raw as Record<string, unknown>;
  if (Object.keys(object).sort().join(",") !== [...keys].sort().join(",")) {
    throw new Error(label + " fields are invalid.");
  }
  return object;
}

function exactSourceSha(value: unknown): string {
  if (typeof value !== "string" || !SHA.test(value)) throw new Error("Main install source SHA is invalid.");
  return value;
}

function normalizePayload(value: unknown): PointerPayload {
  const input = fields(value, ["schemaVersion", "channel", "sourceSha", "version", "publishedAt", "targets"], "Signed Main payload");
  if (input.schemaVersion !== 1 || input.channel !== "main") throw new Error("Signed Main payload identity is invalid.");
  const sourceSha = exactSourceSha(input.sourceSha);
  const version = parseEquinoxVersion(input.version).text;
  if (typeof input.publishedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(input.publishedAt) ||
    Number.isNaN(Date.parse(input.publishedAt)) ||
    new Date(input.publishedAt).toISOString() !== input.publishedAt) {
    throw new Error("Signed Main publication timestamp is invalid.");
  }
  if (!Array.isArray(input.targets) || input.targets.length !== TARGETS.length) {
    throw new Error("Signed Main must carry exactly four native targets.");
  }
  const targets = input.targets.map((raw, index): SignedTarget => {
    const entry = fields(raw, ["target", "runtimeContractSha256", "artifact"], "Signed Main target");
    if (entry.target !== TARGETS[index]) throw new Error("Signed Main target order or coverage is invalid.");
    const artifact = fields(entry.artifact, ["url", "sha256", "bytes"], "Signed Main artifact");
    const target = entry.target as string;
    const native = validateEquinoxLocalMainNativeArtifactManifest({
      schemaVersion: 1,
      channel: "main",
      sourceSha,
      target,
      runtimeContractSha256: entry.runtimeContractSha256,
      artifact: {
        name: "equinox-local-main-" + sourceSha + "-" + target +
          (target.startsWith("win32-") ? ".zip" : ".tar.gz"),
        sha256: artifact.sha256,
        bytes: artifact.bytes,
      },
    }, { expectedSourceSha: sourceSha, expectedTarget: target });
    const url = PUBLIC_BASE + sourceSha + "/" + native.artifact.name;
    if (artifact.url !== url) throw new Error("Signed Main artifact URL must bind the exact SHA and target on public R2.");
    return Object.freeze({
      target,
      runtimeContractSha256: native.runtimeContractSha256,
      artifact: Object.freeze({
        url,
        sha256: native.artifact.sha256,
        bytes: native.artifact.bytes,
      }),
    });
  });
  return Object.freeze({
    schemaVersion: 1 as const,
    channel: "main" as const,
    sourceSha,
    version,
    publishedAt: input.publishedAt,
    targets: Object.freeze(targets),
  });
}

export function canonicalMainInstallPointerPayload(payload: PointerPayload): string {
  return JSON.stringify(normalizePayload(payload));
}

export function createSignedMainInstallPointer({
  sourceSha, version, publishedAt, nativeManifests, keyId, privateKey,
}: {
  sourceSha: string; version: string; publishedAt: string;
  nativeManifests: readonly unknown[]; keyId: string; privateKey: KeyObject;
}): SignedPointer {
  const sha = exactSourceSha(sourceSha);
  if (!Array.isArray(nativeManifests) || nativeManifests.length !== TARGETS.length) {
    throw new Error("Four admitted Main native manifests are required for signing.");
  }
  if (!KEY_ID.test(keyId) || privateKey?.asymmetricKeyType !== "ed25519" || privateKey.type !== "private") {
    throw new Error("An existing Ed25519 private signing key and valid key ID are required.");
  }
  const native = nativeManifests.map((entry, i) =>
    validateEquinoxLocalMainNativeArtifactManifest(entry, { expectedSourceSha: sha, expectedTarget: TARGETS[i]! }));
  const payload = normalizePayload({
    schemaVersion: 1,
    channel: "main",
    sourceSha: sha,
    version,
    publishedAt,
    targets: native.map((entry: NativeManifest) => ({
      target: entry.target,
      runtimeContractSha256: entry.runtimeContractSha256,
      artifact: {
        url: PUBLIC_BASE + sha + "/" + entry.artifact.name,
        sha256: entry.artifact.sha256,
        bytes: entry.artifact.bytes,
      },
    })),
  });
  return Object.freeze({
    ...payload,
    signature: Object.freeze({
      algorithm: "ed25519" as const,
      keyId,
      value: signBytes(null, Buffer.from(JSON.stringify(payload), "utf8"), privateKey).toString("base64"),
    }),
  });
}

export function validateSignedMainInstallPointer(value: unknown, {
  publicKeys, expectedSourceSha,
}: {
  publicKeys: Readonly<Record<string, string>>; expectedSourceSha?: string;
}): SignedPointer {
  const record = fields(value, ["schemaVersion", "channel", "sourceSha", "version", "publishedAt", "targets", "signature"], "Signed Main pointer");
  const signature = fields(record.signature, ["algorithm", "keyId", "value"], "Signed Main signature");
  if (signature.algorithm !== "ed25519" || typeof signature.keyId !== "string" || !KEY_ID.test(signature.keyId)) {
    throw new Error("Signed Main signature identity is invalid.");
  }
  const key = publicKeys?.[signature.keyId];
  if (typeof key !== "string" || !key.includes("BEGIN PUBLIC KEY")) {
    throw new Error("Signed Main pointer has no trusted public signing key.");
  }
  if (typeof signature.value !== "string" || signature.value.length > 256) {
    throw new Error("Signed Main signature value is invalid.");
  }
  const bytes = Buffer.from(signature.value, "base64");
  if (bytes.length !== 64 || bytes.toString("base64") !== signature.value) {
    throw new Error("Signed Main signature is not canonical Ed25519 base64.");
  }
  const payload = normalizePayload({
    schemaVersion: record.schemaVersion, channel: record.channel,
    sourceSha: record.sourceSha, version: record.version, publishedAt: record.publishedAt,
    targets: record.targets,
  });
  if (expectedSourceSha !== undefined && payload.sourceSha !== exactSourceSha(expectedSourceSha)) {
    throw new Error("Signed Main pointer does not match the expected SHA.");
  }
  if (!verifyBytes(null, Buffer.from(JSON.stringify(payload), "utf8"), key, bytes)) {
    throw new Error("Signed Main pointer signature verification failed.");
  }
  return Object.freeze({
    ...payload,
    signature: Object.freeze({
      algorithm: "ed25519",
      keyId: signature.keyId,
      value: signature.value,
    }),
  });
}
