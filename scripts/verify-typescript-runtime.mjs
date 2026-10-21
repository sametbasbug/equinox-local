import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const compiler = path.join(root, "node_modules", "typescript", "bin", "tsc");
async function emittedFiles(directory, prefix = "") {
    const files = [];
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink())
            throw new Error("TypeScript generated a symbolic link.");
        const relative = path.join(prefix, entry.name);
        if (entry.isDirectory())
            files.push(...await emittedFiles(path.join(directory, entry.name), relative));
        else if (entry.isFile() && (relative.endsWith(".js") || relative.endsWith(".mjs")))
            files.push(relative);
        else
            throw new Error(`Unexpected TypeScript runtime output: ${relative}`);
    }
    return files.sort();
}
// Owned tooling output directories must be real directories, never symlink redirects.
async function assertToolingOutputParents(rootDir, sourceDirectory, relative) {
    const parentParts = [sourceDirectory, ...path.dirname(relative).split(path.sep).filter((part) => part !== ".")];
    let current = rootDir;
    for (const part of parentParts) {
        assert.ok(part !== ".." && !path.isAbsolute(part), `Unsafe tooling output directory: ${relative}`);
        current = path.join(current, part);
        const stat = await fs.lstat(current);
        assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), `Unsafe tooling output directory: ${relative}`);
    }
}
// Emit into disposable staging. Never mutate a checked-in JS runtime during verification.
export async function verifyTypeScriptRuntimeOutput({ rootDir = root, nodePath = process.execPath, compilerPath = compiler, spawnImpl = spawnSync, projectFile = "tsconfig.runtime.json", sourceDirectory = "src", emittedPrefix = "", writeOutput = false, } = {}) {
    if (writeOutput) {
        assert.equal(sourceDirectory, "scripts", "Only owned tooling output may be rebuilt.");
        assert.equal(emittedPrefix, "scripts", "Tooling writes require explicit scripts-only filtering.");
        assert.equal(projectFile, "tsconfig.tooling.json", "Only the strict tooling compiler may rebuild tooling.");
    }
    const staging = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-ts-runtime-"));
    try {
        const result = spawnImpl(nodePath, [
            compilerPath, "--project", path.join(rootDir, projectFile),
            "--outDir", staging, "--pretty", "false",
        ], { cwd: rootDir, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
        if (result.error)
            throw result.error;
        if (result.status !== 0) {
            throw new Error(`TypeScript runtime emit failed (exit ${result.status ?? "unknown"}): ${result.stderr || result.stdout}`);
        }
        const emitted = await emittedFiles(staging);
        if (emittedPrefix) {
            // Cross-root TypeScript imports may also emit src/*.js in OS scratch.
            // The tooling compiler must never write those Node-runtime-owned outputs.
            const permitted = [`${emittedPrefix}${path.sep}`, `src${path.sep}`];
            for (const name of emitted) {
                assert.ok(permitted.some((prefix) => name.startsWith(prefix)), `Unexpected cross-root TypeScript output: ${name}`);
            }
        }
        const files = emittedPrefix
            ? emitted.filter((name) => name.startsWith(`${emittedPrefix}${path.sep}`))
                .map((name) => name.slice(emittedPrefix.length + 1))
            : emitted;
        if (files.length === 0)
            throw new Error("TypeScript runtime verification found no emitted JavaScript.");
        // Fail before changing ANY output if a later destination is missing or unsafe.
        // Keep the per-file checks below for substitutions between preflight and open.
        // A hard link looks regular, but overwriting it also changes a foreign file.
        // Reject multiply linked tooling outputs before opening or truncating them.
        if (writeOutput) {
            for (const relative of files) {
                await assertToolingOutputParents(rootDir, sourceDirectory, relative);
                const destination = path.join(rootDir, sourceDirectory, relative);
                const stat = await fs.lstat(destination);
                assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, `Tooling output is not an owned regular file: ${relative}`);
            }
        }
        const changed = [];
        for (const relative of files) {
            const generated = await fs.readFile(path.join(staging, emittedPrefix, relative));
            const destination = path.join(rootDir, sourceDirectory, relative);
            if (writeOutput) {
                await assertToolingOutputParents(rootDir, sourceDirectory, relative);
                const stat = await fs.lstat(destination);
                assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, `Tooling output is not an owned regular file: ${relative}`);
                const handle = await fs.open(destination, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
                try {
                    const opened = await handle.stat();
                    assert.ok(opened.isFile() && opened.nlink === 1 && opened.dev === stat.dev && opened.ino === stat.ino, `Tooling output changed while opening: ${relative}`);
                    await handle.truncate(0);
                    await handle.writeFile(generated);
                }
                finally {
                    await handle.close();
                }
            }
            else {
                const existing = await fs.readFile(destination).catch((error) => {
                    if (error?.code === "ENOENT")
                        return null;
                    throw error;
                });
                if (!existing || !generated.equals(existing))
                    changed.push(relative);
            }
        }
        assert.deepEqual(changed, [], `Committed runtime JS is stale or missing. Rebuild and review: ${changed.join(", ")}`);
        return { checked: files.length, files };
    }
    finally {
        await fs.rm(staging, { recursive: true, force: true });
    }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const result = await verifyTypeScriptRuntimeOutput();
    console.log(`Verified ${result.checked} generated runtime JavaScript files match TypeScript source exactly.`);
}
