import { constants } from "node:fs";
import fs from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
const execFile = promisify(execFileCallback);
const SHA = /^[a-f0-9]{40}$/u;
async function normalFile(file, { privateFile = false } = {}) {
    const stat = await fs.lstat(file);
    const real = await fs.realpath(file);
    const canonical = process.platform === "win32" ? real.toLowerCase() === file.toLowerCase() : real === file;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !canonical) {
        throw new Error("Runtime launch input is not a canonical normal file.");
    }
    if (process.platform === "darwin") {
        if (stat.uid !== process.getuid() || (stat.mode & (privateFile ? 0o077 : 0o022)) !== 0) {
            throw new Error("Runtime launch input ownership or permissions are invalid.");
        }
    }
}
async function pointer(file) {
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > 8192)
            throw new Error("Invalid native runtime pointer.");
        const buffer = Buffer.alloc(8193);
        let bytes = 0;
        while (bytes < buffer.length) {
            const result = await handle.read(buffer, bytes, buffer.length - bytes, null);
            if (!result.bytesRead)
                break;
            bytes += result.bytesRead;
        }
        if (bytes > 8192)
            throw new Error("Native runtime pointer exceeded its limit.");
        const value = JSON.parse(buffer.subarray(0, bytes).toString("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value))
            throw new Error("Invalid native runtime pointer.");
        const row = value;
        if (row.schemaVersion !== 1 || row.channel !== "main" || typeof row.sourceSha !== "string" || !SHA.test(row.sourceSha)
            || row.target !== `${process.platform}-${process.arch}`)
            throw new Error("Invalid native runtime identity.");
        return { sourceSha: row.sourceSha, target: row.target };
    }
    finally {
        await handle.close();
    }
}
/** Resolve only the installed application layout; no renderer-supplied command, root or environment. */
export async function resolveInstalledRuntime(identity, resourcesPath) {
    if (identity.role === "managed" && (!identity.sourceSha || !SHA.test(identity.sourceSha))) {
        throw new Error("An exact signed application source identity is required.");
    }
    if (process.platform === "darwin") {
        const home = os.homedir();
        const application = path.join(home, "Applications", "Equinox Local.app");
        if (process.execPath !== path.join(application, "Contents", "MacOS", "applet")
            || resourcesPath !== path.join(application, "Contents", "Resources"))
            throw new Error("Runtime owner is not the installed Equinox Local application.");
        await normalFile(process.execPath);
        const installRoot = path.join(home, "Library", "Application Support", "Equinox Local");
        if (identity.role === "managed") {
            const release = await fs.realpath(path.join(installRoot, "current"));
            const expected = path.join(installRoot, "main-update", "native-store", `darwin-${process.arch}`, identity.sourceSha, "release");
            if (release !== expected)
                throw new Error("Installed application and selected signed runtime differ.");
        }
        const wrapper = path.join(installRoot, "equinox-local-app-runtime");
        const helper = path.join(resourcesPath, "native", "equinox-local-process-session");
        await normalFile(wrapper, { privateFile: true });
        await normalFile(helper);
        const env = {
            HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin",
            EQUINOX_LOCAL_INSTALL_ROOT: installRoot, EQUINOX_LOCAL_NATIVE_PROCESS_HELPER: helper,
            EQUINOX_LOCAL_DESKTOP_OWNER: "1",
        };
        for (const key of ["USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "SSH_AUTH_SOCK"]) {
            if (process.env[key])
                env[key] = process.env[key];
        }
        return { command: wrapper, args: [], cwd: home, env };
    }
    if (process.platform !== "win32" || identity.role !== "managed")
        throw new Error("Unsupported installed runtime owner.");
    const programRoot = path.dirname(process.execPath);
    if (path.basename(process.execPath).toLowerCase() !== "equinoxlocal.exe"
        || path.basename(programRoot).toLowerCase() !== "equinox local"
        || path.basename(path.dirname(programRoot)).toLowerCase() !== "programs")
        throw new Error("Runtime owner is not in the installed Windows application layout.");
    const installRoot = path.join(path.dirname(path.dirname(programRoot)), "Equinox Local");
    const pointerPath = path.join(installRoot, "state", "main-update", "current-native.json");
    const selected = await pointer(pointerPath);
    if (selected.sourceSha !== identity.sourceSha)
        throw new Error("Installed application and native runtime SHA differ.");
    const env = {};
    for (const key of ["SystemRoot", "WINDIR", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP", "PATH", "PATHEXT", "COMSPEC", "USERNAME", "USERDOMAIN"]) {
        if (process.env[key])
            env[key] = process.env[key];
    }
    const guardian = path.join(installRoot, "runtime", "guardian", "EquinoxLocalGuardian.exe");
    await normalFile(guardian);
    // Preserve the original independent Ed25519/retained-ZIP/full-payload admission.
    await execFile(guardian, ["--audit-installed-signed-main"], {
        cwd: installRoot, env, windowsHide: true, timeout: 120_000, maxBuffer: 16 * 1024,
    });
    const confirmed = await pointer(pointerPath);
    if (confirmed.sourceSha !== selected.sourceSha || confirmed.target !== selected.target)
        throw new Error("Native runtime changed during admission.");
    const release = path.join(installRoot, "state", "main-update", "native-store", selected.target, selected.sourceSha, "release");
    const node = path.join(release, "runtime", "node", "bin", "node.exe");
    const gate = path.join(release, "equinox-local-windows-runtime-gate.mjs");
    const supervisor = path.join(release, "equinox-local-windows-runtime-supervisor.js");
    const server = path.join(release, "server.js");
    const jobModule = path.join(release, "equinox-local-windows-job-object.js");
    const helper = path.join(release, "runtime", "job", "equinox-local-job-object-helper.exe");
    for (const file of [node, gate, supervisor, server, jobModule, helper])
        await normalFile(file);
    const imported = await import(pathToFileURL(jobModule).href);
    if (typeof imported.createWindowsJobObjectLease !== "function")
        throw new Error("Native runtime Job Object ownership is unavailable.");
    env.EQUINOX_LOCAL_RELEASE_DIR = release;
    env.EQUINOX_LOCAL_INSTALL_ROOT = installRoot;
    env.EQUINOX_LOCAL_DESKTOP_OWNER = "1";
    env.EQUINOX_LOCAL_OWNED_PROCESS_SPEC = Buffer.from(JSON.stringify({ command: node, args: [supervisor, server] })).toString("base64");
    env.EQUINOX_LOCAL_OWNED_PROCESS_READY_MARKER = "EQUINOX_RUNTIME_CHILD_STARTED";
    const createLease = imported.createWindowsJobObjectLease;
    return {
        command: node, args: [gate], cwd: release, env, controlHelper: helper,
        createJob: () => createLease({ helperPath: helper }), readyMarker: "EQUINOX_RUNTIME_CHILD_STARTED",
    };
}
