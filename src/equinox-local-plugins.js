import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { BRAIN_RELEASE, installBrainVault, prepareBrainEngine, runBrainMemory, brainEngineDiagnostics, startBrainWebView } from "./equinox-local-brain-install.js";
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
        return { vault: canonical, version, indexState: path.resolve(pin.state) };
    }
    catch {
        throw invalid("Select an installed Avenox Beyin V3 vault containing beyin.py and its installation metadata.");
    }
}
export function createPluginCatalog(stateRoot) {
    const file = path.join(stateRoot, "plugins.json");
    // Observation admission only; every actual refresh still revalidates the
    // protected persisted permission and vault binding inside the mutation lock.
    let browserObservationEnabled;
    const lastLifecycle = { native: null, user: null };
    let webView = null;
    async function stopWeb() { const current = webView; webView = null; if (current)
        await current.stop(); }
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
        if (parsed.brain && (parsed.brain.searchEnabled !== undefined && typeof parsed.brain.searchEnabled !== "boolean" || parsed.brain.searchEnabled === true && !validPath(parsed.brain.indexState)))
            throw invalid("Plugin settings are invalid.");
        if (parsed.brain && (parsed.brain.writeEnabled !== undefined && typeof parsed.brain.writeEnabled !== "boolean" || parsed.brain.writeEnabled === true && !parsed.brain.searchEnabled))
            throw invalid("Plugin settings are invalid.");
        if (parsed.brain && [parsed.brain.lifecycleEnabled, parsed.brain.browserLifecycleEnabled].some(value => value !== undefined && (typeof value !== "boolean" || value === true && !parsed.brain.searchEnabled)))
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
            browserObservationEnabled = brain?.searchEnabled === true && brain.browserLifecycleEnabled === true;
        }
        finally {
            await fs.rm(temp, { force: true }).catch(() => { });
        }
    }
    async function status() {
        const brain = await read();
        if (!brain)
            return { brain: null, offeredVersion: BRAIN_RELEASE.version };
        const base = { vault: brain.vault, version: brain.version, searchEnabled: brain.searchEnabled === true, writeEnabled: brain.writeEnabled === true, lifecycleEnabled: brain.lifecycleEnabled === true, browserLifecycleEnabled: brain.browserLifecycleEnabled === true, webRunning: webView?.running() === true };
        try {
            const actual = await inspectVault(brain.vault);
            return { brain: { ...base, version: actual.version, available: true, searchCompatible: actual.version === BRAIN_RELEASE.version && (!brain.searchEnabled || actual.indexState === brain.indexState) }, offeredVersion: BRAIN_RELEASE.version };
        }
        catch {
            return { brain: { ...base, available: false, searchCompatible: false }, offeredVersion: BRAIN_RELEASE.version };
        }
    }
    async function engineConnection(brain) {
        const actual = await inspectVault(brain.vault);
        if (actual.version !== BRAIN_RELEASE.version)
            throw invalid(`Agent memory currently requires Beyin ${BRAIN_RELEASE.version}. The connected vault has not been changed.`);
        const canonicalState = await fs.realpath(actual.indexState).catch(() => null);
        if (!canonicalState || canonicalState !== actual.indexState || !(await fs.lstat(canonicalState)).isDirectory())
            throw invalid("The vault's local index folder is unavailable or redirected.");
        if (brain.searchEnabled && brain.indexState !== canonicalState)
            throw invalid("The vault's local index binding changed. Disable and re-enable memory access in Control Center.");
        return { vault: actual.vault, state: canonicalState };
    }
    async function prepareSearch(brain) {
        const connection = await engineConnection(brain);
        await prepareBrainEngine(stateRoot);
        const result = await runBrainMemory(stateRoot, { action: "sync", ...connection });
        if (!["succeeded", "degraded"].includes(result.status))
            throw invalid("The Brain index could not be refreshed.");
        return { vault: brain.vault, version: BRAIN_RELEASE.version, searchEnabled: true, indexState: connection.state };
    }
    async function registerBrain(metadata, enableMemory) {
        const linked = { vault: metadata.vault, version: metadata.version, searchEnabled: false };
        let selected = linked, setupWarning = false;
        if (enableMemory) {
            try {
                selected = { ...await prepareSearch(linked), writeEnabled: true, lifecycleEnabled: true, browserLifecycleEnabled: true };
            }
            catch {
                setupWarning = true;
            }
        }
        // A failed preparation never leaves partially granted access. Keep the
        // user's installed/connected vault available for repair in settings.
        await save(selected);
        return { ...await status(), setupWarning };
    }
    return { status, async shouldObserveBrowser() {
            if (browserObservationEnabled !== undefined)
                return browserObservationEnabled;
            const brain = await read();
            // Preserve a concurrent successful save while the initial read is pending.
            return browserObservationEnabled ??= (brain?.searchEnabled === true && brain.browserLifecycleEnabled === true);
        }, async connect(value, enableMemory = false) {
            if (typeof enableMemory !== "boolean")
                throw invalid("Choose whether to enable recommended memory access.");
            if (!validPath(value))
                throw invalid("Choose an absolute vault folder.");
            if (await read())
                throw invalid("Disconnect the current vault before connecting another.");
            const brain = await inspectVault(value);
            return registerBrain(brain, enableMemory);
        }, async install(value, enableMemory = false) {
            if (typeof enableMemory !== "boolean")
                throw invalid("Choose whether to enable recommended memory access.");
            if (!validPath(value))
                throw invalid("Choose an absolute vault folder.");
            if (await read())
                throw invalid("Disconnect the current vault before installing another.");
            await installBrainVault(value, stateRoot);
            const brain = await inspectVault(value);
            if (brain.version !== BRAIN_RELEASE.version)
                throw invalid("Installed vault version could not be confirmed.");
            return registerBrain(brain, enableMemory);
        }, async setSearchEnabled(enabled) {
            if (typeof enabled !== "boolean")
                throw invalid("Choose whether agent memory search is enabled.");
            const brain = await read();
            if (!brain)
                throw invalid("Connect a memory vault first.");
            if (!enabled) {
                await save({ vault: brain.vault, version: brain.version, searchEnabled: false });
                lastLifecycle.native = null;
                lastLifecycle.user = null;
                return status();
            }
            await save(await prepareSearch(brain));
            return status();
        }, async setWriteEnabled(enabled) {
            if (typeof enabled !== "boolean")
                throw invalid("Choose whether agent memory writing is enabled.");
            const brain = await read();
            if (!brain?.searchEnabled)
                throw invalid("Enable agent memory search first.");
            if (enabled)
                await engineConnection(brain);
            await save({ ...brain, writeEnabled: enabled });
            return status();
        }, async setLifecycleEnabled(enabled, scope = "native") {
            if (typeof enabled !== "boolean" || !["native", "user"].includes(scope))
                throw invalid("Choose whether memory refresh is enabled.");
            const brain = await read();
            if (!brain?.searchEnabled)
                throw invalid("Enable agent memory search first.");
            if (enabled)
                await engineConnection(brain);
            const key = scope === "native" ? "lifecycleEnabled" : "browserLifecycleEnabled";
            await save({ ...brain, [key]: enabled });
            lastLifecycle[scope] = null;
            return status();
        }, async lifecycleSync(event, scope = "native") {
            if (!["native", "user"].includes(scope))
                throw invalid("Invalid memory refresh scope.");
            const brain = await read();
            if (!brain?.searchEnabled || !(scope === "native" ? brain.lifecycleEnabled : brain.browserLifecycleEnabled))
                return { status: "disabled" };
            try {
                const result = await runBrainMemory(stateRoot, { action: "lifecycle_sync", ...await engineConnection(brain), event });
                lastLifecycle[scope] = { status: ["succeeded", "degraded", "skipped"].includes(result.status) ? result.status : "attention", at: new Date().toISOString() };
                return result;
            }
            catch (error) {
                lastLifecycle[scope] = { status: "attention", at: new Date().toISOString() };
                throw error;
            }
        }, async sync() {
            const brain = await read();
            if (!brain?.searchEnabled)
                throw invalid("Enable agent memory search first.");
            const connection = await engineConnection(brain);
            const result = await runBrainMemory(stateRoot, { action: "sync", ...connection });
            if (!["succeeded", "degraded"].includes(result.status))
                throw invalid("The Brain index could not be refreshed.");
            return { plugins: await status(), indexStatus: result.status };
        }, async search(input, context = false) {
            const brain = await read();
            if (!brain?.searchEnabled)
                throw invalid("Equinox Brain memory search is disabled. The user can enable it in Control Center.");
            const { query, project, limit, budget } = input;
            if (typeof query !== "string" || !query.trim() || query.length > 2000 ||
                (project !== undefined && (typeof project !== "string" || !project.trim() || project.length > 160)) ||
                !Number.isInteger(limit) || limit < 1 || limit > 10 || !Number.isInteger(budget) || budget < 1000 || budget > 8000)
                throw invalid("Invalid bounded memory search request.");
            const connection = await engineConnection(brain);
            return runBrainMemory(stateRoot, { action: context ? "context" : "search", ...connection, query, ...(project === undefined ? {} : { project }), limit, budget });
        }, async readMemory(input) {
            const brain = await read();
            if (!brain?.searchEnabled)
                throw invalid("Equinox Brain memory access is disabled.");
            const { id, project, budget } = input;
            if (typeof id !== "string" || !id.trim() || id.length > 200 || (project !== undefined && (typeof project !== "string" || !project.trim() || project.length > 160)) || !Number.isInteger(budget) || budget < 1000 || budget > 8000)
                throw invalid("Invalid memory read request.");
            return runBrainMemory(stateRoot, { action: "read", ...await engineConnection(brain), id, budget, ...(project === undefined ? {} : { project }) });
        }, async createMemory(input) {
            const brain = await read();
            if (!brain?.searchEnabled || !brain.writeEnabled)
                throw invalid("Equinox Brain memory writing is disabled. The user can enable it in Control Center.");
            const { key, title, text, project } = input;
            if (typeof key !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/u.test(key) || typeof title !== "string" || !title.trim() || title.length > 160 || typeof text !== "string" || !text.trim() || text.length > 12000 || (project !== undefined && (typeof project !== "string" || !project.trim() || project.length > 160)))
                throw invalid("Invalid memory note request.");
            return runBrainMemory(stateRoot, { action: "create", ...await engineConnection(brain), key, title, text, ...(project === undefined ? {} : { project }) });
        }, async openWeb() {
            const brain = await read();
            if (!brain)
                throw invalid("Connect a memory vault first.");
            const connection = await engineConnection(brain);
            if (webView?.running())
                return { url: await webView.open() };
            await stopWeb();
            await prepareBrainEngine(stateRoot);
            webView = await startBrainWebView(stateRoot, connection);
            return { url: webView.url };
        }, async stopWeb() { await stopWeb(); return status(); },
        async shutdown() { await stopWeb(); },
        async diagnostics() {
            const brain = await read();
            if (!brain)
                throw invalid("Connect a memory vault first.");
            const plugins = await status();
            const engine = await brainEngineDiagnostics(stateRoot);
            let binding = false, index = "not-checked", preferences = "not-checked";
            let connection = null;
            try {
                connection = await engineConnection(brain);
                binding = true;
            }
            catch { /* report unavailable or mismatched binding */ }
            if (connection && engine.python && engine.archive === "verified") {
                try {
                    const result = await runBrainMemory(stateRoot, { action: "diagnostics", ...connection });
                    index = result.indexHealthy ? "healthy" : "attention";
                    preferences = result.preferencesValid ? "valid" : "attention";
                }
                catch {
                    index = "attention";
                    preferences = "attention";
                }
            }
            return { plugins, diagnostics: { ...engine, binding, index, preferences, lastLifecycle: brain.lifecycleEnabled ? lastLifecycle.native : null, lastBrowserLifecycle: brain.browserLifecycleEnabled ? lastLifecycle.user : null, reviewedVersion: BRAIN_RELEASE.version, versionStatus: !plugins.brain?.available ? "unavailable" : plugins.brain.version === BRAIN_RELEASE.version ? "supported" : "unsupported" } };
        }, async preferences(profile) {
            const brain = await read();
            if (!brain)
                throw invalid("Connect a memory vault first.");
            if (profile !== undefined && (typeof profile !== "string" || !["normal", "economical", "manual"].includes(profile)))
                throw invalid("Choose a supported memory profile.");
            const connection = await engineConnection(brain);
            // Explicit desktop action only. Preparing this engine does not authorize MCP access.
            await prepareBrainEngine(stateRoot);
            const preferences = await runBrainMemory(stateRoot, { ...connection, action: profile === undefined ? "preferences" : "profile", ...(typeof profile === "string" ? { profile } : {}) });
            return { plugins: await status(), preferences };
        }, async workflow(input) {
            const brain = await read();
            if (!brain?.searchEnabled || !brain.writeEnabled)
                throw invalid("Equinox Brain memory writing is disabled.");
            const { action, project } = input;
            const text = (value, max) => typeof value === "string" && !!value.trim() && value.length <= max;
            const key = (value) => typeof value === "string" && /^[a-zA-Z0-9_-]{8,100}$/u.test(value);
            const scoped = project === undefined ? {} : { project };
            if (project !== undefined && !text(project, 160))
                throw invalid("Invalid project scope.");
            const connection = await engineConnection(brain);
            if (action === "edit" && text(input.id, 200) && typeof input.sha256 === "string" && /^[a-f0-9]{64}$/u.test(input.sha256) && text(input.old, 8000) && typeof input.new === "string" && input.new.length <= 8000)
                return runBrainMemory(stateRoot, { ...connection, action, id: input.id, sha256: input.sha256, old: input.old, new: input.new, ...scoped });
            if (action === "task_create" && key(input.key) && text(input.title, 160) && text(input.text, 12000) && text(input.owner, 160) && (input.nextAction === undefined || text(input.nextAction, 1000)))
                return runBrainMemory(stateRoot, { ...connection, action, key: input.key, title: input.title, text: input.text, owner: input.owner, ...(input.nextAction === undefined ? {} : { nextAction: input.nextAction }), ...scoped });
            if (action === "task_update" && text(input.id, 200) && Number.isSafeInteger(input.revision) && Number(input.revision) > 0 && typeof input.status === "string" && ["inbox", "active", "waiting", "blocked", "done", "cancelled"].includes(input.status) && (input.nextAction === undefined || (typeof input.nextAction === "string" && input.nextAction.length <= 1000)))
                return runBrainMemory(stateRoot, { ...connection, action, id: input.id, revision: input.revision, status: input.status, ...(input.nextAction === undefined ? {} : { nextAction: input.nextAction }), ...scoped });
            if (action === "receipt" && key(input.key) && text(input.summary, 4000) && Array.isArray(input.refs) && input.refs.length >= 1 && input.refs.length <= 10 && input.refs.every(ref => text(ref, 200)) && new Set(input.refs).size === input.refs.length)
                return runBrainMemory(stateRoot, { ...connection, action, key: input.key, summary: input.summary, refs: input.refs, ...scoped });
            throw invalid("Invalid bounded Brain workflow request.");
        }, async disconnect() { await stopWeb(); await save(null); lastLifecycle.native = null; lastLifecycle.user = null; return status(); } };
}
