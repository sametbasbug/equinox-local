import { EQUINOX_LOCAL_CONFIG_ERROR_CODES } from "./equinox-local-config.js";
import { TASK_CAPSULE_ERROR_CODES } from "./task-capsule-store.js";
import { REPAIR_RECIPE_IDS } from "./repair-engine.js";
import { AUTHENTICATED_HTTP_LIMITS, validateAuthenticatedHttpProfileInput, } from "./authenticated-http-integration.js";
const MAX_REQUEST_BYTES = 256 * 1024;
const REPAIR_RECIPE_ID_SET = new Set(REPAIR_RECIPE_IDS);
// IPC auto-refresh is read-only. It must not increment interactive request
// counters, but it does not grant a broader action to the renderer.
const CONTROL_CENTER_BACKGROUND_REFRESH_PATHS = new Set([
    "/api/v1/health", "/api/v1/status", "/api/v1/activity", "/api/v1/tasks", "/api/v1/chat/threads", "/api/v1/chat/state", "/api/v1/chat/model",
    "/api/v1/onboarding", "/api/v1/doctor", "/api/v1/doctor/repairs",
    "/api/v1/integrations/peekaboo", "/api/v1/integrations/telegram",
    "/api/v1/files/import-settings", "/api/v1/integrations/telegram/pair",
    "/api/v1/integrations/http-profiles", "/api/v1/config", "/api/v1/update",
]);
function redactErrorMessage(value) {
    return String(value ?? "")
        .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/giu, "Bearer [REDACTED]")
        .replace(/\b(authorization|token|secret|password|api[_-]?key|credential(?:token)?)\s*[:=]\s*[^\s,;]+/giu, "$1=[REDACTED]")
        .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/gu, "[REDACTED_GITHUB_SECRET]")
        .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/gu, "[REDACTED_TELEGRAM_TOKEN]")
        .replace(/(?:\/Users\/|\/private\/var\/folders\/|\/var\/folders\/|\/tmp\/)[^\s"'`;,]*/gu, "[REDACTED_PATH]");
}
function safeErrorMessage(error) {
    const message = error instanceof Error ? error.message : String(error);
    return redactErrorMessage(message)
        .replace(/[\r\n\u0000-\u001f\u007f]+/gu, " ")
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, 1000);
}
function publicErrorMessage(error, statusCode) {
    if (statusCode === 500)
        return "Control Center request failed.";
    return safeErrorMessage(error);
}
function badRequest(message) {
    const error = new Error(message);
    error.statusCode = 400;
    return error;
}
function validateReplaceEnvelope(body) {
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
        throw badRequest("Config güncelleme gövdesi JSON nesnesi olmalı.");
    }
    const keys = Object.keys(body);
    if (keys.some((key) => !["expectedRevision", "config"].includes(key))) {
        throw badRequest("Config güncelleme gövdesinde desteklenmeyen alan var.");
    }
    if (typeof body.expectedRevision !== "string" || !/^[a-f0-9]{64}$/u.test(body.expectedRevision)) {
        throw badRequest("expectedRevision 64 karakterlik SHA-256 olmalı.");
    }
    if (body.config === null || typeof body.config !== "object" || Array.isArray(body.config)) {
        throw badRequest("config JSON nesnesi olmalı.");
    }
    return body;
}
function validateBrowserSettings(body) {
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
        throw badRequest("Browser settings body must be a JSON object.");
    }
    const keys = Object.keys(body);
    if (keys.length < 1 || keys.some((key) => !["context", "enabled", "agentCursorEnabled", "agentCursorName"].includes(key))) {
        throw badRequest("Browser settings body has no supported settings or contains an unsupported field.");
    }
    if (Object.hasOwn(body, "context") && !["agent", "user"].includes(body.context)) {
        throw badRequest("Browser settings context must be agent or user.");
    }
    if (Object.hasOwn(body, "enabled") && typeof body.enabled !== "boolean") {
        throw badRequest("enabled must be boolean.");
    }
    if (Object.hasOwn(body, "agentCursorEnabled") && typeof body.agentCursorEnabled !== "boolean") {
        throw badRequest("agentCursorEnabled must be boolean.");
    }
    if (Object.hasOwn(body, "agentCursorName")) {
        if (typeof body.agentCursorName !== "string" || body.agentCursorName.length > 64 || /[\u0000-\u001f\u007f]/u.test(body.agentCursorName)) {
            throw badRequest("agentCursorName must be bounded control-character-free text.");
        }
    }
    return body;
}
function validateEmptyObject(body, label) {
    if (body === null || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0) {
        throw badRequest(`${label} body must be an empty JSON object.`);
    }
    return body;
}
function validateExactObject(body, allowedKeys, label) {
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
        throw badRequest(`${label} body must be a JSON object.`);
    }
    if (Object.keys(body).some((key) => !allowedKeys.includes(key))) {
        throw badRequest(`${label} body contains an unsupported field.`);
    }
    return body;
}
function validateHttpProfileControlUpsert(body) {
    const value = validateExactObject(body, ["profile", "credential"], "Authenticated HTTP profile");
    if (value.profile === null || typeof value.profile !== "object" || Array.isArray(value.profile)) {
        throw badRequest("Authenticated HTTP profile metadata must be a JSON object.");
    }
    let profile;
    try {
        profile = validateAuthenticatedHttpProfileInput(value.profile);
    }
    catch (error) {
        throw badRequest(error instanceof Error ? error.message : String(error));
    }
    let credential;
    if (Object.hasOwn(value, "credential")) {
        if (typeof value.credential !== "string" ||
            /[\u0000-\u001f\u007f]/u.test(value.credential) ||
            Buffer.byteLength(value.credential, "utf8") > AUTHENTICATED_HTTP_LIMITS.maxCredentialBytes) {
            throw badRequest("Authenticated HTTP credential must be bounded control-character-free text.");
        }
        credential = value.credential;
    }
    return { profile, ...(credential !== undefined ? { credential } : {}) };
}
function validateTurnBudgetRequest(body) {
    const value = validateExactObject(body, ["enabled", "cutoffMinutes", "fallbackResetMinutes", "autoContinueMaxHops"], "Turn Budget settings");
    if (typeof value.enabled !== "boolean")
        throw badRequest("Turn Budget enabled must be boolean.");
    if (!Number.isInteger(value.cutoffMinutes) || value.cutoffMinutes < 5 || value.cutoffMinutes > 120) {
        throw badRequest("Turn Budget cutoffMinutes must be an integer between 5 and 120.");
    }
    const fallbackResetMinutes = value.fallbackResetMinutes === undefined ? 2 : value.fallbackResetMinutes;
    if (!Number.isInteger(fallbackResetMinutes) || fallbackResetMinutes < 1 || fallbackResetMinutes > value.cutoffMinutes) {
        throw badRequest("Turn Budget fallbackResetMinutes must be an integer between 1 and cutoffMinutes.");
    }
    const autoContinueMaxHops = value.autoContinueMaxHops === undefined ? 20 : value.autoContinueMaxHops;
    if (!Number.isInteger(autoContinueMaxHops) || autoContinueMaxHops < 1 || autoContinueMaxHops > 100) {
        throw badRequest("Auto Continue max hops must be an integer between 1 and 100.");
    }
    return { enabled: value.enabled, cutoffMinutes: value.cutoffMinutes, fallbackResetMinutes, autoContinueMaxHops };
}
function validateHttpProfileManagementRequest(body) {
    const value = validateExactObject(body, ["enabled"], "Authenticated HTTP profile management");
    if (typeof value.enabled !== "boolean") {
        throw badRequest("Authenticated HTTP profile management enabled must be boolean.");
    }
    return { enabled: value.enabled };
}
function validateHttpProfileDeleteRequest(body) {
    const value = validateExactObject(body, ["profileId"], "Authenticated HTTP profile delete");
    if (typeof value.profileId !== "string" || !/^[a-z][a-z0-9._-]{0,63}$/u.test(value.profileId)) {
        throw badRequest("Authenticated HTTP profile id is invalid.");
    }
    return { profileId: value.profileId };
}
function validateHttpProfileTestRequest(body) {
    const value = validateExactObject(body, ["profileId", "method", "path", "query", "headers", "body", "timeoutMs"], "Authenticated HTTP profile test");
    if (typeof value.profileId !== "string" || !/^[a-z][a-z0-9._-]{0,63}$/u.test(value.profileId)) {
        throw badRequest("Authenticated HTTP profile id is invalid.");
    }
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(value.method)) {
        throw badRequest("Authenticated HTTP test method is invalid.");
    }
    if (typeof value.path !== "string" ||
        value.path.length < 1 ||
        value.path.length > AUTHENTICATED_HTTP_LIMITS.maxPathChars) {
        throw badRequest("Authenticated HTTP test path is invalid.");
    }
    if (value.query !== undefined && (value.query === null || typeof value.query !== "object" || Array.isArray(value.query))) {
        throw badRequest("Authenticated HTTP test query must be a JSON object.");
    }
    if (value.headers !== undefined && (value.headers === null || typeof value.headers !== "object" || Array.isArray(value.headers))) {
        throw badRequest("Authenticated HTTP test headers must be a JSON object.");
    }
    if (value.timeoutMs !== undefined &&
        (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 1000 || value.timeoutMs > AUTHENTICATED_HTTP_LIMITS.maxTimeoutMs)) {
        throw badRequest("Authenticated HTTP test timeout is invalid.");
    }
    return value;
}
function validateDoctorRepairRequest(body) {
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
        throw badRequest("Doctor repair body must be a JSON object.");
    }
    const keys = Object.keys(body).sort();
    if (keys.length !== 2 || keys[0] !== "incidentId" || keys[1] !== "recipeId") {
        throw badRequest("Doctor repair accepts only incidentId and recipeId.");
    }
    const incidentId = String(body.incidentId ?? "");
    const recipeId = String(body.recipeId ?? "");
    if (!/^inc-[a-z0-9-]{4,176}$/u.test(incidentId))
        throw badRequest("Doctor repair incidentId is invalid.");
    if (!REPAIR_RECIPE_ID_SET.has(recipeId))
        throw badRequest("Doctor repair recipeId is invalid.");
    return Object.freeze({ incidentId, recipeId });
}
function validateUninstallRequest(body) {
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
        throw badRequest("Uninstall body must be a JSON object.");
    }
    const keys = Object.keys(body).sort();
    if (keys.length !== 2 || keys[0] !== "confirm" || keys[1] !== "removeUserData") {
        throw badRequest("Uninstall accepts only confirm and removeUserData.");
    }
    if (body.confirm !== "UNINSTALL")
        throw badRequest("Uninstall confirmation is invalid.");
    if (typeof body.removeUserData !== "boolean")
        throw badRequest("removeUserData must be boolean.");
    return Object.freeze({ removeUserData: body.removeUserData });
}
function parseTaskRoute(pathname) {
    const match = /^\/api\/v1\/tasks\/(task-[a-z0-9-]{6,80})(?:\/(complete|cancel|delete|continuation\/cancel|fresh-resume\/cancel|fresh-resume\/abandon))?$/u.exec(pathname);
    if (!match)
        return null;
    return Object.freeze({ taskId: match[1], action: match[2] || null });
}
function validateTaskUpdateRequest(body) {
    if (body === null || typeof body !== "object" || Array.isArray(body))
        throw badRequest("Task update body must be a JSON object.");
    const allowed = new Set(["expectedRevision", "title", "objective", "completed", "next", "references"]);
    const keys = Object.keys(body);
    if (keys.some((key) => !allowed.has(key)))
        throw badRequest("Task update body contains an unsupported field.");
    if (!Number.isInteger(body.expectedRevision) || body.expectedRevision < 1)
        throw badRequest("expectedRevision must be a positive integer.");
    if (typeof body.title !== "string" || body.title.trim().length < 1 || body.title.trim().length > 160)
        throw badRequest("Task title must be 1-160 characters.");
    if (typeof body.objective !== "string" || body.objective.trim().length < 1 || Buffer.byteLength(body.objective.trim(), "utf8") > 12 * 1024)
        throw badRequest("Task objective is invalid or too large.");
    for (const field of ["completed", "next"]) {
        if (!Array.isArray(body[field]) || body[field].length > 64)
            throw badRequest(`${field} must be an array with at most 64 items.`);
        if (body[field].some((item) => typeof item !== "string" || !item.trim() || Buffer.byteLength(item.trim(), "utf8") > 1024))
            throw badRequest(`${field} contains an invalid item.`);
    }
    if (!Array.isArray(body.references) || body.references.length > 32)
        throw badRequest("references must be an array with at most 32 items.");
    for (const reference of body.references) {
        if (!reference || typeof reference !== "object" || Array.isArray(reference))
            throw badRequest("Each task reference must be an object.");
        if (Object.keys(reference).some((key) => !["type", "label", "value"].includes(key)))
            throw badRequest("Task reference contains an unsupported field.");
        if (!["project", "branch", "commit", "file", "url", "note"].includes(reference.type))
            throw badRequest("Task reference type is unsupported.");
        if (typeof reference.label !== "string" || !reference.label.trim() || reference.label.trim().length > 120)
            throw badRequest("Task reference label is invalid.");
        if (typeof reference.value !== "string" || !reference.value.trim() || Buffer.byteLength(reference.value.trim(), "utf8") > 2048)
            throw badRequest("Task reference value is invalid.");
    }
    return body;
}
export function createEquinoxLocalControlApi({ configManager, getStatus = async () => ({}), getTurnBudget = null, updateTurnBudget = null, getDoctorStatus = async () => ({}), getDoctorRepairs = null, applyDoctorRepair = null, getActivity = async () => [], getUpdateStatus = async () => ({}), getOnboardingStatus = async () => ({ available: false }), getChatThreads = null, searchChatThreads = null, browseChatProject = null, controlChatConversation = null, editChatMessage = null, getChatTools = null, selectChatThread = null, getChatState = null, sendChatText = null, startNewChat = null, getChatModel = null, changeChatModel = null, getTasks = null, getTask = null, updateTask = null, completeTask = null, cancelTask = null, deleteTask = null, cancelTaskContinuation = null, cancelTaskFreshResume = null, abandonTaskFreshResume = null, checkForUpdates = null, applyUpdate = null, configureTunnel = null, pauseAgent = null, resumeAgent = null, restartRuntime = null, scheduleUninstall = null, chooseFolder = null, updateBrowserSettings = null, openAgentBrowser = null, checkGitHub = null, getPeekabooStatus = null, getTelegramStatus = null, getWebImportSettings = null, updateWebImportDownloads = null, updateTelegramRemoteControl = null, updateTelegramDownloads = null, configureTelegram = null, startTelegramPairing = null, pollTelegramPairing = null, confirmTelegramPairing = null, cancelTelegramPairing = null, testTelegram = null, disconnectTelegram = null, getHttpProfiles = null, setHttpProfileManagement = null, upsertHttpProfile = null, testHttpProfile = null, deleteHttpProfile = null, recordInternalError = null, } = {}) {
    if (!configManager?.snapshot || !configManager?.replacePersisted) {
        throw new Error("Control Center API için configManager gerekli.");
    }
    if (typeof getStatus !== "function") {
        throw new Error("Control Center API getStatus fonksiyonu gerekli.");
    }
    if (typeof getDoctorStatus !== "function") {
        throw new Error("Control Center API getDoctorStatus fonksiyonu gerekli.");
    }
    if (typeof getActivity !== "function") {
        throw new Error("Control Center API getActivity fonksiyonu gerekli.");
    }
    if (recordInternalError != null && typeof recordInternalError !== "function") {
        throw new Error("Control Center API recordInternalError fonksiyonu geçersiz.");
    }
    if (typeof getUpdateStatus !== "function") {
        throw new Error("Control Center API getUpdateStatus fonksiyonu gerekli.");
    }
    if (typeof getOnboardingStatus !== "function") {
        throw new Error("Control Center API getOnboardingStatus fonksiyonu gerekli.");
    }
    const state = {
        active: false, startedAt: null, requestCount: 0, mutationCount: 0,
    };
    const snapshot = () => Object.freeze({
        active: state.active,
        transport: "ipc",
        host: null,
        configuredPort: null,
        port: null,
        startedAt: state.startedAt,
        requestCount: state.requestCount,
        mutationCount: state.mutationCount,
    });
    const dispatchControlOperation = async (method, pathname, readBody, authorizeMutation, send) => {
        try {
            if (method === "GET" && pathname === "/api/v1/health") {
                send(200, { ok: true, controlCenter: snapshot() });
                return;
            }
            if (method === "GET" && pathname === "/api/v1/config") {
                const configSnapshot = configManager.snapshot();
                send(200, {
                    ok: true,
                    revision: configSnapshot.revision,
                    loadedAt: configSnapshot.loadedAt,
                    config: configSnapshot.config,
                });
                return;
            }
            if (method === "GET" && pathname === "/api/v1/status") {
                send(200, { ok: true, status: await getStatus() });
                return;
            }
            if (method === "GET" && pathname === "/api/v1/turn-budget") {
                if (typeof getTurnBudget !== "function") {
                    const error = new Error("Turn Budget is unavailable.");
                    error.statusCode = 503;
                    throw error;
                }
                send(200, { ok: true, turnBudget: await getTurnBudget() });
                return;
            }
            if (method === "PUT" && pathname === "/api/v1/turn-budget") {
                authorizeMutation();
                if (typeof updateTurnBudget !== "function") {
                    const error = new Error("Turn Budget settings are unavailable.");
                    error.statusCode = 503;
                    throw error;
                }
                const turnBudget = await updateTurnBudget(validateTurnBudgetRequest(await readBody()));
                state.mutationCount += 1;
                send(200, { ok: true, turnBudget });
                return;
            }
            if (method === "GET" && pathname === "/api/v1/doctor") {
                send(200, { ok: true, doctor: await getDoctorStatus() });
                return;
            }
            if (method === "GET" && pathname === "/api/v1/doctor/repairs") {
                if (typeof getDoctorRepairs !== "function") {
                    const error = new Error("Doctor repair planning is unavailable on this installation.");
                    error.statusCode = 503;
                    throw error;
                }
                send(200, { ok: true, repairs: await getDoctorRepairs() });
                return;
            }
            if (method === "POST" && pathname === "/api/v1/doctor/repair") {
                authorizeMutation();
                if (typeof applyDoctorRepair !== "function") {
                    const error = new Error("Doctor repair is unavailable on this installation.");
                    error.statusCode = 503;
                    throw error;
                }
                const request = validateDoctorRepairRequest(await readBody());
                const result = await applyDoctorRepair(request);
                state.mutationCount += 1;
                send(200, { ok: true, result });
                return;
            }
            if (method === "GET" && pathname === "/api/v1/activity") {
                send(200, { ok: true, events: await getActivity() });
                return;
            }
            if (method === "GET" && pathname === "/api/v1/update") {
                send(200, { ok: true, update: await getUpdateStatus() });
                return;
            }
            if (method === "GET" && pathname === "/api/v1/onboarding") {
                send(200, { ok: true, onboarding: await getOnboardingStatus() });
                return;
            }
            if (method === "GET" && pathname === "/api/v1/chat/threads") {
                if (typeof getChatThreads !== "function")
                    throw badRequest("Native chat is unavailable.");
                send(200, { ok: true, chat: await getChatThreads() });
                return;
            }
            if (method === "POST" && pathname === "/api/v1/chat/search") {
                authorizeMutation();
                if (typeof searchChatThreads !== "function")
                    throw badRequest("ChatGPT conversation search is unavailable.");
                const body = validateExactObject(await readBody(), ["query"], "ChatGPT search");
                if (typeof body.query !== "string" || body.query.trim().length < 2
                    || [...body.query].length > 120 || /[\x00-\x1f\x7f]/u.test(body.query))
                    throw badRequest("Search requires 2–120 printable characters.");
                send(200, { ok: true, search: await searchChatThreads(body) });
                return;
            }
            if (method === "POST" && pathname === "/api/v1/chat/project") {
                authorizeMutation();
                if (typeof browseChatProject !== "function")
                    throw badRequest("ChatGPT project browsing is unavailable.");
                const body = validateExactObject(await readBody(), ["projectId"], "ChatGPT project");
                if (typeof body.projectId !== "string" || !/^g-p-[a-zA-Z0-9-]{8,100}$/u.test(body.projectId))
                    throw badRequest("Invalid ChatGPT project identity.");
                send(200, { ok: true, project: await browseChatProject(body) });
                return;
            }
            if (method === "POST" && pathname === "/api/v1/chat/conversation_action") {
                authorizeMutation();
                if (typeof controlChatConversation !== "function")
                    throw badRequest("ChatGPT conversation actions are unavailable.");
                const body = validateExactObject(await readBody(), ["tabId", "conversationId", "action", "expectedTitle", "title", "mutationId", "targetProjectId", "sharedUrl"], "ChatGPT conversation action");
                if (!Number.isSafeInteger(body.tabId) || body.tabId < 1
                    || typeof body.conversationId !== "string"
                    || !/^[a-zA-Z0-9-]{8,160}$/u.test(body.conversationId)
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
                    || (body.action === "inspect" && (body.expectedTitle !== undefined || body.mutationId !== undefined))
                    || (body.action !== "inspect" && (typeof body.mutationId !== "string"
                        || !/^cma-[a-f0-9-]{36}$/u.test(body.mutationId))))
                    throw badRequest("Invalid ChatGPT conversation operation or identity.");
                const result = await controlChatConversation(body);
                if (body.action !== "inspect")
                    state.mutationCount += 1;
                send(200, { ok: true, conversationAction: result });
                return;
            }
            if (method === "POST" && pathname === "/api/v1/chat/message_edit") {
                authorizeMutation();
                if (typeof editChatMessage !== "function")
                    throw badRequest("Native Chat message editing is unavailable.");
                const body = validateExactObject(await readBody(), ["messageId", "oldText", "newText", "mutationId"], "Native Chat message edit");
                if (typeof body.messageId !== "string"
                    || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}:user$/iu.test(body.messageId)
                    || typeof body.oldText !== "string" || !body.oldText.trim()
                    || body.oldText !== body.oldText.trim() || body.oldText.length > 3500
                    || typeof body.newText !== "string" || !body.newText.trim()
                    || body.newText !== body.newText.trim() || body.newText.length > 3500
                    || body.newText === body.oldText || /[\x00]/u.test(body.newText)
                    || typeof body.mutationId !== "string" || !/^mde-[a-f0-9-]{36}$/u.test(body.mutationId))
                    throw badRequest("An exact original user message and a changed edit are required.");
                const edit = await editChatMessage(body);
                state.mutationCount += 1;
                send(200, { ok: true, edit });
                return;
            }
            if (method === "GET" && pathname === "/api/v1/chat/state") {
                if (typeof getChatState !== "function")
                    throw badRequest("Native chat is unavailable.");
                send(200, { ok: true, chat: await getChatState() });
                return;
            }
            if (method === "GET" && pathname === "/api/v1/chat/tools") {
                if (typeof getChatTools !== "function")
                    throw badRequest("Native Chat tool discovery is unavailable.");
                send(200, { ok: true, tools: await getChatTools() });
                return;
            }
            if (method === "GET" && pathname === "/api/v1/chat/model") {
                if (typeof getChatModel !== "function")
                    throw badRequest("Native Chat model selection is unavailable.");
                send(200, { ok: true, model: await getChatModel() });
                return;
            }
            if (method === "POST" && pathname === "/api/v1/chat/model") {
                authorizeMutation();
                if (typeof changeChatModel !== "function")
                    throw badRequest("Native Chat model selection is unavailable.");
                const body = validateExactObject(await readBody(), ["action", "choice", "direction"], "Chat model selection");
                if (!["discover", "choose", "power", "catalog"].includes(String(body.action))
                    || (body.action === "choose" && (typeof body.choice !== "string" || !body.choice.trim() || body.choice.length > 80))
                    || (body.action === "power" && !["left", "right"].includes(String(body.direction)))
                    || (body.action !== "choose" && body.choice !== undefined)
                    || (body.action !== "power" && body.direction !== undefined))
                    throw badRequest("Chat model selection requires an offered choice or an effort direction.");
                const model = await changeChatModel(body);
                state.mutationCount += 1;
                send(200, { ok: true, model });
                return;
            }
            if (method === "POST" && pathname === "/api/v1/chat/select") {
                authorizeMutation();
                if (typeof selectChatThread !== "function")
                    throw badRequest("Native chat is unavailable.");
                const body = validateExactObject(await readBody(), ["tabId", "conversationId"], "Native chat selection");
                if (!Number.isSafeInteger(body.tabId) || body.tabId < 1 || typeof body.conversationId !== "string" || !/^[A-Za-z0-9-]{8,160}$/u.test(body.conversationId))
                    throw badRequest("Invalid conversation identity.");
                const selected = await selectChatThread(body);
                state.mutationCount += 1;
                send(200, { ok: true, chat: selected });
                return;
            }
            if (method === "POST" && pathname === "/api/v1/chat/new") {
                authorizeMutation();
                if (typeof startNewChat !== "function")
                    throw badRequest("New Chat is unavailable.");
                const body = validateExactObject(await readBody(), ["creationId", "text", "model", "effort", "tool", "file"], "Native New Chat");
                if (typeof body.creationId !== "string" || !/^nch-[a-f0-9-]{36}$/u.test(body.creationId) ||
                    typeof body.text !== "string" || !body.text.trim() || body.text.length > 1500 || /[\r\n\0]/u.test(body.text)
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
                        || typeof body.file.name !== "string" || !body.file.name.trim() || body.file.name.length > 255
                        || !Number.isSafeInteger(body.file.size) || body.file.size < 1
                        || body.file.size > 100 * 1024 * 1024))
                    || (body.tool !== undefined && body.file !== undefined))
                    throw badRequest("New Chat requires a unique initial prompt, offered tool or selected local file.");
                const creation = await startNewChat(body);
                state.mutationCount += 1;
                send(200, { ok: true, creation });
                return;
            }
            if (method === "POST" && pathname === "/api/v1/chat/send") {
                authorizeMutation();
                if (typeof sendChatText !== "function")
                    throw badRequest("Native chat is unavailable.");
                const body = validateExactObject(await readBody(), ["deliveryId", "text", "tool", "file"], "Native chat delivery");
                if (typeof body.deliveryId !== "string" || !/^tgb-[a-f0-9-]{36}$/u.test(body.deliveryId) || typeof body.text !== "string" || (!body.text.trim() && !body.file) || body.text.length > 4000
                    || (body.tool !== undefined && (!body.tool || typeof body.tool !== "object" || Array.isArray(body.tool)
                        || Object.keys(body.tool).some(k => !["name", "kind"].includes(k))
                        || typeof body.tool.name !== "string" || !body.tool.name.trim() || body.tool.name.length > 90
                        || (body.tool.kind === "tool"
                            ? !/^(Web search|Web araması|Create image|Görsel oluştur|Deep research|Derin araştırma)$/iu.test(body.tool.name)
                            : body.tool.kind !== "app" || !/^(Gmail|Equinox Local)$/u.test(body.tool.name))))
                    || (body.file !== undefined && (!body.file || typeof body.file !== "object" || Array.isArray(body.file)
                        || Object.keys(body.file).some(k => !["path", "name", "size"].includes(k))
                        || typeof body.file.path !== "string" || body.file.path.length > 4096
                        || typeof body.file.name !== "string" || !body.file.name.trim() || body.file.name.length > 255
                        || !Number.isSafeInteger(body.file.size) || body.file.size < 1
                        || body.file.size > 100 * 1024 * 1024))
                    || (body.tool !== undefined && body.file !== undefined))
                    throw badRequest("Invalid Chat message, account tool or delivery id.");
                const delivery = await sendChatText(body);
                state.mutationCount += 1;
                send(200, { ok: true, delivery });
                return;
            }
            if (method === "GET" && pathname === "/api/v1/tasks") {
                if (typeof getTasks !== "function") {
                    const error = new Error("Task controls are unavailable on this installation.");
                    error.statusCode = 503;
                    throw error;
                }
                send(200, { ok: true, tasks: await getTasks() });
                return;
            }
            const taskRoute = parseTaskRoute(pathname);
            if (method === "GET" && taskRoute?.action === null) {
                if (typeof getTask !== "function") {
                    const error = new Error("Task controls are unavailable on this installation.");
                    error.statusCode = 503;
                    throw error;
                }
                send(200, { ok: true, task: await getTask(taskRoute.taskId) });
                return;
            }
            if (method === "PUT" && taskRoute?.action === null) {
                authorizeMutation();
                if (typeof updateTask !== "function") {
                    const error = new Error("Task editing is unavailable on this installation.");
                    error.statusCode = 503;
                    throw error;
                }
                const task = await updateTask(taskRoute.taskId, validateTaskUpdateRequest(await readBody()));
                state.mutationCount += 1;
                send(200, { ok: true, task });
                return;
            }
            if (method === "POST" && taskRoute?.action) {
                authorizeMutation();
                validateEmptyObject(await readBody(), "Task action");
                if (taskRoute.action === "delete") {
                    if (typeof deleteTask !== "function") {
                        const error = new Error("Task deletion is unavailable on this installation.");
                        error.statusCode = 503;
                        throw error;
                    }
                    const deleted = await deleteTask(taskRoute.taskId);
                    state.mutationCount += 1;
                    send(200, { ok: true, deleted });
                    return;
                }
                let task;
                if (taskRoute.action === "complete") {
                    if (typeof completeTask !== "function") {
                        const error = new Error("Task completion is unavailable on this installation.");
                        error.statusCode = 503;
                        throw error;
                    }
                    task = await completeTask(taskRoute.taskId);
                }
                else if (taskRoute.action === "cancel") {
                    if (typeof cancelTask !== "function") {
                        const error = new Error("Task cancellation is unavailable on this installation.");
                        error.statusCode = 503;
                        throw error;
                    }
                    task = await cancelTask(taskRoute.taskId);
                }
                else if (taskRoute.action === "continuation/cancel") {
                    if (typeof cancelTaskContinuation !== "function") {
                        const error = new Error("Auto Continue cancellation is unavailable on this installation.");
                        error.statusCode = 503;
                        throw error;
                    }
                    task = await cancelTaskContinuation(taskRoute.taskId);
                }
                else if (taskRoute.action === "fresh-resume/cancel") {
                    if (typeof cancelTaskFreshResume !== "function") {
                        const error = new Error("Fresh Chat Resume cancellation is unavailable on this installation.");
                        error.statusCode = 503;
                        throw error;
                    }
                    task = await cancelTaskFreshResume(taskRoute.taskId);
                }
                else {
                    if (typeof abandonTaskFreshResume !== "function") {
                        const error = new Error("Fresh Chat Resume recovery is unavailable on this installation.");
                        error.statusCode = 503;
                        throw error;
                    }
                    task = await abandonTaskFreshResume(taskRoute.taskId);
                }
                state.mutationCount += 1;
                send(200, { ok: true, task });
                return;
            }
            if (method === "POST" && pathname === "/api/v1/agent/pause") {
                authorizeMutation();
                validateEmptyObject(await readBody(), "Agent pause");
                if (typeof pauseAgent !== "function") {
                    const error = new Error("Agent emergency stop is unavailable on this installation.");
                    error.statusCode = 503;
                    throw error;
                }
                const agentControl = await pauseAgent();
                state.mutationCount += 1;
                send(200, { ok: true, agentControl });
                return;
            }
            if (method === "POST" && pathname === "/api/v1/agent/resume") {
                authorizeMutation();
                validateEmptyObject(await readBody(), "Agent resume");
                if (typeof resumeAgent !== "function") {
                    const error = new Error("Agent resume is unavailable on this installation.");
                    error.statusCode = 503;
                    throw error;
                }
                const agentControl = await resumeAgent();
                state.mutationCount += 1;
                send(200, { ok: true, agentControl });
                return;
            }
            if (method === "POST" && pathname === "/api/v1/onboarding/tunnel") {
                authorizeMutation();
                if (typeof configureTunnel !== "function") {
                    const error = new Error("Tunnel onboarding is unavailable on this installation.");
                    error.statusCode = 503;
                    throw error;
                }
                const result = await configureTunnel(await readBody());
                state.mutationCount += 1;
                send(202, { ok: true, result });
                return;
            }
            if (method === "POST" && pathname === "/api/v1/runtime/restart") {
                authorizeMutation();
                validateEmptyObject(await readBody(), "Runtime restart");
                if (typeof restartRuntime !== "function") {
                    const error = new Error("Equinox Local restart is unavailable on this installation.");
                    error.statusCode = 503;
                    throw error;
                }
                const result = await restartRuntime();
                state.mutationCount += 1;
                send(202, { ok: true, result });
                return;
            }
            if (method === "POST" && pathname === "/api/v1/uninstall") {
                authorizeMutation();
                if (typeof scheduleUninstall !== "function") {
                    const error = new Error("Equinox Local uninstall is unavailable on this installation.");
                    error.statusCode = 503;
                    throw error;
                }
                const request = validateUninstallRequest(await readBody());
                const result = await scheduleUninstall(request);
                state.mutationCount += 1;
                send(202, { ok: true, result });
                return;
            }
            if (method === "POST" && pathname === "/api/v1/update/check") {
                authorizeMutation();
                validateEmptyObject(await readBody(), "Update check");
                if (typeof checkForUpdates !== "function") {
                    const error = new Error("Equinox Local update check is unavailable on this installation.");
                    error.statusCode = 503;
                    throw error;
                }
                send(200, { ok: true, update: await checkForUpdates() });
                return;
            }
            if (method === "POST" && pathname === "/api/v1/update/apply") {
                authorizeMutation();
                validateEmptyObject(await readBody(), "Update apply");
                if (typeof applyUpdate !== "function") {
                    const error = new Error("Equinox Local update installation is unavailable on this installation.");
                    error.statusCode = 503;
                    throw error;
                }
                const result = await applyUpdate();
                state.mutationCount += 1;
                send(202, { ok: true, result });
                return;
            }
            if (method === "PUT" && pathname === "/api/v1/config") {
                authorizeMutation();
                const body = validateReplaceEnvelope(await readBody());
                const result = await configManager.replacePersisted(body.config, {
                    expectedRevision: body.expectedRevision,
                });
                state.mutationCount += 1;
                send(200, {
                    ok: true,
                    previousRevision: result.previousRevision,
                    persistedRevision: result.persistedRevision,
                    restartRequired: true,
                });
                return;
            }
            if (method === "POST" && pathname === "/api/v1/folder-picker") {
                authorizeMutation();
                validateEmptyObject(await readBody(), "Folder picker");
                if (typeof chooseFolder !== "function") {
                    const error = new Error("Visual folder selection is unavailable on this installation.");
                    error.statusCode = 501;
                    throw error;
                }
                const selectedPath = await chooseFolder();
                send(200, { ok: true, cancelled: selectedPath === null, path: selectedPath });
                return;
            }
            if (method === "POST" && pathname === "/api/v1/browser/agent/open") {
                authorizeMutation();
                validateEmptyObject(await readBody(), "Agent Browser open");
                if (typeof openAgentBrowser !== "function") {
                    const error = new Error("Agent Browser launch control is unavailable.");
                    error.statusCode = 503;
                    throw error;
                }
                const agentBrowser = await openAgentBrowser();
                state.mutationCount += 1;
                send(200, { ok: true, agentBrowser });
                return;
            }
            if (method === "PUT" && pathname === "/api/v1/browser/settings") {
                authorizeMutation();
                if (typeof updateBrowserSettings !== "function") {
                    const error = new Error("Equinox Browser settings control is unavailable.");
                    error.statusCode = 503;
                    throw error;
                }
                const settings = validateBrowserSettings(await readBody());
                const result = await updateBrowserSettings(settings);
                state.mutationCount += 1;
                send(200, { ok: true, settings: result });
                return;
            }
            if (method === "GET" && pathname === "/api/v1/integrations/github") {
                if (typeof checkGitHub !== "function") {
                    const error = new Error("GitHub integration status is unavailable.");
                    error.statusCode = 503;
                    throw error;
                }
                send(200, { ok: true, github: await checkGitHub() });
                return;
            }
            if (method === "GET" && pathname === "/api/v1/integrations/peekaboo") {
                if (typeof getPeekabooStatus !== "function") {
                    const error = new Error("Peekaboo integration status is unavailable.");
                    error.statusCode = 503;
                    throw error;
                }
                send(200, { ok: true, peekaboo: await getPeekabooStatus() });
                return;
            }
            if (method === "POST" && pathname === "/api/v1/integrations/github/check") {
                authorizeMutation();
                validateEmptyObject(await readBody(), "GitHub check");
                if (typeof checkGitHub !== "function") {
                    const error = new Error("GitHub integration check is unavailable.");
                    error.statusCode = 503;
                    throw error;
                }
                const result = await checkGitHub();
                send(200, {
                    ok: true,
                    github: result,
                });
                return;
            }
            if (method === "GET" && pathname === "/api/v1/integrations/http-profiles") {
                if (typeof getHttpProfiles !== "function") {
                    const error = new Error("Authenticated HTTP profiles are unavailable.");
                    error.statusCode = 503;
                    throw error;
                }
                send(200, { ok: true, httpProfiles: await getHttpProfiles() });
                return;
            }
            if (method === "PUT" && pathname === "/api/v1/integrations/http-profiles/management") {
                authorizeMutation();
                if (typeof setHttpProfileManagement !== "function") {
                    const error = new Error("Authenticated HTTP profile management is unavailable.");
                    error.statusCode = 503;
                    throw error;
                }
                const request = validateHttpProfileManagementRequest(await readBody());
                const httpProfiles = await setHttpProfileManagement(request);
                state.mutationCount += 1;
                send(200, { ok: true, httpProfiles });
                return;
            }
            if (method === "PUT" && pathname === "/api/v1/integrations/http-profiles/profile") {
                authorizeMutation();
                if (typeof upsertHttpProfile !== "function") {
                    const error = new Error("Authenticated HTTP profile setup is unavailable.");
                    error.statusCode = 503;
                    throw error;
                }
                const request = validateHttpProfileControlUpsert(await readBody());
                const profile = await upsertHttpProfile(request);
                state.mutationCount += 1;
                send(200, { ok: true, profile });
                return;
            }
            if (method === "POST" && pathname === "/api/v1/integrations/http-profiles/test") {
                authorizeMutation();
                if (typeof testHttpProfile !== "function") {
                    const error = new Error("Authenticated HTTP profile test is unavailable.");
                    error.statusCode = 503;
                    throw error;
                }
                const request = validateHttpProfileTestRequest(await readBody());
                const result = await testHttpProfile(request);
                state.mutationCount += 1;
                send(200, { ok: true, result });
                return;
            }
            if (method === "POST" && pathname === "/api/v1/integrations/http-profiles/delete") {
                authorizeMutation();
                if (typeof deleteHttpProfile !== "function") {
                    const error = new Error("Authenticated HTTP profile deletion is unavailable.");
                    error.statusCode = 503;
                    throw error;
                }
                const request = validateHttpProfileDeleteRequest(await readBody());
                const result = await deleteHttpProfile(request);
                state.mutationCount += 1;
                send(200, { ok: true, result });
                return;
            }
            if (method === "GET" && pathname === "/api/v1/files/import-settings") {
                if (typeof getWebImportSettings !== "function") {
                    const error = new Error("Web file transfer settings are unavailable.");
                    error.statusCode = 503;
                    throw error;
                }
                send(200, { ok: true, webFileTransfer: await getWebImportSettings() });
                return;
            }
            if (method === "PUT" && pathname === "/api/v1/files/import-settings") {
                authorizeMutation();
                if (typeof updateWebImportDownloads !== "function") {
                    const error = new Error("Web file transfer settings control is unavailable.");
                    error.statusCode = 503;
                    throw error;
                }
                const body = await readBody();
                const keys = body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body) : [];
                if (keys.length !== 1 || keys[0] !== "path" || !(body.path === null || typeof body.path === "string")) {
                    const error = new Error("Web file transfer settings accept only path as an absolute folder path or null for default.");
                    error.statusCode = 400;
                    throw error;
                }
                const webFileTransfer = await updateWebImportDownloads({ path: body.path });
                state.mutationCount += 1;
                send(200, { ok: true, webFileTransfer });
                return;
            }
            if (method === "GET" && pathname === "/api/v1/integrations/telegram") {
                if (typeof getTelegramStatus !== "function") {
                    const error = new Error("Telegram integration is unavailable.");
                    error.statusCode = 503;
                    throw error;
                }
                send(200, { ok: true, telegram: await getTelegramStatus() });
                return;
            }
            if (method === "PUT" && pathname === "/api/v1/integrations/telegram/remote-control") {
                authorizeMutation();
                if (typeof updateTelegramRemoteControl !== "function") {
                    const error = new Error("Telegram remote-control settings are unavailable.");
                    error.statusCode = 503;
                    throw error;
                }
                const body = await readBody();
                const keys = body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body) : [];
                if (keys.length !== 1 || keys[0] !== "enabled" || typeof body.enabled !== "boolean") {
                    const error = new Error("Telegram remote-control settings accept only enabled as a boolean.");
                    error.statusCode = 400;
                    throw error;
                }
                const remoteControl = await updateTelegramRemoteControl({ enabled: body.enabled });
                state.mutationCount += 1;
                send(200, { ok: true, remoteControl });
                return;
            }
            if (method === "PUT" && pathname === "/api/v1/integrations/telegram/downloads") {
                authorizeMutation();
                if (typeof updateTelegramDownloads !== "function") {
                    const error = new Error("Telegram download location control is unavailable.");
                    error.statusCode = 503;
                    throw error;
                }
                const body = await readBody();
                const keys = body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body) : [];
                if (keys.length !== 1 || keys[0] !== "path" || !(body.path === null || typeof body.path === "string")) {
                    const error = new Error("Telegram download settings accept only path as an absolute folder path or null for default.");
                    error.statusCode = 400;
                    throw error;
                }
                const downloads = await updateTelegramDownloads({ path: body.path });
                state.mutationCount += 1;
                send(200, { ok: true, downloads });
                return;
            }
            if (method === "PUT" && pathname === "/api/v1/integrations/telegram") {
                authorizeMutation();
                if (typeof configureTelegram !== "function") {
                    const error = new Error("Telegram integration setup is unavailable.");
                    error.statusCode = 503;
                    throw error;
                }
                const telegram = await configureTelegram(await readBody());
                state.mutationCount += 1;
                send(200, { ok: true, telegram });
                return;
            }
            if (method === "POST" && pathname === "/api/v1/integrations/telegram/pair/start") {
                authorizeMutation();
                if (typeof startTelegramPairing !== "function") {
                    const error = new Error("Telegram pairing is unavailable.");
                    error.statusCode = 503;
                    throw error;
                }
                const body = await readBody();
                const keys = body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body) : [];
                if (keys.length !== 1 || keys[0] !== "botToken" || typeof body.botToken !== "string") {
                    const error = new Error("Telegram pairing start accepts only botToken.");
                    error.statusCode = 400;
                    throw error;
                }
                const pairing = await startTelegramPairing({ botToken: body.botToken });
                state.mutationCount += 1;
                send(200, { ok: true, pairing });
                return;
            }
            if (method === "GET" && pathname === "/api/v1/integrations/telegram/pair") {
                if (typeof pollTelegramPairing !== "function") {
                    const error = new Error("Telegram pairing status is unavailable.");
                    error.statusCode = 503;
                    throw error;
                }
                send(200, { ok: true, pairing: await pollTelegramPairing() });
                return;
            }
            if (method === "POST" && pathname === "/api/v1/integrations/telegram/pair/confirm") {
                authorizeMutation();
                validateEmptyObject(await readBody(), "Telegram pairing confirmation");
                if (typeof confirmTelegramPairing !== "function") {
                    const error = new Error("Telegram pairing confirmation is unavailable.");
                    error.statusCode = 503;
                    throw error;
                }
                const telegram = await confirmTelegramPairing();
                state.mutationCount += 1;
                send(200, { ok: true, telegram });
                return;
            }
            if (method === "POST" && pathname === "/api/v1/integrations/telegram/pair/cancel") {
                authorizeMutation();
                validateEmptyObject(await readBody(), "Telegram pairing cancellation");
                if (typeof cancelTelegramPairing !== "function") {
                    const error = new Error("Telegram pairing cancellation is unavailable.");
                    error.statusCode = 503;
                    throw error;
                }
                const result = await cancelTelegramPairing();
                state.mutationCount += 1;
                send(200, { ok: true, result });
                return;
            }
            if (method === "POST" && pathname === "/api/v1/integrations/telegram/test") {
                authorizeMutation();
                validateEmptyObject(await readBody(), "Telegram test");
                if (typeof testTelegram !== "function") {
                    const error = new Error("Telegram integration test is unavailable.");
                    error.statusCode = 503;
                    throw error;
                }
                const result = await testTelegram();
                state.mutationCount += 1;
                send(200, { ok: true, result });
                return;
            }
            if (method === "POST" && pathname === "/api/v1/integrations/telegram/disconnect") {
                authorizeMutation();
                validateEmptyObject(await readBody(), "Telegram disconnect");
                if (typeof disconnectTelegram !== "function") {
                    const error = new Error("Telegram integration disconnect is unavailable.");
                    error.statusCode = 503;
                    throw error;
                }
                const result = await disconnectTelegram();
                state.mutationCount += 1;
                send(200, { ok: true, result });
                return;
            }
            send(404, { ok: false, error: "Control Center API endpoint bulunamadı." });
        }
        catch (error) {
            const statusCode = Number.isInteger(error?.statusCode)
                ? error.statusCode
                : error?.code === EQUINOX_LOCAL_CONFIG_ERROR_CODES.revisionConflict || error?.code === TASK_CAPSULE_ERROR_CODES.revisionConflict || error?.code === TASK_CAPSULE_ERROR_CODES.terminalRequired
                    ? 409
                    : error?.code === TASK_CAPSULE_ERROR_CODES.notFound
                        ? 404
                        : 500;
            if (statusCode === 500 && recordInternalError) {
                void Promise.resolve(recordInternalError(error)).catch(() => { });
            }
            send(statusCode, { ok: false, error: publicErrorMessage(error, statusCode) });
        }
    };
    // A second permission boundary inside the private IPC server, independent
    // of the renderer and Electron main allowlist. Keep lists synchronized.
    const UI_READ_PATHS = new Set([
        "/api/v1/health", "/api/v1/status", "/api/v1/activity", "/api/v1/tasks", "/api/v1/chat/threads", "/api/v1/chat/state", "/api/v1/chat/model",
        "/api/v1/onboarding", "/api/v1/doctor", "/api/v1/doctor/repairs",
        "/api/v1/config", "/api/v1/update", "/api/v1/turn-budget",
        "/api/v1/integrations/peekaboo", "/api/v1/integrations/telegram",
        "/api/v1/integrations/telegram/pair", "/api/v1/integrations/http-profiles",
        "/api/v1/files/import-settings",
    ]);
    const UI_WRITE_PATHS = {
        POST: new Set([
            "/api/v1/chat/select", "/api/v1/chat/send", "/api/v1/chat/new", "/api/v1/chat/model", "/api/v1/chat/search", "/api/v1/chat/project", "/api/v1/chat/conversation_action",
            "/api/v1/agent/pause", "/api/v1/agent/resume", "/api/v1/runtime/restart",
            "/api/v1/browser/agent/open", "/api/v1/doctor/repair", "/api/v1/update/check",
            "/api/v1/update/apply", "/api/v1/uninstall", "/api/v1/folder-picker",
            "/api/v1/onboarding/tunnel", "/api/v1/integrations/telegram/pair/start",
            "/api/v1/integrations/telegram/pair/confirm", "/api/v1/integrations/telegram/pair/cancel",
            "/api/v1/integrations/telegram/test", "/api/v1/integrations/telegram/disconnect",
            "/api/v1/integrations/http-profiles/test", "/api/v1/integrations/http-profiles/delete",
        ]),
        PUT: new Set([
            "/api/v1/config", "/api/v1/turn-budget", "/api/v1/browser/settings",
            "/api/v1/files/import-settings", "/api/v1/integrations/telegram/downloads",
            "/api/v1/integrations/telegram/remote-control", "/api/v1/integrations/telegram",
            "/api/v1/integrations/http-profiles/management", "/api/v1/integrations/http-profiles/profile",
        ]),
    };
    function allowedDesktopUiOperation(method, route) {
        if (method === "GET" && (UI_READ_PATHS.has(route) || /^\/api\/v1\/tasks\/task-[a-z0-9-]{6,80}$/u.test(route)))
            return true;
        if (UI_WRITE_PATHS[method]?.has(route))
            return true;
        const match = /^\/api\/v1\/tasks\/task-[a-z0-9-]{6,80}(?:\/(complete|cancel|delete|continuation\/cancel|fresh-resume\/cancel|fresh-resume\/abandon))?$/u.exec(route);
        return Boolean(match && ((method === "PUT" && !match[1]) || (method === "POST" && match[1])));
    }
    // This entrypoint is bound only to the existing current-user token-authenticated
    // CLI IPC server. It is never exposed as an HTTP route or an agent capability.
    const executeDesktop = async (value) => {
        if (!value || typeof value !== "object" || Array.isArray(value) ||
            Object.keys(value).some(key => !["method", "path", "body", "backgroundRefresh"].includes(key))) {
            throw badRequest("Invalid desktop operation envelope.");
        }
        const { method, path: route, body, backgroundRefresh = false } = value;
        if (typeof method !== "string" || typeof route !== "string" || route.length > 180 ||
            !allowedDesktopUiOperation(method, route) ||
            typeof backgroundRefresh !== "boolean" || (backgroundRefresh && method !== "GET") ||
            (method === "GET" ? body !== undefined : typeof body !== "string" || Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES)) {
            throw badRequest("Invalid desktop operation arguments.");
        }
        if (!(backgroundRefresh && CONTROL_CENTER_BACKGROUND_REFRESH_PATHS.has(route)))
            state.requestCount += 1;
        let response;
        const readBody = async () => {
            if (typeof body !== "string" || body.length === 0)
                throw badRequest("JSON request body cannot be empty.");
            try {
                return JSON.parse(body);
            }
            catch {
                throw badRequest("Invalid desktop JSON request body.");
            }
        };
        // A mutation here has the authenticated private IPC token, not a web
        // origin/CSRF token. Its route handler still performs all validation and
        // capability-specific authorization/revision/mutation guards.
        await dispatchControlOperation(method, route, readBody, () => { }, (status, payload) => { response = { status, body: payload }; });
        if (!response)
            throw new Error("Desktop operation produced no result.");
        return response;
    };
    // Management is an in-process dispatcher behind an already-bound private
    // IPC socket. No TCP listener or HTTP dashboard is started by this module.
    const start = async () => {
        if (!state.active) {
            state.active = true;
            state.startedAt = new Date().toISOString();
        }
        return snapshot();
    };
    const close = async () => { state.active = false; };
    return Object.freeze({ start, close, snapshot, executeDesktop });
}
