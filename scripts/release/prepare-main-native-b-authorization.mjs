import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateFirstInstallRelease } from "../../src/equinox-local-first-install.js";
import { validateEquinoxLocalMainNativeArtifactManifest } from "../../src/equinox-local-main-native-admission.js";
import { canonicalMainNativeBAuthorizationPayload } from "../../src/equinox-local-main-native-b-authorization.js";
import { fingerprintEquinoxLocalNativeState } from "../../src/equinox-local-native-state-fingerprint.js";
const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const LIMIT = 1024 * 1024 * 1024;
async function hashPinnedArchive(filename) {
    const named = await fs.lstat(filename);
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.size < 1 || named.size > LIMIT) {
        throw new Error("Signed Main B candidate must be a bounded normal standalone archive.");
    }
    const handle = await fs.open(filename, "r");
    try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== named.dev || opened.ino !== named.ino || opened.size !== named.size) {
            throw new Error("Signed Main B archive changed during admission.");
        }
        const sha = createHash("sha256");
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        let bytes = 0;
        while (bytes < named.size) {
            const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, named.size - bytes), bytes);
            if (!bytesRead)
                throw new Error("Signed Main B archive was truncated during hashing.");
            sha.update(buffer.subarray(0, bytesRead));
            bytes += bytesRead;
        }
        const extra = await handle.read(buffer, 0, 1, bytes);
        const ended = await handle.stat();
        if (extra.bytesRead !== 0 || ended.size !== opened.size || ended.mtimeMs !== opened.mtimeMs || ended.dev !== opened.dev || ended.ino !== opened.ino) {
            throw new Error("Signed Main B archive changed during hashing.");
        }
        return { sha256: sha.digest("hex"), bytes };
    }
    finally {
        await handle.close();
    }
}
export async function prepareMainNativeBAuthorizationPayload({ sourceSha, target, artifactPath, manifestPath, releaseDir, validateRelease = validateFirstInstallRelease, }) {
    if (!SHA.test(sourceSha) || (target !== "win32-x64" && target !== "win32-arm64")) {
        throw new Error("Unsigned Main B payload needs an exact full target SHA and Windows architecture.");
    }
    for (const [name, filename] of Object.entries({ artifactPath, manifestPath, releaseDir })) {
        if (typeof filename !== "string" || !path.isAbsolute(filename) || path.resolve(filename) !== filename) {
            throw new Error(`${name} must be an absolute canonical location.`);
        }
    }
    const releaseInfo = await fs.lstat(releaseDir);
    if (!releaseInfo.isDirectory() || releaseInfo.isSymbolicLink() || await fs.realpath(releaseDir) !== releaseDir) {
        throw new Error("Main B native release must be a canonical normal directory.");
    }
    const manifestInfo = await fs.lstat(manifestPath);
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.nlink !== 1 || manifestInfo.size > 8192 || manifestInfo.size < 1) {
        throw new Error("Unsigned Main B transport manifest must be a bounded normal file.");
    }
    const raw = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    if (!raw || typeof raw !== "object" || !("runtimeContractSha256" in raw) ||
        typeof raw.runtimeContractSha256 !== "string" || !DIGEST.test(raw.runtimeContractSha256)) {
        throw new Error("Main B runtime contract SHA-256 is missing.");
    }
    const manifest = validateEquinoxLocalMainNativeArtifactManifest(raw, {
        expectedSourceSha: sourceSha, expectedTarget: target, expectedRuntimeContractSha256: raw.runtimeContractSha256,
    });
    if (path.basename(artifactPath) !== manifest.artifact.name) {
        throw new Error("Main B artifact pathname is not the exact manifest artifact.");
    }
    const actual = await hashPinnedArchive(artifactPath);
    if (actual.sha256 !== manifest.artifact.sha256 || actual.bytes !== manifest.artifact.bytes) {
        throw new Error("Main B candidate archive differs from exact source-bound transport manifest.");
    }
    const validated = await validateRelease(releaseDir, { target });
    if (validated.target !== target || validated.releaseDir !== releaseDir ||
        ("sourceSha" in validated.metadata && validated.metadata.sourceSha !== sourceSha)) {
        throw new Error("Main B extracted native release identity differs from signed source/target.");
    }
    const tree = await fingerprintEquinoxLocalNativeState(releaseDir);
    const payload = {
        schemaVersion: 2, channel: "main", sourceSha, target,
        runtimeContractSha256: manifest.runtimeContractSha256,
        artifact: { sha256: actual.sha256, bytes: actual.bytes },
        releaseFingerprint: { sha256: tree.sha256, entries: tree.entries, bytes: tree.bytes },
    };
    canonicalMainNativeBAuthorizationPayload(payload); // Strict schema + signed-domain validation before use.
    return Object.freeze(payload);
}
async function cli(argv) {
    const args = new Map();
    for (let i = 0; i < argv.length; i += 2) {
        const key = argv[i];
        const value = argv[i + 1];
        if (!key?.startsWith("--") || !value || args.has(key) || !["--source-sha", "--target", "--artifact", "--manifest", "--release-dir", "--output"].includes(key)) {
            throw new Error("Main B authorization preparer requires unique supported --key value pairs.");
        }
        args.set(key, value);
    }
    if (args.size !== 6)
        throw new Error("Main B authorization preparer is missing required arguments.");
    const payload = await prepareMainNativeBAuthorizationPayload({
        sourceSha: args.get("--source-sha"), target: args.get("--target"),
        artifactPath: args.get("--artifact"), manifestPath: args.get("--manifest"), releaseDir: args.get("--release-dir"),
    });
    const output = args.get("--output");
    if (!path.isAbsolute(output))
        throw new Error("Unsigned B authorization output must be absolute.");
    const handle = await fs.open(output, "wx", 0o600);
    try {
        await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    process.stdout.write("Main B unsigned v2 authorization payload prepared; NOT SIGNED and NOT released.\n");
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    cli(process.argv.slice(2)).catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
