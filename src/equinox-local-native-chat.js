import fs from "node:fs/promises";
import path from "node:path";
import { chatGptConversationIdFromUrl } from "./telegram-chat-bridge-controller.js";
const MAX_MESSAGES = 30;
const MAX_TRANSCRIPT_CHARS = 96_000;
const MAX_ASSISTANT_CHARS = 12_000;
const MAX_DELIVERY_IDS = 2_048;
const MAX_NEW_CHAT_IDS = 512;
function invalid(message) { const error = new Error(message); error.statusCode = 400; throw error; }
function safeTitle(value) { return typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/gu, " ").trim().slice(0, 120) : "ChatGPT conversation"; }
/** Display metadata comes only from the exact provider user-turn observer.
 * The provider does not expose original image filenames after Send. */
function providerUserAttachments(item) {
    if (item?.role !== "user")
        return {};
    const names = item.attachmentFileNames;
    const images = item.attachmentImageCount;
    if (!Array.isArray(names) || names.length > 12
        || names.some((name) => typeof name !== "string" || !name.trim()
            || name.length > 255 || /[\\/\x00-\x1f\x7f]/u.test(name))
        || new Set(names).size !== names.length
        || !Number.isSafeInteger(images) || images < 0 || images > 12 || names.length + images > 12)
        return {};
    return { attachmentFileNames: names.slice(), attachmentImageCount: images };
}
/** Current-user native Chat transport. The browser remains the ChatGPT session authority. */
export function createNativeChatController({ browserBridge, chatBridge, taskStore }) {
    let selected = null;
    let messages = [];
    let history = [];
    let historyPartial = false;
    let historyNotice = null;
    let historyPendingHydration = 0;
    let pending = null;
    // After Stop, the provider may hydrate the user turn before the partial
    // assistant reply. Reconcile only by the shared, confirmed provider epoch.
    let stoppedTurn = null;
    let awaitingNewChatIdentity = null;
    let sending = false;
    let creating = false;
    let previousHistoryGeneration = false;
    let selecting = false;
    let blocked = false;
    let creationBlocked = false;
    let selectedRevision = 0;
    let browsedProject = null;
    let searched = null;
    // An ambiguous receipt belongs to the exact conversation; sidebar navigation
    // must never reset its send fence or permit a second uncertain message.
    const uncertainConversations = new Set();
    const awaitingFirstTurns = new Map();
    // Internal exact-binding association. Task Capsule's public projection
    // intentionally omits browser instance and conversation identifiers.
    const associatedTasks = new Map();
    const conversationKey = (binding) => binding.browserInstanceId + ":" + binding.conversationId;
    const restoreTaskBinding = async (binding) => {
        if (!taskStore?.readInternal)
            return;
        // The public Task projection omits private instance and conversation IDs.
        // Resolve those only inside this trusted controller, never in UI payloads.
        const candidates = await taskStore.list({ limit: 100 });
        const matches = [];
        for (const candidate of candidates) {
            if (candidate?.chatBinding?.browserContext !== "user" || candidate.chatBinding.tabId !== binding.tabId
                || typeof candidate.taskId !== "string" || candidate.status !== "active")
                continue;
            let record;
            try {
                record = await taskStore.readInternal(candidate.taskId);
            }
            catch {
                continue;
            } // Missing/unreadable candidate must not hide other matches.
            const original = record?.chatBinding;
            if (record?.status === "active" && original?.browserContext === "user"
                && original.browserInstanceId === binding.browserInstanceId
                && original.tabId === binding.tabId
                && original.conversationId === binding.conversationId) {
                matches.push(record.taskId);
                if (matches.length > 1)
                    break;
            }
        }
        if (matches.length === 1)
            associatedTasks.set(conversationKey(binding), matches[0]);
        else
            associatedTasks.delete(conversationKey(binding));
    };
    const currentTaskId = async (binding) => {
        if (!taskStore?.readInternal)
            return null;
        const key = conversationKey(binding);
        // Task Capsules can be rebound while the selected conversation is open.
        // Re-check the bounded trusted in-memory store on each status read; never
        // trust a previously cached association when another active task matches.
        try {
            await restoreTaskBinding(binding);
        }
        catch {
            associatedTasks.delete(key);
        }
        return associatedTasks.get(key) ?? null;
    };
    const messageEditPermitted = async (binding, taskId) => {
        if (!taskId)
            return true;
        if (!taskStore?.readInternal)
            return false;
        try {
            const record = await taskStore.readInternal(taskId);
            const native = record?.status === "active"
                && record.title?.startsWith("Native Chat · ")
                && record.objective === "User-initiated ChatGPT conversation through the Equinox Local native Chat window. The opening prompt stays in the user's ChatGPT conversation, not the Task Capsule."
                && record.references?.some(ref => ref.type === "note"
                    && ref.label === "Native Chat creation ID" && /^nch-[a-f0-9-]{36}$/u.test(ref.value));
            const busy = ["armed", "delivering"].includes(String(record.continuation?.status || ""))
                || ["prepared", "creating", "ambiguous"].includes(String(record.freshResume?.status || ""));
            const same = record.chatBinding?.browserInstanceId === binding.browserInstanceId
                && record.chatBinding?.conversationId === binding.conversationId
                && record.chatBinding?.tabId === binding.tabId;
            return !!native && !busy && same;
        }
        catch {
            return false;
        }
    };
    const createAttempts = new Map();
    const projectCreateAttempts = new Map();
    const projectInstructionAttempts = new Map();
    const projectTextAttempts = new Map();
    let projectTextBlocked = false;
    let projectTextAdding = false;
    let projectInstructionBlocked = false;
    let projectInstructionsUpdating = false;
    let projectCreateBlocked = false;
    let projectCreating = false;
    const attempts = new Map();
    const actionAttempts = new Map();
    const branchAttempts = new Map();
    const retryAttempts = new Map();
    const stopAttempts = new Map();
    const editAttempts = new Map();
    let mutatingAction = false;
    function appendMessage(message) {
        messages.push(message);
        while (messages.length > MAX_MESSAGES || messages.reduce((sum, item) => sum + item.text.length, 0) > MAX_TRANSCRIPT_CHARS)
            messages.shift();
    }
    const call = (method, args, timeoutMs = 6_000) => browserBridge.call(method, args, { context: "user", timeoutMs });
    const context = () => {
        const c = browserBridge.snapshot()?.contexts?.user;
        const id = c?.extension?.instanceId || c?.host?.instanceId;
        if (!c?.ready || typeof id !== "string" || id.length < 8)
            throw new Error("Your Browser is not connected. Open Chrome with Equinox Browser enabled.");
        if (Number(c?.extension?.capabilityVersions?.chatBridge || 0) < 9)
            throw new Error("Equinox Browser needs the current Chat Bridge capability.");
        return id;
    };
    const list = async () => {
        const browserInstanceId = context();
        const raw = await call("tabs.list", {});
        if (!Array.isArray(raw))
            throw new Error("Connected browser did not return a tab list.");
        const open = new Map();
        const duplicated = new Set();
        for (const item of raw.slice(0, 150)) {
            const tabId = Number(item?.id ?? item?.tabId);
            const conversationId = chatGptConversationIdFromUrl(item?.url);
            if (!conversationId || !Number.isSafeInteger(tabId) || tabId < 1)
                continue;
            if (open.has(conversationId))
                duplicated.add(conversationId);
            else
                open.set(conversationId, { tabId, conversationId, title: safeTitle(item.title) || "ChatGPT conversation",
                    canonicalUrl: String(item.url), opened: true, projectId: null, projectName: null });
        }
        // The provider's rendered navigation is the only source of historical
        // chats. It is a bounded, possibly incomplete view, not an account API.
        // Prefer the selected tab so a task-bound session stays the read authority.
        const homeObserver = raw.find(item => item?.url === "https://chatgpt.com/"
            && Number.isSafeInteger(Number(item.id ?? item.tabId))
            && Number(item.id ?? item.tabId) > 0);
        const observer = ([...open.values()].find(t => t.tabId === selected?.tabId)
            || [...open.values()][0])?.tabId
            ?? (homeObserver ? Number(homeObserver.id ?? homeObserver.tabId) : undefined);
        const ordered = new Map();
        let sidebarPartial = true;
        let projects = [];
        if (observer && Number(browserBridge.snapshot()?.contexts?.user?.extension?.capabilityVersions?.chatBridge || 0) >= 13) {
            try {
                const report = await call("chat_bridge.sidebar", { tabId: observer }, 12_000);
                if (report?.tabId === observer && Array.isArray(report.threads)) {
                    for (const entry of report.threads.slice(0, 100)) {
                        const id = String(entry?.conversationId || "");
                        if (!/^[a-zA-Z0-9-]{8,160}$/u.test(id) || duplicated.has(id)
                            || ordered.has(id) || typeof entry?.title !== "string" || typeof entry?.canonicalUrl !== "string"
                            || chatGptConversationIdFromUrl(entry.canonicalUrl) !== id)
                            continue;
                        const opened = open.get(id);
                        ordered.set(id, opened
                            ? { ...opened, title: safeTitle(entry.title), projectId: entry.projectId || null,
                                projectName: safeTitle(entry.projectName || "") || null }
                            : { tabId: observer, conversationId: id, title: safeTitle(entry.title),
                                canonicalUrl: entry.canonicalUrl, opened: false,
                                projectId: entry.projectId || null, projectName: safeTitle(entry.projectName || "") || null });
                    }
                    if (Array.isArray(report.projects))
                        projects = report.projects.slice(0, 50)
                            .filter((item) => typeof item?.id === "string" && /^g-p-[a-zA-Z0-9-]{8,100}$/u.test(item.id)
                            && typeof item?.name === "string" && item.name.trim())
                            .map((item) => ({ id: item.id, name: safeTitle(item.name) }));
                    sidebarPartial = true;
                }
            }
            catch {
                // A redesign of ChatGPT's navigation must not make open tabs vanish.
            }
        }
        for (const thread of open.values())
            if (!duplicated.has(thread.conversationId) && !ordered.has(thread.conversationId))
                ordered.set(thread.conversationId, thread);
        return { browserInstanceId, duplicateCount: duplicated.size,
            observerTabId: observer ?? null,
            source: "visible-sidebar", partial: sidebarPartial, projects,
            threads: [...ordered.values()].slice(0, 100).map(t => ({ ...t,
                selected: selected?.conversationId === t.conversationId && selected?.tabId === t.tabId })) };
    };
    const search = async (value) => {
        if (!value || typeof value !== "object" || Array.isArray(value))
            invalid("Invalid chat search.");
        const body = value;
        if (Object.keys(body).length !== 1 || typeof body.query !== "string"
            || body.query.trim().length < 2 || [...body.query].length > 120
            || /[\x00-\x1f\x7f]/u.test(body.query))
            invalid("Chat search requires 2–120 characters.");
        const browserInstanceId = context();
        if (Number(browserBridge.snapshot()?.contexts?.user?.extension?.capabilityVersions?.chatBridge || 0) < 13)
            invalid("Update Equinox Browser to use full conversation search.");
        const current = selected;
        const observer = current?.tabId ?? (await list()).observerTabId;
        if (!observer)
            invalid("Open ChatGPT in Chrome before searching your conversations.");
        const revision = selectedRevision;
        const report = await call("chat_bridge.search", { tabId: observer, query: body.query.trim() }, 20_000);
        if (context() !== browserInstanceId || revision !== selectedRevision
            || (current && selected?.tabId !== current.tabId))
            invalid("The ChatGPT browser session or selected conversation changed during search.");
        if (report?.tabId !== observer || typeof report.ticket !== "string"
            || !Array.isArray(report.items) || report.items.length > 60)
            invalid("The provider did not confirm the current search result.");
        const threads = [];
        const unique = new Set();
        for (const item of report.items) {
            if (typeof item?.conversationId !== "string" || typeof item?.canonicalUrl !== "string"
                || chatGptConversationIdFromUrl(item.canonicalUrl) !== item.conversationId
                || typeof item.title !== "string" || unique.has(item.conversationId))
                continue;
            unique.add(item.conversationId);
            threads.push({ tabId: observer, conversationId: item.conversationId, title: safeTitle(item.title),
                canonicalUrl: item.canonicalUrl, opened: false, projectId: null, projectName: null,
                excerpt: typeof item.excerpt === "string" ? item.excerpt.slice(0, 250) : "", searchTicket: report.ticket });
        }
        searched = { query: body.query.trim(), ticket: report.ticket, tabId: observer,
            browserInstanceId, checkedAt: Date.now(), threads };
        return { query: searched.query, threads, partial: true, source: "provider-search-dialog" };
    };
    const createProject = async (value) => {
        if (!value || typeof value !== "object" || Array.isArray(value))
            invalid("Invalid ChatGPT project creation request.");
        const body = value;
        if (Object.keys(body).some(key => !["name", "memoryMode", "mutationId"].includes(key))
            || typeof body.name !== "string" || !body.name.trim()
            || body.name !== body.name.trim() || body.name.length > 80
            || /[\r\n\x00-\x1f\x7f]/u.test(body.name)
            || !["default", "project"].includes(String(body.memoryMode))
            || typeof body.mutationId !== "string"
            || !/^npc-[a-f0-9-]{36}$/u.test(body.mutationId))
            invalid("Project creation requires a valid name, memory choice and one-use identity.");
        const name = body.name, memoryMode = body.memoryMode, id = body.mutationId;
        const prior = projectCreateAttempts.get(id);
        if (prior) {
            if (prior.name !== name || prior.memoryMode !== memoryMode)
                invalid("Project creation id cannot be reused for a different project.");
            return prior.promise;
        }
        if (projectCreateBlocked)
            invalid("A previous project creation may have succeeded. Check ChatGPT before creating another project.");
        if (projectCreating || mutatingAction || selecting || creating || sending || pending || blocked)
            invalid("Finish the current ChatGPT action before creating a project.");
        if (projectCreateAttempts.size >= 20)
            invalid("Project creation request limit reached for this runtime.");
        const browserInstanceId = context();
        if (Number(browserBridge.snapshot()?.contexts?.user?.extension?.capabilityVersions?.chatBridge || 0) < 13)
            invalid("Project creation requires Equinox Browser Chat Bridge 13.");
        projectCreating = true;
        mutatingAction = true; // Reserve before async discovery to prevent concurrent project saves.
        let current;
        let observer;
        try {
            current = await list();
            if (current.browserInstanceId !== browserInstanceId)
                invalid("Chrome changed during project creation.");
            const existing = current.projects;
            if (existing.some(item => item.name === name))
                invalid("A project with this exact name is already visible in ChatGPT.");
            observer = selected?.tabId ?? current.observerTabId;
            if (!Number.isSafeInteger(observer) || Number(observer) < 1)
                invalid("Open ChatGPT in your connected Chrome before creating a project.");
        }
        catch (error) {
            projectCreating = false;
            mutatingAction = false;
            throw error;
        }
        const revision = selectedRevision;
        const promise = (async () => {
            try {
                const result = await call("chat_bridge.project_create", {
                    tabId: observer, name, memoryMode, mutationId: id
                }, 36_000);
                if (result?.confirmed !== true || typeof result.projectId !== "string"
                    || !/^g-p-[a-zA-Z0-9-]{8,100}$/u.test(result.projectId)
                    || result.name !== name || result.memoryMode !== memoryMode
                    || result.canonicalUrl !== "https://chatgpt.com/g/" + result.projectId + "/project")
                    invalid("Chrome did not confirm a durable project with the requested memory choice.");
                if (context() !== browserInstanceId || selectedRevision !== revision)
                    invalid("The source Chrome session changed while creating the project.");
                return { confirmed: true, projectId: result.projectId, name,
                    memoryMode, canonicalUrl: result.canonicalUrl };
            }
            catch (error) {
                // The browser may have submitted just before disconnect/timeout.
                // No subsequent project receipt is admitted in this runtime.
                projectCreateBlocked = true;
                throw error;
            }
            finally {
                projectCreating = false;
                mutatingAction = false;
            }
        })();
        projectCreateAttempts.set(id, { name, memoryMode, promise });
        return promise;
    };
    const editProjectInstructions = async (value) => {
        if (!value || typeof value !== "object" || Array.isArray(value))
            invalid("Invalid project instructions request.");
        const body = value;
        if (Object.keys(body).some(key => !["projectId", "name", "expectedInstructions", "instructions", "mutationId"].includes(key))
            || typeof body.projectId !== "string" || !/^g-p-[a-zA-Z0-9-]{8,100}$/u.test(body.projectId)
            || typeof body.name !== "string" || !body.name.trim() || body.name.length > 120
            || typeof body.expectedInstructions !== "string" || body.expectedInstructions.length > 4000
            || typeof body.instructions !== "string" || body.instructions.length > 4000
            || body.instructions === body.expectedInstructions
            || typeof body.mutationId !== "string" || !/^npi-[a-f0-9-]{36}$/u.test(body.mutationId))
            invalid("Project instruction edits need an exact project and previous value.");
        const key = body.mutationId, fingerprint = JSON.stringify(body);
        const prior = projectInstructionAttempts.get(key);
        if (prior) {
            if (prior.fingerprint !== fingerprint)
                invalid("Project instruction receipt cannot be reused for another edit.");
            return prior.promise;
        }
        if (projectInstructionBlocked || projectInstructionsUpdating)
            invalid("An earlier project instruction edit may have succeeded. Check ChatGPT first.");
        if (mutatingAction || selecting || creating || sending || pending || blocked || projectCreating)
            invalid("Finish the active ChatGPT operation before editing instructions.");
        if (projectInstructionAttempts.size >= 20)
            invalid("Project instruction edit limit reached for this runtime.");
        const browserInstanceId = context();
        if (Number(browserBridge.snapshot()?.contexts?.user?.extension?.capabilityVersions?.chatBridge || 0) < 13)
            invalid("Project instruction edits require Equinox Browser Chat Bridge 13.");
        projectInstructionsUpdating = true;
        mutatingAction = true; // Claim the shared mutation boundary before async sidebar discovery.
        let observer;
        try {
            const projects = await list();
            if (projects.browserInstanceId !== browserInstanceId)
                invalid("Chrome changed during project instruction editing.");
            const choice = projects.projects.find(item => item.id === body.projectId && item.name === body.name);
            if (!choice)
                invalid("The exact project is no longer in the ChatGPT sidebar.");
            observer = selected?.tabId ?? projects.observerTabId;
            if (!observer || browsedProject?.projectId !== body.projectId
                || browsedProject.tabId !== observer || browsedProject.browserInstanceId !== browserInstanceId
                || Date.now() - browsedProject.checkedAt > 5 * 60_000)
                invalid("Open the selected project in Native Chat before editing its instructions.");
        }
        catch (error) {
            projectInstructionsUpdating = false;
            mutatingAction = false;
            throw error;
        }
        const revision = selectedRevision;
        const promise = (async () => {
            try {
                const result = await call("chat_bridge.project_instructions", {
                    tabId: observer, projectId: body.projectId, name: body.name,
                    expectedInstructions: body.expectedInstructions, newInstructions: body.instructions,
                    mutationId: key
                }, 38_000);
                if (result?.confirmed !== true || result.projectId !== body.projectId
                    || result.name !== body.name || result.instructions !== body.instructions
                    || context() !== browserInstanceId || selectedRevision !== revision)
                    invalid("The provider did not confirm the exact project instructions change.");
                return { confirmed: true, projectId: body.projectId, name: body.name,
                    instructions: body.instructions };
            }
            catch (error) {
                // A Save can succeed just before a transport timeout. No silent retry.
                projectInstructionBlocked = true;
                throw error;
            }
            finally {
                projectInstructionsUpdating = false;
                mutatingAction = false;
            }
        })();
        projectInstructionAttempts.set(key, { fingerprint, promise });
        return promise;
    };
    const addProjectTextSource = async (value) => {
        if (!value || typeof value !== "object" || Array.isArray(value))
            invalid("Invalid project text source request.");
        const body = value;
        if (Object.keys(body).some(key => !["projectId", "name", "title", "text", "mutationId"].includes(key))
            || typeof body.projectId !== "string" || !/^g-p-[a-zA-Z0-9-]{8,100}$/u.test(body.projectId)
            || typeof body.name !== "string" || !body.name.trim() || body.name.length > 120
            || typeof body.title !== "string" || body.title !== body.title.trim()
            || !body.title || body.title.length > 80 || /[\r\n\x00-\x1f\x7f]/u.test(body.title)
            || typeof body.text !== "string" || !body.text.trim() || body.text.length > 12000
            || /\x00/u.test(body.text) || typeof body.mutationId !== "string"
            || !/^nps-[a-f0-9-]{36}$/u.test(body.mutationId))
            invalid("Project text source requires an exact project, title, text and one-use receipt.");
        const key = body.mutationId, fingerprint = JSON.stringify(body);
        const prior = projectTextAttempts.get(key);
        if (prior) {
            if (prior.fingerprint !== fingerprint)
                invalid("Project source receipt cannot be reused for a different source.");
            return prior.promise;
        }
        if (projectTextBlocked || projectTextAdding)
            invalid("A project source may have been saved. Inspect ChatGPT before attempting another.");
        if (mutatingAction || selecting || creating || sending || pending || blocked
            || projectCreating || projectInstructionsUpdating)
            invalid("Finish the current ChatGPT action before adding project text.");
        if (projectTextAttempts.size >= 20)
            invalid("Project source operation limit reached for this runtime.");
        const browserInstanceId = context();
        if (Number(browserBridge.snapshot()?.contexts?.user?.extension?.capabilityVersions?.chatBridge || 0) < 13)
            invalid("Text sources require Equinox Browser Chat Bridge v13.");
        projectTextAdding = true;
        mutatingAction = true;
        let observer;
        try {
            const projects = await list();
            if (projects.browserInstanceId !== browserInstanceId)
                invalid("The personal Chrome session changed.");
            if (!projects.projects.some(item => item.id === body.projectId && item.name === body.name))
                invalid("The exact project is missing from the current ChatGPT sidebar.");
            observer = selected?.tabId ?? projects.observerTabId;
            if (!observer || browsedProject?.projectId !== body.projectId
                || browsedProject.tabId !== observer || browsedProject.browserInstanceId !== browserInstanceId
                || Date.now() - browsedProject.checkedAt > 5 * 60_000)
                invalid("Browse the exact project in Native Chat before adding its source.");
        }
        catch (error) {
            projectTextAdding = false;
            mutatingAction = false;
            throw error;
        }
        const revision = selectedRevision;
        const promise = (async () => {
            try {
                const result = await call("chat_bridge.project_text_source", {
                    tabId: observer, projectId: body.projectId, name: body.name,
                    title: body.title, text: body.text, mutationId: key
                }, 44_000);
                if (result?.confirmed !== true || result.projectId !== body.projectId
                    || result.name !== body.name || result.title !== body.title
                    || typeof result.fileName !== "string" || !result.fileName
                    || result.fileName.length > 200 || context() !== browserInstanceId
                    || selectedRevision !== revision)
                    invalid("The provider did not confirm the durable text source and its exact identity.");
                return { confirmed: true, projectId: body.projectId, name: body.name,
                    title: body.title, fileName: result.fileName };
            }
            catch (error) {
                projectTextBlocked = true; // Provider may have committed just before Chrome/IPC timeout.
                throw error;
            }
            finally {
                projectTextAdding = false;
                mutatingAction = false;
            }
        })();
        projectTextAttempts.set(key, { fingerprint, promise });
        return promise;
    };
    const project = async (value) => {
        if (!value || typeof value !== "object" || Array.isArray(value))
            invalid("Invalid ChatGPT project request.");
        const body = value;
        if (Object.keys(body).length !== 1 || typeof body.projectId !== "string"
            || !/^g-p-[a-zA-Z0-9-]{8,100}$/u.test(body.projectId))
            invalid("Project browsing requires an observed ChatGPT project.");
        const available = await list();
        const choice = available.projects.find(item => item.id === body.projectId);
        if (!choice)
            invalid("The selected project is not present in the current ChatGPT sidebar.");
        const browserInstanceId = available.browserInstanceId;
        const observer = selected?.tabId ?? available.observerTabId;
        if (!observer)
            invalid("A connected ChatGPT conversation is required to browse projects.");
        const revision = selectedRevision;
        const report = await call("chat_bridge.project", { tabId: observer, projectId: body.projectId }, 30_000);
        if (context() !== browserInstanceId || revision !== selectedRevision
            || report?.tabId !== observer || report?.projectId !== body.projectId
            || typeof report.ticket !== "string" || !Array.isArray(report.items))
            invalid("The project or Chrome session changed during browsing.");
        const threads = [];
        const seen = new Set();
        for (const item of report.items.slice(0, 100)) {
            if (typeof item?.conversationId !== "string" || typeof item?.canonicalUrl !== "string"
                || typeof item.title !== "string" || seen.has(item.conversationId)
                || chatGptConversationIdFromUrl(item.canonicalUrl) !== item.conversationId)
                continue;
            seen.add(item.conversationId);
            threads.push({ tabId: observer, conversationId: item.conversationId, title: safeTitle(item.title),
                canonicalUrl: item.canonicalUrl, opened: false, projectId: choice.id,
                projectName: choice.name, searchTicket: report.ticket });
        }
        browsedProject = { projectId: choice.id, tabId: observer, browserInstanceId,
            checkedAt: Date.now(), threads };
        const raw = report.settings;
        const settings = raw && typeof raw === "object" && !Array.isArray(raw)
            && typeof raw.instructions === "string" && raw.instructions.length <= 4000
            && typeof raw.instructionsTruncated === "boolean"
            && typeof raw.memoryLabel === "string" && raw.memoryLabel.length <= 80
            && Object.keys(raw).every(key => ["instructions", "instructionsTruncated", "memoryLabel"].includes(key))
            ? { instructions: raw.instructions, instructionsTruncated: raw.instructionsTruncated,
                memoryLabel: raw.memoryLabel } : null;
        const observed = report.sources;
        const sources = observed && typeof observed === "object" && !Array.isArray(observed)
            && Array.isArray(observed.items) && observed.items.length <= 40
            && observed.partial === true && typeof observed.confirmedEmpty === "boolean"
            && observed.items.every((item) => item && typeof item === "object"
                && Object.keys(item).every(key => ["name", "kind"].includes(key))
                && typeof item.name === "string" && item.name.length >= 1 && item.name.length <= 200
                && typeof item.kind === "string" && item.kind.length <= 70)
            && (!observed.confirmedEmpty || observed.items.length === 0)
            ? { items: observed.items.map((item) => ({ name: item.name, kind: item.kind })),
                partial: true, confirmedEmpty: observed.confirmedEmpty } : null;
        return { projectId: choice.id, name: choice.name, threads, settings, sources,
            partial: true, source: "visible-project" };
    };
    const conversationAction = async (value) => {
        if (!value || typeof value !== "object" || Array.isArray(value))
            invalid("Invalid ChatGPT conversation action request.");
        const body = value;
        if (Object.keys(body).some(k => !["tabId", "conversationId", "action", "expectedTitle", "title", "mutationId",
            "targetProjectId", "sharedUrl"].includes(k))
            || !Number.isSafeInteger(body.tabId) || Number(body.tabId) < 1
            || typeof body.conversationId !== "string" || !/^[a-zA-Z0-9-]{8,160}$/u.test(body.conversationId)
            || !["inspect", "pin", "rename", "move", "archive", "delete", "share", "unshare"].includes(String(body.action))
            || (body.action === "move" && (typeof body.targetProjectId !== "string"
                || !/^g-p-[a-zA-Z0-9-]{8,100}$/u.test(body.targetProjectId)))
            || (body.action !== "move" && body.targetProjectId !== undefined)
            || (body.action === "unshare" && (typeof body.sharedUrl !== "string"
                || !/^https:\/\/chatgpt\.com\/share\/[a-zA-Z0-9-]{10,120}$/u.test(body.sharedUrl)))
            || (body.action !== "unshare" && body.sharedUrl !== undefined)
            || (body.action !== "inspect" && (typeof body.expectedTitle !== "string"
                || !body.expectedTitle.trim() || body.expectedTitle.length > 120))
            || (body.action === "rename" && (typeof body.title !== "string"
                || !body.title.trim() || body.title.length > 120 || /[\x00-\x1f\x7f]/u.test(body.title)))
            || (body.action !== "rename" && body.title !== undefined)
            || (body.action === "inspect" && (body.mutationId !== undefined || body.expectedTitle !== undefined))
            || (body.action !== "inspect" && (typeof body.mutationId !== "string"
                || !/^cma-[a-f0-9-]{36}$/u.test(body.mutationId))))
            invalid("Conversation action requires exact identity, requested operation and valid title.");
        const fingerprint = JSON.stringify(body);
        const key = body.mutationId;
        if (key) {
            const prior = actionAttempts.get(key);
            if (prior) {
                if (prior.fingerprint !== fingerprint)
                    invalid("Conversation action id cannot be reused for a different operation.");
                return prior.promise;
            }
            if (actionAttempts.size >= 256)
                invalid("Conversation actions reached the current runtime limit.");
            if (mutatingAction || selecting || sending || creating || pending || blocked)
                invalid("Finish any pending ChatGPT action or delivery before changing conversations.");
            mutatingAction = true;
        }
        const perform = (async () => {
            try {
                const available = await list();
                const tabId = Number(body.tabId), id = String(body.conversationId);
                const thread = available.threads.find(t => t.tabId === tabId && t.conversationId === id)
                    || (searched && Date.now() - searched.checkedAt < 90_000
                        && searched.browserInstanceId === available.browserInstanceId
                        ? searched.threads.find(t => t.tabId === tabId && t.conversationId === id) : null)
                    || (browsedProject && Date.now() - browsedProject.checkedAt < 90_000
                        && browsedProject.browserInstanceId === available.browserInstanceId
                        ? browsedProject.threads.find(t => t.tabId === tabId && t.conversationId === id) : null);
                if (!thread)
                    invalid("The selected chat is not in the current provider history.");
                if (key && body.expectedTitle !== thread.title)
                    invalid("The selected chat title changed. Refresh its actions.");
                const destination = body.action === "move"
                    ? available.projects.find(project => project.id === body.targetProjectId) : null;
                if (body.action === "move") {
                    if (!destination || available.projects.filter(project => project.name === destination.name).length !== 1)
                        invalid("The requested ChatGPT project is missing or its name is ambiguous.");
                    if (thread.projectId === destination.id)
                        invalid("This conversation is already in the selected project.");
                    if (selected?.conversationId === id && selected?.tabId === tabId)
                        invalid("The active Native Chat conversation cannot move projects until its Task Capsule binding is safely refreshed. Select another chat first.");
                }
                if (["archive", "delete"].includes(String(body.action))
                    && selected?.conversationId === id && selected?.tabId === tabId)
                    invalid("The active Native Chat conversation cannot be archived or deleted while its Task Capsule binding is attached.");
                const revision = selectedRevision;
                const response = await call("chat_bridge.conversation_action", {
                    tabId, conversationId: id, canonicalUrl: thread.canonicalUrl,
                    ...("searchTicket" in thread ? { searchTicket: thread.searchTicket } : {}),
                    action: body.action,
                    ...(key ? { expectedTitle: thread.title } : {}),
                    ...(body.action === "rename" ? { title: String(body.title).trim() } : {}),
                    ...(destination ? { targetProjectId: destination.id, targetProjectName: destination.name } : {}),
                    ...(body.action === "unshare" ? { sharedUrl: body.sharedUrl } : {}),
                }, body.action === "unshare" ? 35_000 : 20_000);
                if (context() !== available.browserInstanceId || selectedRevision !== revision
                    || response?.tabId !== tabId || response?.conversationId !== id
                    || response?.action !== body.action || response?.available !== true
                    || (destination && response.projectId !== destination.id))
                    throw new Error("The ChatGPT conversation action lost its exact identity.");
                if (key && response.confirmed !== true)
                    throw new Error("ChatGPT did not confirm this change. Check the provider before retrying.");
                if (body.action === "unshare" && response.revoked !== true)
                    throw new Error("ChatGPT could not verify that the public link was revoked.");
                if (body.action === "share") {
                    if (typeof response.sharedUrl !== "string"
                        || !/^https:\/\/chatgpt\.com\/share\/[a-zA-Z0-9-]{10,120}$/u.test(response.sharedUrl))
                        throw new Error("The provider created a share link but did not confirm its URL. Check existing shared links before retrying.");
                }
                return response;
            }
            finally {
                if (key)
                    mutatingAction = false;
            }
        })();
        if (key)
            actionAttempts.set(key, { fingerprint, promise: perform });
        return perform;
    };
    const model = async (value) => {
        if (value.action === "catalog") {
            const instance = context();
            if (Number(browserBridge.snapshot()?.contexts?.user?.extension?.capabilityVersions?.chatBridge || 0) < 13)
                invalid("Equinox Browser must support Native Chat model discovery.");
            const info = await call("chat_bridge.model_catalog", {}, 15_000);
            if (context() !== instance)
                invalid("The connected Browser changed during model discovery.");
            if (info?.available !== true || info?.discovered !== true || !Array.isArray(info.choices))
                invalid("ChatGPT did not confirm available new-chat models.");
            return info;
        }
        const target = selected;
        if (!target)
            return { available: false, reason: "no-conversation", choices: [] };
        if (Number(browserBridge.snapshot()?.contexts?.user?.extension?.capabilityVersions?.chatBridge || 0) < 13)
            return { available: false, reason: "browser-upgrade-required", choices: [] };
        if (value.action !== "read" && (selecting || sending || creating || pending || blocked || mutatingAction))
            invalid("Cannot change ChatGPT model settings while the conversation is busy or uncertain.");
        const revision = selectedRevision;
        const info = await call("chat_bridge.model", { tabId: target.tabId, conversationId: target.conversationId, ...value }, 12_000);
        if (revision !== selectedRevision || selected?.tabId !== target.tabId
            || selected?.conversationId !== target.conversationId || selected?.browserInstanceId !== target.browserInstanceId)
            throw new Error("Model selection changed conversations; refresh the model controls.");
        if (info?.tabId !== target.tabId || info?.conversationId !== target.conversationId)
            throw new Error("Browser did not confirm the model selector's conversation.");
        return info;
    };
    const select = async (value) => {
        if (!value || typeof value !== "object" || Array.isArray(value))
            invalid("Invalid conversation selection.");
        const object = value;
        if (Object.keys(object).length !== 2 || typeof object.conversationId !== "string" || !Number.isSafeInteger(object.tabId))
            invalid("Invalid conversation selection.");
        if (selecting || sending || creating || pending || mutatingAction)
            invalid("Cannot switch conversations while an action or message is in flight.");
        selecting = true;
        try {
            const available = await list();
            const tab = available.threads.find(t => t.tabId === object.tabId && t.conversationId === object.conversationId)
                || (searched && Date.now() - searched.checkedAt < 90_000
                    && searched.browserInstanceId === available.browserInstanceId
                    ? searched.threads.find(t => t.tabId === object.tabId && t.conversationId === object.conversationId)
                    : null)
                || (browsedProject && Date.now() - browsedProject.checkedAt < 90_000
                    && browsedProject.browserInstanceId === available.browserInstanceId
                    ? browsedProject.threads.find(t => t.tabId === object.tabId && t.conversationId === object.conversationId)
                    : null);
            if (!tab)
                invalid("This ChatGPT conversation is no longer in recent history or the current search.");
            // For a historical sidebar row, navigate the one verified user browser
            // tab only after the bridge proves the exact link, no active generation and
            // no unsent Chrome draft/attachments. Never reuse another thread's state.
            if (!tab.opened) {
                const result = await call("chat_bridge.open_history", { tabId: tab.tabId, conversationId: tab.conversationId, canonicalUrl: tab.canonicalUrl,
                    searchTicket: "searchTicket" in tab ? tab.searchTicket : undefined }, 18_000);
                if (result?.tabId !== tab.tabId || result?.conversationId !== tab.conversationId
                    || result?.canonicalUrl !== tab.canonicalUrl)
                    invalid("ChatGPT did not confirm the selected historical conversation.");
            }
            const next = { browserContext: "user", browserInstanceId: available.browserInstanceId, tabId: tab.tabId, conversationId: tab.conversationId, canonicalUrl: tab.canonicalUrl };
            // A project-scoped URL may be needed to follow the browser's exact conversation identity.
            // Only the browser bridge, never the UI, supplies the canonical URL.
            const raw = await call("tabs.list", {});
            const source = raw.find(t => Number(t.id ?? t.tabId) === tab.tabId && chatGptConversationIdFromUrl(t.url) === tab.conversationId);
            if (!source?.url)
                invalid("Conversation identity changed during selection.");
            next.canonicalUrl = source.url;
            const inspected = await chatBridge.inspectTurnIdentity({ binding: next });
            const confirmed = inspected?.binding;
            if (!confirmed || confirmed.browserContext !== "user"
                || confirmed.browserInstanceId !== next.browserInstanceId
                || confirmed.tabId !== next.tabId
                || confirmed.conversationId !== next.conversationId)
                invalid("The selected Chrome tab changed during selection. Re-select the conversation.");
            // A conversation reopened in a different Chrome tab is a different
            // authenticated transport binding. Never reuse that tab's stale history,
            // preview or task-specific send state merely because its URL ID matches.
            const changed = selected?.conversationId !== next.conversationId
                || selected?.browserInstanceId !== next.browserInstanceId
                || selected?.tabId !== next.tabId
                || selected?.canonicalUrl !== next.canonicalUrl;
            if (changed) {
                selectedRevision++;
                messages = [];
                pending = null;
                stoppedTurn = null;
                awaitingNewChatIdentity = awaitingFirstTurns.get(conversationKey(next)) ?? null;
                blocked = uncertainConversations.has(conversationKey(next)) || Boolean(awaitingNewChatIdentity);
                history = [];
                historyPartial = false;
                historyPendingHydration = 0;
                previousHistoryGeneration = false;
                historyNotice = awaitingNewChatIdentity
                    ? "This New Chat is still waiting for its first response identity in Chrome."
                    : blocked ? "A previous delivery in this conversation is uncertain. Inspect it in Chrome before sending again." : null;
            }
            selected = next;
            if (changed) {
                try {
                    await restoreTaskBinding(next);
                }
                catch {
                    // Task discovery is optional; errors must not break the Chat transport.
                    associatedTasks.delete(conversationKey(next));
                }
                try {
                    const value = await chatBridge.readRecent?.({ binding: next });
                    if (value?.tabId !== undefined && value.tabId !== next.tabId)
                        throw new Error("Recent history came from another Chrome tab.");
                    if (value && Array.isArray(value.items)) {
                        history = value.items.slice(-48).map((item) => ({ id: String(item.id).slice(0, 220), role: item.role,
                            text: String(item.text).slice(0, 14000), status: "complete", truncated: item.truncated === true,
                            richText: typeof item.richText === "string" && item.role === "assistant" && [...item.richText].length <= 5000 ? item.richText : null,
                            versionsAvailable: item.role === "assistant" && item.versionsAvailable === true,
                            hasRichMedia: item.role === "assistant" && item.hasRichMedia === true,
                            ...providerUserAttachments(item) }));
                        historyPartial = value.partial === true;
                        // Navigation may finish before ChatGPT hydrates its transcript.
                        // Retry at most five subsequent normal reads without a new send.
                        if (!history.length && Number(value.observedTurns) === 0)
                            historyPendingHydration = 5;
                    }
                    else
                        historyNotice = "Recent conversation history is not available with this Browser version.";
                }
                catch {
                    historyNotice = "Recent history unavailable. You can still send messages in this conversation.";
                }
            }
            return await read();
        }
        finally {
            selecting = false;
        }
    };
    const read = async () => {
        if (!selected)
            return { selected: null, items: [], turn: "unbound", blocked: false, creationBlocked, limitedHistory: true };
        const initialBinding = selected;
        const startingRevision = selectedRevision;
        const sameSelection = () => selectedRevision === startingRevision
            && selected?.browserInstanceId === initialBinding.browserInstanceId
            && selected?.conversationId === initialBinding.conversationId
            && selected?.tabId === initialBinding.tabId;
        const staleResult = () => ({ selected: { conversationId: selected.conversationId, tabId: selected.tabId, browserInstanceId: selected.browserInstanceId },
            items: [], turn: "waiting", sending, blocked: true, preview: null,
            notice: "Conversation changed while reading. Refresh the selected conversation.",
            limitedHistory: true, historyCount: 0, creationBlocked });
        let turn = "idle";
        let notice = null;
        let preview = null;
        try {
            const inspected = await chatBridge.inspectTurnIdentity({ binding: initialBinding });
            if (!sameSelection())
                return staleResult();
            const current = inspected?.binding;
            if (!current || current.browserContext !== "user"
                || current.conversationId !== initialBinding.conversationId
                || current.browserInstanceId !== initialBinding.browserInstanceId
                || current.tabId !== initialBinding.tabId) {
                throw Object.assign(new Error("The selected Chrome tab changed. Select the conversation again from the sidebar."), { code: "CHAT_BRIDGE_TAB_CHANGED" });
            }
            selected = current;
            const generatingNow = inspected?.generationActive === true;
            turn = generatingNow ? "generating" : inspected?.status === "waiting" ? "waiting" : "ready";
            // Conversations selected while generating have no local send receipt.
            // Refresh their bounded history once when the observed generation ends.
            if (!generatingNow && previousHistoryGeneration && !pending && !messages.length && chatBridge.readRecent) {
                previousHistoryGeneration = false;
                try {
                    const fresh = await chatBridge.readRecent({ binding: initialBinding });
                    if (!sameSelection())
                        return staleResult();
                    if (fresh?.tabId !== undefined && fresh.tabId !== initialBinding.tabId)
                        throw Object.assign(new Error("The selected Chrome tab changed while refreshing history."), { code: "CHAT_BRIDGE_TAB_CHANGED" });
                    if (Array.isArray(fresh?.items)) {
                        history = fresh.items.slice(-48).map((item) => ({
                            id: String(item.id).slice(0, 220), role: item.role, text: String(item.text).slice(0, 14000),
                            status: "complete", truncated: item.truncated === true,
                            richText: typeof item.richText === "string" && item.role === "assistant" && [...item.richText].length <= 5000 ? item.richText : null,
                            versionsAvailable: item.role === "assistant" && item.versionsAvailable === true,
                            hasRichMedia: item.role === "assistant" && item.hasRichMedia === true,
                            ...providerUserAttachments(item),
                        }));
                        historyPartial = fresh.partial === true;
                    }
                }
                catch {
                    historyNotice = "Recent conversation history could not be refreshed after generation.";
                }
            }
            if (generatingNow)
                previousHistoryGeneration = true;
            if (!generatingNow && !pending && historyPendingHydration > 0 && chatBridge.readRecent) {
                historyPendingHydration--;
                try {
                    const fresh = await chatBridge.readRecent({ binding: initialBinding });
                    if (!sameSelection())
                        return staleResult();
                    if (Array.isArray(fresh?.items) && fresh.items.length) {
                        history = fresh.items.slice(-48).map((item) => ({
                            id: String(item.id).slice(0, 220), role: item.role, text: String(item.text).slice(0, 14000),
                            status: "complete", truncated: item.truncated === true,
                            richText: typeof item.richText === "string" && item.role === "assistant"
                                && [...item.richText].length <= 5000 ? item.richText : null,
                            versionsAvailable: item.role === "assistant" && item.versionsAvailable === true,
                            hasRichMedia: item.role === "assistant" && item.hasRichMedia === true,
                            ...providerUserAttachments(item),
                        }));
                        historyPartial = fresh.partial === true;
                        const stopped = stoppedTurn;
                        if (stopped && fresh.items.some((item) => item.role === 'user'
                            && item.turnKey === stopped.userEpoch)) {
                            if (stopped.deliveryId && messages.some(item => item.id === stopped.deliveryId
                                && item.role === 'user' && item.status === 'sent'))
                                messages = messages.filter(item => item.id !== stopped.deliveryId);
                            // A visible user message alone is not proof that a stopped
                            // partial assistant response has finished hydrating.
                            if (fresh.items.some((item) => item.role === 'assistant'
                                && item.turnKey === stopped.userEpoch))
                                stoppedTurn = null;
                        }
                        if (!stoppedTurn)
                            historyPendingHydration = 0;
                    }
                }
                catch { /* A later explicit refresh can recover without replaying sends. */ }
                if (historyPendingHydration === 0)
                    stoppedTurn = null;
            }
            if (awaitingNewChatIdentity && inspected?.status === "ready" && typeof inspected.userEpoch === "string" && inspected.userEpoch) {
                // A fresh /c/ URL can precede the first user-turn epoch. Read-only
                // corroboration of the ONLY user message prevents accidentally claiming
                // a later manual Chrome turn as the opener. No prompt is resent.
                const awaiting = awaitingNewChatIdentity;
                if (selected.conversationId === awaiting.conversationId && chatBridge.readRecent) {
                    try {
                        const recent = await chatBridge.readRecent({ binding: initialBinding });
                        if (!sameSelection())
                            return staleResult();
                        if (recent?.tabId !== undefined && recent.tabId !== initialBinding.tabId)
                            throw new Error("New Chat read another Chrome tab.");
                        const users = Array.isArray(recent?.items) ? recent.items.filter((item) => item?.role === "user") : [];
                        const observedText = String(users[0]?.text || "").trim();
                        const lines = observedText.split(/\r?\n/u).map(line => line.trim());
                        const documents = Array.isArray(users[0]?.attachmentFileNames)
                            ? users[0].attachmentFileNames : [];
                        const imageCount = Number(users[0]?.attachmentImageCount);
                        const missing = awaiting.fileNames.filter(name => !documents.includes(name));
                        const filesMatch = awaiting.fileNames.length > 0
                            && documents.length + imageCount === awaiting.fileNames.length
                            && missing.length === imageCount
                            && documents.every(name => awaiting.fileNames.includes(name) && lines.includes(name))
                            && missing.every(name => /\.(?:png|jpe?g|webp|gif)$/iu.test(name))
                            && awaiting.fileNames.filter(name => documents.includes(name)).every((name, index) => name === documents[index]);
                        const promptMatch = awaiting.text ? lines.includes(awaiting.text) : true;
                        if (recent?.partial !== true && users.length === 1
                            && (awaiting.fileNames.length ? filesMatch && promptMatch : observedText === awaiting.text)) {
                            pending = { userEpoch: inspected.userEpoch, previousAssistantTurnKey: null, deliveryId: awaiting.deliveryId };
                            awaitingNewChatIdentity = null;
                            awaitingFirstTurns.delete(conversationKey(selected));
                            blocked = false;
                            historyNotice = null;
                        }
                    }
                    catch { /* Incomplete browser history is not proof of the first turn. */ }
                }
                if (awaitingNewChatIdentity)
                    notice = "New Chat is waiting for exact first-turn identity confirmation in Chrome. No message will be resent.";
            }
            if (awaitingNewChatIdentity)
                turn = "waiting";
            if (pending) {
                const receipt = pending;
                const result = await chatBridge.readFinal({ binding: initialBinding, userEpoch: receipt.userEpoch, previousAssistantTurnKey: receipt.previousAssistantTurnKey });
                if (!sameSelection())
                    return staleResult();
                if (result?.tabId !== undefined && result.tabId !== initialBinding.tabId)
                    throw Object.assign(new Error("The pending assistant response moved to another Chrome tab."), { code: "CHAT_BRIDGE_TAB_CHANGED" });
                if (result?.status === "ready") {
                    if (typeof result.text !== "string") {
                        throw Object.assign(new Error("The confirmed ChatGPT reply has no readable text payload."), { code: "CHAT_BRIDGE_READ_FAILED" });
                    }
                    // Polling and the post-send refresh can complete simultaneously.
                    // Only the first reader that still owns this receipt may append it.
                    if (pending === receipt) {
                        const reply = result.text;
                        appendMessage({ id: receipt.deliveryId + "-reply", role: "assistant", text: reply.slice(0, MAX_ASSISTANT_CHARS), status: "complete",
                            truncated: result.truncated === true || reply.length > MAX_ASSISTANT_CHARS,
                            richText: typeof result.richText === "string" && [...result.richText].length <= 14000 ? result.richText : null });
                        pending = null;
                    }
                    turn = "complete";
                }
                else
                    turn = inspected?.generationActive === true ? "generating" : "waiting";
            }
            // Preview is ephemeral. Only read it while the browser observer reports
            // active generation, and never append it to completed transcript items.
            if (turn === "generating" && inspected?.generationActive === true &&
                Number(browserBridge.snapshot()?.contexts?.user?.extension?.capabilityVersions?.chatBridge || 0) >= 11 &&
                typeof inspected.userEpoch === "string" && chatBridge.readLive) {
                const live = await chatBridge.readLive({ binding: initialBinding, userEpoch: inspected.userEpoch });
                if (!sameSelection())
                    return staleResult();
                if (live?.tabId !== undefined && live.tabId !== initialBinding.tabId)
                    throw Object.assign(new Error("The live assistant preview moved to another Chrome tab."), { code: "CHAT_BRIDGE_TAB_CHANGED" });
                if (live?.status === "generating" && typeof live.text === "string" && live.text)
                    preview = { text: live.text.slice(0, 3200), truncated: live.truncated === true || live.text.length > 3200,
                        richText: typeof live.richText === "string" && [...live.richText].length <= 4000 ? live.richText : null };
                else if (live?.status === "drifted")
                    throw Object.assign(new Error("Live Chat turn identity changed."), { code: "CHAT_BRIDGE_DRIFTED" });
            }
        }
        catch (error) {
            // A late error from conversation A must not mark newly selected B as
            // uncertain or disconnected. The stale-response guard below owns it.
            if (sameSelection()) {
                const code = error?.code;
                if (code === "CHAT_BRIDGE_TAB_CHANGED") {
                    // A read-only tab move is recoverable by explicit reselection.
                    // A pending/mutating send remains uncertain instead of migrating.
                    if (pending || sending) {
                        pending = null;
                        blocked = true;
                        uncertainConversations.add(conversationKey(selected));
                    }
                    turn = "disconnected";
                }
                else if (code === "CHAT_BRIDGE_DRIFTED" || code === "CHAT_BRIDGE_READ_FAILED") {
                    pending = null;
                    blocked = true;
                    uncertainConversations.add(conversationKey(selected));
                    turn = "disconnected";
                }
                else if (pending) {
                    turn = "waiting";
                }
                else
                    turn = "disconnected";
                notice = error instanceof Error ? error.message : "Browser conversation is unavailable.";
            }
        }
        // Browser reads can finish after another sidebar selection. Never
        // attribute a previous conversation's text/preview to the new selection.
        if (!sameSelection())
            return staleResult();
        const taskId = turn === "disconnected" ? null : await currentTaskId(initialBinding);
        const messageEditAllowed = await messageEditPermitted(initialBinding, taskId);
        if (!sameSelection())
            return staleResult();
        return { selected: { conversationId: selected.conversationId, tabId: selected.tabId, browserInstanceId: selected.browserInstanceId }, items: [...history, ...messages].slice(-80),
            turn, sending, blocked, creationBlocked, taskId, messageEditAllowed,
            preview, notice: notice || historyNotice, limitedHistory: historyPartial || !history.length, historyCount: history.length };
    };
    const stopGeneration = async (value) => {
        if (!value || typeof value !== "object" || Array.isArray(value))
            invalid("Invalid Stop response request.");
        const body = value;
        if (Object.keys(body).some(key => !["tabId", "conversationId", "mutationId"].includes(key))
            || !Number.isSafeInteger(body.tabId) || Number(body.tabId) < 1
            || typeof body.conversationId !== "string"
            || !/^[a-zA-Z0-9-]{8,160}$/u.test(body.conversationId)
            || typeof body.mutationId !== "string"
            || !/^msp-[a-f0-9-]{36}$/u.test(body.mutationId))
            invalid("Stop response requires the exact selected conversation and one-use identity.");
        const id = body.mutationId, prior = stopAttempts.get(id);
        if (prior) {
            if (!selected || prior.conversationKey !== conversationKey(selected)
                || prior.tabId !== selected.tabId || selected.tabId !== body.tabId
                || selected.conversationId !== body.conversationId)
                invalid("Stop response identity cannot be reused for another conversation.");
            return prior.promise;
        }
        if (stopAttempts.size >= 256)
            invalid("The current Native Chat session reached its bounded Stop limit.");
        if (!selected || selecting || sending || creating || blocked || mutatingAction
            || selected.tabId !== body.tabId || selected.conversationId !== body.conversationId)
            invalid("Select one active, unblocked ChatGPT conversation before stopping a reply.");
        const binding = selected, revision = selectedRevision;
        if (Number(browserBridge.snapshot()?.contexts?.user?.extension?.capabilityVersions?.chatBridge || 0) < 13)
            invalid("Update Equinox Browser before using Stop response.");
        const observed = await chatBridge.inspectTurnIdentity({ binding });
        if (selectedRevision !== revision || !selected || selected.tabId !== binding.tabId
            || conversationKey(selected) !== conversationKey(binding)
            || sending || creating || blocked || mutatingAction
            || observed?.generationActive !== true
            || typeof observed?.userEpoch !== 'string' || !observed.userEpoch
            || (pending !== null && pending.userEpoch !== observed.userEpoch)
            || observed?.binding?.tabId !== binding.tabId
            || observed?.binding?.conversationId !== binding.conversationId
            || observed?.binding?.browserInstanceId !== binding.browserInstanceId)
            invalid("The selected ChatGPT response is not actively generating.");
        mutatingAction = true;
        const promise = (async () => {
            try {
                const result = await call("chat_bridge.stop_generation", {
                    tabId: binding.tabId, conversationId: binding.conversationId, mutationId: id,
                }, 12_000);
                if (selectedRevision !== revision || !selected
                    || selected.tabId !== binding.tabId || conversationKey(selected) !== conversationKey(binding)
                    || result?.tabId !== binding.tabId || result?.conversationId !== binding.conversationId)
                    throw new Error("Stop response lost its exact Chrome conversation binding.");
                if (result?.confirmed !== true || result?.stopped !== true) {
                    if (result?.notSubmitted === true) {
                        const err = new Error("ChatGPT no longer offered Stop for this exact response. Refresh the conversation.");
                        err.statusCode = 409;
                        throw err;
                    }
                    throw new Error("Stop may have been clicked. Check the actual ChatGPT response in Chrome.");
                }
                // The interruption ends the pending reply, but it must NOT fabricate
                // assistant text or replay a send. Hydrate provider-rendered history.
                const interrupted = pending;
                pending = null;
                stoppedTurn = { userEpoch: observed.userEpoch,
                    deliveryId: interrupted?.deliveryId ?? null };
                historyPendingHydration = 5;
                previousHistoryGeneration = false;
                return { confirmed: true, stopped: true, chat: await read() };
            }
            catch (error) {
                if (error?.statusCode !== 409) {
                    blocked = true;
                    uncertainConversations.add(conversationKey(binding));
                }
                throw error;
            }
            finally {
                mutatingAction = false;
            }
        })();
        stopAttempts.set(id, { conversationKey: conversationKey(binding), tabId: binding.tabId, promise });
        return promise;
    };
    const tools = async () => {
        const instance = context();
        if (Number(browserBridge.snapshot()?.contexts?.user?.extension?.capabilityVersions?.chatBridge || 0) < 13)
            invalid("The connected Browser must support Native Chat tool discovery.");
        const data = await call("chat_bridge.tools_catalog", {}, 14_000);
        if (context() !== instance || !Array.isArray(data?.items) || data.items.length > 60)
            invalid("ChatGPT account tool discovery changed or failed.");
        const items = data.items.filter((row) => row && typeof row.name === "string"
            && row.name.trim() && row.name.length <= 90 && ["tool", "app"].includes(row.kind))
            .map((row) => ({ name: row.name, kind: row.kind }));
        if (items.length !== data.items.length)
            invalid("ChatGPT returned invalid tool choices.");
        return { items, partial: true, source: "visible-provider-composer" };
    };
    const send = async (value) => {
        if (!value || typeof value !== "object" || Array.isArray(value))
            invalid("Invalid chat delivery request.");
        const body = value;
        if (Object.keys(body).some(k => !["deliveryId", "text", "tool", "file", "files"].includes(k))
            || typeof body.deliveryId !== "string" || !/^tgb-[a-f0-9-]{36}$/u.test(body.deliveryId) || typeof body.text !== "string" || (!body.text.trim() && !body.file && !body.files) || body.text.length > 4000 || /[\0]/u.test(body.text)
            || (body.tool !== undefined && (!body.tool || typeof body.tool !== "object" || Array.isArray(body.tool)
                || Object.keys(body.tool).some(k => !["name", "kind"].includes(k))
                || typeof body.tool.name !== "string"
                || !body.tool.name.trim() || body.tool.name.length > 90
                || (body.tool.kind === "tool"
                    ? !/^(Web search|Web araması|Create image|Görsel oluştur|Deep research|Derin araştırma)$/iu.test(body.tool.name)
                    : body.tool.kind !== "app"
                        || !/^(Gmail|Equinox Local)$/u.test(body.tool.name))))
            || (body.file !== undefined && (!body.file || typeof body.file !== "object" || Array.isArray(body.file)
                || Object.keys(body.file).some(k => !["path", "name", "size"].includes(k))
                || typeof body.file.path !== "string" || body.file.path.length > 4096
                || !path.isAbsolute(body.file.path)
                || typeof body.file.name !== "string" || body.file.name.length > 255
                || !Number.isSafeInteger(body.file.size) || body.file.size < 1
                || body.file.size > 100 * 1024 * 1024
                || path.basename(body.file.path) !== body.file.name))
            || (body.files !== undefined && (!Array.isArray(body.files) || body.files.length < 2
                || body.files.length > 4 || body.files.some((file) => !file
                || typeof file !== "object" || Array.isArray(file)
                || Object.keys(file).some(k => !["path", "name", "size"].includes(k))
                || typeof file.path !== "string" || file.path.length > 4096 || !path.isAbsolute(file.path)
                || typeof file.name !== "string" || !file.name.trim() || file.name.length > 255
                || path.basename(file.path) !== file.name
                || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 100 * 1024 * 1024)
                || new Set(body.files.map((file) => file.name)).size !== body.files.length
                || body.files.reduce((total, file) => total + file.size, 0) > 100 * 1024 * 1024))
            || (body.file !== undefined && body.files !== undefined)
            || (body.tool !== undefined && (body.file !== undefined || body.files !== undefined)))
            invalid("Chat delivery requires a user-selected regular file or verified tool and 1–4000 safe characters.");
        const key = body.deliveryId;
        const message = body.text.trim();
        const selectedTool = body.tool;
        const toolKey = selectedTool ? selectedTool.kind + ":" + selectedTool.name : "";
        const selectedFile = body.file;
        const selectedFiles = body.files;
        const fileKey = selectedFiles ? JSON.stringify(selectedFiles) : selectedFile ? JSON.stringify(selectedFile) : "";
        const prior = attempts.get(key);
        if (prior) {
            if (prior.text !== message || prior.toolKey !== toolKey || prior.fileKey !== fileKey
                || !selected || prior.conversationKey !== conversationKey(selected))
                invalid("A delivery id cannot be reused for a different conversation or message.");
            return prior.promise;
        }
        // Retain every delivery identity for the lifetime of this backend.
        // Refuse new sends at the bound rather than evict old IDs and risk replay.
        if (attempts.size >= MAX_DELIVERY_IDS)
            invalid("This Chat session reached its bounded delivery limit. Restart the runtime before sending again.");
        if (selecting || sending || creating || pending || blocked || mutatingAction || !selected)
            invalid("Select an idle, unblocked ChatGPT conversation and finish any pending conversation action before sending.");
        const binding = selected;
        sending = true;
        const attempt = (async () => {
            try {
                if (selectedTool) {
                    try {
                        const catalog = await tools();
                        if (!catalog.items.some((item) => item.name === selectedTool.name && item.kind === selectedTool.kind))
                            throw new Error("The selected tool is no longer offered by this ChatGPT account.");
                    }
                    catch (error) {
                        const unavailable = new Error("Tool preflight failed: " +
                            (error instanceof Error ? error.message : "ChatGPT tool menu unavailable."));
                        unavailable.code = "CHAT_BRIDGE_NOT_READY";
                        throw unavailable;
                    }
                }
                if (selectedFile || selectedFiles) {
                    try {
                        for (const file of selectedFiles || [selectedFile]) {
                            const stat = await fs.lstat(file.path);
                            const canonical = await fs.realpath(file.path);
                            if (!stat.isFile() || canonical !== file.path || stat.size !== file.size
                                || stat.size > 100 * 1024 * 1024)
                                throw new Error("Selected file moved, changed, or is no longer a regular file.");
                        }
                    }
                    catch (error) {
                        const unavailable = new Error("Selected attachments are not ready: " +
                            (error instanceof Error ? error.message : "File unavailable."));
                        unavailable.code = "CHAT_BRIDGE_NOT_READY";
                        throw unavailable;
                    }
                }
                const result = await chatBridge.deliverText({ binding, deliveryId: key, text: body.text.trim(),
                    ...(selectedTool ? { tool: selectedTool } : {}), ...(selectedFile ? { file: selectedFile } : {}),
                    ...(selectedFiles ? { files: selectedFiles } : {}), requireExactTab: true });
                if (result?.confirmed !== true) {
                    blocked = true;
                    uncertainConversations.add(conversationKey(binding));
                    appendMessage({ id: key, role: "user", text: body.text.trim(), status: "uncertain" });
                    return { confirmed: false, ambiguous: true };
                }
                appendMessage({ id: key, role: "user", text: body.text.trim(), status: "sent" });
                pending = { userEpoch: result.userEpoch, previousAssistantTurnKey: result.previousAssistantTurnKey, deliveryId: key };
                return { confirmed: true, ambiguous: false };
            }
            catch (error) {
                const code = error?.code;
                if (code === "CHAT_BRIDGE_NOT_READY") {
                    // The bridge verified no native send crossed the Chrome mutation
                    // boundary. Preserve the draft and allow a fresh explicit selection.
                    const definitive = new Error("Chat was not submitted: " +
                        (error instanceof Error ? error.message : "The selected Chrome tab is not ready."));
                    definitive.statusCode = 409;
                    throw definitive;
                }
                if (code === "CHAT_BRIDGE_AMBIGUOUS") {
                    blocked = true;
                    uncertainConversations.add(conversationKey(binding));
                    appendMessage({ id: key, role: "user", text: body.text.trim(), status: "uncertain" });
                }
                throw error;
            }
            finally {
                sending = false;
            }
        })();
        attempts.set(key, { text: message, toolKey, fileKey, conversationKey: conversationKey(binding), promise: attempt });
        return attempt;
    };
    // Explicit first-message creation. Reuse the existing Task Capsule + first-party
    // Task Chat starter, and retain request identities even after a failed attempt.
    // A restart cannot silently recreate an already recorded initiation request.
    const editMessage = async (value) => {
        if (!value || typeof value !== "object" || Array.isArray(value))
            invalid("Message edit requires a verified provider user turn.");
        const body = value;
        if (Object.keys(body).some(k => !["messageId", "oldText", "newText", "mutationId"].includes(k))
            || typeof body.messageId !== "string"
            || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}:user$/iu.test(body.messageId)
            || typeof body.oldText !== "string" || !body.oldText.trim()
            || body.oldText !== body.oldText.trim() || body.oldText.length > 3500
            || typeof body.newText !== "string" || !body.newText.trim()
            || body.newText !== body.newText.trim() || body.newText.length > 3500
            || body.newText === body.oldText || /[\x00]/u.test(body.newText)
            || typeof body.mutationId !== "string" || !/^mde-[a-f0-9-]{36}$/u.test(body.mutationId))
            invalid("Message edit requires one changed, exact provider message and mutation identity.");
        const key = String(body.mutationId), fingerprint = JSON.stringify(body);
        const prior = editAttempts.get(key);
        if (prior) {
            if (prior.fingerprint !== fingerprint || !selected
                || prior.conversationKey !== conversationKey(selected) || prior.tabId !== selected.tabId)
                invalid("Message edit identity cannot be reused for another conversation or edit.");
            return prior.promise;
        }
        if (editAttempts.size >= 256)
            invalid("This Chat session has reached its bounded message edit limit.");
        if (!selected || selecting || sending || creating || pending || blocked || mutatingAction)
            invalid("Select an idle, unblocked conversation before editing a message.");
        const binding = selected, revision = selectedRevision;
        if (Number(browserBridge.snapshot()?.contexts?.user?.extension?.capabilityVersions?.chatBridge || 0) < 13)
            invalid("Update Equinox Browser before editing messages.");
        const taskId = await currentTaskId(binding);
        if (!await messageEditPermitted(binding, taskId))
            invalid("This active Task Capsule cannot safely edit its historical turn. Finish its automation before editing.");
        if (selectedRevision !== revision || !selected
            || selected.tabId !== binding.tabId
            || conversationKey(selected) !== conversationKey(binding)
            || selecting || sending || creating || pending || blocked || mutatingAction)
            invalid("Conversation changed while authorizing the message edit. Select the message again.");
        const source = history.find(item => item.id === body.messageId && item.role === "user"
            && item.status === "complete" && item.truncated !== true);
        if (!source || source.text !== body.oldText)
            invalid("This user turn is not a complete, exact message from the selected ChatGPT history.");
        mutatingAction = true;
        const attempt = (async () => {
            try {
                const response = await call("chat_bridge.edit_message", {
                    tabId: binding.tabId, conversationId: binding.conversationId,
                    messageId: body.messageId, oldText: body.oldText, newText: body.newText,
                    editId: key,
                }, 17_000);
                if (selectedRevision !== revision || !selected ||
                    conversationKey(selected) !== conversationKey(binding)
                    || selected.tabId !== binding.tabId || response?.tabId !== binding.tabId
                    || response?.conversationId !== binding.conversationId)
                    throw new Error("Message edit lost the exact conversation binding.");
                if (response?.confirmed !== true) {
                    if (response?.notSubmitted === true) {
                        const err = new Error("ChatGPT did not submit this edit. The message or editor changed. Refresh the conversation.");
                        err.statusCode = 409;
                        throw err;
                    }
                    throw new Error("Edited message outcome is uncertain. Check this conversation in Chrome; the edit will not be resent.");
                }
                history = [];
                messages = [];
                historyPartial = true;
                historyNotice = null;
                historyPendingHydration = 7;
                previousHistoryGeneration = true;
                return { confirmed: true, messageId: body.messageId, chat: await read() };
            }
            catch (error) {
                // Once the browser edit request has been issued, an unknown transport
                // result may have crossed the provider Send boundary. A fresh request
                // must not be auto-authorized until a human inspects Chrome.
                if (error?.statusCode !== 409) {
                    blocked = true;
                    uncertainConversations.add(conversationKey(binding));
                }
                throw error;
            }
            finally {
                mutatingAction = false;
            }
        })();
        editAttempts.set(key, { fingerprint, conversationKey: conversationKey(binding),
            tabId: binding.tabId, promise: attempt });
        return attempt;
    };
    const retryAssistant = async (value) => {
        if (!value || typeof value !== "object" || Array.isArray(value))
            invalid("Retry requires an exact observed assistant response.");
        const body = value;
        if (Object.keys(body).some(k => !["messageId", "expectedText", "mutationId"].includes(k))
            || typeof body.messageId !== "string"
            || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}:assistant$/iu.test(body.messageId)
            || typeof body.expectedText !== "string" || !body.expectedText.trim()
            || body.expectedText !== body.expectedText.trim() || body.expectedText.length > 3500
            || typeof body.mutationId !== "string" || !/^mrt-[a-f0-9-]{36}$/u.test(body.mutationId))
            invalid("Retry requires one complete, exact provider assistant message.");
        const key = String(body.mutationId), fingerprint = JSON.stringify(body);
        const prior = retryAttempts.get(key);
        if (prior) {
            if (prior.fingerprint !== fingerprint || !selected
                || prior.conversationKey !== conversationKey(selected) || prior.tabId !== selected.tabId)
                invalid("Retry identity cannot be reused for another conversation or response.");
            return prior.promise;
        }
        if (retryAttempts.size >= 256)
            invalid("This Chat session reached its bounded Retry limit.");
        if (!selected || selecting || sending || creating || pending || blocked || mutatingAction)
            invalid("Select an idle, unblocked conversation before Retry.");
        const binding = selected, revision = selectedRevision;
        if (Number(browserBridge.snapshot()?.contexts?.user?.extension?.capabilityVersions?.chatBridge || 0) < 13)
            invalid("Update Equinox Browser before using Retry.");
        const taskId = await currentTaskId(binding);
        if (!await messageEditPermitted(binding, taskId))
            invalid("Active automation Task Capsules cannot retry historical replies.");
        if (selectedRevision !== revision || !selected
            || selected.tabId !== binding.tabId
            || conversationKey(selected) !== conversationKey(binding)
            || selecting || sending || creating || pending || blocked || mutatingAction)
            invalid("Conversation changed while verifying Retry.");
        const reply = history.find(item => item.id === body.messageId && item.role === "assistant"
            && item.status === "complete" && item.truncated !== true);
        if (!reply || reply.text !== body.expectedText)
            invalid("This exact assistant reply is not available in the selected provider history.");
        mutatingAction = true;
        const promise = (async () => {
            try {
                const result = await call("chat_bridge.retry_assistant", {
                    tabId: binding.tabId, conversationId: binding.conversationId,
                    messageId: body.messageId, expectedText: body.expectedText,
                    mutationId: key
                }, 19_000);
                if (selectedRevision !== revision || !selected
                    || selected.tabId !== binding.tabId
                    || conversationKey(selected) !== conversationKey(binding)
                    || result?.tabId !== binding.tabId
                    || result?.conversationId !== binding.conversationId)
                    throw new Error("Retry lost the original Chrome conversation binding.");
                if (result?.confirmed !== true || result?.retryStarted !== true) {
                    if (result?.notSubmitted === true) {
                        const err = new Error("ChatGPT did not offer Retry for this exact reply. Refresh history before trying again.");
                        err.statusCode = 409;
                        throw err;
                    }
                    throw new Error("Retry may already be running. Inspect Chrome before another response mutation.");
                }
                history = [];
                messages = [];
                historyPartial = true;
                historyNotice = null;
                historyPendingHydration = 7;
                previousHistoryGeneration = true;
                return { confirmed: true, messageId: body.messageId, chat: await read() };
            }
            catch (error) {
                if (error?.statusCode !== 409) {
                    blocked = true;
                    uncertainConversations.add(conversationKey(binding));
                }
                throw error;
            }
            finally {
                mutatingAction = false;
            }
        })();
        retryAttempts.set(key, { fingerprint, conversationKey: conversationKey(binding),
            tabId: binding.tabId, promise });
        return promise;
    };
    const responseVersions = async (value) => {
        if (!value || typeof value !== "object" || Array.isArray(value))
            invalid("Versions require one exact provider assistant reply.");
        const body = value;
        if (Object.keys(body).some(k => !["messageId", "expectedText"].includes(k))
            || typeof body.messageId !== "string"
            || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}:assistant$/iu.test(body.messageId)
            || typeof body.expectedText !== "string" || !body.expectedText.trim()
            || body.expectedText !== body.expectedText.trim() || body.expectedText.length > 3500)
            invalid("Versions require one complete, exact provider assistant message.");
        if (!selected || selecting || sending || creating || pending || blocked || mutatingAction)
            invalid("Select an idle, unblocked conversation before viewing versions.");
        const binding = selected, revision = selectedRevision;
        if (Number(browserBridge.snapshot()?.contexts?.user?.extension?.capabilityVersions?.chatBridge || 0) < 13)
            invalid("Update Equinox Browser before viewing reply versions.");
        const reply = history.find(item => item.id === body.messageId && item.role === "assistant"
            && item.status === "complete" && item.truncated !== true && item.versionsAvailable === true);
        if (!reply || reply.text !== body.expectedText)
            invalid("ChatGPT did not offer version history for this exact assistant reply.");
        mutatingAction = true; // Guard native sends/reselection while reading provider's temporary modal.
        try {
            const result = await call("chat_bridge.response_versions", {
                tabId: binding.tabId, conversationId: binding.conversationId,
                messageId: body.messageId, expectedText: body.expectedText
            }, 38_000);
            if (selectedRevision !== revision || !selected
                || selected.tabId !== binding.tabId || conversationKey(selected) !== conversationKey(binding)
                || result?.tabId !== binding.tabId || result?.conversationId !== binding.conversationId
                || result?.messageId !== body.messageId)
                invalid("Conversation changed while reading provider versions.");
            if (!Array.isArray(result.versions) || result.versions.length < 2 || result.versions.length > 12)
                invalid("The provider did not return a bounded response version history.");
            const ids = new Set();
            let currentCount = 0;
            const versions = result.versions.map((item, index) => {
                if (!item || item.index !== index + 1 || typeof item.messageId !== "string"
                    || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu.test(item.messageId)
                    || ids.has(item.messageId) || typeof item.text !== "string" || !item.text.trim()
                    || [...item.text].length > 3500 || typeof item.current !== "boolean"
                    || typeof item.truncated !== "boolean")
                    invalid("The provider version response was malformed.");
                ids.add(item.messageId);
                if (item.current)
                    currentCount++;
                return { index: item.index, messageId: item.messageId, text: item.text, truncated: item.truncated, current: item.current };
            });
            if (currentCount !== 1 || !ids.has(String(body.messageId).slice(0, -10)))
                invalid("The provider current reply was not found in its versions.");
            return { messageId: body.messageId, versions };
        }
        finally {
            mutatingAction = false;
        }
    };
    const branchNewChat = async (value, mode = "new") => {
        if (!value || typeof value !== "object" || Array.isArray(value))
            invalid("Branch requires an exact provider assistant reply.");
        const body = value;
        if (Object.keys(body).some(k => !["messageId", "expectedText", "firstMessage", "mutationId",
            ...(mode === "history" ? ["versionMessageId", "versionText"] : [])].includes(k))
            || typeof body.messageId !== "string"
            || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}:assistant$/iu.test(body.messageId)
            || typeof body.expectedText !== "string" || !body.expectedText.trim()
            || body.expectedText !== body.expectedText.trim() || body.expectedText.length > 3500
            || typeof body.firstMessage !== "string" || !body.firstMessage.trim()
            || body.firstMessage !== body.firstMessage.trim() || body.firstMessage.length > 1500
            || /[\r\n\x00]/u.test(body.firstMessage)
            || (mode === "history" && (typeof body.versionMessageId !== "string"
                || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu.test(body.versionMessageId)
                || body.versionMessageId === String(body.messageId).slice(0, -10)
                || typeof body.versionText !== "string" || !body.versionText.trim()
                || body.versionText !== body.versionText.trim() || body.versionText.length > 3500))
            || typeof body.mutationId !== "string" || !(mode === "work" ? /^mwr-[a-f0-9-]{36}$/u :
            mode === "history" ? /^mbv-[a-f0-9-]{36}$/u : /^mbr-[a-f0-9-]{36}$/u).test(body.mutationId))
            invalid("Branch needs one exact complete assistant reply and a one-use identity.");
        const key = String(body.mutationId), fingerprint = JSON.stringify({ mode, ...body });
        const prior = branchAttempts.get(key);
        if (prior) {
            if (prior.fingerprint !== fingerprint || !selected
                || prior.conversationKey !== conversationKey(selected) || prior.tabId !== selected.tabId)
                invalid("A Branch id cannot be reused for another response or conversation.");
            return prior.promise;
        }
        if (branchAttempts.size >= 256)
            invalid("This Chat session reached its bounded branch limit.");
        if (!selected || selecting || sending || creating || pending || blocked || mutatingAction)
            invalid("Finish pending messages before creating a conversation branch.");
        const binding = selected, revision = selectedRevision;
        if (Number(browserBridge.snapshot()?.contexts?.user?.extension?.capabilityVersions?.chatBridge || 0) < 13)
            invalid("Update Equinox Browser to branch an assistant reply.");
        const taskId = await currentTaskId(binding);
        if (!await messageEditPermitted(binding, taskId))
            invalid("An active automation Task Capsule cannot change its conversation branch.");
        if (selectedRevision !== revision || !selected || selected.tabId !== binding.tabId
            || conversationKey(selected) !== conversationKey(binding)
            || selecting || sending || creating || pending || blocked || mutatingAction)
            invalid("Conversation changed while verifying Branch.");
        const source = history.find(item => item.id === body.messageId && item.role === "assistant"
            && item.status === "complete" && item.truncated !== true);
        if (!source || source.text !== body.expectedText
            || (mode === "history" && source.versionsAvailable !== true))
            invalid("This exact assistant reply and historical versions are not available in provider history.");
        mutatingAction = true;
        const promise = (async () => {
            try {
                const result = await call(mode === "work" ? "chat_bridge.branch_work_chat" :
                    mode === "history" ? "chat_bridge.branch_version_new" : "chat_bridge.branch_new_chat", {
                    tabId: binding.tabId, conversationId: binding.conversationId,
                    messageId: body.messageId, expectedText: body.expectedText,
                    firstMessage: body.firstMessage, mutationId: key,
                    ...(mode === "history" ? { versionMessageId: body.versionMessageId,
                        versionText: body.versionText } : {})
                }, 38_000);
                const next = result?.branch;
                if (selectedRevision !== revision || !selected
                    || selected.tabId !== binding.tabId || conversationKey(selected) !== conversationKey(binding)
                    || result?.tabId !== binding.tabId || result?.conversationId !== binding.conversationId
                    || (mode === "history" && result?.versionMessageId !== body.versionMessageId))
                    throw new Error("Branch lost the exact original response version or conversation binding.");
                if (result?.confirmed !== true || !next || !Number.isSafeInteger(next.tabId)
                    || typeof next.conversationId !== "string"
                    || !/^[a-zA-Z0-9-]{8,160}$/u.test(next.conversationId)
                    || typeof next.canonicalUrl !== "string"
                    || chatGptConversationIdFromUrl(next.canonicalUrl) !== next.conversationId
                    || next.conversationId === binding.conversationId) {
                    if (result?.notSubmitted === true) {
                        const err = new Error("The provider did not offer the requested Branch mode for this exact reply.");
                        err.statusCode = 409;
                        throw err;
                    }
                    throw new Error("ChatGPT Branch may have started. Inspect Chrome before trying again.");
                }
                // Preserve original Task Capsule association. The new browser branch
                // is a separate conversation that the native UI can select directly.
                historyNotice = mode === "work" ? "A ChatGPT Work branch was created." :
                    mode === "history" ? "A branch from the selected older response version was created." :
                        "A new ChatGPT branch was created.";
                return { confirmed: true, branch: {
                        tabId: next.tabId, conversationId: next.conversationId,
                        canonicalUrl: next.canonicalUrl,
                        title: typeof next.title === "string" ? safeTitle(next.title) : "New branch"
                    } };
            }
            catch (error) {
                if (error?.statusCode !== 409) {
                    blocked = true;
                    uncertainConversations.add(conversationKey(binding));
                }
                throw error;
            }
            finally {
                mutatingAction = false;
            }
        })();
        branchAttempts.set(key, { fingerprint, conversationKey: conversationKey(binding),
            tabId: binding.tabId, promise });
        return promise;
    };
    const startNew = async (value) => {
        if (!value || typeof value !== "object" || Array.isArray(value))
            invalid("Invalid New Chat request.");
        const body = value;
        if (Object.keys(body).some(k => !["creationId", "text", "model", "effort", "tool", "file", "files"].includes(k))
            || typeof body.creationId !== "string" ||
            !/^nch-[a-f0-9-]{36}$/u.test(body.creationId) || typeof body.text !== "string" ||
            (!body.text.trim() && !body.file && !body.files) || body.text.length > 1500 || /[\r\n\0]/u.test(body.text)
            || (body.model !== undefined && (typeof body.model !== "string" || !body.model.trim() || body.model.length > 80))
            || (body.effort !== undefined && (!Number.isInteger(body.effort) || Number(body.effort) < 0 || Number(body.effort) > 12))
            || (body.tool !== undefined && (!body.tool || typeof body.tool !== "object" || Array.isArray(body.tool)
                || Object.keys(body.tool).some(k => !["name", "kind"].includes(k))
                || typeof body.tool.name !== "string" || body.tool.name.length > 90
                || (body.tool.kind === "tool"
                    ? !/^(Web search|Web araması|Create image|Görsel oluştur|Deep research|Derin araştırma)$/iu.test(body.tool.name)
                    : body.tool.kind !== "app" || !/^(Gmail|Equinox Local)$/u.test(body.tool.name))))
            || (body.file !== undefined && (!body.file || typeof body.file !== "object" || Array.isArray(body.file)
                || Object.keys(body.file).some(k => !["path", "name", "size"].includes(k))
                || typeof body.file.path !== "string" || body.file.path.length > 4096
                || !path.isAbsolute(body.file.path)
                || typeof body.file.name !== "string" || body.file.name.length > 255
                || !Number.isSafeInteger(body.file.size) || body.file.size < 1
                || body.file.size > 100 * 1024 * 1024
                || path.basename(body.file.path) !== body.file.name))
            || (body.files !== undefined && (!Array.isArray(body.files) || body.files.length < 2 || body.files.length > 4
                || body.files.some((file) => !file || typeof file !== "object" || Array.isArray(file)
                    || Object.keys(file).some(k => !["path", "name", "size"].includes(k))
                    || typeof file.path !== "string" || file.path.length > 4096 || !path.isAbsolute(file.path)
                    || typeof file.name !== "string" || !file.name.trim() || file.name.length > 255
                    || path.basename(file.path) !== file.name
                    || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 100 * 1024 * 1024)
                || new Set(body.files.map((file) => file.name)).size !== body.files.length
                || body.files.reduce((total, file) => total + file.size, 0) > 100 * 1024 * 1024))
            || (body.file !== undefined && body.files !== undefined)
            || (body.tool !== undefined && (body.file !== undefined || body.files !== undefined)))
            invalid("The first Chat message requires a safe prompt or up to four explicitly selected files.");
        const key = body.creationId;
        const firstMessage = body.text.trim();
        const modelChoice = typeof body.model === "string" ? body.model.trim() : null;
        const effortLevel = Number.isInteger(body.effort) ? Number(body.effort) : null;
        const selectedTool = body.tool;
        const toolKey = selectedTool ? selectedTool.kind + ":" + selectedTool.name : "";
        const selectedFile = body.file;
        const selectedFiles = body.files;
        const attachments = selectedFiles ?? (selectedFile ? [selectedFile] : []);
        const fileKey = JSON.stringify(attachments);
        const prior = createAttempts.get(key);
        if (prior) {
            if (prior.text !== firstMessage || prior.modelChoice !== modelChoice
                || prior.effortLevel !== effortLevel || prior.toolKey !== toolKey || prior.fileKey !== fileKey)
                invalid("A New Chat creation id cannot be reused with different message or model settings.");
            return prior.promise;
        }
        if (creationBlocked)
            invalid("A previous New Chat creation is uncertain. Check Chrome before restarting the Chat session; no new conversation will be opened automatically.");
        if (createAttempts.size >= MAX_NEW_CHAT_IDS)
            invalid("New Chat reached its request limit for this runtime.");
        if (!taskStore || !chatBridge.startTaskChat)
            invalid("New Chat is unavailable on this installation.");
        if (selecting || creating || sending || pending || blocked || mutatingAction)
            invalid("Finish the current conversation or pending action before starting New Chat.");
        creating = true;
        const attempt = (async () => {
            let taskId = null;
            try {
                context();
                if (selectedTool) {
                    const catalog = await tools();
                    if (!catalog.items.some((item) => item.kind === selectedTool.kind && item.name === selectedTool.name))
                        invalid("Selected New Chat tool is no longer offered by the account.");
                }
                for (const attachment of attachments) {
                    const stat = await fs.lstat(attachment.path);
                    const canonical = await fs.realpath(attachment.path);
                    if (!stat.isFile() || canonical !== attachment.path
                        || stat.size !== attachment.size || stat.size > 100 * 1024 * 1024)
                        invalid("An attachment changed after explicit selection. Choose the files again.");
                }
                const existing = await taskStore.list({ limit: 100 });
                if (existing.some(t => Array.isArray(t.references) && t.references.some((ref) => ref.label === "Native Chat creation ID" && ref.value === key)))
                    invalid("This New Chat request was already recorded. Review existing Task Capsules instead of creating a duplicate.");
                const task = await taskStore.checkpoint({
                    title: "Native Chat · " + new Date().toISOString().slice(0, 16).replace("T", " "),
                    objective: "User-initiated ChatGPT conversation through the Equinox Local native Chat window. The opening prompt stays in the user's ChatGPT conversation, not the Task Capsule.",
                    completed: [], next: [], references: [{ type: "note", label: "Native Chat creation ID", value: key }],
                });
                if (typeof task?.taskId !== "string" || !/^task-[a-z0-9-]{6,80}$/u.test(task.taskId))
                    throw new Error("New Chat Task Capsule was not persisted.");
                const newTaskId = task.taskId;
                taskId = newTaskId;
                const opened = await chatBridge.startTaskChat({ taskId: newTaskId, checkpointRevision: task.checkpointRevision,
                    initialMessage: firstMessage, ...(modelChoice ? { modelChoice } : {}),
                    ...(effortLevel !== null ? { effortLevel } : {}),
                    ...(selectedTool ? { tool: selectedTool } : {}),
                    ...(selectedFile ? { file: selectedFile } : {}),
                    ...(selectedFiles ? { files: selectedFiles } : {}) });
                if (opened?.confirmed !== true || !opened?.binding)
                    throw new Error("New Chat could not confirm its exact ChatGPT binding.");
                const source = opened.binding;
                if (source.browserContext !== "user" || source.browserInstanceId !== context() ||
                    !Number.isSafeInteger(source.tabId) || source.tabId < 1 ||
                    !/^[A-Za-z0-9-]{8,160}$/u.test(source.conversationId) ||
                    chatGptConversationIdFromUrl(source.canonicalUrl) !== source.conversationId)
                    throw new Error("New Chat returned a different browser conversation identity.");
                const saved = await taskStore.bindChat({ taskId: newTaskId, binding: source });
                // bindChat persists and validates the full exact binding internally.
                // Its PUBLIC result exposes only browserContext and tabId by design.
                if (saved?.taskId !== newTaskId || saved?.chatBinding?.browserContext !== source.browserContext || saved?.chatBinding?.tabId !== source.tabId)
                    throw new Error("New Chat Task Capsule binding could not be confirmed.");
                associatedTasks.set(conversationKey(source), newTaskId);
                selected = { browserContext: "user", browserInstanceId: source.browserInstanceId, tabId: source.tabId, conversationId: source.conversationId, canonicalUrl: source.canonicalUrl };
                selectedRevision++;
                history = [];
                messages = [];
                historyNotice = null;
                historyPartial = false;
                blocked = false;
                pending = null;
                awaitingNewChatIdentity = null;
                const messageId = key.replace(/^nch-/u, "tgb-");
                appendMessage({ id: messageId, role: "user",
                    text: firstMessage || attachments.map(item => item.name).join("\n"), status: "sent" });
                if (typeof opened.userEpoch === "string" && opened.userEpoch && !attachments.length) {
                    pending = { userEpoch: opened.userEpoch, previousAssistantTurnKey: null, deliveryId: messageId };
                }
                else {
                    // A confirmed new tab/conversation can still precede its first turn's
                    // DOM epoch. Keep sends blocked, but resolve from exact read-only
                    // Browser history on a later status poll instead of locking forever.
                    awaitingNewChatIdentity = { conversationId: source.conversationId, text: firstMessage,
                        fileNames: attachments.map(item => item.name), deliveryId: messageId };
                    awaitingFirstTurns.set(conversationKey(selected), awaitingNewChatIdentity);
                    blocked = true;
                    historyNotice = "New Chat opened. Waiting to verify its first turn in Chrome; no message will be resent.";
                }
                return { confirmed: true, taskId: newTaskId, chat: await read() };
            }
            catch (error) {
                if (taskId && error?.code === "CHAT_BRIDGE_CREATE_NOT_STARTED" && taskStore?.cancel) {
                    // The starter confirmed no submit boundary was crossed and closed its new tab.
                    // Keep a cancelled durable creation ID, rather than an orphaned active task.
                    let cancelled = false;
                    try {
                        await taskStore.cancel(taskId);
                        cancelled = true;
                    }
                    catch { /* Uncertain cleanup must remain blocked. */ }
                    if (cancelled) {
                        const definitive = new Error("New Chat was not submitted: " + (error instanceof Error ? error.message : "The initial composer was not ready."));
                        definitive.statusCode = 409;
                        throw definitive;
                    }
                }
                if (taskId) {
                    // The first tab/prompt may already exist. Switching to another known
                    // conversation must not authorize a second unknown New Chat.
                    creationBlocked = true;
                    blocked = true;
                }
                throw error;
            }
            finally {
                creating = false;
            }
        })();
        createAttempts.set(key, { text: firstMessage, modelChoice, effortLevel, toolKey, fileKey, promise: attempt });
        return attempt;
    };
    return Object.freeze({ list, search, project, createProject, editProjectInstructions, addProjectTextSource, conversationAction, editMessage, retryAssistant, stopGeneration, responseVersions, branchNewChat,
        branchWorkChat: (value) => branchNewChat(value, "work"),
        branchVersionChat: (value) => branchNewChat(value, "history"), tools, select, read, send, startNew, model });
}
