import { execFile as execFileCallback } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { inspectPinnedElectronZip } from "./inspect-pinned-electron-zip.mjs";
// Build-time extraction observation, never an installer or application launch.
// Retains the original signed Main tree's global no-symlink rule. The caller
// supplies a private scratch root; all extracted files are deleted on return.
const execFile = promisify(execFileCallback);
const MAX_ENTRIES = 5_000;
const MAX_UNPACKED_BYTES = 1024 * 1024 * 1024;
const HOSTED_UI_ID = "dev.equinox.local.workspace-ui";
export async function inspectExtractedPinnedMacElectron({ archivePath, target, scratchRoot, inspectHostedIdentity = false, stageHostedUi = false, }) {
    if (process.platform !== "darwin" ||
        (target !== "darwin-arm64" && target !== "darwin-x64") ||
        !path.isAbsolute(archivePath) || !path.isAbsolute(scratchRoot)) {
        throw new Error("Electron native ZIP extraction inspection supports only isolated macOS targets.");
    }
    const scratchStat = await fs.lstat(scratchRoot);
    if (!scratchStat.isDirectory() || scratchStat.isSymbolicLink() ||
        (scratchStat.mode & 0o077) !== 0 ||
        (typeof process.getuid === "function" && scratchStat.uid !== process.getuid())) {
        throw new Error("Electron ZIP extraction requires a private, user-owned scratch root.");
    }
    const temporary = await fs.mkdtemp(path.join(scratchRoot, "electron-"));
    try {
        // Copy to a directory no other UID can mutate, then inspect the COPY
        // using the same pinned descriptor+SHA-256 checks as signed staging.
        const privateZip = path.join(temporary, "electron.zip");
        await fs.copyFile(archivePath, privateZip, fsConstants.COPYFILE_EXCL);
        await fs.chmod(privateZip, 0o400);
        const inspected = await inspectPinnedElectronZip({ archivePath: privateZip, target });
        const extracted = path.join(temporary, "content");
        await fs.mkdir(extracted, { mode: 0o700 });
        await execFile("/usr/bin/ditto", ["-x", "-k", privateZip, extracted], {
            timeout: 180_000, maxBuffer: 1024 * 1024,
        });
        const root = await fs.realpath(extracted);
        let entries = 0;
        let files = 0;
        let links = 0;
        let expandedBytes = 0;
        const directories = [extracted];
        while (directories.length) {
            const directory = directories.pop();
            for (const name of await fs.readdir(directory)) {
                const full = path.join(directory, name);
                const stat = await fs.lstat(full);
                entries++;
                if (entries > MAX_ENTRIES)
                    throw new Error("Extracted Electron has too many entries.");
                if (stat.isSymbolicLink()) {
                    const targetPath = await fs.realpath(full);
                    if (!targetPath.startsWith(root + path.sep))
                        throw new Error("Extracted Electron link escapes the private directory.");
                    links++;
                }
                else if (stat.isDirectory()) {
                    directories.push(full);
                }
                else if (stat.isFile()) {
                    files++;
                    expandedBytes += stat.size;
                    if (expandedBytes > MAX_UNPACKED_BYTES)
                        throw new Error("Extracted Electron exceeds the inspected byte budget.");
                }
                else {
                    throw new Error("Extracted Electron contains an unsupported file type.");
                }
            }
        }
        if (links !== inspected.links || entries !== inspected.entries ||
            expandedBytes > inspected.unpackedBytes) {
            throw new Error("Extracted Electron tree does not match the inspected ZIP budget.");
        }
        for (const name of ["LICENSE", "LICENSES.chromium.html"]) {
            const stat = await fs.lstat(path.join(extracted, name));
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 100) {
                throw new Error("Extracted Electron license notices are missing.");
            }
        }
        const executable = path.join(extracted, "Electron.app", "Contents", "MacOS", "Electron");
        const handle = await fs.open(executable, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        try {
            const stat = await handle.stat();
            if (!stat.isFile() || (stat.mode & 0o111) === 0) {
                throw new Error("Extracted Electron Mach-O executable has an unsafe mode.");
            }
            const header = Buffer.alloc(8);
            if ((await handle.read(header, 0, header.length, 0)).bytesRead !== 8 ||
                header.readUInt32LE(0) !== 0xfeedfacf ||
                header.readUInt32LE(4) !== (target === "darwin-arm64" ? 0x0100000c : 0x01000007)) {
                throw new Error("Extracted Electron Mach-O architecture does not match the pinned target.");
            }
        }
        finally {
            await handle.close();
        }
        // Isolated preview-only identity validation: do not reuse or modify the
        // native AppKit dev.equinox.local permission owner. Ad-hoc signing needs no
        // paid Apple Developer account and never persists outside this scratch.
        const signedHostedUi = inspectHostedIdentity || stageHostedUi;
        if (signedHostedUi) {
            const app = path.join(extracted, "Electron.app");
            const info = path.join(app, "Contents", "Info.plist");
            await execFile("/usr/libexec/PlistBuddy", [
                "-c", "Set :CFBundleIdentifier " + HOSTED_UI_ID, info,
            ], { timeout: 15_000, maxBuffer: 1024 * 1024 });
            await execFile("/usr/bin/codesign", [
                "--force", "--deep", "--sign", "-", "--identifier", HOSTED_UI_ID, app,
            ], { timeout: 60_000, maxBuffer: 1024 * 1024 });
            await execFile("/usr/bin/codesign", [
                "--verify", "--deep", "--strict", app,
            ], { timeout: 30_000, maxBuffer: 1024 * 1024 });
            const { stderr } = await execFile("/usr/bin/codesign", [
                "-dv", app,
            ], { timeout: 15_000, maxBuffer: 1024 * 1024 });
            if (!stderr.includes("Identifier=" + HOSTED_UI_ID) ||
                !stderr.includes("Signature=adhoc")) {
                throw new Error("Electron UI-child bundle does not have the expected distinct ad-hoc identity.");
            }
        }
        // Optional atomic *preparation* only, not a production install/repair:
        // expose the entirely verified tree under one unpredictable name inside
        // the original 0700 owned scratch root. The installer will later own a
        // separate stable-name/activation transaction; this does not create one.
        let stagedPath;
        if (stageHostedUi) {
            const candidate = path.join(scratchRoot, "electron-ui-" + randomBytes(16).toString("hex"));
            await fs.rename(extracted, candidate);
            try {
                await execFile("/usr/bin/codesign", [
                    "--verify", "--deep", "--strict", path.join(candidate, "Electron.app"),
                ], { timeout: 30_000, maxBuffer: 1024 * 1024 });
                stagedPath = candidate;
            }
            catch (error) {
                await fs.rm(candidate, { recursive: true, force: true });
                throw error;
            }
        }
        return Object.freeze({ target, files, links, expandedBytes,
            machine: target === "darwin-arm64" ? "arm64" : "x64",
            ...(signedHostedUi ? { hostedBundleIdentifier: HOSTED_UI_ID } : {}),
            ...(stagedPath ? { stagedPath } : {}) });
    }
    finally {
        await fs.rm(temporary, { recursive: true, force: true });
    }
}
