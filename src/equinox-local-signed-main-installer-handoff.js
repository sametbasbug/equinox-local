import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { launchDetachedHelper } from "./equinox-local-detached-helper.js";
import { inspectEquinoxLocalMainNativeStoredRelease, readEquinoxLocalMainNativePointer } from "./equinox-local-main-native-state.js";
import { readBoundedNormalFile } from "./equinox-local-safe-file.js";
import { validateTrustedMainInstallPointer } from "./equinox-local-main-install-pointer.js";
const SHA = /^[a-f0-9]{40}$/u;
const TARGET = /^darwin-(arm64|x64)$/u;
function code(error, name) { return error !== null && typeof error === "object" && "code" in error && error.code === name; }
// Acknowledges ONLY the detached ORIGINAL external installer process; the
// signed release B and full-SHA health/rollback still belong to its existing
// first-install coordinator and one native launchd worker.
export async function scheduleEquinoxLocalSignedNativeMacInstaller({ installation, homeDir = os.homedir(), sourceEnv = process.env, fsImpl = fs, inspectStoredImpl = inspectEquinoxLocalMainNativeStoredRelease, readPointerImpl = readEquinoxLocalMainNativePointer, verifyPointerImpl = validateTrustedMainInstallPointer, launchHelperImpl = launchDetachedHelper, spawnImpl = spawn, }) {
    const target = installation?.target;
    const sha = installation?.sourceSha;
    if (installation?.kind !== "managed-main" || installation.platform !== "darwin" ||
        !TARGET.test(target) || target !== "darwin-" + installation.arch ||
        !SHA.test(sha) || installation.mainNativeSha !== sha ||
        typeof homeDir !== "string" || !path.posix.isAbsolute(homeDir) ||
        path.posix.normalize(homeDir) !== homeDir ||
        installation.installRoot !== path.posix.join(homeDir, "Library", "Application Support", "Equinox Local") ||
        installation.mainTransactionRoot !== path.posix.join(installation.installRoot, "main-update") ||
        installation.releaseDir !== path.posix.join(installation.mainTransactionRoot, "native-store", target, sha, "release") ||
        process.platform !== "darwin" || !Number.isSafeInteger(process.getuid?.()) || process.getuid() === 0) {
        throw new Error("Main native updater requires the exact installed signed Mac SHA and non-root user.");
    }
    const root = installation.mainTransactionRoot;
    // Never start a second external installer over an active native journal.
    try {
        await fsImpl.lstat(path.posix.join(root, "active.json"));
        throw new Error("A Main native transaction is already active; repair or recover it first.");
    }
    catch (error) {
        if (!code(error, "ENOENT"))
            throw error;
    }
    const stored = await inspectStoredImpl({
        transactionRoot: root, sourceSha: sha, target, fsImpl,
    });
    if (stored.releaseDir !== installation.releaseDir || stored.sourceSha !== sha ||
        stored.target !== target || !/^[a-f0-9]{64}$/u.test(stored.runtimeContractSha256)) {
        throw new Error("Original installed Main release fingerprint or identity drifted.");
    }
    const pointer = await readPointerImpl(path.posix.join(root, "current-native.json"), {
        transactionRoot: root, fsImpl,
    });
    if (pointer.sourceSha !== sha || pointer.target !== target ||
        pointer.runtimeContractSha256 !== stored.runtimeContractSha256 ||
        pointer.releaseDir !== installation.releaseDir) {
        throw new Error("Current signed Main native SHA pointer is not the installed release.");
    }
    const signedFile = path.posix.join(path.posix.dirname(installation.releaseDir), "signed-selector.json");
    const original = await readBoundedNormalFile(signedFile, {
        fsImpl, minBytes: 200, maxBytes: 16 * 1024, encoding: "utf8",
        label: "Original installed production-signed Main selector",
    });
    const signed = verifyPointerImpl(JSON.parse(original.data), { expectedSourceSha: sha });
    const row = signed.targets.find(item => item.target === target);
    if (!row || signed.version !== stored.payloadVersion ||
        row.runtimeContractSha256 !== stored.runtimeContractSha256 ||
        row.artifact.sha256 !== stored.manifest.artifactSha256 ||
        row.artifact.bytes !== stored.manifest.artifactBytes) {
        throw new Error("Original Main signed install selector differs from the immutable installed release.");
    }
    const installer = path.posix.join(installation.releaseDir, "scripts", "install-equinox-local.sh");
    const stat = await fsImpl.lstat(installer);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
        stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0 ||
        await fsImpl.realpath(installer) !== installer) {
        throw new Error("Original native Main installer is not an owned, unchanged release file.");
    }
    const handoffRoot = path.posix.join(root, "handoff");
    await fsImpl.mkdir(handoffRoot, { recursive: true, mode: 0o700 });
    const handoffStat = await fsImpl.lstat(handoffRoot);
    if (!handoffStat.isDirectory() || handoffStat.isSymbolicLink() ||
        handoffStat.uid !== process.getuid?.() || (handoffStat.mode & 0o077) !== 0) {
        throw new Error("Native Main detached installer logs directory is unsafe.");
    }
    // Bounded private per-request log. A successful spawn is NOT proof that
    // bootstrap, A/B, source-SHA health or rollback later succeeded.
    const requestId = "main-" + randomBytes(16).toString("hex");
    const logPath = path.posix.join(handoffRoot, requestId + ".original-installer.log");
    const fd = await fsImpl.open(logPath, fsConstants.O_WRONLY | fsConstants.O_CREAT |
        fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    try {
        await launchHelperImpl({
            spawnImpl, command: "/bin/bash", args: [installer, "--activate-main"],
            options: {
                cwd: installation.releaseDir, detached: true,
                stdio: ["ignore", fd.fd, fd.fd],
                env: {
                    HOME: homeDir, PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
                    USER: sourceEnv.USER ?? os.userInfo().username,
                    LOGNAME: sourceEnv.LOGNAME ?? os.userInfo().username,
                    TMPDIR: "/tmp",
                },
            },
            label: "Original signed native Main external installer",
        });
    }
    finally {
        await fd.close();
    }
    return Object.freeze({ scheduled: true, requestId, targetSha: null,
        handoff: "original-signed-main-shell", logPath });
}
