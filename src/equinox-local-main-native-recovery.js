import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { assertWindowsNativeMessagingHostOwnership, registerWindowsNativeMessagingHost, windowsNativeMessagingLauncherPath, } from "./equinox-browser-windows-native-messaging.js";
import { resolveEquinoxLocalInstallation } from "./equinox-local-installation.js";
import { inspectEquinoxLocalMainNativeStoredRelease, writeEquinoxLocalMainNativePointer, } from "./equinox-local-main-native-state.js";
import { inspectEquinoxLocalNativeAppHostSnapshot, restoreEquinoxLocalNativeAppHostSnapshot, synchronizeEquinoxLocalAppHostForRelease, } from "./equinox-local-native-app-host.js";
import { readBoundedNormalFile, writeBoundedUtf8File } from "./equinox-local-safe-file.js";
import { validateTrustedMainInstallPointer } from "./equinox-local-main-install-pointer.js";
import { createEquinoxLocalMainMacCurrentLinkTransition, createEquinoxLocalMainNativePointerTransition } from "./equinox-local-main-native-pointer-transition.js";
import { readEquinoxLocalMainNativePointer } from "./equinox-local-main-native-state.js";
import { parseEquinoxVersion } from "./equinox-local-updater.js";
import { readBoundedJsonFile, writeAtomicPrivateJson } from "./equinox-local-main-update-transaction.js";
import { createSupervisorBoundWindowsNativeABLifecycle, requireWindowsNativeABSupervisor } from "./equinox-local-windows-native-ab-supervisor-bound.js";
function hasErrorCode(error, code) {
    return error !== null && typeof error === "object" && "code" in error && error.code === code;
}
const MAX_DESCRIPTOR_BYTES = 8 * 1024;
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const TX_PATTERN = /^main-[a-f0-9]{32}$/u;
function exactKeys(value, expected, label) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`${label} is invalid.`);
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
        throw new Error(`${label} contains missing or unsupported fields.`);
}
function assertSha(value, label) {
    if (typeof value !== "string" || !SHA_PATTERN.test(value))
        throw new Error(`${label} is invalid.`);
    return value;
}
function assertDigest(value, label) {
    if (typeof value !== "string" || !DIGEST_PATTERN.test(value))
        throw new Error(`${label} is invalid.`);
    return value;
}
function assertTransactionId(value) {
    if (typeof value !== "string" || !TX_PATTERN.test(value))
        throw new Error("Main native recovery transaction id is invalid.");
    return value;
}
function requireAbsolute(value, label, pathApi = path) {
    if (typeof value !== "string" || !pathApi.isAbsolute(value) || /[\r\n\0]/u.test(value))
        throw new Error(`${label} must be absolute.`);
    return pathApi.resolve(value);
}
function recoveryPath(transactionRoot, transactionId) {
    const root = requireAbsolute(transactionRoot, "Main native recovery transaction root");
    const id = assertTransactionId(transactionId);
    return Object.freeze({
        root,
        rollbackRoot: path.join(root, "staging", id, "native-rollback"),
        descriptorPath: path.join(root, "staging", id, "native-rollback", "native-recovery.json"),
        pointerPath: path.join(root, "current-native.json"),
    });
}
function validatePrevious(value) {
    if (value !== null && typeof value === "object" && "kind" in value && value.kind === "none") {
        exactKeys(value, ["kind"], "Main native empty first-install identity");
        return Object.freeze({ kind: "none" });
    }
    if (value !== null && typeof value === "object" && "kind" in value && value.kind === "main") {
        exactKeys(value, ["kind", "sourceSha", "target", "runtimeContractSha256"], "Main native previous identity");
        const parsed = value;
        assertSha(parsed.sourceSha, "Main native previous source SHA");
        assertDigest(parsed.runtimeContractSha256, "Main native previous runtime contract");
        if (typeof parsed.target !== "string" || !parsed.target)
            throw new Error("Main native previous target is invalid.");
        return Object.freeze({ ...value });
    }
    if (value !== null && typeof value === "object" && "kind" in value && value.kind === "stable") {
        exactKeys(value, ["kind", "version"], "Main native previous stable identity");
        const parsed = value;
        return Object.freeze({ kind: "stable", version: parseEquinoxVersion(parsed.version).text });
    }
    throw new Error("Main native previous identity is invalid.");
}
function validateDescriptor(value, expected = {}) {
    exactKeys(value, ["schemaVersion", "channel", "targetSha", "target", "targetRuntimeContractSha256", "previous"], "Main native recovery descriptor");
    if (value.schemaVersion !== 1 || value.channel !== "main")
        throw new Error("Main native recovery descriptor identity is invalid.");
    assertSha(value.targetSha, "Main native recovery target SHA");
    assertDigest(value.targetRuntimeContractSha256, "Main native recovery target runtime contract");
    if (typeof value.target !== "string" || !value.target)
        throw new Error("Main native recovery target is invalid.");
    const previous = validatePrevious(value.previous);
    if (expected.targetSha && value.targetSha !== expected.targetSha)
        throw new Error("Main native recovery target SHA mismatch.");
    if (expected.target && value.target !== expected.target)
        throw new Error("Main native recovery target mismatch.");
    if (expected.targetRuntimeContractSha256 && value.targetRuntimeContractSha256 !== expected.targetRuntimeContractSha256)
        throw new Error("Main native recovery runtime contract mismatch.");
    return Object.freeze({ ...value, previous });
}
export function equinoxLocalMainNativeRecoveryDescriptor({ transition, previousPointer, installation }) {
    if (transition?.mode !== "artifact_required")
        throw new Error("Main native recovery descriptor requires an artifact transition.");
    const previous = previousPointer
        ? Object.freeze({ kind: "main", sourceSha: previousPointer.sourceSha, target: previousPointer.target, runtimeContractSha256: previousPointer.runtimeContractSha256 })
        : installation?.releaseDir === null && /^darwin-(arm64|x64)$/u.test(transition.target)
            ? Object.freeze({ kind: "none" })
            : Object.freeze({ kind: "stable", version: parseEquinoxVersion(path.basename(installation?.releaseDir ?? "")).text });
    return validateDescriptor({
        schemaVersion: 1,
        channel: "main",
        targetSha: transition.targetSha,
        target: transition.target,
        targetRuntimeContractSha256: transition.targetRuntimeContractSha256,
        previous,
    });
}
export async function writeEquinoxLocalMainNativeRecoveryDescriptor({ transition, previousPointer, installation, transactionRoot, transactionId, fsImpl = fs, }) {
    const paths = recoveryPath(transactionRoot, transactionId);
    const descriptor = equinoxLocalMainNativeRecoveryDescriptor({ transition, previousPointer, installation });
    await fsImpl.mkdir(paths.rollbackRoot, { recursive: true, mode: 0o700 });
    try {
        const existing = await readEquinoxLocalMainNativeRecoveryDescriptor({
            transactionRoot,
            transactionId,
            expected: { targetSha: descriptor.targetSha, target: descriptor.target, targetRuntimeContractSha256: descriptor.targetRuntimeContractSha256 },
            fsImpl,
        });
        if (JSON.stringify(existing) !== JSON.stringify(descriptor))
            throw new Error("Main native recovery descriptor immutable identity mismatch.");
        return existing;
    }
    catch (error) {
        if (!hasErrorCode(error, "ENOENT"))
            throw error;
    }
    const content = `${JSON.stringify(descriptor, null, 2)}\n`;
    await writeBoundedUtf8File(paths.descriptorPath, { content, fsImpl, maxBytes: MAX_DESCRIPTOR_BYTES, label: "Main native recovery descriptor" });
    return await readEquinoxLocalMainNativeRecoveryDescriptor({
        transactionRoot,
        transactionId,
        expected: { targetSha: descriptor.targetSha, target: descriptor.target, targetRuntimeContractSha256: descriptor.targetRuntimeContractSha256 },
        fsImpl,
    });
}
export async function readEquinoxLocalMainNativeRecoveryDescriptor({ transactionRoot, transactionId, expected = {}, fsImpl = fs }) {
    const paths = recoveryPath(transactionRoot, transactionId);
    const file = await readBoundedNormalFile(paths.descriptorPath, { fsImpl, minBytes: 1, maxBytes: MAX_DESCRIPTOR_BYTES, encoding: "utf8", label: "Main native recovery descriptor" });
    let raw;
    try {
        raw = JSON.parse(file.data);
    }
    catch {
        throw new Error("Main native recovery descriptor is not valid JSON.");
    }
    return validateDescriptor(raw, expected);
}
// The signed native installer and existing Git-backed Main updater share
// ONE exclusive active.json lock namespace. Native records do not pretend
// to be Git receipts: legacy readActive rejects their distinct schema.
export async function beginEquinoxLocalSignedNativeMacOwner({ transactionRoot, transactionId, sourceSha, target, runtimeContractSha256, fsImpl = fs, uid = process.getuid?.(), }) {
    const paths = recoveryPath(transactionRoot, transactionId);
    const id = assertTransactionId(transactionId);
    const sha = assertSha(sourceSha, "Signed native handoff SHA");
    const digest = assertDigest(runtimeContractSha256, "Signed native handoff contract");
    if (!/^darwin-(arm64|x64)$/u.test(target) || !Number.isInteger(uid) || !uid || uid < 1) {
        throw new Error("Signed native Mac owner requires a non-root supported host.");
    }
    const root = await fsImpl.lstat(paths.root);
    if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o777) !== 0o700 ||
        root.uid !== uid || await fsImpl.realpath(paths.root) !== paths.root) {
        throw new Error("Signed native transaction state root is not a private owned directory.");
    }
    await readEquinoxLocalMainNativeRecoveryDescriptor({
        transactionRoot: paths.root, transactionId: id,
        expected: { targetSha: sha, target, targetRuntimeContractSha256: digest }, fsImpl,
    });
    const lockPath = path.join(paths.root, "active.json");
    const record = Object.freeze({
        schemaVersion: 1, kind: "signed-native", transactionId: id, sourceSha: sha,
        target, runtimeContractSha256: digest,
    });
    const handle = await fsImpl.open(lockPath, "wx", 0o600);
    const original = await handle.stat();
    let closed = false, success = false;
    try {
        if (!original.isFile() || original.nlink !== 1 || (original.mode & 0o777) !== 0o600) {
            throw new Error("Signed native owner lock inode is unsafe.");
        }
        await handle.writeFile(JSON.stringify(record) + "\n", "utf8");
        await handle.sync();
        await handle.close();
        closed = true;
        const stored = await fsImpl.lstat(lockPath);
        if (!stored.isFile() || stored.isSymbolicLink() || stored.nlink !== 1 ||
            stored.dev !== original.dev || stored.ino !== original.ino) {
            throw new Error("Signed native owner lock changed during publication.");
        }
        const directory = await fsImpl.open(paths.root, "r");
        try {
            await directory.sync();
        }
        finally {
            await directory.close();
        }
        success = true;
        await writeEquinoxLocalSignedNativeMacReceipt({
            transactionRoot: paths.root, transactionId: id, sourceSha: sha, target,
            runtimeContractSha256: digest, status: "admitted", fsImpl,
        });
        return record;
    }
    finally {
        if (!closed)
            await handle.close().catch(() => { });
        if (!success) {
            const stored = await fsImpl.lstat(lockPath).catch(() => null);
            if (stored?.isFile() && !stored.isSymbolicLink() &&
                stored.dev === original.dev && stored.ino === original.ino) {
                await fsImpl.unlink(lockPath).catch(() => { });
            }
        }
    }
}
// Read-only owner check for a future detached/recovery runner. Never delete a
// native lock on a mismatched identity or when the terminal journal is absent.
export async function assertEquinoxLocalSignedNativeMacOwner({ transactionRoot, transactionId, sourceSha, target, runtimeContractSha256, fsImpl = fs, }) {
    const paths = recoveryPath(transactionRoot, transactionId);
    const lockPath = path.join(paths.root, "active.json");
    const stat = await fsImpl.lstat(lockPath);
    if (!stat.isFile() || stat.isSymbolicLink() ||
        ![1, 2].includes(stat.nlink) || (stat.mode & 0o777) !== 0o600) {
        throw new Error("Signed native owner is not a private normal lock.");
    }
    if (stat.nlink === 2) {
        // Interrupted terminal release may already have created this precise
        // no-clobber archive hardlink, but no foreign additional hardlinks.
        const archive = path.join(paths.root, "receipts", transactionId + ".signed-native-owner.json");
        const linked = await fsImpl.lstat(archive);
        if (!linked.isFile() || linked.isSymbolicLink() ||
            linked.dev !== stat.dev || linked.ino !== stat.ino ||
            (linked.mode & 0o777) !== 0o600) {
            throw new Error("Signed native owner has an unexpected second hardlink.");
        }
    }
    const { data } = await readBoundedNormalFile(lockPath, {
        fsImpl, minBytes: 30, maxBytes: 1024, encoding: "utf8", label: "Signed native owner lock",
    });
    let raw;
    try {
        raw = JSON.parse(data);
    }
    catch {
        throw new Error("Signed native owner lock JSON is invalid.");
    }
    exactKeys(raw, ["schemaVersion", "kind", "transactionId", "sourceSha", "target", "runtimeContractSha256"], "Signed native owner");
    if (raw.schemaVersion !== 1 || raw.kind !== "signed-native" ||
        raw.transactionId !== transactionId || raw.sourceSha !== sourceSha ||
        raw.target !== target || raw.runtimeContractSha256 !== runtimeContractSha256) {
        throw new Error("Signed native owner differs from the exact active transaction.");
    }
    return Object.freeze({ ...raw });
}
const SIGNED_NATIVE_STAGES = new Set([
    "admitted", "activating", "rolling_back", "healthy", "rolled_back", "rollback_failed",
]);
function signedNativeReceiptPath(args) {
    return path.join(recoveryPath(args.transactionRoot, args.transactionId).root, "receipts", args.transactionId + ".signed-native.json");
}
function validateSignedNativeReceipt(raw, identity) {
    exactKeys(raw, ["schemaVersion", "kind", "transactionId", "sourceSha", "target",
        "runtimeContractSha256", "status"], "Signed native durable receipt");
    if (raw.schemaVersion !== 1 || raw.kind !== "signed-native" ||
        raw.transactionId !== identity.transactionId || raw.sourceSha !== identity.sourceSha ||
        raw.target !== identity.target || raw.runtimeContractSha256 !== identity.runtimeContractSha256 ||
        !SIGNED_NATIVE_STAGES.has(raw.status)) {
        throw new Error("Signed native durable receipt differs from active transaction.");
    }
    return Object.freeze({ ...raw, status: raw.status });
}
export async function readEquinoxLocalSignedNativeMacReceipt(args) {
    await assertEquinoxLocalSignedNativeMacOwner(args);
    const root = path.join(recoveryPath(args.transactionRoot, args.transactionId).root, "receipts");
    const dir = await (args.fsImpl ?? fs).lstat(root);
    if (!dir.isDirectory() || dir.isSymbolicLink())
        throw new Error("Signed native receipt directory is unsafe.");
    const file = signedNativeReceiptPath(args);
    const stat = await (args.fsImpl ?? fs).lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
        (stat.mode & 0o777) !== 0o600)
        throw new Error("Signed native receipt is not a private normal file.");
    return validateSignedNativeReceipt(await readBoundedJsonFile(file, { fsImpl: args.fsImpl ?? fs }), args);
}
export async function writeEquinoxLocalSignedNativeMacReceipt({ status, fsImpl = fs, ...identity }) {
    if (!SIGNED_NATIVE_STAGES.has(status))
        throw new Error("Signed native receipt stage is invalid.");
    await assertEquinoxLocalSignedNativeMacOwner({ ...identity, fsImpl });
    const receiptDir = path.join(identity.transactionRoot, "receipts");
    await fsImpl.mkdir(receiptDir, { recursive: true, mode: 0o700 });
    const receiptPath = signedNativeReceiptPath(identity);
    let previous = null;
    try {
        previous = await readEquinoxLocalSignedNativeMacReceipt({ ...identity, fsImpl });
    }
    catch (error) {
        if (!hasErrorCode(error, "ENOENT"))
            throw error;
    }
    const next = Object.freeze({ schemaVersion: 1, kind: "signed-native",
        transactionId: identity.transactionId, sourceSha: identity.sourceSha,
        target: identity.target, runtimeContractSha256: identity.runtimeContractSha256, status });
    const allowed = {
        // An installer may cancel *before scheduling launchd* only after
        // rechecking old A + its live health. It uses rolling_back/rolled_back
        // and the exact same terminal release gate, never deletes active.json.
        admitted: ["activating", "rolling_back"], activating: ["rolling_back", "healthy"],
        rolling_back: ["rolled_back", "rollback_failed"],
        healthy: [], rolled_back: [], rollback_failed: [],
    };
    if (!previous && status !== "admitted")
        throw new Error("Signed native owner has no admitted durable receipt.");
    if (previous && previous.status !== status && !allowed[previous.status].includes(status)) {
        throw new Error("Signed native receipt cannot advance from its durable terminal/rollback stage.");
    }
    if (previous?.status === status)
        return previous;
    if (previous) {
        // Replacement is a SHA-256 compare-and-swap: two detached invocations
        // sharing a transaction ID cannot silently overwrite another's phase.
        const { data } = await readBoundedNormalFile(receiptPath, {
            fsImpl, minBytes: 30, maxBytes: 1024, encoding: "utf8",
            label: "Signed native durable receipt",
        });
        const current = validateSignedNativeReceipt(JSON.parse(data), identity);
        if (current.status !== previous.status) {
            throw new Error("Signed native receipt stage changed before publication.");
        }
        await writeBoundedUtf8File(receiptPath, {
            content: JSON.stringify(next) + "\n",
            expectedSha256: createHash("sha256").update(data).digest("hex"),
            fsImpl, maxBytes: 1024, maxExistingBytes: 1024, label: "Signed native durable receipt",
        });
    }
    else {
        await writeAtomicPrivateJson(receiptPath, next, { fsImpl });
    }
    return await readEquinoxLocalSignedNativeMacReceipt({ ...identity, fsImpl });
}
// The exact terminal lock inode is retained in receipts/ before the shared
// active.json name is released. Crash between link and unlink is resumable
// ONLY when both names still refer to the original signed-native lock inode.
export async function releaseEquinoxLocalSignedNativeMacOwner({ fsImpl = fs, ...identity }) {
    const paths = recoveryPath(identity.transactionRoot, identity.transactionId);
    const lockPath = path.join(paths.root, "active.json");
    const archivePath = path.join(paths.root, "receipts", identity.transactionId + ".signed-native-owner.json");
    const receiptPath = signedNativeReceiptPath(identity);
    let stat;
    try {
        stat = await fsImpl.lstat(lockPath);
    }
    catch (error) {
        if (!hasErrorCode(error, "ENOENT"))
            throw error;
    }
    if (!stat) {
        // A previous release may already have removed active.json. Do not
        // accept an unrelated archived marker as proof of our terminal record.
        const archive = await fsImpl.lstat(archivePath);
        if (!archive.isFile() || archive.isSymbolicLink() ||
            archive.nlink !== 1 || (archive.mode & 0o777) !== 0o600) {
            throw new Error("Signed native release archive is unsafe.");
        }
        const { data } = await readBoundedNormalFile(archivePath, {
            fsImpl, minBytes: 30, maxBytes: 1024, encoding: "utf8", label: "Signed native archived owner",
        });
        let raw;
        try {
            raw = JSON.parse(data);
        }
        catch {
            throw new Error("Signed native archived owner is invalid.");
        }
        exactKeys(raw, ["schemaVersion", "kind", "transactionId", "sourceSha", "target", "runtimeContractSha256"], "Archived signed native owner");
        if (raw.schemaVersion !== 1 || raw.kind !== "signed-native" ||
            raw.transactionId !== identity.transactionId || raw.sourceSha !== identity.sourceSha ||
            raw.target !== identity.target || raw.runtimeContractSha256 !== identity.runtimeContractSha256) {
            throw new Error("Signed native archived owner does not match this transaction.");
        }
        const verified = await readStandaloneNativeReceipt();
        if (!["healthy", "rolled_back"].includes(verified.status)) {
            throw new Error("Signed native release cannot reuse a non-success terminal receipt.");
        }
        return Object.freeze({ released: true, alreadyReleased: true, transactionId: identity.transactionId });
    }
    await assertEquinoxLocalSignedNativeMacOwner({ ...identity, fsImpl });
    const receipt = await readEquinoxLocalSignedNativeMacReceipt({ ...identity, fsImpl });
    if (!["healthy", "rolled_back"].includes(receipt.status)) {
        throw new Error("Signed native owner cannot be released before verified healthy or rolled-back terminal health.");
    }
    const original = await fsImpl.lstat(lockPath);
    if (!original.isFile() || original.isSymbolicLink() ||
        (original.mode & 0o777) !== 0o600 || ![1, 2].includes(original.nlink)) {
        throw new Error("Signed native owner changed before terminal release.");
    }
    try {
        if (original.nlink === 1)
            await fsImpl.link(lockPath, archivePath);
    }
    catch (error) {
        if (!hasErrorCode(error, "EEXIST"))
            throw error;
    }
    const archive = await fsImpl.lstat(archivePath);
    const before = await fsImpl.lstat(lockPath);
    if (!archive.isFile() || archive.isSymbolicLink() ||
        archive.dev !== original.dev || archive.ino !== original.ino ||
        before.dev !== original.dev || before.ino !== original.ino ||
        before.nlink !== 2 || archive.nlink !== 2) {
        throw new Error("Signed native terminal lock archive does not match the active owner inode.");
    }
    const receiptsDir = await fsImpl.open(path.dirname(archivePath), "r");
    try {
        await receiptsDir.sync();
    }
    finally {
        await receiptsDir.close();
    }
    // No other actor should mutate a claimed signed-native owner; check
    // identity again before releasing the global Main lock name.
    await assertEquinoxLocalSignedNativeMacOwner({ ...identity, fsImpl });
    await fsImpl.unlink(lockPath);
    const rootDir = await fsImpl.open(paths.root, "r");
    try {
        await rootDir.sync();
    }
    finally {
        await rootDir.close();
    }
    return Object.freeze({ released: true, alreadyReleased: false, transactionId: identity.transactionId });
    async function readStandaloneNativeReceipt() {
        const st = await fsImpl.lstat(receiptPath);
        if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 ||
            (st.mode & 0o777) !== 0o600) {
            throw new Error("Signed native terminal receipt is unsafe.");
        }
        const raw = await readBoundedJsonFile(receiptPath, { fsImpl });
        return validateSignedNativeReceipt(raw, identity);
    }
}
async function previousReleaseFromDescriptor({ descriptor, transactionRoot, installation, fsImpl, inspectStoredReleaseImpl }) {
    if (descriptor.previous.kind === "none") {
        throw new Error("Clean Main first-install has no previous release; it cannot use existing A recovery.");
    }
    if (descriptor.previous.kind === "main") {
        if (descriptor.previous.target !== descriptor.target)
            throw new Error("Main native previous target does not match recovery target.");
        const stored = await inspectStoredReleaseImpl({
            transactionRoot,
            sourceSha: descriptor.previous.sourceSha,
            target: descriptor.previous.target,
            expectedRuntimeContractSha256: descriptor.previous.runtimeContractSha256,
            fsImpl,
        });
        return stored.releaseDir;
    }
    const releasesRoot = requireAbsolute(installation?.releasesRoot, "Managed stable releases root", installation?.platform === "win32" ? path.win32 : path);
    const pathApi = installation?.platform === "win32" ? path.win32 : path;
    const releaseDir = pathApi.join(releasesRoot, descriptor.previous.version);
    if (pathApi.dirname(releaseDir) !== releasesRoot)
        throw new Error("Stable native recovery release escaped the managed releases root.");
    return releaseDir;
}
export async function recoverEquinoxLocalMainNativeLifecycle({ transition, transactionRoot, transactionId, installation = resolveEquinoxLocalInstallation(), fsImpl = fs, execFileImpl, env = process.env, windowsAdmission = null, createBoundWindowsABImpl = createSupervisorBoundWindowsNativeABLifecycle, readDescriptorImpl = readEquinoxLocalMainNativeRecoveryDescriptor, inspectStoredReleaseImpl = inspectEquinoxLocalMainNativeStoredRelease, verifySignedPointerImpl = validateTrustedMainInstallPointer, readPointerImpl = readEquinoxLocalMainNativePointer, createPointerTransitionImpl = createEquinoxLocalMainNativePointerTransition, createMacLinkTransitionImpl = createEquinoxLocalMainMacCurrentLinkTransition, writePointerImpl = writeEquinoxLocalMainNativePointer, inspectDarwinSnapshotImpl = inspectEquinoxLocalNativeAppHostSnapshot, activateDarwinImpl = synchronizeEquinoxLocalAppHostForRelease, restoreDarwinImpl = restoreEquinoxLocalNativeAppHostSnapshot, assertWindowsNativeHostImpl = assertWindowsNativeMessagingHostOwnership, registerWindowsNativeHostImpl = registerWindowsNativeMessagingHost, windowsLauncherPathImpl = windowsNativeMessagingLauncherPath, } = {}) {
    if (transition?.mode !== "artifact_required")
        throw new Error("Main native recovery requires an artifact transition.");
    if (!installation?.managed || !installation?.selfUpdateSupported || installation.target !== transition.target)
        throw new Error("Main native recovery requires the matching managed installation.");
    if (transition.target.startsWith("win32-")) {
        // Crash recovery must not inspect or touch native A/B slots without the
        // exact admitted, independent Windows owner even when the journal exists.
        requireWindowsNativeABSupervisor({ windowsAdmission, transition, transactionId: transactionId });
    }
    const paths = recoveryPath(transactionRoot, transactionId);
    const id = assertTransactionId(transactionId);
    const descriptor = await readDescriptorImpl({
        transactionRoot: paths.root,
        transactionId: id,
        expected: { targetSha: transition.targetSha, target: transition.target, targetRuntimeContractSha256: transition.targetRuntimeContractSha256 },
        fsImpl,
    });
    if (descriptor.previous.kind === "none") {
        if (!/^darwin-(arm64|x64)$/u.test(transition.target) ||
            installation.releaseDir !== null || !installation.installRoot) {
            throw new Error("Empty Main recovery has no authenticated first-install macOS baseline.");
        }
        const stored = await inspectStoredReleaseImpl({ transactionRoot: paths.root,
            sourceSha: transition.targetSha, target: transition.target,
            expectedRuntimeContractSha256: transition.targetRuntimeContractSha256, fsImpl });
        const expectedB = path.posix.join(paths.root, "native-store", transition.target, transition.targetSha, "release");
        if (stored.releaseDir !== expectedB ||
            stored.sourceSha !== transition.targetSha ||
            stored.target !== transition.target ||
            stored.runtimeContractSha256 !== transition.targetRuntimeContractSha256) {
            throw new Error("Empty Main recovery stored immutable B release drifted.");
        }
        const selectorPath = path.posix.join(path.posix.dirname(expectedB), "signed-selector.json");
        const st = await fsImpl.lstat(selectorPath);
        if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || (st.mode & 0o777) !== 0o600) {
            throw new Error("Empty Main recovery selector is not a private normal file.");
        }
        const { data } = await readBoundedNormalFile(selectorPath, { fsImpl,
            minBytes: 200, maxBytes: 16 * 1024, encoding: "utf8", label: "Signed first Main selector" });
        const signed = verifySignedPointerImpl(JSON.parse(data), {
            expectedSourceSha: transition.targetSha,
        });
        const row = signed.targets.find(entry => entry.target === transition.target);
        if (!row || row.runtimeContractSha256 !== transition.targetRuntimeContractSha256 ||
            stored.payloadVersion !== signed.version ||
            stored.manifest?.artifactSha256 !== row.artifact.sha256 ||
            stored.manifest?.artifactBytes !== row.artifact.bytes) {
            throw new Error("Clean Main recovery signed selector differs from immutable B store.");
        }
        const homeDir = path.posix.dirname(path.posix.dirname(path.posix.dirname(path.posix.resolve(installation.installRoot))));
        const { createEquinoxLocalMainMacFreshFirstLifecycle } = await import("./equinox-local-main-native-activation.js");
        const fresh = await createEquinoxLocalMainMacFreshFirstLifecycle({
            transactionRoot: paths.root, target: transition.target,
            sourceSha: transition.targetSha,
            runtimeContractSha256: transition.targetRuntimeContractSha256,
            releaseDir: expectedB, homeDir, fsImpl,
            ...(execFileImpl === undefined ? {} : { execFileImpl }),
        });
        return Object.freeze({ ...fresh, target: transition.target, stored, descriptor,
            previousPointer: null, rollbackPath: null });
    }
    const stored = await inspectStoredReleaseImpl({ transactionRoot: paths.root, sourceSha: transition.targetSha, target: transition.target, expectedRuntimeContractSha256: transition.targetRuntimeContractSha256, fsImpl });
    const previousReleaseDir = await previousReleaseFromDescriptor({ descriptor, transactionRoot: paths.root, installation, fsImpl, inspectStoredReleaseImpl });
    const pointerValue = Object.freeze({ schemaVersion: 1, channel: "main", sourceSha: transition.targetSha, target: transition.target, runtimeContractSha256: transition.targetRuntimeContractSha256 });
    if (transition.target.startsWith("darwin-")) {
        const homeDir = requireAbsolute(installation.installRoot, "Managed installation root").replace(/\/Library\/Application Support\/Equinox Local$/u, "");
        if (!homeDir || path.join(homeDir, "Library", "Application Support", "Equinox Local") !== path.resolve(requireAbsolute(installation.installRoot, "Managed installation root")))
            throw new Error("Managed macOS installation root cannot be mapped to the user home directory.");
        const snapshotPath = path.join(paths.rollbackRoot, "Equinox Local.app");
        await inspectDarwinSnapshotImpl({ snapshotPath, fsImpl, execFileImpl });
        const selectorPath = path.join(path.dirname(stored.releaseDir), "signed-selector.json");
        let selectorStat;
        try {
            selectorStat = await fsImpl.lstat(selectorPath);
        }
        catch (error) {
            if (!hasErrorCode(error, "ENOENT"))
                throw error;
        }
        if (selectorStat) {
            // A signed, Git-free immutable B must be recovered with BOTH its
            // current-native pointer and LaunchAgent link. If a forged selector is
            // present, NEVER silently downgrade to the old transient recovery.
            if (!selectorStat.isFile() || selectorStat.isSymbolicLink() ||
                selectorStat.nlink !== 1 || (selectorStat.mode & 0o777) !== 0o600) {
                throw new Error("Signed Main crash recovery selector is not a private normal file.");
            }
            const { data } = await readBoundedNormalFile(selectorPath, { fsImpl, minBytes: 200,
                maxBytes: 16 * 1024, encoding: "utf8", label: "Signed Main recovery selector" });
            let raw;
            try {
                raw = JSON.parse(data);
            }
            catch {
                throw new Error("Signed Main recovery selector JSON is invalid.");
            }
            const signed = verifySignedPointerImpl(raw, { expectedSourceSha: transition.targetSha });
            const selected = signed.targets.find(row => row.target === transition.target);
            if (!selected || selected.runtimeContractSha256 !== transition.targetRuntimeContractSha256 ||
                stored.sourceSha !== signed.sourceSha ||
                stored.target !== transition.target ||
                stored.runtimeContractSha256 !== selected.runtimeContractSha256 ||
                stored.payloadVersion !== signed.version ||
                stored.manifest?.artifactSha256 !== selected.artifact.sha256 ||
                stored.manifest?.artifactBytes !== selected.artifact.bytes) {
                throw new Error("Signed Main recovery stored native B differs from production selector.");
            }
            const previous = descriptor.previous.kind === "main" ? {
                sourceSha: descriptor.previous.sourceSha, target: descriptor.previous.target,
                runtimeContractSha256: descriptor.previous.runtimeContractSha256,
            } : null;
            const nativePointer = createPointerTransitionImpl({
                pointerPath: paths.pointerPath, transactionRoot: paths.root, target: pointerValue,
                previous, fsImpl, readPointer: readPointerImpl, writePointer: writePointerImpl,
            });
            const macLink = createMacLinkTransitionImpl({
                installRoot: installation.installRoot, target: pointerValue,
                previousReleaseDir, fsImpl,
            });
            return Object.freeze({
                target: transition.target, stored, descriptor, previousPointer: previous, rollbackPath: snapshotPath,
                activate: async () => {
                    await nativePointer.selectTarget();
                    await macLink.selectTarget();
                    await activateDarwinImpl({ installation, releaseDir: stored.releaseDir, fsImpl, execFileImpl, requirePayloadIdentity: true });
                },
                rollback: async () => {
                    // Preflight BOTH pointers before mutating either: foreign owners
                    // cannot trick partial rollback into mixing A and another SHA.
                    const observedLink = await macLink.current();
                    if (observedLink !== previousReleaseDir && observedLink !== macLink.targetReleaseDir) {
                        throw new Error("Signed native Mac rollback link is outside admitted A/B.");
                    }
                    await nativePointer.assertRollbackAdmitted();
                    await macLink.restorePrevious();
                    await nativePointer.restorePrevious();
                    await restoreDarwinImpl({ homeDir, snapshotPath, fsImpl, execFileImpl });
                },
                commit: async () => {
                    await nativePointer.requireTarget();
                    if (await macLink.current() !== macLink.targetReleaseDir) {
                        throw new Error("Recovered signed Main macOS B link is not durably selected.");
                    }
                    return stored;
                },
            });
        }
        return Object.freeze({
            target: transition.target,
            stored,
            descriptor,
            rollbackPath: snapshotPath,
            activate: async () => activateDarwinImpl({ installation, releaseDir: stored.releaseDir, fsImpl, execFileImpl, requirePayloadIdentity: true }),
            rollback: async () => restoreDarwinImpl({ homeDir, snapshotPath, fsImpl, execFileImpl }),
            commit: async () => writePointerImpl(paths.pointerPath, pointerValue, { transactionRoot: paths.root, fsImpl }),
        });
    }
    if (!transition.target.startsWith("win32-"))
        throw new Error("Main native recovery target is unsupported.");
    const programRoot = requireAbsolute(installation.programRoot, "Managed Windows program root", path.win32);
    const manifestRoot = requireAbsolute(installation.nativeMessagingManifestRoot, "Managed Windows Native Messaging root", path.win32);
    const previousRelease = requireAbsolute(previousReleaseDir, "Previous Windows native release", path.win32);
    const targetRelease = requireAbsolute(stored.releaseDir, "Target Windows native release", path.win32);
    // Native A/B journal owns rollback. Do not require the legacy WPF snapshot
    // for healthy B or an interrupted native A restoration.
    return createBoundWindowsABImpl({ windowsAdmission, transition, transactionId: id, stored,
        previousPointer: descriptor.previous, previousReleaseDir: previousRelease,
        programRoot, manifestRoot, transactionRoot: paths.root, pointerPath: paths.pointerPath,
        fsImpl, execFileImpl, env, writePointerImpl, assertNativeHostImpl: assertWindowsNativeHostImpl,
        registerNativeHostImpl: registerWindowsNativeHostImpl, launcherPathImpl: windowsLauncherPathImpl });
}
