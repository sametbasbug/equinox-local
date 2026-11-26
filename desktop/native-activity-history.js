import { safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
const MAX_ITEMS = 240;
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_AGE = 30 * 24 * 60 * 60_000;
const routePattern = /^\/(?:g\/[A-Za-z0-9_-]{8,160}\/)?c\/([A-Za-z0-9-]{8,160})\/?$/u;
// Terminal results only, with the exact already-verified invocation identity.
// Never interpret the projected text as an executable or instruction.
function validated(pathname, input) {
    const route = routePattern.exec(pathname);
    if (!route || !input || typeof input !== "object" || Array.isArray(input))
        return null;
    const { owner, id, signature } = input;
    if (typeof owner !== "string" || owner.length > 1000 || typeof id !== "string" || !id || id.length > 200 ||
        /[\x00-\x1f\x7f]/u.test(id) || typeof signature !== "string" || Buffer.byteLength(signature, "utf8") > 300_000)
        return null;
    try {
        const keys = JSON.parse(owner);
        if (!Array.isArray(keys) || keys.length !== 4 || keys[0] !== route[1] || keys[1] !== keys[3] ||
            keys.some(v => typeof v !== "string" || !v || v.length > 200 || /[\x00-\x1f\x7f]/u.test(v)))
            return null;
        const d = JSON.parse(signature);
        if (!d || d.operation !== "terminal_exec" || !["success", "complete", "failed", "cancelled", "background"].includes(String(d.state)) ||
            typeof d.command !== "string" || !d.command || d.command.length > 12000 ||
            !["stdout", "stderr", "result", "error"].every(k => typeof d[k] === "string" && String(d[k]).length <= 24000) ||
            typeof d.truncated !== "boolean" ||
            !(d.exit === null || Number.isSafeInteger(d.exit)) ||
            !(d.duration === null || (typeof d.duration === "number" && Number.isFinite(d.duration) && d.duration >= 0)))
            return null;
        return { owner, id, signature: JSON.stringify({ operation: d.operation, state: d.state, command: d.command,
                stdout: d.stdout, stderr: d.stderr, result: d.result, error: d.error, truncated: d.truncated, exit: d.exit, duration: d.duration }) };
    }
    catch {
        return null;
    }
}
/** Role-local opt-in encrypted cache. Unavailable encryption or invalid
 * storage disables persistence, never the live native activity timeline. */
export function createNativeActivityHistory(directory, initialEnabled) {
    const file = path.join(directory, "native-command-history.enc");
    let enabled = false, failed = false, epoch = 0, nextPruneAt = 0;
    let available = process.platform === "darwin" || process.platform === "win32";
    let tail = Promise.resolve();
    function enqueue(action) {
        const work = tail.then(action);
        tail = work.catch(() => { });
        return work;
    }
    let records = [];
    const privateDirectory = () => {
        if (fs.realpathSync(directory) !== directory)
            throw new Error("Unsafe history directory.");
        const stat = fs.lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== "win32" &&
            (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)))
            throw new Error("History directory is not private.");
    };
    const checkFile = () => {
        privateDirectory();
        try {
            const stat = fs.lstatSync(file);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
                (process.platform !== "win32" && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)))
                throw new Error("Unsafe history file.");
            return stat;
        }
        catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT")
                return null;
            throw error;
        }
    };
    function prune() {
        const cutoff = Date.now() - MAX_AGE;
        nextPruneAt = Date.now() + 60 * 60_000;
        records = records.filter(x => x.at >= cutoff && x.at <= Date.now() + 60_000).sort((a, b) => a.at - b.at).slice(-MAX_ITEMS);
        // Bound size without serializing the entire array for each evicted record.
        let bytes = 2 + records.reduce((n, x) => n + Buffer.byteLength(JSON.stringify(x), "utf8") + 1, 0);
        while (records.length && bytes > MAX_BYTES)
            bytes -= Buffer.byteLength(JSON.stringify(records.shift()), "utf8") + 1;
    }
    async function persist() {
        prune();
        checkFile();
        const temporary = path.join(directory, ".native-command-history-" + randomUUID() + ".tmp");
        try {
            const encrypted = await safeStorage.encryptStringAsync(JSON.stringify(records));
            checkFile();
            const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
            try {
                fs.writeFileSync(fd, encrypted);
                fs.fsyncSync(fd);
            }
            finally {
                fs.closeSync(fd);
            }
            fs.renameSync(temporary, file);
        }
        finally {
            try {
                fs.unlinkSync(temporary);
            }
            catch { /* only owned temporary */ }
        }
    }
    function clearFile() {
        if (checkFile())
            fs.unlinkSync(file);
        records = [];
        failed = false;
    }
    async function activate() {
        available = await safeStorage.isAsyncEncryptionAvailable();
        if (!available)
            throw new Error("OS encryption is unavailable.");
        const stat = checkFile();
        records = [];
        if (stat) {
            if (stat.size < 1 || stat.size > MAX_BYTES + 65536)
                throw new Error("Invalid encrypted command history.");
            const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
            let encrypted;
            try {
                const opened = fs.fstatSync(fd);
                if (!opened.isFile() || opened.ino !== stat.ino || opened.size !== stat.size || opened.nlink !== 1)
                    throw new Error("History changed.");
                encrypted = fs.readFileSync(fd);
            }
            finally {
                fs.closeSync(fd);
            }
            const decrypted = await safeStorage.decryptStringAsync(encrypted);
            const parsed = JSON.parse(decrypted.result);
            if (!Array.isArray(parsed) || parsed.length > MAX_ITEMS)
                throw new Error("Invalid command history.");
            records = parsed.flatMap((x) => {
                const item = typeof x?.pathname === "string" ? validated(x.pathname, x) : null;
                return item && Number.isSafeInteger(x.at) ? [{ ...item, pathname: x.pathname, at: x.at }] : [];
            });
            const before = parsed.length;
            prune();
            if (records.length !== before || decrypted.shouldReEncrypt)
                await persist();
        }
        enabled = true;
        failed = false;
    }
    const ready = initialEnabled ? enqueue(async () => { try {
        await activate();
    }
    catch {
        failed = true;
        enabled = false;
        records = [];
    } }) : Promise.resolve();
    const currentRecords = () => records.filter(x => x.at >= Date.now() - MAX_AGE);
    return {
        ready: () => ready,
        epoch: () => epoch,
        status: () => ({ enabled, available: available && !failed, count: currentRecords().length }),
        setEnabled(value) {
            epoch++;
            return enqueue(async () => {
                if (value) {
                    if (!enabled || failed)
                        await activate();
                }
                else {
                    enabled = false;
                    clearFile();
                }
            });
        },
        clear() {
            epoch++;
            return enqueue(async () => clearFile());
        },
        read(pathname) {
            if (!enabled || failed || !routePattern.test(pathname))
                return [];
            return currentRecords().filter(x => x.pathname === pathname).map(({ owner, id, signature }) => ({ owner, id, signature }));
        },
        merge(pathname, input, expectedEpoch) {
            if (!enabled || failed || expectedEpoch !== epoch || !Array.isArray(input) || input.length > 32 ||
                (!input.length && Date.now() < nextPruneAt))
                return Promise.resolve();
            return enqueue(async () => {
                if (!enabled || failed || expectedEpoch !== epoch)
                    return;
                const before = records.length;
                if (Date.now() >= nextPruneAt)
                    prune();
                let changed = before !== records.length;
                for (const raw of input) {
                    const item = validated(pathname, raw);
                    if (!item)
                        continue;
                    const previous = records.find(x => x.pathname === pathname && x.owner === item.owner && x.id === item.id);
                    if (previous?.signature === item.signature)
                        continue;
                    if (previous)
                        previous.signature = item.signature;
                    else
                        records.push({ ...item, pathname, at: Date.now() });
                    changed = true;
                }
                if (changed)
                    try {
                        await persist();
                    }
                    catch {
                        failed = true;
                    }
            });
        },
    };
}
