import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile as execCallback, spawn } from "node:child_process";
import { constants } from "node:fs";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { appRuntimeWrapper, launchAgentPlist } from "./equinox-local-bootstrap.js";
import { assertEquinoxLocalFreshNativeAppHostOwned, readEquinoxLocalNativeAppMetadata } from "./equinox-local-native-app-host.js";
import { inspectEquinoxLocalMainNativeStoredRelease, readEquinoxLocalMainNativePointer } from "./equinox-local-main-native-state.js";
import { validateTrustedMainInstallPointer } from "./equinox-local-main-install-pointer.js";
import { readBoundedNormalFile } from "./equinox-local-safe-file.js";
import { requestDesktopUpdateShutdown, requestDesktopUninstallShutdown } from "./equinox-local-desktop-control.js";
const exec = promisify(execCallback);
const options = { timeout: 15_000, maxBuffer: 1024 * 1024 };
const home = os.homedir();
const installRoot = path.join(home, "Library", "Application Support", "Equinox Local");
const app = path.join(home, "Applications", "Equinox Local.app");
const executable = path.join(app, "Contents", "MacOS", "applet");
const plist = path.join(home, "Library", "LaunchAgents", "dev.equinox.local.plist");
const service = `gui/${process.getuid?.()}/dev.equinox.local`;
const candidateRelease = path.dirname(fileURLToPath(import.meta.url));
async function admitCandidate() {
    const native = await readEquinoxLocalNativeAppMetadata(candidateRelease);
    if (!("kind" in native) || native.kind !== "electron")
        throw new Error("Direct macOS cutover requires the admitted schema-2 Electron candidate.");
    return native;
}
async function exists(file) { try {
    await fs.lstat(file);
    return true;
}
catch (error) {
    if (error.code === "ENOENT")
        return false;
    throw error;
} }
async function trusted(file) {
    let current = file;
    for (;;) {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink() || ![0, process.getuid?.()].includes(stat.uid) ||
            ((stat.mode & 0o022) !== 0 && !(stat.isDirectory() && stat.uid === 0 && (stat.mode & 0o1000) !== 0)))
            throw new Error("Unsafe installer ownership or ancestor.");
        if (current === path.dirname(current))
            break;
        current = path.dirname(current);
    }
}
async function text(file) { await trusted(file); return (await readBoundedNormalFile(file, { maxBytes: 128 * 1024, encoding: "utf8", label: "Installer owned program file" })).data; }
async function owners() {
    const { stdout } = await exec("/bin/ps", ["-axo", "uid=,pid=,comm="], options);
    const result = [];
    for (const line of stdout.split("\n")) {
        const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
        if (match?.[3] === executable) {
            if (Number(match[1]) !== process.getuid?.())
                throw new Error("Foreign installed application process.");
            result.push(Number(match[2]));
        }
    }
    if (result.length > 1)
        throw new Error("Ambiguous installed application owner.");
    return result;
}
async function waitExit(pid) {
    for (let count = 0; count < 150; count++) {
        try {
            process.kill(pid, 0);
        }
        catch (error) {
            if (error.code === "ESRCH")
                return;
            throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error("Exact installed owner did not exit; executable roots must not move.");
}
async function loaded() {
    try {
        return (await exec("/bin/launchctl", ["print", service], options)).stdout;
    }
    catch (error) {
        // launchctl uses 113 for an absent service. Do not treat arbitrary errors as absence.
        if (error.code === 113)
            return null;
        throw error;
    }
}
function verifyLoaded(value) {
    if (!value.includes(`path = ${plist}\n`) || !value.includes(`program = ${executable}\n`))
        throw new Error("Loaded service does not match the owned managed plist/application.");
}
async function writeContext(file, value, create = false) {
    await trusted(path.dirname(file));
    if (!create)
        await trusted(file);
    const body = JSON.stringify(value) + "\n";
    if (create) {
        const handle = await fs.open(file, "wx", 0o600);
        try {
            await handle.writeFile(body);
            await handle.sync();
        }
        finally {
            await handle.close();
        }
    }
    else {
        const temporary = path.join(path.dirname(file), `.installer-context-${randomBytes(8).toString("hex")}`);
        const handle = await fs.open(temporary, "wx", 0o600);
        try {
            await handle.writeFile(body);
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        await fs.rename(temporary, file);
    }
}
function validLegacyShell(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const record = value;
    if (Object.keys(record).some(key => !["visible", "language", "frame"].includes(key)) ||
        (record.visible !== undefined && typeof record.visible !== "boolean") ||
        (record.language !== undefined && record.language !== "en" && record.language !== "tr"))
        return false;
    if (record.frame !== undefined) {
        if (!record.frame || typeof record.frame !== "object" || Array.isArray(record.frame))
            return false;
        const frame = record.frame;
        if (Object.keys(frame).length !== 4 || !["x", "y", "width", "height"].every(key => typeof frame[key] === "number" && Number.isFinite(frame[key]) && Math.abs(frame[key]) <= 100_000) ||
            frame.width <= 0 || frame.height <= 0)
            return false;
    }
    return true;
}
async function readLegacyShellPreferences() {
    // Called ONLY after managed legacy app/wrapper/release ownership admission.
    // Read the three existing GUI keys; never export a domain or write old defaults.
    const read = async (key) => {
        try {
            return (await exec("/usr/bin/defaults", ["read", "dev.equinox.local", key], {
                ...options, maxBuffer: 8192, env: { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" },
            })).stdout.trim();
        }
        catch (error) {
            if (error.code === 1 && /does not exist/iu.test(String(error.stderr)))
                return undefined;
            throw new Error("Legacy GUI preference read failed before owner shutdown; existing defaults were not changed.");
        }
    };
    const values = {};
    const visible = await read("EquinoxLocalFloatingPetVisible");
    if (visible !== undefined) {
        if (["1", "true", "yes"].includes(visible.toLowerCase()))
            values.visible = true;
        else if (["0", "false", "no"].includes(visible.toLowerCase()))
            values.visible = false;
    }
    const language = await read("EquinoxLocalNativeLanguage");
    if (language === "en" || language === "tr")
        values.language = language;
    const frame = await read("EquinoxLocalFloatingPetFrame");
    if (frame !== undefined) {
        const number = "([-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][-+]?\\d+)?)";
        const match = new RegExp(`^\\{\\{\\s*${number}\\s*,\\s*${number}\\s*\\},\\s*\\{\\s*${number}\\s*,\\s*${number}\\s*\\}\\}$`, "u").exec(frame);
        if (match) {
            const [x, y, width, height] = match.slice(1).map(Number);
            const candidate = { frame: { x: x, y: y, width: width, height: height } };
            if (validLegacyShell(candidate))
                values.frame = candidate.frame;
        }
    }
    return values;
}
export async function readMacInstallerContext(file) {
    await trusted(file);
    const stat = await fs.lstat(file);
    if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
        throw new Error("Installer context is not private.");
    const value = JSON.parse(await text(file));
    if (value.schemaVersion !== 1 || !["none", "legacy", "electron"].includes(value.kind) ||
        typeof value.candidateSourceSha !== "string" || !/^[a-f0-9]{40}$/u.test(value.candidateSourceSha) || value.candidateTarget !== `darwin-${process.arch}` ||
        typeof value.wasRunning !== "boolean" || typeof value.loginEnabled !== "boolean" || typeof value.stopRequested !== "boolean" || typeof value.stopCompleted !== "boolean" ||
        !(value.ownerPid === null || Number.isSafeInteger(value.ownerPid) && value.ownerPid > 1) ||
        !(value.releaseDir === null || typeof value.releaseDir === "string" && path.isAbsolute(value.releaseDir)) ||
        (value.legacyShell !== undefined && (value.kind !== "legacy" || !validLegacyShell(value.legacyShell))))
        throw new Error("Invalid private installer context.");
    return value;
}
// Independent of the transient candidate-bound installer context. Only admitted
// legacy shutdown creates this one role-local, bounded GUI handoff.
async function retainLegacyShellPending(value) {
    let directory = installRoot;
    for (const component of ["state", "electron", "private-shell"]) {
        directory = path.join(directory, component);
        try {
            await fs.mkdir(directory, { mode: 0o700 });
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
        }
        await trusted(directory);
        const stat = await fs.lstat(directory);
        if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (component === "private-shell" && (stat.mode & 0o077) !== 0))
            throw new Error("GUI handoff directory is not owned/private.");
    }
    const file = path.join(directory, "legacy-shell-pending.json");
    let previous = null;
    if (await exists(file)) {
        await trusted(file);
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
            throw new Error("Unsafe pending GUI handoff.");
        const parsed = JSON.parse((await readBoundedNormalFile(file, { maxBytes: 2048, encoding: "utf8", label: "Pending GUI handoff" })).data);
        const { schemaVersion, ...preferences } = parsed;
        if (schemaVersion !== 1 || !validLegacyShell(preferences))
            throw new Error("Invalid pending GUI handoff.");
        // This producer runs only after a freshly admitted legacy predecessor exits.
        // Its latest GUI values supersede a failed attempt's older snapshot. An
        // Electron reinstall never calls this producer and keeps the pending record.
        previous = stat;
    }
    const temporary = path.join(directory, `.legacy-shell-${randomBytes(8).toString("hex")}`);
    try {
        const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
            await handle.writeFile(JSON.stringify({ schemaVersion: 1, ...value }) + "\n");
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        // Publish a normal single-link file atomically before exposing the app.
        if (previous) {
            await trusted(file);
            const current = await fs.lstat(file);
            if (!current.isFile() || current.nlink !== 1 || current.dev !== previous.dev || current.ino !== previous.ino ||
                current.uid !== previous.uid || (current.mode & 0o077) !== 0 || current.size !== previous.size ||
                current.mtimeMs !== previous.mtimeMs || current.ctimeMs !== previous.ctimeMs)
                throw new Error("Pending GUI handoff changed during refresh.");
        }
        else if (await exists(file))
            throw new Error("Pending GUI handoff appeared during capture.");
        await fs.rename(temporary, file);
    }
    finally {
        try {
            await fs.unlink(temporary);
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
    }
    const parent = await fs.open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        await parent.sync();
    }
    finally {
        await parent.close();
    }
}
// Shared finite primitives only. Each installer/preparer still owns its own
// role admission; exporting these does not admit a managed candidate as Source.
export { readLegacyShellPreferences as readLegacyMacShellPreferences, retainLegacyShellPending as retainLegacyMacShellPending, login as configureInstalledMacDesktopLogin };
async function login(mode) {
    const temporaryRoot = await fs.realpath(os.tmpdir());
    await trusted(temporaryRoot);
    const profile = await fs.mkdtemp(path.join(temporaryRoot, "equinox-installer-login-"));
    const owned = await fs.lstat(profile);
    let closed = true, failure, enabled = false;
    try {
        if (!owned.isDirectory() || owned.uid !== process.getuid?.() || (owned.mode & 0o777) !== 0o700)
            throw new Error("Installer login profile is not private.");
        const stdout = await new Promise((resolve, reject) => {
            // A minimal environment admits no Electron/Node/profile overrides.
            const env = { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: temporaryRoot };
            for (const key of ["USER", "LOGNAME", "LANG", "LC_ALL"])
                if (process.env[key])
                    env[key] = process.env[key];
            const child = spawn(executable, [`--installer-login=${mode}`, `--installer-profile=${profile}`], { env, cwd: home, stdio: ["ignore", "pipe", "pipe"] });
            closed = false;
            let output = "", bytes = 0, error = null, stopping = false, settled = false;
            let grace, final;
            const finish = (close, code) => {
                if (close)
                    closed = true;
                if (settled)
                    return;
                settled = true;
                clearTimeout(deadline);
                clearTimeout(grace);
                clearTimeout(final);
                if (error)
                    reject(error);
                else if (!close || code !== 0)
                    reject(new Error("Installer login helper did not close successfully."));
                else
                    resolve(output);
            };
            const stop = (reason) => {
                error ??= reason;
                if (stopping || closed)
                    return;
                stopping = true;
                try {
                    child.kill("SIGTERM");
                }
                catch (killError) {
                    error = new AggregateError([error, killError], "Installer helper termination failed.");
                }
                grace = setTimeout(() => {
                    try {
                        child.kill("SIGKILL");
                    }
                    catch (killError) {
                        error = new AggregateError([error, killError], "Installer helper kill failed.");
                    }
                    final = setTimeout(() => {
                        error = new AggregateError([error], "Installer helper close unconfirmed; private profile retained.");
                        child.stdout.destroy();
                        child.stderr.destroy();
                        child.unref();
                        finish(false);
                    }, 2_000);
                }, 2_000);
            };
            const deadline = setTimeout(() => stop(new Error("Installer login helper timed out.")), 20_000);
            child.on("error", value => stop(value));
            child.once("close", code => finish(true, code));
            for (const stream of [child.stdout, child.stderr]) {
                stream.on("error", value => stop(value));
                stream.on("data", (chunk) => {
                    bytes += chunk.length;
                    if (bytes > 64 * 1024)
                        stop(new Error("Installer login helper output exceeded its bound."));
                    else if (stream === child.stdout)
                        output += chunk.toString("utf8");
                });
            }
        });
        const result = JSON.parse(stdout);
        if (result.mode !== mode || typeof result.enabled !== "boolean" || ((mode === "cleanup" || mode === "disabled") && result.enabled) || (mode === "enabled" && !result.enabled))
            throw new Error("Application login readback failed.");
        enabled = result.enabled;
    }
    catch (error) {
        failure = error;
    }
    if (closed) {
        try {
            await trusted(profile);
            const current = await fs.lstat(profile);
            if (current.dev !== owned.dev || current.ino !== owned.ino || current.uid !== owned.uid || !current.isDirectory() ||
                current.isSymbolicLink() || (current.mode & 0o777) !== 0o700 || await fs.realpath(profile) !== profile)
                throw new Error("Installer login profile ownership changed; retaining it.");
            await fs.rm(profile, { recursive: true });
        }
        catch (error) {
            failure = failure ? new AggregateError([failure, error], "Installer login and profile cleanup failed.") : error;
        }
    }
    if (failure)
        throw failure;
    return enabled;
}
export async function assertMacInstallerStopped(contextFile, sourceSha, target) {
    if (process.platform !== "darwin" || !process.getuid?.())
        throw new Error("Current-user macOS installer required.");
    const context = await readMacInstallerContext(contextFile);
    if (!context.stopRequested || !context.stopCompleted || context.candidateSourceSha !== sourceSha || context.candidateTarget !== target) {
        throw new Error("Fresh macOS installation requires this candidate's stopped-owner context.");
    }
    if ((await owners()).length || await loaded() !== null)
        throw new Error("Fresh macOS installation requires observed owner/service exit.");
}
export async function preflightMacInstaller(contextFile, validateRelease) {
    if (process.platform !== "darwin" || !process.getuid?.())
        throw new Error("Current-user macOS installer required.");
    const candidate = await admitCandidate();
    await trusted(installRoot);
    const wrapper = path.join(installRoot, "equinox-local-app-runtime");
    // Source builders use the same app identity/path with a different wrapper and custom label.
    const expectedWrapper = appRuntimeWrapper({ installRoot });
    // Exact pre-Electron managed wrapper, before log redirection moved out of launchd.
    const legacyWrapper = expectedWrapper.replace("umask 077\n", "")
        .replace('exec >>"$HOME/Library/Logs/Equinox Local.log" 2>>"$HOME/Library/Logs/Equinox Local.error.log"\n', "");
    if (await exists(wrapper) && ![expectedWrapper, legacyWrapper].includes(await text(wrapper)))
        throw new Error("Source/Factory or foreign runtime wrapper; refusing managed replacement.");
    const agents = path.dirname(plist);
    if (await exists(agents)) {
        await trusted(agents);
        for (const name of await fs.readdir(agents)) {
            if (!name.endsWith(".plist"))
                continue;
            const file = path.join(agents, name);
            if (file === plist)
                continue; // Canonical Equinox entry is admitted strictly below.
            let identified = /^dev\.equinox\.local(?:[.-]|$)/iu.test(name);
            // Discovery is read-only and bounded, not an ownership assertion. Follow
            // third-party links only to ordinary files; never block on a FIFO/device.
            try {
                const handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK);
                try {
                    const stat = await handle.stat();
                    if (stat.isFile()) {
                        const buffer = Buffer.alloc(128 * 1024);
                        let bytes = 0;
                        while (bytes < buffer.length) {
                            const read = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
                            if (!read.bytesRead)
                                break;
                            bytes += read.bytesRead;
                        }
                        const content = buffer.subarray(0, bytes);
                        for (const reference of [app, wrapper]) {
                            const utf16 = Buffer.from(reference, "utf16le");
                            identified ||= content.includes(Buffer.from(reference)) || content.includes(utf16) || content.includes(Buffer.from(utf16).swap16());
                        }
                        if (stat.size <= buffer.length) {
                            try {
                                const stdout = await new Promise((resolve, reject) => {
                                    const converter = execCallback("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], options, (error, stdout) => error ? reject(error) : resolve(stdout));
                                    converter.stdin?.on("error", reject);
                                    converter.stdin?.end(content);
                                });
                                const parsed = JSON.stringify(JSON.parse(stdout));
                                identified ||= parsed.includes(app) || parsed.includes(wrapper);
                            }
                            catch { /* Unrelated malformed/unreadable discovery is not admission. */ }
                        }
                    }
                }
                finally {
                    await handle.close();
                }
            }
            catch { /* Discovery errors must not globally block unrelated agents. */ }
            // Inspect link text after the bounded open attempt, including dangling
            // links. This is discovery only, never a pathname precheck for opening.
            try {
                if ((await fs.lstat(file)).isSymbolicLink()) {
                    const target = await fs.readlink(file);
                    identified ||= target.includes(app) || target.includes(wrapper) || /^dev\.equinox\.local(?:[.-]|$)/iu.test(path.basename(target));
                }
            }
            catch { /* An unreadable link does not admit an unrelated job. */ }
            if (identified) {
                // All noncanonical identified entries are refused, including unsafe,
                // unreadable, oversized or malformed ones; none need a second open.
                throw new Error("Source/custom or unsafe Equinox LaunchAgent; refusing managed replacement.");
            }
        }
    }
    const hasPlist = await exists(plist);
    if (hasPlist && await text(plist) !== launchAgentPlist({ homeDir: home, installRoot }))
        throw new Error("Foreign or source LaunchAgent; refusing managed replacement.");
    const current = path.join(installRoot, "current");
    const hasCurrent = await exists(current);
    const appExists = await exists(app);
    let kind = "none", releaseDir = null;
    if (hasCurrent) {
        const stat = await fs.lstat(current);
        if (!stat.isSymbolicLink() || stat.uid !== process.getuid?.())
            throw new Error("Unowned current release pointer.");
        releaseDir = await fs.realpath(current);
        await trusted(releaseDir);
        const root = path.join(installRoot, "main-update");
        const target = `darwin-${process.arch}`;
        const relative = path.relative(path.join(root, "native-store", target), releaseDir).split(path.sep);
        if (relative.length === 2 && /^[a-f0-9]{40}$/u.test(relative[0]) && relative[1] === "release") {
            const sha = relative[0];
            const stored = await inspectEquinoxLocalMainNativeStoredRelease({ transactionRoot: root, sourceSha: sha, target });
            const pointer = await readEquinoxLocalMainNativePointer(path.join(root, "current-native.json"), { transactionRoot: root });
            const signed = validateTrustedMainInstallPointer(JSON.parse(await text(path.join(path.dirname(releaseDir), "signed-selector.json"))), { expectedSourceSha: sha });
            const row = signed.targets.find(row => row.target === target);
            if (pointer.releaseDir !== releaseDir || pointer.sourceSha !== sha || pointer.target !== target ||
                pointer.runtimeContractSha256 !== stored.runtimeContractSha256 || !row || signed.version !== stored.payloadVersion ||
                row.runtimeContractSha256 !== stored.runtimeContractSha256 || row.artifact.sha256 !== stored.manifest.artifactSha256 || row.artifact.bytes !== stored.manifest.artifactBytes)
                throw new Error("Installed signed Main ownership drifted.");
        }
        else if (path.dirname(releaseDir) !== path.join(installRoot, "releases"))
            throw new Error("Source/foreign current release.");
        await validateRelease(releaseDir);
        const native = await readEquinoxLocalNativeAppMetadata(releaseDir);
        kind = "kind" in native && native.kind === "electron" ? "electron" : "legacy";
        if (!appExists || !await exists(wrapper) || (kind === "legacy" && !hasPlist) || (kind === "electron" && hasPlist))
            throw new Error("Incomplete or ambiguous managed executable ownership.");
        await trusted(app);
        await assertEquinoxLocalFreshNativeAppHostOwned({ homeDir: home, releaseDir });
    }
    else if (appExists || hasPlist || await exists(wrapper) || await exists(path.join(installRoot, "main-update")) || await exists(path.join(installRoot, "releases")))
        throw new Error("Orphaned/ambiguous program roots; refusing replacement.");
    const running = await owners();
    const state = await loaded();
    if (state !== null) {
        if (kind !== "legacy")
            throw new Error("Unexpected loaded legacy service.");
        verifyLoaded(state);
    }
    if (kind === "none" && running.length)
        throw new Error("Unexpected installed owner.");
    let loginEnabled = true;
    if (kind === "legacy") {
        const { stdout } = await exec("/bin/launchctl", ["print-disabled", `gui/${process.getuid?.()}`], options);
        loginEnabled = !/^\s*"dev\.equinox\.local"\s*=>\s*(?:disabled|true)\s*;?\s*$/mu.test(stdout);
    }
    else if (kind === "electron")
        loginEnabled = await login("read");
    const legacyShell = kind === "legacy" ? await readLegacyShellPreferences() : undefined;
    await writeContext(contextFile, { schemaVersion: 1, candidateSourceSha: candidate.sourceSha, candidateTarget: candidate.target, kind, releaseDir, wasRunning: running.length > 0 || state !== null, ownerPid: running[0] ?? null, loginEnabled, stopRequested: false, stopCompleted: false, ...(legacyShell ? { legacyShell } : {}) }, true);
}
export async function macInstallerLifecycle(action, contextFile) {
    const context = await readMacInstallerContext(contextFile);
    if (action === "stop") {
        // Persist restart intent before sending anything: cancellation/lost acknowledgement is recoverable.
        context.stopRequested = true;
        context.stopCompleted = false;
        await writeContext(contextFile, context);
        const pids = await owners();
        if (context.kind === "electron") {
            if (pids.length) {
                const receipt = await requestDesktopUpdateShutdown({ homeDir: home });
                if (!("ownerPid" in receipt) || receipt.ownerPid !== pids[0])
                    throw new Error("Shutdown receipt is not the exact installed owner.");
                await waitExit(pids[0]);
            }
        }
        else if (context.kind === "legacy") {
            const state = await loaded();
            if (state !== null) {
                verifyLoaded(state);
                await exec("/bin/launchctl", ["bootout", service], options);
            }
            if (pids.length)
                await waitExit(pids[0]);
            if (await loaded() !== null)
                throw new Error("Legacy service stop was not observed.");
        }
        if ((await owners()).length)
            throw new Error("Installed owner still alive.");
        if (context.kind === "legacy") {
            // Re-read only the three already-admitted defaults after observed exit:
            // the predecessor can save its last frame/visibility during shutdown.
            context.legacyShell = await readLegacyShellPreferences();
            await retainLegacyShellPending(context.legacyShell);
        }
        context.stopCompleted = true;
        await writeContext(contextFile, context);
    }
    else if (action === "stop-replacement") {
        if (await exists(app)) {
            await trusted(app);
            await assertEquinoxLocalFreshNativeAppHostOwned({ homeDir: home, releaseDir: candidateRelease });
        }
        const pids = await owners();
        if (pids.length) {
            const receipt = context.kind === "electron" ? await requestDesktopUpdateShutdown({ homeDir: home }) : await requestDesktopUninstallShutdown({ homeDir: home });
            if (!("ownerPid" in receipt) || receipt.ownerPid !== pids[0])
                throw new Error("Replacement shutdown owner mismatch.");
            await waitExit(pids[0]);
        }
        // Legacy/fresh failure must unregister a newly created Electron login item,
        // even when startup failed before its socket existed. Never alter prior Electron preference.
        if (context.kind !== "electron" && await exists(executable))
            await login("cleanup");
        if ((await owners()).length)
            throw new Error("Replacement owner still alive.");
    }
    else if (action === "restart") {
        if (!context.stopRequested || !context.wasRunning)
            return;
        const pending = await owners();
        if (pending.length) {
            if (pending[0] !== context.ownerPid)
                throw new Error("Unexpected owner appeared during restoration.");
            // A lost socket acknowledgement may precede the actual Quit. Do not
            // mistake a still-draining predecessor for a successfully restarted app.
            await waitExit(pending[0]);
        }
        if (context.kind === "electron")
            await launchMacInstallerElectron(contextFile);
        else if (context.kind === "legacy") {
            if (await text(plist) !== launchAgentPlist({ homeDir: home, installRoot }))
                throw new Error("Restored plist mismatch.");
            const state = await loaded();
            if (state !== null)
                verifyLoaded(state);
            try {
                if (!context.loginEnabled)
                    await exec("/bin/launchctl", ["enable", service], options);
                if (state === null)
                    await exec("/bin/launchctl", ["bootstrap", `gui/${process.getuid?.()}`, plist], options);
                await exec("/bin/launchctl", ["kickstart", service], options);
            }
            finally {
                if (!context.loginEnabled)
                    await exec("/bin/launchctl", ["disable", service], options);
            }
        }
        // Reopen/bootstrap success alone is not an observed owner restart.
        for (let attempt = 0; attempt < 150; attempt++) {
            if ((await owners()).length)
                return;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error("Restored owner restart was not observed; retain private diagnostics.");
    }
    else
        throw new Error("Unknown finite installer lifecycle action.");
}
export async function launchMacInstallerElectron(contextFile) {
    const context = contextFile ? await readMacInstallerContext(contextFile) : null;
    // A finite, independently admitted helper applies login intent even if the
    // GUI was opened early and LaunchServices discards the later argv payload.
    if (!context || context.kind !== "electron") {
        const enabled = context?.loginEnabled !== false;
        if (await login(enabled ? "enabled" : "disabled") !== enabled)
            throw new Error("Installer login migration readback failed.");
    }
    await exec("/usr/bin/open", ["-g", app, "--args", "--startup"], options);
}
