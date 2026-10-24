import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateEquinoxLocalMainNativeArtifactManifest } from "../../src/equinox-local-main-native-admission.js";
import { validateSignedMainNativeBAuthorization } from "../../src/equinox-local-main-native-b-authorization.js";
const SHA = /^[a-f0-9]{40}$/u;
const TARGETS = ["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64"];
const FILE_LIMIT = 1024 * 1024 * 1024;
async function readNormal(file, max) {
    const named = await fs.lstat(file);
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.size < 1 || named.size > max) {
        throw new Error("Signed Main snapshot publication file is not a bounded normal file.");
    }
    const fd = await fs.open(file, "r");
    try {
        const opened = await fd.stat();
        if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== named.dev || opened.ino !== named.ino || opened.size !== named.size) {
            throw new Error("Signed Main snapshot file changed while opening.");
        }
        const bytes = Buffer.allocUnsafe(named.size);
        let total = 0;
        while (total < bytes.length) {
            const { bytesRead } = await fd.read(bytes, total, bytes.length - total, total);
            if (!bytesRead)
                throw new Error("Signed Main snapshot file ended during read.");
            total += bytesRead;
        }
        const after = await fd.stat();
        if (after.size !== opened.size || after.ino !== opened.ino || after.dev !== opened.dev || after.mtimeMs !== opened.mtimeMs) {
            throw new Error("Signed Main snapshot file changed during reading.");
        }
        return bytes;
    }
    finally {
        await fd.close();
    }
}
async function hashNormal(file, expectedBytes) {
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > FILE_LIMIT) {
        throw new Error("Signed Main snapshot artifact exceeds the allowed size.");
    }
    const named = await fs.lstat(file);
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.size !== expectedBytes) {
        throw new Error("Signed Main snapshot archive filename/byte count is not a normal exact artifact.");
    }
    const fd = await fs.open(file, "r");
    try {
        const opened = await fd.stat();
        if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== named.dev || opened.ino !== named.ino || opened.size !== expectedBytes) {
            throw new Error("Signed Main snapshot archive file identity drifted.");
        }
        const digest = createHash("sha256");
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        let total = 0;
        while (total < expectedBytes) {
            const { bytesRead } = await fd.read(buffer, 0, Math.min(buffer.length, expectedBytes - total), total);
            if (!bytesRead)
                throw new Error("Signed Main snapshot archive truncated.");
            digest.update(buffer.subarray(0, bytesRead));
            total += bytesRead;
        }
        const after = await fd.stat();
        if (after.size !== opened.size || after.ino !== opened.ino || after.dev !== opened.dev || after.mtimeMs !== opened.mtimeMs) {
            throw new Error("Signed Main snapshot archive mutated during hashing.");
        }
        return digest.digest("hex");
    }
    finally {
        await fd.close();
    }
}
export async function verifyMainNativeSignedSnapshotSet({ directory, sourceSha, publicKeys, }) {
    if (!SHA.test(sourceSha))
        throw new Error("Signed Main snapshot publication requires an exact Git source SHA.");
    if (!path.isAbsolute(directory) || path.resolve(directory) !== directory) {
        throw new Error("Signed Main snapshot directory must be absolute.");
    }
    const dir = await fs.lstat(directory);
    if (!dir.isDirectory() || dir.isSymbolicLink() || await fs.realpath(directory) !== directory) {
        throw new Error("Signed Main snapshot directory must be canonical and normal.");
    }
    const expectedFiles = [];
    const manifests = [];
    for (const target of TARGETS) {
        const prefix = `equinox-local-main-${sourceSha}-${target}`;
        const manifestName = `${prefix}.json`;
        const archiveName = `${prefix}${target.startsWith("darwin-") ? ".tar.gz" : ".zip"}`;
        expectedFiles.push(manifestName, archiveName);
        const record = JSON.parse((await readNormal(path.join(directory, manifestName), 64 * 1024)).toString("utf8"));
        if (!record || typeof record !== "object" || !("runtimeContractSha256" in record) ||
            typeof record.runtimeContractSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(record.runtimeContractSha256)) {
            throw new Error("Main snapshot runtime contract must be exact SHA-256.");
        }
        const validated = validateEquinoxLocalMainNativeArtifactManifest(record, {
            expectedSourceSha: sourceSha, expectedTarget: target, expectedRuntimeContractSha256: record.runtimeContractSha256,
        });
        if (validated.artifact.name !== archiveName)
            throw new Error("Main snapshot archive filename does not match the exact SHA and platform.");
        const sha = await hashNormal(path.join(directory, archiveName), validated.artifact.bytes);
        if (sha !== validated.artifact.sha256)
            throw new Error("Main snapshot archive SHA-256 differs from the published manifest.");
        {
            const sidecarName = `${prefix}.b-authorization.json`;
            expectedFiles.push(sidecarName);
            const authorization = JSON.parse((await readNormal(path.join(directory, sidecarName), 8192)).toString("utf8"));
            validateSignedMainNativeBAuthorization(authorization, {
                ...(publicKeys === undefined ? {} : { publicKeys }),
                expected: {
                    schemaVersion: 2, channel: "main", sourceSha, target: target,
                    runtimeContractSha256: validated.runtimeContractSha256,
                    artifact: { sha256: validated.artifact.sha256, bytes: validated.artifact.bytes },
                },
            });
        }
        manifests.push({ target, sha256: sha, bytes: validated.artifact.bytes });
    }
    const contents = (await fs.readdir(directory)).sort();
    expectedFiles.sort();
    if (contents.length !== expectedFiles.length || contents.some((name, index) => name !== expectedFiles[index])) {
        throw new Error("Signed Main snapshot set must contain exactly four native archives, four transport manifests and four signed native B authorizations.");
    }
    return Object.freeze({ schemaVersion: 2, sourceSha, verifiedTargets: manifests.map(m => m.target), signedTargets: [...TARGETS] });
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    const argv = process.argv.slice(2);
    if (argv.length !== 4 || argv[0] !== "--directory" || argv[2] !== "--source-sha") {
        process.stderr.write("Usage: --directory <absolute dir> --source-sha <full git SHA>\n");
        process.exitCode = 1;
    }
    else {
        verifyMainNativeSignedSnapshotSet({ directory: argv[1], sourceSha: argv[3] }).then(result => {
            process.stdout.write(`${JSON.stringify(result)}\n`);
        }).catch(err => { process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`); process.exitCode = 1; });
    }
}
