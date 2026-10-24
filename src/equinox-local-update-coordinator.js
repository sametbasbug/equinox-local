import { spawn as spawnChild } from "node:child_process";
import { fileURLToPath } from "node:url";
import { launchDetachedHelper } from "./equinox-local-detached-helper.js";
import { prepareManagedEquinoxRelease } from "./equinox-local-release-manager.js";
import { compareEquinoxVersions, parseEquinoxVersion } from "./equinox-local-updater.js";
import { requestWindowsShellManagedActivation } from "./equinox-local-windows-shell-control.js";
import { projectDarwinDetachedHelperEnvironment } from "./equinox-local-darwin-helper-environment.js";
const DEFAULT_HELPER_PATH = fileURLToPath(new URL("./equinox-local-update-helper.js", import.meta.url));
function helperEnvironment(installation, sourceEnv = process.env) {
    if (installation?.platform !== "win32") {
        return projectDarwinDetachedHelperEnvironment({ installation, sourceEnv });
    }
    const env = {
        HOME: sourceEnv.HOME,
        USERPROFILE: sourceEnv.USERPROFILE,
        LOCALAPPDATA: sourceEnv.LOCALAPPDATA,
        SystemRoot: sourceEnv.SystemRoot,
        WINDIR: sourceEnv.WINDIR,
        USER: sourceEnv.USER,
        LOGNAME: sourceEnv.LOGNAME,
        TMPDIR: sourceEnv.TMPDIR,
        EQUINOX_LOCAL_INSTALL_ROOT: installation.installRoot,
        EQUINOX_LOCAL_RELEASE_DIR: installation.releaseDir,
    };
    return Object.fromEntries(Object.entries(env).filter((entry) => typeof entry[1] === "string" && entry[1].length > 0));
}
export async function scheduleEquinoxLocalActivation({ installation, version, spawnImpl = spawnChild, nodePath = process.execPath, helperPath = DEFAULT_HELPER_PATH, sourceEnv = process.env, requestWindowsActivationImpl = requestWindowsShellManagedActivation, } = {}) {
    if (!installation?.selfUpdateSupported)
        throw new Error("A managed Equinox Local installation is required to schedule activation.");
    const normalizedVersion = parseEquinoxVersion(version).text;
    if (installation.platform === "win32") {
        const acknowledgement = await requestWindowsActivationImpl(normalizedVersion, { platform: "win32" });
        if (acknowledgement?.requested !== true)
            throw new Error("Windows shell did not confirm managed update activation handoff.");
        return Object.freeze({ scheduled: true, version: normalizedVersion, handoff: "windows-shell" });
    }
    await launchDetachedHelper({
        spawnImpl,
        command: nodePath,
        args: [helperPath, "--activate", normalizedVersion],
        options: {
            detached: true,
            stdio: "ignore",
            env: helperEnvironment(installation, sourceEnv),
        },
        label: "Equinox Local update helper",
    });
    return Object.freeze({ scheduled: true, version: normalizedVersion });
}
export function createEquinoxLocalUpdateCoordinator({ installation, updater, prepareRelease = prepareManagedEquinoxRelease, spawnImpl = spawnChild, nodePath = process.execPath, helperPath = DEFAULT_HELPER_PATH, sourceEnv = process.env, requestWindowsActivationImpl = requestWindowsShellManagedActivation, now = Date.now, } = {}) {
    if (!updater || typeof updater.snapshot !== "function" || typeof updater.candidate !== "function") {
        throw new Error("Equinox Local updater is required by the update coordinator.");
    }
    let applying = false;
    let restartScheduledFor = null;
    let scheduledAt = null;
    let restartError = null;
    const snapshot = () => {
        const update = updater.snapshot();
        // An acknowledged handoff is not proof that the new runtime started.
        // A still-running old server must not trap Control Center in Restarting
        // forever when its independently launched Windows/macOS helper fails.
        if (restartScheduledFor && scheduledAt !== null) {
            const elapsed = now() - scheduledAt;
            if (elapsed >= 5 * 60_000) {
                restartScheduledFor = null;
                scheduledAt = null;
                restartError = "The update restart was not confirmed within five minutes. The current runtime is still responding; check its health and retry the update.";
            }
        }
        return Object.freeze({ ...update, applying, restartScheduledFor, restartError });
    };
    const apply = async () => {
        if (applying)
            throw new Error("An Equinox Local update is already being prepared.");
        const status = updater.snapshot();
        if (!installation?.selfUpdateSupported || !status.selfUpdateSupported) {
            throw new Error("Self-update is unavailable for this Equinox Local installation.");
        }
        const candidate = updater.candidate();
        if (!candidate || status.updateAvailable !== true) {
            throw new Error("Check for updates and verify a newer signed release before installing.");
        }
        if (compareEquinoxVersions(status.currentVersion, candidate.version) >= 0) {
            throw new Error("The verified update candidate is not newer than the running Equinox Local version.");
        }
        applying = true;
        restartError = null;
        try {
            const prepared = await prepareRelease({ installation, manifest: candidate });
            await scheduleEquinoxLocalActivation({
                installation,
                version: candidate.version,
                spawnImpl,
                nodePath,
                helperPath,
                sourceEnv,
                requestWindowsActivationImpl,
            });
            restartScheduledFor = candidate.version;
            scheduledAt = now();
            return Object.freeze({
                scheduled: true,
                currentVersion: status.currentVersion,
                targetVersion: candidate.version,
                fileCount: prepared.fileCount,
                extractedBytes: prepared.extractedBytes,
            });
        }
        finally {
            applying = false;
        }
    };
    return Object.freeze({ snapshot, apply });
}
