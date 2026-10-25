import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveEquinoxLocalInstallation } from "./equinox-local-installation.js";
import { activatePreparedEquinoxRelease, readManagedCurrentRelease } from "./equinox-local-update-activation.js";
import { pruneInactiveManagedStableReleases } from "./equinox-local-release-retention.js";
import { parseEquinoxVersion } from "./equinox-local-updater.js";
import { bridgeActivatedStableToMain } from "./equinox-local-stable-main-bridge.js";
import { runMacStableMainBridgeWorker } from "./equinox-local-mac-main-bridge.js";
function failureMessage(error) {
    if (error !== null && typeof error === "object" && "message" in error &&
        error.message !== null && error.message !== undefined)
        return String(error.message);
    return String(error);
}
const START_DELAY_MS = 1_500;
export async function runEquinoxLocalUpdateHelper({ argv = process.argv.slice(2), env = process.env, homeDir = env.USERPROFILE ?? env.HOME, sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), activateImpl = activatePreparedEquinoxRelease, bridgeImpl = bridgeActivatedStableToMain, macBridgeWorkerImpl = runMacStableMainBridgeWorker, pruneStableImpl = (value) => pruneInactiveManagedStableReleases(value, { readCurrent: readManagedCurrentRelease }), } = {}) {
    if (!Array.isArray(argv) || argv.length !== 2 || !["--activate", "--bridge-after-upgrade"].includes(argv[0])) {
        throw new Error("Usage: equinox-local-update-helper.js --activate|--bridge-after-upgrade <version>");
    }
    const targetVersion = parseEquinoxVersion(argv[1]).text;
    const installation = resolveEquinoxLocalInstallation({ homeDir: homeDir, env });
    if (!installation.selfUpdateSupported) {
        throw new Error("Update helper requires a managed Equinox Local installation.");
    }
    // The installation resolver already applies runtime managed/ownership checks.
    // Its union result retains nullable fields for unsupported source installations.
    const admitted = installation;
    if (argv[0] === "--bridge-after-upgrade") {
        if (installation.platform !== "darwin")
            throw new Error("Stable Main startup bridge is macOS-only.");
        return macBridgeWorkerImpl({ installation: admitted, version: targetVersion, homeDir: homeDir });
    }
    await sleepImpl(START_DELAY_MS);
    const activation = await activateImpl({ installation: admitted, targetVersion });
    if (activation?.status === "activated" || activation?.status === "already-active") {
        // The *new*, signed Stable release helper is the bridge for previously
        // installed Stable clients. The old updater has no dependency on this code.
        const bridge = await bridgeImpl({ installation: admitted, version: targetVersion, homeDir: homeDir, env });
        // The old numbered Stable versions are no longer needed after the new
        // Stable runtime AND Main bridge have both been confirmed. Deleting them
        // before either health gate succeeds would remove rollback protection.
        let releaseCleanup;
        try {
            releaseCleanup = await pruneStableImpl(installation);
        }
        catch (error) {
            // An already healthy installation must never be rolled back because an
            // obsolete Windows directory remains locked. Surface the cleanup error
            // so the next guarded maintenance pass can retry it.
            releaseCleanup = { pending: true, reason: failureMessage(error).slice(0, 240) };
        }
        return Object.freeze({ ...activation, mainBridge: bridge.status, releaseCleanup });
    }
    return activation;
}
// WPF acknowledges Process.Start, not successful activation. Detached helpers
// must leave a safe, bounded failure trace in the EXISTING Windows shell log.
// Never persist raw exception messages: they may contain paths or credentials.
const SAFE_ERROR_CODES = new Set([
    "EACCES", "EPERM", "ENOENT", "EBUSY", "ENOSPC", "EIO", "EINVAL",
    "ETIMEDOUT", "ECONNREFUSED", "EADDRINUSE", "EEXIST",
]);
const WINDOWS_SHELL_LOG_MAX_BYTES = 64 * 1024;
export async function recordEquinoxLocalUpdateHelperFailure(error, { env = process.env, platform = process.platform, argv = process.argv.slice(2), now = () => new Date(), } = {}) {
    if (platform !== "win32")
        return false;
    const localAppData = env.LOCALAPPDATA;
    if (!localAppData || !path.isAbsolute(localAppData))
        return false;
    const action = Array.isArray(argv) && argv[0] === "--activate" ? "activate" :
        Array.isArray(argv) && argv[0] === "--bridge-after-upgrade" ? "bridge" : "invalid-arguments";
    const rawCode = error && typeof error === "object" && "code" in error ? error.code : null;
    const code = typeof rawCode === "string" && SAFE_ERROR_CODES.has(rawCode) ? rawCode : "UNCLASSIFIED";
    const detail = failureMessage(error);
    const phase = /automatic rollback also failed/u.test(detail) ? "rollback-failed" :
        /was rolled back to/u.test(detail) ? "rolled-back" : "helper-failed";
    const line = `${now().toISOString()} update-helper action=${action} status=failed phase=${phase} code=${code}\n`;
    try {
        const logsRoot = path.join(localAppData, "Equinox Local", "logs");
        await fs.mkdir(logsRoot, { recursive: true, mode: 0o700 });
        const directory = await fs.lstat(logsRoot);
        if (!directory.isDirectory() || directory.isSymbolicLink())
            return false;
        const logPath = path.join(logsRoot, "windows-shell-runtime.log");
        // Open exactly once with no symlink following. A prior lstat followed by
        // append/rotation is racy and could overwrite a foreign file on replacement.
        const flags = fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW;
        const log = await fs.open(logPath, flags, 0o600);
        try {
            const info = await log.stat();
            // Native WPF owns rotation of this shared log; never truncate its data.
            if (!info.isFile() || info.size >= WINDOWS_SHELL_LOG_MAX_BYTES)
                return false;
            await log.writeFile(line);
            return true;
        }
        finally {
            await log.close();
        }
    }
    catch {
        // Logging must never interfere with the update/rollback decision.
        return false;
    }
}
export async function runEquinoxLocalUpdateHelperCli({ argv = process.argv.slice(2), env = process.env, platform = process.platform, runImpl = runEquinoxLocalUpdateHelper, reportImpl = recordEquinoxLocalUpdateHelperFailure, } = {}) {
    try {
        await runImpl({ argv, env });
        return 0;
    }
    catch (error) {
        await reportImpl(error, { argv, env, platform });
        return 1;
    }
}
const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath && import.meta.url === invokedPath) {
    runEquinoxLocalUpdateHelperCli().then((exitCode) => { process.exitCode = exitCode; });
}
