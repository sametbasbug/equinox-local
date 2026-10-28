import { randomBytes } from "node:crypto";
import { execFile as callbackExec } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { launchAgentPlist, EQUINOX_LOCAL_LAUNCH_AGENT_LABEL } from "./equinox-local-bootstrap.js";
import { equinoxLocalAppExecutablePath } from "./equinox-local-app-host.js";
import { inspectSignedMainInstallerMacActivation } from "./equinox-local-first-install.js";
import { resolveEquinoxLocalInstallation } from "./equinox-local-installation.js";
import { validateTrustedMainInstallPointer } from "./equinox-local-main-install-pointer.js";
import { beginEquinoxLocalSignedNativeMacOwner, assertEquinoxLocalSignedNativeMacOwner, readEquinoxLocalSignedNativeMacReceipt, readEquinoxLocalMainNativeRecoveryDescriptor, writeEquinoxLocalMainNativeRecoveryDescriptor, writeEquinoxLocalSignedNativeMacReceipt, releaseEquinoxLocalSignedNativeMacOwner, } from "./equinox-local-main-native-recovery.js";
import { readEquinoxLocalMainNativePointer } from "./equinox-local-main-native-state.js";
import { assertEquinoxLocalFreshNativeAppHostOwned } from "./equinox-local-native-app-host.js";
import { waitForExactNativeMainHealth } from "./equinox-local-main-update-worker.js";
import { readBoundedNormalFile } from "./equinox-local-safe-file.js";
const execFile = promisify(callbackExec);
const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
function isCode(error, code) {
    return error !== null && typeof error === "object" && "code" in error && error.code === code;
}
// Reconcile a crash AFTER a same-SHA repair's detached service action.
// Repair never starts a B worker or switches the SHA pointer. Only a
// production-signed, intact, NOW HEALTHY identical A may close its journal.
// An unhealthy original or rollback_failed receipt stays locked for review.
export async function recoverEquinoxLocalSignedMainMacRepair({ signedPointer, transactionId, homeDir = os.homedir(), platform = process.platform, arch = process.arch, uid = process.getuid?.(), env = process.env, fsImpl = fs, inspectImpl = inspectSignedMainInstallerMacActivation, readPointerImpl = readEquinoxLocalMainNativePointer, verifyHealthImpl = waitForExactNativeMainHealth, assertAppImpl = assertEquinoxLocalFreshNativeAppHostOwned, verifyPointerImpl = validateTrustedMainInstallPointer, }) {
    if (platform !== "darwin" || !["arm64", "x64"].includes(arch) ||
        !/^main-[a-f0-9]{32}$/u.test(transactionId) ||
        typeof homeDir !== "string" || !path.posix.isAbsolute(homeDir) ||
        path.posix.normalize(homeDir) !== homeDir ||
        !Number.isSafeInteger(uid) || uid === null || uid === undefined || uid < 1) {
        throw new Error("Same-SHA repair recovery requires the exact original Mac transaction.");
    }
    const root = path.posix.join(homeDir, "Library", "Application Support", "Equinox Local", "main-update");
    const target = "darwin-" + arch;
    const inspected = await inspectImpl({ signedPointer, homeDir, platform, arch, env, fsImpl });
    if (inspected.action !== "verify_or_repair" || inspected.target !== target ||
        inspected.transactionRoot !== root || inspected.previousSha !== inspected.sourceSha ||
        inspected.previousReleaseDir !== inspected.releaseDir) {
        throw new Error("Signed Main recovery is not the exact original same-SHA installation.");
    }
    const selected = verifyPointerImpl(signedPointer, { expectedSourceSha: inspected.sourceSha });
    const row = selected.targets.find(value => value.target === target);
    if (!row || row.runtimeContractSha256 !== inspected.runtimeContractSha256 ||
        selected.version !== inspected.version) {
        throw new Error("Signed Main repair recovery selector is not the original trusted SHA.");
    }
    const owner = { transactionRoot: root, transactionId, sourceSha: inspected.sourceSha,
        target, runtimeContractSha256: inspected.runtimeContractSha256 };
    await assertEquinoxLocalSignedNativeMacOwner({ ...owner, fsImpl });
    const descriptor = await readEquinoxLocalMainNativeRecoveryDescriptor({
        transactionRoot: root, transactionId,
        expected: { targetSha: inspected.sourceSha, target,
            targetRuntimeContractSha256: inspected.runtimeContractSha256 }, fsImpl,
    });
    if (descriptor.previous.kind !== "main" ||
        descriptor.previous.sourceSha !== inspected.sourceSha ||
        descriptor.previous.target !== target ||
        descriptor.previous.runtimeContractSha256 !== inspected.runtimeContractSha256) {
        throw new Error("Repair recovery descriptor does not identify the SAME original native A.");
    }
    const receipt = await readEquinoxLocalSignedNativeMacReceipt({ ...owner, fsImpl });
    if (!["admitted", "activating", "healthy"].includes(receipt.status)) {
        throw new Error("Failed same-SHA repair receipt cannot be automatically cleared.");
    }
    const pointer = await readPointerImpl(path.posix.join(root, "current-native.json"), {
        transactionRoot: root, fsImpl,
    });
    if (pointer.sourceSha !== inspected.sourceSha || pointer.target !== target ||
        pointer.runtimeContractSha256 !== inspected.runtimeContractSha256 ||
        pointer.payloadVersion !== inspected.version ||
        pointer.releaseDir !== inspected.releaseDir ||
        await fsImpl.realpath(path.posix.join(path.dirname(root), "current")) !== inspected.releaseDir) {
        throw new Error("Same-SHA repair recovery original native pointers were modified.");
    }
    const agent = path.posix.join(homeDir, "Library", "LaunchAgents", EQUINOX_LOCAL_LAUNCH_AGENT_LABEL + ".plist");
    const { data: agentText, stat } = await readBoundedNormalFile(agent, {
        fsImpl, minBytes: 1, maxBytes: 32 * 1024, encoding: "utf8", requireSingleLink: true,
        label: "Original Main LaunchAgent",
    });
    if ((stat.mode & 0o777) !== 0o600 ||
        agentText !== launchAgentPlist({ homeDir, installRoot: path.posix.dirname(root) })) {
        throw new Error("Same-SHA repair recovery LaunchAgent is foreign.");
    }
    await assertAppImpl({ homeDir, releaseDir: inspected.releaseDir, fsImpl });
    if (await verifyHealthImpl({ transactionRoot: root, sourceSha: inspected.sourceSha,
        target, version: inspected.version,
        runtimeContractSha256: inspected.runtimeContractSha256 }) !== true) {
        throw new Error("Original same-SHA native runtime remains unhealthy; repair owner retained.");
    }
    if (receipt.status === "admitted") {
        await writeEquinoxLocalSignedNativeMacReceipt({ ...owner, status: "activating", fsImpl });
    }
    if (receipt.status !== "healthy") {
        await writeEquinoxLocalSignedNativeMacReceipt({ ...owner, status: "healthy", fsImpl });
    }
    await releaseEquinoxLocalSignedNativeMacOwner({ ...owner, fsImpl });
    return Object.freeze({ status: "repaired", recovered: true, sourceSha: inspected.sourceSha,
        target, version: inspected.version, transactionId });
}
// A same-SHA repair does NOT switch A/B pointers or overwrite a user app.
// It is only a bounded restart of an authenticated original LaunchAgent.
// The shared signed-native owner is retained if the exact SHA does not
// become healthy; never misrecord an unhealthy original A as "rolled back".
export async function repairEquinoxLocalSignedMainMacRuntime({ signedPointer, homeDir = os.homedir(), arch = process.arch, platform = process.platform, uid = process.getuid?.(), env = process.env, fsImpl = fs, execFileImpl = execFile, transactionId = "main-" + randomBytes(16).toString("hex"), inspectImpl = inspectSignedMainInstallerMacActivation, verifyPointerImpl = validateTrustedMainInstallPointer, readPointerImpl = readEquinoxLocalMainNativePointer, assertAppImpl = assertEquinoxLocalFreshNativeAppHostOwned, verifyHealthImpl = waitForExactNativeMainHealth, writeDescriptorImpl = writeEquinoxLocalMainNativeRecoveryDescriptor, beginOwnerImpl = beginEquinoxLocalSignedNativeMacOwner, writeReceiptImpl = writeEquinoxLocalSignedNativeMacReceipt, releaseOwnerImpl = releaseEquinoxLocalSignedNativeMacOwner, }) {
    if (platform !== "darwin" || !["arm64", "x64"].includes(arch) ||
        typeof homeDir !== "string" || !path.posix.isAbsolute(homeDir) ||
        path.posix.normalize(homeDir) !== homeDir ||
        !Number.isSafeInteger(uid) || uid === null || uid === undefined || uid < 1 ||
        !/^main-[a-f0-9]{32}$/u.test(transactionId)) {
        throw new Error("Exact signed Main native repair requires the original non-root Mac installation.");
    }
    const target = "darwin-" + arch;
    const root = path.posix.join(homeDir, "Library", "Application Support", "Equinox Local", "main-update");
    const installRoot = path.posix.dirname(root);
    const initial = await inspectImpl({ signedPointer, homeDir, platform, arch, env, fsImpl });
    if (initial.action !== "verify_or_repair" || initial.target !== target ||
        initial.transactionRoot !== root || !SHA.test(initial.sourceSha) ||
        !DIGEST.test(initial.runtimeContractSha256) ||
        initial.previousKind !== "main" || initial.previousSha !== initial.sourceSha ||
        initial.previousReleaseDir !== initial.releaseDir ||
        initial.releaseDir !== path.posix.join(root, "native-store", target, initial.sourceSha, "release")) {
        throw new Error("Same-SHA repair cannot replace a foreign, Stable, Factory or different-source A.");
    }
    const signed = verifyPointerImpl(signedPointer, { expectedSourceSha: initial.sourceSha });
    const targetRow = signed.targets.find(v => v.target === target);
    if (!targetRow || signed.version !== initial.version ||
        targetRow.runtimeContractSha256 !== initial.runtimeContractSha256) {
        throw new Error("Same-SHA repair original production signature or native contract drifted.");
    }
    const nativePath = path.posix.join(root, "current-native.json");
    const checkPointer = async () => {
        const current = await readPointerImpl(nativePath, { transactionRoot: root, fsImpl });
        if (current.sourceSha !== initial.sourceSha || current.target !== target ||
            current.runtimeContractSha256 !== initial.runtimeContractSha256 ||
            current.releaseDir !== initial.releaseDir ||
            current.payloadVersion !== initial.version) {
            throw new Error("Same-SHA repair durable pointer changed.");
        }
        const link = path.posix.join(installRoot, "current");
        if (await fsImpl.realpath(link) !== initial.releaseDir) {
            throw new Error("Same-SHA repair current symlink changed.");
        }
    };
    const agentPath = path.posix.join(homeDir, "Library", "LaunchAgents", EQUINOX_LOCAL_LAUNCH_AGENT_LABEL + ".plist");
    const service = "gui/" + uid + "/" + EQUINOX_LOCAL_LAUNCH_AGENT_LABEL;
    const executable = equinoxLocalAppExecutablePath(homeDir);
    const checkHost = async () => {
        const { data: agentText, stat } = await readBoundedNormalFile(agentPath, {
            fsImpl, minBytes: 1, maxBytes: 32 * 1024, encoding: "utf8", requireSingleLink: true,
            label: "Original Main LaunchAgent",
        });
        if ((stat.mode & 0o777) !== 0o600 ||
            agentText !== launchAgentPlist({ homeDir, installRoot })) {
            throw new Error("Original Main LaunchAgent differs from the signed native installation.");
        }
        await assertAppImpl({ homeDir, releaseDir: initial.releaseDir, fsImpl, execFileImpl });
    };
    const healthArgs = { transactionRoot: root, sourceSha: initial.sourceSha,
        target, version: initial.version, runtimeContractSha256: initial.runtimeContractSha256 };
    await checkPointer();
    await checkHost();
    try {
        if (await verifyHealthImpl(healthArgs) === true) {
            return Object.freeze({ status: "already_healthy", sourceSha: initial.sourceSha, target, version: initial.version });
        }
    }
    catch { /* unhealthy is NOT proof of damaged signed release */ }
    const owner = { transactionRoot: root, transactionId, sourceSha: initial.sourceSha,
        target, runtimeContractSha256: initial.runtimeContractSha256 };
    const current = await readPointerImpl(nativePath, { transactionRoot: root, fsImpl });
    const installation = resolveEquinoxLocalInstallation({ homeDir, platform, arch,
        env: { ...env, EQUINOX_LOCAL_INSTALL_ROOT: installRoot,
            EQUINOX_LOCAL_RELEASE_DIR: initial.releaseDir } });
    if (!installation.managed || !installation.selfUpdateSupported ||
        installation.releaseDir !== initial.releaseDir || installation.target !== target) {
        throw new Error("Same-SHA repair installation is not the original managed Main.");
    }
    await writeDescriptorImpl({
        transactionRoot: root, transactionId,
        transition: { mode: "artifact_required", target, targetSha: initial.sourceSha,
            targetRuntimeContractSha256: initial.runtimeContractSha256 },
        previousPointer: current, installation, fsImpl,
    });
    await beginOwnerImpl({ ...owner, uid, fsImpl });
    // From here ON, any crash or unverifiable restart retains the original
    // exclusive active owner and its receipt for explicit, conservative
    // recovery; it does not pretend A is healthy or update any pointers.
    await checkPointer();
    await checkHost();
    const rechecked = await inspectImpl({ signedPointer, homeDir, platform, arch, env, fsImpl });
    if (rechecked.action !== "verify_or_repair" ||
        rechecked.sourceSha !== initial.sourceSha || rechecked.releaseDir !== initial.releaseDir) {
        throw new Error("Signed native A changed after same-SHA repair lock admission.");
    }
    await writeReceiptImpl({ ...owner, status: "activating", fsImpl });
    let mutated = false;
    try {
        const loaded = await (async () => {
            try {
                const status = await execFileImpl("/bin/launchctl", ["print", service], {
                    timeout: 5000, maxBuffer: 65536,
                });
                if (!String(status.stdout ?? "").includes(executable)) {
                    throw new Error("LaunchAgent loaded process differs from the original signed Main host.");
                }
                return true;
            }
            catch (error) {
                const message = String(error?.stderr ?? "");
                if (!isCode(error, 113) ||
                    !message.includes('Could not find service "' + EQUINOX_LOCAL_LAUNCH_AGENT_LABEL + '" in domain for user gui: ' + uid)) {
                    throw error;
                }
                return false;
            }
        })();
        await execFileImpl("/bin/launchctl", ["print", "gui/" + uid], {
            timeout: 5000, maxBuffer: 65536,
        });
        // Both operations use the verified ORIGINAL user LaunchAgent only.
        mutated = true;
        await execFileImpl("/bin/launchctl", loaded
            ? ["kickstart", "-k", service]
            : ["bootstrap", "gui/" + uid, agentPath], { timeout: 15000, maxBuffer: 65536 });
        if (await verifyHealthImpl(healthArgs) !== true) {
            throw new Error("Same-SHA repair restarted the original service but exact source SHA health did not recover.");
        }
        await checkPointer();
        await checkHost();
        await writeReceiptImpl({ ...owner, status: "healthy", fsImpl });
        await releaseOwnerImpl({ ...owner, fsImpl });
        return Object.freeze({ status: "repaired", sourceSha: initial.sourceSha,
            target, version: initial.version, transactionId });
    }
    catch (error) {
        // A healthy earlier A did not exist; rollback to the SAME unhealthy
        // SHA would falsely assert success. Keep ACTIVATING with the same
        // owner. The ORIGINAL --recover-main can finish ONLY if that exact
        // SHA actually becomes healthy; no rollback was ever attempted.
        throw Object.assign(new Error("Exact signed Main repair could not prove runtime health; original native owner remains locked."), {
            cause: error, serviceMutationAttempted: mutated, transactionId,
        });
    }
}
