import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { resolveEquinoxLocalInstallation } from "./equinox-local-installation.js";
import { resolveEquinoxLocalManagedSourceInstallation, equinoxLocalManagedSourcePaths } from "./equinox-local-managed-source-installation.js";
import { inspectEquinoxLocalMainNativeStoredRelease, readEquinoxLocalMainNativePointer } from "./equinox-local-main-native-state.js";
import { validateTrustedMainInstallPointer } from "./equinox-local-main-install-pointer.js";
import { readEquinoxLocalCurrentVersionPointer } from "./equinox-local-current-release.js";
const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
function errorCode(error, name) {
    return error !== null && typeof error === "object" && "code" in error && error.code === name;
}
async function fileHash(file, fsImpl) {
    const handle = await fsImpl.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
            stat.size < 1024 || stat.size > 80 * 1024 * 1024) {
            throw new Error("Original Windows Guardian executable is not an owned bounded normal file.");
        }
        const hash = createHash("sha256");
        for await (const chunk of handle.createReadStream())
            hash.update(chunk);
        return { sha256: hash.digest("hex"), size: stat.size };
    }
    finally {
        await handle.close();
    }
}
// Inspection ONLY. Provisioning the original signed Guardian is a separate
// OS-owned operation and MUST NOT be performed as a side effect of checking B.
export async function inspectInstalledOriginalWindowsGuardian({ installRoot, releaseDir, fsImpl = fs, }) {
    const platformPath = path.win32;
    if (!platformPath.isAbsolute(installRoot) || !platformPath.isAbsolute(releaseDir) ||
        platformPath.normalize(installRoot) !== installRoot ||
        platformPath.normalize(releaseDir) !== releaseDir) {
        throw new Error("Original signed Windows Guardian has no canonical release path.");
    }
    const installed = platformPath.join(installRoot, "runtime", "guardian", "EquinoxLocalGuardian.exe");
    const original = platformPath.join(releaseDir, "runtime", "guardian", "EquinoxLocalGuardian.exe");
    const [a, b] = await Promise.all([fileHash(installed, fsImpl), fileHash(original, fsImpl)]);
    if (a.sha256 !== b.sha256 || a.size !== b.size) {
        throw new Error("Installed Windows Guardian differs from original A signed release.");
    }
    return Object.freeze({ trusted: true, sha256: a.sha256, bytes: a.size });
}
// Exactly one active A comes from a durable Native SHA pointer OR the
// original numbered Stable current-version pointer. A caller must NOT
// supply the identity from an ambient environment variable.
export async function resolveOriginalWindowsInstalledA({ transactionRoot, installRoot, target, fsImpl = fs, readPointerImpl = readEquinoxLocalMainNativePointer, readStableImpl = readEquinoxLocalCurrentVersionPointer, }) {
    const expected = path.win32.join(installRoot, "state", "main-update");
    if (transactionRoot !== expected || !/^win32-(arm64|x64)$/u.test(target)) {
        throw new Error("Original Windows installed A has no canonical product state.");
    }
    try {
        const ptr = await readPointerImpl(path.win32.join(transactionRoot, "current-native.json"), {
            transactionRoot, fsImpl,
        });
        const release = path.win32.join(transactionRoot, "native-store", target, ptr.sourceSha, "release");
        if (ptr.target !== target || !SHA.test(ptr.sourceSha) ||
            !DIGEST.test(ptr.runtimeContractSha256) || ptr.releaseDir !== release) {
            throw new Error("Original Windows native A pointer cannot identify the owning runtime.");
        }
        return Object.freeze({ releaseDir: release, previousKind: "main" });
    }
    catch (error) {
        if (!errorCode(error, "ENOENT"))
            throw error;
    }
    const stable = await readStableImpl(path.win32.join(installRoot, "current-version.json"), {
        platform: "win32", target, fsImpl,
    });
    const release = path.win32.join(installRoot, "releases", stable.version);
    return Object.freeze({ releaseDir: release, previousKind: "stable" });
}
export async function inspectSignedMainInstallerWindowsAdmission({ signedPointer, platform = process.platform, arch = process.arch, homeDir = os.homedir(), env = process.env, fsImpl = fs, verifyPointerImpl = validateTrustedMainInstallPointer, resolveInstallationImpl = resolveEquinoxLocalInstallation, resolveManagedImpl = resolveEquinoxLocalManagedSourceInstallation, inspectStoredImpl = inspectEquinoxLocalMainNativeStoredRelease, readPointerImpl = readEquinoxLocalMainNativePointer, resolveActiveAImpl = resolveOriginalWindowsInstalledA, inspectGuardianImpl = inspectInstalledOriginalWindowsGuardian, }) {
    if (platform !== "win32" || !["x64", "arm64"].includes(arch) ||
        typeof homeDir !== "string" || !path.win32.isAbsolute(homeDir) ||
        path.win32.normalize(homeDir) !== homeDir) {
        throw new Error("Signed native Windows Main preflight requires an original Windows x64/arm64 user profile.");
    }
    const target = "win32-" + arch;
    const paths = equinoxLocalManagedSourcePaths({ platform, arch, homeDir, env });
    const root = paths.mainTransactionRoot;
    const installRoot = path.win32.dirname(path.win32.dirname(root));
    const signed = verifyPointerImpl(signedPointer);
    const row = signed.targets.find(item => item.target === target);
    if (!row || !SHA.test(signed.sourceSha) || !DIGEST.test(row.runtimeContractSha256)) {
        throw new Error("Original signed native Windows Main has no admitted exact B identity.");
    }
    const originalA = await resolveActiveAImpl({
        transactionRoot: root, installRoot, target, fsImpl, readPointerImpl,
    });
    const currentRelease = originalA.releaseDir;
    if (!path.win32.isAbsolute(currentRelease) ||
        path.win32.normalize(currentRelease) !== currentRelease ||
        (env.EQUINOX_LOCAL_RELEASE_DIR &&
            env.EQUINOX_LOCAL_RELEASE_DIR !== currentRelease)) {
        throw new Error("Windows native admission requires the original durable current A, not caller-provided release paths.");
    }
    const base = resolveInstallationImpl({ platform, arch, homeDir, env: {
            ...env, EQUINOX_LOCAL_INSTALL_ROOT: installRoot, EQUINOX_LOCAL_RELEASE_DIR: currentRelease,
        } });
    if (!base.managed || !base.selfUpdateSupported || base.target !== target ||
        base.releaseDir !== currentRelease || base.installRoot !== installRoot ||
        Boolean(base.mainNativeSha) !== (originalA.previousKind === "main")) {
        throw new Error("Windows signed Main cannot displace unsupported or foreign A.");
    }
    const previous = await resolveManagedImpl({ baseInstallation: { ...base, target, releaseDir: currentRelease }, platform, arch, homeDir, env, fsImpl });
    if (!previous || (previous.kind !== "managed" && previous.kind !== "managed-main")) {
        throw new Error("Windows signed Main cannot displace Git-backed or private Factory A.");
    }
    const originalGuardian = await inspectGuardianImpl({ installRoot, releaseDir: currentRelease, fsImpl });
    if (originalGuardian.trusted !== true) {
        throw new Error("Windows signed Main requires the ORIGINAL installed signed Guardian.");
    }
    let previousSha = null;
    let previousRuntimeContractSha256 = null;
    if (base.mainNativeSha) {
        if (previous.kind !== "managed-main" ||
            previous.sourceSha !== base.mainNativeSha ||
            previous.mainNativeSha !== base.mainNativeSha) {
            throw new Error("Original Windows native Main A selector is unauthenticated.");
        }
        const ptr = await readPointerImpl(path.win32.join(root, "current-native.json"), {
            transactionRoot: root, fsImpl,
        });
        if (ptr.sourceSha !== base.mainNativeSha || ptr.target !== target ||
            ptr.releaseDir !== currentRelease || !DIGEST.test(ptr.runtimeContractSha256)) {
            throw new Error("Windows signed Main A native pointer and owned WPF release drifted.");
        }
        previousSha = ptr.sourceSha;
        previousRuntimeContractSha256 = ptr.runtimeContractSha256;
    }
    else if (previous.kind !== "managed") {
        throw new Error("Windows signed Main original Stable A identity is invalid.");
    }
    const store = await inspectStoredImpl({ transactionRoot: root, sourceSha: signed.sourceSha,
        target, expectedRuntimeContractSha256: row.runtimeContractSha256, fsImpl });
    const expectedB = path.win32.join(root, "native-store", target, signed.sourceSha, "release");
    if (store.releaseDir !== expectedB || store.sourceSha !== signed.sourceSha ||
        store.target !== target || store.runtimeContractSha256 !== row.runtimeContractSha256 ||
        store.payloadVersion !== signed.version ||
        store.manifest.artifactSha256 !== row.artifact.sha256 ||
        store.manifest.artifactBytes !== row.artifact.bytes) {
        throw new Error("Windows signed Main B differs from original production-signed immutable store.");
    }
    try {
        await fsImpl.lstat(path.win32.join(root, "active.json"));
        throw new Error("The original Main native transaction owner is already active.");
    }
    catch (error) {
        if (!errorCode(error, "ENOENT"))
            throw error;
    }
    // This does not mint/pretend independent WPF Guardian admission, stop any
    // process, switch pointers, write a journal or claim that B is healthy.
    return Object.freeze({
        status: "guardian_handoff_required",
        sourceSha: signed.sourceSha, target, version: signed.version,
        runtimeContractSha256: row.runtimeContractSha256,
        transactionRoot: root, releaseDir: expectedB,
        previousKind: previousSha ? "main" : "stable",
        previousSha, previousRuntimeContractSha256,
        originalGuardianSha256: originalGuardian.sha256,
        sameSha: previousSha === signed.sourceSha,
    });
}
