import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { validateFirstInstallRelease } from "./equinox-local-first-install.js";
import { fingerprintEquinoxLocalNativeState } from "./equinox-local-native-state-fingerprint.js";
import { EQUINOX_LOCAL_SUPPORTED_RELEASE_TARGETS } from "./equinox-local-platform.js";
import { readBoundedNormalFile } from "./equinox-local-safe-file.js";
import type { NativeStateFingerprint } from "./equinox-local-native-state-fingerprint.js";

type NativeFs = typeof fs;
type VerifiedRelease = Awaited<ReturnType<typeof validateFirstInstallRelease>>;
type ReleaseValidator = (dir: string, options: { target: string; fsImpl: NativeFs }) => Promise<VerifiedRelease>;
type FingerprintValidator = (dir: string, options: { fsImpl: NativeFs }) => Promise<NativeStateFingerprint>;
type NativeManifest = Readonly<{
  schemaVersion: 1; channel: "main"; sourceSha: string; target: string;
  runtimeContractSha256: string; artifactSha256: string; artifactBytes: number;
  payloadVersion: string; releaseFingerprint: NativeStateFingerprint;
}>;
type NativePointer = Readonly<{
  schemaVersion: 1; channel: "main"; sourceSha: string; target: string; runtimeContractSha256: string;
}>;
type NativeCandidate = {
  sourceSha: string; target: string; runtimeContractSha256: string; artifactSha256: string;
  artifactBytes: number; payloadVersion: string; releaseDir: string;
};
type NativeOptions = { fsImpl?: NativeFs; validateRelease?: ReleaseValidator; fingerprintRelease?: FingerprintValidator };
type StoreOptions = NativeOptions & {
  transactionRoot: string; sourceSha: string; target: string; expectedRuntimeContractSha256?: string | null;
};
type PromoteOptions = NativeOptions & {
  candidate: NativeCandidate; transactionRoot: string; transactionId: string; randomBytesImpl?: typeof randomBytes;
};
type PointerOptions = NativeOptions & {transactionRoot: string; randomBytesImpl?: typeof randomBytes};
type ManifestExpected = {sourceSha?: string; target?: string; runtimeContractSha256?: string | null};

function hasErrorCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}


const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const TARGETS = new Set<string>(EQUINOX_LOCAL_SUPPORTED_RELEASE_TARGETS);
const MAX_STATE_BYTES = 8 * 1024;
export const EQUINOX_LOCAL_MAIN_NATIVE_STATE_SCHEMA_VERSION = 1;

function assertSha(value: unknown, label = "Main native source SHA"): string {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}
function assertDigest(value: unknown, label = "Main native runtime contract digest"): string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}
function assertTarget(value: unknown): string {
  if (typeof value !== "string" || !TARGETS.has(value)) throw new Error("Main native target is unsupported.");
  return value;
}
function assertTransactionId(value: unknown): string {
  if (typeof value !== "string" || !/^main-[a-f0-9]{32}$/u.test(value)) throw new Error("Main native transaction id is invalid.");
  return value;
}
function assertAbsolute(value: unknown, label: string): string {
  if (typeof value !== "string" || !path.isAbsolute(value) || /[\r\n\0]/u.test(value)) throw new Error(`${label} is invalid.`);
  return path.resolve(value);
}
function exactKeys(value: unknown, keys: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid.`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`${label} contains missing or unsupported fields.`);
}
async function syncDirectory(directory: string, fsImpl: NativeFs) {
  if (process.platform === "win32") return;
  const handle = await fsImpl.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
async function ensureCanonicalDirectory(directory: string, { fsImpl, create = false }: {fsImpl: NativeFs; create?: boolean}) {
  const resolved = path.resolve(directory);
  if (create) await fsImpl.mkdir(resolved, { recursive: true, mode: 0o700 });
  const [stat, real] = await Promise.all([fsImpl.lstat(resolved), fsImpl.realpath(resolved)]);
  if (!stat.isDirectory() || stat.isSymbolicLink() || real !== resolved) throw new Error("Main native state directory is unsafe.");
  return resolved;
}
async function writeAtomicPrivateJson(filePath: string, value: NativeManifest | NativePointer, { fsImpl, randomBytesImpl = randomBytes }: {fsImpl: NativeFs; randomBytesImpl?: typeof randomBytes}) {
  const parent = await ensureCanonicalDirectory(path.dirname(filePath), { fsImpl, create: true });
  const body = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(body) > MAX_STATE_BYTES) throw new Error("Main native state exceeds the size limit.");
  const tempPath = path.join(parent, `.main-native-${randomBytesImpl(8).toString("hex")}.tmp`);
  let handle: Awaited<ReturnType<NativeFs["open"]>> | undefined;
  try {
    handle = await fsImpl.open(tempPath, "wx", 0o600);
    await handle.writeFile(body, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fsImpl.rename(tempPath, filePath);
    await syncDirectory(parent, fsImpl);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fsImpl.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}
function storePaths(transactionRoot: unknown, target: unknown, sourceSha: unknown) {
  const root = assertAbsolute(transactionRoot, "Main native transaction root");
  const resolvedTarget = assertTarget(target);
  const resolvedSha = assertSha(sourceSha);
  const storeRoot = path.join(root, "native-store");
  const targetRoot = path.join(storeRoot, resolvedTarget);
  const payloadRoot = path.join(targetRoot, resolvedSha);
  return Object.freeze({
    transactionRoot: root,
    storeRoot,
    targetRoot,
    payloadRoot,
    releaseDir: path.join(payloadRoot, "release"),
    manifestPath: path.join(payloadRoot, "native-store.json"),
    pointerPath: path.join(root, "current-native.json"),
  });
}
function validateFingerprint(value: unknown): NativeStateFingerprint {
  exactKeys(value, ["schemaVersion", "sha256", "entries", "bytes"], "Main native release fingerprint");
  if (value.schemaVersion !== 1 ||
    typeof value.sha256 !== "string" || !DIGEST_PATTERN.test(value.sha256) ||
    typeof value.entries !== "number" || !Number.isSafeInteger(value.entries) || value.entries < 1 ||
    typeof value.bytes !== "number" || !Number.isSafeInteger(value.bytes) || value.bytes < 1) {
    throw new Error("Main native release fingerprint is invalid.");
  }
  // Preserve the signed manifest's validated wire key order exactly.
  return Object.freeze({ ...value }) as NativeStateFingerprint;
}
function validateStoreManifest(value: unknown, expected: ManifestExpected = {}): NativeManifest {
  exactKeys(value, ["schemaVersion", "channel", "sourceSha", "target", "runtimeContractSha256", "artifactSha256", "artifactBytes", "payloadVersion", "releaseFingerprint"], "Main native store manifest");
  if (value.schemaVersion !== EQUINOX_LOCAL_MAIN_NATIVE_STATE_SCHEMA_VERSION || value.channel !== "main") throw new Error("Main native store manifest identity is invalid.");
  const sourceSha = assertSha(value.sourceSha);
  const target = assertTarget(value.target);
  const runtimeContractSha256 = assertDigest(value.runtimeContractSha256);
  const artifactSha256 = assertDigest(value.artifactSha256, "Main native artifact digest");
  if (typeof value.artifactBytes !== "number" || !Number.isSafeInteger(value.artifactBytes) || value.artifactBytes < 1 || value.artifactBytes > 1024 * 1024 * 1024) throw new Error("Main native artifact byte count is invalid.");
  if (typeof value.payloadVersion !== "string" || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(value.payloadVersion)) throw new Error("Main native payload version is invalid.");
  const releaseFingerprint = validateFingerprint(value.releaseFingerprint);
  if (expected.sourceSha && value.sourceSha !== expected.sourceSha) throw new Error("Main native stored source SHA mismatch.");
  if (expected.target && value.target !== expected.target) throw new Error("Main native stored target mismatch.");
  if (expected.runtimeContractSha256 && value.runtimeContractSha256 !== expected.runtimeContractSha256) throw new Error("Main native stored runtime contract mismatch.");
  // exactKeys and the runtime validators above prove every field; retain
  // the original JSON object order for byte-identical manifest round-trips.
  return Object.freeze({ ...value, releaseFingerprint: Object.freeze({ ...value.releaseFingerprint as Record<string, unknown> }) }) as NativeManifest;
}

export async function inspectEquinoxLocalMainNativeStoredRelease({
  transactionRoot,
  sourceSha,
  target,
  expectedRuntimeContractSha256 = null,
  fsImpl = fs,
  validateRelease = validateFirstInstallRelease,
  fingerprintRelease = fingerprintEquinoxLocalNativeState,
}: StoreOptions) {
  const paths = storePaths(transactionRoot, target, sourceSha);
  await ensureCanonicalDirectory(paths.payloadRoot, { fsImpl });
  const file = await readBoundedNormalFile(paths.manifestPath, { fsImpl, minBytes: 1, maxBytes: MAX_STATE_BYTES, encoding: "utf8", label: "Main native store manifest" });
  let raw;
  try { raw = JSON.parse(file.data); } catch { throw new Error("Main native store manifest contains invalid JSON."); }
  const manifest = validateStoreManifest(raw, { sourceSha, target, runtimeContractSha256: expectedRuntimeContractSha256 });
  const validated = await validateRelease(paths.releaseDir, { target, fsImpl });
  if (validated?.releaseDir !== paths.releaseDir || validated?.target !== target || validated?.version !== manifest.payloadVersion) throw new Error("Main native stored release validation drifted.");
  const fingerprint = await fingerprintRelease(paths.releaseDir, { fsImpl });
  if (fingerprint.sha256 !== manifest.releaseFingerprint.sha256 || fingerprint.entries !== manifest.releaseFingerprint.entries || fingerprint.bytes !== manifest.releaseFingerprint.bytes) {
    throw new Error("Main native stored release fingerprint mismatch.");
  }
  return Object.freeze({ ...paths, sourceSha, target, runtimeContractSha256: manifest.runtimeContractSha256, manifest, payloadVersion: validated.version, tree: validated.tree });
}

export async function promoteEquinoxLocalMainNativeCandidate({
  candidate,
  transactionRoot,
  transactionId,
  fsImpl = fs,
  randomBytesImpl = randomBytes,
  validateRelease = validateFirstInstallRelease,
  fingerprintRelease = fingerprintEquinoxLocalNativeState,
}: PromoteOptions) {
  assertTransactionId(transactionId);
  if (!candidate || typeof candidate !== "object") throw new Error("Main native candidate is required.");
  assertSha(candidate.sourceSha); assertTarget(candidate.target); assertDigest(candidate.runtimeContractSha256);
  assertDigest(candidate.artifactSha256, "Main native artifact digest");
  if (!Number.isSafeInteger(candidate.artifactBytes) || candidate.artifactBytes < 1) throw new Error("Main native candidate artifact bytes are invalid.");
  const paths = storePaths(transactionRoot, candidate.target, candidate.sourceSha);
  const candidateRoot = path.join(paths.transactionRoot, "staging", transactionId, "native-candidate");
  const expectedReleaseDir = path.join(candidateRoot, "release");
  if (path.resolve(candidate.releaseDir ?? "") !== expectedReleaseDir) throw new Error("Main native candidate release path is not transaction-owned.");

  try {
    const stored = await inspectEquinoxLocalMainNativeStoredRelease({ transactionRoot, sourceSha: candidate.sourceSha, target: candidate.target, expectedRuntimeContractSha256: candidate.runtimeContractSha256, fsImpl, validateRelease, fingerprintRelease });
    await fsImpl.rm(candidateRoot, { recursive: true, force: true });
    return Object.freeze({ ...stored, reused: true });
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }

  await ensureCanonicalDirectory(candidateRoot, { fsImpl });
  const validated = await validateRelease(expectedReleaseDir, { target: candidate.target, fsImpl });
  if (validated?.releaseDir !== expectedReleaseDir || validated?.target !== candidate.target || validated?.version !== candidate.payloadVersion) throw new Error("Main native candidate identity drifted before durable promotion.");
  const releaseFingerprint = await fingerprintRelease(expectedReleaseDir, { fsImpl });
  const manifest = validateStoreManifest({
    schemaVersion: EQUINOX_LOCAL_MAIN_NATIVE_STATE_SCHEMA_VERSION,
    channel: "main",
    sourceSha: candidate.sourceSha,
    target: candidate.target,
    runtimeContractSha256: candidate.runtimeContractSha256,
    artifactSha256: candidate.artifactSha256,
    artifactBytes: candidate.artifactBytes,
    payloadVersion: candidate.payloadVersion,
    releaseFingerprint,
  });
  await writeAtomicPrivateJson(path.join(candidateRoot, "native-store.json"), manifest, { fsImpl, randomBytesImpl });
  await ensureCanonicalDirectory(paths.targetRoot, { fsImpl, create: true });
  await fsImpl.rename(candidateRoot, paths.payloadRoot);
  await syncDirectory(paths.targetRoot, fsImpl);
  return Object.freeze({ ...(await inspectEquinoxLocalMainNativeStoredRelease({ transactionRoot, sourceSha: candidate.sourceSha, target: candidate.target, expectedRuntimeContractSha256: candidate.runtimeContractSha256, fsImpl, validateRelease, fingerprintRelease })), reused: false });
}

function validatePointer(value: unknown): NativePointer {
  exactKeys(value, ["schemaVersion", "channel", "sourceSha", "target", "runtimeContractSha256"], "Main native pointer");
  if (value.schemaVersion !== EQUINOX_LOCAL_MAIN_NATIVE_STATE_SCHEMA_VERSION || value.channel !== "main") throw new Error("Main native pointer identity is invalid.");
  assertSha(value.sourceSha); assertTarget(value.target); assertDigest(value.runtimeContractSha256);
  return Object.freeze({ ...value }) as NativePointer;
}

export async function readEquinoxLocalMainNativePointer(pointerPath: unknown, { transactionRoot, fsImpl = fs, validateRelease = validateFirstInstallRelease, fingerprintRelease = fingerprintEquinoxLocalNativeState }: PointerOptions) {
  const resolvedPointer = assertAbsolute(pointerPath, "Main native pointer path");
  const root = assertAbsolute(transactionRoot, "Main native transaction root");
  if (resolvedPointer !== path.join(root, "current-native.json")) throw new Error("Main native pointer path is outside canonical transaction state.");
  const file = await readBoundedNormalFile(resolvedPointer, { fsImpl, minBytes: 1, maxBytes: MAX_STATE_BYTES, encoding: "utf8", label: "Main native pointer" });
  let raw;
  try { raw = JSON.parse(file.data); } catch { throw new Error("Main native pointer contains invalid JSON."); }
  const pointer = validatePointer(raw);
  const stored = await inspectEquinoxLocalMainNativeStoredRelease({ transactionRoot: root, sourceSha: pointer.sourceSha, target: pointer.target, expectedRuntimeContractSha256: pointer.runtimeContractSha256, fsImpl, validateRelease, fingerprintRelease });
  return Object.freeze({ ...pointer, releaseDir: stored.releaseDir, payloadVersion: stored.payloadVersion });
}

export async function writeEquinoxLocalMainNativePointer(pointerPath: unknown, value: unknown, { transactionRoot, fsImpl = fs, randomBytesImpl = randomBytes, validateRelease = validateFirstInstallRelease, fingerprintRelease = fingerprintEquinoxLocalNativeState }: PointerOptions) {
  const root = assertAbsolute(transactionRoot, "Main native transaction root");
  const resolvedPointer = assertAbsolute(pointerPath, "Main native pointer path");
  if (resolvedPointer !== path.join(root, "current-native.json")) throw new Error("Main native pointer path is outside canonical transaction state.");
  const pointer = validatePointer(value);
  await inspectEquinoxLocalMainNativeStoredRelease({ transactionRoot: root, sourceSha: pointer.sourceSha, target: pointer.target, expectedRuntimeContractSha256: pointer.runtimeContractSha256, fsImpl, validateRelease, fingerprintRelease });
  await writeAtomicPrivateJson(resolvedPointer, pointer, { fsImpl, randomBytesImpl });
  return await readEquinoxLocalMainNativePointer(resolvedPointer, { transactionRoot: root, fsImpl, validateRelease, fingerprintRelease });
}

export function equinoxLocalMainNativeStatePaths({ transactionRoot, sourceSha, target }: {transactionRoot: unknown; sourceSha: unknown; target: unknown}) {
  return storePaths(transactionRoot, target, sourceSha);
}
