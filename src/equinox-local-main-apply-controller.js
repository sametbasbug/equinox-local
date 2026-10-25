import path from "node:path";
import { prepareAndScheduleEquinoxLocalMainUpdate } from "./equinox-local-main-update-coordinator.js";
import { createEquinoxLocalMainUpdateTransactionEngine } from "./equinox-local-main-update-transaction.js";
const TX_PATTERN = /^main-[a-f0-9]{32}$/u;
const SAFE_FAILURE_STAGES = new Set(["native_admission_failed", "rollback_failed", "rollback_source_restored", "rollback_native_restored", "ready_to_switch", "native_switched", "source_switched"]);
function safeFailedReceiptNotice(receipt) {
    // Detached worker errors can contain absolute user paths and command output.
    // Surface only trusted receipt enums and a fixed, actionable explanation.
    const stage = SAFE_FAILURE_STAGES.has(receipt.stage) ? receipt.stage : "update_failed";
    if (receipt.status === "rollback_failed")
        return "Main update rollback_failed: rollback health could not be verified. Keep the current installation and inspect local diagnostics before retrying.";
    if (receipt.status === "rolled_back")
        return "Main update rolled_back (" + stage + "): the previous version was restored after health validation failed.";
    if (stage === "native_admission_failed") {
        const needsSupervisor = typeof receipt.lastError === "string" && /independent supervisor|supervisor ownership/iu.test(receipt.lastError);
        return "Main update failed (" + stage + "): " + (needsSupervisor ? "independent Windows native supervisor ownership is required" : "native trust or toolchain admission was refused") + ". No new native version was activated.";
    }
    return "Main update failed (" + stage + "): the detached worker stopped before confirming a healthy new version. Check local update diagnostics.";
}
async function readExactScheduledReceipt({ transactionId, sourceRoot, transactionRoot }) {
    return createEquinoxLocalMainUpdateTransactionEngine({ sourceRoot, transactionRoot }).readReceipt(transactionId);
}
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
function validAbsolute(value) {
    return typeof value === "string" && path.isAbsolute(value) && !/[\r\n\0]/u.test(value);
}
function unavailableReason(installation) {
    if (installation?.kind !== "managed-source") {
        return "Main apply is available only for managed-source installations.";
    }
    if (installation?.mainUpdateSupported !== true) {
        return installation?.mainUpdateReason || "This managed-source installation has not enabled Main update handoff.";
    }
    if (!validAbsolute(installation?.sourceRoot) || !validAbsolute(installation?.mainTransactionRoot)) {
        return "Managed-source update paths are unavailable.";
    }
    return null;
}
export function createEquinoxLocalMainApplyController({ installation, discovery, applyImpl = prepareAndScheduleEquinoxLocalMainUpdate, readScheduledReceiptImpl = readExactScheduledReceipt, } = {}) {
    if (!discovery || typeof discovery.snapshot !== "function") {
        throw new Error("Main update discovery is required by the apply controller.");
    }
    if (typeof applyImpl !== "function") {
        throw new Error("Main update apply implementation is required.");
    }
    let applying = false;
    let restartScheduledFor = null;
    let scheduledTransactionId = null;
    let scheduledCurrentSha = null;
    let lastError = null;
    const snapshot = () => {
        const main = discovery.snapshot();
        const reason = unavailableReason(installation);
        const applySupported = reason === null && main?.checkSupported === true;
        const applyAvailable = Boolean(applySupported
            && main?.state === "behind"
            && SHA_PATTERN.test(main?.currentSha ?? "")
            && SHA_PATTERN.test(main?.targetSha ?? "")
            && main?.currentSha !== main?.targetSha
            && main?.dirty === false
            && main?.remoteCanonical === true
            && !lastError);
        return Object.freeze({
            applySupported,
            applyAvailable,
            applying,
            restartScheduledFor,
            applyReason: reason,
            applyError: lastError,
        });
    };
    // GET /update status reconciles only the exact scheduled transaction, not
    // unrelated historical receipts. Never infer failure from a transient read
    // error, and never allow a mismatched receipt to clear the restart guard.
    const reconcile = async () => {
        if (!restartScheduledFor || !scheduledTransactionId || !scheduledCurrentSha || !TX_PATTERN.test(scheduledTransactionId))
            return snapshot();
        try {
            const receipt = await readScheduledReceiptImpl({
                transactionId: scheduledTransactionId,
                sourceRoot: path.resolve(installation.sourceRoot),
                transactionRoot: path.resolve(installation.mainTransactionRoot),
            });
            if (receipt.transactionId !== scheduledTransactionId || receipt.currentSha !== scheduledCurrentSha || receipt.targetSha !== restartScheduledFor) {
                throw new Error("Main update receipt no longer matches the scheduled source identities.");
            }
            if (["failed", "rolled_back", "rollback_failed"].includes(receipt.status)) {
                lastError = safeFailedReceiptNotice(receipt);
                restartScheduledFor = null;
                scheduledTransactionId = null;
                scheduledCurrentSha = null;
            }
            else if (receipt.status === "succeeded") {
                restartScheduledFor = null;
                scheduledTransactionId = null;
                scheduledCurrentSha = null;
            }
        }
        catch {
            // Missing/unsafe/foreign receipt is unknown, not proof of failure or success.
        }
        return snapshot();
    };
    const resetError = () => {
        lastError = null;
        return snapshot();
    };
    const apply = async () => {
        if (applying)
            throw new Error("A Main update is already being prepared.");
        const status = snapshot();
        if (!status.applySupported) {
            throw new Error(status.applyReason || "Main update apply is unavailable.");
        }
        const main = discovery.snapshot();
        if (!status.applyAvailable) {
            throw new Error("Check the admitted Main snapshot and require a newer eligible target before applying.");
        }
        const currentSha = main.currentSha;
        const targetSha = main.targetSha;
        applying = true;
        lastError = null;
        try {
            const result = await applyImpl({
                sourceRoot: path.resolve(installation.sourceRoot),
                transactionRoot: path.resolve(installation.mainTransactionRoot),
                currentSha,
                targetSha,
                engineOptions: {
                    gitPath: installation.gitPath ?? "git",
                    nodePath: installation.nodePath ?? process.execPath,
                    npmPath: installation.npmPath ?? null,
                    shellPath: installation.shellPath ?? null,
                },
                schedulerOptions: {
                    ...(installation.mainSchedulerOptions ?? {}),
                    ...(installation.nodePath ? { nodePath: installation.nodePath } : {}),
                },
            });
            if (result?.targetSha !== targetSha || result?.status !== "scheduled") {
                throw new Error("Main update handoff did not preserve the admitted target identity.");
            }
            restartScheduledFor = targetSha;
            scheduledTransactionId = typeof result.transactionId === "string" && TX_PATTERN.test(result.transactionId) ? result.transactionId : null;
            scheduledCurrentSha = currentSha;
            return Object.freeze({
                ...result,
                currentSha,
                targetSha,
            });
        }
        catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
            throw error;
        }
        finally {
            applying = false;
        }
    };
    return Object.freeze({ snapshot, apply, resetError, reconcile });
}
