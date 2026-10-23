import fs from "node:fs/promises";
import path from "node:path";
import { sameWindowsStableShellTree, snapshotWindowsStableShellTree } from "./equinox-local-windows-stable-shell.js";
function hasCode(error, code) {
    return error !== null && typeof error === "object" && "code" in error && error.code === code;
}
const BACKUP_NAME = /^\.equinox-shell-backup-[1-9][0-9]*-[a-f0-9]{16}$/u;
const CANDIDATE_NAME = /^\.equinox-shell-(?:next|failed)-[1-9][0-9]*-[a-f0-9]{16}$/u;
async function normalDirectory(directory, { fsImpl, optional = false }) {
    try {
        const stat = await fsImpl.lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink())
            throw new Error(`Windows native swap directory is unsafe: ${directory}`);
        const real = await fsImpl.realpath(directory);
        if (path.normalize(real).toLowerCase() !== path.resolve(directory).toLowerCase()) {
            throw new Error(`Windows native swap directory is not canonical: ${directory}`);
        }
        return true;
    }
    catch (error) {
        if (optional && hasCode(error, "ENOENT"))
            return false;
        throw error;
    }
}
// This routine can run with no live WPF, Node update worker or named pipe.
// It deliberately does not rename, remove, launch or mark any update successful.
// An independent updater must separately prove the transaction journal,
// source pointer and Native Messaging registration before acting on its result.
export async function inspectEquinoxLocalWindowsNativeSwap({ programRoot, previousReleaseDir, targetReleaseDir, fsImpl = fs, } = {}) {
    for (const [label, value] of Object.entries({ programRoot, previousReleaseDir, targetReleaseDir })) {
        if (typeof value !== "string" || !path.isAbsolute(value) || path.normalize(value) !== value || /[\r\n\0]/u.test(value)) {
            throw new Error(`Windows native swap ${label} must be a canonical absolute path.`);
        }
    }
    // Paths are admitted above at runtime; their types do not grant ownership.
    const root = programRoot;
    const previousDir = previousReleaseDir;
    const targetDir = targetReleaseDir;
    const parent = path.dirname(root);
    if (path.basename(root).toLowerCase() !== "equinox local" ||
        path.basename(parent).toLowerCase() !== "programs" || parent === path.dirname(parent)) {
        throw new Error("Windows native swap requires the fixed Equinox Local program directory.");
    }
    if (root === previousDir || root === targetDir || previousDir === targetDir) {
        throw new Error("Windows native swap identities must be separate.");
    }
    await normalDirectory(parent, { fsImpl });
    const previousRoot = path.join(previousDir, "runtime", "shell");
    const targetRoot = path.join(targetDir, "runtime", "shell");
    await normalDirectory(previousRoot, { fsImpl });
    await normalDirectory(targetRoot, { fsImpl });
    const [previous, target] = await Promise.all([
        snapshotWindowsStableShellTree(previousRoot, { fsImpl }),
        snapshotWindowsStableShellTree(targetRoot, { fsImpl }),
    ]);
    if (!previous.some(({ relative }) => relative === "EquinoxLocal.exe") ||
        !target.some(({ relative }) => relative === "EquinoxLocal.exe") ||
        sameWindowsStableShellTree(previous, target)) {
        throw new Error("Windows native swap releases must contain distinct verified shell executables.");
    }
    const backupNames = [];
    const candidateNames = [];
    for (const entry of await fsImpl.readdir(parent, { withFileTypes: true })) {
        if (entry.name.startsWith(".equinox-shell-backup-")) {
            if (!BACKUP_NAME.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
                throw new Error("Windows native swap contains an unowned backup entry.");
            }
            backupNames.push(entry.name);
        }
        else if (entry.name.startsWith(".equinox-shell-next-") || entry.name.startsWith(".equinox-shell-failed-")) {
            if (!CANDIDATE_NAME.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
                throw new Error("Windows native swap contains an unsafe staged/failed candidate entry.");
            }
            candidateNames.push(entry.name);
        }
    }
    // Legacy swap files are not tied to a durable transaction token. If more
    // than one exists, never guess which backup a future supervisor should use.
    if (backupNames.length > 1 || candidateNames.length > 1) {
        throw new Error("Windows native swap inventory is ambiguous; manual audit required.");
    }
    const backupRoot = backupNames.length ? path.join(parent, backupNames[0]) : null;
    if (backupRoot) {
        await normalDirectory(backupRoot, { fsImpl });
        const foundBackup = await snapshotWindowsStableShellTree(backupRoot, { fsImpl, ignoreLegacyCache: true });
        if (!sameWindowsStableShellTree(foundBackup, previous)) {
            throw new Error("Windows native swap backup differs from the expected previous release.");
        }
    }
    let installed = null;
    if (await normalDirectory(root, { fsImpl, optional: true })) {
        installed = await snapshotWindowsStableShellTree(root, { fsImpl, ignoreLegacyCache: true });
    }
    const installedIdentity = installed === null ? "missing" : sameWindowsStableShellTree(installed, previous) ? "previous" :
        sameWindowsStableShellTree(installed, target) ? "target" : "unknown";
    // A staged or quarantined tree requires a durable transaction journal for
    // correct ownership; never auto-restore based on directory names alone.
    let status = "blocked";
    if (!candidateNames.length) {
        if (installedIdentity === "previous" && !backupRoot)
            status = "previous-intact";
        else if (installedIdentity === "target" && !backupRoot)
            status = "target-intact";
        else if (installedIdentity === "missing" && backupRoot)
            status = "previous-backup-ready";
        else if (installedIdentity === "target" && backupRoot)
            status = "target-with-previous-backup";
    }
    return Object.freeze({ status, installedIdentity, backupRoot, candidateCount: candidateNames.length });
}
