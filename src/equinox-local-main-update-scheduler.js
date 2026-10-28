import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { readBoundedNormalFile } from "./equinox-local-safe-file.js";
function hasErrorCode(error, code) {
    return error !== null && typeof error === "object" && "code" in error && error.code === code;
}
function errorProperty(error, property) {
    if (error !== null && typeof error === "object" && property in error) {
        return error[property];
    }
    return undefined;
}
import { equinoxLocalWindowsPowerShellPath } from "./equinox-local-platform.js";
import { requestWindowsShellMainUpdateHandoff } from "./equinox-local-windows-shell-control.js";
const execFile = promisify(execFileCallback);
const TRANSACTION_ID_PATTERN = /^main-[a-f0-9]{32}$/u;
const LABEL_PREFIX = "dev.equinox.local.main-update.";
const WINDOWS_WORKER_TOKEN_PATTERN = /^[a-f0-9]{64}$/u;
const WINDOWS_START_TICKS_PATTERN = /^[0-9]{1,19}$/u;
const MAX_WINDOWS_OWNERSHIP_BYTES = 8 * 1024;
const WINDOWS_PROCESS_IDENTITY_SCRIPT = [
    "$ErrorActionPreference='Stop'",
    "$p=Get-Process -Id ([int]$env:EQUINOX_LOCAL_CHECK_WORKER_PID) -ErrorAction SilentlyContinue",
    "if($null -eq $p){[Console]::Out.Write('missing');exit 0}",
    "$ticks=$p.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)",
    "if($ticks -ne $env:EQUINOX_LOCAL_CHECK_WORKER_TICKS){[Console]::Out.Write('mismatch');exit 0}",
    "try{$exe=$p.Path}catch{[Console]::Out.Write('unknown');exit 0}",
    "if($exe -ine $env:EQUINOX_LOCAL_CHECK_WORKER_NODE){[Console]::Out.Write('mismatch');exit 0}",
    "[Console]::Out.Write('running')",
].join(";");
function xml(value) {
    return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
function assertAbsolute(value, label, platform = process.platform) {
    const pathApi = platform === "win32" ? path.win32 : path.posix;
    if (typeof value !== "string" || !pathApi.isAbsolute(value) || /[\r\n\0]/u.test(value))
        throw new Error(label + " must be an absolute path.");
    return pathApi.resolve(value);
}
function assertTransactionId(value) {
    if (typeof value !== "string" || !TRANSACTION_ID_PATTERN.test(value))
        throw new Error("Main update transaction id is invalid.");
    return value;
}
export function mainUpdateLaunchdLabel(transactionId) {
    return `${LABEL_PREFIX}${assertTransactionId(transactionId).slice(5)}`;
}
export function windowsMainUpdateWorkerOwnershipPath(transactionRoot, transactionId) {
    const root = assertAbsolute(transactionRoot, "Main update transaction root", "win32");
    return path.win32.join(root, "handoff", assertTransactionId(transactionId) + ".windows-worker.json");
}
export function parseWindowsMainUpdateWorkerOwnership(value, { transactionId } = {}) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Windows Main worker ownership is invalid.");
    const record = value;
    const keys = Object.keys(value).sort();
    const expected = ["nodePath", "pid", "schemaVersion", "startTimeUtcTicks", "token", "transactionId"];
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]))
        throw new Error("Windows Main worker ownership contains missing or unsupported fields.");
    if (record.schemaVersion !== 1 || record.transactionId !== assertTransactionId(transactionId ?? record.transactionId))
        throw new Error("Windows Main worker ownership identity is invalid.");
    if (typeof record.pid !== "number" || !Number.isSafeInteger(record.pid) || record.pid < 1)
        throw new Error("Windows Main worker ownership PID is invalid.");
    if (typeof record.startTimeUtcTicks !== "string" || !WINDOWS_START_TICKS_PATTERN.test(record.startTimeUtcTicks))
        throw new Error("Windows Main worker ownership start identity is invalid.");
    if (typeof record.token !== "string" || !WINDOWS_WORKER_TOKEN_PATTERN.test(record.token))
        throw new Error("Windows Main worker ownership token is invalid.");
    const nodePath = assertAbsolute(record.nodePath, "Windows Main worker Node path", "win32");
    return Object.freeze({ ...value, nodePath });
}
export async function readWindowsMainUpdateWorkerOwnership({ transactionId, transactionRoot, fsImpl = fs } = {}) {
    const ownershipPath = windowsMainUpdateWorkerOwnershipPath(transactionRoot, transactionId);
    try {
        const file = await readBoundedNormalFile(ownershipPath, {
            fsImpl,
            platform: "win32",
            minBytes: 2,
            maxBytes: MAX_WINDOWS_OWNERSHIP_BYTES,
            encoding: "utf8",
            label: "Windows Main worker ownership",
        });
        return Object.freeze({
            ownershipPath,
            ownership: parseWindowsMainUpdateWorkerOwnership(JSON.parse(file.data), { transactionId }),
        });
    }
    catch (error) {
        if (hasErrorCode(error, "ENOENT"))
            return Object.freeze({ ownershipPath, ownership: null });
        throw error;
    }
}
export async function inspectWindowsMainUpdateWorkerProcess(ownership, { execFileImpl = execFile, nativeHelperPath = null } = {}) {
    const parsed = parseWindowsMainUpdateWorkerOwnership(ownership);
    // The managed updater runs with a deliberately restricted PATH. The OS
    // worker birth/PID check must use the fixed Windows SystemRoot path.
    const args = [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle", "Hidden",
        // Windows PowerShell 5.1 does not faithfully preserve the semicolons,
        // quotes and script blocks of raw -Command when started via execFile.
        // Use the same UTF-16LE -EncodedCommand contract as finite terminal_exec.
        "-EncodedCommand",
        Buffer.from(WINDOWS_PROCESS_IDENTITY_SCRIPT, "utf16le").toString("base64"),
    ];
    // Only a validated B release may supply this native helper path. Worker
    // admission uses direct Win32 process identity APIs, not a cold PowerShell
    // child that can stall under the detached WPF handoff environment.
    const useNative = nativeHelperPath !== null;
    if (useNative)
        assertAbsolute(nativeHelperPath, "Windows native identity helper", "win32");
    const options = {
        timeout: useNative ? 5_000 : 15_000, maxBuffer: 4 * 1024, windowsHide: true,
        // All untrusted identity values stay in validated environment fields;
        // never interpolate a PID, tick count or executable path into script.
        env: {
            ...process.env,
            EQUINOX_LOCAL_CHECK_WORKER_PID: String(parsed.pid),
            EQUINOX_LOCAL_CHECK_WORKER_TICKS: parsed.startTimeUtcTicks,
            EQUINOX_LOCAL_CHECK_WORKER_NODE: parsed.nodePath,
        },
    };
    let result;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            result = await execFileImpl(useNative ? nativeHelperPath : equinoxLocalWindowsPowerShellPath(), useNative ? ["--inspect-process"] : args, options);
            break;
        }
        catch (error) {
            // The native acceptance runners start a cold Windows PowerShell 5.1
            // under a busy freshly-installed WPF/Node process tree. Only an OS
            // launch TIMEOUT may be retried, once; never treat an inspection error
            // or uncertain process as an authenticated worker. Strip raw command
            // text (which includes EncodedCommand and executable paths) from the
            // durable failure receipt.
            if (!useNative && attempt === 0 && (hasErrorCode(error, "ETIMEDOUT") || errorProperty(error, "killed") === true))
                continue;
            const code = errorProperty(error, "code");
            const status = typeof code === "number" && Number.isInteger(code) ? String(code) :
                (code === "ETIMEDOUT" ? "timeout" : "spawn");
            const rawSignal = errorProperty(error, "signal");
            const signal = typeof rawSignal === "string" && /^[A-Z0-9]+$/u.test(rawSignal)
                ? rawSignal : "none";
            const stderrBytes = Buffer.byteLength(String(errorProperty(error, "stderr") ?? ""));
            throw new Error(`Windows native worker OS process inspection failed (status=${status};signal=${signal};stderrBytes=${stderrBytes};timeout=${errorProperty(error, "killed") === true || hasErrorCode(error, "ETIMEDOUT")}).`, { cause: error });
        }
    }
    const state = String(result?.stdout ?? "").trim();
    if (state === "running")
        return Object.freeze({ running: true, stale: false, uncertain: false });
    if (state === "missing" || state === "mismatch")
        return Object.freeze({ running: false, stale: true, uncertain: false });
    return Object.freeze({ running: false, stale: false, uncertain: true });
}
// Native OS witness only. This checks a specific installed WPF PID and birth
// identity against the *OS-derived* per-user install path, logon SID/LUID and
// session. It never confers journal authority, stops WPF or authorizes A/B.
export async function inspectWindowsOwnedWpfProcess(identity, { nativeHelperPath, execFileImpl = execFile, sourceEnv = process.env } = {}) {
    const value = identity !== null && typeof identity === "object" && !Array.isArray(identity)
        ? identity : null;
    if (!value || Object.keys(value).sort().join(",") !== "pid,startTimeUtcTicks" ||
        typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid < 1 || value.pid > 0xffffffff ||
        typeof value.startTimeUtcTicks !== "string" || !/^\d{15,19}$/u.test(value.startTimeUtcTicks)) {
        throw new Error("Windows WPF OS witness requires exact PID and process creation time.");
    }
    if (typeof nativeHelperPath !== "string" || !path.win32.isAbsolute(nativeHelperPath) ||
        path.win32.basename(nativeHelperPath).toLowerCase() !== "equinox-local-job-object-helper.exe" ||
        /[\r\n\0]/u.test(nativeHelperPath)) {
        throw new Error("Windows WPF OS witness requires the validated native release helper.");
    }
    const env = {
        SystemRoot: sourceEnv.SystemRoot,
        WINDIR: sourceEnv.WINDIR,
        USERPROFILE: sourceEnv.USERPROFILE,
        EQUINOX_LOCAL_CHECK_WPF_PID: String(value.pid),
        EQUINOX_LOCAL_CHECK_WPF_TICKS: value.startTimeUtcTicks,
    };
    let result;
    try {
        result = await execFileImpl(nativeHelperPath, ["--inspect-owned-wpf"], {
            timeout: 5_000, maxBuffer: 1024, windowsHide: true,
            env: Object.fromEntries(Object.entries(env).filter((entry) => typeof entry[1] === "string" && entry[1].length > 0)),
        });
    }
    catch {
        // Do not propagate inherited command, shell path or stderr into durable
        // Main update receipts; uncertainty is never a positive identity proof.
        throw new Error("Windows native WPF process witness failed; OS ownership is unverified.");
    }
    const state = String(result?.stdout ?? "").trim();
    if (state === "running")
        return Object.freeze({ running: true, stale: false, uncertain: false });
    if (state === "missing" || state === "mismatch")
        return Object.freeze({ running: false, stale: true, uncertain: false });
    return Object.freeze({ running: false, stale: false, uncertain: true });
}
export function mainUpdateWorkerEnvironment(sourceEnv = process.env) {
    const env = {
        HOME: sourceEnv.HOME,
        USER: sourceEnv.USER,
        LOGNAME: sourceEnv.LOGNAME,
        TMPDIR: sourceEnv.TMPDIR,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        EQUINOX_LOCAL_DEV_RUNTIME_CONFIG: sourceEnv.EQUINOX_LOCAL_DEV_RUNTIME_CONFIG,
        EQUINOX_LOCAL_DEV_NODE: sourceEnv.EQUINOX_LOCAL_DEV_NODE,
        // The native worker is a separate launchd job; without the managed
        // installation identity it resolves as a source checkout and refuses the
        // REAL artifact_required native lifecycle even though source-only Main
        // updates work. Pass only these non-secret, separately validated paths.
        EQUINOX_LOCAL_INSTALL_ROOT: sourceEnv.EQUINOX_LOCAL_INSTALL_ROOT,
        EQUINOX_LOCAL_RELEASE_DIR: sourceEnv.EQUINOX_LOCAL_RELEASE_DIR,
    };
    return Object.fromEntries(Object.entries(env).filter((entry) => typeof entry[1] === "string" && entry[1].length > 0));
}
export function renderMainUpdateLaunchdPlist({ label, nodePath, workerPath, sourceRoot, transactionRoot, transactionId, logPath, environment, signedNative = false }) {
    const args = signedNative
        ? [nodePath, workerPath, "--signed-native", "--transaction-id", transactionId, "--transaction-root", transactionRoot]
        : [nodePath, workerPath, "--transaction-id", transactionId, "--source-root", sourceRoot, "--transaction-root", transactionRoot];
    const envXml = Object.entries(environment).map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`).join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>${xml(label)}</string>\n  <key>ProgramArguments</key>\n  <array>\n${args.map((arg) => `    <string>${xml(arg)}</string>`).join("\n")}\n  </array>\n  <key>EnvironmentVariables</key>\n  <dict>\n${envXml}\n  </dict>\n  <key>RunAtLoad</key>\n  <true/>\n  <key>KeepAlive</key>\n  <false/>\n  <key>ProcessType</key>\n  <string>Background</string>\n  <key>StandardOutPath</key>\n  <string>${xml(logPath)}</string>\n  <key>StandardErrorPath</key>\n  <string>${xml(logPath)}</string>\n</dict>\n</plist>\n`;
}
export async function inspectEquinoxLocalMainUpdateWorkerOwnership({ transactionId, transactionRoot, platform = process.platform, uid = process.getuid?.(), fsImpl = fs, execFileImpl = execFile, readWindowsOwnershipImpl = readWindowsMainUpdateWorkerOwnership, inspectWindowsProcessImpl = inspectWindowsMainUpdateWorkerProcess, } = {}) {
    transactionId = assertTransactionId(transactionId);
    if (platform === "win32") {
        try {
            const record = await readWindowsOwnershipImpl({ transactionId, transactionRoot, fsImpl });
            if (!record?.ownership) {
                return Object.freeze({
                    loaded: false,
                    running: false,
                    stale: false,
                    uncertain: false,
                    platform: "win32",
                    ownershipPath: record?.ownershipPath ?? windowsMainUpdateWorkerOwnershipPath(transactionRoot, transactionId),
                });
            }
            const identity = await inspectWindowsProcessImpl(record.ownership, { execFileImpl });
            return Object.freeze({
                loaded: true,
                platform: "win32",
                ownershipPath: record.ownershipPath,
                ownership: record.ownership,
                ...identity,
            });
        }
        catch (error) {
            return Object.freeze({
                loaded: true,
                running: false,
                stale: false,
                uncertain: true,
                platform: "win32",
                reason: error instanceof Error ? error.message : String(error),
            });
        }
    }
    if (typeof uid !== "number" || !Number.isInteger(uid) || uid < 1)
        return Object.freeze({ loaded: false, running: false });
    const label = mainUpdateLaunchdLabel(transactionId);
    try {
        const result = await execFileImpl("/bin/launchctl", ["print", `gui/${uid}/${label}`], { timeout: 5_000, maxBuffer: 64 * 1024 });
        const output = String(result?.stdout ?? "");
        const running = /(?:^|\n)\s*state\s*=\s*running\s*(?:\n|$)/u.test(output);
        return Object.freeze({ loaded: true, running, label });
    }
    catch {
        return Object.freeze({ loaded: false, running: false, label });
    }
}
// A failed launchd bootstrap is NOT evidence of an absent worker. Only
// accept two explicit service-not-found responses (macOS exit 113) while
// successfully inspecting the user's actual GUI domain and service table,
// and with NO scheduled handoff plist. Every other outcome fails closed.
export async function assertEquinoxLocalSignedMacWorkerNeverStarted({ transactionId, transactionRoot, uid = process.getuid?.(), currentUid = process.getuid?.(), fsImpl = fs, execFileImpl = execFile, sleepImpl = async (ms) => new Promise(resolve => setTimeout(resolve, ms)), }) {
    const id = assertTransactionId(transactionId);
    const root = assertAbsolute(transactionRoot, "Signed native Main transaction root", "darwin");
    if (!Number.isSafeInteger(uid) || !uid || uid < 1 || uid !== currentUid) {
        throw new Error("Signed native worker absence can only be proven in the owning non-root launchd user session.");
    }
    const label = mainUpdateLaunchdLabel(id);
    const service = "gui/" + uid + "/" + label;
    const plist = path.join(root, "handoff", id + ".plist");
    const assertNoPlist = async () => {
        try {
            await fsImpl.lstat(plist);
            throw new Error("Signed native launchd handoff plist still exists; worker absence is not proven.");
        }
        catch (error) {
            if (!hasErrorCode(error, "ENOENT"))
                throw error;
        }
    };
    for (let attempt = 0; attempt < 2; attempt++) {
        await assertNoPlist();
        try {
            await execFileImpl("/bin/launchctl", ["print", service], {
                timeout: 5000, maxBuffer: 64 * 1024, encoding: "utf8",
            });
            throw new Error("Signed native launchd worker service is loaded; cancellation forbidden.");
        }
        catch (error) {
            const message = String(error?.stderr ?? "");
            if (error?.code !== 113 ||
                !message.includes("Could not find service") ||
                !message.includes('"' + label + '"') ||
                !message.includes("in domain for user gui: " + uid)) {
                throw new Error("Signed native launchd service status is not conclusively absent.");
            }
        }
        // A healthy gui domain probe plus a fully readable launchctl service
        // table is independent confirmation. No parse errors are absence.
        await execFileImpl("/bin/launchctl", ["print", "gui/" + uid], {
            timeout: 5000, maxBuffer: 64 * 1024, encoding: "utf8",
        });
        const { stdout } = await execFileImpl("/bin/launchctl", ["list"], {
            timeout: 5000, maxBuffer: 1024 * 1024, encoding: "utf8",
        });
        const lines = String(stdout ?? "").split(/\r?\n/u);
        if (lines[0] !== "PID\tStatus\tLabel" ||
            lines.slice(1).some(line => line.trim() && line.split("\t").length !== 3)) {
            throw new Error("Signed native launchd service table is not unambiguously readable.");
        }
        if (lines.slice(1).some(line => line.split("\t")[2] === label)) {
            throw new Error("Signed native launchd worker is listed; cancellation forbidden.");
        }
        await assertNoPlist();
        if (attempt === 0)
            await sleepImpl(250);
    }
    return Object.freeze({ absent: true, transactionId: id, label });
}
export async function cleanupEquinoxLocalMainUpdateWorkerOwnership({ transactionId, transactionRoot, platform = process.platform, uid = process.getuid?.(), fsImpl = fs, execFileImpl = execFile, ownershipToken = process.env.EQUINOX_LOCAL_MAIN_WORKER_TOKEN, inspectWorkerImpl = inspectEquinoxLocalMainUpdateWorkerOwnership, readWindowsOwnershipImpl = readWindowsMainUpdateWorkerOwnership, sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), } = {}) {
    transactionId = assertTransactionId(transactionId);
    const stateRoot = assertAbsolute(transactionRoot, "Main update transaction root", platform);
    if (platform === "win32") {
        // If the original signed Guardian's live HMAC/NTFS-file-ID session exists,
        // only THAT native owner may dispose of BOTH its kernel-pinned lease and
        // the authenticated Windows worker handoff. Never let Node unlink the
        // worker record before the Guardian can verify terminal A/B success.
        const sessionPath = path.win32.join(stateRoot, "guardian-journal", "." + transactionId + ".guardian-session-lock");
        const handoffPath = windowsMainUpdateWorkerOwnershipPath(stateRoot, transactionId);
        const exists = async (file) => {
            try {
                const stat = await fsImpl.lstat(file);
                if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
                    throw new Error("Signed native A/B owner left an unsafe terminal identity file.");
                return true;
            }
            catch (error) {
                if (hasErrorCode(error, "ENOENT"))
                    return false;
                throw error;
            }
        };
        if (typeof fsImpl.lstat === "function" && await exists(sessionPath)) {
            // The real detached worker remains alive while its Guardian polls the
            // fully committed/rolled-back Main+native receipt. Without this bounded
            // rendezvous it exits and leaves a permanent orphan session marker.
            for (let attempt = 0; attempt < 60; attempt += 1) {
                if (!await exists(sessionPath) && !await exists(handoffPath))
                    return Object.freeze({ cleaned: true, platform: "win32", nativeOwner: true, ownershipPath: handoffPath });
                if (attempt < 59)
                    await sleepImpl(200);
            }
            return Object.freeze({ cleaned: false, platform: "win32", pendingNativeOwner: true, ownershipPath: handoffPath });
        }
        const record = await readWindowsOwnershipImpl({ transactionId, transactionRoot: stateRoot, fsImpl });
        if (!record?.ownership) {
            return Object.freeze({
                cleaned: true,
                platform: "win32",
                ownershipPath: record?.ownershipPath ?? windowsMainUpdateWorkerOwnershipPath(stateRoot, transactionId),
            });
        }
        if (typeof ownershipToken === "string"
            && WINDOWS_WORKER_TOKEN_PATTERN.test(ownershipToken)
            && record.ownership.token === ownershipToken) {
            await fsImpl.rm(record.ownershipPath, { force: true });
            return Object.freeze({ cleaned: true, owner: true, platform: "win32", ownershipPath: record.ownershipPath });
        }
        const inspected = await inspectWorkerImpl({
            transactionId,
            transactionRoot: stateRoot,
            platform: "win32",
            fsImpl,
            execFileImpl,
        });
        if (inspected?.running)
            return Object.freeze({ cleaned: false, running: true, platform: "win32", ownershipPath: record.ownershipPath });
        if (inspected?.uncertain)
            return Object.freeze({ cleaned: false, uncertain: true, platform: "win32", ownershipPath: record.ownershipPath });
        await fsImpl.rm(record.ownershipPath, { force: true });
        return Object.freeze({ cleaned: true, stale: true, platform: "win32", ownershipPath: record.ownershipPath });
    }
    if (typeof uid !== "number" || !Number.isInteger(uid) || uid < 1)
        return Object.freeze({ cleaned: false });
    const label = mainUpdateLaunchdLabel(transactionId);
    const plistPath = path.join(stateRoot, "handoff", `${transactionId}.plist`);
    await execFileImpl("/bin/launchctl", ["bootout", `gui/${uid}/${label}`], { timeout: 5_000, maxBuffer: 64 * 1024 }).catch(() => { });
    await fsImpl.rm(plistPath, { force: true }).catch(() => { });
    return Object.freeze({ cleaned: true, label, plistPath });
}
export async function scheduleEquinoxLocalMainUpdateWorker({ transactionId, sourceRoot, transactionRoot, platform = process.platform, nodePath = process.env.EQUINOX_LOCAL_DEV_NODE || process.execPath, workerPath = path.join(sourceRoot ?? "", "src", "equinox-local-main-update-worker.js"), signedNative = false, sourceSha, target, sourceEnv = process.env, uid = process.getuid?.(), fsImpl = fs, execFileImpl = execFile, requestWindowsHandoffImpl = requestWindowsShellMainUpdateHandoff, } = {}) {
    transactionId = assertTransactionId(transactionId);
    const root = assertAbsolute(sourceRoot, "Main update source root", platform);
    const stateRoot = assertAbsolute(transactionRoot, "Main update transaction root", platform);
    const worker = assertAbsolute(workerPath, "Main update worker", platform);
    const workerStat = await fsImpl.lstat(worker);
    if (!workerStat.isFile() || workerStat.isSymbolicLink())
        throw new Error("Main update worker executable/source is unsafe.");
    if (signedNative) {
        // The same launcher services the signed native-only update, but its B
        // worker+Node must come from one exact immutable target SHA store; a
        // source checkout or ambient Node cannot schedule this privileged job.
        if (platform !== "darwin" || !/^darwin-(arm64|x64)$/u.test(target ?? "") ||
            !/^[a-f0-9]{40}$/u.test(sourceSha ?? "") ||
            stateRoot !== path.posix.join(sourceEnv.HOME ?? "", "Library", "Application Support", "Equinox Local", "main-update") ||
            root !== path.posix.join(stateRoot, "native-store", target, sourceSha, "release") ||
            worker !== path.posix.join(root, "equinox-local-main-update-worker.js") ||
            nodePath !== path.posix.join(root, "runtime", "node", "bin", "node")) {
            throw new Error("Signed native Main scheduler requires the exact packaged immutable B release.");
        }
        if (await fsImpl.realpath(root) !== root || await fsImpl.realpath(worker) !== worker) {
            throw new Error("Signed native Main scheduler release directory is not canonical.");
        }
    }
    if (platform === "win32") {
        const handoff = await requestWindowsHandoffImpl(transactionId, { platform: "win32" });
        return Object.freeze({ scheduled: true, platform: "win32", transactionId, handoff });
    }
    if (platform !== "darwin")
        throw new Error("Main update worker handoff is unsupported on this platform.");
    const node = assertAbsolute(nodePath, "Main update Node runtime", platform);
    if (typeof uid !== "number" || !Number.isInteger(uid) || uid < 1)
        throw new Error("A non-root user id is required to schedule main update handoff.");
    if (typeof execFileImpl !== "function")
        throw new Error("Main update launchd scheduler requires an exec function.");
    const nodeStat = await fsImpl.lstat(node);
    if (!nodeStat.isFile() || nodeStat.isSymbolicLink())
        throw new Error("Main update worker executable/source is unsafe.");
    if (signedNative && await fsImpl.realpath(node) !== node) {
        throw new Error("Signed native Main scheduler runtime Node is not canonical.");
    }
    const schedulerRoot = path.join(stateRoot, "handoff");
    await fsImpl.mkdir(schedulerRoot, { recursive: true, mode: 0o700 });
    const schedulerReal = await fsImpl.realpath(schedulerRoot);
    if (schedulerReal !== schedulerRoot)
        throw new Error("Main update handoff directory is unsafe.");
    const label = mainUpdateLaunchdLabel(transactionId);
    const plistPath = path.join(schedulerRoot, `${transactionId}.plist`);
    const logPath = path.join(schedulerRoot, `${transactionId}.log`);
    const allowed = mainUpdateWorkerEnvironment(sourceEnv);
    const environment = signedNative
        ? Object.fromEntries(Object.entries(allowed).filter(([name]) => ["HOME", "USER", "LOGNAME", "TMPDIR", "PATH"].includes(name)))
        : allowed;
    const plist = renderMainUpdateLaunchdPlist({ label, nodePath: node, workerPath: worker, sourceRoot: root, transactionRoot: stateRoot, transactionId, logPath, environment, signedNative });
    const handle = await fsImpl.open(plistPath, "wx", 0o600);
    try {
        await handle.writeFile(plist, "utf8");
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    let bootstrapped = false;
    try {
        await execFileImpl("/bin/launchctl", ["bootstrap", `gui/${uid}`, plistPath], { timeout: 10_000, maxBuffer: 64 * 1024 });
        bootstrapped = true;
        await execFileImpl("/bin/launchctl", ["print", `gui/${uid}/${label}`], { timeout: 5_000, maxBuffer: 64 * 1024 });
    }
    catch (error) {
        if (bootstrapped)
            await execFileImpl("/bin/launchctl", ["bootout", `gui/${uid}/${label}`], { timeout: 5_000, maxBuffer: 64 * 1024 }).catch(() => { });
        await fsImpl.rm(plistPath, { force: true }).catch(() => { });
        throw error;
    }
    return Object.freeze({ scheduled: true, label, plistPath, logPath });
}
