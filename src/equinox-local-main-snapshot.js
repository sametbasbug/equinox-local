import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { EQUINOX_LOCAL_SUPPORTED_RELEASE_TARGETS } from "./equinox-local-platform.js";
import { validateEquinoxLocalMainNativeArtifactManifest } from "./equinox-local-main-native-admission.js";
import { validateSignedMainNativeBAuthorization } from "./equinox-local-main-native-b-authorization.js";
const MAIN_SNAPSHOT_ORIGIN = "https://main.local.sametbasbug.dev";
const MAIN_SNAPSHOT_PREFIX = "/snapshots/";
const MAX_MANIFEST_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 8_000;
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const TARGETS = new Set(EQUINOX_LOCAL_SUPPORTED_RELEASE_TARGETS);
const TRANSACTION_ID_PATTERN = /^main-[a-f0-9]{32}$/u;
const ARTIFACT_TIMEOUT_MS = 10 * 60 * 1000;
function assertSnapshotIdentity(sourceSha, target) {
    if (typeof sourceSha !== "string" || !SHA_PATTERN.test(sourceSha))
        throw new Error("Main snapshot source SHA is invalid.");
    if (typeof target !== "string" || !TARGETS.has(target))
        throw new Error("Main snapshot target is unsupported.");
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
// Domain-separated, exact-SHA sibling to the old unsigned Main snapshot manifest.
// This is a read-only opt-in fetch boundary until the production FD3 signer
// publishes a genuine B authorization for the immutable four-OS artifact set.
export function equinoxLocalMainSnapshotBAuthorizationUrl(sourceSha, target) {
    assertSnapshotIdentity(sourceSha, target);
    return `${MAIN_SNAPSHOT_ORIGIN}${MAIN_SNAPSHOT_PREFIX}${sourceSha}/equinox-local-main-${sourceSha}-${target}.b-authorization.json`;
}
export async function fetchEquinoxLocalSignedMainBPublication({ previousSourceSha, sourceSha, target, expectedRuntimeContractSha256, fetchImpl = globalThis.fetch, publicKeys, }) {
    if (typeof previousSourceSha !== "string" || !SHA_PATTERN.test(previousSourceSha) || previousSourceSha === sourceSha) {
        throw new Error("Signed Main B publication requires a distinct exact previous Main commit SHA.");
    }
    const original = await fetchEquinoxLocalMainSnapshotManifest({
        sourceSha, target, expectedRuntimeContractSha256, fetchImpl,
    });
    const authorizationUrl = equinoxLocalMainSnapshotBAuthorizationUrl(sourceSha, target);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    timer.unref?.();
    try {
        const response = await fetchImpl(authorizationUrl, {
            method: "GET", redirect: "error", cache: "no-store", credentials: "omit",
            headers: { accept: "application/json" }, signal: controller.signal,
        });
        if (!response?.ok)
            throw new Error(`Signed Main B authorization returned HTTP ${response?.status ?? "unknown"}.`);
        const text = await readBoundedManifestText(response);
        let parsed;
        try {
            parsed = JSON.parse(text);
        }
        catch {
            throw new Error("Signed Main B authorization is not valid JSON.");
        }
        const authorization = validateSignedMainNativeBAuthorization(parsed, {
            ...(publicKeys === undefined ? {} : { publicKeys }),
            expected: {
                schemaVersion: 2, channel: "main", sourceSha, target: target,
                runtimeContractSha256: expectedRuntimeContractSha256,
                artifact: { sha256: original.manifest.artifact.sha256, bytes: original.manifest.artifact.bytes },
            },
        });
        return Object.freeze({ ...original, authorizationUrl, authorization });
    }
    finally {
        clearTimeout(timer);
    }
}
async function readBoundedManifestText(response) {
    const contentLength = response.headers?.get?.("content-length");
    if (contentLength !== null && contentLength !== undefined && contentLength !== "") {
        const parsed = Number(contentLength);
        if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_MANIFEST_BYTES) {
            throw new Error("Main snapshot manifest exceeds the size limit.");
        }
    }
    if (!response.body)
        throw new Error("Main snapshot manifest response body is unavailable.");
    const chunks = [];
    let bytes = 0;
    for await (const chunkValue of response.body) {
        const chunk = Buffer.from(chunkValue);
        bytes += chunk.length;
        if (bytes > MAX_MANIFEST_BYTES)
            throw new Error("Main snapshot manifest exceeds the size limit.");
        chunks.push(chunk);
    }
    return Buffer.concat(chunks, bytes).toString("utf8");
}
export async function fetchEquinoxLocalMainSnapshotManifest({ sourceSha, target, expectedRuntimeContractSha256, fetchImpl = globalThis.fetch, }) {
    assertSnapshotIdentity(sourceSha, target);
    if (typeof fetchImpl !== "function")
        throw new Error("Main snapshot network client is unavailable.");
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
        if (!response?.ok)
            throw new Error(`Main snapshot server returned HTTP ${response?.status ?? "unknown"}.`);
        const text = await readBoundedManifestText(response);
        let parsed;
        try {
            parsed = JSON.parse(text);
        }
        catch {
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
    }
    finally {
        clearTimeout(timer);
    }
}
async function assertCanonicalExistingDirectory(directory, label, fsImpl) {
    if (typeof directory !== "string" || !path.isAbsolute(directory))
        throw new Error(`${label} must be an absolute path.`);
    const resolved = path.resolve(directory);
    const [stat, real] = await Promise.all([fsImpl.lstat(resolved), fsImpl.realpath(resolved)]);
    if (!stat.isDirectory() || stat.isSymbolicLink() || real !== resolved)
        throw new Error(`${label} must be a canonical normal directory.`);
    return resolved;
}
async function syncDirectory(directory, fsImpl) {
    if (process.platform === "win32")
        return;
    const handle = await fsImpl.open(directory, "r");
    try {
        await handle.sync();
    }
    finally {
        await handle.close();
    }
}
// Windows does not provide POSIX O_NOFOLLOW semantics; pin the lstat
// identity to the opened descriptor against symlinks and file replacement.
async function openPinnedSnapshotFile(filePath, fsImpl) {
    // Read-only open first (POSIX kernel NOFOLLOW). Consume no file bytes
    // before both the descriptor and final pathname have passed validation.
    let handle;
    try {
        handle = await fsImpl.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    }
    catch (error) {
        if (error?.code === "ELOOP")
            throw new Error("Main snapshot staged file must be a normal, non-symlink file.");
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
    }
    catch (error) {
        await handle.close().catch(() => { });
        throw error;
    }
}
async function readBoundedLocalManifest(filePath, fsImpl) {
    let handle;
    try {
        handle = await openPinnedSnapshotFile(filePath, fsImpl);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size < 1 || stat.size > MAX_MANIFEST_BYTES)
            throw new Error("Main snapshot staged manifest is not an admissible normal file.");
        // The manifest inode can grow after fstat. Never use unbounded readFile()
        // for mutable staged data: cap descriptor reads at 64 KiB plus one byte.
        const chunks = [];
        let total = 0;
        while (total <= MAX_MANIFEST_BYTES) {
            const buffer = Buffer.allocUnsafe(Math.min(8192, MAX_MANIFEST_BYTES + 1 - total));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
            if (bytesRead === 0)
                break;
            chunks.push(buffer.subarray(0, bytesRead));
            total += bytesRead;
        }
        if (total > MAX_MANIFEST_BYTES)
            throw new Error("Main snapshot staged manifest exceeds the size limit.");
        const text = Buffer.concat(chunks, total).toString("utf8");
        try {
            return JSON.parse(text);
        }
        catch {
            throw new Error("Main snapshot staged manifest is not valid JSON.");
        }
    }
    finally {
        await handle?.close().catch(() => { });
    }
}
async function hashExactNormalFile(filePath, expectedBytes, fsImpl) {
    let handle;
    try {
        handle = await openPinnedSnapshotFile(filePath, fsImpl);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size !== expectedBytes)
            throw new Error("Main snapshot staged artifact byte size does not match the manifest.");
        const digest = createHash("sha256");
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        let bytes = 0;
        while (bytes < expectedBytes) {
            const length = Math.min(buffer.length, expectedBytes - bytes);
            const { bytesRead } = await handle.read(buffer, 0, length, bytes);
            if (bytesRead < 1)
                throw new Error("Main snapshot staged artifact ended before the manifest byte size.");
            digest.update(buffer.subarray(0, bytesRead));
            bytes += bytesRead;
        }
        return Object.freeze({ bytes, sha256: digest.digest("hex") });
    }
    finally {
        await handle?.close().catch(() => { });
    }
}
export async function inspectStagedEquinoxLocalMainSnapshotArtifact({ sourceSha, target, expectedRuntimeContractSha256, transactionRoot, transactionId, fsImpl = fs, }) {
    assertSnapshotIdentity(sourceSha, target);
    if (typeof transactionId !== "string" || !TRANSACTION_ID_PATTERN.test(transactionId))
        throw new Error("Main snapshot transaction id is invalid.");
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
    if (artifact.sha256 !== manifest.artifact.sha256)
        throw new Error("Main snapshot staged artifact SHA-256 does not match the manifest.");
    const entries = (await fsImpl.readdir(nativeDir)).sort();
    const expectedEntries = [manifest.artifact.name, path.basename(manifestPath)].sort();
    if (entries.length !== expectedEntries.length || entries.some((entry, index) => entry !== expectedEntries[index])) {
        throw new Error("Main snapshot native staging directory contains unexpected entries.");
    }
    return Object.freeze({ sourceSha, target, transactionId, manifest, manifestPath, artifactPath, ...artifact });
}
export async function stageEquinoxLocalMainSnapshotArtifact({ sourceSha, target, expectedRuntimeContractSha256, transactionRoot, transactionId, fetchImpl = globalThis.fetch, fsImpl = fs, randomBytesImpl = randomBytes, timeoutMs = ARTIFACT_TIMEOUT_MS, }) {
    assertSnapshotIdentity(sourceSha, target);
    if (typeof transactionId !== "string" || !TRANSACTION_ID_PATTERN.test(transactionId))
        throw new Error("Main snapshot transaction id is invalid.");
    if (typeof fetchImpl !== "function")
        throw new Error("Main snapshot network client is unavailable.");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30 * 60 * 1000)
        throw new Error("Main snapshot artifact timeout is invalid.");
    const root = await assertCanonicalExistingDirectory(transactionRoot, "Main update transaction root", fsImpl);
    const stagingRoot = await assertCanonicalExistingDirectory(path.join(root, "staging"), "Main update staging root", fsImpl);
    const transactionDir = await assertCanonicalExistingDirectory(path.join(stagingRoot, transactionId), "Main update transaction directory", fsImpl);
    const snapshot = await fetchEquinoxLocalMainSnapshotManifest({ sourceSha, target, expectedRuntimeContractSha256, fetchImpl });
    const nativeDir = path.join(transactionDir, "native");
    let nativeCreated = false;
    let originalNativeDirectory = null;
    let handle = null;
    let originalArtifact = null;
    let tempPath = null;
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
        if (nativeReal !== nativeDir)
            throw new Error("Main snapshot native staging directory is not canonical.");
        const response = await fetchImpl(snapshot.artifactUrl, {
            method: "GET",
            redirect: "error",
            cache: "no-store",
            credentials: "omit",
            headers: { accept: target.startsWith("darwin-") ? "application/gzip, application/octet-stream" : "application/zip, application/octet-stream" },
            signal: controller.signal,
        });
        if (!response?.ok || !response.body)
            throw new Error(`Main snapshot artifact server returned HTTP ${response?.status ?? "unknown"}.`);
        const expectedBytes = snapshot.manifest.artifact.bytes;
        const declaredLength = response.headers?.get?.("content-length");
        if (declaredLength !== null && declaredLength !== undefined && declaredLength !== "") {
            const parsed = Number(declaredLength);
            if (!Number.isSafeInteger(parsed) || parsed !== expectedBytes)
                throw new Error("Main snapshot artifact Content-Length does not match the manifest.");
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
            if (bytes > expectedBytes)
                throw new Error("Main snapshot artifact exceeded the manifest byte size.");
            digest.update(chunk);
            await handle.write(chunk);
        }
        await handle.sync();
        await handle.close();
        handle = null;
        if (bytes !== expectedBytes)
            throw new Error("Main snapshot artifact byte size does not match the manifest.");
        const sha256 = digest.digest("hex");
        if (sha256 !== snapshot.manifest.artifact.sha256)
            throw new Error("Main snapshot artifact SHA-256 verification failed.");
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
    }
    catch (error) {
        await handle?.close().catch(() => { });
        // Both the artifact temporary pathname and the recursive cleanup live
        // under nativeDir. Never delete another writer's same-named directory
        // (or anything inside it) after our original scratch was displaced.
        if (nativeCreated && originalNativeDirectory) {
            const current = await fsImpl.lstat(nativeDir).catch(() => null);
            if (current?.isDirectory() && !current.isSymbolicLink() &&
                current.dev === originalNativeDirectory.dev && current.ino === originalNativeDirectory.ino) {
                await fsImpl.rm(nativeDir, { recursive: true, force: true }).catch(() => { });
            }
        }
        throw error;
    }
    finally {
        clearTimeout(timer);
    }
}
// Explicit future signed-Main B staging entrypoint. Old unsigned snapshot
// helper remains for historic read-only artifact tests; production Windows
// B activation must use this signature gate AND the post-extraction native
// fingerprint/Guardian OS signature gates before any journal or pointer write.
export async function stageSignedEquinoxLocalMainBArtifact({ previousSourceSha, publicKeys, ...stageOptions }) {
    const admitted = await fetchEquinoxLocalSignedMainBPublication({
        previousSourceSha,
        sourceSha: stageOptions.sourceSha,
        target: stageOptions.target,
        expectedRuntimeContractSha256: stageOptions.expectedRuntimeContractSha256,
        ...(stageOptions.fetchImpl === undefined ? {} : { fetchImpl: stageOptions.fetchImpl }),
        ...(publicKeys === undefined ? {} : { publicKeys }),
    });
    // Download ONLY after the exact previous A, B SHA/contract, target and ZIP
    // digest/size have passed a trusted Ed25519 signature check.
    const staged = await stageEquinoxLocalMainSnapshotArtifact(stageOptions);
    if (staged.sha256 !== admitted.authorization.artifact.sha256 ||
        staged.bytes !== admitted.authorization.artifact.bytes ||
        staged.manifest.artifact.sha256 !== admitted.authorization.artifact.sha256 ||
        staged.manifest.runtimeContractSha256 !== admitted.authorization.runtimeContractSha256) {
        // No state/activation is promoted. Leave transaction-owned immutable
        // staging for the normal crash reconciliation, never delete another
        // writer's same-named directory on a failed cross-fetch identity check.
        throw new Error("Signed Main B authorization changed between publication and staging.");
    }
    return Object.freeze({ ...staged, signedAuthorization: admitted.authorization });
}
