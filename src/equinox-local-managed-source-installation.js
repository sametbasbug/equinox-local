import fs from "node:fs/promises";
import path from "node:path";
import { validateManagedSourceInstallStamp } from "./equinox-local-main-update.js";
import { readEquinoxLocalMainSourcePointer } from "./equinox-local-main-source-pointer.js";
import { readEquinoxLocalMainNativePointer } from "./equinox-local-main-native-state.js";
import { validateTrustedMainInstallPointer } from "./equinox-local-main-install-pointer.js";
import { equinoxLocalPlatformPaths } from "./equinox-local-platform.js";
import { equinoxLocalToolchainContract } from "./equinox-local-toolchain-contract.js";
import { inspectPrivateStatePath, verifyWindowsPrivateStateAcl } from "./equinox-local-private-state.js";
import { readBoundedNormalFile } from "./equinox-local-safe-file.js";
function hasErrorCode(error, code) {
    return error !== null && typeof error === "object" && "code" in error && error.code === code;
}
const MAX_STAMP_BYTES = 8 * 1024;
export function equinoxLocalManagedSourcePaths({ platform = process.platform, arch = process.arch, homeDir, env = process.env, } = {}) {
    const layout = equinoxLocalPlatformPaths({ platform, arch, ...(homeDir === undefined ? {} : { homeDir }), env });
    const pathApi = platform === "win32" ? path.win32 : path.posix;
    const mainTransactionRoot = pathApi.join(layout.stateRoot, "main-update");
    return Object.freeze({
        mainTransactionRoot,
        installStampPath: pathApi.join(mainTransactionRoot, "install.json"),
        sourcePointerPath: pathApi.join(mainTransactionRoot, "current-source.conf"),
    });
}
export async function resolveEquinoxLocalManagedSourceInstallation({ baseInstallation, platform = baseInstallation?.platform ?? process.platform, arch = baseInstallation?.arch ?? process.arch, homeDir, env = process.env, fsImpl = fs, verifyWindowsAcl = verifyWindowsPrivateStateAcl, readPointerImpl = readEquinoxLocalMainSourcePointer, readNativePointerImpl = readEquinoxLocalMainNativePointer, verifySignedPointerImpl = validateTrustedMainInstallPointer, } = {}) {
    if (!baseInstallation || baseInstallation.kind !== "managed" || baseInstallation.managed !== true || baseInstallation.selfUpdateSupported !== true) {
        return baseInstallation;
    }
    const paths = equinoxLocalManagedSourcePaths({ platform, arch, ...(homeDir === undefined ? {} : { homeDir }), env });
    const directorySecurity = await inspectPrivateStatePath(paths.mainTransactionRoot, {
        platform, type: "directory", mode: "700", fsImpl, verifyWindowsAcl,
    });
    if (!directorySecurity.exists)
        return baseInstallation;
    if (!directorySecurity.safe)
        throw new Error("Managed-source state directory is not private.");
    const stampSecurity = await inspectPrivateStatePath(paths.installStampPath, {
        platform, type: "file", mode: "600", fsImpl, verifyWindowsAcl,
    });
    if (!stampSecurity.exists) {
        if (!baseInstallation.mainNativeSha)
            return baseInstallation;
        // A Git-free, signed-native release has NO legacy Git install stamp.
        // Its complete original production-root signed selector is persisted by
        // the external installer. An arbitrary release path alone is NEVER
        // sufficient for a native process to claim a trusted Main identity.
        const pathApi = platform === "win32" ? path.win32 : path.posix;
        // Each immutable native SHA owns its ORIGINAL signed selector. A->B
        // rollback selects A's selector automatically, without a second mutable
        // pointer or a risky multi-file identity switch.
        const releaseDir = baseInstallation.releaseDir;
        if (typeof releaseDir !== "string" || !pathApi.isAbsolute(releaseDir)) {
            throw new Error("Signed Main native release path is not owned.");
        }
        const selectorPath = pathApi.join(pathApi.dirname(releaseDir), "signed-selector.json");
        const signedSecurity = await inspectPrivateStatePath(selectorPath, {
            platform, type: "file", mode: "600", fsImpl, verifyWindowsAcl,
        });
        if (!signedSecurity.exists)
            throw new Error("Main native runtime has no verified Main install stamp or signed native selector.");
        if (!signedSecurity.safe)
            throw new Error("Signed Main native install selector is not private.");
        const { data } = await readBoundedNormalFile(selectorPath, {
            platform, fsImpl, minBytes: 200, maxBytes: 16 * 1024, encoding: "utf8",
            label: "Production-signed native Main install selector",
        });
        let raw;
        try {
            raw = JSON.parse(data);
        }
        catch {
            throw new Error("Production-signed native Main install selector is invalid JSON.");
        }
        const signed = verifySignedPointerImpl(raw, { expectedSourceSha: baseInstallation.mainNativeSha });
        const row = signed.targets.find(value => value.target === baseInstallation.target);
        if (!row)
            throw new Error("Signed native Main selector does not admit the current target.");
        const native = await readNativePointerImpl(pathApi.join(paths.mainTransactionRoot, "current-native.json"), {
            transactionRoot: paths.mainTransactionRoot, fsImpl,
        });
        const equivalent = (a, b) => platform === "win32"
            ? pathApi.normalize(a).toLowerCase() === pathApi.normalize(b).toLowerCase()
            : pathApi.normalize(a) === pathApi.normalize(b);
        if (native.sourceSha !== signed.sourceSha ||
            native.sourceSha !== baseInstallation.mainNativeSha ||
            native.target !== baseInstallation.target ||
            native.runtimeContractSha256 !== row.runtimeContractSha256 ||
            native.payloadVersion !== signed.version ||
            typeof native.releaseDir !== "string" ||
            typeof baseInstallation.releaseDir !== "string" ||
            !equivalent(native.releaseDir, baseInstallation.releaseDir)) {
            throw new Error("Signed native Main runtime differs from its exact durable SHA pointer.");
        }
        return Object.freeze({
            ...baseInstallation, kind: "managed-main", channel: "main",
            sourceSha: signed.sourceSha, mainNativeSha: signed.sourceSha,
            mainTransactionRoot: paths.mainTransactionRoot,
            mainUpdateSupported: false,
            mainUpdateReason: "The unified signed installer owns Main updates.",
            gitPath: null, nodePath: null, npmPath: null, shellPath: null, toolchainRoot: null,
        });
    }
    if (!stampSecurity.safe)
        throw new Error("Managed-source install stamp is not private.");
    const { data } = await readBoundedNormalFile(paths.installStampPath, {
        platform,
        fsImpl,
        minBytes: 2,
        maxBytes: MAX_STAMP_BYTES,
        encoding: "utf8",
        label: "Managed-source install stamp",
    });
    let parsed;
    try {
        parsed = JSON.parse(data);
    }
    catch {
        throw new Error("Managed-source install stamp is not valid JSON.");
    }
    const stamp = validateManagedSourceInstallStamp(parsed);
    // Only an enrolled Main installation owns the complete toolchain contract.
    // A signed Stable repair may retain a partial old Main toolchain while its
    // install stamp is parked; it must boot without inspecting or deleting it.
    const layout = equinoxLocalPlatformPaths({ platform, arch, ...(homeDir === undefined ? {} : { homeDir }), env });
    const toolchain = equinoxLocalToolchainContract({ runtimeRoot: layout.runtimeRoot, target: `${platform}-${arch}` });
    let managedGitPath = null;
    try {
        const [gitStat, nodeStat, npmStat] = await Promise.all([
            fsImpl.lstat(toolchain.gitPath),
            fsImpl.lstat(toolchain.nodePath),
            fsImpl.lstat(toolchain.npmPath),
        ]);
        if (!gitStat.isFile() || gitStat.isSymbolicLink())
            throw new Error("Managed Git executable is unsafe.");
        if (!nodeStat.isFile() || nodeStat.isSymbolicLink())
            throw new Error("Managed Node executable is unsafe.");
        if (!npmStat.isFile() || npmStat.isSymbolicLink())
            throw new Error("Managed npm CLI is unsafe.");
        if (platform !== "win32" && ((gitStat.mode & 0o111) === 0 || (nodeStat.mode & 0o111) === 0))
            throw new Error("Managed toolchain executable is not executable.");
        managedGitPath = toolchain.gitPath;
    }
    catch (error) {
        if (!hasErrorCode(error, "ENOENT"))
            throw error;
        const anyToolchainState = await Promise.all([toolchain.gitPath, toolchain.nodePath, toolchain.npmPath].map(async (candidate) => {
            try {
                await fsImpl.lstat(candidate);
                return true;
            }
            catch (inner) {
                if (hasErrorCode(inner, "ENOENT"))
                    return false;
                throw inner;
            }
        }));
        if (anyToolchainState.some(Boolean))
            throw new Error("Managed product-owned toolchain is incomplete.");
    }
    const pointer = await readPointerImpl(paths.sourcePointerPath, {
        fsImpl,
        ...(managedGitPath ? { gitPath: managedGitPath } : {}),
    });
    if (baseInstallation.mainNativeSha) {
        const native = await readNativePointerImpl((platform === "win32" ? path.win32 : path.posix).join(paths.mainTransactionRoot, "current-native.json"), {
            transactionRoot: paths.mainTransactionRoot, fsImpl,
        });
        const pathApi = path.win32;
        if (typeof baseInstallation.releaseDir !== "string" ||
            native.sourceSha !== baseInstallation.mainNativeSha ||
            native.target !== baseInstallation.target ||
            pathApi.normalize(native.releaseDir).toLowerCase() !== pathApi.normalize(baseInstallation.releaseDir).toLowerCase()) {
            throw new Error("Main bootstrap native runtime does not match the authenticated native-store pointer.");
        }
    }
    return Object.freeze({
        ...baseInstallation,
        kind: "managed-source",
        channel: "main",
        mainUpdateSupported: true,
        mainUpdateReason: null,
        sourceRoot: pointer.sourceRoot,
        sourceSha: pointer.sha,
        mainTransactionRoot: paths.mainTransactionRoot,
        mainInstallStamp: stamp,
        gitPath: managedGitPath,
        nodePath: managedGitPath ? toolchain.nodePath : null,
        npmPath: managedGitPath ? toolchain.npmPath : null,
        shellPath: managedGitPath ? toolchain.shellPath : null,
        toolchainRoot: managedGitPath ? toolchain.toolchainRoot : null,
    });
}
