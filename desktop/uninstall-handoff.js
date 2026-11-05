import { spawn } from "node:child_process";
import path from "node:path";
const READY = Buffer.from("EQUINOX_UNINSTALL_READY\n");
const GO = "EQUINOX_UNINSTALL_GO\n";
// The existing native uninstall acknowledgement window is three seconds.
const START_TIMEOUT_MS = 2_000;
const CLOSE_TIMEOUT_MS = 2_000;
export class UninstallCleanupError extends Error {
    constructor(cause) {
        super("Owned uninstall helper exit could not be verified.", { cause });
        this.name = "UninstallCleanupError";
    }
}
/** Only the admitted Windows uninstall helper; never an arbitrary command bridge. */
export async function prepareWindowsUninstallHandoff(launch, options) {
    if (process.platform !== "win32" || !Number.isSafeInteger(options.ownerPid)
        || options.ownerPid < 1 || options.ownerPid !== process.pid
        || typeof options.removeUserData !== "boolean" || !options.expectedStartupCommand
        || /[\r\n\0]/u.test(options.expectedStartupCommand)) {
        throw new Error("Invalid Windows uninstall handoff owner or options.");
    }
    const env = {};
    for (const key of ["SystemRoot", "WINDIR", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP",
        "EQUINOX_LOCAL_RELEASE_DIR", "EQUINOX_LOCAL_INSTALL_ROOT"]) {
        if (launch.env[key])
            env[key] = launch.env[key];
    }
    env.EQUINOX_LOCAL_UNINSTALL_SHELL_PID = String(options.ownerPid);
    env.EQUINOX_LOCAL_EXPECTED_STARTUP_COMMAND = options.expectedStartupCommand;
    const child = spawn(launch.command, [path.join(launch.cwd, "equinox-local-uninstall-helper.js"),
        "--uninstall", options.removeUserData ? "--remove-user-data" : "--preserve-user-data",
        "--wait-for-desktop-release"], {
        cwd: launch.cwd, env, shell: false, windowsHide: true, detached: true,
        stdio: ["pipe", "pipe", "ignore"],
    });
    let closed = false;
    let spawned = false;
    let failure;
    let failStartup;
    const close = new Promise((resolve) => child.once("close", () => {
        closed = true;
        failStartup?.(new Error("Uninstall helper closed before handoff."));
        resolve();
    }));
    // Keep asynchronous transport/process errors handled for the entire ownership lifetime.
    const onError = (error) => { failure = error; failStartup?.(error); };
    child.on("error", onError);
    child.stdin.on("error", onError);
    child.stdout.on("error", onError);
    const waitClose = async () => {
        if (closed)
            return true;
        let timer;
        try {
            return await Promise.race([close.then(() => true), new Promise((resolve) => {
                    timer = setTimeout(() => resolve(false), CLOSE_TIMEOUT_MS);
                })]);
        }
        finally {
            clearTimeout(timer);
        }
    };
    const stop = async () => {
        try {
            child.stdin.destroy();
            child.stdout.destroy();
            if (await waitClose())
                return;
            // ChildProcess.kill targets only this owned child, never a PID/tree lookup.
            child.kill("SIGKILL");
            if (!await waitClose())
                throw new Error("Owned uninstall helper did not close.");
        }
        catch (error) {
            throw new UninstallCleanupError(error);
        }
    };
    try {
        await new Promise((resolve, reject) => {
            let received = Buffer.alloc(0);
            let ready = false;
            const timer = setTimeout(() => finish(new Error("Uninstall helper readiness timed out.")), START_TIMEOUT_MS);
            const finish = (error) => {
                clearTimeout(timer);
                failStartup = undefined;
                child.stdout.off("data", onData);
                child.stdout.off("end", onEnd);
                child.off("spawn", onSpawn);
                if (error)
                    reject(error);
                else
                    resolve();
            };
            const onSpawn = () => { spawned = true; if (ready)
                finish(); };
            const onEnd = () => finish(new Error("Uninstall helper readiness stream ended."));
            const onData = (chunk) => {
                if (received.length + chunk.length > READY.length) {
                    finish(new Error("Invalid uninstall helper readiness."));
                    return;
                }
                received = Buffer.concat([received, chunk]);
                if (!READY.subarray(0, received.length).equals(received)) {
                    finish(new Error("Invalid uninstall helper readiness."));
                    return;
                }
                ready = received.length === READY.length;
                if (ready && spawned)
                    finish();
            };
            failStartup = (error) => finish(error);
            child.once("spawn", onSpawn);
            child.stdout.on("data", onData);
            child.stdout.once("end", onEnd);
        });
        if (failure || closed)
            throw failure ?? new Error("Uninstall helper exited during preparation.");
    }
    catch (error) {
        await stop();
        throw error;
    }
    let state = "prepared";
    let serial = Promise.resolve();
    const serialize = (action) => {
        const result = serial.then(action);
        serial = result.catch(() => { });
        return result;
    };
    return {
        release: () => serialize(async () => {
            if (state === "released")
                return;
            if (state === "cancelled")
                throw new Error("Uninstall handoff was cancelled.");
            try {
                if (failure || closed)
                    throw failure ?? new Error("Uninstall helper already exited.");
                await new Promise((resolve, reject) => {
                    const timer = setTimeout(() => done(new Error("Uninstall release write timed out.")), CLOSE_TIMEOUT_MS);
                    const done = (error) => {
                        clearTimeout(timer);
                        child.stdin.off("error", done);
                        if (error)
                            reject(error);
                        else
                            resolve();
                    };
                    child.stdin.once("error", done);
                    child.stdin.write(GO, done);
                });
                if (failure)
                    throw failure;
                state = "released";
                child.stdin.end(() => child.stdin.destroy());
                child.stdout.destroy();
                child.unref();
            }
            catch (error) {
                state = "cancelled";
                await stop();
                throw error;
            }
        }),
        cancel: () => serialize(async () => {
            if (state === "released")
                return;
            state = "cancelled";
            await stop();
        }),
    };
}
