import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { validateTrustedMainInstallPointer } from "../../src/equinox-local-main-install-pointer.js";
import { inspectEquinoxLocalMainNativeStoredRelease } from "../../src/equinox-local-main-native-state.js";
import { equinoxLocalManagedSourcePaths } from "../../src/equinox-local-managed-source-installation.js";
import { ELECTRON_DISTRIBUTIONS } from "../../src/equinox-local-runtime-versions.js";
import { inspectExtractedPinnedMacElectron } from "./inspect-extracted-electron-macos.mjs";
// Dormant installer-side admission. It never starts Electron or changes the
// selected Main native pointer; callers must already own the signed install
// transaction. Do not invoke from a source-checkout Factory runtime.
const execFile = promisify(execFileCallback);
const HOSTED_UI_ID = "dev.equinox.local.workspace-ui";
function isMissing(error) {
    return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
async function privateDirectory(directory, create = false) {
    if (create) {
        try {
            await fs.mkdir(directory, { mode: 0o700 });
        }
        catch (error) {
            if (error === null || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST")
                throw error;
        }
    }
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
        await fs.realpath(directory) !== directory) {
        throw new Error("Managed Electron UI runtime root is not canonical, private and user-owned.");
    }
}
async function signedUiIdentity(app) {
    await execFile("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], {
        timeout: 30_000, maxBuffer: 1024 * 1024,
    });
    const { stderr } = await execFile("/usr/bin/codesign", ["-dv", app], {
        timeout: 15_000, maxBuffer: 1024 * 1024,
    });
    if (!stderr.includes("Identifier=" + HOSTED_UI_ID) || !stderr.includes("Signature=adhoc")) {
        throw new Error("Managed Electron UI app signature or bundle identifier is not admitted.");
    }
}
const MIN_ABANDONED_LOCK_AGE_MS = 10 * 60_000;
async function recoverOwnedAbandonedLock({ lockPath, targetRoot, target, sourceSha, }) {
    // This operation must be requested by the original signed installer after
    // it establishes exclusive native install/repair ownership. A regular UI
    // launch or ordinary admission may never silently clear a lock.
    const file = await fs.open(lockPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    let stat;
    let owner;
    try {
        stat = await file.stat();
        if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 ||
            stat.size < 40 || stat.size > 512 || stat.uid !== process.getuid?.()) {
            throw new Error("Unknown Electron UI activation lock cannot be recovered.");
        }
        owner = JSON.parse(await file.readFile({ encoding: "utf8" }));
    }
    finally {
        await file.close();
    }
    if (!owner || typeof owner !== "object" ||
        !("schemaVersion" in owner) || owner.schemaVersion !== 1 ||
        !("target" in owner) || owner.target !== target ||
        !("sourceSha" in owner) || owner.sourceSha !== sourceSha ||
        !("nonce" in owner) || typeof owner.nonce !== "string" ||
        !/^[a-f0-9]{32}$/u.test(owner.nonce) ||
        !("pid" in owner) || !Number.isSafeInteger(owner.pid) ||
        owner.pid < 2 ||
        !("createdAt" in owner) || !Number.isSafeInteger(owner.createdAt) ||
        owner.createdAt > Date.now() ||
        Date.now() - owner.createdAt < MIN_ABANDONED_LOCK_AGE_MS ||
        Date.now() - stat.mtimeMs < MIN_ABANDONED_LOCK_AGE_MS) {
        throw new Error("Electron UI activation lock is not a confirmed abandoned owned lock.");
    }
    // An alive or inaccessible process is NEVER assumed dead (including PID
    // reuse). Confirm ESRCH rather than guessing from a stale timestamp.
    try {
        process.kill(owner.pid, 0);
        throw new Error("Electron UI activation lock owner still has a live PID.");
    }
    catch (error) {
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ESRCH") {
            throw error;
        }
    }
    const scratch = path.join(targetRoot, ".ui-stage-" + owner.nonce);
    const staged = await fs.lstat(scratch).catch((error) => {
        if (isMissing(error))
            return null;
        throw error;
    });
    if (staged)
        await privateDirectory(scratch);
    // Preserve unknown/raced locks: this inode is the one whose exact receipt
    // was authenticated from the original open descriptor.
    const current = await fs.lstat(lockPath);
    if (!current.isFile() || current.isSymbolicLink() ||
        current.ino !== stat.ino || current.dev !== stat.dev ||
        current.size !== stat.size || current.mtimeMs !== stat.mtimeMs) {
        throw new Error("Electron UI activation owner lock changed during recovery.");
    }
    if (staged)
        await fs.rm(scratch, { recursive: true, force: true });
    const unchanged = await fs.lstat(lockPath);
    if (unchanged.ino !== stat.ino || unchanged.dev !== stat.dev) {
        throw new Error("Electron UI activation owner lock changed during staged cleanup.");
    }
    await fs.unlink(lockPath);
}
// A codesign check alone is insufficient: ad-hoc signatures can be recreated
// for arbitrary content. Only an exact derived tree from the pinned signed
// ZIP may be reused. The digest covers names, modes, link targets and bytes.
async function fingerprintSignedUiTree(root) {
    await privateDirectory(root);
    const digest = createHash("sha256");
    const pending = [""];
    const rootReal = await fs.realpath(root);
    let entries = 0;
    let totalBytes = 0;
    const block = Buffer.alloc(1024 * 1024);
    while (pending.length > 0) {
        const relative = pending.pop();
        const folder = path.join(root, relative);
        const children = (await fs.readdir(folder)).sort();
        for (const name of children) {
            const next = relative ? relative + "/" + name : name;
            const absolute = path.join(folder, name);
            if (++entries > 5_000)
                throw new Error("Managed Electron UI tree exceeds the expected entry budget.");
            // Open first and classify from the SAME descriptor. A prior lstat
            // followed by open would admit a filename-swap race.
            let handle;
            try {
                handle = await fs.open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
            }
            catch (error) {
                if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ELOOP") {
                    throw error;
                }
                // O_NOFOLLOW intentionally refuses framework symlinks. Never open
                // their targets; record the exact relative link and contained target.
                const target = await fs.readlink(absolute);
                const resolved = await fs.realpath(absolute);
                if (!resolved.startsWith(rootReal + path.sep)) {
                    throw new Error("Managed Electron UI framework link escapes the owned tree.");
                }
                digest.update("L\0" + next + "\0" + target + "\0");
                continue;
            }
            try {
                const stat = await handle.stat();
                if (stat.isDirectory()) {
                    digest.update("D\0" + next + "\0" + (stat.mode & 0o777).toString(8) + "\0");
                    const unchanged = await fs.lstat(absolute);
                    if (!unchanged.isDirectory() || unchanged.isSymbolicLink() ||
                        unchanged.ino !== stat.ino || unchanged.dev !== stat.dev) {
                        throw new Error("Managed Electron UI directory changed while enumerating.");
                    }
                    pending.push(next);
                }
                else if (stat.isFile()) {
                    totalBytes += stat.size;
                    if (totalBytes > 1024 * 1024 * 1024) {
                        throw new Error("Managed Electron UI tree exceeds its content budget.");
                    }
                    digest.update("F\0" + next + "\0" + stat.size + "\0" +
                        (stat.mode & 0o777).toString(8) + "\0");
                    let offset = 0;
                    while (offset < stat.size) {
                        const { bytesRead } = await handle.read(block, 0, Math.min(block.length, stat.size - offset), offset);
                        if (bytesRead < 1)
                            throw new Error("Managed Electron UI content truncated during verification.");
                        digest.update(block.subarray(0, bytesRead));
                        offset += bytesRead;
                    }
                    if ((await handle.stat()).size !== stat.size) {
                        throw new Error("Managed Electron UI file grew during verification.");
                    }
                }
                else {
                    throw new Error("Managed Electron UI tree includes a special filesystem entry.");
                }
            }
            finally {
                await handle.close();
            }
        }
    }
    return digest.digest("hex");
}
// Production defaults enforce the pinned Ed25519 Main trust root and original
// immutable native-store manifest/tree fingerprint. Dependency overrides are
// only for disposable build-tool integration diagnostics.
export async function activateSignedMainMacElectronUi({ signedPointer, installerOptIn = false, recoverAbandonedLock = false, homeDir = os.homedir(), arch = process.arch, verifyPointerImpl = validateTrustedMainInstallPointer, inspectStoredImpl = inspectEquinoxLocalMainNativeStoredRelease, }) {
    if (installerOptIn !== true) {
        throw new Error("Managed Electron UI installation is disabled unless the signed installer explicitly opts in.");
    }
    if (process.platform !== "darwin" || process.getuid?.() === 0 ||
        !["arm64", "x64"].includes(arch) ||
        !path.isAbsolute(homeDir) || path.normalize(homeDir) !== homeDir) {
        throw new Error("Managed Electron UI activation requires a canonical macOS home and CPU target.");
    }
    const pointer = verifyPointerImpl(signedPointer);
    const target = "darwin-" + arch;
    const row = pointer.targets.find((candidate) => candidate.target === target);
    const sourceSha = pointer.sourceSha;
    if (!row || !/^[a-f0-9]{40}$/u.test(sourceSha)) {
        throw new Error("Signed Main selector does not authorize this Electron target and source SHA.");
    }
    const root = equinoxLocalManagedSourcePaths({ homeDir, platform: "darwin", arch }).mainTransactionRoot;
    await privateDirectory(root);
    const stored = await inspectStoredImpl({
        transactionRoot: root, target, sourceSha,
        expectedRuntimeContractSha256: row.runtimeContractSha256,
    });
    const releaseDir = path.join(root, "native-store", target, sourceSha, "release");
    if (stored.releaseDir !== releaseDir || stored.sourceSha !== sourceSha ||
        stored.target !== target ||
        stored.runtimeContractSha256 !== row.runtimeContractSha256 ||
        stored.manifest.artifactSha256 !== row.artifact.sha256 ||
        stored.manifest.artifactBytes !== row.artifact.bytes ||
        stored.manifest.payloadVersion !== pointer.version) {
        throw new Error("Signed Main immutable release differs from the authenticated selector.");
    }
    const sourceEntrypoint = path.join(releaseDir, "desktop", "electron", "main.cjs");
    const sourceHandle = await fs.open(sourceEntrypoint, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
        if (!(await sourceHandle.stat()).isFile())
            throw new Error("Signed Electron UI source entrypoint is not a normal file.");
    }
    finally {
        await sourceHandle.close();
    }
    const pinned = ELECTRON_DISTRIBUTIONS[target];
    if (!pinned)
        throw new Error("Signed Electron UI distribution is not pinned.");
    const archivePath = path.join(releaseDir, "runtime", "electron", pinned.filename);
    const uiRoot = path.join(root, "electron-ui");
    const targetRoot = path.join(uiRoot, target);
    await privateDirectory(uiRoot, true);
    await privateDirectory(targetRoot, true);
    const installedPath = path.join(targetRoot, sourceSha);
    const lockPath = path.join(targetRoot, ".activation.lock");
    const nonce = randomBytes(16).toString("hex");
    let lock;
    try {
        lock = await fs.open(lockPath, "wx", 0o600);
    }
    catch (error) {
        if (!recoverAbandonedLock || !error || typeof error !== "object" ||
            !("code" in error) || error.code !== "EEXIST")
            throw error;
        await recoverOwnedAbandonedLock({ lockPath, targetRoot, target, sourceSha });
        lock = await fs.open(lockPath, "wx", 0o600);
    }
    let scratch = null;
    try {
        await lock.writeFile(JSON.stringify({
            schemaVersion: 1, target, sourceSha, nonce, pid: process.pid, createdAt: Date.now(),
        }));
        await lock.sync();
        // There must be no overlapping Main install/update and no second UI
        // activation. A previous same-SHA tree is NOT overwritten or deleted.
        try {
            await fs.lstat(path.join(root, "active.json"));
            throw new Error("Main native transaction active; Electron UI admission is unavailable.");
        }
        catch (error) {
            if (!isMissing(error))
                throw error;
        }
        const previous = await fs.lstat(installedPath).catch((error) => {
            if (isMissing(error))
                return null;
            throw error;
        });
        if (previous && (!previous.isDirectory() || previous.isSymbolicLink())) {
            throw new Error("Existing Electron UI destination is not a normal directory.");
        }
        scratch = path.join(targetRoot, ".ui-stage-" + nonce);
        await fs.mkdir(scratch, { mode: 0o700 });
        const staged = await inspectExtractedPinnedMacElectron({
            archivePath, target, scratchRoot: scratch, stageHostedUi: true,
        });
        if (!staged.stagedPath || path.dirname(staged.stagedPath) !== scratch ||
            staged.hostedBundleIdentifier !== HOSTED_UI_ID) {
            throw new Error("Verified Electron UI was not staged at the admitted location.");
        }
        const expectedTree = await fingerprintSignedUiTree(staged.stagedPath);
        await privateDirectory(root);
        await privateDirectory(targetRoot);
        try {
            await fs.lstat(path.join(root, "active.json"));
            throw new Error("Main transaction began during Electron UI preparation.");
        }
        catch (error) {
            if (!isMissing(error))
                throw error;
        }
        const current = await fs.lstat(installedPath).catch((error) => {
            if (isMissing(error))
                return null;
            throw error;
        });
        if (previous && current && current.dev === previous.dev && current.ino === previous.ino) {
            // Exact SHA reinstall is idempotent ONLY if the installed content
            // matches a new derivation from the verified signed Main ZIP.
            await signedUiIdentity(path.join(installedPath, "Electron.app"));
            const actualTree = await fingerprintSignedUiTree(installedPath);
            if (actualTree !== expectedTree) {
                throw new Error("Existing Electron UI tree differs from signed Main; installer repair required.");
            }
        }
        else {
            if (current || previous) {
                throw new Error("Electron UI destination changed during admission; refusing overwrite.");
            }
            await fs.rename(staged.stagedPath, installedPath);
            try {
                await signedUiIdentity(path.join(installedPath, "Electron.app"));
                if (await fingerprintSignedUiTree(installedPath) !== expectedTree) {
                    throw new Error("Newly admitted Electron UI tree drifted after atomic placement.");
                }
            }
            catch (error) {
                // Only our newly admitted destination, under our exclusive owner lock.
                await fs.rm(installedPath, { recursive: true, force: true });
                throw error;
            }
        }
        const executablePath = path.join(installedPath, "Electron.app", "Contents", "MacOS", "Electron");
        return Object.freeze({ target, sourceSha, installedPath, executablePath });
    }
    finally {
        if (scratch)
            await fs.rm(scratch, { recursive: true, force: true });
        const inode = await lock.stat().catch(() => null);
        await lock.close();
        const current = await fs.lstat(lockPath).catch(() => null);
        if (current && inode && current.dev === inode.dev && current.ino === inode.ino) {
            await fs.rm(lockPath, { force: true });
        }
    }
}
