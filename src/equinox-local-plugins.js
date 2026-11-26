import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { BRAIN_RELEASE, installBrainVault } from "./equinox-local-brain-install.js";
import { readBoundedNormalFile } from "./equinox-local-safe-file.js";
import { inspectPrivateStatePath, protectWindowsPrivateStatePath, verifyWindowsPrivateStateAcl } from "./equinox-local-private-state.js";
const MAX_SETTINGS_BYTES = 8192;
const VERSION = /^\d+\.\d+\.\d+$/u;
function invalid(message) { return Object.assign(new Error(message), { statusCode: 400 }); }
function validPath(value) {
    return typeof value === "string" && value.length <= 1024 && path.isAbsolute(value) && path.parse(value).root !== value && !/[\u0000-\u001f\u007f]/u.test(value);
}
async function inspectVault(vault) {
    // Registration is read-only: selecting a vault does not execute its Python,
    // change its hook configuration, or add it to agent filesystem permissions.
    try {
        const folder = await fs.lstat(vault);
        if (!folder.isDirectory() || folder.isSymbolicLink())
            throw new Error("invalid folder");
        const canonical = await fs.realpath(vault);
        const entry = await fs.lstat(path.join(canonical, "beyin.py"));
        if (!entry.isFile() || entry.isSymbolicLink())
            throw new Error("missing CLI");
        const { data: stamp } = await readBoundedNormalFile(path.join(canonical, ".beyin-version"), { maxBytes: 128, encoding: "utf8", requireSingleLink: true });
        const { data: raw } = await readBoundedNormalFile(path.join(canonical, ".beyin-runtime.json"), { maxBytes: MAX_SETTINGS_BYTES, encoding: "utf8", requireSingleLink: true });
        const pin = JSON.parse(raw);
        const version = stamp.trim();
        if (!VERSION.test(version) || !version.startsWith("3.") || pin.schema !== 1 || !validPath(pin.state))
            throw new Error("invalid V3 metadata");
        const relative = path.relative(canonical, path.resolve(pin.state));
        if (!relative || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative)))
            throw new Error("state inside vault");
        return { vault: canonical, version };
    }
    catch {
        throw invalid("Select an installed Avenox Beyin V3 vault containing beyin.py and its installation metadata.");
    }
}
export function createPluginCatalog(stateRoot) {
    const file = path.join(stateRoot, "plugins.json");
    async function read() {
        const security = await inspectPrivateStatePath(file, { type: "file", mode: "600", verifyWindowsAcl: verifyWindowsPrivateStateAcl });
        if (security.reason === "missing")
            return null;
        if (!security.safe)
            throw invalid("Plugin settings are unavailable or unsafe.");
        const { data } = await readBoundedNormalFile(file, { maxBytes: MAX_SETTINGS_BYTES, encoding: "utf8", requireSingleLink: true });
        const parsed = JSON.parse(data);
        if (parsed.schema !== 1 || (parsed.brain !== null && (!validPath(parsed.brain?.vault) || !VERSION.test(parsed.brain?.version))))
            throw invalid("Plugin settings are invalid.");
        return parsed.brain;
    }
    async function save(brain) {
        await read(); // Never replace an unsafe or malformed settings file.
        const temp = path.join(stateRoot, `.plugins-${randomUUID()}.tmp`);
        try {
            await fs.writeFile(temp, JSON.stringify({ schema: 1, brain }) + "\n", { flag: "wx", mode: 0o600 });
            if (process.platform === "win32")
                await protectWindowsPrivateStatePath({ target: temp, type: "file" });
            await fs.rename(temp, file);
        }
        finally {
            await fs.rm(temp, { force: true }).catch(() => { });
        }
    }
    async function status() {
        const brain = await read();
        if (!brain)
            return { brain: null, offeredVersion: BRAIN_RELEASE.version };
        try {
            return { brain: { ...await inspectVault(brain.vault), available: true }, offeredVersion: BRAIN_RELEASE.version };
        }
        catch {
            return { brain: { ...brain, available: false }, offeredVersion: BRAIN_RELEASE.version };
        }
    }
    return { status, async connect(value) {
            if (!validPath(value))
                throw invalid("Choose an absolute vault folder.");
            const brain = await inspectVault(value);
            await save(brain);
            return status();
        }, async install(value) {
            if (!validPath(value))
                throw invalid("Choose an absolute vault folder.");
            if (await read())
                throw invalid("Disconnect the current vault before installing another.");
            await installBrainVault(value, stateRoot);
            const brain = await inspectVault(value);
            if (brain.version !== BRAIN_RELEASE.version)
                throw invalid("Installed vault version could not be confirmed.");
            await save(brain);
            return status();
        }, async disconnect() { await save(null); return status(); } };
}
