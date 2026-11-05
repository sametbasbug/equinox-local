import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
export function validCompanionOrigin(value) {
    if (!value || typeof value !== "object")
        return false;
    const point = value;
    return [point.x, point.y].every(n => typeof n === "number" && Number.isSafeInteger(n) && Math.abs(n) <= 100_000);
}
/** Role-local only. Never reads or writes legacy AppKit/Factory defaults. */
export function openShellPreferences(directory) {
    let values = {};
    let writable = false;
    const file = path.join(directory, "shell-preferences.json");
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    const normal = (stat) => stat.isFile() && stat.nlink === 1 && stat.size <= 8192
        && (process.platform === "win32" || (stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0));
    try {
        if (!path.isAbsolute(directory) || path.resolve(directory) !== directory)
            throw new Error("Invalid shell profile.");
        const missing = [];
        let existing = directory;
        for (;;) {
            try {
                fs.lstatSync(existing);
                break;
            }
            catch (error) {
                if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
                    throw error;
                missing.push(existing);
                existing = path.dirname(existing);
            }
        }
        if (fs.realpathSync(existing) !== existing)
            throw new Error("Unsafe shell profile.");
        for (let current = existing;; current = path.dirname(current)) {
            const ancestor = fs.lstatSync(current);
            if (!ancestor.isDirectory() || ancestor.isSymbolicLink()
                || (process.platform !== "win32" && (![0, process.getuid?.()].includes(ancestor.uid)
                    || ((ancestor.mode & 0o022) !== 0 && !(ancestor.uid === 0 && (ancestor.mode & 0o1000) !== 0)))))
                throw new Error("Unsafe shell profile ancestor.");
            if (current === path.dirname(current))
                break;
        }
        for (const entry of missing.reverse())
            fs.mkdirSync(entry, { mode: 0o700 });
        if (fs.realpathSync(directory) !== directory)
            throw new Error("Shell profile changed.");
        const profile = fs.lstatSync(directory);
        if (process.platform !== "win32" && (profile.uid !== process.getuid?.() || (profile.mode & 0o077) !== 0))
            throw new Error("Shell profile is not private.");
        try {
            const fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow | (fs.constants.O_NONBLOCK ?? 0));
            try {
                const opened = fs.fstatSync(fd);
                const before = fs.lstatSync(file);
                if (!normal(before) || before.isSymbolicLink())
                    throw new Error("Unsafe shell preferences.");
                if (!normal(opened) || before.ino !== opened.ino || before.dev !== opened.dev)
                    throw new Error("Shell preferences changed.");
                const buffer = Buffer.alloc(8193);
                let count = 0;
                while (count < buffer.length) {
                    const read = fs.readSync(fd, buffer, count, buffer.length - count, count);
                    if (!read)
                        break;
                    count += read;
                }
                const after = fs.fstatSync(fd);
                if (count > 8192 || count !== opened.size || !normal(after) || after.size !== opened.size
                    || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs)
                    throw new Error("Shell preferences changed or exceeded their bound.");
                const parsed = JSON.parse(buffer.subarray(0, count).toString("utf8"));
                if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
                    throw new Error("Invalid shell preferences.");
                const item = parsed;
                if (Object.keys(item).some(key => !["language", "companionVisible", "companionBounds"].includes(key))
                    || (item.language !== undefined && item.language !== "en" && item.language !== "tr")
                    || (item.companionVisible !== undefined && typeof item.companionVisible !== "boolean")
                    || (item.companionBounds !== undefined && !validCompanionOrigin(item.companionBounds)))
                    throw new Error("Invalid shell preferences.");
                values = parsed;
            }
            finally {
                fs.closeSync(fd);
            }
        }
        catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
                throw error;
        }
        writable = true;
    }
    catch { /* Optional presentation storage must not prevent runtime startup; never overwrite invalid storage. */ }
    return {
        available: () => writable,
        read: () => structuredClone(values),
        refresh() {
            const recovered = openShellPreferences(directory);
            writable = recovered.available();
            if (writable)
                values = recovered.read();
            return writable;
        },
        write(patch) {
            if (!writable)
                return false;
            const next = { ...values, ...patch };
            const temporary = path.join(directory, `.shell-preferences-${randomUUID()}.tmp`);
            try {
                if (fs.realpathSync(directory) !== directory)
                    throw new Error("Shell profile changed.");
                try {
                    if (!normal(fs.lstatSync(file)))
                        throw new Error("Unsafe preferences target.");
                }
                catch (error) {
                    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
                        throw error;
                }
                const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600);
                try {
                    fs.writeFileSync(fd, JSON.stringify(next) + "\n");
                    fs.fsyncSync(fd);
                }
                finally {
                    fs.closeSync(fd);
                }
                fs.renameSync(temporary, file);
                if (process.platform !== "win32") {
                    const parent = fs.openSync(directory, fs.constants.O_RDONLY | noFollow);
                    try {
                        fs.fsyncSync(parent);
                    }
                    finally {
                        fs.closeSync(parent);
                    }
                }
                const verified = openShellPreferences(directory);
                if (!verified.available() || JSON.stringify(verified.read()) !== JSON.stringify(next))
                    throw new Error("Preference persistence readback failed.");
                values = next;
                return true;
            }
            catch {
                writable = false;
                return false;
            }
            finally {
                try {
                    fs.unlinkSync(temporary);
                }
                catch { /* Only the owned temporary file. */ }
            }
        },
    };
}
