import fs from "node:fs/promises";
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
    });
}
