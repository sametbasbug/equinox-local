import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { planEquinoxLocalMainNativeTransition } from "./equinox-local-main-native-admission.js";
import { prepareEquinoxLocalMainNativeCandidate } from "./equinox-local-main-native-candidate.js";
import { stageEquinoxLocalMainSnapshotArtifact } from "./equinox-local-main-snapshot.js";
import { prepareEquinoxLocalMainNativeLifecycle } from "./equinox-local-main-native-activation.js";
import { recoverEquinoxLocalMainNativeLifecycle } from "./equinox-local-main-native-recovery.js";
import { equinoxLocalReleaseTarget } from "./equinox-local-platform.js";
import { EQUINOX_LOCAL_INSTALL_LABEL, resolveEquinoxLocalInstallation } from "./equinox-local-installation.js";
import { kickstartEquinoxLocalLaunchAgent } from "./equinox-local-update-activation.js";
import { equinoxLocalToolchainContract } from "./equinox-local-toolchain-contract.js";
import { readBoundedNormalFile } from "./equinox-local-safe-file.js";
import { createEquinoxLocalMainUpdateTransactionEngine } from "./equinox-local-main-update-transaction.js";
import { runEquinoxLocalMainUpdateHandoff } from "./equinox-local-main-update-handoff.js";
import { readEquinoxLocalMainSourcePointer } from "./equinox-local-main-source-pointer.js";
import { inspectEquinoxLocalMainNativeStoredRelease } from "./equinox-local-main-native-state.js";
import { inspectCanonicalMainCheckout } from "./equinox-local-main-update.js";
import { EQUINOX_LOCAL_CONTROL_CENTER_STATUS_URL } from "./equinox-local-update-activation.js";
import { requestWindowsShellRuntimeRestart } from "./equinox-local-windows-shell-control.js";
import { assertWindowsStableShellOwnedByRelease, launchWindowsStableShell } from "./equinox-local-windows-stable-shell.js";
import { cleanupEquinoxLocalMainUpdateWorkerOwnership } from "./equinox-local-main-update-scheduler.js";
import { admitWindowsMainNativeWorkerJournal } from "./equinox-local-windows-main-worker-admission.js";
const execFile = promisify(execFileCallback);
function hasErrorCode(error, code) {
    return error !== null && typeof error === "object" && "code" in error && error.code === code;
}
const HEALTH_ATTEMPTS = 40;
const HEALTH_DELAY_MS = 500;
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function parseArgs(argv) {
    const result = {};
    for (let index = 0; index < argv.length; index += 2) {
        const key = argv[index];
        const value = argv[index + 1];
        if (typeof key !== "string" || !value || !new Set(["--transaction-id", "--source-root", "--transaction-root"]).has(key))
            throw new Error("Main update worker arguments are invalid.");
        if (Object.hasOwn(result, key))
            throw new Error("Main update worker arguments contain duplicates.");
        result[key] = value;
    }
    if (Object.keys(result).length !== 3)
        throw new Error("Main update worker requires transaction id, source root and transaction root.");
    return Object.freeze({ transactionId: result["--transaction-id"], sourceRoot: path.resolve(result["--source-root"]), transactionRoot: path.resolve(result["--transaction-root"]) });
}
export async function restartEquinoxLocalMainSourceRuntime({ sourceRoot, previousSourceRoot, platform = process.platform, execFileImpl = execFile, env = process.env, fsImpl = fs, requestWindowsRestartImpl = requestWindowsShellRuntimeRestart, windowsNativeShell = null, verifyWindowsShellImpl = assertWindowsStableShellOwnedByRelease, launchWindowsShellImpl = launchWindowsStableShell, restartDarwinImpl = kickstartEquinoxLocalLaunchAgent, uid = typeof process.getuid === "function" ? process.getuid() : null, } = {}) {
    if (platform === "win32") {
        if (windowsNativeShell) {
            // An artifact-required native Main update first shuts down the owning
            // WPF process to replace its executable. Its named pipe no longer exists.
            // Verify the exact staged/rollback shell before relaunching it DIRECTLY;
            // an ENOENT retry to the dead pipe causes rollback_failed and strands the
            // user without Control Center.
            const { programRoot, releaseDir } = windowsNativeShell;
            if (typeof programRoot !== "string" || !path.win32.isAbsolute(programRoot) ||
                typeof releaseDir !== "string" || !path.win32.isAbsolute(releaseDir)) {
                throw new Error("Windows Main native restart requires trusted absolute shell and release paths.");
            }
            const owned = await verifyWindowsShellImpl({ programRoot, releaseDir, fsImpl });
            if (owned?.owned !== true || owned.shellExecutable !== path.win32.join(programRoot, "EquinoxLocal.exe")) {
                throw new Error("Windows Main native restart shell integrity could not be verified.");
            }
            await launchWindowsShellImpl(owned.shellExecutable);
            return Object.freeze({ requested: true, platform: "win32", directNativeLaunch: true });
        }
        await requestWindowsRestartImpl({ platform: "win32" });
        return Object.freeze({ requested: true, platform: "win32" });
    }
    if (platform !== "darwin")
        throw new Error("Main source runtime restart is unsupported on this platform.");
    const homeDir = env?.HOME;
    if (typeof homeDir !== "string" || !path.posix.isAbsolute(homeDir))
        throw new Error("Managed Main restart requires an absolute HOME.");
    const installation = Object.freeze({
        launchAgentLabel: EQUINOX_LOCAL_INSTALL_LABEL,
        launchAgentPath: path.posix.join(homeDir, "Library", "LaunchAgents", `${EQUINOX_LOCAL_INSTALL_LABEL}.plist`),
    });
    await restartDarwinImpl(installation, { execFileImpl, uid });
    return Object.freeze({ requested: true, platform: "darwin" });
}
export async function waitForExactSourceHealth({ sha, sourceRoot, pointerPath, gitPath = "git", fetchImpl = globalThis.fetch, sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), attempts = HEALTH_ATTEMPTS, readPointerImpl = readEquinoxLocalMainSourcePointer, inspectCheckoutImpl = inspectCanonicalMainCheckout, readVersionImpl = async (root) => {
    const file = path.join(root, "src", "equinox-local-version.js");
    const { data: text } = await readBoundedNormalFile(file, {
        minBytes: 1, maxBytes: 1024, encoding: "utf8",
        label: "Main update release version declaration",
    });
    const match = /^export const EQUINOX_LOCAL_VERSION = "(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)";$/mu.exec(text);
    if (!match)
        throw new Error("Main update release version declaration is invalid.");
    return `${match[1]}.${match[2]}.${match[3]}`;
}, }) {
    const pointer = await readPointerImpl(pointerPath, { gitPath });
    if (pointer.sha !== sha || pointer.sourceRoot !== sourceRoot)
        throw new Error("Main update source pointer does not match the expected runtime identity.");
    const checkout = await inspectCheckoutImpl(sourceRoot, { gitPath });
    if (!checkout.eligible || checkout.currentSha !== sha)
        throw new Error("Main update runtime checkout does not match the expected canonical SHA.");
    const expectedVersion = await readVersionImpl(sourceRoot);
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(expectedVersion ?? "")) {
        throw new Error("Main update expected runtime version is invalid.");
    }
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            const response = await fetchImpl(EQUINOX_LOCAL_CONTROL_CENTER_STATUS_URL, { method: "GET", redirect: "error", cache: "no-store", credentials: "omit", headers: { accept: "application/json" } });
            if (!response?.ok)
                throw new Error(`HTTP ${response?.status ?? "unknown"}`);
            const body = await response.json();
            const observed = body?.status;
            if (observed?.health?.state === "HEALTHY"
                && observed?.installation?.kind === "managed-source"
                && observed?.installation?.sourceSha === sha
                && observed?.server?.version === expectedVersion)
                return true;
            // A native relaunch can race the old A server staying HEALTHY on the
            // loopback port. Never call source B admitted until B itself responds.
            throw new Error("Main update runtime health or installed source SHA has not converged.");
        }
        catch (error) {
            lastError = error;
            if (attempt + 1 < attempts)
                await sleepImpl(HEALTH_DELAY_MS);
        }
    }
    throw new Error(`Main update runtime did not become healthy: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}
// Older admitted A versions schedule the B worker with a minimal launchd
// environment that omits both managed installation paths. Derive identity
// from the actual owned current-release pointer and the tightly constrained
// transactionRoot, not arbitrary caller-supplied environment path strings.
export async function resolveEquinoxLocalMainWorkerNativeInstallation({ transactionRoot, env = process.env, platform = process.platform, arch = process.arch, fsImpl = fs, }) {
    if (platform !== "darwin")
        return resolveEquinoxLocalInstallation({ platform, arch, env });
    const homeDir = env?.HOME;
    if (typeof homeDir !== "string" || !path.posix.isAbsolute(homeDir)
        || path.posix.normalize(homeDir) !== homeDir) {
        throw new Error("Detached Main native worker HOME is not canonical.");
    }
    const installRoot = path.posix.join(homeDir, "Library", "Application Support", "Equinox Local");
    if (path.posix.resolve(transactionRoot ?? "") !== path.posix.join(installRoot, "main-update")) {
        throw new Error("Detached Main native worker transaction root does not belong to its managed HOME.");
    }
    const releaseDir = await fsImpl.realpath(path.posix.join(installRoot, "current"));
    const installation = resolveEquinoxLocalInstallation({
        platform, arch, homeDir,
        env: { ...env, EQUINOX_LOCAL_INSTALL_ROOT: installRoot, EQUINOX_LOCAL_RELEASE_DIR: releaseDir },
    });
    if (!installation.managed || !installation.selfUpdateSupported) {
        throw new Error("Detached Main native worker release identity is not a trusted managed installation.");
    }
    return installation;
}
// The previous installed A version may have selected reuse_native and
// therefore never downloaded B's native archive. The B-owned detached worker
// makes this upgrade safe without requiring patches to already shipped A.
async function ensureFreshTargetNativeArtifact({ transactionRoot, transactionId, targetSha, target, expectedRuntimeContractSha256, fsImpl = fs, stageImpl = stageEquinoxLocalMainSnapshotArtifact }) {
    const nativeDir = path.join(transactionRoot, "staging", transactionId, "native");
    let exists = false;
    try {
        const stat = await fsImpl.lstat(nativeDir);
        if (!stat.isDirectory() || stat.isSymbolicLink())
            throw new Error("Main native artifact stage is not a safe directory.");
        exists = true;
    }
    catch (error) {
        if (!hasErrorCode(error, "ENOENT"))
            throw error;
    }
    if (exists)
        return false; // The candidate validator still verifies every exact hash.
    await stageImpl({ sourceSha: targetSha, target,
        expectedRuntimeContractSha256, transactionRoot, transactionId, fsImpl });
    return true;
}
export async function runEquinoxLocalMainUpdateWorker({ argv = process.argv.slice(2), execFileImpl = execFile, fetchImpl = globalThis.fetch, sleepImpl, fsImpl = fs, env = process.env, uid = process.getuid?.(), engineFactory = (options) => createEquinoxLocalMainUpdateTransactionEngine(options), resolveHostTarget = () => equinoxLocalReleaseTarget(), planNativeTransition = planEquinoxLocalMainNativeTransition, ensureNativeArtifact = ensureFreshTargetNativeArtifact, prepareNativeCandidate = prepareEquinoxLocalMainNativeCandidate, inspectStoredNativeRelease = inspectEquinoxLocalMainNativeStoredRelease, prepareNativeLifecycle = prepareEquinoxLocalMainNativeLifecycle, recoverNativeLifecycle = recoverEquinoxLocalMainNativeLifecycle, admitWindowsNativeWorker = admitWindowsMainNativeWorkerJournal, handoffImpl = runEquinoxLocalMainUpdateHandoff, restartRuntimeImpl = (value) => restartEquinoxLocalMainSourceRuntime({ ...value, execFileImpl, env, fsImpl }), verifyRuntimeImpl, resolveNativeInstallation = resolveEquinoxLocalMainWorkerNativeInstallation, cleanupImpl = (value) => cleanupEquinoxLocalMainUpdateWorkerOwnership({
    ...value, execFileImpl, fsImpl,
    ...(uid === undefined ? {} : { uid }),
    ...(env.EQUINOX_LOCAL_MAIN_WORKER_TOKEN === undefined ? {} : { ownershipToken: env.EQUINOX_LOCAL_MAIN_WORKER_TOKEN }),
}), } = {}) {
    const args = parseArgs(argv);
    const hostTarget = resolveHostTarget();
    const pathApi = process.platform === "win32" ? path.win32 : path.posix;
    const runtimeRoot = process.platform === "win32"
        ? pathApi.join(pathApi.dirname(pathApi.dirname(args.transactionRoot)), "runtime")
        : pathApi.join(pathApi.dirname(args.transactionRoot), "runtime");
    const toolchain = equinoxLocalToolchainContract({ runtimeRoot, target: hostTarget });
    try {
        const engine = engineFactory({
            sourceRoot: args.sourceRoot,
            transactionRoot: args.transactionRoot,
            gitPath: toolchain.gitPath,
            nodePath: toolchain.nodePath,
            npmPath: toolchain.npmPath,
            shellPath: toolchain.shellPath,
        });
        let active = await engine.readActive();
        if (!active || active.transactionId !== args.transactionId)
            throw new Error("Main update worker does not own the active transaction.");
        if (["succeeded", "rolled_back"].includes(active.status)) {
            await engine.releaseStagedLock(args.transactionId);
            return Object.freeze({ status: active.status, receipt: active, recovered: true });
        }
        if (active.status === "rollback_failed")
            throw new Error("Main update worker cannot resume a transaction whose rollback already failed.");
        const resumable = new Set([
            "promoting:ready_to_switch",
            "promoting:native_rollback_ready",
            "promoting:native_switched",
            "verifying:source_switched",
            "verifying:rollback_source_restored",
            "verifying:rollback_native_restored",
        ]);
        if (!resumable.has(`${active.status}:${active.stage}`))
            throw new Error("Main update worker requires a resumable promotion receipt.");
        const initialStage = active.stage;
        let nativeTransition;
        let nativeLifecycle = null;
        try {
            const target = hostTarget;
            nativeTransition = await planNativeTransition({
                ...(active.rollbackSourceRoot === null ? {} : { currentRoot: active.rollbackSourceRoot }),
                currentSha: active.currentSha,
                ...(active.targetSourceRoot === null ? {} : { targetRoot: active.targetSourceRoot }),
                targetSha: active.targetSha,
                target,
                gitPath: toolchain.gitPath,
            });
            if (nativeTransition?.mode === "artifact_required") {
                const installation = await resolveNativeInstallation({ transactionRoot: args.transactionRoot, env, platform: process.platform, fsImpl });
                if (!installation?.managed || !installation?.selfUpdateSupported || installation.target !== nativeTransition.target) {
                    throw new Error("Detached Main worker native installation does not match the exact target.");
                }
                // The installed WPF detached worker is verified by its OS process,
                // owned Node executable, birth time and exact transaction token.
                // Install every native candidate from a fresh immutable payload and
                // use the existing one-shot snapshot/rollback: no second Guardian.
                // Authenticate the B payload before running its product-owned Win32
                // identity helper. Candidate extraction only touches private staging;
                // no native activation, old-version deletion or rollback mutation is
                // allowed until the real detached worker passes OS identity admission.
                let candidate = null;
                if (initialStage === "ready_to_switch") {
                    await ensureNativeArtifact({ transactionRoot: args.transactionRoot,
                        transactionId: args.transactionId, targetSha: active.targetSha, target,
                        expectedRuntimeContractSha256: nativeTransition.targetRuntimeContractSha256, fsImpl });
                    candidate = await prepareNativeCandidate({
                        sourceSha: active.targetSha,
                        target,
                        expectedRuntimeContractSha256: nativeTransition.targetRuntimeContractSha256,
                        transactionRoot: args.transactionRoot,
                        transactionId: args.transactionId,
                        fsImpl,
                        execFileImpl,
                    });
                }
                const trustedNativeRelease = hostTarget.startsWith("win32-")
                    ? (candidate ?? await inspectStoredNativeRelease({
                        transactionRoot: args.transactionRoot, sourceSha: active.targetSha,
                        target, expectedRuntimeContractSha256: nativeTransition.targetRuntimeContractSha256, fsImpl,
                    }))
                    : null;
                const nativeHelperPath = trustedNativeRelease
                    ? path.win32.join(trustedNativeRelease.releaseDir, "runtime", "job", "equinox-local-job-object-helper.exe")
                    : null;
                if (hostTarget.startsWith("win32-") && typeof installation.target !== "string") {
                    throw new Error("Windows native worker installation target was not authenticated.");
                }
                const windowsAdmission = hostTarget.startsWith("win32-")
                    ? await admitWindowsNativeWorker({
                        receipt: active, transition: nativeTransition,
                        installation: { ...installation, target: installation.target },
                        transactionRoot: args.transactionRoot, engine,
                        fsImpl, execFileImpl, ...(env.EQUINOX_LOCAL_MAIN_WORKER_TOKEN === undefined ? {} : { workerToken: env.EQUINOX_LOCAL_MAIN_WORKER_TOKEN }),
                        nativeHelperPath, ownerOnly: true,
                    })
                    : null;
                if (windowsAdmission && windowsAdmission.admitted !== true) {
                    throw new Error("Windows update has no verified detached WPF owner.");
                }
                if (initialStage === "ready_to_switch") {
                    nativeLifecycle = await prepareNativeLifecycle({
                        transition: nativeTransition,
                        ...(candidate === null ? {} : { candidate }),
                        installation,
                        transactionRoot: args.transactionRoot,
                        transactionId: args.transactionId,
                        fsImpl,
                        execFileImpl,
                        env,
                        windowsAdmission: null,
                    });
                    active = await engine.markNativeRollbackReady(args.transactionId);
                }
                else {
                    nativeLifecycle = await recoverNativeLifecycle({
                        transition: nativeTransition,
                        installation,
                        transactionRoot: args.transactionRoot,
                        transactionId: args.transactionId,
                        fsImpl,
                        execFileImpl,
                        env,
                        windowsAdmission: null,
                    });
                }
            }
            else if (nativeTransition?.mode === "reuse_native") {
                if (["native_rollback_ready", "native_switched", "rollback_source_restored", "rollback_native_restored"].includes(initialStage)) {
                    throw new Error("Main update native receipt stage is incompatible with reuse_native recovery.");
                }
            }
            else {
                throw new Error("Main native transition mode is unsupported.");
            }
        }
        catch (error) {
            if (initialStage === "ready_to_switch") {
                await engine.abortPreparedPromotion(args.transactionId, errorMessage(error), { stage: "native_admission_failed" }).catch(() => { });
            }
            else {
                await engine.markRollbackFailed(args.transactionId, errorMessage(error)).catch(() => { });
            }
            throw error;
        }
        const verify = typeof verifyRuntimeImpl === "function"
            ? verifyRuntimeImpl
            : (value) => waitForExactSourceHealth({
                ...value, pointerPath: engine.paths.sourcePointerPath, gitPath: toolchain.gitPath, fetchImpl,
                ...(sleepImpl ? { sleepImpl } : {}),
            });
        const restartWithNativeOwnership = (value) => {
            if (hostTarget.startsWith("win32-") && nativeLifecycle) {
                // Native Windows lifecycle supplies both trusted release identities;
                // preserve exact rollback ownership instead of guessing a shell path.
                const windowsNativeShell = {
                    programRoot: nativeLifecycle.windowsProgramRoot,
                    releaseDir: value.rollback ? nativeLifecycle.rollbackPath : nativeLifecycle.stored?.releaseDir,
                };
                return restartRuntimeImpl({ ...value, windowsNativeShell: windowsNativeShell });
            }
            return restartRuntimeImpl(value);
        };
        return await handoffImpl({
            engine,
            transactionId: args.transactionId,
            nativeTransition,
            nativeLifecycle,
            initialReceipt: active,
            restartRuntime: restartWithNativeOwnership,
            verifyRuntime: verify,
        });
    }
    finally {
        await cleanupImpl({ transactionId: args.transactionId, transactionRoot: args.transactionRoot });
    }
}
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invoked && import.meta.url === invoked) {
    runEquinoxLocalMainUpdateWorker().catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
