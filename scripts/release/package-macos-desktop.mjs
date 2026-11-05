import fs from "node:fs/promises";
import path from "node:path";
import { packageManagedDesktopShell } from "./package-desktop-shell.mjs";
import { sealDesktopBundle } from "../../src/equinox-local-desktop-bundle.js";
import { EQUINOX_LOCAL_DESKTOP_APP_ARCHIVE, EQUINOX_LOCAL_DESKTOP_SHELL_VERSION, EQUINOX_LOCAL_NATIVE_APP_METADATA, validateEquinoxLocalDesktopAppMetadata, } from "../../src/equinox-local-native-app.js";
/** Build tooling only. The public runtime never imports Electron packaging dependencies. */
export async function buildManagedMacDesktopPayload({ rootDir, releaseDir, target, sourceSha }) {
    if (process.platform !== "darwin" || target !== `darwin-${process.arch}`)
        throw new Error("Managed macOS desktop payload requires its native target host.");
    for (const directory of [rootDir, releaseDir]) {
        if (!path.isAbsolute(directory) || await fs.realpath(directory) !== directory)
            throw new Error("Desktop payload build paths must be canonical.");
        const stat = await fs.lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid())
            throw new Error("Desktop payload build directory is not owned.");
    }
    const output = path.join(path.dirname(releaseDir), "desktop");
    const payloadRoot = path.join(releaseDir, "runtime", "app");
    await fs.mkdir(output, { mode: 0o700 });
    const outputStat = await fs.lstat(output);
    try {
        const built = await packageManagedDesktopShell({ rootDir, outputDir: output, target, sourceSha, shellVersion: EQUINOX_LOCAL_DESKTOP_SHELL_VERSION });
        if (built.role !== "managed" || built.target !== target)
            throw new Error("Desktop packager returned the wrong installation role.");
        // No legacy executable/assets alongside the sealed Electron representation.
        await fs.mkdir(payloadRoot, { mode: 0o700 });
        const identity = await sealDesktopBundle(path.join(built.output, "Equinox Local.app"), path.join(payloadRoot, EQUINOX_LOCAL_DESKTOP_APP_ARCHIVE));
        const metadata = validateEquinoxLocalDesktopAppMetadata({
            schemaVersion: 2, kind: "electron", shellVersion: EQUINOX_LOCAL_DESKTOP_SHELL_VERSION,
            sourceSha, target, archive: EQUINOX_LOCAL_DESKTOP_APP_ARCHIVE, ...identity,
        });
        await fs.writeFile(path.join(payloadRoot, EQUINOX_LOCAL_NATIVE_APP_METADATA), `${JSON.stringify(metadata, null, 2)}\n`, { flag: "wx", mode: 0o644 });
        return metadata;
    }
    finally {
        // Only this tool's fresh build output; release payload remains with its caller.
        const current = await fs.lstat(output);
        if (!current.isDirectory() || current.isSymbolicLink() || current.uid !== outputStat.uid || current.dev !== outputStat.dev || current.ino !== outputStat.ino)
            throw new Error("Desktop build output ownership changed; cleanup refused.");
        await fs.rm(output, { recursive: true, force: true });
    }
}
