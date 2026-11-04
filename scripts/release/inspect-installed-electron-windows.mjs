import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateTrustedMainInstallPointer } from "../../src/equinox-local-main-install-pointer.js";
import { inspectEquinoxLocalMainNativeStoredRelease, readEquinoxLocalMainNativePointer } from "../../src/equinox-local-main-native-state.js";
import { equinoxLocalManagedSourcePaths } from "../../src/equinox-local-managed-source-installation.js";
import { ELECTRON_DISTRIBUTIONS } from "../../src/equinox-local-runtime-versions.js";
import { readBoundedNormalFile } from "../../src/equinox-local-safe-file.js";
import { inspectExtractedPinnedWindowsElectron } from "./inspect-extracted-electron-windows.mjs";
// The Windows WPF owner may invoke this once with its pinned installed Node.
// It does not repair, install, activate or launch the UI, and no user-provided
// path is accepted through the CLI. Process/ACL exclusive ownership must be
// enforced separately by the original native signed Main installer/WPF shell.
export async function inspectInstalledSignedMainWindowsElectronUi({ homeDir = os.homedir(), arch = process.arch, } = {}) {
    if (process.platform !== "win32" || (arch !== "x64" && arch !== "arm64") ||
        !path.win32.isAbsolute(homeDir) || path.win32.normalize(homeDir) !== homeDir) {
        throw new Error("Installed Windows Electron inspection requires a canonical Windows home and CPU.");
    }
    const target = `win32-${arch}`;
    const root = equinoxLocalManagedSourcePaths({ homeDir, platform: "win32", arch }).mainTransactionRoot;
    const currentPointer = path.win32.join(root, "current-native.json");
    const active = await readEquinoxLocalMainNativePointer(currentPointer, { transactionRoot: root });
    if (active.target !== target || !/^[a-f0-9]{40}$/u.test(active.sourceSha)) {
        throw new Error("Current Windows Main native pointer does not authorize this CPU/source SHA.");
    }
    const sourceSha = active.sourceSha;
    const selectorPath = path.win32.join(root, "native-store", target, sourceSha, "signed-selector.json");
    const { data } = await readBoundedNormalFile(selectorPath, {
        platform: "win32", minBytes: 200, maxBytes: 16 * 1024,
        encoding: "utf8", label: "Immutable signed Windows Main selector",
    });
    let raw;
    try {
        raw = JSON.parse(data);
    }
    catch {
        throw new Error("Immutable Windows Main selector is not valid JSON.");
    }
    const signed = validateTrustedMainInstallPointer(raw, { expectedSourceSha: sourceSha });
    const row = signed.targets.find((candidate) => candidate.target === target);
    if (!row || row.runtimeContractSha256 !== active.runtimeContractSha256) {
        throw new Error("Windows Main native pointer differs from its Ed25519 signed selector.");
    }
    const stored = await inspectEquinoxLocalMainNativeStoredRelease({
        transactionRoot: root, target, sourceSha,
        expectedRuntimeContractSha256: row.runtimeContractSha256,
    });
    const releaseDir = path.win32.join(root, "native-store", target, sourceSha, "release");
    if (stored.releaseDir !== releaseDir || stored.sourceSha !== sourceSha ||
        stored.target !== target || stored.manifest.artifactSha256 !== row.artifact.sha256 ||
        stored.manifest.artifactBytes !== row.artifact.bytes ||
        stored.manifest.payloadVersion !== signed.version) {
        throw new Error("Windows Electron source failed immutable signed Main native-store admission.");
    }
    const sourceEntrypoint = path.win32.join(releaseDir, "desktop", "electron", "main.cjs");
    const sourceFile = await fs.open(sourceEntrypoint, fsConstants.O_RDONLY);
    try {
        const stat = await sourceFile.stat();
        const named = await fs.lstat(sourceEntrypoint);
        if (!stat.isFile() || named.isSymbolicLink() ||
            stat.dev !== named.dev || stat.ino !== named.ino) {
            throw new Error("Signed Windows Electron source entrypoint is unsafe.");
        }
    }
    finally {
        await sourceFile.close();
    }
    const pinned = ELECTRON_DISTRIBUTIONS[target];
    if (!pinned)
        throw new Error("Unsupported Windows Electron distribution.");
    const archivePath = path.win32.join(releaseDir, "runtime", "electron", pinned.filename);
    const installedPath = path.win32.join(root, "electron-ui", target, sourceSha);
    const conflicts = [path.win32.join(root, "active.json"),
        path.win32.join(root, "electron-ui", target, ".activation.lock")];
    async function assertNoActiveInstall() {
        for (const conflict of conflicts) {
            try {
                await fs.lstat(conflict);
                throw new Error("Windows native Main install or Electron activation is currently active.");
            }
            catch (error) {
                if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") {
                    throw error;
                }
            }
        }
    }
    await assertNoActiveInstall();
    const first = await fs.lstat(installedPath);
    if (!first.isDirectory() || first.isSymbolicLink() ||
        await fs.realpath(installedPath) !== installedPath) {
        throw new Error("Product-owned Windows Electron UI root is unsafe.");
    }
    const verified = await inspectExtractedPinnedWindowsElectron({ archivePath, target, extractedRoot: installedPath });
    const after = await fs.lstat(installedPath);
    if (after.dev !== first.dev || after.ino !== first.ino || !after.isDirectory() ||
        after.isSymbolicLink()) {
        throw new Error("Product-owned Windows Electron UI root changed during source validation.");
    }
    await assertNoActiveInstall();
    const reread = await readEquinoxLocalMainNativePointer(currentPointer, { transactionRoot: root });
    if (reread.target !== target || reread.sourceSha !== sourceSha ||
        reread.runtimeContractSha256 !== row.runtimeContractSha256) {
        throw new Error("Windows signed Main SHA changed during hosted UI inspection.");
    }
    if (verified.executablePath !== path.win32.join(installedPath, "electron.exe")) {
        throw new Error("Windows Electron executable escaped the product-owned UI tree.");
    }
    return Object.freeze({ target, sourceSha, sourceEntrypoint,
        installedPath, executablePath: verified.executablePath });
}
const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invoked === import.meta.url) {
    if (process.argv.length !== 3 || process.argv[2] !== "--inspect-installed-ui") {
        process.stderr.write("Usage: inspect-installed-electron-windows.mjs --inspect-installed-ui\n");
        process.exitCode = 64;
    }
    else {
        inspectInstalledSignedMainWindowsElectronUi().then((result) => {
            process.stdout.write(JSON.stringify(result) + "\n");
        }).catch((error) => {
            process.stderr.write("Installed Windows Electron UI not admitted: " +
                (error instanceof Error ? error.message : "unknown failure") + "\n");
            process.exitCode = 1;
        });
    }
}
