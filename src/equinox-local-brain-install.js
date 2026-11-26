import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { protectWindowsPrivateStatePath } from "./equinox-local-private-state.js";
// Reviewed upstream release; never resolve `latest` or execute an unpinned URL.
export const BRAIN_RELEASE = Object.freeze({ version: "3.17.0", bytes: 780632,
    sha256: "8d665e30cd755e61d3b8d87bca5b5a70dfc5c985c3823a212b1c05618b1eea3b",
    url: "https://github.com/avenoxai/avenoxbeyin/releases/download/v3.17.0/beyin-v3-3.17.0.zip" });
const LICENSE = `MIT License

Copyright (c) 2026 Avenox

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
const execFile = promisify(execFileCallback);
function invalid(message) { return Object.assign(new Error(message), { statusCode: 400 }); }
function pythonEnvironment() {
    // The optional upstream engine never inherits runtime API keys, agent
    // session variables, Python injection environment or arbitrary PATH aliases.
    const env = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (["HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL"].includes(key.toUpperCase()))
            env[key] = value;
    }
    return env;
}
async function pythonCandidates() {
    if (process.platform === "darwin")
        return ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/Library/Frameworks/Python.framework/Versions/Current/bin/python3"].map(command => ({ command, prefix: [] }));
    if (process.platform !== "win32")
        return [];
    const candidates = [];
    const windows = process.env.SystemRoot || process.env.WINDIR;
    const local = process.env.LOCALAPPDATA;
    if (windows && path.isAbsolute(windows))
        candidates.push({ command: path.join(windows, "py.exe"), prefix: ["-3"] });
    if (local && path.isAbsolute(local)) {
        const root = path.join(local, "Programs", "Python");
        candidates.push({ command: path.join(root, "Launcher", "py.exe"), prefix: ["-3"] });
        for (const entry of (await fs.readdir(root, { withFileTypes: true }).catch(() => [])).filter(e => e.isDirectory() && /^Python3\d{2}$/u.test(e.name)).sort((a, b) => b.name.localeCompare(a.name)).slice(0, 12))
            candidates.push({ command: path.join(root, entry.name, "python.exe"), prefix: [] });
    }
    return candidates;
}
export async function findBrainPython() {
    for (const { command, prefix } of await pythonCandidates()) {
        try {
            const real = await fs.realpath(command);
            if (!(await fs.stat(real)).isFile())
                continue;
            const { stdout } = await execFile(real, [...prefix, "-I", "-X", "utf8", "-c", "import sys, json; print(json.dumps({'path':sys.executable,'version':list(sys.version_info[:3])}))"], { windowsHide: true, timeout: 3000, maxBuffer: 8192, env: pythonEnvironment() });
            const result = JSON.parse(stdout);
            if (result.version?.[0] !== 3 || result.version?.[1] < 11 || typeof result.path !== "string" || !path.isAbsolute(result.path))
                continue;
            const executable = await fs.realpath(result.path);
            if ((await fs.stat(executable)).isFile())
                return executable;
        }
        catch { /* Try the next explicit standard installation location. */ }
    }
    throw invalid("Python 3.11 or newer is required. Install Python from python.org or a standard system installation before continuing.");
}
async function downloadRelease() {
    const signal = AbortSignal.timeout(30_000);
    const options = { redirect: "manual", cache: "no-store", credentials: "omit", signal };
    let response = await fetch(BRAIN_RELEASE.url, options);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location)
            throw new Error("Missing release redirect.");
        const target = new URL(location, BRAIN_RELEASE.url);
        if (target.protocol !== "https:" || target.hostname !== "release-assets.githubusercontent.com" || target.port || target.username || target.password || !target.pathname.startsWith("/github-production-release-asset/"))
            throw new Error("Unexpected release redirect.");
        await response.body?.cancel();
        response = await fetch(target, { ...options, redirect: "error" });
    }
    if (!response.ok || !response.body)
        throw new Error("Release download failed.");
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    try {
        while (true) {
            const result = await reader.read();
            if (result.done)
                break;
            length += result.value.length;
            if (length > BRAIN_RELEASE.bytes)
                throw new Error("Release exceeds the expected size.");
            chunks.push(Buffer.from(result.value));
        }
    }
    finally {
        await reader.cancel().catch(() => { });
        reader.releaseLock();
    }
    const data = Buffer.concat(chunks, length);
    if (length !== BRAIN_RELEASE.bytes || createHash("sha256").update(data).digest("hex") !== BRAIN_RELEASE.sha256)
        throw new Error("Release integrity verification failed.");
    return data;
}
const EXTRACT = `import pathlib, stat, sys, zipfile
root = pathlib.Path(sys.argv[2])
with zipfile.ZipFile(sys.argv[1]) as archive:
    entries = archive.infolist()
    if len(entries) > 256 or sum(e.file_size for e in entries) > 8 * 1024 * 1024:
        raise ValueError('archive bounds')
    seen = set()
    for entry in entries:
        name = entry.filename.rstrip('/')
        parts = name.split('/')
        if not name or any(not p or p in ('.', '..') or ':' in p or '\\\\' in p or p.endswith(('.', ' ')) for p in parts):
            raise ValueError('unsafe archive path')
        key = name.casefold()
        if key in seen or stat.S_IFMT(entry.external_attr >> 16) not in (0, stat.S_IFREG, stat.S_IFDIR):
            raise ValueError('duplicate or unsafe archive entry')
        seen.add(key)
    archive.extractall(root)
`;
export async function installBrainVault(vault, stateRoot) {
    const directory = await fs.lstat(vault).catch(() => null);
    if (!directory?.isDirectory() || directory.isSymbolicLink())
        throw invalid("Select a new empty folder for the memory vault.");
    const canonical = await fs.realpath(vault);
    if (await fs.realpath(stateRoot) === canonical || (await fs.readdir(canonical)).length)
        throw invalid("New vault installation requires an empty folder. Use Connect existing for an existing Beyin vault.");
    const python = await findBrainPython();
    const staging = await fs.mkdtemp(path.join(stateRoot, ".brain-install-"));
    try {
        if (process.platform === "win32")
            await protectWindowsPrivateStatePath({ target: staging, type: "directory" });
        const archive = path.join(staging, "release.zip");
        const packageRoot = path.join(staging, "package");
        await fs.writeFile(archive, await downloadRelease(), { flag: "wx", mode: 0o600 });
        await fs.mkdir(packageRoot, { mode: 0o700 });
        await execFile(python, ["-I", "-X", "utf8", "-c", EXTRACT, archive, packageRoot], { cwd: staging, env: pythonEnvironment(), windowsHide: true, timeout: 15000, maxBuffer: 64 * 1024 });
        // Recheck the user's target after network work. Upstream owns the local
        // installer and state binding; EL never overwrites an existing vault.
        if (await fs.realpath(vault) !== canonical || (await fs.readdir(canonical)).length)
            throw invalid("The selected folder changed. Choose an empty folder again.");
        await execFile(python, ["-I", "-X", "utf8", path.join(packageRoot, "scripts", "install_v3.py"), "--vault", canonical], { cwd: staging, env: pythonEnvironment(), windowsHide: true, timeout: 60000, maxBuffer: 256 * 1024 });
        await fs.writeFile(path.join(canonical, "AVENOX-BEYIN-LICENSE.txt"), LICENSE, { flag: "wx", mode: 0o600 });
    }
    catch (error) {
        if (error?.statusCode === 400)
            throw error;
        throw invalid("Brain installation could not finish. Any created vault files have been preserved; inspect the folder before retrying.");
    }
    finally {
        await fs.rm(staging, { recursive: true, force: true });
    }
}
