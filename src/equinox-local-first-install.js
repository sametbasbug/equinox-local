import { execFile as execFileCallback, spawn as spawnChild } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { bootstrapManagedEquinoxUser, EQUINOX_LOCAL_LAUNCH_AGENT_LABEL, } from "./equinox-local-bootstrap.js";
import { activatePreparedEquinoxRelease, kickstartEquinoxLocalLaunchAgent, readManagedCurrentRelease, synchronizeManagedShellForRelease, waitForEquinoxLocalManagedSource, waitForEquinoxLocalVersion, } from "./equinox-local-update-activation.js";
import { compareEquinoxVersions, equinoxLocalUpdateTarget, parseEquinoxVersion, } from "./equinox-local-updater.js";
import { managedSupervisorPaths } from "./equinox-local-supervisor.js";
import { enrollEquinoxLocalManagedSource, rollbackEquinoxLocalManagedSourceEnrollment } from "./equinox-local-managed-source-enrollment.js";
import { equinoxLocalManagedSourcePaths, resolveEquinoxLocalManagedSourceInstallation } from "./equinox-local-managed-source-installation.js";
import { resolveEquinoxLocalInstallation } from "./equinox-local-installation.js";
import { inspectEquinoxLocalMainNativeStoredRelease } from "./equinox-local-main-native-state.js";
import { validateManagedSourceInstallStamp } from "./equinox-local-main-update.js";
import { readEquinoxLocalMainNativePointer, writeEquinoxLocalMainNativePointer } from "./equinox-local-main-native-state.js";
import { createEquinoxLocalMainMacCurrentLinkTransition } from "./equinox-local-main-native-pointer-transition.js";
import { validateTrustedMainInstallPointer } from "./equinox-local-main-install-pointer.js";
import { readEquinoxLocalMainSourcePointer } from "./equinox-local-main-source-pointer.js";
import { reconcileWindowsClassicRepairJournal, writeWindowsClassicRepairJournal, } from "./equinox-local-windows-classic-repair-journal.js";
import { pruneInactiveManagedStableReleases } from "./equinox-local-release-retention.js";
import { readBoundedNormalFile } from "./equinox-local-safe-file.js";
import { protectWindowsPrivateStatePath, verifyWindowsPrivateStateAcl } from "./equinox-local-private-state.js";
import { assertWindowsNativeMessagingHostOwnership, windowsNativeMessagingLauncherPath } from "./equinox-browser-windows-native-messaging.js";
import { assertWindowsStableShellOwnedByRelease } from "./equinox-local-windows-stable-shell.js";
import { requestWindowsShellRuntimeRestart, requestWindowsShellUpdateShutdown, waitForWindowsShellPipeRelease } from "./equinox-local-windows-shell-control.js";
import { provisionWindowsGuardianFromRelease } from "./equinox-local-windows-guardian-provision.js";
import { readEquinoxLocalCurrentVersionPointer, writeEquinoxLocalCurrentVersionPointer } from "./equinox-local-current-release.js";
import { fingerprintEquinoxLocalNativeState } from "./equinox-local-native-state-fingerprint.js";
import { preserveOriginalSignedWindowsArchive } from "./equinox-local-signed-windows-archive.js";
import { initializeManagedOnboardingState } from "./equinox-local-onboarding.js";
import { equinoxLocalReleaseRuntimeContract } from "./equinox-local-release-runtime-contract.js";
import { equinoxLocalToolchainContract } from "./equinox-local-toolchain-contract.js";
import { launchWindowsStableShell, renameWindowsPathWhenUnlocked, synchronizeFreshWindowsShell, } from "./equinox-local-windows-stable-shell.js";
import { walkBoundedReleaseTree } from "./equinox-local-release-tree.js";
export { sameWindowsStableShellTree, snapshotWindowsStableShellTree, stageWindowsStableShellForRelease, synchronizeFreshWindowsShell, } from "./equinox-local-windows-stable-shell.js";
export { launchWindowsStableShell as launchFreshWindowsShell } from "./equinox-local-windows-stable-shell.js";
const execFile = promisify(execFileCallback);
const MAX_RELEASE_METADATA_BYTES = 16 * 1024;
const FIRST_INSTALL_HEALTH_ATTEMPTS = 120;
const FIRST_INSTALL_WINDOWS_HEALTH_ATTEMPTS = 180;
const FIRST_INSTALL_HEALTH_DELAY_MS = 500;
const FIRST_INSTALL_DIAGNOSTIC_BYTES = 12 * 1024;
export function equinoxLocalFirstInstallHealthBudget({ platform = process.platform, arch = process.arch } = {}) {
    const attempts = platform === "win32" && ["x64", "arm64"].includes(arch)
        ? FIRST_INSTALL_WINDOWS_HEALTH_ATTEMPTS
        : FIRST_INSTALL_HEALTH_ATTEMPTS;
    return Object.freeze({ attempts, delayMs: FIRST_INSTALL_HEALTH_DELAY_MS });
}
function inside(parent, child, pathApi = path) {
    const relative = pathApi.relative(parent, child);
    return relative !== "" && !relative.startsWith("..") && !pathApi.isAbsolute(relative);
}
function exactKeys(value, expected, label) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label} must be an object.`);
    }
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
        throw new Error(`${label} contains missing or unsupported fields.`);
    }
}
async function assertOwnedNormalDirectory(directory, { uid, platform = process.platform, fsImpl = fs, create = false, mode = 0o700, } = {}) {
    if (create)
        await fsImpl.mkdir(directory, { recursive: true, mode });
    const stat = await fsImpl.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error(`Unsafe managed directory: ${directory}`);
    if (platform === "darwin") {
        if (Number.isInteger(uid) && Number.isInteger(stat.uid) && stat.uid !== uid) {
            throw new Error(`Managed directory is not owned by the current user: ${directory}`);
        }
        if ((stat.mode & 0o022) !== 0)
            throw new Error(`Managed directory is writable by group or other users: ${directory}`);
        await fsImpl.chmod(directory, mode).catch(() => { });
    }
    return stat;
}
async function assertNormalFile(filePath, label, { executable = false, maxBytes = null, fsImpl = fs } = {}) {
    const stat = await fsImpl.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error(`${label} must be a normal file.`);
    if (Number.isFinite(maxBytes) && (stat.size < 1 || stat.size > maxBytes))
        throw new Error(`${label} has an invalid size.`);
    if (executable && (stat.mode & 0o111) === 0)
        throw new Error(`${label} must be executable.`);
    return stat;
}
async function validateReleaseTree(root, { fsImpl = fs } = {}) {
    return walkBoundedReleaseTree(root, {
        fsImpl,
        countName: "entryCount",
        errors: {
            entryLimit: "Staged Equinox Local release contains too many entries.",
            byteLimit: "Staged Equinox Local release exceeds the extracted size limit.",
            symlink: "Staged Equinox Local release may not contain symbolic links.",
            unsupportedEntry: "Staged Equinox Local release contains an unsupported filesystem entry.",
        },
    });
}
export async function validateFirstInstallRelease(releaseDir, { target = equinoxLocalUpdateTarget(), expectedMainSourceSha = null, expectedMainVersion = null, fsImpl = fs, } = {}) {
    // A source-SHA installer must not infer identity from a manual 6.x version.
    // The caller's expected SHA/version must originate from the production-
    // signed selector AND its verified archived bytes, not untrusted metadata.
    if (expectedMainSourceSha !== null &&
        (typeof expectedMainSourceSha !== "string" || !/^[a-f0-9]{40}$/u.test(expectedMainSourceSha))) {
        throw new Error("Main native candidate requires a signed exact source SHA.");
    }
    if (expectedMainVersion !== null &&
        (typeof expectedMainVersion !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(expectedMainVersion))) {
        throw new Error("Main native candidate requires an exact signed presentation version.");
    }
    if ((expectedMainSourceSha === null) !== (expectedMainVersion === null)) {
        throw new Error("Main native candidate requires both signed source SHA and version.");
    }
    if (typeof releaseDir !== "string" || !path.isAbsolute(releaseDir)) {
        throw new Error("Staged Equinox Local release path must be absolute.");
    }
    const rootStat = await fsImpl.lstat(releaseDir);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
        throw new Error("Staged Equinox Local release must be a normal directory.");
    const tree = await validateReleaseTree(releaseDir, { fsImpl });
    const metadataPath = path.join(releaseDir, "release.json");
    await assertNormalFile(metadataPath, "Release metadata", { maxBytes: MAX_RELEASE_METADATA_BYTES, fsImpl });
    const metadata = JSON.parse(await fsImpl.readFile(metadataPath, "utf8"));
    const runtimeContract = equinoxLocalReleaseRuntimeContract({ target, version: metadata.version });
    const sourceIdentityKeys = Object.hasOwn(metadata, "sourceSha") ? ["sourceSha"] : [];
    const metadataKeys = runtimeContract.platform === "darwin"
        ? ["schemaVersion", "version", "target", ...sourceIdentityKeys, "nodeVersion", "tunnelClientVersion", "nativeAppShellVersion", "serverEntry"]
        : ["schemaVersion", "version", "target", ...sourceIdentityKeys, "nodeVersion", "tunnelClientVersion", "serverEntry"];
    exactKeys(metadata, metadataKeys, "Release metadata");
    if (metadata.schemaVersion !== 1 ||
        metadata.target !== target ||
        metadata.serverEntry !== "server.js" ||
        (metadata.sourceSha !== undefined && (typeof metadata.sourceSha !== "string" || !/^[a-f0-9]{40}$/u.test(metadata.sourceSha))) ||
        typeof metadata.nodeVersion !== "string" ||
        !/^\d+\.\d+\.\d+$/u.test(metadata.nodeVersion) ||
        typeof metadata.tunnelClientVersion !== "string" ||
        !/^\d+\.\d+\.\d+$/u.test(metadata.tunnelClientVersion) ||
        (runtimeContract.platform === "darwin" && (!Number.isSafeInteger(metadata.nativeAppShellVersion) || metadata.nativeAppShellVersion < 1))) {
        throw new Error(`Staged Equinox Local release metadata is invalid for ${target}.`);
    }
    parseEquinoxVersion(metadata.version);
    if (expectedMainSourceSha !== null &&
        (metadata.sourceSha !== expectedMainSourceSha || metadata.version !== expectedMainVersion)) {
        throw new Error("Main native release metadata does not match the signed full source SHA/version.");
    }
    for (const relative of runtimeContract.runtimeExecutables) {
        await assertNormalFile(path.join(releaseDir, relative), `Runtime ${relative}`, { executable: runtimeContract.executableModeRequired, fsImpl });
    }
    for (const relative of runtimeContract.runtimeDocuments) {
        await assertNormalFile(path.join(releaseDir, relative), `Runtime ${relative}`, { fsImpl });
    }
    for (const relative of runtimeContract.nativeShellFiles) {
        await assertNormalFile(path.join(releaseDir, relative), `Native shell ${relative}`, { fsImpl });
    }
    if (runtimeContract.nativeAppKind === "macos-app") {
        await assertNormalFile(path.join(releaseDir, "runtime", "app", "applet"), "Native app executable", { executable: true, fsImpl });
        await assertNormalFile(path.join(releaseDir, "runtime", "app", "EquinoxLocal.png"), "Native app icon", { fsImpl });
        await assertNormalFile(path.join(releaseDir, "runtime", "app", "native-app.json"), "Native app metadata", { fsImpl });
    }
    for (const relative of runtimeContract.requiredReleaseFiles) {
        await assertNormalFile(path.join(releaseDir, relative), `Release ${relative}`, { fsImpl });
    }
    return Object.freeze({
        version: metadata.version,
        target: metadata.target,
        releaseDir,
        metadata: Object.freeze({ ...metadata }),
        tree: tree,
    });
}
function installationFor(paths, releaseDir, { platform = process.platform, arch = process.arch, target = equinoxLocalUpdateTarget({ platform, arch }), } = {}) {
    const pathApi = platform === "win32" ? path.win32 : path.posix;
    return Object.freeze({
        kind: "managed",
        managed: true,
        selfUpdateSupported: true,
        platform,
        arch,
        target,
        lifecycleKind: platform === "win32" ? "windows-user" : "launch-agent",
        installRoot: paths.installRoot,
        releasesRoot: paths.releasesRoot,
        releaseDir,
        currentLink: platform === "darwin" ? paths.currentLink : null,
        currentPointer: paths.currentPointer,
        programRoot: paths.programRoot,
        nativeMessagingManifestRoot: paths.nativeMessagingManifestRoot,
        stagingRoot: pathApi.join(paths.installRoot, "staging"),
        launchAgentPath: platform === "darwin"
            ? path.posix.join(paths.homeDir, "Library", "LaunchAgents", `${EQUINOX_LOCAL_LAUNCH_AGENT_LABEL}.plist`)
            : null,
        launchAgentLabel: platform === "darwin" ? EQUINOX_LOCAL_LAUNCH_AGENT_LABEL : null,
    });
}
async function atomicInitialCurrentPointer(paths, targetRelease, candidate, { platform = process.platform, target = candidate.target, fsImpl = fs, } = {}) {
    const pathApi = platform === "win32" ? path.win32 : path.posix;
    const pointerPath = platform === "win32" ? paths.currentPointer : paths.currentLink;
    try {
        await fsImpl.lstat(pointerPath);
        throw new Error("Managed current pointer appeared during first-install promotion.");
    }
    catch (error) {
        if (error?.code !== "ENOENT")
            throw error;
    }
    if (pathApi.dirname(targetRelease) !== paths.releasesRoot) {
        throw new Error("First-install current pointer target is unsafe.");
    }
    if (platform === "win32") {
        await writeEquinoxLocalCurrentVersionPointer(paths.currentPointer, {
            version: candidate.version,
            fsImpl,
            platform: "win32",
            target,
        });
        return;
    }
    const relative = path.posix.relative(paths.installRoot, targetRelease);
    if (!relative.startsWith("releases/"))
        throw new Error("First-install current pointer target is unsafe.");
    const temporary = path.posix.join(paths.installRoot, `.current-install-${process.pid}-${randomBytes(8).toString("hex")}`);
    try {
        await fsImpl.symlink(relative, temporary, "dir");
        await fsImpl.rename(temporary, paths.currentLink);
    }
    catch (error) {
        await fsImpl.rm(temporary, { force: true }).catch(() => { });
        throw error;
    }
}
function boundedDiagnostic(value, maxChars = 1200) {
    return String(value ?? "")
        .replace(/[\r\u0000-\u001f\u007f]+/gu, " ")
        .replace(/\n{3,}/gu, "\n\n")
        .trim()
        .slice(-maxChars);
}
async function readDiagnosticTail(filePath, { fsImpl = fs, maxBytes = FIRST_INSTALL_DIAGNOSTIC_BYTES } = {}) {
    if (typeof fsImpl.open !== "function")
        return null;
    let handle = null;
    try {
        handle = await fsImpl.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size < 1)
            return null;
        const length = Math.min(stat.size, maxBytes);
        const offset = Math.max(0, stat.size - length);
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        return boundedDiagnostic(buffer.subarray(0, bytesRead).toString("utf8"));
    }
    catch {
        return null;
    }
    finally {
        if (handle)
            await handle.close().catch(() => { });
    }
}
async function windowsFirstInstallActivationDiagnostics({ paths, fsImpl = fs }) {
    const errorLog = await readDiagnosticTail(path.win32.join(paths.logsRoot, "windows-shell-runtime.log"), { fsImpl });
    return errorLog ? boundedDiagnostic(`Windows shell runtime error log tail: ${errorLog}`, 1_800) : "";
}
async function firstInstallActivationDiagnostics({ homeDir, uid, execFileImpl = execFile, fsImpl = fs }) {
    const parts = [];
    const service = `gui/${uid}/${EQUINOX_LOCAL_LAUNCH_AGENT_LABEL}`;
    try {
        const result = await execFileImpl("/bin/launchctl", ["print", service], {
            timeout: 5_000,
            maxBuffer: 1024 * 1024,
        });
        const output = String(result?.stdout ?? "");
        const state = /^\s*state = (.+)$/mu.exec(output)?.[1]?.trim() ?? null;
        const pid = /^\s*pid = (\d+)$/mu.exec(output)?.[1] ?? null;
        const lastExit = /^\s*last exit code = (.+)$/mu.exec(output)?.[1]?.trim() ?? null;
        const summary = [state ? `state=${state}` : null, pid ? `pid=${pid}` : null, lastExit ? `lastExit=${lastExit}` : null].filter(Boolean).join(", ");
        if (summary)
            parts.push(`LaunchAgent ${summary}`);
    }
    catch (error) {
        parts.push(`LaunchAgent unavailable (${boundedDiagnostic(error instanceof Error ? error.message : error, 240)})`);
    }
    const errorLog = await readDiagnosticTail(path.join(homeDir, "Library", "Logs", "Equinox Local.error.log"), { fsImpl });
    if (errorLog)
        parts.push(`error log tail: ${errorLog}`);
    return boundedDiagnostic(parts.join(" | "), 1_800);
}
async function reloadLaunchAgent(installation, { uid, execFileImpl = execFile, }) {
    if (!Number.isInteger(uid) || uid < 1)
        throw new Error("A non-root user id is required to load Equinox Local.");
    const service = `gui/${uid}/${EQUINOX_LOCAL_LAUNCH_AGENT_LABEL}`;
    await execFileImpl("/bin/launchctl", ["bootout", service], {
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
    }).catch(() => ({ stdout: "", stderr: "" }));
    await execFileImpl("/bin/launchctl", ["bootstrap", `gui/${uid}`, installation.launchAgentPath], {
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
    });
    await execFileImpl("/bin/launchctl", ["kickstart", service], {
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
    });
}
// Older Main enrollment retains the signed Stable WPF/Native Messaging at the
// numbered release path and has no current-native.json until a native update.
// Accept that exact installation only after proving both existing native owners.
async function inspectLegacyWindowsMainHost(installation, { version, releaseDir, verifyShell = false, fsImpl = fs }) {
    const original = path.win32.join(installation.releasesRoot, version);
    await assertWindowsNativeMessagingHostOwnership({
        manifestRoot: installation.nativeMessagingManifestRoot,
        acceptedLauncherPaths: [windowsNativeMessagingLauncherPath(original)],
        fsImpl,
    });
    if (verifyShell) {
        await assertWindowsStableShellOwnedByRelease({ releaseDir, programRoot: installation.programRoot, fsImpl });
    }
}
// The unchanged version pointer cannot distinguish Main A from signed Stable B.
// Keep A and a small identity record outside the numbered release until B is
// HEALTHY/managed. Presence of the parked stamp means rollback is still owed;
// deleting it is the commit point. No user-owned state is moved or removed.
async function repairSameVersionMain({ paths, mainPaths, installation, candidate = null, mainStamp = null, uid, platform, arch, target, fsImpl, execFileImpl, syncManagedShellImpl, stopWindowsShellImpl, launchWindowsShellImpl, waitForVersionImpl, windowsRenameSleepImpl, inspectLegacyMainHostImpl, }) {
    const pathApi = platform === "win32" ? path.win32 : path.posix;
    const backupRoot = pathApi.join(paths.installRoot, ".stable-repair-backup");
    const recordPath = pathApi.join(backupRoot, "repair.json");
    const temporaryRecord = pathApi.join(backupRoot, ".repair-next.json");
    const oldRelease = pathApi.join(backupRoot, "release");
    const failedRelease = pathApi.join(backupRoot, "failed-release");
    const savedStamp = `${mainPaths.installStampPath}.stable-install-backup`;
    const statOrNull = (name) => fsImpl.lstat(name).catch((error) => {
        if (error?.code === "ENOENT")
            return null;
        throw error;
    });
    const readStamp = async (name) => {
        const file = await readBoundedNormalFile(name, {
            fsImpl, platform, minBytes: 1, maxBytes: 8 * 1024, encoding: "utf8", label: "Stable repair Main identity",
        }).catch((error) => {
            if (error?.code === "ENOENT")
                return null;
            throw error;
        });
        if (file)
            validateManagedSourceInstallStamp(JSON.parse(file.data));
        return file?.data ?? null;
    };
    const rename = (from, to) => platform === "win32"
        ? renameWindowsPathWhenUnlocked(from, to, { fsImpl, sleepImpl: windowsRenameSleepImpl })
        : fsImpl.rename(from, to);
    const fingerprint = async (root) => (await fingerprintEquinoxLocalNativeState(root, { fsImpl })).sha256;
    const assertFingerprint = async (root, expected) => {
        if (await fingerprint(root) !== expected)
            throw new Error("Stable repair release identity changed; refusing unexpected state.");
    };
    const nativePointer = async (version) => {
        const pointerPath = pathApi.join(mainPaths.mainTransactionRoot, "current-native.json");
        const pointer = await statOrNull(pointerPath) ? await readEquinoxLocalMainNativePointer(pointerPath, {
            transactionRoot: mainPaths.mainTransactionRoot, fsImpl,
        }) : null;
        if (pointer && (pointer.target !== target || pointer.payloadVersion !== version)) {
            throw new Error("Stable repair old Main native identity does not match the numbered release.");
        }
        if (platform === "win32" && !pointer) {
            // Only the first prepared swap requires the original WPF bytes. On
            // interrupted recovery the shell may legitimately be A or B, while the
            // HKCU manifest must still name this exact owned numbered launcher.
            await inspectLegacyMainHostImpl(installation, {
                version, releaseDir: pathApi.join(paths.releasesRoot, version),
                verifyShell: Boolean(candidate && !record), fsImpl,
            });
        }
        return pointer;
    };
    const assertPointer = async (version) => {
        const expected = pathApi.join(paths.releasesRoot, version);
        if (platform === "win32") {
            const pointer = await readEquinoxLocalCurrentVersionPointer(paths.currentPointer, { platform, target, fsImpl });
            if (pointer.version !== version)
                throw new Error("Stable repair current pointer changed.");
        }
        else {
            const stat = await fsImpl.lstat(paths.currentLink);
            if (!stat.isSymbolicLink() || pathApi.resolve(paths.installRoot, await fsImpl.readlink(paths.currentLink)) !== expected) {
                throw new Error("Stable repair current pointer changed.");
            }
        }
        return expected;
    };
    const stop = async () => {
        if (platform === "win32") {
            // Already stopped is normal on interruption recovery. Locked release
            // renames still fail boundedly rather than deleting a running payload.
            await stopWindowsShellImpl({ platform }).catch(() => null);
        }
        else {
            let loaded = false;
            try {
                await execFileImpl("/bin/launchctl", ["print", `gui/${uid}/${EQUINOX_LOCAL_LAUNCH_AGENT_LABEL}`], { timeout: 5_000, maxBuffer: 64 * 1024 });
                loaded = true;
            }
            catch (error) {
                if (![3, 113].includes(error.code) && error?.code !== "ENOENT")
                    throw error;
            }
            if (loaded)
                await execFileImpl("/bin/launchctl", ["bootout", `gui/${uid}/${EQUINOX_LOCAL_LAUNCH_AGENT_LABEL}`], { timeout: 15_000, maxBuffer: 64 * 1024 });
        }
    };
    const restart = async () => {
        if (platform === "win32")
            await launchWindowsShellImpl(pathApi.join(paths.programRoot, "EquinoxLocal.exe"));
        else
            await reloadLaunchAgent(installation, { uid, execFileImpl });
    };
    const health = (version, kind) => waitForVersionImpl(version, {
        ...equinoxLocalFirstInstallHealthBudget({ platform, arch }), expectedInstallationKind: kind,
    });
    const cleanup = async () => {
        // Keep the record until both trees are gone: an interrupted recursive rm
        // can be retried without demanding an intact, already-retired A payload.
        for (const root of [oldRelease, failedRelease]) {
            const stat = await statOrNull(root);
            if (stat) {
                if (!stat.isDirectory() || stat.isSymbolicLink())
                    throw new Error("Stable repair cleanup path is unsafe.");
                await validateReleaseTree(root, { fsImpl });
                await fsImpl.rm(root, { recursive: true });
            }
        }
        await fsImpl.rm(recordPath);
        await fsImpl.rmdir(backupRoot);
    };
    let record;
    if (await statOrNull(backupRoot)) {
        await assertOwnedNormalDirectory(backupRoot, { uid, platform, fsImpl });
        if (await fsImpl.realpath(backupRoot) !== backupRoot)
            throw new Error("Stable repair backup path is not canonical.");
        const names = await fsImpl.readdir(backupRoot);
        if (names.some((name) => !["repair.json", ".repair-next.json", "release", "failed-release"].includes(name))) {
            throw new Error("Stable repair backup contains unexpected files.");
        }
        if (!names.includes("repair.json")) {
            // Preparation was interrupted before any live files could be moved.
            if (names.some((name) => name !== ".repair-next.json"))
                throw new Error("Stable repair backup has no identity record.");
            if (names.length) {
                await assertNormalFile(temporaryRecord, "Stable repair temporary record", { fsImpl });
                await fsImpl.rm(temporaryRecord);
            }
            await fsImpl.rmdir(backupRoot);
            return null;
        }
        if (names.includes(".repair-next.json"))
            throw new Error("Stable repair contains conflicting identity records.");
        const file = await readBoundedNormalFile(recordPath, { fsImpl, platform, minBytes: 1, maxBytes: 16 * 1024, encoding: "utf8", label: "Stable repair record" });
        record = JSON.parse(file.data);
        exactKeys(record, ["schemaVersion", "version", "target", "mainStamp", "oldSha256", "stableSha256", "nativeSourceSha"], "Stable repair record");
        parseEquinoxVersion(record.version);
        validateManagedSourceInstallStamp(JSON.parse(record.mainStamp));
        if (record.schemaVersion !== 1 || record.target !== target ||
            !/^[a-f0-9]{64}$/u.test(record.oldSha256) || !/^[a-f0-9]{64}$/u.test(record.stableSha256) ||
            (record.nativeSourceSha !== null && !/^[a-f0-9]{40}$/u.test(record.nativeSourceSha))) {
            throw new Error("Stable repair record identity is invalid.");
        }
    }
    else if (!candidate) {
        // A parked selector without our full-tree backup belongs to another
        // operation. Never silently treat that state as a fresh Stable install.
        if (await statOrNull(savedStamp))
            throw new Error("Prior Stable replacement needs reconciliation before another attempt.");
        return null;
    }
    else {
        const targetRelease = await assertPointer(candidate.version);
        if (installation.releaseDir !== targetRelease)
            throw new Error("Same-version Main release path is inconsistent.");
        const old = await validateFirstInstallRelease(targetRelease, { target, fsImpl });
        if (old.version !== candidate.version)
            throw new Error("Same-version Main release identity is inconsistent.");
        if (await readStamp(mainPaths.installStampPath) !== mainStamp || await statOrNull(savedStamp))
            throw new Error("Stable repair Main identity changed.");
        const native = await nativePointer(candidate.version);
        record = { schemaVersion: 1, version: candidate.version, target, mainStamp: mainStamp,
            oldSha256: await fingerprint(targetRelease), stableSha256: await fingerprint(candidate.releaseDir), nativeSourceSha: native?.sourceSha ?? null };
        await fsImpl.mkdir(backupRoot, { mode: 0o700 });
        if (await fsImpl.realpath(backupRoot) !== backupRoot)
            throw new Error("Stable repair backup path is not canonical.");
        const handle = await fsImpl.open(temporaryRecord, "wx", 0o600);
        try {
            await handle.writeFile(`${JSON.stringify(record)}\n`);
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        await fsImpl.rename(temporaryRecord, recordPath);
    }
    const targetRelease = await assertPointer(record.version);
    const liveStamp = await readStamp(mainPaths.installStampPath);
    const parkedStamp = await readStamp(savedStamp);
    if ((liveStamp && parkedStamp) || (liveStamp && liveStamp !== record.mainStamp) || (parkedStamp && parkedStamp !== record.mainStamp)) {
        throw new Error("Stable repair Main selector contains unexpected state.");
    }
    if (!liveStamp && !parkedStamp) {
        // B was committed; A may already be partially deleted. Never resurrect
        // Main just because post-HEALTHY housekeeping was interrupted.
        await assertFingerprint(targetRelease, record.stableSha256);
        await restart();
        await health(record.version, "managed");
        await cleanup();
        return { status: "activated", version: record.version, previousVersion: record.version, configCreated: false };
    }
    const native = await nativePointer(record.version);
    if ((native?.sourceSha ?? null) !== record.nativeSourceSha)
        throw new Error("Stable repair old native pointer changed.");
    const rollback = async () => {
        const backedUp = await statOrNull(oldRelease);
        await assertFingerprint(backedUp ? oldRelease : targetRelease, record.oldSha256);
        if (backedUp && await statOrNull(targetRelease)) {
            await assertFingerprint(targetRelease, record.stableSha256);
            if (await statOrNull(failedRelease))
                throw new Error("Stable repair has duplicate candidate trees.");
        }
        await stop();
        const activeRelease = await statOrNull(targetRelease);
        // If interruption occurred between moving A out and promoting B, the
        // native host was never changed. On Windows the numbered A tree can
        // legitimately differ from the active Main native-store shell, so do not
        // treat that numbered tree as evidence of WPF or Native Messaging ownership.
        if (native && activeRelease) {
            await syncManagedShellImpl(installation, { version: record.version,
                releaseDir: native.releaseDir, previousReleaseDir: targetRelease });
        }
        if (backedUp) {
            if (activeRelease)
                await rename(targetRelease, failedRelease);
            await rename(oldRelease, targetRelease);
        }
        if (!native && platform === "win32" && await statOrNull(failedRelease)) {
            // A classic Main enrollment uses releases/<version> as its ONLY
            // native-host launcher. Restore A at that same address *before* the
            // native sync, so the manifest never points at a removed backup tree.
            await syncManagedShellImpl(installation, { version: record.version,
                releaseDir: targetRelease, previousReleaseDir: failedRelease });
        }
        if (await readStamp(savedStamp))
            await fsImpl.rename(savedStamp, mainPaths.installStampPath);
        await restart();
        await health(record.version, "managed-source");
        await cleanup();
    };
    if (!candidate) {
        await rollback();
        return null;
    }
    try {
        await stop();
        await rename(targetRelease, oldRelease);
        await rename(candidate.releaseDir, targetRelease);
        await fsImpl.rename(mainPaths.installStampPath, savedStamp);
        await syncManagedShellImpl(installation, { version: record.version, releaseDir: targetRelease,
            previousReleaseDir: native?.releaseDir ?? oldRelease });
        await restart();
        await health(record.version, "managed");
    }
    catch (error) {
        try {
            await rollback();
        }
        catch (recoveryError) {
            throw new AggregateError([error, recoveryError], "Same-version Stable repair failed; Main rollback needs recovery on the next installer invocation.");
        }
        throw new Error("Same-version Stable repair failed and was rolled back to Main.", { cause: error });
    }
    await fsImpl.rm(savedStamp);
    await cleanup();
    return { status: "activated", version: record.version, previousVersion: record.version, configCreated: false };
}
// Retain the existing API/CLI opt-in for fresh enrollment too.
// Provenance alone is never user consent to leave Stable.
export async function installManagedEquinoxRelease({ stagedReleaseDir, homeDir = os.homedir(), uid = typeof process.getuid === "function" ? process.getuid() : null, platform = process.platform, arch = process.arch, target = null, allowExistingStableToMainMigration = false, env = process.env, fsImpl = fs, execFileImpl = execFile, bootstrapImpl = bootstrapManagedEquinoxUser, readCurrentImpl = readManagedCurrentRelease, readMainSourcePointerImpl = readEquinoxLocalMainSourcePointer, readMainNativePointerImpl = readEquinoxLocalMainNativePointer, pruneStableImpl = (installation) => pruneInactiveManagedStableReleases(installation, { readCurrent: readManagedCurrentRelease }), activateImpl = activatePreparedEquinoxRelease, waitForVersionImpl = waitForEquinoxLocalVersion, waitForManagedSourceImpl = waitForEquinoxLocalManagedSource, enrollManagedSourceImpl = enrollEquinoxLocalManagedSource, rollbackManagedSourceImpl = rollbackEquinoxLocalManagedSourceEnrollment, requestWindowsRestartImpl = requestWindowsShellRuntimeRestart, initializeOnboardingImpl = initializeManagedOnboardingState, syncWindowsShellImpl = synchronizeFreshWindowsShell, syncManagedShellImpl = synchronizeManagedShellForRelease, stopWindowsShellImpl = requestWindowsShellUpdateShutdown, launchWindowsShellImpl = launchWindowsStableShell, verifyWindowsShellOwnedImpl = assertWindowsStableShellOwnedByRelease, verifyWindowsNativeHostOwnedImpl = assertWindowsNativeMessagingHostOwnership, waitWindowsPipeReleaseImpl = waitForWindowsShellPipeRelease, windowsRenameSleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), inspectLegacyMainHostImpl = inspectLegacyWindowsMainHost, }) {
    if (platform !== "darwin" && !(platform === "win32" && ["arm64", "x64"].includes(arch))) {
        throw new Error(`Equinox Local first install is not implemented for ${platform}-${arch}.`);
    }
    const nativeTarget = equinoxLocalUpdateTarget({ platform, arch });
    const expectedTarget = target || nativeTarget;
    if (platform === "win32" && expectedTarget !== nativeTarget) {
        throw new Error(`Windows first install target ${expectedTarget} does not match native ${nativeTarget}.`);
    }
    const pathApi = platform === "win32" ? path.win32 : path.posix;
    if (platform === "darwin" && (!Number.isInteger(uid) || uid < 1))
        throw new Error("Do not run the Equinox Local installer with sudo or as root.");
    if (typeof homeDir !== "string" || !pathApi.isAbsolute(homeDir))
        throw new Error("A trusted absolute HOME is required for Equinox Local first install.");
    const homeStat = await fsImpl.lstat(homeDir);
    if (!homeStat.isDirectory() || homeStat.isSymbolicLink())
        throw new Error("The current HOME directory is unsafe.");
    if (platform === "darwin" && Number.isInteger(homeStat.uid) && homeStat.uid !== uid)
        throw new Error("The current HOME directory is not owned by the current user.");
    if (typeof allowExistingStableToMainMigration !== "boolean") {
        throw new Error("Existing Stable-to-Main migration requires an explicit boolean opt-in.");
    }
    const paths = managedSupervisorPaths(homeDir, { platform, arch, env });
    const stagingRoot = pathApi.join(paths.installRoot, "staging");
    await assertOwnedNormalDirectory(paths.installRoot, { uid, platform, fsImpl, create: true });
    await assertOwnedNormalDirectory(paths.releasesRoot, { uid, platform, fsImpl, create: true });
    await assertOwnedNormalDirectory(stagingRoot, { uid, platform, fsImpl, create: true });
    const baseInstallation = installationFor(paths, null, { platform, arch, target: expectedTarget });
    const mainPaths = equinoxLocalManagedSourcePaths({ platform, arch, homeDir, env });
    const repairOptions = { paths, mainPaths, installation: baseInstallation, uid, platform, arch, target: expectedTarget,
        fsImpl, execFileImpl, syncManagedShellImpl, stopWindowsShellImpl, launchWindowsShellImpl, waitForVersionImpl,
        windowsRenameSleepImpl, inspectLegacyMainHostImpl };
    const classicJournalPath = pathApi.join(mainPaths.mainTransactionRoot, "classic-repair.json");
    if (platform === "win32" && !allowExistingStableToMainMigration) {
        const readStoredStamp = async (filePath) => {
            const file = await readBoundedNormalFile(filePath, {
                fsImpl, platform, minBytes: 2, maxBytes: 8 * 1024,
                encoding: "utf8", label: "Windows classic Main recovery stamp",
            }).catch((error) => {
                if (error?.code === "ENOENT")
                    return null;
                throw error;
            });
            if (file)
                validateManagedSourceInstallStamp(JSON.parse(file.data));
            return file?.data ?? null;
        };
        const verifiedPrevious = async (record) => {
            const active = await fsImpl.lstat(pathApi.join(mainPaths.mainTransactionRoot, "active.json")).catch((error) => {
                if (error?.code === "ENOENT")
                    return null;
                throw error;
            });
            if (active)
                throw new Error("An active Main transaction must finish before recovering classic Stable repair.");
            const contract = equinoxLocalToolchainContract({
                runtimeRoot: path.win32.join(paths.installRoot, "runtime"), target: expectedTarget,
            });
            const source = await readMainSourcePointerImpl(mainPaths.sourcePointerPath, {
                fsImpl, execFileImpl, gitPath: contract.gitPath,
            });
            if (source.sha !== record.oldSourceSha ||
                path.win32.normalize(source.sourceRoot).toLowerCase() !==
                    path.win32.join(mainPaths.mainTransactionRoot, "sources", record.oldSourceSha).toLowerCase()) {
                throw new Error("Classic repair rollback Main checkout SHA differs from its durable record.");
            }
            const pointer = await readMainNativePointerImpl(path.win32.join(mainPaths.mainTransactionRoot, "current-native.json"), {
                transactionRoot: mainPaths.mainTransactionRoot, fsImpl,
            });
            if (pointer.target !== expectedTarget || pointer.sourceSha !== record.oldNativeSha) {
                throw new Error("Classic repair native rollback SHA changed during interrupted handoff.");
            }
            const declarationPath = path.win32.join(source.sourceRoot, "src", "equinox-local-version.js");
            const file = await readBoundedNormalFile(declarationPath, {
                fsImpl, platform, minBytes: 25, maxBytes: 1024, encoding: "utf8",
                label: "Classic repair native Main source version",
            });
            const versionLine = /^export const EQUINOX_LOCAL_VERSION = "(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)";$/mu.exec(file.data);
            if (!versionLine || `${versionLine[1]}.${versionLine[2]}.${versionLine[3]}` !== record.oldMainVersion) {
                throw new Error("Classic repair source version differs from its recorded Main rollback.");
            }
            return pointer;
        };
        const recover = await reconcileWindowsClassicRepairJournal({
            journalPath: classicJournalPath, expectedTarget,
            fsImpl,
            readStamp: async () => ({
                live: await readStoredStamp(mainPaths.installStampPath),
                parked: await readStoredStamp(`${mainPaths.installStampPath}.stable-install-backup`),
            }),
            readCurrentVersion: async () => (await readEquinoxLocalCurrentVersionPointer(paths.currentPointer, {
                fsImpl, platform, target: expectedTarget,
            })).version,
            verifyPrevious: verifiedPrevious,
            isPreviousMainHealthy: async (record) => {
                try {
                    const native = await verifiedPrevious(record);
                    await verifyWindowsShellOwnedImpl({
                        releaseDir: native.releaseDir, programRoot: paths.programRoot, fsImpl,
                    });
                    await verifyWindowsNativeHostOwnedImpl({
                        manifestRoot: paths.nativeMessagingManifestRoot,
                        acceptedLauncherPaths: [windowsNativeMessagingLauncherPath(native.releaseDir)],
                        fsImpl,
                    });
                    await waitForManagedSourceImpl(record.oldMainVersion, record.oldSourceSha, {
                        ...equinoxLocalFirstInstallHealthBudget({ platform, arch }), attempts: 4,
                    });
                    return true;
                }
                catch {
                    return false;
                }
            },
            isCommittedStableHealthy: async (record) => {
                try {
                    const signed = await readCurrentImpl(baseInstallation);
                    if (signed.version !== record.targetVersion)
                        return false;
                    await verifyWindowsShellOwnedImpl({
                        releaseDir: signed.releaseDir, programRoot: paths.programRoot, fsImpl,
                    });
                    await verifyWindowsNativeHostOwnedImpl({
                        manifestRoot: paths.nativeMessagingManifestRoot,
                        acceptedLauncherPaths: [windowsNativeMessagingLauncherPath(signed.releaseDir)],
                        fsImpl,
                    });
                    await waitForVersionImpl(record.targetVersion, {
                        ...equinoxLocalFirstInstallHealthBudget({ platform, arch }),
                        attempts: 4, expectedInstallationKind: "managed",
                    });
                    return true;
                }
                catch {
                    return false;
                }
            },
            rollbackPreviousMain: async (record, { parked }) => {
                const oldNative = await verifiedPrevious(record);
                const signedB = path.win32.join(paths.releasesRoot, record.targetVersion);
                await stopWindowsShellImpl({ platform: "win32" }).catch(() => null);
                await writeEquinoxLocalCurrentVersionPointer(paths.currentPointer, {
                    fsImpl, platform, target: expectedTarget, version: record.oldStablePointerVersion,
                });
                if (parked)
                    await fsImpl.rename(`${mainPaths.installStampPath}.stable-install-backup`, mainPaths.installStampPath);
                await syncManagedShellImpl(baseInstallation, {
                    version: record.oldMainVersion, releaseDir: oldNative.releaseDir,
                    previousReleaseDir: signedB,
                });
                await waitWindowsPipeReleaseImpl({ platform: "win32" });
                await launchWindowsShellImpl(path.win32.join(paths.programRoot, "EquinoxLocal.exe"));
                await waitForManagedSourceImpl(record.oldMainVersion, record.oldSourceSha, equinoxLocalFirstInstallHealthBudget({ platform, arch }));
            },
        });
        if (recover) {
            // Stop after safe recovery; a second explicit installer invocation may
            // install B. Never silently resume a partially interrupted replacement
            // with an unverified/stale staged candidate.
            return Object.freeze({
                status: recover.status, version: recover.version, configCreated: false,
                controlCenterUrl: "http://127.0.0.1:24891/",
            });
        }
    }
    // Recovery must precede even current-release resolution: the unchanged
    // pointer can temporarily name the missing directory between two renames.
    if (!allowExistingStableToMainMigration) {
        const recovered = await repairSameVersionMain(repairOptions);
        if (recovered)
            return Object.freeze({ ...recovered, controlCenterUrl: "http://127.0.0.1:24891/" });
    }
    else {
        const backup = await fsImpl.lstat(pathApi.join(paths.installRoot, ".stable-repair-backup")).catch((error) => {
            if (error?.code === "ENOENT")
                return null;
            throw error;
        });
        if (backup)
            throw new Error("Classic Stable installer recovery must complete before Main enrollment.");
    }
    const stagedReal = await fsImpl.realpath(stagedReleaseDir);
    const stagingReal = await fsImpl.realpath(stagingRoot);
    if (!inside(stagingReal, stagedReal, pathApi))
        throw new Error("Staged Equinox Local release escaped the managed staging directory.");
    const candidate = await validateFirstInstallRelease(stagedReal, { target: expectedTarget, fsImpl });
    const targetRelease = pathApi.join(paths.releasesRoot, candidate.version);
    if (pathApi.dirname(targetRelease) !== paths.releasesRoot)
        throw new Error("Candidate release path escaped the managed releases root.");
    let current = null;
    try {
        current = await readCurrentImpl(baseInstallation);
    }
    catch (error) {
        if (error?.code !== "ENOENT")
            throw error;
    }
    if (!current && allowExistingStableToMainMigration && !candidate.metadata?.sourceSha) {
        throw new Error("Main enrollment requires exact source provenance in the requested Stable release.");
    }
    const startRuntime = async (installation) => {
        if (platform === "darwin") {
            await reloadLaunchAgent(installation, { uid, execFileImpl });
            return;
        }
        const shell = await syncWindowsShellImpl({ releaseDir: installation.releaseDir, programRoot: installation.programRoot, fsImpl });
        await provisionWindowsGuardianFromRelease({ installation: installation, fsImpl });
        await launchWindowsShellImpl(shell.shellExecutable);
    };
    const enrollAfterStableHealth = async (installation, candidateValue) => {
        const bootstrapSha = candidateValue.metadata?.sourceSha ?? null;
        if (!bootstrapSha)
            return null;
        let enrollment;
        try {
            enrollment = await enrollManagedSourceImpl({
                bootstrapSha,
                target: expectedTarget,
                platform,
                arch,
                homeDir,
                env,
                fsImpl,
                execFileImpl,
                windowsZipHelperPath: platform === "win32"
                    ? path.win32.join(installation.releaseDir, "equinox-local-windows-release-zip.ps1")
                    : undefined,
                windowsPrivateStateHelperPath: platform === "win32"
                    ? path.win32.join(installation.releaseDir, "equinox-local-windows-private-state.ps1")
                    : undefined,
                stableReleaseDir: platform === "win32" ? installation.releaseDir : undefined,
            });
            if (platform === "darwin")
                await reloadLaunchAgent(installation, { uid, execFileImpl });
            else
                await requestWindowsRestartImpl({ platform: "win32" });
            await waitForManagedSourceImpl(candidateValue.version, bootstrapSha, equinoxLocalFirstInstallHealthBudget({ platform, arch }));
            return enrollment;
        }
        catch (error) {
            let rollback = null;
            try {
                rollback = await rollbackManagedSourceImpl({
                    bootstrapSha, target: expectedTarget, platform, arch, homeDir, env, fsImpl, execFileImpl,
                });
                if (rollback?.rolledBack) {
                    if (platform === "darwin")
                        await reloadLaunchAgent(installation, { uid, execFileImpl });
                    else
                        await requestWindowsRestartImpl({ platform: "win32" });
                    await waitForVersionImpl(candidateValue.version, equinoxLocalFirstInstallHealthBudget({ platform, arch }));
                }
            }
            catch (rollbackError) {
                const primary = error instanceof Error ? error.message : String(error);
                const recovery = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
                throw new Error(`Managed-source enrollment failed and Stable recovery did not complete: ${primary}; recovery: ${recovery}`);
            }
            const reason = error instanceof Error ? error.message : String(error);
            throw new Error(`${reason} Stable Equinox Local remains installed${rollback?.rolledBack ? " and was restored healthy" : " and healthy"}; managed-source enrollment can be retried.`);
        }
    };
    const savedMainStamp = `${mainPaths.installStampPath}.stable-install-backup`;
    let parkedMain = false;
    // Read identity through one checked file descriptor; lstat+readFile
    // permitted symlink/path replacement between the check and the read.
    const currentMainStamp = await readBoundedNormalFile(mainPaths.installStampPath, {
        fsImpl, platform, minBytes: 1, maxBytes: 8 * 1024,
        encoding: "utf8", label: "Existing Main install identity",
    }).catch((error) => {
        if (error?.code === "ENOENT")
            return null;
        throw error;
    });
    if (currentMainStamp) {
        validateManagedSourceInstallStamp(JSON.parse(currentMainStamp.data));
        try {
            await fsImpl.lstat(savedMainStamp);
            throw new Error("Prior Stable replacement needs reconciliation before another attempt.");
        }
        catch (error) {
            if (error?.code !== "ENOENT")
                throw error;
        }
    }
    // A website reinstall must not replace an already healthy Main with a
    // different numbered signed bootstrap (or mutate its WPF/native host).
    // The existing verified Main identity and live exact-SHA health win; an
    // unhealthy/ambiguous install fails closed for explicit recovery instead.
    if (allowExistingStableToMainMigration && currentMainStamp) {
        const active = await fsImpl.lstat(pathApi.join(mainPaths.mainTransactionRoot, "active.json")).catch((error) => {
            if (error?.code === "ENOENT")
                return null;
            throw error;
        });
        if (active)
            throw new Error("Main update transaction must complete before reinstalling.");
        const contract = equinoxLocalToolchainContract({
            runtimeRoot: pathApi.join(paths.installRoot, "runtime"), target: expectedTarget,
        });
        const source = await readMainSourcePointerImpl(mainPaths.sourcePointerPath, {
            fsImpl, execFileImpl, gitPath: contract.gitPath,
        });
        if (!/^[a-f0-9]{40}$/u.test(source?.sha ?? "")) {
            throw new Error("Existing Main source SHA is invalid.");
        }
        const sourceRoot = pathApi.join(mainPaths.mainTransactionRoot, "sources", source.sha);
        if (source.sourceRoot !== sourceRoot) {
            throw new Error("Existing Main source identity is not an exact owned checkout.");
        }
        const { data: declaration } = await readBoundedNormalFile(pathApi.join(sourceRoot, "src", "equinox-local-version.js"), {
            fsImpl, platform, minBytes: 25, maxBytes: 1024, encoding: "utf8", label: "Existing Main version declaration",
        });
        const version = /^export const EQUINOX_LOCAL_VERSION = "(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)";$/mu.exec(declaration);
        if (!version)
            throw new Error("Existing Main version declaration is invalid.");
        const currentVersion = `${version[1]}.${version[2]}.${version[3]}`;
        await waitForManagedSourceImpl(currentVersion, source.sha, { attempts: 6, delayMs: 500 });
        return Object.freeze({
            status: "already-installed", version: currentVersion, managedSourceSha: source.sha,
            configCreated: false, controlCenterUrl: "http://127.0.0.1:24891/",
        });
    }
    let previousMainNativeReleaseDir = null;
    let previousManagedMain = null;
    if (currentMainStamp && platform === "win32") {
        const pointerPath = path.win32.join(mainPaths.mainTransactionRoot, "current-native.json");
        const nativePointer = await readMainNativePointerImpl(pointerPath, {
            transactionRoot: mainPaths.mainTransactionRoot, fsImpl,
        }).catch((error) => {
            if (error?.code === "ENOENT")
                return null;
            throw error;
        });
        if (nativePointer) {
            if (nativePointer.target !== expectedTarget)
                throw new Error("Existing Main native architecture differs from signed installer.");
            previousMainNativeReleaseDir = nativePointer.releaseDir;
            // The legacy numbered Stable current-version can lag a healthy Main B
            // checkout, while source-only updates can retain an even older native
            // payload. Neither is the version of the RUNNING Main server.
        }
        if (!allowExistingStableToMainMigration && nativePointer &&
            !(current && compareEquinoxVersions(current.version, candidate.version) === 0)) {
            // Legacy same-version Main repair has its own full-tree backup journal
            // and can legitimately predate source-pointer enrollment. Do not
            // require a nonexistent Main source checkout before that recovery path.
            // Use the exact authenticated Main source + native A as the rollback
            // identity whether the obsolete numbered Stable tree has already been
            // reclaimed OR still exists pending post-health cleanup.
            // The legacy Stable pointer is only the fallback pointer to restore.
            const lock = await fsImpl.lstat(path.win32.join(mainPaths.mainTransactionRoot, "active.json")).catch((error) => {
                if (error?.code === "ENOENT")
                    return null;
                throw error;
            });
            if (lock)
                throw new Error("Classic reinstall is blocked until the active Main transaction has been reconciled.");
            const legacyPointer = await readEquinoxLocalCurrentVersionPointer(paths.currentPointer, {
                platform, target: expectedTarget, fsImpl,
            });
            const legacyRoot = path.win32.join(paths.releasesRoot, legacyPointer.version);
            const legacyStat = await fsImpl.lstat(legacyRoot).catch((error) => {
                if (error?.code === "ENOENT")
                    return null;
                throw error;
            });
            if (legacyStat && (!legacyStat.isDirectory() || legacyStat.isSymbolicLink() ||
                !current || path.win32.normalize(current.releaseDir).toLowerCase() !==
                path.win32.normalize(legacyRoot).toLowerCase())) {
                throw new Error("Existing Main Stable baseline is inconsistent, foreign or unsafe.");
            }
            const productGit = equinoxLocalToolchainContract({
                runtimeRoot: path.win32.join(paths.installRoot, "runtime"), target: expectedTarget,
            }).gitPath;
            const source = await readMainSourcePointerImpl(mainPaths.sourcePointerPath, {
                fsImpl, execFileImpl, gitPath: productGit,
            });
            if (!/^[a-f0-9]{40}$/u.test(source?.sha ?? "") ||
                !path.win32.isAbsolute(source.sourceRoot) ||
                path.win32.normalize(source.sourceRoot).toLowerCase() !==
                    path.win32.normalize(path.win32.join(mainPaths.mainTransactionRoot, "sources", source.sha)).toLowerCase()) {
                throw new Error("Installed Main source does not match the authenticated product-owned checkout.");
            }
            const versionFile = path.win32.join(source.sourceRoot, "src", "equinox-local-version.js");
            const { data: declaration } = await readBoundedNormalFile(versionFile, {
                fsImpl, platform, minBytes: 25, maxBytes: 1024,
                encoding: "utf8", label: "Installed Main version declaration",
            });
            const match = /^export const EQUINOX_LOCAL_VERSION = "(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)";$/mu.exec(declaration);
            if (!match)
                throw new Error("Installed Main version declaration is invalid.");
            const mainVersion = `${match[1]}.${match[2]}.${match[3]}`;
            previousManagedMain = Object.freeze({
                version: mainVersion, sourceSha: source.sha, releaseDir: nativePointer.releaseDir,
                stablePointerVersion: legacyPointer.version,
            });
            current = Object.freeze({ version: mainVersion, releaseDir: nativePointer.releaseDir });
        }
    }
    if (!current && currentMainStamp) {
        throw new Error("Existing Main identity has no verified rollback runtime; refusing destructive Stable repair.");
    }
    if (current) {
        const comparison = compareEquinoxVersions(current.version, candidate.version);
        if (allowExistingStableToMainMigration && comparison !== 0) {
            throw new Error("Upgrade the existing Stable release with the Stable updater before explicitly enrolling Main; installer migration cannot replace a different active Stable version.");
        }
        if (comparison > 0 && !currentMainStamp) {
            return Object.freeze({
                status: "newer-installed",
                version: current.version,
                requestedVersion: candidate.version,
                controlCenterUrl: "http://127.0.0.1:24891/",
            });
        }
        if (comparison === 0 && currentMainStamp && !allowExistingStableToMainMigration && !previousManagedMain) {
            const result = await repairSameVersionMain({ ...repairOptions, candidate, mainStamp: currentMainStamp.data,
                installation: installationFor(paths, current.releaseDir, { platform, arch, target: expectedTarget }) });
            return Object.freeze({ ...result, controlCenterUrl: "http://127.0.0.1:24891/" });
        }
        if (comparison === 0 && !previousManagedMain) {
            // Re-running the website installer is not consent to move an existing
            // numbered Stable installation onto Main. Explicit migration requires
            // matching installed provenance, not just the staged download's stamp.
            if (allowExistingStableToMainMigration) {
                if (!candidate.metadata?.sourceSha) {
                    throw new Error("Stable-to-Main migration requires exact source provenance in the requested Stable release.");
                }
                const installed = await validateFirstInstallRelease(current.releaseDir, { target: expectedTarget, fsImpl });
                if (installed.version !== current.version || installed.metadata.sourceSha !== candidate.metadata.sourceSha) {
                    throw new Error("Existing Stable release source provenance does not match the requested Main enrollment.");
                }
            }
            const installation = installationFor(paths, current.releaseDir, { platform, arch, target: expectedTarget });
            const bootstrap = await bootstrapImpl({ homeDir, platform, arch, env, fsImpl });
            await initializeOnboardingImpl({ installation, homeDir });
            await startRuntime(installation);
            await waitForVersionImpl(current.version, equinoxLocalFirstInstallHealthBudget({ platform, arch }));
            const enrollment = allowExistingStableToMainMigration
                ? await enrollAfterStableHealth(installation, candidate)
                : null;
            return Object.freeze({
                status: "already-installed",
                version: current.version,
                managedSourceSha: enrollment?.bootstrapSha ?? null,
                configCreated: Boolean(bootstrap.configCreated),
                controlCenterUrl: bootstrap.controlCenterUrl || "http://127.0.0.1:24891/",
            });
        }
        // Both Windows and macOS use the existing signed native activation,
        // health check and automatic rollback below for a different version.
    }
    const existing = await fsImpl.lstat(targetRelease).catch((error) => {
        if (error?.code === "ENOENT")
            return null;
        throw error;
    });
    if (existing) {
        if (!existing.isDirectory() || existing.isSymbolicLink())
            throw new Error("Existing target release path is unsafe.");
        if (current?.releaseDir === targetRelease)
            throw new Error("Active target release state is inconsistent.");
        await fsImpl.rm(targetRelease, { recursive: true, force: false });
    }
    if (platform === "win32") {
        await renameWindowsPathWhenUnlocked(stagedReal, targetRelease, { fsImpl, sleepImpl: windowsRenameSleepImpl });
    }
    else {
        await fsImpl.rename(stagedReal, targetRelease);
    }
    if (current) {
        const currentInstallation = installationFor(paths, current.releaseDir, { platform, arch, target: expectedTarget });
        await bootstrapImpl({ homeDir, platform, arch, env, fsImpl });
        // Existing Main sources must not override the freshly installed Stable
        // runtime. Park ONLY the authenticated Main channel selector while B is
        // started; restore it before the old A is relaunched on failed B health.
        const restoreMainIdentity = async () => {
            if (!parkedMain)
                return;
            await fsImpl.rename(savedMainStamp, mainPaths.installStampPath);
            parkedMain = false;
        };
        let activation;
        if (previousManagedMain) {
            const priorNative = await readMainNativePointerImpl(path.win32.join(mainPaths.mainTransactionRoot, "current-native.json"), { transactionRoot: mainPaths.mainTransactionRoot, fsImpl });
            await writeWindowsClassicRepairJournal(classicJournalPath, {
                schemaVersion: 1, target: expectedTarget,
                oldMainVersion: previousManagedMain.version,
                oldSourceSha: previousManagedMain.sourceSha,
                oldNativeSha: priorNative.sourceSha,
                oldStablePointerVersion: previousManagedMain.stablePointerVersion,
                targetVersion: candidate.version,
                mainStamp: currentMainStamp.data,
            }, { fsImpl });
        }
        try {
            activation = await activateImpl({
                installation: currentInstallation,
                targetVersion: candidate.version,
                healthAttempts: equinoxLocalFirstInstallHealthBudget({ platform, arch }).attempts,
                ...(previousMainNativeReleaseDir ? { previousMainNativeReleaseDir } : {}),
                ...(previousManagedMain ? { previousManagedMain } : {}),
                ...(currentMainStamp ? { kickstartImpl: async (version) => {
                        if (version === candidate.version && !parkedMain) {
                            await fsImpl.rename(mainPaths.installStampPath, savedMainStamp);
                            parkedMain = true;
                        }
                        else if (version === current.version) {
                            await restoreMainIdentity();
                        }
                        if (platform === "darwin") {
                            await kickstartEquinoxLocalLaunchAgent(currentInstallation, { uid, execFileImpl });
                        }
                        else {
                            // Old shipped WPF acknowledges the update shutdown request before
                            // releasing its single-instance coordinator. Await actual pipe
                            // release; otherwise a new WPF can exit as a duplicate.
                            await waitForWindowsShellPipeRelease({ platform });
                            return launchWindowsShellImpl(path.win32.join(paths.programRoot, "EquinoxLocal.exe"));
                        }
                    } } : {}),
            });
        }
        catch (error) {
            // Even if OS-native rollback failed before it could relaunch A,
            // do not strand A's original authenticated Main channel identity.
            await restoreMainIdentity();
            throw error;
        }
        if (parkedMain) {
            await fsImpl.rm(savedMainStamp);
            parkedMain = false;
        }
        if (previousManagedMain)
            await fsImpl.rm(classicJournalPath);
        const bootstrap = await bootstrapImpl({ homeDir, platform, arch, env, fsImpl });
        if (activation.status === "activated") {
            // Classic PowerShell reinstall is also a public update path. A signed
            // B which already passed WPF/Native Messaging and exact-version health
            // may reclaim old A bundles, exactly like the Control Center updater.
            // A failed or rolling-back update must NEVER remove A.
            try {
                await pruneStableImpl(installationFor(paths, targetRelease, {
                    platform, arch, target: expectedTarget,
                }));
            }
            catch (error) {
                process.stderr.write(`[Equinox Local] Prior Stable release cleanup pending: ${String(error?.message ?? error).slice(0, 220)}\n`);
            }
        }
        return Object.freeze({
            status: activation.status,
            version: candidate.version,
            previousVersion: activation.previousVersion,
            configCreated: Boolean(bootstrap.configCreated),
            controlCenterUrl: bootstrap.controlCenterUrl || "http://127.0.0.1:24891/",
        });
    }
    await atomicInitialCurrentPointer(paths, targetRelease, candidate, {
        platform,
        target: expectedTarget,
        fsImpl,
    });
    const installation = installationFor(paths, targetRelease, { platform, arch, target: expectedTarget });
    const bootstrap = await bootstrapImpl({ homeDir, platform, arch, env, fsImpl });
    try {
        await initializeOnboardingImpl({ installation, homeDir });
        await startRuntime(installation);
        await waitForVersionImpl(candidate.version, equinoxLocalFirstInstallHealthBudget({ platform, arch }));
    }
    catch (error) {
        let diagnostics = "";
        if (platform === "darwin") {
            diagnostics = await firstInstallActivationDiagnostics({ homeDir, uid, execFileImpl, fsImpl });
            await execFileImpl("/bin/launchctl", ["bootout", `gui/${uid}/${EQUINOX_LOCAL_LAUNCH_AGENT_LABEL}`], {
                timeout: 15_000,
                maxBuffer: 1024 * 1024,
            }).catch(() => ({ stdout: "", stderr: "" }));
        }
        else if (platform === "win32") {
            diagnostics = await windowsFirstInstallActivationDiagnostics({ paths, fsImpl });
        }
        const reason = error instanceof Error ? error.message : String(error);
        const detail = diagnostics ? ` ${diagnostics}` : "";
        throw new Error(`${reason} First-install files were preserved so the verified release can be retried safely.${detail}`);
    }
    const enrollment = allowExistingStableToMainMigration
        ? await enrollAfterStableHealth(installation, candidate)
        : null;
    return Object.freeze({
        status: "installed",
        version: candidate.version,
        managedSourceSha: enrollment?.bootstrapSha ?? null,
        configCreated: Boolean(bootstrap.configCreated),
        controlCenterUrl: bootstrap.controlCenterUrl || "http://127.0.0.1:24891/",
    });
}
// The signed selector belongs to one IMMUTABLE native-store SHA, not a
// mutable global "active selector" slot. Pointer A/B rollback automatically
// reads each SHA's own signed receipt without multi-file CAS.
export async function persistSignedMainNativeStoreSelector({ signedPointer, sourceSha, target, releaseDir, transactionRoot, platform = process.platform, env = process.env, uid = typeof process.getuid === "function" ? process.getuid() : null, fsImpl = fs, verifyPointerImpl = validateTrustedMainInstallPointer, }) {
    const signed = verifyPointerImpl(signedPointer, { expectedSourceSha: sourceSha });
    if (!signed.targets.some(row => row.target === target))
        throw new Error("Signed Main selector does not authorize this native target.");
    const pathApi = platform === "win32" ? path.win32 : path.posix;
    const directory = pathApi.join(transactionRoot, "native-store", target, sourceSha);
    if (typeof releaseDir !== "string" || pathApi.normalize(releaseDir) !== pathApi.join(directory, "release") ||
        !pathApi.isAbsolute(transactionRoot) || !pathApi.isAbsolute(releaseDir)) {
        throw new Error("Signed Main native receipt must belong to its exact source-SHA store.");
    }
    await assertOwnedNormalDirectory(directory, { uid, platform, fsImpl });
    const receiptPath = pathApi.join(directory, "signed-selector.json");
    const content = JSON.stringify(signedPointer) + "\n";
    if (Buffer.byteLength(content, "utf8") > 16 * 1024)
        throw new Error("Signed Main native selector exceeds the bounded size.");
    const readExisting = async () => {
        const { data } = await readBoundedNormalFile(receiptPath, {
            platform, fsImpl, minBytes: 200, maxBytes: 16 * 1024, encoding: "utf8",
            label: "Immutable native Main signed selector",
        });
        if (JSON.stringify(JSON.parse(data)) !== JSON.stringify(signedPointer)) {
            throw new Error("Immutable Main native signed selector differs from its existing SHA.");
        }
    };
    try {
        await readExisting();
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
        const temporary = pathApi.join(directory, ".signed-selector-" + randomBytes(12).toString("hex") + ".tmp");
        let created = false;
        try {
            const handle = await fsImpl.open(temporary, "wx", 0o600);
            created = true;
            try {
                const file = await handle.stat();
                if (!file.isFile() || file.nlink !== 1)
                    throw new Error("Signed Main selector temporary inode is unsafe.");
                await handle.writeFile(content, "utf8");
                await handle.sync();
            }
            finally {
                await handle.close();
            }
            try {
                await fsImpl.link(temporary, receiptPath);
            }
            catch (error) {
                if (error.code !== "EEXIST")
                    throw error;
                await readExisting(); // Replayed identical publish, never replace.
            }
        }
        finally {
            if (created)
                await fsImpl.rm(temporary, { force: true });
        }
        await readExisting();
    }
    if (platform === "win32") {
        await protectWindowsPrivateStatePath({ target: receiptPath, type: "file", env });
        const acl = await verifyWindowsPrivateStateAcl({ target: receiptPath, type: "file", env });
        if (!acl.safe)
            throw new Error("Signed Main native selector Windows ACL is not private.");
    }
    else {
        const stat = await fsImpl.lstat(receiptPath);
        if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
            throw new Error("Signed Main native selector is not a private normal file.");
        }
    }
    return receiptPath;
}
// Stage ONLY the production-signed source SHA into the existing inactive A/B
// native store. OS-native WPF/Guardian and macOS restart/rollback are *never*
// performed by this preparation phase, and no current pointer is changed.
export async function stageSignedMainInstallerNativeArchive({ signedPointer, sourceArchivePath, homeDir = os.homedir(), platform = process.platform, arch = process.arch, env = process.env, uid = typeof process.getuid === "function" ? process.getuid() : null, fsImpl = fs, verifyPointerImpl = validateTrustedMainInstallPointer, importArchiveImpl, prepareCandidateImpl, promoteCandidateImpl, persistSelectorImpl = persistSignedMainNativeStoreSelector, persistWindowsArchiveImpl = preserveOriginalSignedWindowsArchive, }) {
    const expectedTarget = equinoxLocalUpdateTarget({ platform, arch });
    const pointer = verifyPointerImpl(signedPointer);
    const row = pointer.targets.find(value => value.target === expectedTarget);
    if (!row)
        throw new Error("Signed Main inactive staging requires an admitted native architecture.");
    const pathApi = platform === "win32" ? path.win32 : path.posix;
    if (typeof homeDir !== "string" || !pathApi.isAbsolute(homeDir) ||
        typeof sourceArchivePath !== "string" || !pathApi.isAbsolute(sourceArchivePath)) {
        throw new Error("Signed Main inactive staging paths must be absolute.");
    }
    if (platform === "darwin" && (!Number.isInteger(uid) || uid < 1)) {
        throw new Error("Signed Main staging cannot execute as root.");
    }
    // Do not use Git, the legacy numbered releases directory, or a mutable
    // version number as the installed runtime identity.
    const root = equinoxLocalManagedSourcePaths({ homeDir, platform, arch, env }).mainTransactionRoot;
    const staging = pathApi.join(root, "staging");
    await assertOwnedNormalDirectory(root, { uid, platform, fsImpl, create: true });
    await assertOwnedNormalDirectory(staging, { uid, platform, fsImpl, create: true });
    if (platform === "win32") {
        for (const directory of [root, staging]) {
            await protectWindowsPrivateStatePath({ target: directory, type: "directory", env });
            const acl = await verifyWindowsPrivateStateAcl({ target: directory, type: "directory", env });
            if (!acl.safe)
                throw new Error("Signed Main staging directory Windows ACL is not private.");
        }
    }
    for (const directory of [root, staging]) {
        const actual = await fsImpl.realpath(directory);
        if (platform === "darwin" && actual !== directory)
            throw new Error("Signed Main staging directory is not canonical.");
    }
    try {
        await fsImpl.lstat(pathApi.join(root, "active.json"));
        throw new Error("Main source transaction is active; signed staging cannot race it.");
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
    const transactionId = "main-" + randomBytes(16).toString("hex");
    const transactionDir = pathApi.join(staging, transactionId);
    await fsImpl.mkdir(transactionDir, { recursive: false, mode: 0o700 });
    try {
        await assertOwnedNormalDirectory(transactionDir, { uid, platform, fsImpl });
        if (platform === "win32") {
            await protectWindowsPrivateStatePath({ target: transactionDir, type: "directory", env });
            const acl = await verifyWindowsPrivateStateAcl({ target: transactionDir, type: "directory", env });
            if (!acl.safe)
                throw new Error("Signed Main transaction Windows ACL is not private.");
        }
        const { stageEquinoxLocalSignedMainLocalArchive } = await import("./equinox-local-main-snapshot.js");
        const { prepareEquinoxLocalMainNativeCandidate } = await import("./equinox-local-main-native-candidate.js");
        const { promoteEquinoxLocalMainNativeCandidate } = await import("./equinox-local-main-native-state.js");
        const input = { sourceSha: pointer.sourceSha, target: expectedTarget,
            expectedRuntimeContractSha256: row.runtimeContractSha256,
            transactionRoot: root, transactionId, fsImpl };
        await (importArchiveImpl ?? stageEquinoxLocalSignedMainLocalArchive)({
            ...input, signedPointer, sourceArchivePath,
        });
        const candidate = await (prepareCandidateImpl ?? prepareEquinoxLocalMainNativeCandidate)(input);
        if (candidate.sourceSha !== pointer.sourceSha ||
            candidate.target !== expectedTarget ||
            candidate.runtimeContractSha256 !== row.runtimeContractSha256 ||
            candidate.artifactSha256 !== row.artifact.sha256 ||
            candidate.artifactBytes !== row.artifact.bytes ||
            candidate.payloadVersion !== pointer.version) {
            throw new Error("Signed Main inactive candidate identity drifted before durable promotion.");
        }
        const stored = await (promoteCandidateImpl ?? promoteEquinoxLocalMainNativeCandidate)({
            candidate, transactionRoot: root, transactionId, fsImpl,
        });
        if (stored.sourceSha !== pointer.sourceSha || stored.target !== expectedTarget ||
            stored.runtimeContractSha256 !== row.runtimeContractSha256 ||
            stored.payloadVersion !== pointer.version) {
            throw new Error("Signed Main inactive durable release identity drifted.");
        }
        await persistSelectorImpl({ signedPointer, sourceSha: pointer.sourceSha, target: expectedTarget,
            releaseDir: stored.releaseDir, transactionRoot: root, platform, env, uid, fsImpl,
            verifyPointerImpl });
        if (platform === "win32") {
            await persistWindowsArchiveImpl({ transactionRoot: root, transactionId,
                sourceSha: pointer.sourceSha, target: expectedTarget,
                artifactSha256: row.artifact.sha256, artifactBytes: row.artifact.bytes,
                env, fsImpl });
        }
        return Object.freeze({
            status: "staged", sourceSha: pointer.sourceSha, version: pointer.version,
            target: expectedTarget, releaseDir: stored.releaseDir, reused: stored.reused === true,
        });
    }
    finally {
        // The native-store is immutable and outside staging. This only removes
        // our exclusively owned short-lived transaction, never A or current.
        await fsImpl.rm(transactionDir, { recursive: true, force: true });
    }
}
// Read-only admission before the SAME signed installer schedules an inactive
// native B. Version is display-only; a healthy exact SHA may be a no-op,
// whereas an unhealthy identical SHA requires repair (not a downgrade).
// A legacy source/Factory Main MUST NOT be mistaken for public Stable A.
export async function inspectSignedMainInstallerMacActivation({ signedPointer, homeDir = os.homedir(), platform = process.platform, arch = process.arch, env = process.env, fsImpl = fs, verifyPointerImpl = validateTrustedMainInstallPointer, resolveInstallationImpl = resolveEquinoxLocalInstallation, resolveManagedImpl = resolveEquinoxLocalManagedSourceInstallation, inspectStoredImpl = inspectEquinoxLocalMainNativeStoredRelease, }) {
    if (platform !== "darwin" || !["arm64", "x64"].includes(arch) ||
        typeof homeDir !== "string" || !path.posix.isAbsolute(homeDir) ||
        path.posix.normalize(homeDir) !== homeDir) {
        throw new Error("Signed Main Mac activation requires a canonical non-Windows user HOME.");
    }
    const signed = verifyPointerImpl(signedPointer);
    const target = "darwin-" + arch;
    const row = signed.targets.find(value => value.target === target);
    if (!row)
        throw new Error("Signed Main Mac activation has no admitted B architecture.");
    const installRoot = path.posix.join(homeDir, "Library", "Application Support", "Equinox Local");
    const currentLink = path.posix.join(installRoot, "current");
    const paths = equinoxLocalManagedSourcePaths({ homeDir, platform, arch, env });
    const root = paths.mainTransactionRoot;
    let stat = null;
    try {
        stat = await fsImpl.lstat(currentLink);
    }
    catch (error) {
        if (error?.code !== "ENOENT")
            throw error;
    }
    if (stat === null) {
        // A genuinely clean direct-Main install has no prior Stable, Git,
        // Factory, apphost or launchd identity to protect. Do not infer absence
        // merely from a missing (or broken) current symlink.
        const privateRoot = await fsImpl.lstat(root);
        if (!privateRoot.isDirectory() || privateRoot.isSymbolicLink() ||
            (privateRoot.mode & 0o777) !== 0o700 ||
            await fsImpl.realpath(root) !== root) {
            throw new Error("Signed Main clean install requires the existing private canonical inactive B store.");
        }
        const forbidden = [
            path.posix.join(root, "current-native.json"), paths.installStampPath,
            paths.sourcePointerPath,
            path.posix.join(homeDir, "Library", "LaunchAgents", "dev.equinox.local.plist"),
            path.posix.join(homeDir, "Applications", "Equinox Local.app"),
            path.posix.join(installRoot, "releases"),
            path.posix.join(installRoot, "runtime"),
        ];
        for (const name of forbidden) {
            try {
                await fsImpl.lstat(name);
                throw new Error("Signed Main clean install cannot displace a prior managed/Factory app or runtime state.");
            }
            catch (error) {
                if (error?.code !== "ENOENT")
                    throw error;
            }
        }
        const store = await inspectStoredImpl({ transactionRoot: root, sourceSha: signed.sourceSha,
            target, expectedRuntimeContractSha256: row.runtimeContractSha256, fsImpl });
        const expectedB = path.posix.join(root, "native-store", target, signed.sourceSha, "release");
        if (store.releaseDir !== expectedB || store.sourceSha !== signed.sourceSha ||
            store.target !== target || store.runtimeContractSha256 !== row.runtimeContractSha256 ||
            store.payloadVersion !== signed.version ||
            store.manifest.artifactSha256 !== row.artifact.sha256 ||
            store.manifest.artifactBytes !== row.artifact.bytes) {
            throw new Error("Signed Main clean install B differs from immutable production Ed25519 selector.");
        }
        return Object.freeze({ action: "first_install", target,
            sourceSha: signed.sourceSha, version: signed.version,
            runtimeContractSha256: row.runtimeContractSha256,
            transactionRoot: root, releaseDir: store.releaseDir,
            previousKind: "none", previousSha: null, previousVersion: null,
            previousReleaseDir: null });
    }
    if (!stat.isSymbolicLink())
        throw new Error("Signed Main Mac A must have an owned current symlink.");
    const currentRaw = await fsImpl.readlink(currentLink);
    const lexicalA = path.posix.resolve(installRoot, currentRaw);
    const stableRelative = path.posix.relative(path.posix.join(installRoot, "releases"), lexicalA);
    const nativeRelative = path.posix.relative(path.posix.join(installRoot, "main-update", "native-store", target), lexicalA).split(path.posix.sep);
    const stableShape = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(stableRelative);
    const nativeShape = nativeRelative.length === 2 && /^[a-f0-9]{40}$/u.test(nativeRelative[0] ?? "") && nativeRelative[1] === "release";
    if (!stableShape && !nativeShape) {
        throw new Error("Signed Main Mac A current link escaped the owned Stable/native release roots.");
    }
    const physicalA = await fsImpl.realpath(currentLink);
    const physicalRoot = await fsImpl.realpath(installRoot);
    if (physicalA !== path.posix.join(physicalRoot, path.posix.relative(installRoot, lexicalA))) {
        throw new Error("Signed Main Mac A current symlink escapes the owned release.");
    }
    const base = resolveInstallationImpl({ homeDir, platform, arch,
        env: { ...env, EQUINOX_LOCAL_INSTALL_ROOT: installRoot, EQUINOX_LOCAL_RELEASE_DIR: lexicalA } });
    if (!base.managed || !base.selfUpdateSupported || base.target !== target ||
        base.releaseDir !== lexicalA) {
        throw new Error("Signed Main Mac A is not an admitted managed Stable/native release.");
    }
    const previous = await resolveManagedImpl({
        baseInstallation: { ...base, target, releaseDir: lexicalA }, platform, arch, homeDir, env, fsImpl,
    });
    if (!previous || typeof previous !== "object" || !("kind" in previous)) {
        throw new Error("Signed Main Mac A has no authenticated source identity.");
    }
    const previousMain = base.mainNativeSha ?? null;
    if (previousMain) {
        if (previous.kind !== "managed-main" || previous.sourceSha !== previousMain ||
            previous.mainNativeSha !== previousMain) {
            throw new Error("Signed Main Mac A immutable native selector is unauthenticated.");
        }
    }
    else if (previous.kind !== "managed") {
        throw new Error("Signed Main Mac cannot replace a legacy Git source or private Factory installation.");
    }
    const store = await inspectStoredImpl({ transactionRoot: root, sourceSha: signed.sourceSha,
        target, expectedRuntimeContractSha256: row.runtimeContractSha256, fsImpl });
    const expectedB = path.posix.join(root, "native-store", target, signed.sourceSha, "release");
    if (store.releaseDir !== expectedB || store.sourceSha !== signed.sourceSha ||
        store.target !== target || store.runtimeContractSha256 !== row.runtimeContractSha256 ||
        store.payloadVersion !== signed.version ||
        store.manifest.artifactSha256 !== row.artifact.sha256 ||
        store.manifest.artifactBytes !== row.artifact.bytes) {
        throw new Error("Signed Main Mac B inactive store has a different immutable Ed25519 identity.");
    }
    return Object.freeze({
        action: previousMain === signed.sourceSha ? "verify_or_repair" : "activate",
        target, sourceSha: signed.sourceSha, version: signed.version,
        runtimeContractSha256: row.runtimeContractSha256,
        transactionRoot: root, releaseDir: store.releaseDir,
        previousKind: previousMain ? "main" : "stable",
        previousSha: previousMain,
        previousVersion: previousMain ? null : path.posix.basename(lexicalA),
        previousReleaseDir: lexicalA,
    });
}
// Opt-in INTERNAL coordinator for the existing external installer. The
// previous A must be authenticated before any durable transaction is created;
// the signed B worker itself owns the later pointer switch, launchd restart
// and terminal receipt. No in-process Control Center activation is permitted.
export async function prepareSignedMainInstallerMacActivation({ signedPointer, homeDir = os.homedir(), platform = process.platform, arch = process.arch, env = process.env, uid = process.getuid?.(), fsImpl = fs, transactionId = "main-" + randomBytes(16).toString("hex"), inspectImpl = inspectSignedMainInstallerMacActivation, verifyPointerImpl = validateTrustedMainInstallPointer, readPointerImpl = readEquinoxLocalMainNativePointer, resolveInstallationImpl = resolveEquinoxLocalInstallation, writeDescriptorImpl, beginOwnerImpl, prepareLifecycleImpl, scheduleImpl, verifyPriorHealthImpl, verifySameShaHealthImpl, }) {
    if (platform !== "darwin" || !["arm64", "x64"].includes(arch) ||
        typeof homeDir !== "string" || !path.posix.isAbsolute(homeDir) ||
        path.posix.normalize(homeDir) !== homeDir ||
        !Number.isSafeInteger(uid) || uid === null || uid === undefined || uid < 1 ||
        !/^main-[a-f0-9]{32}$/u.test(transactionId)) {
        throw new Error("Signed Main Mac coordinator requires an exact non-root user and transaction identity.");
    }
    const initial = await inspectImpl({ signedPointer, homeDir, platform, arch, env, fsImpl });
    if (initial.action === "verify_or_repair") {
        // A full source SHA is the installation identity, not the displayed
        // semantic version. A healthy identical SHA is a true no-op: no new
        // launchd worker, runtime restart or A/B journal is ever created.
        const expectedRoot = path.posix.join(homeDir, "Library", "Application Support", "Equinox Local", "main-update");
        if (initial.transactionRoot !== expectedRoot ||
            initial.target !== "darwin-" + arch ||
            initial.previousKind !== "main" ||
            initial.previousSha !== initial.sourceSha ||
            !/^[a-f0-9]{40}$/u.test(initial.sourceSha) ||
            !/^[a-f0-9]{64}$/u.test(initial.runtimeContractSha256)) {
            throw new Error("Same-SHA Main verification requires the exact admitted installed native B identity.");
        }
        const selected = verifyPointerImpl(signedPointer, { expectedSourceSha: initial.sourceSha });
        const row = selected.targets.find(item => item.target === initial.target);
        if (!row || selected.version !== initial.version ||
            row.runtimeContractSha256 !== initial.runtimeContractSha256) {
            throw new Error("Same-SHA native Main selector does not match the currently installed runtime contract.");
        }
        const current = await readPointerImpl(path.posix.join(expectedRoot, "current-native.json"), {
            transactionRoot: expectedRoot, fsImpl,
        });
        if (current.sourceSha !== initial.sourceSha ||
            current.runtimeContractSha256 !== initial.runtimeContractSha256 ||
            current.target !== initial.target) {
            throw new Error("Same-SHA native Main current identity drifted before health verification.");
        }
        const { waitForExactNativeMainHealth: verifyDefault } = await import("./equinox-local-main-update-worker.js");
        const verify = verifySameShaHealthImpl ?? verifyDefault;
        let healthy = false;
        try {
            healthy = (await verify({
                transactionRoot: expectedRoot, sourceSha: initial.sourceSha,
                target: initial.target, version: initial.version,
                runtimeContractSha256: initial.runtimeContractSha256,
            })) === true;
        }
        catch {
            // Failed/unknown runtime health is not proof of a healthy install.
            // Leave A untouched; an explicit durable repair path is still needed.
        }
        return Object.freeze({ status: healthy ? "already_healthy" : "repair_required",
            sourceSha: initial.sourceSha, target: initial.target, version: initial.version });
    }
    const cleanFirst = initial.action === "first_install";
    if (!["activate", "first_install"].includes(initial.action) || initial.target !== "darwin-" + arch ||
        initial.transactionRoot !== path.posix.join(homeDir, "Library", "Application Support", "Equinox Local", "main-update") ||
        !/^[a-f0-9]{40}$/u.test(initial.sourceSha) ||
        !/^[a-f0-9]{64}$/u.test(initial.runtimeContractSha256) ||
        initial.releaseDir !== path.posix.join(initial.transactionRoot, "native-store", initial.target, initial.sourceSha, "release")) {
        throw new Error("Signed Main Mac coordinator preflight returned an inauthentic B.");
    }
    // Never run or trust the target release before its exact signed selector
    // was checked by inspectImpl and its private immutable manifest matched.
    const previousMain = initial.previousKind === "main";
    const previousPointer = previousMain
        ? await readPointerImpl(path.posix.join(initial.transactionRoot, "current-native.json"), {
            transactionRoot: initial.transactionRoot, fsImpl,
        }) : null;
    if (previousMain && (!previousPointer ||
        previousPointer.sourceSha !== initial.previousSha ||
        previousPointer.target !== initial.target ||
        initial.previousReleaseDir !== path.posix.join(initial.transactionRoot, "native-store", initial.target, previousPointer.sourceSha, "release"))) {
        throw new Error("Signed Main Mac coordinator previous native A pointer drifted.");
    }
    if (cleanFirst && (initial.previousKind !== "none" ||
        initial.previousSha !== null || initial.previousVersion !== null ||
        initial.previousReleaseDir !== null)) {
        throw new Error("Signed Main clean first install has a fabricated previous A.");
    }
    if (!previousMain && !cleanFirst && (initial.previousKind !== "stable" ||
        !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(initial.previousVersion ?? "") ||
        initial.previousReleaseDir !== path.posix.join(homeDir, "Library", "Application Support", "Equinox Local", "releases", initial.previousVersion))) {
        throw new Error("Signed Main Mac coordinator cannot displace unknown or source/Factory A.");
    }
    const transition = {
        mode: "artifact_required", target: initial.target,
        currentSha: previousPointer?.sourceSha ?? "0".repeat(40),
        targetSha: initial.sourceSha,
        currentRuntimeContractSha256: previousPointer?.runtimeContractSha256 ?? "0".repeat(64),
        targetRuntimeContractSha256: initial.runtimeContractSha256,
    };
    const admittedInstallation = resolveInstallationImpl({ platform, arch, homeDir,
        env: { ...env, EQUINOX_LOCAL_INSTALL_ROOT: path.posix.dirname(initial.transactionRoot),
            EQUINOX_LOCAL_RELEASE_DIR: cleanFirst ? initial.releaseDir : initial.previousReleaseDir } });
    if (!admittedInstallation.managed || !admittedInstallation.selfUpdateSupported ||
        admittedInstallation.target !== initial.target ||
        admittedInstallation.releaseDir !== (cleanFirst ? initial.releaseDir : initial.previousReleaseDir)) {
        throw new Error("Signed Main Mac coordinator cannot authenticate the rollback A or clean signed B installation.");
    }
    const installation = cleanFirst
        ? Object.freeze({ ...admittedInstallation, releaseDir: null })
        : admittedInstallation;
    // The second explicit verifier must run BEFORE acquiring an exclusive
    // owner; no bad/foreign signer can strand an admitted lock.
    const selected = signedPointer;
    const verified = verifyPointerImpl(selected, { expectedSourceSha: initial.sourceSha });
    const selectedRow = verified.targets.find(v => v.target === initial.target);
    if (!selectedRow || selectedRow.runtimeContractSha256 !== initial.runtimeContractSha256) {
        throw new Error("Signed Main Mac B selector identity changed before transaction admission.");
    }
    const recovery = await import("./equinox-local-main-native-recovery.js");
    const writer = writeDescriptorImpl ?? recovery.writeEquinoxLocalMainNativeRecoveryDescriptor;
    const begin = beginOwnerImpl ?? recovery.beginEquinoxLocalSignedNativeMacOwner;
    const { prepareEquinoxLocalMainNativeLifecycle: prepareDefault } = await import("./equinox-local-main-native-activation.js");
    const { scheduleEquinoxLocalMainUpdateWorker: scheduleDefault } = await import("./equinox-local-main-update-scheduler.js");
    const prepare = prepareLifecycleImpl ?? prepareDefault;
    const schedule = scheduleImpl ?? scheduleDefault;
    // Descriptor creation is private staging only; the owner is exclusively
    // locked BEFORE any A snapshot, native pointer or supervisor work.
    await writer({ transition, previousPointer, installation,
        transactionRoot: initial.transactionRoot, transactionId, fsImpl });
    const owner = { transactionRoot: initial.transactionRoot, transactionId,
        sourceSha: initial.sourceSha, target: initial.target,
        runtimeContractSha256: initial.runtimeContractSha256 };
    await begin({ ...owner, fsImpl, uid });
    // Revalidate A after ownership. Even independent external user actions
    // changing current must not cause us to snapshot the wrong rollback tree.
    const locked = await inspectImpl({ signedPointer, homeDir, platform, arch, env, fsImpl });
    if (locked.action !== initial.action || locked.sourceSha !== initial.sourceSha ||
        locked.previousKind !== initial.previousKind ||
        locked.previousSha !== initial.previousSha ||
        locked.previousReleaseDir !== initial.previousReleaseDir) {
        throw new Error("Signed Main Mac A/B identity changed after acquiring the transaction lock; recovery required.");
    }
    try {
        await prepare({
            transition, storedCandidate: {
                sourceSha: initial.sourceSha, target: initial.target,
                runtimeContractSha256: initial.runtimeContractSha256,
                artifactSha256: selectedRow.artifact.sha256,
                artifactBytes: selectedRow.artifact.bytes,
                payloadVersion: initial.version,
            },
            signedPointer: selected, installation, transactionRoot: initial.transactionRoot,
            transactionId, fsImpl, env,
        });
    }
    catch (preparationFailure) {
        // launchd has NOT been scheduled. Reauthenticate the still-running A
        // before declaring an admitted pre-launch transaction rolled_back. If
        // ANY verification or durable receipt transition fails, retain the
        // exclusive owner for explicit recovery instead of unlocking blind.
        try {
            const rechecked = await inspectImpl({ signedPointer, homeDir, platform, arch, env, fsImpl });
            if (rechecked.action !== initial.action ||
                rechecked.previousKind !== initial.previousKind ||
                rechecked.previousSha !== initial.previousSha ||
                rechecked.previousReleaseDir !== initial.previousReleaseDir) {
                throw new Error("Signed native pre-launch A changed before rollback admission.");
            }
            const verify = verifyPriorHealthImpl ?? (async (input) => {
                if (input.previousKind === "stable") {
                    return await waitForEquinoxLocalVersion(input.previousVersion, {
                        expectedInstallationKind: "managed",
                    });
                }
                const storedA = await inspectEquinoxLocalMainNativeStoredRelease({
                    transactionRoot: input.transactionRoot, sourceSha: input.previousSha,
                    target: input.target, expectedRuntimeContractSha256: input.previousRuntimeContractSha256,
                    fsImpl,
                });
                const { waitForExactNativeMainHealth } = await import("./equinox-local-main-update-worker.js");
                return await waitForExactNativeMainHealth({
                    transactionRoot: input.transactionRoot, sourceSha: input.previousSha,
                    target: input.target, version: storedA.payloadVersion,
                    runtimeContractSha256: input.previousRuntimeContractSha256,
                });
            });
            const healthy = cleanFirst ? true : await verify({
                previousKind: initial.previousKind,
                previousVersion: initial.previousVersion,
                previousSha: initial.previousSha,
                previousRuntimeContractSha256: previousPointer?.runtimeContractSha256 ?? null,
                transactionRoot: initial.transactionRoot, target: initial.target,
            });
            if (healthy !== true)
                throw new Error("Signed native pre-launch A did not pass exact health.");
            await recovery.writeEquinoxLocalSignedNativeMacReceipt({ ...owner, status: "rolling_back", fsImpl });
            await recovery.writeEquinoxLocalSignedNativeMacReceipt({ ...owner, status: "rolled_back", fsImpl });
            await recovery.releaseEquinoxLocalSignedNativeMacOwner({ ...owner, fsImpl });
        }
        catch (cancelFailure) {
            throw Object.assign(new Error("Signed native preparation failed; original Main owner remains locked for safe recovery."), {
                cause: cancelFailure, preparationFailure,
            });
        }
        throw preparationFailure;
    }
    const nodePath = path.posix.join(initial.releaseDir, "runtime", "node", "bin", "node");
    const workerPath = path.posix.join(initial.releaseDir, "equinox-local-main-update-worker.js");
    // launchd bootstrap may fail AFTER the service was briefly running. Never
    // unilaterally delete the shared owner: the attached durable receipt and
    // same exact service PID must be reconciled by signed native recovery.
    const scheduled = await schedule({
        signedNative: true, transactionId, transactionRoot: initial.transactionRoot,
        sourceRoot: initial.releaseDir, sourceSha: initial.sourceSha, target: initial.target,
        nodePath, workerPath, platform: "darwin", uid, fsImpl,
        sourceEnv: { HOME: homeDir, USER: env.USER, LOGNAME: env.LOGNAME, TMPDIR: env.TMPDIR },
    });
    if (scheduled.scheduled !== true)
        throw new Error("Signed Main native worker was not accepted by launchd; recovery required.");
    return Object.freeze({ status: "scheduled", transactionId, sourceSha: initial.sourceSha,
        target: initial.target, version: initial.version });
}
// Explicit recovery ONLY for an admitted, not-yet-started signed-native
// handoff. A failed "launchctl bootstrap" never alone implies absence.
// No new runtime updater is introduced: this reuses the exact existing
// signed owner + durable receipt + original launchd scheduler ownership.
export async function recoverAbandonedSignedMainMacAdmission({ transactionId, homeDir = os.homedir(), platform = process.platform, arch = process.arch, uid = process.getuid?.(), env = process.env, fsImpl = fs, inspectImpl = inspectSignedMainInstallerMacActivation, verifyPointerImpl = validateTrustedMainInstallPointer, proveAbsentImpl, verifyPriorHealthImpl, recoverRepairImpl, }) {
    if (platform !== "darwin" || !["arm64", "x64"].includes(arch) ||
        !/^main-[a-f0-9]{32}$/u.test(transactionId) ||
        typeof homeDir !== "string" || !path.posix.isAbsolute(homeDir) ||
        path.posix.normalize(homeDir) !== homeDir ||
        !Number.isSafeInteger(uid) || uid === null || uid === undefined || uid < 1) {
        throw new Error("Abandoned signed Main Mac recovery requires the exact owning user and transaction.");
    }
    const root = path.posix.join(homeDir, "Library", "Application Support", "Equinox Local", "main-update");
    const { data } = await readBoundedNormalFile(path.join(root, "active.json"), {
        fsImpl, minBytes: 100, maxBytes: 1024, encoding: "utf8", label: "Active signed native Main owner",
    });
    let raw;
    try {
        raw = JSON.parse(data);
    }
    catch {
        throw new Error("Signed native Main active owner is invalid.");
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
        Object.keys(raw).sort().join(",") !==
            ["schemaVersion", "kind", "transactionId", "sourceSha", "target", "runtimeContractSha256"].sort().join(",")) {
        throw new Error("Main update active owner does not contain an exact signed-native identity.");
    }
    const active = raw;
    const sha = active.sourceSha, contract = active.runtimeContractSha256, target = active.target;
    if (active.schemaVersion !== 1 || active.kind !== "signed-native" ||
        active.transactionId !== transactionId ||
        typeof sha !== "string" || !/^[a-f0-9]{40}$/u.test(sha) ||
        typeof contract !== "string" || !/^[a-f0-9]{64}$/u.test(contract) ||
        target !== "darwin-" + arch) {
        throw new Error("Main update active owner differs from this signed native Mac transaction.");
    }
    const owner = { transactionRoot: root, transactionId, sourceSha: sha, target,
        runtimeContractSha256: contract };
    const recovery = await import("./equinox-local-main-native-recovery.js");
    await recovery.assertEquinoxLocalSignedNativeMacOwner({ ...owner, fsImpl });
    const receipt = await recovery.readEquinoxLocalSignedNativeMacReceipt({ ...owner, fsImpl });
    const desc = await recovery.readEquinoxLocalMainNativeRecoveryDescriptor({
        transactionRoot: root, transactionId, fsImpl,
        expected: { targetSha: sha, target, targetRuntimeContractSha256: contract },
    });
    const selectorPath = path.posix.join(root, "native-store", target, sha, "signed-selector.json");
    const selectorStat = await fsImpl.lstat(selectorPath);
    if (!selectorStat.isFile() || selectorStat.isSymbolicLink() ||
        selectorStat.nlink !== 1 || (selectorStat.mode & 0o777) !== 0o600) {
        throw new Error("Abandoned signed native selector is not a private normal file.");
    }
    const selector = await readBoundedNormalFile(selectorPath, {
        fsImpl, minBytes: 200, maxBytes: 16 * 1024, encoding: "utf8", label: "Stored original production-signed Main pointer",
    });
    let rawSelector;
    try {
        rawSelector = JSON.parse(selector.data);
    }
    catch {
        throw new Error("Stored signed Main pointer is invalid.");
    }
    const signed = verifyPointerImpl(rawSelector, { expectedSourceSha: sha });
    const relevant = signed.targets.find(v => v.target === target);
    if (!relevant || relevant.runtimeContractSha256 !== contract) {
        throw new Error("Stored native B is not authenticated for the abandoned transaction.");
    }
    // Repair's previous A IS the signed target SHA. It has no detached B
    // worker; recovery is permitted only once that SAME runtime is proven
    // healthy, unlike an A->B abandoned-admission cancellation.
    if (desc.previous.kind === "main" && desc.previous.sourceSha === sha &&
        desc.previous.target === target &&
        desc.previous.runtimeContractSha256 === contract) {
        const { recoverEquinoxLocalSignedMainMacRepair: recoverDefault } = await import("./equinox-local-signed-main-repair.js");
        return await (recoverRepairImpl ?? recoverDefault)({
            signedPointer: rawSelector, transactionId, homeDir, platform, arch, uid,
            env, fsImpl, inspectImpl, verifyPointerImpl,
        });
    }
    if (receipt.status !== "admitted") {
        throw new Error("Signed native Main recovery only cancels a never-activated admitted owner.");
    }
    const authenticatedA = desc.previous;
    const assertA = async () => {
        const current = await inspectImpl({ signedPointer: rawSelector, homeDir, platform, arch, env, fsImpl });
        if (current.action !== (authenticatedA.kind === "none" ? "first_install" : "activate") ||
            current.sourceSha !== sha || current.target !== target ||
            current.runtimeContractSha256 !== contract) {
            throw new Error("Signed native original A/B identity changed since failed handoff.");
        }
        if (authenticatedA.kind === "none") {
            if (current.previousKind !== "none" || current.previousReleaseDir !== null ||
                current.previousSha !== null) {
                throw new Error("Abandoned signed Main clean first-install has an unexpected A.");
            }
            return { previousKind: "none", previousVersion: null,
                previousSha: null, previousRuntimeContractSha256: null, transactionRoot: root, target };
        }
        if (authenticatedA.kind === "stable") {
            if (current.previousKind !== "stable" ||
                current.previousVersion !== authenticatedA.version ||
                current.previousReleaseDir !== path.posix.join(path.dirname(root), "releases", authenticatedA.version)) {
                throw new Error("Abandoned signed native Stable A does not match the immutable recovery descriptor.");
            }
            return { previousKind: "stable", previousVersion: authenticatedA.version,
                previousSha: null, previousRuntimeContractSha256: null, transactionRoot: root, target };
        }
        if (authenticatedA.kind !== "main")
            throw new Error("Clean install has no previous A to recover.");
        if (current.previousKind !== "main" ||
            current.previousSha !== authenticatedA.sourceSha ||
            authenticatedA.target !== target ||
            current.previousReleaseDir !== path.posix.join(root, "native-store", target, authenticatedA.sourceSha, "release")) {
            throw new Error("Abandoned signed native A SHA differs from immutable rollback identity.");
        }
        const previous = await readEquinoxLocalMainNativePointer(path.posix.join(root, "current-native.json"), {
            transactionRoot: root, fsImpl,
        });
        if (previous.sourceSha !== authenticatedA.sourceSha ||
            previous.runtimeContractSha256 !== authenticatedA.runtimeContractSha256 ||
            previous.target !== target) {
            throw new Error("Abandoned native A runtime contract pointer drifted.");
        }
        return { previousKind: "main", previousVersion: null,
            previousSha: authenticatedA.sourceSha,
            previousRuntimeContractSha256: authenticatedA.runtimeContractSha256,
            transactionRoot: root, target };
    };
    const { assertEquinoxLocalSignedMacWorkerNeverStarted: defaultAbsent } = await import("./equinox-local-main-update-scheduler.js");
    const absent = proveAbsentImpl ?? defaultAbsent;
    const absenceInput = { transactionId, transactionRoot: root, uid, fsImpl };
    // Snapshot is not needed: a never-started B has not changed either A
    // pointer. The worker can later be rejected by terminal CAS even if
    // a stale scheduler races to start it.
    if ((await absent(absenceInput)).absent !== true) {
        throw new Error("Signed native launchd absence is not proven; owner remains locked.");
    }
    const prior = await assertA();
    const verify = verifyPriorHealthImpl ?? (async (input) => {
        if (input.previousKind === "stable") {
            return await waitForEquinoxLocalVersion(input.previousVersion, {
                expectedInstallationKind: "managed",
            });
        }
        const stored = await inspectEquinoxLocalMainNativeStoredRelease({
            transactionRoot: root, sourceSha: input.previousSha,
            target, expectedRuntimeContractSha256: input.previousRuntimeContractSha256, fsImpl,
        });
        const { waitForExactNativeMainHealth } = await import("./equinox-local-main-update-worker.js");
        return await waitForExactNativeMainHealth({
            transactionRoot: root, sourceSha: input.previousSha, target,
            version: stored.payloadVersion,
            runtimeContractSha256: input.previousRuntimeContractSha256,
        });
    });
    if (prior.previousKind !== "none" && (await verify(prior)) !== true) {
        throw new Error("Abandoned signed Main Mac original A did not pass exact health; owner retained.");
    }
    if ((await absent(absenceInput)).absent !== true) {
        throw new Error("Signed native launchd absence changed before terminal receipt.");
    }
    await assertA();
    if ((await recovery.readEquinoxLocalSignedNativeMacReceipt({ ...owner, fsImpl })).status !== "admitted") {
        throw new Error("Signed native receipt was advanced while proving abandoned ownership.");
    }
    await recovery.writeEquinoxLocalSignedNativeMacReceipt({ ...owner, status: "rolling_back", fsImpl });
    await recovery.writeEquinoxLocalSignedNativeMacReceipt({ ...owner, status: "rolled_back", fsImpl });
    await recovery.releaseEquinoxLocalSignedNativeMacOwner({ ...owner, fsImpl });
    return Object.freeze({ status: "rolled_back", transactionId, sourceSha: sha,
        target, originalAHealthy: true, workerNeverStarted: true });
}
// The original external installer owns stopping and removing *only* old
// executable roots. This is the existing first-install/managed bootstrap
// path for the independently verified Main ZIP, NOT an A/B updater.
// It never inspects an old version or attempts rollback: a retry simply
// runs the SAME fresh installer again, leaving config/workspace untouched.
export async function installFreshSignedMainRelease({ signedPointer, sourceArchivePath, homeDir = os.homedir(), platform = process.platform, arch = process.arch, env = process.env, uid = process.getuid?.() ?? null, }) {
    const target = equinoxLocalUpdateTarget({ platform, arch });
    const signed = validateTrustedMainInstallPointer(signedPointer);
    const targetRow = signed.targets.find(row => row.target === target);
    if (!targetRow)
        throw new Error("Production signed Main lacks the current native target.");
    const paths = managedSupervisorPaths(homeDir, { platform, arch, env });
    const main = equinoxLocalManagedSourcePaths({ platform, arch, homeDir, env });
    const pointerPath = (platform === "win32" ? path.win32 : path.posix)
        .join(main.mainTransactionRoot, "current-native.json");
    // The external installer must have completed its owned executable-only
    // cleanup BEFORE this operation. Never overwrite a live old Main pointer.
    try {
        await fs.lstat(pointerPath);
        throw new Error("Fresh Main installer requires the old executable owner to stop first.");
    }
    catch (error) {
        if (error?.code !== "ENOENT")
            throw error;
    }
    const staged = await stageSignedMainInstallerNativeArchive({
        signedPointer, sourceArchivePath, homeDir, platform, arch, env, uid,
    });
    if (staged.status !== "staged" || staged.sourceSha !== signed.sourceSha ||
        staged.version !== signed.version || staged.target !== target) {
        throw new Error("Fresh Main staged release differs from the production selector.");
    }
    await writeEquinoxLocalMainNativePointer(pointerPath, {
        schemaVersion: 1, channel: "main", sourceSha: signed.sourceSha, target,
        runtimeContractSha256: targetRow.runtimeContractSha256,
    }, { transactionRoot: main.mainTransactionRoot });
    if (platform === "darwin") {
        const link = createEquinoxLocalMainMacCurrentLinkTransition({
            installRoot: paths.installRoot,
            target: { sourceSha: signed.sourceSha, target,
                runtimeContractSha256: targetRow.runtimeContractSha256 },
            previousReleaseDir: null,
        });
        await link.selectTarget();
    }
    const installation = { ...installationFor(paths, staged.releaseDir, { platform, arch, target }),
        releaseDir: staged.releaseDir };
    const bootstrap = await bootstrapManagedEquinoxUser({ homeDir, platform, arch, env });
    await initializeManagedOnboardingState({ installation, homeDir });
    if (platform === "darwin") {
        await reloadLaunchAgent(installation, { uid, execFileImpl: execFile });
    }
    else {
        const shell = await synchronizeFreshWindowsShell({
            releaseDir: staged.releaseDir, programRoot: paths.programRoot,
        });
        await provisionWindowsGuardianFromRelease({ installation });
        await launchWindowsStableShell(shell.shellExecutable);
    }
    const { waitForExactNativeMainHealth } = await import("./equinox-local-main-update-worker.js");
    await waitForExactNativeMainHealth({
        transactionRoot: main.mainTransactionRoot, sourceSha: signed.sourceSha,
        target, version: signed.version,
        runtimeContractSha256: targetRow.runtimeContractSha256,
        // Windows WPF + Node supervisor can need longer than the default 20s.
        // Keep the bound: 180 polls x 500ms = at most 90s for fresh installs.
        attempts: platform === "win32" ? 180 : 40,
    });
    return Object.freeze({ status: "installed", channel: "main",
        version: signed.version, sourceSha: signed.sourceSha, target,
        configCreated: bootstrap.configCreated });
}
function parseCli(argv) {
    if ((argv.length !== 2 && argv.length !== 3) || argv[0] !== "--staged-release" || !path.isAbsolute(argv[1]) ||
        (argv.length === 3 && argv[2] !== "--enroll-existing-main")) {
        throw new Error("Usage: equinox-local-first-install.js --staged-release /absolute/path/to/release [--enroll-existing-main]");
    }
    return { stagedReleaseDir: argv[1], allowExistingStableToMainMigration: argv.length === 3 };
}
function parseSignedMainInspectionCli(argv) {
    if ((argv.length !== 9 && argv.length !== 11) || argv[0] !== "--inspect-signed-main" ||
        argv[1] !== "--staged-release" || argv[3] !== "--source-sha" ||
        argv[5] !== "--version" || argv[7] !== "--target" ||
        !path.isAbsolute(argv[2]) ||
        (argv.length === 11 && (argv[9] !== "--signed-pointer-file" || !path.isAbsolute(argv[10])))) {
        throw new Error("Signed Main admission requires staged release, full source SHA, version and target.");
    }
    return { releaseDir: argv[2], sourceSha: argv[4], version: argv[6], target: argv[8],
        signedPointerFile: argv.length === 11 ? argv[10] : null };
}
function parseSignedMainStageCli(argv) {
    if (argv.length !== 5 || argv[0] !== "--stage-signed-main" ||
        argv[1] !== "--signed-pointer-file" || argv[3] !== "--archive" ||
        !path.isAbsolute(argv[2]) || !path.isAbsolute(argv[4])) {
        throw new Error("Signed Main inactive staging requires an absolute signed pointer file and archive.");
    }
    return { signedPointerFile: argv[2], sourceArchivePath: argv[4] };
}
function parseSignedMainActivateCli(argv) {
    if (argv.length !== 3 || argv[0] !== "--activate-signed-main" ||
        argv[1] !== "--signed-pointer-file" ||
        typeof argv[2] !== "string" || !path.isAbsolute(argv[2])) {
        throw new Error("Signed Main activation requires only an absolute production-signed pointer file.");
    }
    return { signedPointerFile: argv[2] };
}
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && path.basename(invokedPath) === path.basename(fileURLToPath(import.meta.url))) {
    if (process.argv[2] === "--install-main-fresh") {
        Promise.resolve().then(async () => {
            const cli = parseSignedMainStageCli([
                "--stage-signed-main", ...process.argv.slice(3),
            ]);
            const { data } = await readBoundedNormalFile(cli.signedPointerFile, {
                minBytes: 200, maxBytes: 16 * 1024, encoding: "utf8",
                label: "Original production-signed fresh Main selector",
            });
            const result = await installFreshSignedMainRelease({
                signedPointer: JSON.parse(data), sourceArchivePath: cli.sourceArchivePath,
            });
            process.stdout.write(JSON.stringify(result) + "\n");
        }).catch((error) => {
            process.stderr.write(`Signed Main fresh installation failed: ${boundedDiagnostic(error instanceof Error ? error.message : error, 500)}. User settings were not cleared.\n`);
            process.exitCode = 1;
        });
    }
    else if (process.argv[2] === "--check-windows-signed-main") {
        Promise.resolve().then(async () => {
            const cli = parseSignedMainActivateCli([
                "--activate-signed-main", ...process.argv.slice(3),
            ]);
            const { data } = await readBoundedNormalFile(cli.signedPointerFile, {
                minBytes: 200, maxBytes: 16 * 1024, encoding: "utf8",
                label: "Private original production-signed Windows Main selector",
            });
            const { inspectSignedMainInstallerWindowsAdmission } = await import("./equinox-local-signed-main-windows-admission.js");
            // NO WPF shutdown, no Guardian token mint, no native pointer switch,
            // no receipt mutation. This check cannot authorize activation.
            const result = await inspectSignedMainInstallerWindowsAdmission({
                signedPointer: JSON.parse(data),
            });
            if (result.status !== "guardian_handoff_required") {
                throw new Error("Windows native Main check cannot grant OS Guardian admission.");
            }
            process.stdout.write(JSON.stringify(result) + "\n");
        }).catch(() => {
            process.stderr.write("Windows signed native Main preflight denied; independent Guardian/WPF activation was not attempted.\n");
            process.exitCode = 1;
        });
    }
    else if (process.argv[2] === "--inspect-signed-main") {
        Promise.resolve().then(async () => {
            const input = parseSignedMainInspectionCli(process.argv.slice(2));
            let signedTarget = null;
            if (input.signedPointerFile !== null) {
                const { data } = await readBoundedNormalFile(input.signedPointerFile, {
                    minBytes: 200, maxBytes: 16 * 1024, encoding: "utf8", label: "Private production-signed Main selector",
                });
                const signed = validateTrustedMainInstallPointer(JSON.parse(data), { expectedSourceSha: input.sourceSha });
                if (signed.version !== input.version)
                    throw new Error("Signed Main presentation version differs from native candidate.");
                signedTarget = signed.targets.find(row => row.target === input.target) ?? null;
                if (!signedTarget)
                    throw new Error("Signed Main selector does not admit this native architecture.");
            }
            const candidate = await validateFirstInstallRelease(input.releaseDir, {
                target: input.target,
                expectedMainSourceSha: input.sourceSha,
                expectedMainVersion: input.version,
            });
            process.stdout.write(JSON.stringify({
                status: "admitted", sourceSha: candidate.metadata.sourceSha,
                version: candidate.version, target: candidate.target,
                ...(signedTarget ? {
                    runtimeContractSha256: signedTarget.runtimeContractSha256,
                    artifactSha256: signedTarget.artifact.sha256,
                    artifactBytes: signedTarget.artifact.bytes,
                } : {}),
            }) + "\n");
        }).catch((error) => {
            process.stderr.write("Signed Main native candidate admission failed.\n");
            process.exitCode = 1;
        });
    }
    else if (process.argv.length === 3 && process.argv[2] === "--help") {
        process.stdout.write("Usage: equinox-local-first-install.js --staged-release /absolute/path/to/release [--enroll-existing-main]\nBundled internal helper: --enroll-existing-main enrolls Main after signed Stable health.\nPublic installers enroll the admitted Main commit by default; this internal helper without the flag preserves legacy Stable-only recovery.\n");
    }
    else {
        installManagedEquinoxRelease(parseCli(process.argv.slice(2)))
            .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
            .catch((error) => {
            process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
            process.exitCode = 1;
        });
    }
}
