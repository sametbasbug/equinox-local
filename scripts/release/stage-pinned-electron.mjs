import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { ELECTRON_DISTRIBUTIONS, EQUINOX_LOCAL_ELECTRON_VERSION } from "../../src/equinox-local-runtime-versions.js";
const MAX_REDIRECTS = 4;
const MAX_DOWNLOAD_MS = 180_000;
const ADMITTED_HOSTS = new Set(["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]);
function trustedUrl(raw) {
    const url = new URL(String(raw));
    if (url.protocol !== "https:" || url.username || url.password || url.port ||
        !ADMITTED_HOSTS.has(url.hostname) || url.hash) {
        throw new Error("Electron distribution redirected outside admitted HTTPS release hosts.");
    }
    return url;
}
async function downloadOfficialZip(target, fetchImpl) {
    const pinned = ELECTRON_DISTRIBUTIONS[target];
    const endpoint = trustedUrl("https://github.com/electron/electron/releases/download/v" +
        EQUINOX_LOCAL_ELECTRON_VERSION + "/" + pinned.filename);
    let current = endpoint;
    const signal = AbortSignal.timeout(MAX_DOWNLOAD_MS);
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
        const response = await fetchImpl(current, {
            method: "GET",
            redirect: "manual",
            cache: "no-store",
            credentials: "omit",
            headers: { accept: "application/zip, application/octet-stream" },
            signal,
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get("location");
            await response.body?.cancel();
            if (!location || redirects === MAX_REDIRECTS)
                throw new Error("Electron distribution redirect limit exceeded.");
            current = trustedUrl(new URL(location, current));
            continue;
        }
        if (!response.ok || !response.body) {
            await response.body?.cancel();
            throw new Error("Pinned Electron distribution returned HTTP " + response.status + ".");
        }
        const length = response.headers.get("content-length");
        if (length !== null && Number(length) !== pinned.bytes) {
            await response.body.cancel();
            throw new Error("Pinned Electron distribution Content-Length mismatch.");
        }
        return response;
    }
    throw new Error("Electron distribution redirect limit exceeded.");
}
export async function stagePinnedElectronArchive({ releaseDir, target, fetchImpl = globalThis.fetch, sourceArchivePath, }) {
    if (typeof releaseDir !== "string" || !path.isAbsolute(releaseDir) || typeof fetchImpl !== "function") {
        throw new Error("Pinned Electron staging requires an absolute release directory and fetch implementation.");
    }
    if (!Object.hasOwn(ELECTRON_DISTRIBUTIONS, target))
        throw new Error("Pinned Electron target is unsupported.");
    const admittedTarget = target;
    const pinned = ELECTRON_DISTRIBUTIONS[admittedTarget];
    if (!pinned)
        throw new Error("Pinned Electron distribution is missing.");
    if (sourceArchivePath !== undefined) {
        if (typeof sourceArchivePath !== "string" || !path.isAbsolute(sourceArchivePath)) {
            throw new Error("Pinned Electron local source must be an absolute file path.");
        }
        const stat = await fs.lstat(sourceArchivePath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== pinned.bytes) {
            throw new Error("Pinned Electron local source is not an exact-size normal file.");
        }
    }
    const root = path.resolve(releaseDir);
    const rootStat = await fs.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
        throw new Error("Pinned Electron release root is unsafe.");
    const runtimeDirectory = path.join(root, "runtime");
    const directory = path.join(runtimeDirectory, "electron");
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    for (const folder of [runtimeDirectory, directory]) {
        const stat = await fs.lstat(folder);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw new Error("Pinned Electron staging directory is unsafe.");
        }
    }
    const relative = "runtime/electron/" + pinned.filename;
    const destination = path.join(root, relative);
    const temporary = path.join(directory, ".electron-" + randomBytes(8).toString("hex") + ".part");
    const source = sourceArchivePath
        ? createReadStream(sourceArchivePath)
        : (await downloadOfficialZip(admittedTarget, fetchImpl)).body;
    if (!source)
        throw new Error("Pinned Electron distribution has no response body.");
    let handle = null;
    try {
        handle = await fs.open(temporary, "wx", 0o600);
        const digest = createHash("sha256");
        let bytes = 0;
        for await (const value of source) {
            const chunk = Buffer.from(value);
            bytes += chunk.length;
            if (bytes > pinned.bytes)
                throw new Error("Pinned Electron archive exceeded the approved byte count.");
            digest.update(chunk);
            await handle.writeFile(chunk);
        }
        if (bytes !== pinned.bytes || digest.digest("hex") !== pinned.sha256) {
            throw new Error("Pinned Electron distribution SHA-256 or byte count mismatch.");
        }
        await handle.sync();
        await handle.close();
        handle = null;
        // Never overwrite another, possibly already signed staging artifact.
        // Same-directory hard link provides atomic no-overwrite admission;
        // removing the temporary name leaves one ordinary signed ZIP file.
        await fs.link(temporary, destination);
        return Object.freeze({ relative, bytes, sha256: pinned.sha256, target: admittedTarget });
    }
    finally {
        await handle?.close().catch(() => { });
        await fs.rm(temporary, { force: true });
    }
}
