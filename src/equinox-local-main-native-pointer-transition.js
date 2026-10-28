import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { readEquinoxLocalMainNativePointer, writeEquinoxLocalMainNativePointer } from "./equinox-local-main-native-state.js";
function hasErrorCode(error, code) {
    return error !== null && typeof error === "object" && "code" in error && error.code === code;
}
function sameIdentity(pointer, expected) {
    return pointer?.sourceSha === expected?.sourceSha
        && pointer?.target === expected?.target
        && pointer?.runtimeContractSha256 === expected?.runtimeContractSha256;
}
export function createEquinoxLocalMainNativePointerTransition({ pointerPath, transactionRoot, target, previous = null, fsImpl = fs, readPointer = readEquinoxLocalMainNativePointer, writePointer = writeEquinoxLocalMainNativePointer, } = {}) {
    if (!pointerPath || !transactionRoot || !target?.sourceSha || !target?.runtimeContractSha256 ||
        (previous && !previous.sourceSha))
        throw new Error("Main native switch requires exact A and B identities.");
    const options = { transactionRoot, fsImpl };
    async function current() {
        try {
            return await readPointer(pointerPath, options);
        }
        catch (error) {
            if (hasErrorCode(error, "ENOENT"))
                return null;
            throw error;
        }
    }
    return Object.freeze({
        async selectTarget() {
            const before = await current();
            if (sameIdentity(before, target))
                return before;
            if (!sameIdentity(before, previous)) {
                throw new Error("Native pointer switched away from the admitted rollback A identity.");
            }
            return writePointer(pointerPath, target, options);
        },
        async restorePrevious() {
            const before = await current();
            if (sameIdentity(before, previous))
                return before;
            if (!sameIdentity(before, target)) {
                throw new Error("Native pointer no longer belongs to admitted B or rollback A.");
            }
            if (previous)
                return writePointer(pointerPath, {
                    schemaVersion: 1, channel: "main",
                    sourceSha: previous.sourceSha, target: previous.target,
                    runtimeContractSha256: previous.runtimeContractSha256,
                }, options);
            // Stable A had no Main pointer. Remove only our verified B selection.
            await fsImpl.unlink(pointerPath);
            return null;
        },
        async requireTarget() {
            const observed = await current();
            if (!sameIdentity(observed, target))
                throw new Error("Native B pointer is not durably selected.");
            return observed;
        },
        async assertRollbackAdmitted() {
            const observed = await current();
            if (!sameIdentity(observed, target) && !sameIdentity(observed, previous)) {
                throw new Error("Native Main rollback pointer is neither admitted A nor B.");
            }
            return observed;
        },
    });
}
// macOS' existing LaunchAgent supervisor reads <installRoot>/current. Native
// A/B must switch that ONE symlink atomically to the already-admitted store B.
// This is a filesystem transition only: a detached updater must coordinate
// its native SHA pointer, LaunchAgent restart, health and rollback.
export function createEquinoxLocalMainMacCurrentLinkTransition({ installRoot, target, previousReleaseDir = null, fsImpl = fs, randomBytesImpl = randomBytes, }) {
    if (typeof installRoot !== "string" || !path.posix.isAbsolute(installRoot) ||
        !installRoot.endsWith("/Library/Application Support/Equinox Local") ||
        !/^[a-f0-9]{40}$/u.test(target?.sourceSha ?? "") ||
        !/^darwin-(arm64|x64)$/u.test(target?.target ?? "") ||
        !/^[a-f0-9]{64}$/u.test(target?.runtimeContractSha256 ?? "")) {
        throw new Error("Native Main macOS current-link identity or install root is invalid.");
    }
    const root = path.posix.resolve(installRoot);
    const pointer = path.posix.join(root, "current");
    const targetReleaseDir = path.posix.join(root, "main-update", "native-store", target.target, target.sourceSha, "release");
    if (previousReleaseDir !== null) {
        const prev = path.posix.resolve(previousReleaseDir);
        const stable = path.posix.dirname(prev) === path.posix.join(root, "releases") &&
            /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(path.posix.basename(prev));
        const nativePrefix = path.posix.join(root, "main-update", "native-store", target.target);
        const nativeRelative = path.posix.relative(nativePrefix, prev).split(path.posix.sep);
        const native = nativeRelative.length === 2 && /^[a-f0-9]{40}$/u.test(nativeRelative[0] ?? "") &&
            nativeRelative[1] === "release";
        if (!path.posix.isAbsolute(previousReleaseDir) || (!stable && !native)) {
            throw new Error("Native Main macOS rollback A is outside an owned Stable/native release.");
        }
    }
    async function physical(release) {
        const actual = await fsImpl.realpath(release);
        // Reject symlink aliases in the release sub-tree, but support /var to
        // /private/var canonicalization of macOS' per-user temporary fixtures.
        const physicalRoot = await fsImpl.realpath(root);
        const expected = path.posix.join(physicalRoot, path.posix.relative(root, release));
        if (actual !== expected)
            throw new Error("Native Main macOS release contains an untrusted symlink.");
        return actual;
    }
    async function current() {
        let stat;
        try {
            stat = await fsImpl.lstat(pointer);
        }
        catch (error) {
            if (hasErrorCode(error, "ENOENT"))
                return null;
            throw error;
        }
        if (!stat.isSymbolicLink())
            throw new Error("Managed Main current pointer is not an owned symlink.");
        const text = await fsImpl.readlink(pointer);
        const literal = path.posix.resolve(root, text);
        if (literal !== targetReleaseDir && literal !== previousReleaseDir) {
            throw new Error("Managed Main current pointer changed outside admitted A/B releases.");
        }
        // A broken link is a corrupted owned pointer, NEVER an absent A.
        await physical(literal);
        return literal;
    }
    async function syncParent() {
        const handle = await fsImpl.open(root, "r");
        try {
            await handle.sync();
        }
        finally {
            await handle.close();
        }
    }
    return Object.freeze({
        async selectTarget() {
            await physical(targetReleaseDir);
            const before = await current();
            if (before === targetReleaseDir)
                return targetReleaseDir;
            if (before !== previousReleaseDir)
                throw new Error("Native Main current link switched away from rollback A.");
            const temp = path.posix.join(root, ".current-main-" + randomBytesImpl(8).toString("hex"));
            let created = false;
            try {
                await fsImpl.symlink(path.posix.relative(root, targetReleaseDir), temp, "dir");
                created = true;
                if (await current() !== before)
                    throw new Error("Native Main current link changed during B admission.");
                await fsImpl.rename(temp, pointer);
                created = false;
                await syncParent();
                return targetReleaseDir;
            }
            finally {
                if (created) {
                    const stat = await fsImpl.lstat(temp).catch(() => null);
                    if (stat?.isSymbolicLink() && await fsImpl.readlink(temp) === path.posix.relative(root, targetReleaseDir)) {
                        await fsImpl.unlink(temp);
                    }
                }
            }
        },
        async restorePrevious() {
            const before = await current();
            if (before === previousReleaseDir)
                return previousReleaseDir;
            if (before !== targetReleaseDir)
                throw new Error("Native Main current link no longer belongs to B.");
            if (previousReleaseDir === null) {
                await fsImpl.unlink(pointer);
                await syncParent();
                return null;
            }
            await physical(previousReleaseDir);
            const temp = path.posix.join(root, ".current-main-" + randomBytesImpl(8).toString("hex"));
            let created = false;
            try {
                await fsImpl.symlink(path.posix.relative(root, previousReleaseDir), temp, "dir");
                created = true;
                if (await current() !== targetReleaseDir)
                    throw new Error("Native Main current link changed before rollback.");
                await fsImpl.rename(temp, pointer);
                created = false;
                await syncParent();
                return previousReleaseDir;
            }
            finally {
                if (created) {
                    const stat = await fsImpl.lstat(temp).catch(() => null);
                    if (stat?.isSymbolicLink() && await fsImpl.readlink(temp) === path.posix.relative(root, previousReleaseDir)) {
                        await fsImpl.unlink(temp);
                    }
                }
            }
        },
        current,
        pointer,
        targetReleaseDir,
    });
}
