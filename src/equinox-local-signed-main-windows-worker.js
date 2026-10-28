import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { readBoundedNormalFile } from "./equinox-local-safe-file.js";
import { validateTrustedMainInstallPointer } from "./equinox-local-main-install-pointer.js";
import { inspectEquinoxLocalMainNativeStoredRelease } from "./equinox-local-main-native-state.js";
import { readEquinoxLocalMainNativeRecoveryDescriptor } from "./equinox-local-main-native-recovery.js";
import { startEquinoxWindowsMainWorkerProof } from "./equinox-local-windows-main-worker-proof.js";
const execFile = promisify(execFileCallback);
const ID = /^main-[a-f0-9]{32}$/u;
const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const TOKEN = /^[a-f0-9]{64}$/u;
async function auditOriginalInstalledGuardian({ guardianPath, env = process.env }) {
    // A signed-native read-only audit is NOT a worker session/HMAC and cannot
    // stop WPF or mutate native pointers. The original Guardian does not
    // expose a signed-native activation opcode yet.
    // The exact original Guardian OS argv audit already verifies the full
    // production-signed journal and B release fingerprint. Do not rescan B
    // with a redundant separate journal command; no OS mutation authority.
    await execFile(guardianPath, ["--audit-signed-native-worker-argv"], {
        timeout: 15_000, windowsHide: true, maxBuffer: 4096,
        env: {
            ...(env.SystemRoot ? { SystemRoot: env.SystemRoot } : {}),
            ...(env.WINDIR ? { WINDIR: env.WINDIR } : {}),
            ...(env.LOCALAPPDATA ? { LOCALAPPDATA: env.LOCALAPPDATA } : {}),
            ...(env.USERPROFILE ? { USERPROFILE: env.USERPROFILE } : {}),
        },
    });
}
async function auditOriginalInstalledGuardianPipe({ guardianPath, env = process.env, }) {
    await execFile(guardianPath, ["--audit-signed-native-worker-pipe"], {
        timeout: 15_000, windowsHide: true, maxBuffer: 4096,
        env: {
            ...(env.SystemRoot ? { SystemRoot: env.SystemRoot } : {}),
            ...(env.WINDIR ? { WINDIR: env.WINDIR } : {}),
            ...(env.LOCALAPPDATA ? { LOCALAPPDATA: env.LOCALAPPDATA } : {}),
            ...(env.USERPROFILE ? { USERPROFILE: env.USERPROFILE } : {}),
        },
    });
}
// This is a *read-only* entrypoint for the SAME packaged Main worker,
// NOT a second Windows updater, a source-Git receipt, a service or a
// Guardian-native journal writer. WPF must authenticate B independently
// BEFORE ever launching its executable, and a separate ORIGINAL signed
// Guardian OS session must grant any future mutation permission.
export async function inspectSignedWindowsNativeWorkerPreflight({ argv = process.argv.slice(2), workerPath = process.argv[1], nodePath = process.execPath, platform = process.platform, arch = process.arch, env = process.env, fsImpl = fs, readSelectorImpl = readBoundedNormalFile, verifyPointerImpl = validateTrustedMainInstallPointer, inspectStoredImpl = inspectEquinoxLocalMainNativeStoredRelease, readDescriptorImpl = readEquinoxLocalMainNativeRecoveryDescriptor, auditGuardianImpl = auditOriginalInstalledGuardian, } = {}) {
    if (platform !== "win32" || !["x64", "arm64"].includes(arch) ||
        argv.length !== 5 || argv[0] !== "--signed-native" ||
        argv[1] !== "--transaction-id" || argv[3] !== "--transaction-root" ||
        !ID.test(argv[2] ?? "") || typeof argv[4] !== "string" ||
        !path.win32.isAbsolute(argv[4]) ||
        path.win32.normalize(argv[4]) !== argv[4]) {
        throw new Error("Original Windows signed-native worker requires an exact OS-owned transaction argv.");
    }
    const local = env.LOCALAPPDATA;
    if (typeof local !== "string" || !path.win32.isAbsolute(local) ||
        path.win32.normalize(local) !== local) {
        throw new Error("Original signed-native worker has no canonical Windows user root.");
    }
    const installRoot = path.win32.join(local, "Equinox Local");
    const root = path.win32.join(installRoot, "state", "main-update");
    const id = argv[2];
    if (argv[4] !== root)
        throw new Error("Windows signed-native worker cannot escape original user Main state.");
    const target = "win32-" + arch;
    const releaseDir = path.win32.dirname(workerPath ?? "");
    const sha = path.win32.basename(path.win32.dirname(releaseDir));
    const wantedRelease = path.win32.join(root, "native-store", target, sha, "release");
    const expectedWorker = path.win32.join(wantedRelease, "equinox-local-main-update-worker.js");
    const expectedNode = path.win32.join(wantedRelease, "runtime", "node", "bin", "node.exe");
    if (!SHA.test(sha) || releaseDir !== wantedRelease || workerPath !== expectedWorker ||
        nodePath !== expectedNode) {
        throw new Error("Windows signed-native worker and Node must belong to one exact B SHA.");
    }
    for (const file of [expectedWorker, expectedNode]) {
        const stat = await fsImpl.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
            await fsImpl.realpath(file) !== file) {
            throw new Error("Original Windows signed-native B contains a redirected worker executable.");
        }
    }
    const descriptor = await readDescriptorImpl({
        transactionRoot: root, transactionId: id, expected: { targetSha: sha, target }, fsImpl,
    });
    if (descriptor.targetSha !== sha || descriptor.target !== target ||
        !DIGEST.test(descriptor.targetRuntimeContractSha256) ||
        descriptor.previous.kind === "none" ||
        (descriptor.previous.kind === "main" &&
            (descriptor.previous.sourceSha === sha || descriptor.previous.target !== target))) {
        throw new Error("Original Windows signed-native B has no admissible previous A and contract.");
    }
    const stored = await inspectStoredImpl({ transactionRoot: root, sourceSha: sha,
        target, expectedRuntimeContractSha256: descriptor.targetRuntimeContractSha256, fsImpl });
    const selector = await readSelectorImpl(path.win32.join(root, "native-store", target, sha, "signed-selector.json"), { fsImpl, platform: "win32",
        minBytes: 200, maxBytes: 16 * 1024, encoding: "utf8", label: "Original Windows immutable Main Ed25519 selector" });
    const signed = verifyPointerImpl(JSON.parse(selector.data), { expectedSourceSha: sha });
    const row = signed.targets.find(t => t.target === target);
    if (!row || row.runtimeContractSha256 !== descriptor.targetRuntimeContractSha256 ||
        stored.sourceSha !== sha || stored.target !== target ||
        stored.releaseDir !== wantedRelease || stored.runtimeContractSha256 !== row.runtimeContractSha256 ||
        stored.payloadVersion !== signed.version ||
        stored.manifest.artifactSha256 !== row.artifact.sha256 ||
        stored.manifest.artifactBytes !== row.artifact.bytes) {
        throw new Error("Original Windows signed-native worker B differs from production Ed25519/immutable store.");
    }
    const guardianPath = path.win32.join(installRoot, "runtime", "guardian", "EquinoxLocalGuardian.exe");
    const guardianStat = await fsImpl.lstat(guardianPath);
    if (!guardianStat.isFile() || guardianStat.isSymbolicLink() || guardianStat.nlink !== 1 ||
        await fsImpl.realpath(guardianPath) !== guardianPath) {
        throw new Error("Original Windows signed-native worker cannot find its installed Guardian.");
    }
    await auditGuardianImpl({ guardianPath, transactionId: id, env });
    return Object.freeze({ status: "guardian_os_handoff_required",
        transactionId: id, sourceSha: sha, target, version: signed.version,
        runtimeContractSha256: row.runtimeContractSha256 });
}
export async function runEquinoxLocalSignedWindowsNativeWorker({ startProofImpl = startEquinoxWindowsMainWorkerProof, auditProofImpl = auditOriginalInstalledGuardianPipe, ...options } = {}) {
    const verified = await inspectSignedWindowsNativeWorkerPreflight(options);
    const env = options.env ?? process.env;
    const token = env.EQUINOX_LOCAL_MAIN_WORKER_TOKEN;
    if (typeof token !== "string" || !TOKEN.test(token)) {
        throw new Error("Original Windows signed-native worker has no exact WPF-issued launch token.");
    }
    const guardianPath = path.win32.join(env.LOCALAPPDATA, "Equinox Local", "runtime", "guardian", "EquinoxLocalGuardian.exe");
    // This is the EXISTING product-owned named pipe challenge and HMAC,
    // NOT a new update protocol. The original Guardian independently binds
    // the live pipe server to PID, birth time, SID/LUID, exact B argv and
    // the WPF-issued token. The positive read-only audit is NOT an A/B grant.
    const proof = await startProofImpl({ transactionId: verified.transactionId,
        workerToken: token, platform: "win32" });
    try {
        await auditProofImpl({ guardianPath, env });
    }
    finally {
        await proof.close();
    }
    // Explicitly no API calls to the Git source journal, Windows slot changes,
    // WPF shutdown, Chrome Native Messaging or supervisor restarts. A positive
    // fresh OS nonce MAC is still NOT an original signed-native mutation lease.
    throw new Error("Signed Windows Main B passed read-only Guardian kernel HMAC, but original native OS mutation session is not authorized.");
}
