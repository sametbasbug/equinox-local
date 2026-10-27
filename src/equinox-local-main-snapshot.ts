import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { EQUINOX_LOCAL_SUPPORTED_RELEASE_TARGETS } from "./equinox-local-platform.js";
import { validateEquinoxLocalMainNativeArtifactManifest } from "./equinox-local-main-native-admission.js";
import { validateTrustedMainInstallPointer } from "./equinox-local-main-install-pointer.js";

type NativeSnapshotFs = typeof fs;
type SnapshotFetch = typeof fetch;
type NativeSnapshotIdentity = {
  sourceSha: string; target: string; expectedRuntimeContractSha256: string;
};
type NativeSnapshotTransaction = NativeSnapshotIdentity & {
  transactionRoot: string; transactionId: string; fsImpl?: NativeSnapshotFs;
};
type ManifestFetchOptions = NativeSnapshotIdentity & { fetchImpl?: SnapshotFetch };
type StageOptions = NativeSnapshotTransaction & {
  fetchImpl?: SnapshotFetch; randomBytesImpl?: typeof randomBytes; timeoutMs?: number;
  signedArtifactSha256?: string; signedArtifactBytes?: number;
  signedPointer?: unknown;
};
type ResponseWithBody = Pick<Response, "headers" | "body" | "ok" | "status">;
type OpenHandle = Awaited<ReturnType<NativeSnapshotFs["open"]>>;

const MAIN_SNAPSHOT_ORIGIN = "https://main.local.sametbasbug.dev";
const MAIN_SNAPSHOT_PREFIX = "/snapshots/";
const MAX_MANIFEST_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 8_000;
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const TARGETS: ReadonlySet<string> = new Set(EQUINOX_LOCAL_SUPPORTED_RELEASE_TARGETS);
const TRANSACTION_ID_PATTERN = /^main-[a-f0-9]{32}$/u;
const ARTIFACT_TIMEOUT_MS = 10 * 60 * 1000;

function assertSnapshotIdentity(sourceSha: unknown, target: unknown): void {
  if (typeof sourceSha !== "string" || !SHA_PATTERN.test(sourceSha)) throw new Error("Main snapshot source SHA is invalid.");
  if (typeof target !== "string" || !TARGETS.has(target)) throw new Error("Main snapshot target is unsupported.");
}

function snapshotArtifactExtension(target: string): string {
  return target.startsWith("darwin-") ? ".tar.gz" : ".zip";
}

function snapshotManifestName(sourceSha: string, target: string): string {
  return `equinox-local-main-${sourceSha}-${target}.json`;
}

export function equinoxLocalMainSnapshotManifestUrl(sourceSha: string, target: string): string {
  assertSnapshotIdentity(sourceSha, target);
  return `${MAIN_SNAPSHOT_ORIGIN}${MAIN_SNAPSHOT_PREFIX}${sourceSha}/${snapshotManifestName(sourceSha, target)}`;
}

export function equinoxLocalMainSnapshotArtifactUrl(sourceSha: string, target: string): string {
  assertSnapshotIdentity(sourceSha, target);
  return `${MAIN_SNAPSHOT_ORIGIN}${MAIN_SNAPSHOT_PREFIX}${sourceSha}/equinox-local-main-${sourceSha}-${target}${snapshotArtifactExtension(target)}`;
}

async function readBoundedManifestText(response: ResponseWithBody): Promise<string> {
  const contentLength = response.headers?.get?.("content-length");
  if (contentLength !== null && contentLength !== undefined && contentLength !== "") {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_MANIFEST_BYTES) {
      throw new Error("Main snapshot manifest exceeds the size limit.");
    }
  }
  if (!response.body) throw new Error("Main snapshot manifest response body is unavailable.");

  const chunks: Buffer[] = [];
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
}: ManifestFetchOptions) {
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
    let parsed: unknown;
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


async function assertCanonicalExistingDirectory(directory: unknown, label: string, fsImpl: NativeSnapshotFs): Promise<string> {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) throw new Error(`${label} must be an absolute path.`);
  const resolved = path.resolve(directory);
  const [stat, real] = await Promise.all([fsImpl.lstat(resolved), fsImpl.realpath(resolved)]);
  if (!stat.isDirectory() || stat.isSymbolicLink() || real !== resolved) throw new Error(`${label} must be a canonical normal directory.`);
  return resolved;
}

async function syncDirectory(directory: string, fsImpl: NativeSnapshotFs): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await fsImpl.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

// Windows does not provide POSIX O_NOFOLLOW semantics; pin the lstat
// identity to the opened descriptor against symlinks and file replacement.
async function openPinnedSnapshotFile(filePath: string, fsImpl: NativeSnapshotFs): Promise<OpenHandle> {
  // Read-only open first (POSIX kernel NOFOLLOW). Consume no file bytes
  // before both the descriptor and final pathname have passed validation.
  let handle: OpenHandle;
  try { handle = await fsImpl.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ELOOP") throw new Error("Main snapshot staged file must be a normal, non-symlink file.");
    throw error;
  }
  try {
    const opened = await handle.stat();
    const named = await fsImpl.lstat(filePath);
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 ||
        (process.platform === "win32" && named.dev === 0 && named.ino === 0) ||
        !opened.isFile() || opened.nlink !== 1 || opened.dev !== named.dev || opened.ino !== named.ino) {
      throw new Error("Main snapshot staged file must be a normal, non-symlink file or changed while opening.");
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function readBoundedLocalManifest(filePath: string, fsImpl: NativeSnapshotFs): Promise<unknown> {
  let handle: OpenHandle | undefined;
  try {
    handle = await openPinnedSnapshotFile(filePath, fsImpl);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_MANIFEST_BYTES) throw new Error("Main snapshot staged manifest is not an admissible normal file.");
    // The manifest inode can grow after fstat. Never use unbounded readFile()
    // for mutable staged data: cap descriptor reads at 64 KiB plus one byte.
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= MAX_MANIFEST_BYTES) {
      const buffer = Buffer.allocUnsafe(Math.min(8192, MAX_MANIFEST_BYTES + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > MAX_MANIFEST_BYTES) throw new Error("Main snapshot staged manifest exceeds the size limit.");
    const text = Buffer.concat(chunks, total).toString("utf8");
    try { return JSON.parse(text); } catch { throw new Error("Main snapshot staged manifest is not valid JSON."); }
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function hashExactNormalFile(filePath: string, expectedBytes: number, fsImpl: NativeSnapshotFs) {
  let handle: OpenHandle | undefined;
  try {
    handle = await openPinnedSnapshotFile(filePath, fsImpl);
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
}: NativeSnapshotTransaction) {
  assertSnapshotIdentity(sourceSha, target);
  if (typeof transactionId !== "string" || !TRANSACTION_ID_PATTERN.test(transactionId)) throw new Error("Main snapshot transaction id is invalid.");
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

// The external macOS/Windows installer already downloaded and authenticated
// these native bytes. Reuse the SAME existing durable Main snapshot stage
// without a second CDN download, unsigned override or alternate A/B engine.
export async function stageEquinoxLocalSignedMainLocalArchive({
  signedPointer,
  sourceSha,
  target,
  sourceArchivePath,
  transactionRoot,
  transactionId,
  fsImpl = fs,
  verifySignedPointerImpl = validateTrustedMainInstallPointer,
}: {
  signedPointer:unknown;sourceSha:string;target:string;
  sourceArchivePath:string;transactionRoot:string;transactionId:string;
  fsImpl?:NativeSnapshotFs;
  verifySignedPointerImpl?:typeof validateTrustedMainInstallPointer;
}) {
  const verified = verifySignedPointerImpl(signedPointer,{expectedSourceSha:sourceSha});
  const row = verified.targets.find(entry=>entry.target===target);
  if (!row) throw new Error("Production-signed Main pointer does not authorize the native target.");
  if (typeof sourceArchivePath !== "string" || !path.isAbsolute(sourceArchivePath) ||
      path.resolve(sourceArchivePath) !== sourceArchivePath) {
    throw new Error("Verified Main archive must have a canonical absolute path.");
  }
  const manifest = validateEquinoxLocalMainNativeArtifactManifest({
    schemaVersion:1,channel:"main",sourceSha,target,
    runtimeContractSha256:row.runtimeContractSha256,
    artifact:{
      name:path.posix.basename(new URL(row.artifact.url).pathname),
      sha256:row.artifact.sha256,bytes:row.artifact.bytes,
    },
  },{expectedSourceSha:sourceSha,expectedTarget:target,expectedRuntimeContractSha256:row.runtimeContractSha256});
  const archive = await openPinnedSnapshotFile(sourceArchivePath,fsImpl);
  try {
    const stat = await archive.stat();
    if (stat.size !== row.artifact.bytes) throw new Error("Verified local native archive byte size differs from the signed Main pointer.");
    const manifestUrl = equinoxLocalMainSnapshotManifestUrl(sourceSha,target);
    const artifactUrl = equinoxLocalMainSnapshotArtifactUrl(sourceSha,target);
    let archiveIssued = false;
    const offlineFetch = async (url:string) => {
      if (url === manifestUrl) {
        const json = Buffer.from(JSON.stringify(manifest));
        return {
          ok:true,status:200,headers:{get:(name:string)=>name==="content-length"?String(json.length):null},
          body:(async function*(){yield json;})(),
        } as unknown as Response;
      }
      if (url === artifactUrl && !archiveIssued) {
        archiveIssued=true;
        return {
          ok:true,status:200,
          headers:{get:(name:string)=>name==="content-length"?String(stat.size):null},
          body:(async function*(){
            const buffer=Buffer.allocUnsafe(1024*1024);
            let offset=0;
            while(offset<stat.size){
              const count=Math.min(buffer.length,stat.size-offset);
              const {bytesRead}=await archive.read(buffer,0,count,offset);
              if(bytesRead<1)throw new Error("Verified local native archive ended prematurely.");
              offset+=bytesRead;
              yield Buffer.from(buffer.subarray(0,bytesRead));
            }
          })(),
        } as unknown as Response;
      }
      throw new Error("Local signed Main staging forbids foreign or repeated network fetches.");
    };
    return await stageEquinoxLocalMainSnapshotArtifact({
      sourceSha,target,
      expectedRuntimeContractSha256:row.runtimeContractSha256,
      signedArtifactSha256:row.artifact.sha256,signedArtifactBytes:row.artifact.bytes,
      transactionRoot,transactionId,fsImpl,fetchImpl:offlineFetch as typeof fetch,
    });
  } finally {
    await archive.close();
  }
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
  signedArtifactSha256,
  signedArtifactBytes,
  signedPointer,
}: StageOptions) {
  assertSnapshotIdentity(sourceSha, target);
  if (typeof transactionId !== "string" || !TRANSACTION_ID_PATTERN.test(transactionId)) throw new Error("Main snapshot transaction id is invalid.");
  if (typeof fetchImpl !== "function") throw new Error("Main snapshot network client is unavailable.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30 * 60 * 1000) throw new Error("Main snapshot artifact timeout is invalid.");
  // The signed external installer passes both fields authenticated by the
  // fixed production Ed25519 root. Neither a matching SHA URL nor an
  // unsigned R2 manifest may substitute for this expected archive digest.
  if ((signedArtifactSha256 === undefined) !== (signedArtifactBytes === undefined) ||
      (signedArtifactSha256 !== undefined &&
        (!/^[a-f0-9]{64}$/u.test(signedArtifactSha256) ||
         !Number.isSafeInteger(signedArtifactBytes) || signedArtifactBytes! < 1 ||
         signedArtifactBytes! > 1024*1024*1024))) {
    throw new Error("Signed Main archive size and SHA-256 must be provided together.");
  }
  // A standalone installer must supply the exact production-signed selector,
  // not a mutable R2 manifest with a caller-chosen SHA. Existing Git-backed
  // worker stages are unchanged when this option is absent.
  if (signedPointer !== undefined) {
    const signed = validateTrustedMainInstallPointer(signedPointer,{expectedSourceSha:sourceSha});
    const entry = signed.targets.find(item=>item.target===target);
    if (!entry || entry.runtimeContractSha256 !== expectedRuntimeContractSha256 ||
        (signedArtifactSha256 !== undefined && entry.artifact.sha256 !== signedArtifactSha256) ||
        (signedArtifactBytes !== undefined && entry.artifact.bytes !== signedArtifactBytes)) {
      throw new Error("Main native staging signature does not match expected architecture, contract or archive.");
    }
    signedArtifactSha256 = entry.artifact.sha256;
    signedArtifactBytes = entry.artifact.bytes;
  }

  const root = await assertCanonicalExistingDirectory(transactionRoot, "Main update transaction root", fsImpl);
  const stagingRoot = await assertCanonicalExistingDirectory(path.join(root, "staging"), "Main update staging root", fsImpl);
  const transactionDir = await assertCanonicalExistingDirectory(path.join(stagingRoot, transactionId), "Main update transaction directory", fsImpl);
  const snapshot = await fetchEquinoxLocalMainSnapshotManifest({ sourceSha, target, expectedRuntimeContractSha256, fetchImpl });
  if (signedArtifactSha256 !== undefined &&
      (snapshot.manifest.artifact.sha256 !== signedArtifactSha256 ||
       snapshot.manifest.artifact.bytes !== signedArtifactBytes)) {
    throw new Error("Main R2 manifest differs from the production-signed native archive.");
  }
  const nativeDir = path.join(transactionDir, "native");
  let nativeCreated = false;
  let originalNativeDirectory: { dev: number; ino: number } | null = null;
  let handle: OpenHandle | null = null;
  let originalArtifact: Awaited<ReturnType<OpenHandle["stat"]>> | null = null;
  let tempPath: string | null = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    await fsImpl.mkdir(nativeDir, { recursive: false, mode: 0o700 });
    nativeCreated = true;
    const nativeStat = await fsImpl.lstat(nativeDir);
    if (!nativeStat.isDirectory() || nativeStat.isSymbolicLink() ||
        (process.platform === "win32" && nativeStat.dev === 0 && nativeStat.ino === 0)) {
      throw new Error("Main snapshot native staging directory is not an owned normal directory.");
    }
    originalNativeDirectory = { dev: nativeStat.dev, ino: nativeStat.ino };
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
    originalArtifact = await handle.stat();
    if (!originalArtifact.isFile() || originalArtifact.nlink !== 1) {
      throw new Error("Main snapshot temporary artifact is not an exclusive normal file.");
    }
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
    const beforeLink = await fsImpl.lstat(tempPath);
    if (!beforeLink.isFile() || beforeLink.isSymbolicLink() || beforeLink.nlink !== 1 ||
        beforeLink.dev !== originalArtifact.dev || beforeLink.ino !== originalArtifact.ino) {
      throw new Error("Main snapshot temporary artifact changed from the original inode before publication.");
    }
    await fsImpl.link(tempPath, artifactPath);
    // The pathname can be switched at link() even after the preceding stat.
    // Never certify an alternate same-sized inode using the original digest.
    const published = await fsImpl.lstat(artifactPath);
    if (!published.isFile() || published.isSymbolicLink() ||
        published.dev !== originalArtifact.dev || published.ino !== originalArtifact.ino) {
      throw new Error("Main snapshot staged artifact changed from the original inode during publication.");
    }
    await fsImpl.unlink(tempPath);
    tempPath = null;
    await syncDirectory(nativeDir, fsImpl);
    const finalStat = await fsImpl.lstat(artifactPath);
    if (finalStat.isSymbolicLink() || !finalStat.isFile() || finalStat.nlink !== 1 ||
        finalStat.dev !== originalArtifact.dev || finalStat.ino !== originalArtifact.ino ||
        finalStat.size !== expectedBytes) {
      throw new Error("Main snapshot staged artifact is not the original verified normal file.");
    }
    const manifestPath = path.join(nativeDir, snapshotManifestName(sourceSha, target));
    const manifestBody = `${JSON.stringify(snapshot.manifest, null, 2)}\n`;
    handle = await fsImpl.open(manifestPath, "wx", 0o600);
    const createdManifest = await handle.stat();
    if (!createdManifest.isFile() || createdManifest.nlink !== 1 ||
        (process.platform === "win32" && createdManifest.dev === 0 && createdManifest.ino === 0)) {
      throw new Error("Main snapshot staged manifest is not an exclusive normal file.");
    }
    await handle.writeFile(manifestBody, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await syncDirectory(nativeDir, fsImpl);
    // The published manifest must be the exact descriptor we wrote, not a
    // same-sized replacement inserted between close() and successful return.
    const finalManifest = await fsImpl.lstat(manifestPath);
    if (!finalManifest.isFile() || finalManifest.isSymbolicLink() || finalManifest.nlink !== 1 ||
        finalManifest.dev !== createdManifest.dev || finalManifest.ino !== createdManifest.ino ||
        finalManifest.size !== Buffer.byteLength(manifestBody, "utf8")) {
      throw new Error("Main snapshot staged manifest changed from the original verified inode.");
    }
    // The manifest has the same in-place write exposure as the archive:
    // inode identity and byte length cannot authenticate persisted JSON.
    const manifestOnDisk = await hashExactNormalFile(manifestPath, Buffer.byteLength(manifestBody, "utf8"), fsImpl);
    if (manifestOnDisk.sha256 !== createHash("sha256").update(manifestBody).digest("hex")) {
      throw new Error("Main snapshot persisted staged manifest SHA-256 differs from the verified manifest.");
    }
    // Streaming SHA-256 authenticates the bytes received, not necessarily
    // the bytes persisted to a concurrently writable inode. Before stage()
    // promises success, hash the opened on-disk file by descriptor again.
    const persisted = await hashExactNormalFile(artifactPath, expectedBytes, fsImpl);
    if (persisted.sha256 !== sha256) {
      throw new Error("Main snapshot persisted staged artifact SHA-256 differs from the verified download.");
    }
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
    // Both the artifact temporary pathname and the recursive cleanup live
    // under nativeDir. Never delete another writer's same-named directory
    // (or anything inside it) after our original scratch was displaced.
    if (nativeCreated && originalNativeDirectory) {
      const current = await fsImpl.lstat(nativeDir).catch(() => null);
      if (current?.isDirectory() && !current.isSymbolicLink() &&
          current.dev === originalNativeDirectory.dev && current.ino === originalNativeDirectory.ino) {
        await fsImpl.rm(nativeDir, { recursive: true, force: true }).catch(() => {});
      }
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
