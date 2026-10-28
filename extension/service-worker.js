"use strict";
// Canonical TS7 owner of the classic Manifest V3 service worker shipped to Chrome.
// Keep this file a classic script: importScripts loads the packaged bookmark API.
importScripts("bookmarks.js");
function workerStorageLocal() {
    return globalThis.chrome.storage.local;
}
const HOST_NAME = "dev.equinox.browser";
const PROTOCOL_VERSION = "1.3";
const BRIDGE_PROTOCOL_VERSION = 1;
// Keep one sliding debugger lease across active browser-control bursts so Chrome's debugging infobar does not flicker between related actions. Passive ChatGPT turn-state reads do not use debugger.
const DEFAULT_ATTACH_IDLE_MS = 60_000;
const CONTINUATION_MUTATION_DETACH_MS = 250;
const MAX_SNAPSHOT_ELEMENTS = 250;
const SNAPSHOT_VERSION = 9;
const DELTA_SNAPSHOT_VERSION = 2;
const SCREENSHOT_VERSION = 4;
const REACQUIRE_VERSION = 2;
const COMPOUND_ACTION_VERSION = 4;
const DOUBLE_CLICK_VERSION = 1;
const POINTER_DRAG_VERSION = 1;
const HTML5_DRAG_VERSION = 1;
const WAIT_VERSION = 3;
const NAVIGATION_VERSION = 2;
const EMULATION_VERSION = 1;
const INPUT_VERSION = 3;
const ACTIONABILITY_VERSION = 7;
const REF_LIFECYCLE_VERSION = 1;
const CLICK_VERSION = 2;
const OBSERVATION_VERSION = 2;
const TOUCH_GESTURE_VERSION = 1;
const BOOKMARKS_VERSION = globalThis.EquinoxBrowserBookmarks.BOOKMARKS_VERSION;
const PDF_CONTENT_VERSION = 1;
const DOWNLOAD_LIFECYCLE_VERSION = 1;
const RANGE_VERSION = 2;
const AUTO_CONTINUE_VERSION = 1;
const FRESH_CHAT_RESUME_VERSION = 1;
const CHAT_BRIDGE_VERSION = 9;
const MAX_PDF_DOCUMENT_BYTES = 16 * 1024 * 1024;
const HTML5_DRAG_INTERCEPT_TIMEOUT_MS = 1_500;
const MAX_HTML5_DRAG_ITEMS = 32;
const MAX_HTML5_DRAG_FILES = 16;
const MAX_HTML5_DRAG_DATA_CHARS = 512 * 1024;
const MAX_SNAPSHOT_HISTORY = 8;
const MAX_REF_REGISTRY_ENTRIES = 2_000;
const NETWORK_IDLE_IGNORED_TYPES = new Set(["EventSource", "Media", "WebSocket"]);
const MAX_OBSERVATION_EVENTS = 500;
const CONSOLE_LEVEL_FILTERS = new Set([
    "log", "debug", "info", "error", "warning", "dir", "dirxml", "table", "trace", "clear",
    "startgroup", "startgroupcollapsed", "endgroup", "assert", "profile", "profileend", "count", "timeend",
]);
const NETWORK_RESOURCE_TYPE_FILTERS = new Set([
    "document",
    "stylesheet",
    "image",
    "media",
    "font",
    "script",
    "texttrack",
    "xhr",
    "fetch",
    "prefetch",
    "eventsource",
    "websocket",
    "manifest",
    "signedexchange",
    "ping",
    "cspviolationreport",
    "preflight",
    "fedcm",
    "other",
]);
const MAX_SCREENSHOT_DIMENSION = 32_000;
const MAX_SCREENSHOT_AREA = 80_000_000;
const MAX_SCREENSHOT_PNG_BYTES = 32 * 1024 * 1024;
const RESPONSE_CHUNK_CHARS = 512 * 1024;
const MAX_TAB_CREATION_EVENTS = 200;
const MAX_DOWNLOAD_CREATION_EVENTS = 200;
const MAX_DOWNLOADS_PER_ACTION = 8;
const DOWNLOAD_DISCOVERY_GRACE_MS = 250;
const TAB_CREATION_DISCOVERY_GRACE_MS = 150;
const HISTORY_NAVIGATION_TIMEOUT_MS = 5_000;
const HISTORY_METADATA_SETTLE_MS = 150;
const HISTORY_NAVIGATION_POLL_MS = 50;
const SELF_RELOAD_DELAY_MS = 250;
const NATIVE_RECONNECT_ALARM = "equinox-native-reconnect";
const LOCAL_REQUEST_TIMEOUT_MS = 5_000;
const BROWSER_ENABLED_STORAGE_KEY = "browserEnabled";
const BROWSER_CONTROL_CONSENT_STORAGE_KEY = "browserControlConsentVersion";
const CURRENT_BROWSER_CONTROL_CONSENT_VERSION = 2;
const AGENT_CURSOR_STORAGE_KEY = "agentCursorEnabled";
const AGENT_CURSOR_NAME_STORAGE_KEY = "agentCursorName";
const BROWSER_INSTANCE_ID_STORAGE_KEY = "browserInstanceId";
const BROWSER_CONTEXT_STORAGE_KEY = "browserContext";
const AUTO_CONTINUE_TARGET_STORAGE_KEY = "autoContinueTarget";
const AUTO_CONTINUE_RECEIPTS_STORAGE_KEY = "autoContinueDeliveryReceipts";
const FRESH_CHAT_RESUME_RECEIPTS_STORAGE_KEY = "freshChatResumeReceipts";
const CHAT_BRIDGE_RECEIPTS_STORAGE_KEY = "chatBridgeDeliveryReceipts";
const CHATGPT_CONTINUATION_STATE_PUSH = "equinox.chatgpt.continuationState.push";
const CHATGPT_CONTINUATION_STATE_GET = "equinox.chatgpt.continuationState.get";
const CHATGPT_CONTINUATION_CACHE_MAX_AGE_MS = 2_000;
const MAX_AUTO_CONTINUE_RECEIPTS = 64;
const MAX_FRESH_CHAT_RESUME_RECEIPTS = 64;
const MAX_CHAT_BRIDGE_RECEIPTS = 64;
const BROWSER_CONTEXT_VALUES = new Set(["agent", "user"]);
const AGENT_CURSOR_HOST_ID = "__equinox_browser_agent_cursor__";
const SCREENSHOT_ANNOTATION_HOST_ID = "__equinox_browser_ref_annotations__";
const MAX_SCREENSHOT_ANNOTATIONS = 50;
const DEFAULT_AGENT_CURSOR_NAME = "Agent";
const AGENT_CURSOR_IDLE_MS = 3_500;
function browserCapabilityVersions() {
    return {
        snapshot: SNAPSHOT_VERSION,
        deltaSnapshot: DELTA_SNAPSHOT_VERSION,
        screenshot: SCREENSHOT_VERSION,
        reacquire: REACQUIRE_VERSION,
        compoundAction: COMPOUND_ACTION_VERSION,
        doubleClick: DOUBLE_CLICK_VERSION,
        pointerDrag: POINTER_DRAG_VERSION,
        html5Drag: HTML5_DRAG_VERSION,
        wait: WAIT_VERSION,
        navigation: NAVIGATION_VERSION,
        emulation: EMULATION_VERSION,
        input: INPUT_VERSION,
        actionability: ACTIONABILITY_VERSION,
        refLifecycle: REF_LIFECYCLE_VERSION,
        click: CLICK_VERSION,
        observation: OBSERVATION_VERSION,
        touchGesture: TOUCH_GESTURE_VERSION,
        bookmarks: BOOKMARKS_VERSION,
        pdfContent: PDF_CONTENT_VERSION,
        downloadLifecycle: DOWNLOAD_LIFECYCLE_VERSION,
        rangeSet: RANGE_VERSION,
        autoContinue: AUTO_CONTINUE_VERSION,
        freshChatResume: FRESH_CHAT_RESUME_VERSION,
        chatBridge: CHAT_BRIDGE_VERSION,
    };
}
const INTERACTIVE_ROLES = new Set([
    "button",
    "link",
    "textbox",
    "searchbox",
    "checkbox",
    "radio",
    "combobox",
    "listbox",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "tab",
    "switch",
    "slider",
    "spinbutton",
    "option",
    "treeitem",
]);
const READABLE_ROLES = new Set([
    "heading",
    "paragraph",
    "StaticText",
    "alert",
    "status",
    "dialog",
]);
const SEMANTIC_CONTAINER_ROLES = new Set([
    "row",
    "article",
    "listitem",
    "group",
    "region",
]);
const SEMANTIC_CONTEXT_TEXT_ROLES = new Set([
    "statictext",
    "heading",
    "paragraph",
    "cell",
    "gridcell",
]);
const attachedTabs = new Map();
const refStates = new Map();
const refRegistries = new Map();
const snapshotHistories = new Map();
const networkWaitStates = new Map();
const networkResponseWaitStates = new Map();
const observationStates = new Map();
const dialogStates = new Map();
const html5DragInterceptStates = new Map();
let dialogSequence = 0;
const documentGenerations = new Map();
const tabCreationEvents = [];
let tabCreationSequence = 0;
const downloadCreationEvents = [];
let downloadCreationSequence = 0;
let nativePort = null;
let reconnectTimer = null;
let reconnectDelayMs = 500;
let immediateReconnectUsed = false;
let lastNativeDisconnectError = null;
let browserEnabled = false;
let browserEnabledLoaded = false;
let browserEnabledLoadPromise = null;
let browserControlConsentVersion = 0;
let browserControlConsentLoaded = false;
let browserControlConsentLoadPromise = null;
let agentCursorEnabled = true;
let agentCursorEnabledLoaded = false;
let agentCursorEnabledLoadPromise = null;
let agentCursorName = DEFAULT_AGENT_CURSOR_NAME;
let agentCursorNameLoaded = false;
let agentCursorNameLoadPromise = null;
let browserInstanceId = null;
let browserContext = "unassigned";
let browserIdentityLoaded = false;
let browserIdentityLoadPromise = null;
let autoContinueTarget = Object.freeze({ mode: "task-tab" });
let autoContinueTargetLoaded = false;
let autoContinueTargetLoadPromise = null;
let autoContinueReceiptMutation = Promise.resolve();
let freshChatResumeReceiptMutation = Promise.resolve();
let chatBridgeReceiptMutation = Promise.resolve();
let localBridgeConnected = false;
let nextLocalRequestId = 1;
const pendingLocalRequests = new Map();
const intentionallyDisconnectedPorts = new WeakSet();
const chatGptContinuationStateCache = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function errorMessage(error) {
    if (error !== null && typeof error === "object" && "message" in error && error.message) {
        return String(error.message);
    }
    return String(error);
}
function rejectPendingHtml5DragIntercept(tabId, reason) {
    const state = html5DragInterceptStates.get(tabId);
    if (!state)
        return false;
    html5DragInterceptStates.delete(tabId);
    if (state.timer !== null)
        clearTimeout(state.timer);
    if (!state.settled) {
        state.settled = true;
        state.reject?.(new Error(reason));
    }
    return true;
}
function beginHtml5DragIntercept(tabId, timeoutMs = HTML5_DRAG_INTERCEPT_TIMEOUT_MS) {
    if (html5DragInterceptStates.has(tabId)) {
        throw new Error("Another HTML5 drag interception is already active for this tab");
    }
    const state = {
        armed: false,
        settled: false,
        timer: null,
        resolve: null,
        reject: null,
        promise: null,
    };
    state.promise = new Promise((resolve, reject) => {
        state.resolve = resolve;
        state.reject = reject;
    });
    state.promise?.catch(() => { });
    state.timer = setTimeout(() => {
        if (html5DragInterceptStates.get(tabId) !== state || state.settled)
            return;
        html5DragInterceptStates.delete(tabId);
        state.settled = true;
        state.reject?.(new Error("Timed out waiting for Chrome to intercept an HTML5 drag payload"));
    }, Math.max(100, Math.min(Number(timeoutMs) || HTML5_DRAG_INTERCEPT_TIMEOUT_MS, 5_000)));
    html5DragInterceptStates.set(tabId, state);
    return state;
}
function resolveHtml5DragIntercept(tabId, source, params) {
    const state = html5DragInterceptStates.get(tabId);
    if (!state)
        return false;
    if (!state.armed)
        return false;
    if (source?.sessionId) {
        rejectPendingHtml5DragIntercept(tabId, "HTML5 drag interception from a child CDP session is not supported safely");
        return true;
    }
    html5DragInterceptStates.delete(tabId);
    if (state.timer !== null)
        clearTimeout(state.timer);
    state.settled = true;
    state.resolve?.(params?.data ?? null);
    return true;
}
function normalizeHtml5DragData(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new Error("Chrome did not provide a valid HTML5 drag payload");
    }
    const payload = data;
    const items = Array.isArray(payload.items) ? payload.items : [];
    const files = Array.isArray(payload.files) ? payload.files : [];
    if (items.length > MAX_HTML5_DRAG_ITEMS)
        throw new Error("HTML5 drag payload contains too many data items");
    if (files.length > MAX_HTML5_DRAG_FILES)
        throw new Error("HTML5 drag payload contains too many files");
    let totalChars = 0;
    const normalizedItems = items.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
            throw new Error("HTML5 drag payload contains an invalid data item");
        }
        const value = item;
        const mimeType = String(value.mimeType || "");
        const itemData = String(value.data ?? "");
        const title = value.title == null ? null : String(value.title);
        const baseURL = value.baseURL == null ? null : String(value.baseURL);
        if (!mimeType || mimeType.length > 256)
            throw new Error("HTML5 drag payload contains an invalid MIME type");
        if (title != null && title.length > 4_096)
            throw new Error("HTML5 drag payload title is too large");
        if (baseURL != null && baseURL.length > 8_192)
            throw new Error("HTML5 drag payload base URL is too large");
        totalChars += mimeType.length + itemData.length + (title?.length || 0) + (baseURL?.length || 0);
        return {
            mimeType,
            data: itemData,
            ...(title == null ? {} : { title }),
            ...(baseURL == null ? {} : { baseURL }),
        };
    });
    const normalizedFiles = files.map((file) => {
        const value = String(file || "");
        if (!value || value.length > 8_192)
            throw new Error("HTML5 drag payload contains an invalid file path");
        totalChars += value.length;
        return value;
    });
    if (totalChars > MAX_HTML5_DRAG_DATA_CHARS)
        throw new Error("HTML5 drag payload exceeds the bounded data limit");
    const dragOperationsMask = Number(payload.dragOperationsMask);
    if (!Number.isInteger(dragOperationsMask) || dragOperationsMask < 0 || dragOperationsMask > 0xffff_ffff) {
        throw new Error("HTML5 drag payload contains an invalid operation mask");
    }
    return {
        data: {
            items: normalizedItems,
            files: normalizedFiles,
            dragOperationsMask,
        },
        summary: {
            itemCount: normalizedItems.length,
            fileCount: normalizedFiles.length,
            hasFiles: normalizedFiles.length > 0,
            mimeTypes: [...new Set(normalizedItems.map((item) => item.mimeType))].slice(0, 16),
            dragOperationsMask,
        },
    };
}
function rejectPendingLocalRequests(reason) {
    for (const [id, waiter] of pendingLocalRequests.entries()) {
        clearTimeout(waiter.timer);
        pendingLocalRequests.delete(id);
        waiter.reject(new Error(reason));
    }
}
function handleLocalResponse(message) {
    if (message?.type !== "extension.response" || message.id == null)
        return false;
    const id = String(message.id);
    const waiter = pendingLocalRequests.get(id);
    if (!waiter)
        return true;
    pendingLocalRequests.delete(id);
    clearTimeout(waiter.timer);
    if (message.ok)
        waiter.resolve(message.result ?? null);
    else {
        const failure = message.error;
        const detail = failure !== null && typeof failure === "object"
            ? failure.message
            : failure;
        waiter.reject(new Error(String(detail || "Equinox Local request failed.")));
    }
    return true;
}
async function requestLocalAction(method, args = {}, { timeoutMs = LOCAL_REQUEST_TIMEOUT_MS } = {}) {
    if (typeof method !== "string" || !/^[a-z0-9._-]{1,80}$/u.test(method)) {
        throw new Error("Equinox Local action name is invalid.");
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) {
        throw new Error("Equinox Local action arguments must be an object.");
    }
    if (!nativePort || !localBridgeConnected) {
        throw new Error("Equinox Local is not connected.");
    }
    const id = `local-${nextLocalRequestId++}`;
    return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pendingLocalRequests.delete(id);
            reject(new Error(`Equinox Local action timed out: ${method}`));
        }, timeoutMs);
        pendingLocalRequests.set(id, { resolve, reject, timer, method });
        try {
            nativePort.postMessage({ type: "extension.request", id, method, args });
        }
        catch (error) {
            pendingLocalRequests.delete(id);
            clearTimeout(timer);
            reject(error);
        }
    });
}
async function openAgentBrowserFromPopup() {
    await ensureBrowserIdentityLoaded();
    if (browserContext === "agent") {
        return {
            opened: false,
            alreadyOpen: true,
            context: browserContext,
        };
    }
    return await requestLocalAction("agent_browser.open");
}
function hasCurrentBrowserControlConsent() {
    return browserControlConsentVersion === CURRENT_BROWSER_CONTROL_CONSENT_VERSION;
}
async function ensureBrowserControlConsentLoaded() {
    if (browserControlConsentLoaded)
        return browserControlConsentVersion;
    if (!browserControlConsentLoadPromise) {
        browserControlConsentLoadPromise = (async () => {
            try {
                const stored = await workerStorageLocal().get(BROWSER_CONTROL_CONSENT_STORAGE_KEY);
                const version = Number(stored?.[BROWSER_CONTROL_CONSENT_STORAGE_KEY]);
                browserControlConsentVersion = Number.isInteger(version) && version > 0 ? version : 0;
            }
            catch {
                browserControlConsentVersion = 0;
            }
            browserControlConsentLoaded = true;
            return browserControlConsentVersion;
        })();
    }
    return await browserControlConsentLoadPromise;
}
async function ensureBrowserEnabledLoaded() {
    if (browserEnabledLoaded)
        return browserEnabled;
    if (!browserEnabledLoadPromise) {
        browserEnabledLoadPromise = (async () => {
            await ensureBrowserControlConsentLoaded();
            try {
                const stored = await workerStorageLocal().get(BROWSER_ENABLED_STORAGE_KEY);
                browserEnabled = hasCurrentBrowserControlConsent() && stored?.[BROWSER_ENABLED_STORAGE_KEY] === true;
            }
            catch {
                browserEnabled = false;
            }
            browserEnabledLoaded = true;
            return browserEnabled;
        })();
    }
    return await browserEnabledLoadPromise;
}
async function ensureAgentCursorEnabledLoaded() {
    if (agentCursorEnabledLoaded)
        return agentCursorEnabled;
    if (!agentCursorEnabledLoadPromise) {
        agentCursorEnabledLoadPromise = (async () => {
            try {
                const stored = await workerStorageLocal().get(AGENT_CURSOR_STORAGE_KEY);
                agentCursorEnabled = stored?.[AGENT_CURSOR_STORAGE_KEY] !== false;
            }
            catch {
                agentCursorEnabled = true;
            }
            agentCursorEnabledLoaded = true;
            return agentCursorEnabled;
        })();
    }
    return await agentCursorEnabledLoadPromise;
}
async function ensureAgentCursorNameLoaded() {
    if (agentCursorNameLoaded)
        return agentCursorName;
    if (!agentCursorNameLoadPromise) {
        agentCursorNameLoadPromise = (async () => {
            try {
                const stored = await workerStorageLocal().get(AGENT_CURSOR_NAME_STORAGE_KEY);
                agentCursorName = normalizeAgentCursorName(stored?.[AGENT_CURSOR_NAME_STORAGE_KEY]);
            }
            catch {
                agentCursorName = DEFAULT_AGENT_CURSOR_NAME;
            }
            agentCursorNameLoaded = true;
            return agentCursorName;
        })();
    }
    return await agentCursorNameLoadPromise;
}
function normalizeBrowserContext(value, { allowUnassigned = true } = {}) {
    if (value === "agent" || value === "user")
        return value;
    if (allowUnassigned && (value == null || value === "unassigned"))
        return "unassigned";
    throw new Error(`Unsupported browser context: ${String(value)}`);
}
async function ensureBrowserIdentityLoaded() {
    if (browserIdentityLoaded)
        return { instanceId: browserInstanceId, browserContext };
    if (!browserIdentityLoadPromise) {
        browserIdentityLoadPromise = (async () => {
            let stored = {};
            try {
                stored = await workerStorageLocal().get([
                    BROWSER_INSTANCE_ID_STORAGE_KEY,
                    BROWSER_CONTEXT_STORAGE_KEY,
                ]);
            }
            catch {
                stored = {};
            }
            const storedInstanceId = String(stored?.[BROWSER_INSTANCE_ID_STORAGE_KEY] || "").trim();
            browserInstanceId = /^[a-f0-9-]{36}$/iu.test(storedInstanceId)
                ? storedInstanceId.toLowerCase()
                : crypto.randomUUID();
            browserContext = normalizeBrowserContext(stored?.[BROWSER_CONTEXT_STORAGE_KEY]);
            await workerStorageLocal().set({ [BROWSER_INSTANCE_ID_STORAGE_KEY]: browserInstanceId });
            browserIdentityLoaded = true;
            return { instanceId: browserInstanceId, browserContext };
        })();
    }
    return await browserIdentityLoadPromise;
}
async function setBrowserContext(nextContext) {
    await ensureBrowserIdentityLoaded();
    const normalized = normalizeBrowserContext(nextContext, { allowUnassigned: false });
    await workerStorageLocal().set({ [BROWSER_CONTEXT_STORAGE_KEY]: normalized });
    browserContext = normalized;
    return {
        instanceId: browserInstanceId,
        browserContext,
    };
}
function workerTabs() {
    return globalThis.chrome.tabs;
}
function chatGptResumeRoute(tabOrUrl) {
    const tab = typeof tabOrUrl === "string" ? { url: tabOrUrl } : (tabOrUrl || {});
    let parsed;
    try {
        parsed = new URL(String(tab.url || ""));
    }
    catch {
        return null;
    }
    if (parsed.protocol !== "https:" || parsed.hostname !== "chatgpt.com")
        return null;
    const parts = parsed.pathname.split("/").filter(Boolean);
    const conversationIdValid = (value) => /^[A-Za-z0-9-]{8,160}$/u.test(String(value || ""));
    if (parts.length === 2 && parts[0] === "c" && conversationIdValid(parts[1])) {
        return Object.freeze({
            scopeKind: "root",
            scopeToken: null,
            conversationId: parts[1],
            canonicalUrl: `https://chatgpt.com/c/${parts[1]}`,
            freshChatUrl: "https://chatgpt.com/",
        });
    }
    if (parts.length === 4 && parts[0] === "g" && parts[2] === "c" && conversationIdValid(parts[3])) {
        const scopeToken = String(parts[1] || "");
        const projectMatch = /^(g-p-[a-f0-9]{32})(?:-[a-z0-9][a-z0-9-]{0,126})?$/u.exec(scopeToken);
        if (!projectMatch)
            return null;
        const projectId = projectMatch[1];
        return Object.freeze({
            scopeKind: "project",
            projectId,
            scopeToken,
            conversationId: parts[3],
            canonicalUrl: `https://chatgpt.com/g/${scopeToken}/c/${parts[3]}`,
            freshChatUrl: `https://chatgpt.com/g/${projectId}`,
        });
    }
    return null;
}
function chatGptFreshHomeRoute(tabOrUrl) {
    const tab = typeof tabOrUrl === "string" ? { url: tabOrUrl } : (tabOrUrl || {});
    let parsed;
    try {
        parsed = new URL(String(tab.url || ""));
    }
    catch {
        return null;
    }
    if (parsed.protocol !== "https:" || parsed.hostname !== "chatgpt.com")
        return null;
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length === 0) {
        return Object.freeze({ scopeKind: "root", projectId: null, canonicalUrl: "https://chatgpt.com/" });
    }
    if (parts.length !== 3 || parts[0] !== "g" || parts[2] !== "project")
        return null;
    const projectMatch = /^(g-p-[a-f0-9]{32})(?:-[a-z0-9][a-z0-9-]{0,126})?$/u.exec(String(parts[1] || ""));
    if (!projectMatch)
        return null;
    return Object.freeze({
        scopeKind: "project",
        projectId: projectMatch[1],
        canonicalUrl: `https://chatgpt.com/${parts.join("/")}`,
    });
}
function sameFreshChatScope(sourceRoute, destinationRoute) {
    if (!sourceRoute || !destinationRoute || sourceRoute.scopeKind !== destinationRoute.scopeKind)
        return false;
    if (sourceRoute.scopeKind === "root")
        return true;
    return sourceRoute.projectId === destinationRoute.projectId;
}
function withFreshChatResumeReceiptMutation(operation) {
    const run = freshChatResumeReceiptMutation.then(operation, operation);
    freshChatResumeReceiptMutation = run.then(() => { }, () => { });
    return run;
}
async function freshChatResumeReceipts() {
    const stored = await workerStorageLocal().get(FRESH_CHAT_RESUME_RECEIPTS_STORAGE_KEY);
    const rows = stored[FRESH_CHAT_RESUME_RECEIPTS_STORAGE_KEY];
    if (!Array.isArray(rows))
        return [];
    const validated = rows.filter((row) => {
        if (row === null || typeof row !== "object" || Array.isArray(row))
            return false;
        const receipt = row;
        return typeof receipt.resumeId === "string"
            && typeof receipt.sourceConversationId === "string"
            && (receipt.scopeKind === "root" || receipt.scopeKind === "project")
            && (receipt.status === "claimed" || receipt.status === "destination_created"
                || receipt.status === "filled" || receipt.status === "submitted"
                || receipt.status === "confirmed" || receipt.status === "ambiguous")
            && typeof receipt.claimedAt === "string"
            && typeof receipt.updatedAt === "string"
            && (receipt.projectId == null || typeof receipt.projectId === "string")
            && (receipt.destinationTabId == null || typeof receipt.destinationTabId === "number")
            && (receipt.destinationConversationId == null || typeof receipt.destinationConversationId === "string")
            && (receipt.destinationCanonicalUrl == null || typeof receipt.destinationCanonicalUrl === "string")
            && (receipt.reason == null || typeof receipt.reason === "string");
    });
    // Do not silently discard a corrupt receipt: that could allow resubmitting
    // a previously claimed message under the same id after storage corruption.
    if (validated.length !== rows.length)
        throw new Error("Fresh Chat Resume receipt store is invalid.");
    return validated;
}
async function findFreshChatResumeReceipt(resumeId) {
    return (await freshChatResumeReceipts()).find((item) => item?.resumeId === resumeId) || null;
}
async function claimFreshChatResumeReceipt(resumeId, sourceRoute) {
    return await withFreshChatResumeReceiptMutation(async () => {
        const current = await freshChatResumeReceipts();
        const existing = current.find((item) => item?.resumeId === resumeId);
        if (existing)
            return { claimed: false, receipt: existing };
        const receipt = {
            resumeId,
            status: "claimed",
            claimedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            sourceConversationId: sourceRoute.conversationId,
            scopeKind: sourceRoute.scopeKind,
            projectId: sourceRoute.scopeKind === "project" ? sourceRoute.projectId ?? null : null,
            destinationTabId: null,
            destinationConversationId: null,
            destinationCanonicalUrl: null,
            reason: null,
        };
        await workerStorageLocal().set({
            [FRESH_CHAT_RESUME_RECEIPTS_STORAGE_KEY]: [...current, receipt].slice(-MAX_FRESH_CHAT_RESUME_RECEIPTS),
        });
        return { claimed: true, receipt };
    });
}
async function updateFreshChatResumeReceipt(resumeId, patch) {
    return await withFreshChatResumeReceiptMutation(async () => {
        const current = await freshChatResumeReceipts();
        const index = current.findIndex((item) => item?.resumeId === resumeId);
        if (index < 0)
            throw new Error("Fresh Chat Resume receipt is missing.");
        const receipt = { ...current[index], ...patch, updatedAt: new Date().toISOString() };
        const next = [...current];
        next[index] = receipt;
        await workerStorageLocal().set({ [FRESH_CHAT_RESUME_RECEIPTS_STORAGE_KEY]: next });
        return receipt;
    });
}
function freshChatResumeReceiptResult(receipt, duplicatePrevented = false) {
    return {
        freshChatResumeVersion: FRESH_CHAT_RESUME_VERSION,
        resumeId: receipt.resumeId,
        status: receipt.status,
        confirmed: receipt.status === "confirmed",
        ambiguous: receipt.status === "ambiguous" || (duplicatePrevented && receipt.status !== "confirmed"),
        duplicatePrevented,
        scopeKind: receipt.scopeKind,
        projectId: receipt.projectId || null,
        destinationTabId: Number.isInteger(receipt.destinationTabId) ? receipt.destinationTabId : null,
        destinationConversationId: receipt.destinationConversationId || null,
        destinationCanonicalUrl: receipt.destinationCanonicalUrl || null,
        reason: receipt.reason || null,
    };
}
// Shared trusted submit target for Fresh Chat Resume and Telegram Chat Bridge.
// Current ChatGPT: primary action is type=submit after typing (voice/stop stay type=button).
// Previous ChatGPT variants: legacy send test-id or composer-submit-button.
const CHATGPT_SEND_SELECTOR = '[data-composer-body] button.bg-composer-primary[type="submit"], button[data-testid="send-button"][type="submit"], button#composer-submit-button[type="submit"]:not([data-testid="stop-button"])';
async function freshChatComposerState(tabId) {
    const tab = await workerTabs().get(tabId);
    const homeRoute = chatGptFreshHomeRoute(tab);
    if (!homeRoute)
        throw new Error("Fresh Chat Resume destination is not a supported ChatGPT new-chat page.");
    await requireDebuggableTab(tabId);
    await attachTab(tabId);
    try {
        const result = await send(tabId, "Runtime.evaluate", {
            expression: `(() => {
        /* Fresh Chat Resume composer state */
        const composer = document.querySelector('#prompt-textarea[contenteditable="true"][role="textbox"], [data-composer-markdown][contenteditable="true"][role="textbox"]');
        const userTurns = document.querySelectorAll('[data-message-author-role="user"], section[data-turn="user"]');
        const assistantTurns = document.querySelectorAll('[data-message-author-role="assistant"], section[data-turn="assistant"]');
        const modernTurns = document.querySelectorAll('[data-turn-key]');
        // Modern ChatGPT removed the legacy role nodes. A hydrated turn on a
        // supposedly new/empty destination must fail closed before any send.
        return {
          composerReady: Boolean(composer),
          composerEmpty: Boolean(composer) && !String(composer.textContent || '').trim(),
          userTurnCount: userTurns.length + modernTurns.length,
          assistantTurnCount: assistantTurns.length,
        };
      })()`,
            returnByValue: true,
        });
        if (result?.exceptionDetails)
            throw new Error(result.exceptionDetails?.exception?.description || result.exceptionDetails?.text || "Could not inspect Fresh Chat Resume composer state.");
        const state = cdpObject(result?.result?.value);
        if (!state)
            throw new Error("Fresh Chat Resume composer state is unavailable.");
        return {
            tabId,
            homeRoute,
            composerReady: state.composerReady === true,
            composerEmpty: state.composerEmpty === true,
            userTurnCount: Number.isInteger(state.userTurnCount) ? state.userTurnCount : 0,
            assistantTurnCount: Number.isInteger(state.assistantTurnCount) ? state.assistantTurnCount : 0,
        };
    }
    finally {
        scheduleDetach(tabId);
    }
}
async function waitForFreshChatHome(tabId, sourceRoute, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    let lastUrl = null;
    while (Date.now() < deadline) {
        const tab = await workerTabs().get(tabId);
        lastUrl = tab?.url || null;
        const homeRoute = chatGptFreshHomeRoute(tab);
        if (tab?.status === "complete" && sameFreshChatScope(sourceRoute, homeRoute))
            return { tab, homeRoute };
        await sleep(100);
    }
    throw new Error(`Fresh Chat Resume destination did not reach the expected new-chat scope: ${lastUrl || "unknown"}`);
}
async function waitForFreshChatComposer(tabId, sourceRoute, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const state = await freshChatComposerState(tabId);
            if (!sameFreshChatScope(sourceRoute, state.homeRoute))
                throw new Error("Fresh Chat Resume destination scope changed.");
            if (state.userTurnCount || state.assistantTurnCount)
                throw new Error("Fresh Chat Resume destination is not an empty conversation.");
            if (state.composerReady && state.composerEmpty)
                return state;
        }
        catch (error) {
            if (/scope changed|not an empty conversation/u.test(errorMessage(error)))
                throw error;
        }
        await sleep(100);
    }
    throw new Error("Fresh Chat Resume destination composer did not become safely ready.");
}
async function selectorTargetWithActionability(tabId, selector, { label = "selector", agentName } = {}) {
    await send(tabId, "Page.bringToFront");
    const activeDeadline = Date.now() + 1_500;
    while (Date.now() < activeDeadline) {
        const tab = await workerTabs().get(tabId);
        if (tab?.active)
            break;
        await sleep(50);
    }
    const activeTab = await workerTabs().get(tabId);
    if (!activeTab?.active)
        throw new Error(`Fresh Chat Resume could not activate ${label}.`);
    await send(tabId, "DOM.enable");
    const documentResult = await send(tabId, "DOM.getDocument", { depth: 1 });
    const rootNodeId = documentResult?.root?.nodeId;
    if (!Number.isInteger(rootNodeId))
        throw new Error(`Fresh Chat Resume could not inspect ${label}.`);
    const query = await send(tabId, "DOM.querySelector", { nodeId: rootNodeId, selector });
    if (typeof query?.nodeId !== "number" || !Number.isSafeInteger(query.nodeId) || query.nodeId < 1)
        throw new Error(`Fresh Chat Resume could not find ${label}.`);
    const described = await send(tabId, "DOM.describeNode", { nodeId: query.nodeId });
    const backendNodeId = Number(described?.node?.backendNodeId);
    if (!Number.isInteger(backendNodeId) || backendNodeId < 1)
        throw new Error(`Fresh Chat Resume could not resolve ${label}.`);
    const target = { backendNodeId, frameId: null, sessionId: null };
    await send(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId });
    const box = await send(tabId, "DOM.getBoxModel", { backendNodeId });
    const quad = box?.model?.border || box?.model?.content;
    if (!Array.isArray(quad) || quad.length < 8)
        throw new Error(`Fresh Chat Resume ${label} has no visible box.`);
    const point = await verifiedClickablePoint(tabId, target, quad, label);
    await showAgentCursor(tabId, point, null, { pulse: true, agentName });
    await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
    return { target, point };
}
async function setEditableTargetValue(tabId, target, value, { label = "element" } = {}) {
    const wanted = String(value ?? "");
    const resolved = await send(tabId, "DOM.resolveNode", { backendNodeId: target.backendNodeId }, target.sessionId);
    const objectId = resolved?.object?.objectId;
    if (!objectId)
        throw new Error(`Unable to resolve editable ${label}.`);
    try {
        const result = await send(tabId, "Runtime.callFunctionOn", {
            objectId,
            functionDeclaration: `function(nextValue) {
        this.focus();
        const tag = String(this.tagName || '').toUpperCase();
        const inputType = String(this.type || '').toLowerCase();
        const blockedInputTypes = new Set(['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit']);
        const nativeEditable = tag === 'TEXTAREA' || (tag === 'INPUT' && !blockedInputTypes.has(inputType));
        const contentEditable = Boolean(this.isContentEditable);
        if (!nativeEditable && !contentEditable) throw new Error('Target is not a supported editable control');
        if (contentEditable) {
          this.textContent = nextValue;
        } else {
          const proto = Object.getPrototypeOf(this);
          const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
            || (globalThis.HTMLInputElement ? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value') : null)
            || (globalThis.HTMLTextAreaElement ? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value') : null);
          if (descriptor && typeof descriptor.set === 'function') descriptor.set.call(this, nextValue);
          else this.value = nextValue;
        }
        this.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        this.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        const actual = contentEditable ? String(this.textContent ?? '') : String(this.value ?? '');
        return { value: actual, editable: true, kind: contentEditable ? 'contenteditable' : tag.toLowerCase() };
      }`,
            arguments: [{ value: wanted }],
            returnByValue: true,
        }, target.sessionId);
        if (result?.exceptionDetails) {
            const description = result.exceptionDetails?.exception?.description || result.exceptionDetails?.text;
            throw new Error(description || `Unable to fill ${label}.`);
        }
        const outcome = cdpObject(result?.result?.value) || {};
        if (String(outcome.value ?? "") !== wanted)
            throw new Error(`Fill postcondition failed for ${label}.`);
        return outcome;
    }
    finally {
        await send(tabId, "Runtime.releaseObject", { objectId }, target.sessionId).catch(() => { });
    }
}
async function fillSelectorWithSemanticInput(tabId, selector, value, { label = "selector", agentName } = {}) {
    const { target, point } = await selectorTargetWithActionability(tabId, selector, { label, agentName });
    const outcome = await setEditableTargetValue(tabId, target, value, { label });
    return { target, point, kind: outcome.kind || null };
}
async function clickSelectorWithActionability(tabId, selector, { label = "selector", agentName } = {}) {
    const { target, point } = await selectorTargetWithActionability(tabId, selector, { label, agentName });
    const outcome = await dispatchNormalizedSemanticClick(tabId, target, point, {
        clickCount: 1,
        button: "left",
        modifiers: [],
        delayMs: 0,
    });
    if (outcome.dialog)
        throw new Error(`Fresh Chat Resume ${label} opened a dialog instead of submitting.`);
    return point;
}
async function createFreshChatResume({ resumeId, sourceTabId, sourceConversationId, prompt } = {}) {
    if (typeof resumeId !== "string" || !/^resume-[a-z0-9-]{6,80}$/u.test(resumeId)) {
        throw new Error("Fresh Chat Resume id is invalid.");
    }
    if (typeof sourceTabId !== "number" || !Number.isInteger(sourceTabId) || sourceTabId < 1)
        throw new Error("Fresh Chat Resume source tab id is invalid.");
    if (typeof sourceConversationId !== "string" || !/^[A-Za-z0-9-]{8,160}$/u.test(sourceConversationId)) {
        throw new Error("Fresh Chat Resume source conversation id is invalid.");
    }
    const message = String(prompt || "");
    if (!message || message.length > 2_000 || /\0/u.test(message))
        throw new Error("Fresh Chat Resume prompt is invalid.");
    const prior = await findFreshChatResumeReceipt(resumeId);
    if (prior) {
        if (prior.sourceConversationId !== sourceConversationId) {
            throw new Error("Fresh Chat Resume id is already bound to another source conversation.");
        }
        return freshChatResumeReceiptResult(prior, true);
    }
    const sourceTab = await workerTabs().get(sourceTabId);
    const sourceRoute = chatGptResumeRoute(sourceTab);
    if (!sourceRoute || sourceRoute.conversationId !== sourceConversationId) {
        throw new Error("Fresh Chat Resume source conversation changed or has an unsupported route.");
    }
    const claim = await claimFreshChatResumeReceipt(resumeId, sourceRoute);
    if (!claim.claimed)
        return freshChatResumeReceiptResult(claim.receipt, true);
    try {
        const tabs = workerTabs();
        if (!tabs.create)
            throw new Error("Chrome tabs.create API is unavailable.");
        const created = await tabs.create({ url: sourceRoute.freshChatUrl, active: false });
        if (typeof created?.id !== "number" || !Number.isInteger(created.id))
            throw new Error("Chrome did not return a Fresh Chat Resume destination tab id.");
        await updateFreshChatResumeReceipt(resumeId, { status: "destination_created", destinationTabId: created.id });
        await waitForFreshChatHome(created.id, sourceRoute);
        await waitForFreshChatComposer(created.id, sourceRoute);
        await requireDebuggableTab(created.id);
        await attachTab(created.id);
        try {
            await fillSelectorWithSemanticInput(created.id, '#prompt-textarea[contenteditable="true"][role="textbox"], [data-composer-markdown][contenteditable="true"][role="textbox"]', message, { label: "composer" });
            await updateFreshChatResumeReceipt(resumeId, { status: "filled" });
            const submitDeadline = Date.now() + 4_000;
            const submitStableMs = 500;
            let ready = false;
            let readySince = null;
            let lastSubmitReason = "not_ready";
            while (Date.now() < submitDeadline) {
                const destinationTab = await workerTabs().get(created.id);
                const destinationHomeRoute = chatGptFreshHomeRoute(destinationTab);
                if (!sameFreshChatScope(sourceRoute, destinationHomeRoute)) {
                    throw new Error("Fresh Chat Resume destination scope changed before submit.");
                }
                const submitTarget = await send(created.id, "Runtime.evaluate", {
                    expression: `(() => {
            // Fresh Chat Resume trusted submit target
            const composer = document.querySelector('#prompt-textarea[contenteditable="true"][role="textbox"], [data-composer-markdown][contenteditable="true"][role="textbox"]');
            const button = document.querySelector(${JSON.stringify(CHATGPT_SEND_SELECTOR)});
            const turns = document.querySelectorAll('[data-message-author-role], section[data-turn], [data-turn-key]');
            if (turns.length) return { ready: false, reason: "destination_not_empty" };
            if (!composer || !button || !button.isConnected) return { ready: false, reason: "send_button_missing" };
            if (String(composer.textContent || "") !== ${JSON.stringify(message)}) return { ready: false, reason: "composer_changed" };
            if (Boolean(button.disabled) || button.getAttribute("aria-disabled") === "true") return { ready: false, reason: "send_disabled" };
            return { ready: true };
          })()`,
                    returnByValue: true,
                    silent: true,
                });
                if (submitTarget?.exceptionDetails) {
                    const submitError = submitTarget.exceptionDetails?.exception?.description
                        || submitTarget.exceptionDetails?.text
                        || "unknown";
                    throw new Error(`Fresh Chat Resume submit target failed: ${submitError}`);
                }
                const candidate = cdpObject(submitTarget?.result?.value);
                if (candidate?.ready === true) {
                    if (readySince == null)
                        readySince = Date.now();
                    if (Date.now() - readySince >= submitStableMs) {
                        ready = true;
                        break;
                    }
                    await sleep(100);
                    continue;
                }
                readySince = null;
                lastSubmitReason = typeof candidate?.reason === "string" ? candidate.reason : "not_ready";
                if (lastSubmitReason === "composer_changed" || lastSubmitReason === "destination_not_empty") {
                    throw new Error(`Fresh Chat Resume submit target failed: ${lastSubmitReason}`);
                }
                await sleep(100);
            }
            if (!ready)
                throw new Error(`Fresh Chat Resume submit target timed out: ${lastSubmitReason}`);
            await clickSelectorWithActionability(created.id, CHATGPT_SEND_SELECTOR, { label: "send button" });
            await updateFreshChatResumeReceipt(resumeId, { status: "submitted" });
        }
        finally {
            scheduleDetach(created.id, CONTINUATION_MUTATION_DETACH_MS);
        }
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
            await sleep(100);
            const tab = await workerTabs().get(created.id);
            const destinationRoute = chatGptResumeRoute(tab);
            if (destinationRoute && sameFreshChatScope(sourceRoute, destinationRoute)) {
                if (destinationRoute.conversationId === sourceRoute.conversationId) {
                    throw new Error("Fresh Chat Resume destination reused the source conversation identity.");
                }
                const confirmed = await updateFreshChatResumeReceipt(resumeId, {
                    status: "confirmed",
                    destinationConversationId: destinationRoute.conversationId,
                    destinationCanonicalUrl: destinationRoute.canonicalUrl,
                    reason: null,
                });
                return freshChatResumeReceiptResult(confirmed, false);
            }
            if (destinationRoute && !sameFreshChatScope(sourceRoute, destinationRoute)) {
                throw new Error("Fresh Chat Resume destination conversation scope does not match the source.");
            }
        }
        throw new Error("Fresh Chat Resume destination conversation identity could not be confirmed.");
    }
    catch (error) {
        const ambiguous = await updateFreshChatResumeReceipt(resumeId, {
            status: "ambiguous",
            reason: errorMessage(error).slice(0, 300),
        }).catch(() => claim.receipt);
        return freshChatResumeReceiptResult(ambiguous, false);
    }
}
function chatGptConversationIdentity(tabOrUrl) {
    const tab = typeof tabOrUrl === "string" ? { url: tabOrUrl } : (tabOrUrl || {});
    const rawUrl = String(tab.url || "");
    let parsed;
    try {
        parsed = new URL(rawUrl);
    }
    catch {
        return null;
    }
    if (parsed.protocol !== "https:" || parsed.hostname !== "chatgpt.com")
        return null;
    const parts = parsed.pathname.split("/").filter(Boolean);
    let conversationIndex = -1;
    for (let index = parts.length - 2; index >= 0; index -= 1) {
        if (parts[index] === "c") {
            conversationIndex = index;
            break;
        }
    }
    if (conversationIndex < 0)
        return null;
    const conversationId = String(parts[conversationIndex + 1] || "");
    if (!/^[A-Za-z0-9-]{8,160}$/u.test(conversationId))
        return null;
    const canonicalPath = `/${parts.slice(0, conversationIndex + 2).join("/")}`;
    return {
        conversationId,
        canonicalUrl: `https://chatgpt.com${canonicalPath}`,
        title: String(tab.title || "ChatGPT").slice(0, 200),
    };
}
function normalizeAutoContinueTarget(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return Object.freeze({ mode: "task-tab" });
    const persisted = value;
    if (persisted.mode === "task-tab")
        return Object.freeze({ mode: "task-tab" });
    if (persisted.mode !== "pinned" || typeof persisted.tabId !== "number" || !Number.isInteger(persisted.tabId) || persisted.tabId < 1) {
        return Object.freeze({ mode: "task-tab" });
    }
    const conversationId = String(persisted.conversationId || "");
    if (!/^[A-Za-z0-9-]{8,160}$/u.test(conversationId))
        return Object.freeze({ mode: "task-tab" });
    return Object.freeze({
        mode: "pinned",
        tabId: persisted.tabId,
        conversationId,
        canonicalUrl: String(persisted.canonicalUrl || "").slice(0, 500),
        title: String(persisted.title || "ChatGPT").slice(0, 200),
    });
}
async function ensureAutoContinueTargetLoaded() {
    if (autoContinueTargetLoaded)
        return autoContinueTarget;
    if (!autoContinueTargetLoadPromise) {
        autoContinueTargetLoadPromise = (async () => {
            try {
                const stored = await workerStorageLocal().get(AUTO_CONTINUE_TARGET_STORAGE_KEY);
                autoContinueTarget = normalizeAutoContinueTarget(stored?.[AUTO_CONTINUE_TARGET_STORAGE_KEY]);
            }
            catch {
                autoContinueTarget = Object.freeze({ mode: "task-tab" });
            }
            autoContinueTargetLoaded = true;
            return autoContinueTarget;
        })();
    }
    return await autoContinueTargetLoadPromise;
}
async function listChatGptConversationTabs() {
    const tabs = await workerTabs().query({});
    return tabs.flatMap((tab) => {
        // A tab leaving ChatGPT is not a stable conversation to offer in popup.
        if (typeof tab.pendingUrl === "string" && tab.pendingUrl.length > 0)
            return [];
        const identity = chatGptConversationIdentity(tab);
        if (!identity || typeof tab.id !== "number" || !Number.isInteger(tab.id))
            return [];
        return [{
                tabId: tab.id,
                title: identity.title,
                conversationId: identity.conversationId,
                canonicalUrl: identity.canonicalUrl,
                active: Boolean(tab.active),
            }];
    }).slice(0, 50);
}
async function setAutoContinueTarget({ mode, tabId } = {}) {
    if (mode === "task-tab") {
        autoContinueTarget = Object.freeze({ mode: "task-tab" });
    }
    else if (mode === "pinned") {
        if (typeof tabId !== "number" || !Number.isInteger(tabId) || tabId < 1)
            throw new Error("Pinned Auto Continue target requires a valid tab id.");
        const tab = await workerTabs().get(tabId);
        if (typeof tab.pendingUrl === "string" && tab.pendingUrl.length > 0) {
            throw new Error("Only a committed ChatGPT conversation can be pinned; navigation is pending.");
        }
        const identity = chatGptConversationIdentity(tab);
        if (!identity)
            throw new Error("Only an open chatgpt.com conversation can be pinned for Auto Continue.");
        autoContinueTarget = Object.freeze({ mode: "pinned", tabId, ...identity });
    }
    else {
        throw new Error("Auto Continue target mode must be task-tab or pinned.");
    }
    await workerStorageLocal().set({ [AUTO_CONTINUE_TARGET_STORAGE_KEY]: autoContinueTarget });
    autoContinueTargetLoaded = true;
    return await autoContinueTargetStatus();
}
async function autoContinueTargetStatus({ includeTabs = true } = {}) {
    await ensureAutoContinueTargetLoaded();
    const tabs = includeTabs ? await listChatGptConversationTabs() : [];
    let pinnedValid = null;
    const selectedTarget = autoContinueTarget;
    if (selectedTarget.mode === "pinned") {
        const current = tabs.find((tab) => tab.tabId === selectedTarget.tabId);
        pinnedValid = Boolean(current && current.conversationId === selectedTarget.conversationId
            && current.canonicalUrl === selectedTarget.canonicalUrl);
    }
    return {
        autoContinueVersion: AUTO_CONTINUE_VERSION,
        target: { ...autoContinueTarget },
        pinnedValid,
        tabs,
    };
}
function normalizeChatGptContinuationState(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    const received = value;
    const startedAt = received.generationStartedAtMs;
    return Object.freeze({
        generationActive: received.generationActive === true,
        generationStartedAtMs: received.generationActive === true
            && typeof startedAt === "number" && Number.isSafeInteger(startedAt)
            && startedAt > 0 && startedAt <= Date.now() + 5_000 ? startedAt : null,
        userEpoch: typeof received.userEpoch === "string" ? received.userEpoch.slice(0, 200) : null,
        assistantTurnKey: typeof received.assistantTurnKey === "string" ? received.assistantTurnKey.slice(0, 200) : null,
        composerReady: received.composerReady === true,
        composerEmpty: received.composerEmpty === true,
    });
}
function rememberChatGptContinuationState(tabId, tabUrl, state) {
    if (!Number.isInteger(tabId) || typeof tabUrl !== "string")
        return null;
    const normalized = normalizeChatGptContinuationState(state);
    if (!normalized)
        return null;
    const record = Object.freeze({ state: normalized, tabUrl, observedAt: Date.now() });
    chatGptContinuationStateCache.set(tabId, record);
    return normalized;
}
function cachedChatGptContinuationState(tab) {
    if (typeof tab.id !== "number" || !Number.isInteger(tab.id))
        return null;
    const record = chatGptContinuationStateCache.get(tab.id);
    if (!record)
        return null;
    if (record.tabUrl !== tab.url || Date.now() - record.observedAt > CHATGPT_CONTINUATION_CACHE_MAX_AGE_MS)
        return null;
    return record.state;
}
async function chatGptContinuationState(tabId) {
    const tab = await chooseTab(tabId);
    // A committed conversation URL does not authorize another turn while Chrome
    // is already navigating this tab elsewhere (even before tab.url updates).
    if (typeof tab.pendingUrl === "string" && tab.pendingUrl.length > 0) {
        throw new Error("Auto Continue target has a pending navigation; wait for a committed ChatGPT page.");
    }
    const identity = chatGptConversationIdentity(tab);
    if (!identity || typeof tab.id !== "number" || !Number.isInteger(tab.id) || typeof tab.url !== "string") {
        throw new Error("Auto Continue target is not a valid chatgpt.com conversation tab.");
    }
    let state = null;
    try {
        const response = await workerTabs().sendMessage(tab.id, { type: CHATGPT_CONTINUATION_STATE_GET });
        const received = response && typeof response === "object" && "state" in response ? response.state : null;
        state = rememberChatGptContinuationState(tab.id, tab.url, received);
    }
    catch {
        state = cachedChatGptContinuationState(tab);
    }
    if (!state) {
        throw new Error("ChatGPT continuation state observer is unavailable. Reload the ChatGPT tab so Equinox Browser can observe turn state without debugger access.");
    }
    return {
        autoContinueVersion: AUTO_CONTINUE_VERSION,
        tabId: tab.id,
        ...identity,
        ...state,
    };
}
async function resolveAutoContinueTarget() {
    await ensureAutoContinueTargetLoaded();
    const selectedTarget = autoContinueTarget;
    if (selectedTarget.mode === "pinned") {
        let tab;
        try {
            tab = await workerTabs().get(selectedTarget.tabId);
        }
        catch {
            return { autoContinueVersion: AUTO_CONTINUE_VERSION, mode: "pinned", status: "invalid", reason: "pinned_tab_closed" };
        }
        // Pinning the last committed URL must not survive an in-flight navigation.
        const identity = typeof tab.pendingUrl === "string" && tab.pendingUrl.length > 0
            ? null : chatGptConversationIdentity(tab);
        if (!identity || identity.conversationId !== selectedTarget.conversationId
            || identity.canonicalUrl !== selectedTarget.canonicalUrl) {
            return { autoContinueVersion: AUTO_CONTINUE_VERSION, mode: "pinned", status: "invalid", reason: "pinned_conversation_changed" };
        }
        if (typeof tab.id !== "number" || tab.id !== selectedTarget.tabId) {
            return { autoContinueVersion: AUTO_CONTINUE_VERSION, mode: "pinned", status: "invalid", reason: "pinned_tab_changed" };
        }
        const state = await chatGptContinuationState(tab.id);
        return {
            autoContinueVersion: AUTO_CONTINUE_VERSION,
            mode: "pinned",
            status: state.generationActive && state.assistantTurnKey ? "ready" : "idle",
            target: state,
        };
    }
    const tabs = await listChatGptConversationTabs();
    const generating = [];
    for (const tab of tabs) {
        try {
            const state = await chatGptContinuationState(tab.tabId);
            if (state.generationActive && state.assistantTurnKey)
                generating.push(state);
        }
        catch {
            // A disappearing or restricted tab is not an eligible task target.
        }
    }
    if (generating.length === 1) {
        return { autoContinueVersion: AUTO_CONTINUE_VERSION, mode: "task-tab", status: "ready", target: generating[0] };
    }
    return {
        autoContinueVersion: AUTO_CONTINUE_VERSION,
        mode: "task-tab",
        status: generating.length === 0 ? "idle" : "ambiguous",
        reason: generating.length === 0 ? "no_generating_chatgpt_tab" : "multiple_generating_chatgpt_tabs",
        candidateCount: generating.length,
    };
}
async function resolveTurnBudgetTarget() {
    // Auto Continue's explicit pin is also the Turn Budget scope. Never fall
    // through to a different generating tab when the pinned one is idle/closed.
    await ensureAutoContinueTargetLoaded();
    if (autoContinueTarget.mode === "pinned") {
        const pinned = autoContinueTarget;
        let tab;
        try {
            tab = await workerTabs().get(pinned.tabId);
        }
        catch {
            return { mode: "pinned", status: "idle", reason: "pinned_tab_closed" };
        }
        const identity = typeof tab.pendingUrl === "string" && tab.pendingUrl.length > 0
            ? null : chatGptConversationIdentity(tab);
        if (!identity || identity.conversationId !== pinned.conversationId
            || identity.canonicalUrl !== pinned.canonicalUrl) {
            return { mode: "pinned", status: "idle", reason: "pinned_conversation_changed" };
        }
        let state;
        try {
            state = await chatGptContinuationState(pinned.tabId);
        }
        catch {
            return { mode: "pinned", status: "idle", reason: "pinned_observer_unavailable" };
        }
        if (state.generationActive && (state.userEpoch || state.assistantTurnKey)) {
            return { mode: "pinned", status: "ready", target: state };
        }
        if (state.composerReady && !state.composerEmpty) {
            return { mode: "pinned", status: "composing", reason: "draft_not_turn_completion" };
        }
        return { mode: "pinned", status: "idle", reason: "pinned_tab_not_generating" };
    }
    const tabs = await listChatGptConversationTabs();
    const generating = [];
    let composing = false;
    for (const tab of tabs) {
        try {
            const state = await chatGptContinuationState(tab.tabId);
            if (state.generationActive && (state.userEpoch || state.assistantTurnKey))
                generating.push(state);
            // A draft can temporarily change ChatGPT's stop/send-button markup.
            // It is not evidence that an already observed assistant turn ended.
            if (state.composerReady && !state.composerEmpty)
                composing = true;
        }
        catch {
            // A disappearing/restricted tab or missing observer is not an eligible active turn.
        }
    }
    if (generating.length === 1) {
        return { status: "ready", target: generating[0] };
    }
    if (generating.length === 0 && composing)
        return { status: "composing", reason: "draft_not_turn_completion" };
    return {
        status: generating.length === 0 ? "idle" : "ambiguous",
        reason: generating.length === 0 ? "no_generating_chatgpt_tab" : "multiple_generating_chatgpt_tabs",
        candidateCount: generating.length,
    };
}
async function storedDeliveryReceipts(storageKey, idField) {
    const data = await workerStorageLocal().get(storageKey);
    const rows = data[storageKey];
    if (!Array.isArray(rows))
        return [];
    const validated = rows.filter((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item))
            return false;
        const record = item;
        return typeof record[idField] === "string";
    });
    if (validated.length !== rows.length)
        throw new Error("Delivery receipt store is invalid.");
    return validated;
}
function withAutoContinueReceiptMutation(operation) {
    const run = autoContinueReceiptMutation.then(operation, operation);
    autoContinueReceiptMutation = run.then(() => { }, () => { });
    return run;
}
async function hasAutoContinueReceipt(continuationId) {
    const current = await storedDeliveryReceipts(AUTO_CONTINUE_RECEIPTS_STORAGE_KEY, "continuationId");
    return current.some((item) => item?.continuationId === continuationId);
}
async function claimAutoContinueReceipt(continuationId) {
    return await withAutoContinueReceiptMutation(async () => {
        const current = await storedDeliveryReceipts(AUTO_CONTINUE_RECEIPTS_STORAGE_KEY, "continuationId");
        if (current.some((item) => item?.continuationId === continuationId))
            return false;
        const next = [...current, { continuationId, claimedAt: new Date().toISOString() }]
            .slice(-MAX_AUTO_CONTINUE_RECEIPTS);
        await workerStorageLocal().set({ [AUTO_CONTINUE_RECEIPTS_STORAGE_KEY]: next });
        return true;
    });
}
function withChatBridgeReceiptMutation(operation) {
    const run = chatBridgeReceiptMutation.then(operation, operation);
    chatBridgeReceiptMutation = run.then(() => { }, () => { });
    return run;
}
async function hasChatBridgeReceipt(deliveryId) {
    const current = await storedDeliveryReceipts(CHAT_BRIDGE_RECEIPTS_STORAGE_KEY, "deliveryId");
    return current.some((item) => item?.deliveryId === deliveryId);
}
async function claimChatBridgeReceipt(deliveryId) {
    return await withChatBridgeReceiptMutation(async () => {
        const current = await storedDeliveryReceipts(CHAT_BRIDGE_RECEIPTS_STORAGE_KEY, "deliveryId");
        if (current.some((item) => item?.deliveryId === deliveryId))
            return false;
        const next = [...current, { deliveryId, claimedAt: new Date().toISOString() }]
            .slice(-MAX_CHAT_BRIDGE_RECEIPTS);
        await workerStorageLocal().set({ [CHAT_BRIDGE_RECEIPTS_STORAGE_KEY]: next });
        return true;
    });
}
async function assertAutoContinueConversationStillCommitted(tabId, expectedCanonicalUrl, pinnedAdmission = null) {
    const tab = await workerTabs().get(tabId);
    if (typeof tab.pendingUrl === "string" && tab.pendingUrl.length > 0) {
        throw new Error("Auto Continue target has a pending navigation; refusing to mutate or submit the composer.");
    }
    const current = chatGptConversationIdentity(tab);
    if (!current || current.canonicalUrl !== expectedCanonicalUrl) {
        throw new Error("Auto Continue conversation changed before composing or submitting.");
    }
    // A user repinning the popup during an in-flight CDP mutation revokes the
    // original pinned delivery, even while the tab itself stays committed.
    if (pinnedAdmission && (autoContinueTarget.mode !== "pinned"
        || autoContinueTarget.tabId !== pinnedAdmission.tabId
        || autoContinueTarget.conversationId !== pinnedAdmission.conversationId
        || autoContinueTarget.canonicalUrl !== pinnedAdmission.canonicalUrl)) {
        throw new Error("Pinned Auto Continue target changed before composing or submitting.");
    }
}
async function deliverAutoContinuation({ continuationId, tabId, conversationId, userEpoch, assistantTurnKey, prompt, } = {}) {
    if (typeof continuationId !== "string" || !/^cont-[a-z0-9-]{6,80}$/u.test(continuationId)) {
        throw new Error("Auto Continue delivery id is invalid.");
    }
    if (typeof tabId !== "number" || !Number.isInteger(tabId) || tabId < 1)
        throw new Error("Auto Continue delivery tab id is invalid.");
    if (typeof conversationId !== "string" || !/^[A-Za-z0-9-]{8,160}$/u.test(conversationId)) {
        throw new Error("Auto Continue conversation id is invalid.");
    }
    if (typeof userEpoch !== "string" || userEpoch.length < 1 || userEpoch.length > 200) {
        throw new Error("Auto Continue user epoch is invalid.");
    }
    if (typeof assistantTurnKey !== "string" || assistantTurnKey.length < 1 || assistantTurnKey.length > 200) {
        throw new Error("Auto Continue assistant turn key is invalid.");
    }
    const message = String(prompt || "");
    if (!message || message.length > 2_000 || /\0/u.test(message))
        throw new Error("Auto Continue prompt is invalid.");
    if (await hasAutoContinueReceipt(continuationId)) {
        return {
            autoContinueVersion: AUTO_CONTINUE_VERSION,
            continuationId,
            tabId,
            confirmed: false,
            duplicatePrevented: true,
            ambiguous: false,
        };
    }
    const before = await chatGptContinuationState(tabId);
    if (before.conversationId !== conversationId)
        throw new Error("Auto Continue conversation changed before delivery.");
    if (before.userEpoch !== userEpoch)
        throw new Error("A new user message arrived before Auto Continue delivery.");
    if (before.assistantTurnKey !== assistantTurnKey)
        throw new Error("The assistant turn changed before Auto Continue delivery.");
    if (before.generationActive)
        throw new Error("ChatGPT is still generating; Auto Continue delivery is not ready.");
    if (!before.composerReady || !before.composerEmpty)
        throw new Error("ChatGPT composer is unavailable or contains human input.");
    // A pinned target's route scope must be honored at the final delivery
    // boundary too, not just in the popup or earlier target resolution.
    await ensureAutoContinueTargetLoaded();
    if (autoContinueTarget.mode === "pinned" && (autoContinueTarget.tabId !== tabId
        || autoContinueTarget.conversationId !== conversationId
        || autoContinueTarget.canonicalUrl !== before.canonicalUrl)) {
        throw new Error("Pinned Auto Continue conversation route changed before delivery.");
    }
    const pinnedAdmission = autoContinueTarget.mode === "pinned" ? autoContinueTarget : null;
    const claimed = await claimAutoContinueReceipt(continuationId);
    if (!claimed) {
        return {
            autoContinueVersion: AUTO_CONTINUE_VERSION,
            continuationId,
            tabId,
            confirmed: false,
            duplicatePrevented: true,
            ambiguous: false,
        };
    }
    const hadDebuggerAttachment = attachedTabs.has(tabId);
    await requireDebuggableTab(tabId);
    await attachTab(tabId);
    try {
        const focusResult = await send(tabId, "Runtime.evaluate", {
            expression: `(() => {
      const composer = document.querySelector('#prompt-textarea[contenteditable="true"][role="textbox"], [data-composer-markdown][contenteditable="true"][role="textbox"]');
      if (!composer) throw new Error('ChatGPT composer is unavailable');
      if (String(composer.textContent || '').trim()) throw new Error('ChatGPT composer is not empty');
      composer.focus();
      return { focused: document.activeElement === composer };
    })()`,
            returnByValue: true,
        });
        if (focusResult?.exceptionDetails || cdpObject(focusResult?.result?.value)?.focused !== true) {
            throw new Error(focusResult?.exceptionDetails?.exception?.description || focusResult?.exceptionDetails?.text || "Auto Continue could not focus the ChatGPT composer.");
        }
        await assertAutoContinueConversationStillCommitted(tabId, before.canonicalUrl, pinnedAdmission);
        await send(tabId, "Input.insertText", { text: message });
        const fillResult = await send(tabId, "Runtime.evaluate", {
            expression: `(() => {
      const composer = document.querySelector('#prompt-textarea[contenteditable="true"][role="textbox"], [data-composer-markdown][contenteditable="true"][role="textbox"]');
      return composer ? String(composer.textContent || '') : null;
    })()`,
            returnByValue: true,
        });
        if (fillResult?.exceptionDetails || String(fillResult?.result?.value || "") !== message) {
            throw new Error(fillResult?.exceptionDetails?.exception?.description || fillResult?.exceptionDetails?.text || "Auto Continue composer fill postcondition failed.");
        }
        await sleep(50);
        await assertAutoContinueConversationStillCommitted(tabId, before.canonicalUrl, pinnedAdmission);
        await dispatchKeyChord(tabId, "Enter", null);
        const deadline = Date.now() + 4_000;
        while (Date.now() < deadline) {
            await sleep(100);
            try {
                const after = await chatGptContinuationState(tabId);
                if (after.conversationId !== conversationId)
                    break;
                if (after.userEpoch && after.userEpoch !== userEpoch) {
                    return {
                        autoContinueVersion: AUTO_CONTINUE_VERSION,
                        continuationId,
                        tabId,
                        confirmed: true,
                        duplicatePrevented: false,
                        ambiguous: false,
                    };
                }
            }
            catch {
                break;
            }
        }
        return {
            autoContinueVersion: AUTO_CONTINUE_VERSION,
            continuationId,
            tabId,
            confirmed: false,
            duplicatePrevented: false,
            ambiguous: true,
        };
    }
    finally {
        if (!hadDebuggerAttachment) {
            scheduleDetach(tabId, CONTINUATION_MUTATION_DETACH_MS);
        }
    }
}
async function readChatBridgeAttachedState(tabId) {
    // The existing Auto Continue content observer is the canonical, modern
    // data-turn-key/search-unit/ProseMirror reader. Chat Bridge must use the SAME
    // user/assistant epochs and generation state instead of the removed legacy
    // data-message-id DOM; never infer an idle conversation from missing old nodes.
    const state = await chatGptContinuationState(tabId);
    const normalized = normalizeChatGptContinuationState(state);
    if (!normalized)
        throw new Error("Chat Bridge current ChatGPT observer returned invalid turn state.");
    return normalized;
}
async function inspectChatBridgeState({ tabId } = {}) {
    if (typeof tabId !== "number" || !Number.isInteger(tabId) || tabId < 1)
        throw new Error("Chat Bridge inspect tab id is invalid.");
    const tab = await chooseTab(tabId);
    const identity = chatGptConversationIdentity(tab);
    if (!identity)
        throw new Error("Chat Bridge target is not a chatgpt.com conversation.");
    await requireDebuggableTab(tabId);
    await attachTab(tabId);
    try {
        const state = await readChatBridgeAttachedState(tabId);
        return {
            chatBridgeVersion: CHAT_BRIDGE_VERSION,
            tabId,
            ...identity,
            ...state,
        };
    }
    finally {
        scheduleDetach(tabId, CONTINUATION_MUTATION_DETACH_MS);
    }
}
async function deliverChatBridgeMessage({ deliveryId, tabId, conversationId, userEpoch, assistantTurnKey, text, } = {}) {
    if (typeof deliveryId !== "string" || !/^tgb-[a-z0-9-]{6,80}$/u.test(deliveryId)) {
        throw new Error("Chat Bridge delivery id is invalid.");
    }
    if (typeof tabId !== "number" || !Number.isInteger(tabId) || tabId < 1)
        throw new Error("Chat Bridge delivery tab id is invalid.");
    if (typeof conversationId !== "string" || !/^[A-Za-z0-9-]{8,160}$/u.test(conversationId)) {
        throw new Error("Chat Bridge conversation id is invalid.");
    }
    if (typeof userEpoch !== "string" || userEpoch.length < 1 || userEpoch.length > 200) {
        throw new Error("Chat Bridge user epoch is invalid.");
    }
    if (typeof assistantTurnKey !== "string" || assistantTurnKey.length < 1 || assistantTurnKey.length > 200) {
        throw new Error("Chat Bridge assistant turn key is invalid.");
    }
    const message = String(text || "");
    if (!message || message.length > 4_000 || /\0/u.test(message))
        throw new Error("Chat Bridge prompt is invalid.");
    if (await hasChatBridgeReceipt(deliveryId)) {
        return {
            chatBridgeVersion: CHAT_BRIDGE_VERSION,
            deliveryId,
            tabId,
            confirmed: false,
            duplicatePrevented: true,
            ambiguous: false,
        };
    }
    await requireDebuggableTab(tabId);
    await attachTab(tabId);
    let stage = "attached";
    try {
        const before = await readChatBridgeAttachedState(tabId);
        const tab = await chooseTab(tabId);
        const identity = chatGptConversationIdentity(tab);
        if (identity?.conversationId !== conversationId)
            throw new Error("Chat Bridge conversation changed before delivery.");
        if (before.userEpoch !== userEpoch)
            throw new Error("A new user message arrived before Chat Bridge delivery.");
        if (before.assistantTurnKey !== assistantTurnKey)
            throw new Error("The assistant turn changed before Chat Bridge delivery.");
        if (before.generationActive)
            throw new Error("ChatGPT is still generating; Chat Bridge delivery is not ready.");
        if (!before.composerReady || !before.composerEmpty)
            throw new Error("ChatGPT composer is unavailable or contains human input.");
        const claimed = await claimChatBridgeReceipt(deliveryId);
        if (!claimed) {
            return {
                chatBridgeVersion: CHAT_BRIDGE_VERSION,
                deliveryId,
                tabId,
                confirmed: false,
                duplicatePrevented: true,
                ambiguous: false,
                stage: "duplicate_prevented",
            };
        }
        stage = "claimed";
        const focusResult = await send(tabId, "Runtime.evaluate", {
            expression: `(() => {
        const composer = document.querySelector('#prompt-textarea[contenteditable="true"][role="textbox"], [data-composer-markdown][contenteditable="true"][role="textbox"]');
        if (!composer) throw new Error('ChatGPT composer is unavailable');
        if (String(composer.textContent || '').trim()) throw new Error('ChatGPT composer is not empty');
        composer.focus();
        return { focused: document.activeElement === composer };
      })()`,
            returnByValue: true,
            silent: true,
        });
        if (focusResult?.exceptionDetails || cdpObject(focusResult?.result?.value)?.focused !== true) {
            throw new Error(focusResult?.exceptionDetails?.exception?.description || focusResult?.exceptionDetails?.text || "Chat Bridge could not focus the ChatGPT composer.");
        }
        await send(tabId, "Input.insertText", { text: message });
        stage = "filled";
        const chatBridgeSendSelector = CHATGPT_SEND_SELECTOR;
        const submitDeadline = Date.now() + 4_000;
        let submitReady = false;
        let lastSubmitReason = "not_ready";
        while (Date.now() < submitDeadline) {
            const submitTarget = await send(tabId, "Runtime.evaluate", {
                expression: `(() => {
          // Chat Bridge trusted submit readiness after real Input.insertText.
          const composer = document.querySelector('#prompt-textarea[contenteditable="true"][role="textbox"], [data-composer-markdown][contenteditable="true"][role="textbox"]');
          const button = document.querySelector(${JSON.stringify(chatBridgeSendSelector)});
          if (!composer) return { ready: false, reason: "composer_missing" };
          if (!String(composer.textContent || '').trim()) return { ready: false, reason: "composer_empty" };
          if (!button || !button.isConnected) return { ready: false, reason: "send_button_missing" };
          if (button.getAttribute('data-testid') === 'stop-button') return { ready: false, reason: "generation_active" };
          if (Boolean(button.disabled) || button.getAttribute('aria-disabled') === 'true') return { ready: false, reason: "send_disabled" };
          return { ready: true, reason: null };
        })()`,
                returnByValue: true,
                silent: true,
            });
            if (submitTarget?.exceptionDetails)
                throw new Error(submitTarget.exceptionDetails?.exception?.description || submitTarget.exceptionDetails?.text || "Chat Bridge submit readiness failed.");
            const candidate = cdpObject(submitTarget?.result?.value);
            if (candidate?.ready === true) {
                submitReady = true;
                break;
            }
            lastSubmitReason = typeof candidate?.reason === "string" ? candidate.reason : "not_ready";
            if (lastSubmitReason === "composer_missing" || lastSubmitReason === "generation_active") {
                throw new Error(`Chat Bridge submit target failed: ${lastSubmitReason}.`);
            }
            await sleep(100);
        }
        if (!submitReady)
            throw new Error(`Chat Bridge submit target timed out: ${lastSubmitReason}.`);
        stage = "submit_ready";
        // Activating the exact submit control with a trusted Enter key avoids a
        // coordinate click against ChatGPT's moving, 36px composer action. A
        // missed mouse click previously left the Telegram message staged forever.
        // Do not fall back to a second submit: the durable receipt owns this one
        // attempt, and only a changed user epoch can confirm delivery.
        const submitFocus = await send(tabId, "Runtime.evaluate", {
            expression: `(() => {
        // Chat Bridge coordinate-free submit: focus the trusted Send button.
        const composer = document.querySelector('#prompt-textarea[contenteditable="true"][role="textbox"], [data-composer-markdown][contenteditable="true"][role="textbox"]');
        const button = document.querySelector(${JSON.stringify(chatBridgeSendSelector)});
        if (!composer || String(composer.textContent || '') !== ${JSON.stringify(message)}) return { focused: false, reason: "composer_changed" };
        if (!button || !button.isConnected || button.type !== 'submit') return { focused: false, reason: "send_button_missing" };
        const form = composer.closest('form');
        if (!form || button.closest('form') !== form) return { focused: false, reason: "send_button_scope_changed" };
        if (button.disabled || button.getAttribute('aria-disabled') === 'true') return { focused: false, reason: "send_disabled" };
        button.focus({ preventScroll: true });
        return { focused: document.activeElement === button, reason: document.activeElement === button ? null : "send_focus_failed" };
      })()`,
            returnByValue: true,
            silent: true,
        });
        if (submitFocus?.exceptionDetails || cdpObject(submitFocus?.result?.value)?.focused !== true) {
            const reason = submitFocus?.exceptionDetails?.exception?.description
                || submitFocus?.exceptionDetails?.text
                || cdpObject(submitFocus?.result?.value)?.reason
                || "unknown";
            throw new Error(`Chat Bridge could not focus the trusted Send button: ${reason}.`);
        }
        stage = "submit_focused";
        await dispatchKeyChord(tabId, "Enter");
        stage = "submitted_keyboard";
        const deadline = Date.now() + 6_000;
        while (Date.now() < deadline) {
            await sleep(100);
            const after = await readChatBridgeAttachedState(tabId);
            const currentTab = await chooseTab(tabId);
            const currentIdentity = chatGptConversationIdentity(currentTab);
            if (currentIdentity?.conversationId !== conversationId)
                break;
            if (after.userEpoch && after.userEpoch !== userEpoch) {
                stage = "epoch_confirmed";
                return {
                    chatBridgeVersion: CHAT_BRIDGE_VERSION,
                    deliveryId,
                    tabId,
                    confirmed: true,
                    duplicatePrevented: false,
                    ambiguous: false,
                    stage,
                    userEpoch: after.userEpoch,
                    previousAssistantTurnKey: assistantTurnKey,
                };
            }
        }
        return {
            chatBridgeVersion: CHAT_BRIDGE_VERSION,
            deliveryId,
            tabId,
            confirmed: false,
            duplicatePrevented: false,
            ambiguous: true,
            stage,
        };
    }
    finally {
        scheduleDetach(tabId, CONTINUATION_MUTATION_DETACH_MS);
    }
}
async function readChatBridgeFinalResponse({ tabId, conversationId, userEpoch, previousAssistantTurnKey, } = {}) {
    if (typeof tabId !== "number" || !Number.isInteger(tabId) || tabId < 1)
        throw new Error("Chat Bridge response tab id is invalid.");
    if (typeof conversationId !== "string" || !/^[A-Za-z0-9-]{8,160}$/u.test(conversationId))
        throw new Error("Chat Bridge response conversation id is invalid.");
    if (typeof userEpoch !== "string" || userEpoch.length < 1 || userEpoch.length > 200)
        throw new Error("Chat Bridge response user epoch is invalid.");
    if (previousAssistantTurnKey !== null && (typeof previousAssistantTurnKey !== "string" || previousAssistantTurnKey.length < 1 || previousAssistantTurnKey.length > 200))
        throw new Error("Chat Bridge previous assistant turn key is invalid.");
    const state = await chatGptContinuationState(tabId);
    if (state.conversationId !== conversationId)
        return { chatBridgeVersion: CHAT_BRIDGE_VERSION, status: "drifted", reason: "conversation_changed" };
    if (state.userEpoch !== userEpoch)
        return { chatBridgeVersion: CHAT_BRIDGE_VERSION, status: "drifted", reason: "user_epoch_changed" };
    if (state.generationActive)
        return { chatBridgeVersion: CHAT_BRIDGE_VERSION, status: "waiting" };
    if (!state.assistantTurnKey || state.assistantTurnKey === previousAssistantTurnKey) {
        return { chatBridgeVersion: CHAT_BRIDGE_VERSION, status: "waiting" };
    }
    await requireDebuggableTab(tabId);
    await attachTab(tabId);
    try {
        const result = await send(tabId, "Runtime.evaluate", {
            expression: `(() => {
        // Chat Bridge final response: read only the exact completed assistant turn requested by Local.
        const key = ${JSON.stringify(state.assistantTurnKey)};
        // In current ChatGPT the observer's assistantTurnKey is the parent
        // data-turn-key (the user epoch), not an old data-message-id. Resolve
        // the *same exact turn* and read only its assistant render subtree.
        const modernTurn = [...document.querySelectorAll('[data-turn-key]')]
          .find((node) => node.getAttribute('data-turn-key') === key);
        const modernAssistant = modernTurn?.querySelector('[data-chatgpt-search-unit-key$=":assistant"][data-chatgpt-search-message-ids]');
        const legacyRoots = [...document.querySelectorAll('section[data-turn="assistant"][data-testid], [data-message-author-role="assistant"][data-message-id]')];
        const legacyRoot = legacyRoots.find((node) => node.getAttribute('data-testid') === key || node.getAttribute('data-message-id') === key);
        const root = modernAssistant || legacyRoot;
        if (!root) return { found: false };
        const body = modernAssistant
          ? (modernAssistant.querySelector('[data-chatgpt-selection-message-id]') || modernAssistant)
          : (legacyRoot.matches('[data-message-author-role="assistant"]')
            ? legacyRoot : (legacyRoot.querySelector('[data-message-author-role="assistant"]') || legacyRoot));
        const raw = String(body.innerText || body.textContent || '').trim();
        if (!raw) return { found: true, empty: true };
        const chars = [...raw];
        const maxChars = 12000;
        return {
          found: true,
          empty: false,
          text: chars.slice(0, maxChars).join(''),
          truncated: chars.length > maxChars,
        };
      })()`,
            returnByValue: true,
        });
        if (result?.exceptionDetails)
            throw new Error(result.exceptionDetails.text || "Chat Bridge final response read failed.");
        const value = cdpObject(result?.result?.value);
        if (!value?.found || value.empty || typeof value.text !== "string" || !value.text.trim()) {
            return { chatBridgeVersion: CHAT_BRIDGE_VERSION, status: "waiting" };
        }
        return {
            chatBridgeVersion: CHAT_BRIDGE_VERSION,
            status: "ready",
            assistantTurnKey: state.assistantTurnKey,
            text: value.text,
            truncated: value.truncated === true,
        };
    }
    finally {
        scheduleDetach(tabId, CONTINUATION_MUTATION_DETACH_MS);
    }
}
function workerAlarms() {
    return globalThis.chrome.alarms;
}
function workerRuntime() {
    return globalThis.chrome.runtime;
}
function clearReconnectSchedule() {
    if (reconnectTimer)
        clearTimeout(reconnectTimer);
    reconnectTimer = null;
    reconnectDelayMs = 500;
    immediateReconnectUsed = false;
    void workerAlarms().clear(NATIVE_RECONNECT_ALARM);
}
async function popupStatus() {
    await Promise.all([
        ensureBrowserControlConsentLoaded(),
        ensureBrowserEnabledLoaded(),
        ensureAgentCursorEnabledLoaded(),
        ensureAgentCursorNameLoaded(),
        ensureBrowserIdentityLoaded(),
        ensureAutoContinueTargetLoaded(),
    ]);
    const consentAccepted = hasCurrentBrowserControlConsent();
    let tab = null;
    if (browserEnabled && consentAccepted) {
        try {
            tab = await chooseTab();
        }
        catch {
            // Chrome can transiently have no tab while windows are closing.
        }
    }
    const policy = tab ? classifyBrowserPage(tab) : null;
    const autoContinue = await autoContinueTargetStatus({ includeTabs: browserEnabled && consentAccepted });
    return {
        enabled: browserEnabled,
        consentAccepted,
        consentVersion: browserControlConsentVersion,
        requiredConsentVersion: CURRENT_BROWSER_CONTROL_CONSENT_VERSION,
        agentCursorEnabled,
        agentCursorName,
        nativeHostConnected: Boolean(nativePort),
        localConnected: localBridgeConnected,
        extensionVersion: workerRuntime().getManifest().version,
        browserContext,
        browserInstanceId,
        lastNativeDisconnectError,
        autoContinue,
        tab: tab
            ? {
                id: tab.id,
                title: tab.title || "",
                url: tab.url || "",
                pageKind: policy?.kind || "unknown",
                debuggerSupported: Boolean(policy?.debuggerSupported),
            }
            : null,
    };
}
async function setBrowserEnabled(nextEnabled) {
    if (typeof nextEnabled !== "boolean")
        throw new Error("enabled must be boolean.");
    await ensureBrowserEnabledLoaded();
    const enabled = nextEnabled;
    if (enabled && !hasCurrentBrowserControlConsent()) {
        throw new Error("Browser control requires consent in the Equinox Browser extension popup.");
    }
    if (browserEnabled === enabled)
        return await popupStatus();
    await workerStorageLocal().set({ [BROWSER_ENABLED_STORAGE_KEY]: enabled });
    browserEnabled = enabled;
    if (!enabled) {
        await browserDisconnect();
    }
    lastNativeDisconnectError = null;
    connectNativeHost();
    return await popupStatus();
}
async function acceptBrowserControlConsent() {
    await ensureBrowserEnabledLoaded();
    await workerStorageLocal().set({
        [BROWSER_CONTROL_CONSENT_STORAGE_KEY]: CURRENT_BROWSER_CONTROL_CONSENT_VERSION,
        [BROWSER_ENABLED_STORAGE_KEY]: true,
    });
    browserControlConsentVersion = CURRENT_BROWSER_CONTROL_CONSENT_VERSION;
    browserControlConsentLoaded = true;
    browserEnabled = true;
    browserEnabledLoaded = true;
    lastNativeDisconnectError = null;
    connectNativeHost();
    return await popupStatus();
}
async function setAgentCursorEnabled(nextEnabled) {
    if (typeof nextEnabled !== "boolean")
        throw new Error("agentCursorEnabled must be boolean.");
    await ensureAgentCursorEnabledLoaded();
    const enabled = nextEnabled;
    await workerStorageLocal().set({ [AGENT_CURSOR_STORAGE_KEY]: enabled });
    agentCursorEnabled = enabled;
    return await popupStatus();
}
async function setAgentCursorName(nextName) {
    await ensureAgentCursorNameLoaded();
    const normalized = normalizeAgentCursorName(nextName);
    await workerStorageLocal().set({ [AGENT_CURSOR_NAME_STORAGE_KEY]: normalized });
    agentCursorName = normalized;
    return await popupStatus();
}
async function updateBrowserSettings(nextSettings = {}) {
    if (!nextSettings || typeof nextSettings !== "object" || Array.isArray(nextSettings)) {
        throw new Error("Browser settings must be an object.");
    }
    const settings = nextSettings;
    const allowed = new Set(["enabled", "agentCursorEnabled", "agentCursorName"]);
    for (const key of Object.keys(settings)) {
        if (!allowed.has(key))
            throw new Error(`Unsupported browser setting: ${key}`);
    }
    if (Object.hasOwn(nextSettings, "enabled") && typeof settings.enabled !== "boolean") {
        throw new Error("enabled must be boolean.");
    }
    if (Object.hasOwn(nextSettings, "agentCursorEnabled") && typeof settings.agentCursorEnabled !== "boolean") {
        throw new Error("agentCursorEnabled must be boolean.");
    }
    if (Object.hasOwn(nextSettings, "agentCursorName") && typeof settings.agentCursorName !== "string") {
        throw new Error("agentCursorName must be text.");
    }
    if (Object.hasOwn(nextSettings, "enabled"))
        await setBrowserEnabled(settings.enabled);
    if (Object.hasOwn(nextSettings, "agentCursorEnabled"))
        await setAgentCursorEnabled(settings.agentCursorEnabled);
    if (Object.hasOwn(nextSettings, "agentCursorName"))
        await setAgentCursorName(settings.agentCursorName);
    return await popupStatus();
}
function postNativeResponseForPort(port, payload) {
    if (port && nativePort === port)
        port.postMessage(payload);
}
function postSuccessfulResponse(id, result, sourcePort = nativePort) {
    const payload = result && typeof result === "object" && !Array.isArray(result)
        ? result : null;
    const data = typeof payload?.data === "string" ? payload.data : null;
    if (!payload || !data || data.length <= RESPONSE_CHUNK_CHARS) {
        postNativeResponseForPort(sourcePort, { type: "response", id, ok: true, result });
        return;
    }
    const { data: _data, ...metadata } = payload;
    const total = Math.ceil(data.length / RESPONSE_CHUNK_CHARS);
    for (let index = 0; index < total; index += 1) {
        postNativeResponseForPort(sourcePort, {
            type: "response.chunk",
            id,
            field: "data",
            index,
            total,
            data: data.slice(index * RESPONSE_CHUNK_CHARS, (index + 1) * RESPONSE_CHUNK_CHARS),
        });
    }
    postNativeResponseForPort(sourcePort, {
        type: "response",
        id,
        ok: true,
        result: { ...metadata, streamed: { field: "data", chunks: total } },
    });
}
function isNewTabUrl(url = "") {
    return /^chrome:\/\/(newtab|new-tab-page)\//.test(url);
}
const CHROME_PDF_VIEWER_EXTENSION_ID = "mhjfbmdgcfjbbpaeojofohoefgiehjai";
function isChromeWebStoreUrl(parsed) {
    if (!parsed)
        return false;
    if (parsed.hostname === "chromewebstore.google.com")
        return true;
    return parsed.hostname === "chrome.google.com" && parsed.pathname.startsWith("/webstore");
}
function classifyBrowserPage(tabOrUrl) {
    const tab = typeof tabOrUrl === "string" ? { url: tabOrUrl } : (tabOrUrl || {});
    const url = String(tab.url || "");
    const title = String(tab.title || "");
    if (isNewTabUrl(url)) {
        return { kind: "chrome-new-tab", debuggerSupported: false, openSupported: true, reason: "chrome-new-tab" };
    }
    if (url.startsWith("chrome://extensions")) {
        return { kind: "chrome-extensions", debuggerSupported: false, openSupported: false, reason: "chrome-internal" };
    }
    if (url.startsWith("chrome://settings")) {
        return { kind: "chrome-settings", debuggerSupported: false, openSupported: false, reason: "chrome-internal" };
    }
    if (url.startsWith("chrome://")) {
        return { kind: "chrome-internal", debuggerSupported: false, openSupported: false, reason: "chrome-internal" };
    }
    if (url.startsWith("devtools://")) {
        return { kind: "devtools", debuggerSupported: false, openSupported: false, reason: "devtools" };
    }
    if (url.startsWith("chrome-error://")) {
        return { kind: "browser-owned-error", debuggerSupported: false, openSupported: false, reason: "browser-owned" };
    }
    if (url.startsWith("chrome-extension://")) {
        const extensionId = url.slice("chrome-extension://".length).split("/", 1)[0];
        return {
            kind: extensionId === CHROME_PDF_VIEWER_EXTENSION_ID ? "chrome-pdf-viewer-extension" : "chrome-extension-page",
            debuggerSupported: false,
            openSupported: false,
            reason: "chrome-extension-page",
        };
    }
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        return { kind: "unknown", debuggerSupported: false, openSupported: false, reason: "invalid-url" };
    }
    if (parsed.protocol === "file:") {
        return { kind: "file-url", debuggerSupported: false, openSupported: false, reason: "local-file" };
    }
    if (new Set(["http:", "https:"]).has(parsed.protocol)) {
        if (isChromeWebStoreUrl(parsed)) {
            return { kind: "chrome-web-store", debuggerSupported: false, openSupported: true, reason: "extensions-gallery" };
        }
        if (/^(privacy|security) error$/i.test(title)) {
            return { kind: "browser-owned-interstitial", debuggerSupported: false, openSupported: true, reason: "browser-owned" };
        }
        return { kind: "web", debuggerSupported: true, openSupported: true, reason: null };
    }
    return { kind: "unsupported-scheme", debuggerSupported: false, openSupported: false, reason: parsed.protocol || "unsupported-scheme" };
}
function restrictedPageMessage(policy) {
    switch (policy?.kind) {
        case "chrome-new-tab":
            return "Chrome New Tab is restricted. Navigate this same tab to an HTTP(S) page before using debugger-backed commands.";
        case "chrome-extensions":
            return "chrome://extensions is browser-owned UI and cannot be scripted or debugged by Equinox Browser.";
        case "chrome-settings":
            return "chrome://settings is browser-owned UI and cannot be scripted or debugged by Equinox Browser.";
        case "chrome-web-store":
            return "Chrome Web Store is protected by Chrome and cannot be scripted by extensions.";
        case "file-url":
            return "file:// pages are intentionally unsupported. Equinox Browser does not navigate to or debug arbitrary local files.";
        case "browser-owned-interstitial":
        case "browser-owned-error":
            return "This browser-owned error/interstitial page cannot be scripted or debugged by Equinox Browser.";
        case "devtools":
            return "DevTools pages cannot be scripted or debugged by Equinox Browser.";
        case "chrome-extension-page":
        case "chrome-pdf-viewer-extension":
            return "Top-level Chrome extension pages cannot be scripted or debugged by Equinox Browser.";
        case "chrome-internal":
            return "Chrome internal pages cannot be scripted or debugged by Equinox Browser.";
        default:
            return "This browser page type is unsupported by Equinox Browser.";
    }
}
function restrictedPageError(policy) {
    const error = new Error(restrictedPageMessage(policy));
    error.code = "EQUINOX_RESTRICTED_PAGE";
    error.pageKind = policy?.kind || "unknown";
    error.reason = policy?.reason || "restricted";
    return error;
}
function validateOpenUrl(rawUrl) {
    const value = String(rawUrl || "").trim();
    if (!value)
        throw new Error("URL is required");
    const policy = classifyBrowserPage(value);
    if (!policy.openSupported)
        throw restrictedPageError(policy);
    if (isNewTabUrl(value))
        return value;
    return new URL(value).toString();
}
async function chooseTab(tabId) {
    if (typeof tabId === "number" && Number.isInteger(tabId))
        return await workerTabs().get(tabId);
    const active = await workerTabs().query({ active: true, lastFocusedWindow: true });
    if (active[0])
        return active[0];
    const current = await workerTabs().query({ active: true, currentWindow: true });
    if (current[0])
        return current[0];
    const all = await workerTabs().query({});
    if (all[0])
        return all[0];
    throw new Error("No Chrome tab is available");
}
async function waitForTab(tabId, predicate, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    let tab;
    while (Date.now() < deadline) {
        tab = await workerTabs().get(tabId);
        if (predicate(tab))
            return tab;
        await sleep(100);
    }
    throw new Error(`Timed out waiting for tab ${tabId}: ${tab?.url || "unknown"}`);
}
function historyNavigationSignal({ initialTab, candidate, initialGeneration, sawLoading, tabId }) {
    if (currentDocumentGeneration(tabId) !== initialGeneration)
        return "document_generation";
    if (String(candidate?.url || "") !== String(initialTab?.url || ""))
        return "url_change";
    if (sawLoading)
        return "status_cycle";
    if (String(candidate?.title || "") !== String(initialTab?.title || ""))
        return "title_change";
    return null;
}
async function waitForHistoryNavigation(tabId, initialTab, initialGeneration, timeoutMs = HISTORY_NAVIGATION_TIMEOUT_MS) {
    const deadline = Date.now() + Math.max(250, Math.min(Number(timeoutMs) || HISTORY_NAVIGATION_TIMEOUT_MS, 10_000));
    let last = initialTab;
    let sawLoading = false;
    let signal = null;
    let stableSignature = null;
    let stableSince = null;
    while (Date.now() < deadline) {
        last = await workerTabs().get(tabId);
        if (last?.status === "loading")
            sawLoading = true;
        signal = historyNavigationSignal({ initialTab, candidate: last, initialGeneration, sawLoading, tabId });
        if (signal && last?.status !== "loading") {
            const signature = JSON.stringify([
                last?.url || "",
                last?.title || "",
                last?.status || "",
                currentDocumentGeneration(tabId),
            ]);
            if (signature !== stableSignature) {
                stableSignature = signature;
                stableSince = Date.now();
            }
            else if (stableSince != null && Date.now() - stableSince >= HISTORY_METADATA_SETTLE_MS) {
                return {
                    tab: last,
                    navigationCommitted: true,
                    navigationTimedOut: false,
                    metadataSettled: true,
                    navigationSignal: signal,
                };
            }
        }
        else {
            stableSignature = null;
            stableSince = null;
        }
        await sleep(HISTORY_NAVIGATION_POLL_MS);
    }
    return {
        tab: last,
        navigationCommitted: Boolean(signal),
        navigationTimedOut: true,
        metadataSettled: false,
        navigationSignal: signal,
    };
}
function workerDebuggerLease() {
    return globalThis.chrome.debugger;
}
// Restrict only the two frame-routing CDP methods; leave arbitrary CDP send()
// unchanged until their individual response contracts have been migrated.
async function sendFrameRoutingCommand(tabId, command, sessionId = null) {
    const debuggee = sessionId ? { tabId, sessionId } : { tabId };
    await workerDebuggerLease().sendCommand(debuggee, command.method, command.params);
}
const ALLOWED_WORKER_CDP_METHODS = new Set([
    "Accessibility.enable",
    "Accessibility.getFullAXTree",
    "Accessibility.queryAXTree",
    "DOM.describeNode",
    "DOM.enable",
    "DOM.getBoxModel",
    "DOM.getDocument",
    "DOM.getFrameOwner",
    "DOM.querySelector",
    "DOM.resolveNode",
    "DOM.scrollIntoViewIfNeeded",
    "DOM.setFileInputFiles",
    "Emulation.clearDeviceMetricsOverride",
    "Emulation.setDeviceMetricsOverride",
    "Emulation.setTouchEmulationEnabled",
    "Input.cancelDragging",
    "Input.dispatchDragEvent",
    "Input.dispatchKeyEvent",
    "Input.dispatchMouseEvent",
    "Input.dispatchTouchEvent",
    "Input.insertText",
    "Input.setInterceptDrags",
    "Network.enable",
    "Network.setCacheDisabled",
    "Page.bringToFront",
    "Page.captureScreenshot",
    "Page.enable",
    "Page.getFrameTree",
    "Page.getLayoutMetrics",
    "Page.getNavigationHistory",
    "Page.handleJavaScriptDialog",
    "Page.navigate",
    "Page.navigateToHistoryEntry",
    "Page.reload",
    "Runtime.callFunctionOn",
    "Runtime.enable",
    "Runtime.evaluate",
    "Runtime.releaseObject",
]);
function workerCdpCommands() {
    return globalThis.chrome.debugger;
}
function checkedCdpCommandResult(method, value) {
    const response = value == null ? {} : cdpObject(value);
    if (!response)
        throw new Error(`Chrome CDP ${method} returned a non-object response`);
    if (method === "Runtime.evaluate" || method === "Runtime.callFunctionOn") {
        const result = response.result;
        const remote = result == null ? null : cdpObject(result);
        if (result != null && !remote)
            throw new Error(`Chrome CDP ${method} returned an invalid remote object`);
        if (remote?.objectId != null && typeof remote.objectId !== "string")
            throw new Error(`Chrome CDP ${method} has invalid remote object id`);
        if (remote?.type != null && typeof remote.type !== "string")
            throw new Error(`Chrome CDP ${method} has invalid remote object type`);
        const exception = response.exceptionDetails;
        const details = exception == null ? null : cdpObject(exception);
        if (exception != null && !details)
            throw new Error(`Chrome CDP ${method} returned invalid exception details`);
        if (details?.text != null && typeof details.text !== "string")
            throw new Error(`Chrome CDP ${method} returned invalid exception text`);
    }
    else if (method === "DOM.resolveNode" && response.object != null && !cdpObject(response.object)) {
        throw new Error("Chrome CDP DOM.resolveNode returned invalid object metadata");
    }
    else if (method === "DOM.getBoxModel" && response.model != null) {
        const model = cdpObject(response.model);
        if (!model)
            throw new Error("Chrome CDP DOM.getBoxModel returned an invalid box model");
        for (const field of ["border", "content", "padding", "margin"]) {
            const quad = model[field];
            if (quad != null && (!Array.isArray(quad) || quad.length < 8 || !quad.every((n) => typeof n === "number" && Number.isFinite(n)))) {
                throw new Error(`Chrome CDP DOM.getBoxModel returned invalid ${field} coordinates`);
            }
        }
    }
    else if (method === "Page.getLayoutMetrics") {
        for (const field of ["cssLayoutViewport", "layoutViewport", "cssContentSize", "contentSize"]) {
            if (response[field] == null)
                continue;
            const rect = cdpObject(response[field]);
            if (!rect)
                throw new Error(`Chrome CDP Page.getLayoutMetrics has invalid ${field}`);
            for (const [key, value] of Object.entries(rect)) {
                if (["pageX", "pageY", "clientWidth", "clientHeight", "x", "y", "width", "height"].includes(key)
                    && (typeof value !== "number" || !Number.isFinite(value))) {
                    throw new Error(`Chrome CDP Page.getLayoutMetrics has invalid ${field}.${key}`);
                }
            }
        }
    }
    if (method === "Accessibility.getFullAXTree" || method === "Accessibility.queryAXTree") {
        return checkedAxTreeResponse(response);
    }
    if (method === "DOM.querySelector" || method === "DOM.getFrameOwner") {
        const field = method === "DOM.querySelector" ? "nodeId" : "backendNodeId";
        if (response[field] != null && (typeof response[field] !== "number" || !Number.isSafeInteger(response[field]))) {
            throw new Error(`Chrome CDP ${method} returned invalid ${field}`);
        }
    }
    if (method === "DOM.getDocument" && response.root != null) {
        const root = cdpObject(response.root);
        if (!root || (root.nodeId != null && (typeof root.nodeId !== "number" || !Number.isSafeInteger(root.nodeId)))) {
            throw new Error("Chrome CDP DOM.getDocument returned invalid root node");
        }
    }
    if (method === "DOM.describeNode" && response.node != null) {
        const node = cdpObject(response.node);
        if (!node || (node.backendNodeId != null && (typeof node.backendNodeId !== "number" || !Number.isSafeInteger(node.backendNodeId)))) {
            throw new Error("Chrome CDP DOM.describeNode returned invalid node metadata");
        }
    }
    if (method === "Page.getNavigationHistory") {
        if (response.currentIndex != null && (typeof response.currentIndex !== "number" || !Number.isSafeInteger(response.currentIndex))) {
            throw new Error("Chrome CDP Page.getNavigationHistory returned invalid current index");
        }
        if (response.entries != null && (!Array.isArray(response.entries) || !response.entries.every((entry) => {
            const item = cdpObject(entry);
            return item && typeof item.id === "number" && Number.isSafeInteger(item.id);
        })))
            throw new Error("Chrome CDP Page.getNavigationHistory returned invalid entries");
    }
    if (method === "Page.captureScreenshot" && response.data != null && typeof response.data !== "string") {
        throw new Error("Chrome CDP Page.captureScreenshot returned invalid image data");
    }
    // This assertion is confined to known method results AFTER a method-specific shape check.
    // Untrusted Runtime.result.value stays unknown until decoded by its consumer.
    return response;
}
async function send(tabId, method, params = {}, sessionId = null) {
    if (typeof tabId !== "number" || !Number.isSafeInteger(tabId) || tabId < 1)
        throw new Error("CDP command requires a valid Chrome tab id");
    if (!ALLOWED_WORKER_CDP_METHODS.has(method))
        throw new Error(`CDP method is not allowlisted: ${String(method)}`);
    const debuggee = sessionId ? { tabId, sessionId } : { tabId };
    const response = await workerCdpCommands().sendCommand(debuggee, method, params);
    return checkedCdpCommandResult(method, response);
}
function currentDocumentGeneration(tabId) {
    return documentGenerations.get(tabId) || 1;
}
function invalidateRefs(tabId, { bumpGeneration = false } = {}) {
    if (bumpGeneration) {
        documentGenerations.set(tabId, currentDocumentGeneration(tabId) + 1);
        refRegistries.delete(tabId);
        return;
    }
    refStates.delete(tabId);
}
function refContextMetadata(tabId, { validReason = "current_snapshot", invalidReason = "no_active_snapshot" } = {}) {
    const state = refStates.get(tabId);
    const generation = currentDocumentGeneration(tabId);
    if (!state) {
        return {
            currentSnapshotId: null,
            refContextValid: false,
            freshSnapshotRequired: true,
            refContextReason: invalidReason,
            currentDocumentGeneration: generation,
        };
    }
    if (state.documentGeneration !== generation) {
        refStates.delete(tabId);
        return {
            currentSnapshotId: null,
            refContextValid: false,
            freshSnapshotRequired: true,
            refContextReason: "document_generation_changed",
            currentDocumentGeneration: generation,
        };
    }
    return {
        currentSnapshotId: state.snapshotId || null,
        refContextValid: true,
        freshSnapshotRequired: false,
        refContextReason: validReason,
        currentDocumentGeneration: generation,
    };
}
function captureRefContextSource(tabId) {
    const state = refStates.get(tabId);
    return {
        sourceSnapshotId: state?.snapshotId || null,
        sourceDocumentGeneration: state?.documentGeneration ?? currentDocumentGeneration(tabId),
    };
}
function refOperationMetadata(tabId, source = null, options = {}) {
    return {
        refLifecycleVersion: REF_LIFECYCLE_VERSION,
        sourceSnapshotId: source?.sourceSnapshotId ?? null,
        sourceDocumentGeneration: source?.sourceDocumentGeneration ?? currentDocumentGeneration(tabId),
        ...refContextMetadata(tabId, options),
    };
}
function scheduleActionDetach(tabId, { afterResult = null, preserveRefContext = false, idleMs = DEFAULT_ATTACH_IDLE_MS, } = {}) {
    const hasFreshSnapshot = Boolean(afterResult?.ok &&
        afterResult?.snapshot?.snapshot?.id &&
        refStates.get(tabId)?.snapshotId === afterResult.snapshot.snapshot.id);
    scheduleDetach(tabId, preserveRefContext || hasFreshSnapshot ? DEFAULT_ATTACH_IDLE_MS : idleMs);
}
function registerChildSession(tabId, sessionId, targetInfo = {}) {
    const state = attachedTabs.get(tabId);
    if (!state || !sessionId)
        return;
    state.sessions.set(sessionId, {
        sessionId,
        targetId: targetInfo.targetId || null,
        type: targetInfo.type || null,
        url: targetInfo.url || "",
        title: targetInfo.title || "",
    });
}
function unregisterChildSession(tabId, sessionId) {
    const state = attachedTabs.get(tabId);
    if (!state || !sessionId)
        return;
    state.sessions.delete(sessionId);
    invalidateRefs(tabId, { bumpGeneration: true });
}
const FRAME_AUTO_ATTACH_OPTIONS = Object.freeze({
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
});
async function ensureFrameRouting(tabId) {
    const state = attachedTabs.get(tabId);
    if (!state || state.frameRoutingReady)
        return;
    await sendFrameRoutingCommand(tabId, { method: "Page.enable", params: {} });
    await sendFrameRoutingCommand(tabId, { method: "Target.setAutoAttach", params: FRAME_AUTO_ATTACH_OPTIONS });
    state.frameRoutingReady = true;
}
async function ensureRecursiveFrameRouting(tabId) {
    await ensureFrameRouting(tabId);
    const state = attachedTabs.get(tabId);
    if (!state)
        return;
    let previousSessionCount = -1;
    for (let round = 0; round < 4; round += 1) {
        const sessions = [...state.sessions.values()].filter((session) => !session.type || session.type === "iframe");
        if (sessions.length === previousSessionCount && round > 0)
            break;
        previousSessionCount = sessions.length;
        await Promise.all(sessions.map(async (session) => {
            await sendFrameRoutingCommand(tabId, { method: "Page.enable", params: {} }, session.sessionId).catch(() => { });
            await sendFrameRoutingCommand(tabId, { method: "Target.setAutoAttach", params: FRAME_AUTO_ATTACH_OPTIONS }, session.sessionId).catch(() => { });
        }));
        await sleep(25);
    }
}
function scheduleDetach(tabId, idleMs = DEFAULT_ATTACH_IDLE_MS) {
    if (typeof tabId !== "number" || !Number.isSafeInteger(tabId) || tabId < 1)
        return;
    const state = attachedTabs.get(tabId);
    if (!state || state.persistent || currentDialogRecord(tabId))
        return;
    if (state.timer !== null)
        clearTimeout(state.timer);
    state.timer = setTimeout(() => {
        void detachTab(tabId).catch(() => { });
    }, idleMs ?? 0);
    // Node tests expose unref(); Chrome MV3 uses numeric timer handles.
    const testTimer = state.timer;
    if (testTimer && typeof testTimer === "object" && "unref" in testTimer
        && typeof testTimer.unref === "function") {
        testTimer.unref();
    }
}
function normalizeDebuggerAttachError(error, tab) {
    const message = errorMessage(error);
    if (/extensions gallery cannot be scripted/i.test(message)) {
        return restrictedPageError({ kind: "chrome-web-store", reason: "extensions-gallery" });
    }
    if (/cannot attach to this target/i.test(message)) {
        return restrictedPageError({ kind: "browser-owned-interstitial", reason: "browser-owned" });
    }
    if (/cannot access a chrome:\/\/ url/i.test(message)) {
        return restrictedPageError(classifyBrowserPage(tab));
    }
    return error;
}
async function attachTab(tabId, idleMs = DEFAULT_ATTACH_IDLE_MS, { persistent = false } = {}) {
    if (typeof tabId !== "number" || !Number.isSafeInteger(tabId) || tabId < 1)
        throw new Error("Debugger attach requires a valid Chrome tab id");
    if (!attachedTabs.has(tabId)) {
        try {
            await workerDebuggerLease().attach({ tabId }, PROTOCOL_VERSION);
        }
        catch (error) {
            let tab = null;
            try {
                tab = await workerTabs().get(tabId);
            }
            catch {
                // Preserve the original debugger error if the tab disappeared.
            }
            throw normalizeDebuggerAttachError(error, tab);
        }
        attachedTabs.set(tabId, {
            attachedAt: Date.now(),
            timer: null,
            persistent: false,
            frameRoutingReady: false,
            sessions: new Map(),
        });
    }
    const state = attachedTabs.get(tabId);
    if (!state)
        throw new Error("Debugger attachment state disappeared after attach.");
    if (persistent) {
        state.persistent = true;
        if (state.timer)
            clearTimeout(state.timer);
        state.timer = null;
        return;
    }
    scheduleDetach(tabId, idleMs);
}
async function detachTab(tabId) {
    if (typeof tabId !== "number" || !Number.isSafeInteger(tabId) || tabId < 1)
        return;
    const state = attachedTabs.get(tabId);
    if (state?.timer)
        clearTimeout(state.timer);
    attachedTabs.delete(tabId);
    refStates.delete(tabId);
    observationStates.delete(tabId);
    dialogStates.delete(tabId);
    rejectPendingHtml5DragIntercept(tabId, "Debugger detached while waiting for HTML5 drag interception");
    try {
        await workerDebuggerLease().detach({ tabId });
    }
    catch {
        // Already detached or tab closed.
    }
}
async function requireDebuggableTab(tabId) {
    if (typeof tabId !== "number" || !Number.isSafeInteger(tabId) || tabId < 1)
        throw new Error("Debuggable tab requires a valid Chrome tab id");
    const tab = await workerTabs().get(tabId);
    const policy = classifyBrowserPage(tab);
    if (!policy.debuggerSupported)
        throw restrictedPageError(policy);
    return tab;
}
function pushBounded(list, value, limit = MAX_OBSERVATION_EVENTS) {
    list.push(value);
    if (list.length > limit)
        list.splice(0, list.length - limit);
}
function pushObservationEvent(state, stream, value) {
    const cursorField = stream === "console" ? "consoleCursor" : "networkCursor";
    const cursor = (Number(state[cursorField]) || 0) + 1;
    state[cursorField] = cursor;
    pushBounded(state[stream], { cursor, ...value });
    return cursor;
}
function rememberNetworkRequest(state, requestId, metadata) {
    if (!requestId)
        return;
    if (!(state.networkRequests instanceof Map))
        state.networkRequests = new Map();
    state.networkRequests.delete(requestId);
    state.networkRequests.set(requestId, metadata);
    while (state.networkRequests.size > MAX_OBSERVATION_EVENTS) {
        const oldest = state.networkRequests.keys().next().value;
        if (oldest == null)
            break;
        state.networkRequests.delete(oldest);
    }
}
function networkRequestMetadata(state, requestId) {
    const value = requestId ? state.networkRequests?.get(requestId) : null;
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    const fields = value;
    return {
        method: typeof fields.method === "string" ? fields.method : null,
        url: typeof fields.url === "string" ? fields.url : null,
        status: typeof fields.status === "number" && Number.isFinite(fields.status) ? fields.status : null,
        mimeType: typeof fields.mimeType === "string" ? fields.mimeType : null,
        type: typeof fields.type === "string" ? fields.type : null,
    };
}
function forgetNetworkRequest(state, requestId) {
    if (requestId)
        state.networkRequests?.delete(requestId);
}
function normalizeObservationCursor(value, currentCursor) {
    if (value == null)
        return null;
    const cursor = Number(value);
    if (!Number.isSafeInteger(cursor) || cursor < 0)
        throw new Error("Observation cursor must be a non-negative safe integer.");
    if (cursor > currentCursor)
        throw new Error(`Observation cursor ${cursor} is ahead of the current cursor ${currentCursor}.`);
    return cursor;
}
function getObservation(tabId) {
    const state = observationStates.get(tabId);
    if (!state)
        throw new Error("Observation is not active for this tab. Call equinox_browser_observe_start first.");
    return state;
}
function currentDialogRecord(tabId) {
    return dialogStates.get(tabId) || null;
}
function recordDialogState(tabId, source, params = {}) {
    const dialog = {
        openedAt: new Date().toISOString(),
        type: params.type || "alert",
        message: String(params.message || "").slice(0, 20_000),
        defaultPrompt: String(params.defaultPrompt || "").slice(0, 20_000),
        url: safeObservedUrl(params.url || ""),
        hasBrowserHandler: Boolean(params.hasBrowserHandler),
        sessionScope: source?.sessionId ? "child" : "root",
    };
    const record = {
        sequence: ++dialogSequence,
        dialog,
        sessionId: source?.sessionId || null,
    };
    dialogStates.set(tabId, record);
    const attachment = attachedTabs.get(tabId);
    if (attachment?.timer) {
        clearTimeout(attachment.timer);
        attachment.timer = null;
    }
    const observation = observationStates.get(tabId);
    if (observation)
        observation.dialog = dialog;
    return record;
}
function clearDialogState(tabId) {
    dialogStates.delete(tabId);
    const observation = observationStates.get(tabId);
    if (observation)
        observation.dialog = null;
}
async function waitForNewDialog(tabId, afterSequence, timeoutMs = 1_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const record = currentDialogRecord(tabId);
        if (record && record.sequence > afterSequence)
            return record.dialog;
        await sleep(20);
    }
    return null;
}
async function settleCommandOrDialog(tabId, commandPromise, afterSequence) {
    const dialog = await Promise.race([
        commandPromise.then(() => null),
        waitForNewDialog(tabId, afterSequence),
    ]);
    if (dialog) {
        void commandPromise.catch(() => { });
        return dialog;
    }
    await commandPromise;
    return null;
}
function remoteValue(arg) {
    if (arg && (typeof arg !== "object" || Array.isArray(arg)))
        return null;
    const received = arg;
    if (!received)
        return null;
    if (Object.prototype.hasOwnProperty.call(received, "value"))
        return received.value;
    if (received.unserializableValue)
        return received.unserializableValue;
    return received.description ?? received.type ?? null;
}
function safeObservedUrl(rawUrl) {
    const value = String(rawUrl || "");
    try {
        const parsed = new URL(value);
        parsed.hash = "";
        for (const [key] of parsed.searchParams) {
            if (/(token|key|secret|auth|password|passwd|session|code)/i.test(key))
                parsed.searchParams.set(key, "[REDACTED]");
        }
        return parsed.toString().slice(0, 4_000);
    }
    catch {
        return value.slice(0, 4_000);
    }
}
function observationRead(state, stream, { limit = 100, clear = false, afterCursor = null, predicate = null, } = {}) {
    const list = state[stream];
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
    const currentCursor = Number(state[stream === "console" ? "consoleCursor" : "networkCursor"]) || 0;
    const cursor = normalizeObservationCursor(afterCursor, currentCursor);
    if (cursor != null && clear)
        throw new Error("clear cannot be combined with after_cursor; advance the stable cursor instead.");
    const minAvailableCursor = list.length > 0 ? Math.max(0, Number(list[0]?.cursor) - 1) : currentCursor;
    if (cursor != null && cursor < minAvailableCursor) {
        throw new Error(`Observation cursor ${cursor} is no longer available; the bounded event buffer now starts after cursor ${minAvailableCursor}.`);
    }
    let candidates = cursor == null ? list : list.filter((item) => Number(item?.cursor) > cursor);
    if (typeof predicate === "function")
        candidates = candidates.filter(predicate);
    let items;
    let hasMore = false;
    let nextCursor = currentCursor;
    if (cursor == null) {
        items = candidates.slice(-boundedLimit);
    }
    else {
        items = candidates.slice(0, boundedLimit);
        hasMore = candidates.length > items.length;
        if (hasMore && items.length > 0)
            nextCursor = Number(items[items.length - 1].cursor);
    }
    if (clear)
        list.length = 0;
    return {
        items,
        returned: items.length,
        matched: candidates.length,
        nextCursor,
        currentCursor,
        minAvailableCursor,
        hasMore,
        cleared: Boolean(clear),
    };
}
function normalizeConsoleLevelFilter(level) {
    if (level == null || level === "")
        return null;
    const normalized = String(level).trim().toLowerCase();
    if (!CONSOLE_LEVEL_FILTERS.has(normalized))
        throw new Error(`Unsupported console level filter: ${String(level)}`);
    return normalized;
}
function consoleEventMatches(event, { level = null, query = null } = {}) {
    if (level && String(event?.level || "").toLowerCase() !== level)
        return false;
    if (!query)
        return true;
    const normalizedQuery = String(query).toLowerCase();
    const argsText = JSON.stringify(event?.args || []).slice(0, 20_000);
    const haystack = [event?.kind, event?.level, event?.text, event?.url, argsText]
        .filter((value) => value != null)
        .join(" ")
        .toLowerCase();
    return haystack.includes(normalizedQuery);
}
function normalizeNetworkFilters({ urlContains = null, method = null, status = null, resourceType = null } = {}) {
    const normalizedMethod = method == null || method === "" ? null : String(method).trim().toUpperCase();
    if (normalizedMethod && !/^[A-Z]{1,16}$/.test(normalizedMethod))
        throw new Error("Network method filter must contain 1-16 ASCII letters.");
    let normalizedStatus = null;
    if (status != null) {
        normalizedStatus = Number(status);
        if (!Number.isInteger(normalizedStatus) || normalizedStatus < 100 || normalizedStatus > 599) {
            throw new Error("Network status filter must be an integer between 100 and 599.");
        }
    }
    const normalizedResourceType = resourceType == null || resourceType === ""
        ? null
        : String(resourceType).trim().toLowerCase();
    if (normalizedResourceType && !NETWORK_RESOURCE_TYPE_FILTERS.has(normalizedResourceType)) {
        throw new Error(`Unsupported network resource type filter: ${String(resourceType)}`);
    }
    const normalizedUrl = urlContains == null || urlContains === "" ? null : String(urlContains).slice(0, 4_000);
    return {
        urlContains: normalizedUrl,
        method: normalizedMethod,
        status: normalizedStatus,
        resourceType: normalizedResourceType,
    };
}
function networkEventMatches(event, filters = {}) {
    if (filters.urlContains && !String(event?.url || "").includes(filters.urlContains))
        return false;
    if (filters.method && String(event?.method || "").toUpperCase() !== filters.method)
        return false;
    if (filters.status != null && Number(event?.status) !== filters.status)
        return false;
    if (filters.resourceType && String(event?.type || "").toLowerCase() !== filters.resourceType)
        return false;
    return true;
}
function addNetworkResponseWaitState(tabId, state) {
    let waiters = networkResponseWaitStates.get(tabId);
    if (!waiters) {
        waiters = new Set();
        networkResponseWaitStates.set(tabId, waiters);
    }
    waiters.add(state);
}
function removeNetworkResponseWaitState(tabId, state) {
    const waiters = networkResponseWaitStates.get(tabId);
    if (!waiters)
        return;
    waiters.delete(state);
    if (waiters.size === 0)
        networkResponseWaitStates.delete(tabId);
}
// Narrow, runtime-checked CDP result boundaries. Do not claim that the
// generic chrome.debugger.sendCommand() response has one universal shape.
function cdpObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value : null;
}
function isCdpAxValue(value) {
    return cdpObject(value) !== null;
}
function isCdpAxNode(value) {
    const node = cdpObject(value);
    if (!node || typeof node.nodeId !== "string")
        return false;
    if (node.parentId != null && typeof node.parentId !== "string")
        return false;
    if (node.childIds != null && (!Array.isArray(node.childIds) || !node.childIds.every((id) => typeof id === "string")))
        return false;
    if (node.backendDOMNodeId != null && (typeof node.backendDOMNodeId !== "number" || !Number.isSafeInteger(node.backendDOMNodeId)))
        return false;
    for (const field of ["role", "name", "description"]) {
        if (node[field] != null) {
            const text = cdpObject(node[field]);
            if (!text || (text.value != null && typeof text.value !== "string"))
                return false;
        }
    }
    if (node.value != null && !isCdpAxValue(node.value))
        return false;
    if (node.ignored != null && typeof node.ignored !== "boolean")
        return false;
    if (node.properties != null && (!Array.isArray(node.properties)
        || !node.properties.every((property) => {
            const item = cdpObject(property);
            return item !== null && typeof item.name === "string"
                && (item.value == null || isCdpAxValue(item.value));
        })))
        return false;
    return true;
}
function checkedAxTreeResponse(response) {
    const payload = cdpObject(response);
    const nodes = payload?.nodes;
    if (!Array.isArray(nodes) || !nodes.every(isCdpAxNode)) {
        throw new Error("Chrome CDP Accessibility response contains an invalid AX tree.");
    }
    return { nodes };
}
function cdpResolvedObjectId(response) {
    const result = cdpObject(response);
    const object = cdpObject(result?.object);
    return typeof object?.objectId === "string" && object.objectId ? object.objectId : null;
}
// Only these CDP commands are decoded here; unrelated dynamic CDP calls
// retain their original semantics until their own response contracts exist.
function cdpFunctionByValue(response) {
    const payload = cdpObject(response);
    if (payload?.exceptionDetails != null)
        return null;
    const result = cdpObject(payload?.result);
    return result?.value ?? null;
}
function checkedCdpFunctionName(response) {
    const value = cdpObject(cdpFunctionByValue(response));
    if (!value)
        return null;
    const name = String(typeof value.name === "string" ? value.name : "").replace(/\s+/gu, " ").trim().slice(0, 200);
    if (!name)
        return null;
    return { name, source: String(typeof value.source === "string" ? value.source : "nearby_text").slice(0, 40) };
}
function checkedCdpViewportMetrics(response) {
    const payload = cdpObject(response);
    const viewport = cdpObject(payload?.cssLayoutViewport) || cdpObject(payload?.layoutViewport);
    const x = Number(viewport?.pageX ?? 0);
    const y = Number(viewport?.pageY ?? 0);
    const width = Number(viewport?.clientWidth ?? viewport?.width ?? 0);
    const height = Number(viewport?.clientHeight ?? viewport?.height ?? 0);
    return [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0 ? { x, y, width, height } : null;
}
function checkedCdpFrameOwnerId(response) {
    const payload = cdpObject(response);
    const id = Number(payload?.backendNodeId);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}
function checkedCdpElementRect(response) {
    const value = cdpObject(cdpFunctionByValue(response));
    if (!value)
        return null;
    const rect = {
        left: value.left, top: value.top, right: value.right, bottom: value.bottom,
        width: value.width, height: value.height, clientLeft: value.clientLeft,
        clientTop: value.clientTop, offsetWidth: value.offsetWidth, offsetHeight: value.offsetHeight,
    };
    if (!Object.values(rect).every((item) => typeof item === "number" && Number.isFinite(item)))
        return null;
    return rect;
}
function checkedCdpBoxQuad(response) {
    const result = cdpObject(response);
    const model = cdpObject(result?.model);
    const raw = model?.border || model?.content || model?.padding || model?.margin;
    if (!Array.isArray(raw) || raw.length < 8)
        return null;
    const quad = raw.slice(0, 8).map(Number);
    return quad.every(Number.isFinite) ? quad : null;
}
function axProperty(node, name) {
    const prop = (node.properties || []).find((item) => item?.name === name);
    return prop?.value?.value ?? null;
}
function flattenFrameTree(frameTree, route, output = []) {
    const frame = frameTree?.frame;
    if (!frame?.id)
        return output;
    output.push({
        id: frame.id,
        parentId: frame.parentId || null,
        name: frame.name || "",
        url: frame.url || "",
        securityOrigin: frame.securityOrigin || "",
        mimeType: frame.mimeType || "",
        sessionId: route.sessionId || null,
        targetId: route.targetId || null,
        isOopif: Boolean(route.isOopif),
    });
    for (const child of frameTree?.childFrames || [])
        flattenFrameTree(child, route, output);
    return output;
}
async function collectFrameContexts(tabId) {
    await ensureRecursiveFrameRouting(tabId);
    const contexts = new Map();
    const rootTree = await send(tabId, "Page.getFrameTree");
    for (const frame of flattenFrameTree(rootTree?.frameTree, { sessionId: null, targetId: null, isOopif: false })) {
        contexts.set(frame.id, frame);
    }
    const state = attachedTabs.get(tabId);
    for (const session of state?.sessions?.values() || []) {
        if (session.type && session.type !== "iframe")
            continue;
        try {
            await send(tabId, "Page.enable", {}, session.sessionId);
            const childTree = await send(tabId, "Page.getFrameTree", {}, session.sessionId);
            for (const frame of flattenFrameTree(childTree?.frameTree, {
                sessionId: session.sessionId,
                targetId: session.targetId,
                isOopif: true,
            })) {
                const existing = contexts.get(frame.id);
                contexts.set(frame.id, {
                    ...existing,
                    ...frame,
                    parentId: frame.parentId || existing?.parentId || null,
                });
            }
        }
        catch {
            // A child target may disappear between auto-attach and enumeration.
        }
    }
    return [...contexts.values()];
}
async function frameAccessibilityTree(tabId, frame, { rootBackendNodeId = null } = {}) {
    await send(tabId, "Accessibility.enable", {}, frame.sessionId);
    if (Number.isInteger(rootBackendNodeId)) {
        await send(tabId, "DOM.enable", {}, frame.sessionId);
        return checkedAxTreeResponse(await send(tabId, "Accessibility.queryAXTree", {
            backendNodeId: rootBackendNodeId,
        }, frame.sessionId));
    }
    try {
        return checkedAxTreeResponse(await send(tabId, "Accessibility.getFullAXTree", { frameId: frame.id }, frame.sessionId));
    }
    catch (error) {
        if (!frame.sessionId || (frame.targetId && frame.targetId !== frame.id))
            throw error;
        return checkedAxTreeResponse(await send(tabId, "Accessibility.getFullAXTree", {}, frame.sessionId));
    }
}
function normalizeSnapshotMode(mode, includeReadable) {
    if (mode == null || mode === "")
        return includeReadable === false ? "interactive" : "balanced";
    const normalized = String(mode).toLowerCase();
    if (normalized !== "interactive" && normalized !== "readable" && normalized !== "balanced") {
        throw new Error(`Unsupported snapshot mode: ${String(mode)}`);
    }
    return normalized;
}
function normalizeSnapshotScope(scope) {
    const normalized = String(scope || "document").toLowerCase();
    if (normalized !== "document" && normalized !== "viewport") {
        throw new Error(`Unsupported snapshot scope: ${String(scope)}`);
    }
    return normalized;
}
function isMailSurfaceUrl(rawUrl) {
    try {
        const parsed = new URL(String(rawUrl || ""));
        const host = parsed.hostname.toLowerCase();
        return (host === "mail.google.com" ||
            host === "mail.yahoo.com" ||
            host === "outlook.live.com" ||
            host === "outlook.office.com" ||
            host.endsWith(".proton.me") ||
            host.endsWith(".protonmail.com"));
    }
    catch {
        return false;
    }
}
const AUTH_CODE_LABEL_PATTERN = /(?:otp|2fa(?: code)?|two[- ]factor(?: authentication)? code|one[- ]time(?: password| code)?|verification code|security code|recovery code|account recovery code|backup code|login code|authentication code|confirmation code|passcode|doğrulama kodu(?:nuz(?:dur)?)?|kurtarma kodu|hesap kurtarma kodu|yedek kodu|giriş kodu|kimlik doğrulama kodu|onay kodu|tek kullanımlık(?: şifre| kod)?|tek seferlik(?: doğrulama)?(?: şifre| kodu?(?:nuz(?:dur)?)?)?)/giu;
const AUTH_CODE_TOKEN_PATTERN = /\b(?:\d{4,8}|\d{2,4}[ -]\d{2,4})\b/gu;
function redactContextualAuthCodes(rawValue) {
    const value = String(rawValue || "");
    const labels = [...value.matchAll(AUTH_CODE_LABEL_PATTERN)].map((match) => ({
        start: match.index ?? 0,
        end: (match.index ?? 0) + match[0].length,
    }));
    if (labels.length === 0)
        return value;
    return value.replace(AUTH_CODE_TOKEN_PATTERN, (candidate, offset) => {
        const start = Number(offset) || 0;
        const end = start + candidate.length;
        const digits = candidate.replace(/\D/gu, "");
        if (digits.length < 4 || digits.length > 8)
            return candidate;
        const contextual = labels.some((label) => ((end <= label.start && label.start - end <= 96) ||
            (start >= label.end && start - label.end <= 48)));
        return contextual ? "[REDACTED CODE]" : candidate;
    });
}
function redactSensitiveSnapshotText(rawValue) {
    if (rawValue == null)
        return { value: rawValue, redacted: false };
    let value = String(rawValue).replace(/\s+/gu, " ").trim().slice(0, 4_000);
    const original = value;
    if (!value)
        return { value, redacted: false };
    try {
        if (/^https?:\/\//iu.test(value))
            value = safeObservedUrl(value);
    }
    catch {
        // Keep the bounded text and continue with token masking.
    }
    value = redactContextualAuthCodes(value)
        .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{8,}\b/giu, "$1[REDACTED]")
        .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED]")
        .replace(/\b(?:api[ _-]?key|secret|token|session|authorization|password|passwd)\s*[:=]\s*[^\s,;]{6,}/giu, (match) => {
        const separator = match.search(/[:=]/u);
        return separator >= 0 ? `${match.slice(0, separator + 1)}[REDACTED]` : "[REDACTED]";
    })
        .replace(/\b[a-f0-9]{40,}\b/giu, "[REDACTED]")
        .replace(/\b[A-Za-z0-9_\-+/]{48,}={0,2}\b/gu, "[REDACTED]");
    return { value: value.slice(0, 4_000), redacted: value !== original };
}
function isAuxiliaryFrame(frame) {
    const rawUrl = String(frame?.url || "");
    const haystack = `${frame?.name || ""} ${rawUrl}`.toLowerCase();
    if (/(doubleclick|googlesyndication|googleadservices|adservice|adsystem|pagead|analytics|tagmanager|scorecardresearch|quantserve)/u.test(haystack)) {
        return true;
    }
    try {
        const parsed = new URL(rawUrl);
        const host = parsed.hostname.toLowerCase();
        if (host === "ogs.google.com" && /^\/(?:u\/\d+\/)?widget\/app(?:\/|$)/u.test(parsed.pathname))
            return true;
        if (host === "accounts.google.com" && parsed.pathname === "/RotateCookiesPage")
            return true;
    }
    catch {
        // Non-URL frame metadata falls back to the bounded name/url classifier above.
    }
    return false;
}
function snapshotFrameRelevance(frame, mainFrameId, pageKind) {
    let score = frame?.id === mainFrameId ? 100 : frame?.isOopif ? 60 : 75;
    if (frame?.parentId === mainFrameId)
        score += 5;
    if (isAuxiliaryFrame(frame))
        score -= 120;
    if (pageKind === "chrome-pdf-viewer") {
        const isViewerFrame = String(frame?.url || "").startsWith(`chrome-extension://${CHROME_PDF_VIEWER_EXTENSION_ID}/`);
        if (isViewerFrame)
            score += 240;
        else if (frame?.mimeType === "application/pdf")
            score += 80;
    }
    return score;
}
function selectSnapshotFrames(frames, { mainFrameId, pageKind, rootTarget = null, mainFrameOnly = false, excludeAuxiliaryFrames = false, activeLayerOnly = false, frameId = null, } = {}) {
    if (rootTarget) {
        return frames.filter((frame) => (frame.id === rootTarget.frameId &&
            (frame.sessionId || null) === (rootTarget.sessionId || null)));
    }
    const selectorCount = [Boolean(mainFrameOnly), Boolean(activeLayerOnly), Boolean(frameId)].filter(Boolean).length;
    if (selectorCount > 1)
        throw new Error("main_frame_only, active_layer_only and frame_id are mutually exclusive.");
    let selected = [...frames];
    if (frameId) {
        selected = selected.filter((frame) => frame.id === String(frameId));
        if (selected.length === 0)
            throw new Error(`Snapshot frame_id is unavailable: ${String(frameId)}`);
    }
    else if (mainFrameOnly) {
        selected = selected.filter((frame) => frame.id === mainFrameId);
    }
    else if (activeLayerOnly) {
        const ranked = selected
            .map((frame) => ({ frame, score: snapshotFrameRelevance(frame, mainFrameId, pageKind || "") }))
            .sort((a, b) => b.score - a.score);
        selected = ranked.length ? [ranked[0].frame] : [];
    }
    if (excludeAuxiliaryFrames)
        selected = selected.filter((frame) => !isAuxiliaryFrame(frame));
    return selected;
}
async function fallbackInteractiveName(tabId, frame, backendNodeId) {
    if (!Number.isInteger(backendNodeId))
        return null;
    let objectId = null;
    try {
        const resolved = await send(tabId, "DOM.resolveNode", { backendNodeId }, frame.sessionId);
        objectId = cdpResolvedObjectId(resolved);
        if (!objectId)
            return null;
        const result = await send(tabId, "Runtime.callFunctionOn", {
            objectId,
            returnByValue: true,
            functionDeclaration: `function() {
        const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim().slice(0, 200);
        const direct = [
          ["aria-label", this.getAttribute && this.getAttribute("aria-label")],
          ["title", this.getAttribute && this.getAttribute("title")],
          ["alt", this.getAttribute && this.getAttribute("alt")],
        ];
        for (const [source, raw] of direct) {
          const name = clean(raw);
          if (name) return { name, source };
        }
        const labelledBy = this.getAttribute && clean(this.getAttribute("aria-labelledby"));
        if (labelledBy) {
          const names = labelledBy.split(/\\s+/).slice(0, 4).map((id) => clean(document.getElementById(id)?.innerText || document.getElementById(id)?.textContent)).filter(Boolean);
          if (names.length) return { name: clean(names.join(" ")), source: "nearby_text" };
        }
        const candidates = [
          this.innerText,
          this.textContent,
          this.closest && this.closest("label")?.innerText,
          this.previousElementSibling?.innerText,
          this.nextElementSibling?.innerText,
        ];
        for (const raw of candidates) {
          const name = clean(raw);
          if (name) return { name, source: "nearby_text" };
        }
        return null;
      }`,
        }, frame.sessionId);
        return checkedCdpFunctionName(result);
    }
    catch {
        return null;
    }
    finally {
        if (objectId)
            await send(tabId, "Runtime.releaseObject", { objectId }, frame.sessionId).catch(() => { });
    }
}
function nearestSemanticAncestor(node, index, roles = SEMANTIC_CONTAINER_ROLES) {
    if (node?.nodeId == null)
        return null;
    let currentId = index.parentById.get(String(node.nodeId)) || null;
    let depth = 0;
    while (currentId && depth < 12) {
        const ancestor = index.byId.get(currentId);
        if (!ancestor)
            return null;
        const role = normalizedIdentityText(ancestor?.role?.value, 40);
        if (roles.has(role))
            return ancestor;
        currentId = index.parentById.get(currentId) || null;
        depth += 1;
    }
    return null;
}
function coalesceReadableInlineElements(elements) {
    const output = [];
    for (const element of elements) {
        const previous = output.at(-1);
        const eligible = !element.ref && element.role === "StaticText" && element.name && String(element.name).length <= 120;
        const previousEligible = previous && !previous.ref && previous.role === "StaticText" && previous.name && String(previous.name).length <= 220;
        if (eligible && previousEligible &&
            element.frameId === previous.frameId &&
            element.axParentId && element.axParentId === previous.axParentId &&
            Number(element.axOrder) === Number(previous.axOrder) + 1 &&
            (previous.coalescedInlineCount || 1) < 4) {
            previous.name = `${previous.name} ${element.name}`.replace(/\s+/gu, " ").trim().slice(0, 320);
            previous.coalescedInlineCount = (previous.coalescedInlineCount || 1) + 1;
            previous.axOrder = element.axOrder;
            continue;
        }
        output.push({ ...element });
    }
    return output;
}
function dedupeReadableSnapshotElements(elements) {
    const seen = new Set();
    return elements.filter((element) => {
        if (element.ref)
            return true;
        const key = JSON.stringify([element.frameId, element.role, element.name, element.value]);
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
}
function normalizeSnapshotRoles(roles) {
    if (!Array.isArray(roles) || roles.length === 0)
        return null;
    return new Set(roles
        .map((role) => String(role || "").trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 50));
}
async function frameViewport(tabId, frame) {
    const metrics = await send(tabId, "Page.getLayoutMetrics", {}, frame.sessionId);
    return checkedCdpViewportMetrics(metrics);
}
async function backendNodeBounds(tabId, frame, backendNodeId) {
    if (!Number.isInteger(backendNodeId))
        return null;
    try {
        const result = await send(tabId, "DOM.getBoxModel", { backendNodeId }, frame.sessionId);
        const quad = checkedCdpBoxQuad(result);
        if (!quad)
            return null;
        const xs = [quad[0], quad[2], quad[4], quad[6]].map(Number);
        const ys = [quad[1], quad[3], quad[5], quad[7]].map(Number);
        if (![...xs, ...ys].every(Number.isFinite))
            return null;
        return {
            left: Math.min(...xs),
            top: Math.min(...ys),
            right: Math.max(...xs),
            bottom: Math.max(...ys),
        };
    }
    catch {
        return null;
    }
}
async function elementViewportRect(tabId, sessionId, backendNodeId) {
    if (!Number.isInteger(backendNodeId))
        return null;
    let objectId = null;
    try {
        const resolved = await send(tabId, "DOM.resolveNode", { backendNodeId }, sessionId);
        objectId = cdpResolvedObjectId(resolved);
        if (!objectId)
            return null;
        const evaluated = await send(tabId, "Runtime.callFunctionOn", {
            objectId,
            functionDeclaration: `function() {
        const __equinoxFrameRect = true;
        if (typeof this.getBoundingClientRect !== 'function') return null;
        const rect = this.getBoundingClientRect();
        const width = Number(rect.width);
        const height = Number(rect.height);
        if (![rect.left, rect.top, rect.right, rect.bottom, width, height].every(Number.isFinite)) return null;
        return {
          left: Number(rect.left), top: Number(rect.top), right: Number(rect.right), bottom: Number(rect.bottom),
          width, height, clientLeft: Number(this.clientLeft || 0), clientTop: Number(this.clientTop || 0),
          offsetWidth: Number(this.offsetWidth || width || 1), offsetHeight: Number(this.offsetHeight || height || 1),
        };
      }`,
            returnByValue: true,
            silent: true,
        }, sessionId);
        return checkedCdpElementRect(evaluated);
    }
    catch {
        return null;
    }
    finally {
        if (objectId)
            await send(tabId, "Runtime.releaseObject", { objectId }, sessionId).catch(() => { });
    }
}
async function frameOwnerViewportTransform(tabId, childFrame, parentFrame) {
    try {
        await send(tabId, "DOM.enable", {}, parentFrame.sessionId);
        const owner = await send(tabId, "DOM.getFrameOwner", { frameId: childFrame.id }, parentFrame.sessionId);
        const backendNodeId = checkedCdpFrameOwnerId(owner);
        if (backendNodeId === null)
            return null;
        const rect = await elementViewportRect(tabId, parentFrame.sessionId, backendNodeId);
        if (!rect)
            return null;
        const scaleX = rect.offsetWidth > 0 ? rect.width / rect.offsetWidth : 1;
        const scaleY = rect.offsetHeight > 0 ? rect.height / rect.offsetHeight : 1;
        return {
            x: rect.left + rect.clientLeft * scaleX,
            y: rect.top + rect.clientTop * scaleY,
            scaleX: Number.isFinite(scaleX) && scaleX > 0 ? scaleX : 1,
            scaleY: Number.isFinite(scaleY) && scaleY > 0 ? scaleY : 1,
        };
    }
    catch {
        return null;
    }
}
async function rootPageBoundsForTarget(tabId, target, frameContexts = null) {
    const local = await elementViewportRect(tabId, target.sessionId || null, target.backendNodeId);
    if (!local)
        return null;
    let bounds = { left: local.left, top: local.top, right: local.right, bottom: local.bottom };
    const frames = frameContexts || await collectFrameContexts(tabId);
    let frame = frames.find((item) => (item.id === target.frameId && (item.sessionId || null) === (target.sessionId || null))) || frames.find((item) => item.id === target.frameId);
    const seen = new Set();
    while (frame?.parentId) {
        if (seen.has(frame.id))
            return null;
        seen.add(frame.id);
        const parentId = frame.parentId;
        const parent = frames.find((item) => item.id === parentId);
        if (!parent)
            return null;
        const transform = await frameOwnerViewportTransform(tabId, frame, parent);
        if (!transform)
            return null;
        bounds = {
            left: transform.x + bounds.left * transform.scaleX,
            top: transform.y + bounds.top * transform.scaleY,
            right: transform.x + bounds.right * transform.scaleX,
            bottom: transform.y + bounds.bottom * transform.scaleY,
        };
        frame = parent;
    }
    const scroll = await send(tabId, "Runtime.evaluate", {
        expression: "({x:Number(window.scrollX||0),y:Number(window.scrollY||0)})",
        returnByValue: true,
        silent: true,
    }).catch(() => null);
    const scrollValue = cdpObject(scroll?.result?.value) || {};
    const scrollX = Number(scrollValue.x) || 0;
    const scrollY = Number(scrollValue.y) || 0;
    return {
        left: bounds.left + scrollX,
        top: bounds.top + scrollY,
        right: bounds.right + scrollX,
        bottom: bounds.bottom + scrollY,
    };
}
function boundsIntersectViewport(bounds, viewport) {
    if (!bounds || !viewport)
        return false;
    return !(bounds.right <= viewport.x ||
        bounds.left >= viewport.x + viewport.width ||
        bounds.bottom <= viewport.y ||
        bounds.top >= viewport.y + viewport.height);
}
function rememberSnapshotState(tabId, state) {
    if (!Number.isInteger(tabId) || !state?.id)
        return;
    const history = snapshotHistories.get(tabId) || [];
    history.push(state);
    if (history.length > MAX_SNAPSHOT_HISTORY)
        history.splice(0, history.length - MAX_SNAPSHOT_HISTORY);
    snapshotHistories.set(tabId, history);
}
function snapshotStateById(tabId, snapshotId) {
    const history = snapshotHistories.get(tabId) || [];
    return history.find((item) => item.id === snapshotId) || null;
}
function normalizedIdentityText(value, maxChars = 160) {
    return String(value ?? "")
        .replace(/\s+/gu, " ")
        .trim()
        .toLowerCase()
        .slice(0, Math.max(1, maxChars));
}
function usefulSemanticContextText(value, targetName = "") {
    const text = normalizedIdentityText(value, 96);
    if (!text || text === normalizedIdentityText(targetName, 96))
        return null;
    if (/^[\d\s.,:%+()\/-]{1,24}$/u.test(text))
        return null;
    if (/^\d+\s*(?:s|m|h|d|w|mo|y|sec|secs|min|mins|hr|hrs|day|days|week|weeks|month|months|year|years)$/iu.test(text))
        return null;
    return text;
}
function usefulSemanticContextDisplayText(value, targetName = "") {
    const display = String(value ?? "").replace(/\s+/gu, " ").trim().slice(0, 96);
    return usefulSemanticContextText(display, targetName) ? display : null;
}
function buildAxTreeIndex(nodes) {
    const byId = new Map();
    const parentById = new Map();
    for (const node of nodes || []) {
        if (node?.nodeId == null)
            continue;
        byId.set(String(node.nodeId), node);
        if (node.parentId != null)
            parentById.set(String(node.nodeId), String(node.parentId));
    }
    for (const node of nodes || []) {
        if (node?.nodeId == null || !Array.isArray(node.childIds))
            continue;
        const parentId = String(node.nodeId);
        for (const childId of node.childIds) {
            const key = String(childId);
            if (!parentById.has(key))
                parentById.set(key, parentId);
        }
    }
    return { byId, parentById };
}
function boundedSemanticContainerSummary(container, index, targetNode, { maxParts = 6, maxChars = 320 } = {}) {
    const parts = [];
    const seen = new Set();
    const targetId = targetNode?.nodeId == null ? null : String(targetNode.nodeId);
    const targetName = targetNode?.name?.value || "";
    const queue = [...(container?.childIds || [])].map(String);
    const visited = new Set();
    while (queue.length > 0 && parts.length < maxParts && visited.size < 80) {
        const nodeId = queue.shift();
        if (nodeId === undefined || visited.has(nodeId))
            continue;
        visited.add(nodeId);
        const node = index.byId.get(nodeId);
        if (!node)
            continue;
        if (nodeId !== targetId) {
            const role = normalizedIdentityText(node?.role?.value, 40);
            const name = usefulSemanticContextDisplayText(node?.name?.value, targetName);
            if (name && SEMANTIC_CONTEXT_TEXT_ROLES.has(role) && !seen.has(name)) {
                seen.add(name);
                parts.push(name);
            }
        }
        for (const childId of node.childIds || [])
            queue.push(String(childId));
    }
    if (parts.length === 0) {
        const ownName = normalizedIdentityText(container?.name?.value, 200);
        if (ownName)
            parts.push(ownName);
    }
    return parts.join(" | ").slice(0, maxChars);
}
function semanticContainerIdentity(node, index) {
    if (node?.nodeId == null)
        return null;
    let currentId = index.parentById.get(String(node.nodeId)) || null;
    let depth = 0;
    while (currentId && depth < 10) {
        const ancestor = index.byId.get(currentId);
        if (!ancestor)
            break;
        const role = normalizedIdentityText(ancestor?.role?.value, 40);
        if (SEMANTIC_CONTAINER_ROLES.has(role)) {
            const summary = boundedSemanticContainerSummary(ancestor, index, node);
            if (summary)
                return `${role}:${normalizedIdentityText(summary, 320)}`;
        }
        currentId = index.parentById.get(currentId) || null;
        depth += 1;
    }
    return null;
}
function semanticInteractiveIdentity(frame, node, index, nameOverride = null) {
    const container = semanticContainerIdentity(node, index);
    if (!container)
        return null;
    const role = normalizedIdentityText(node?.role?.value, 40);
    const name = normalizedIdentityText(nameOverride ?? node?.name?.value, 160);
    if (!role || !name)
        return null;
    return `semantic:${frame.sessionId || "root"}:${frame.id}:${container}:${role}:${name}`;
}
function refRegistryForGeneration(tabId, generation) {
    let registry = refRegistries.get(tabId);
    if (!registry || registry.documentGeneration !== generation) {
        registry = {
            documentGeneration: generation,
            nextRefIndex: 1,
            nextContainerRefIndex: 1,
            byIdentity: new Map(),
            byContainerIdentity: new Map(),
        };
        refRegistries.set(tabId, registry);
    }
    if (!Number.isInteger(registry.nextContainerRefIndex))
        registry.nextContainerRefIndex = 1;
    if (!(registry.byContainerIdentity instanceof Map))
        registry.byContainerIdentity = new Map();
    return registry;
}
function stableRefForIdentity(tabId, generation, identity) {
    const registry = refRegistryForGeneration(tabId, generation);
    const existing = registry.byIdentity.get(identity);
    if (existing)
        return existing;
    const ref = `@e${registry.nextRefIndex++}`;
    registry.byIdentity.set(identity, ref);
    while (registry.byIdentity.size > MAX_REF_REGISTRY_ENTRIES) {
        const oldest = registry.byIdentity.keys().next().value;
        if (oldest == null)
            break;
        registry.byIdentity.delete(oldest);
    }
    return ref;
}
function stableContainerRefForIdentity(tabId, generation, identity) {
    const registry = refRegistryForGeneration(tabId, generation);
    const existing = registry.byContainerIdentity.get(identity);
    if (existing)
        return existing;
    const ref = `@c${registry.nextContainerRefIndex++}`;
    registry.byContainerIdentity.set(identity, ref);
    while (registry.byContainerIdentity.size > MAX_REF_REGISTRY_ENTRIES) {
        const oldest = registry.byContainerIdentity.keys().next().value;
        if (oldest == null)
            break;
        registry.byContainerIdentity.delete(oldest);
    }
    return ref;
}
function publicSnapshotElement(element) {
    const { backendNodeId: _backendNodeId, identity: _identity, axParentId: _axParentId, axOrder: _axOrder, ...publicElement } = element;
    return publicElement;
}
function snapshotElementSignature(element) {
    const { ref: _ref, ...comparable } = publicSnapshotElement(element);
    return JSON.stringify(comparable);
}
function snapshotFilterSignature(filters) {
    return JSON.stringify({
        mode: filters?.mode || "balanced",
        scope: filters?.scope || "document",
        maxNodes: Number(filters?.maxNodes) || MAX_SNAPSHOT_ELEMENTS,
        rootRef: filters?.rootRef || null,
        roles: Array.isArray(filters?.roles) ? [...filters.roles].sort() : null,
        query: filters?.query || null,
        mainFrameOnly: Boolean(filters?.mainFrameOnly),
        excludeAuxiliaryFrames: Boolean(filters?.excludeAuxiliaryFrames),
        activeLayerOnly: Boolean(filters?.activeLayerOnly),
        frameId: filters?.frameId || null,
        pruneUnnamedRefs: Boolean(filters?.pruneUnnamedRefs),
        sensitiveText: filters?.sensitiveText === "redact" ? "redact" : "allow",
    });
}
function buildSnapshotDelta(base, currentElements, snapshotId, currentDocumentGeneration) {
    const baseElements = Array.isArray(base?.elements) ? base.elements : [];
    const resetDelta = (reason, details = {}) => ({
        version: DELTA_SNAPSHOT_VERSION,
        baseSnapshotId: base?.id || null,
        snapshotId,
        deltaMode: "reset",
        reset: true,
        reason,
        fullReplacement: true,
        added: [],
        removed: [],
        changed: [],
        retainedRefs: [],
        retainedCount: 0,
        retentionRatio: 0,
        ...details,
    });
    if (Number.isInteger(base?.documentGeneration) && base.documentGeneration !== currentDocumentGeneration) {
        return resetDelta("document_generation_changed", {
            baseDocumentGeneration: base.documentGeneration,
            documentGeneration: currentDocumentGeneration,
        });
    }
    const baseByIdentity = new Map(baseElements.map((element) => [element.identity, element]));
    const currentByIdentity = new Map(currentElements.map((element) => [element.identity, element]));
    const added = [];
    const removed = [];
    const changed = [];
    const retainedRefs = [];
    for (const current of currentElements) {
        const previous = baseByIdentity.get(current.identity);
        if (!previous) {
            added.push(publicSnapshotElement(current));
            continue;
        }
        if (current.ref)
            retainedRefs.push(current.ref);
        if (snapshotElementSignature(previous) !== snapshotElementSignature(current)) {
            changed.push({
                ref: current.ref || null,
                before: publicSnapshotElement(previous),
                after: publicSnapshotElement(current),
            });
        }
    }
    for (const previous of baseElements) {
        if (currentByIdentity.has(previous.identity))
            continue;
        const publicPrevious = publicSnapshotElement(previous);
        removed.push({
            ...publicPrevious,
            previousRef: publicPrevious.ref || null,
            ref: null,
        });
    }
    const baseRefCount = baseElements.filter((element) => Boolean(element.ref)).length;
    const currentRefCount = currentElements.filter((element) => Boolean(element.ref)).length;
    const comparableRefCount = Math.min(baseRefCount, currentRefCount);
    const retentionRatio = comparableRefCount > 0 ? retainedRefs.length / comparableRefCount : 1;
    if (comparableRefCount > 0 && (retainedRefs.length === 0 || (comparableRefCount >= 8 && retentionRatio < 0.1))) {
        return resetDelta("low_ref_retention", {
            baseRefCount,
            currentRefCount,
            comparableRefCount,
            retentionRatio,
        });
    }
    return {
        version: DELTA_SNAPSHOT_VERSION,
        baseSnapshotId: base.id,
        snapshotId,
        deltaMode: "incremental",
        reset: false,
        fullReplacement: false,
        added,
        removed,
        changed,
        retainedRefs,
        retainedCount: retainedRefs.length,
        retentionRatio,
    };
}
async function semanticProjectionState(tabId, { query = "", roles = null, minNodes = 1 } = {}) {
    const queryNeedle = String(query || "").trim().toLowerCase();
    const roleFilter = Array.isArray(roles) && roles.length
        ? new Set(roles.map((role) => String(role).trim().toLowerCase()).filter(Boolean))
        : null;
    const minimum = Math.max(1, Math.min(Math.floor(Number(minNodes) || 1), MAX_SNAPSHOT_ELEMENTS));
    const frames = await collectFrameContexts(tabId);
    const semanticRows = [];
    for (const frame of frames) {
        let tree;
        try {
            tree = await frameAccessibilityTree(tabId, frame);
        }
        catch {
            continue;
        }
        for (const node of tree?.nodes || []) {
            if (node?.ignored)
                continue;
            const role = String(node?.role?.value || "");
            const name = String(node?.name?.value || "");
            const value = node?.value?.value == null ? "" : String(node.value.value);
            const meaningful = INTERACTIVE_ROLES.has(role) || (READABLE_ROLES.has(role) && Boolean(name));
            if (!meaningful)
                continue;
            if (roleFilter && !roleFilter.has(role.toLowerCase()))
                continue;
            if (queryNeedle && ![role, name, value].some((part) => part.toLowerCase().includes(queryNeedle)))
                continue;
            semanticRows.push(`${frame.id}|${role}|${name}|${value}`);
            if (semanticRows.length >= MAX_SNAPSHOT_ELEMENTS)
                break;
        }
        if (semanticRows.length >= MAX_SNAPSHOT_ELEMENTS)
            break;
    }
    return {
        nodeCount: semanticRows.length,
        minNodes: minimum,
        matched: semanticRows.length >= minimum,
        signature: JSON.stringify(semanticRows),
    };
}
function mutationTrackerExpression() {
    return `(() => {
    const key = '__equinox_browser_mutation_tracker__';
    const ignoredHostIds = [
      ${JSON.stringify(AGENT_CURSOR_HOST_ID)},
      ${JSON.stringify(SCREENSHOT_ANNOTATION_HOST_ID)},
    ];
    if (!window[key]) {
      const state = { count: 0 };
      const isIgnoredNode = (node) => {
        if (!node) return false;
        const element = node.nodeType === 1 ? node : node.parentElement;
        if (!element) return false;
        return ignoredHostIds.some((hostId) => (
          element.id === hostId || Boolean(element.closest?.('#' + hostId))
        ));
      };
      const observer = new MutationObserver((records) => {
        const meaningful = records.some((record) => {
          if (isIgnoredNode(record.target)) return false;
          if (record.type === 'childList') {
            const changed = [...record.addedNodes, ...record.removedNodes];
            if (changed.length > 0 && changed.every((node) => isIgnoredNode(node))) return false;
          }
          return true;
        });
        if (meaningful) state.count += 1;
      });
      observer.observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      Object.defineProperty(window, key, { value: state, configurable: true });
    }
    return Number(window[key].count) || 0;
  })()`;
}
async function domMutationCounter(tabId) {
    const evaluated = await send(tabId, "Runtime.evaluate", {
        expression: mutationTrackerExpression(),
        returnByValue: true,
    });
    const value = Number(evaluated?.result?.value);
    return Number.isFinite(value) && value >= 0 ? value : 0;
}
async function inspectLiveRef(tabId, ref) {
    const target = lookupRef(tabId, ref);
    let objectId = null;
    try {
        const resolved = await send(tabId, "DOM.resolveNode", { backendNodeId: target.backendNodeId }, target.sessionId);
        objectId = cdpResolvedObjectId(resolved);
        if (!objectId)
            return { exists: false, visible: false, enabled: false };
        const evaluated = await send(tabId, "Runtime.callFunctionOn", {
            objectId,
            functionDeclaration: `function() {
        const exists = this.isConnected !== false;
        if (!exists) return { exists: false, visible: false, enabled: false };
        const style = globalThis.getComputedStyle ? getComputedStyle(this) : null;
        const rect = typeof this.getBoundingClientRect === 'function' ? this.getBoundingClientRect() : null;
        const hasBox = !rect || (Number(rect.width) > 0 && Number(rect.height) > 0);
        const visible = Boolean(
          hasBox &&
          (!style || (style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse' && Number(style.opacity || 1) > 0))
        );
        const disabled = Boolean(this.disabled) || this.getAttribute?.('aria-disabled') === 'true';
        return { exists: true, visible, enabled: !disabled };
      }`,
            returnByValue: true,
        }, target.sessionId);
        const value = cdpObject(evaluated?.result?.value) || {};
        return {
            exists: Boolean(value.exists),
            visible: Boolean(value.visible),
            enabled: Boolean(value.enabled),
        };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/No node|Could not find node|Node with given id|Cannot find context|object.*not found/i.test(message)) {
            return { exists: false, visible: false, enabled: false };
        }
        throw error;
    }
    finally {
        if (objectId)
            await send(tabId, "Runtime.releaseObject", { objectId }, target.sessionId).catch(() => { });
    }
}
function publicFrameContext(frame, mainFrameId) {
    return {
        id: frame.id,
        parentId: frame.parentId,
        name: frame.name,
        url: frame.url,
        securityOrigin: frame.securityOrigin,
        mimeType: frame.mimeType,
        kind: frame.id === mainFrameId ? "main" : "iframe",
        process: frame.isOopif ? "oopif" : "same-process",
        sessionScope: frame.sessionId ? "child" : "root",
    };
}
function formatSnapshotLine(element) {
    const parts = [];
    if (element.ref)
        parts.push(element.ref);
    parts.push(element.role || "unknown");
    if (element.name)
        parts.push(JSON.stringify(element.name));
    if (element.value != null && element.value !== "")
        parts.push(`value=${JSON.stringify(String(element.value))}`);
    if (element.disabled === true)
        parts.push("[disabled]");
    if (element.checked != null)
        parts.push(`[checked=${element.checked}]`);
    if (element.selected != null)
        parts.push(`[selected=${element.selected}]`);
    if (element.pressed != null)
        parts.push(`[pressed=${element.pressed}]`);
    if (element.frameId)
        parts.push(`[frame=${element.frameId}]`);
    return parts.join(" ");
}
function pageKindFromFrames(basePolicy, frames) {
    const frameList = Array.isArray(frames) ? frames : [];
    if (frameList.some((frame) => frame?.mimeType === "application/pdf") ||
        frameList.some((frame) => String(frame?.url || "").startsWith(`chrome-extension://${CHROME_PDF_VIEWER_EXTENSION_ID}/`))) {
        return "chrome-pdf-viewer";
    }
    if (frameList.some((frame) => String(frame?.url || "").startsWith("chrome-error://"))) {
        return "browser-owned-error";
    }
    return basePolicy?.kind || "unknown";
}
async function browserPdfData({ tabId } = {}) {
    const tab = await chooseTab(tabId);
    if (typeof tab.id !== "number" || !Number.isSafeInteger(tab.id) || tab.id < 1)
        throw new Error("PDF viewer requires a valid Chrome tab ID.");
    const policy = classifyBrowserPage(tab);
    if (!policy.debuggerSupported)
        throw new Error("PDF data is unavailable on this browser-owned page.");
    await requireDebuggableTab(tab.id);
    await attachTab(tab.id);
    try {
        const frames = await collectFrameContexts(tab.id);
        const pageKind = pageKindFromFrames(policy, frames);
        if (pageKind !== "chrome-pdf-viewer")
            throw new Error("The selected tab is not a Chrome PDF Viewer document.");
        const viewerFrame = frames.find((frame) => (frame?.sessionId &&
            String(frame?.url || "").startsWith(`chrome-extension://${CHROME_PDF_VIEWER_EXTENSION_ID}/`)));
        if (!viewerFrame)
            throw new Error("Chrome PDF Viewer frame is unavailable.");
        const evaluated = await send(tab.id, "Runtime.evaluate", {
            awaitPromise: true,
            returnByValue: true,
            expression: `(async () => {
        const maxBytes = ${MAX_PDF_DOCUMENT_BYTES};
        const viewer = globalThis.viewer || document.getElementById('viewer') || document.querySelector('pdf-viewer');
        const controller = viewer && (viewer.pluginController_ || viewer.pluginController);
        if (!controller || typeof controller.getSaveDataBlock !== 'function') {
          return { unavailable: true, reason: 'plugin_controller_unavailable' };
        }
        const chunks = [];
        let totalFileSize = null;
        let offset = 0;
        let requests = 0;
        while (totalFileSize === null || offset < totalFileSize) {
          if (++requests > 8) return { unavailable: true, reason: 'pdf_block_limit_exceeded' };
          const blockSize = totalFileSize === null ? 0 : Math.min(totalFileSize - offset, 4 * 1024 * 1024);
          const result = await controller.getSaveDataBlock('ORIGINAL', offset, blockSize);
          const reportedTotal = Number(result && result.totalFileSize);
          if (!Number.isInteger(reportedTotal) || reportedTotal < 5) {
            return { unavailable: true, reason: 'pdf_total_size_invalid' };
          }
          if (reportedTotal > maxBytes) return { tooLarge: true, byteLength: reportedTotal };
          if (totalFileSize === null) totalFileSize = reportedTotal;
          else if (reportedTotal !== totalFileSize) return { unavailable: true, reason: 'pdf_total_size_changed' };
          const block = result && result.dataToSave;
          let bytes = null;
          if (block instanceof ArrayBuffer) bytes = new Uint8Array(block);
          else if (ArrayBuffer.isView(block)) bytes = new Uint8Array(block.buffer, block.byteOffset, block.byteLength);
          if (!bytes || bytes.byteLength === 0 || offset + bytes.byteLength > totalFileSize) {
            return { unavailable: true, reason: 'pdf_bytes_unavailable' };
          }
          chunks.push(bytes);
          offset += bytes.byteLength;
        }
        if (offset !== totalFileSize) return { unavailable: true, reason: 'pdf_size_mismatch' };
        const bytes = new Uint8Array(totalFileSize);
        let writeOffset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, writeOffset);
          writeOffset += chunk.byteLength;
        }
        let binary = '';
        const encodeChunkSize = 0x8000;
        for (let index = 0; index < bytes.byteLength; index += encodeChunkSize) {
          binary += String.fromCharCode(...bytes.subarray(index, Math.min(bytes.byteLength, index + encodeChunkSize)));
        }
        return { byteLength: bytes.byteLength, blockCount: requests, data: btoa(binary) };
      })()`,
        }, viewerFrame.sessionId);
        const value = cdpObject(evaluated?.result?.value);
        if (value?.tooLarge) {
            throw new Error(`PDF exceeds the ${MAX_PDF_DOCUMENT_BYTES / 1024 / 1024} MB readable-content limit.`);
        }
        if (value?.unavailable || typeof value?.byteLength !== "number" || !Number.isSafeInteger(value.byteLength) || typeof value?.data !== "string") {
            throw new Error(`Chrome PDF Viewer did not expose readable document bytes${value?.reason ? `: ${value.reason}` : "."}`);
        }
        if (value.byteLength < 5 || value.byteLength > MAX_PDF_DOCUMENT_BYTES) {
            throw new Error(`PDF exceeds the ${MAX_PDF_DOCUMENT_BYTES / 1024 / 1024} MB readable-content limit.`);
        }
        return {
            pdfContentVersion: PDF_CONTENT_VERSION,
            tabId: tab.id,
            byteLength: value.byteLength,
            source: "chrome_pdf_viewer_save_data",
            data: value.data,
        };
    }
    finally {
        scheduleDetach(tab.id);
    }
}
function normalizeSnapshotOutput(output) {
    const value = String(output || "both").toLowerCase();
    if (!new Set(["compact", "structured", "text", "both"]).has(value)) {
        throw new Error(`Unsupported snapshot output mode: ${value}`);
    }
    return value;
}
function projectSnapshotOutput(response, output) {
    const mode = normalizeSnapshotOutput(output);
    if (mode === "both")
        return { ...response, outputMode: mode };
    const common = {
        tab: response.tab,
        snapshotVersion: response.snapshotVersion,
        deltaVersion: response.deltaVersion,
        restricted: response.restricted,
        pageKind: response.pageKind,
        debuggerSupported: response.debuggerSupported,
        ...(response.reason ? { reason: response.reason } : {}),
        ...(response.snapshot ? { snapshot: response.snapshot } : {}),
        ...(Number.isInteger(response.refCount) ? { refCount: response.refCount } : {}),
        ...(Number.isInteger(response.containerRefCount) ? { containerRefCount: response.containerRefCount } : {}),
        ...(response.privacy ? { privacy: response.privacy } : {}),
        ...(Number.isInteger(response.elementCount) ? { elementCount: response.elementCount } : {}),
        ...(Number.isInteger(response.returnedElementCount) ? { returnedElementCount: response.returnedElementCount } : {}),
        ...(typeof response.truncated === "boolean" ? { truncated: response.truncated } : {}),
        ...(typeof response.deltaOnly === "boolean" ? { deltaOnly: response.deltaOnly } : {}),
        ...(Object.hasOwn(response, "currentSnapshotId") ? { currentSnapshotId: response.currentSnapshotId } : {}),
        ...(typeof response.refContextValid === "boolean" ? { refContextValid: response.refContextValid } : {}),
        ...(typeof response.freshSnapshotRequired === "boolean" ? { freshSnapshotRequired: response.freshSnapshotRequired } : {}),
        ...(response.refContextReason ? { refContextReason: response.refContextReason } : {}),
        ...(Number.isInteger(response.currentDocumentGeneration) ? { currentDocumentGeneration: response.currentDocumentGeneration } : {}),
        outputMode: mode,
    };
    if (mode === "compact") {
        if (response.deltaOnly && response.delta)
            return { ...common, delta: response.delta };
        return { ...common, text: response.text || "" };
    }
    if (mode === "text") {
        return {
            tab: response.tab,
            snapshotVersion: response.snapshotVersion,
            restricted: response.restricted,
            pageKind: response.pageKind,
            debuggerSupported: response.debuggerSupported,
            ...(response.reason ? { reason: response.reason } : {}),
            ...(response.snapshot ? { snapshot: response.snapshot } : {}),
            ...(response.privacy ? { privacy: response.privacy } : {}),
            ...(Number.isInteger(response.containerRefCount) ? { containerRefCount: response.containerRefCount } : {}),
            outputMode: mode,
            text: response.text || "",
        };
    }
    return {
        ...common,
        frames: response.frames || [],
        delta: response.delta ?? null,
        elements: response.elements || [],
    };
}
function restrictedSnapshot(tab, policy, output = "both") {
    const response = {
        tab: { id: tab.id, windowId: tab.windowId, title: tab.title, url: tab.url, active: tab.active },
        restricted: true,
        snapshotVersion: SNAPSHOT_VERSION,
        deltaVersion: DELTA_SNAPSHOT_VERSION,
        pageKind: policy?.kind || "unknown",
        debuggerSupported: false,
        reason: policy?.reason || "restricted",
        text: restrictedPageMessage(policy),
        frames: [],
        refCount: 0,
        elementCount: 0,
        elements: [],
    };
    return projectSnapshotOutput(response, output);
}
async function browserSnapshot({ tabId, includeReadable = true, mode, scope = "document", maxNodes = MAX_SNAPSHOT_ELEMENTS, rootRef, roles, query, mainFrameOnly = false, excludeAuxiliaryFrames = false, activeLayerOnly = false, frameId, pruneUnnamedRefs = false, sensitiveText = "allow", sinceSnapshotId, output = "both", } = {}) {
    const snapshotMode = normalizeSnapshotMode(mode, includeReadable);
    const snapshotScope = normalizeSnapshotScope(scope);
    const snapshotOutput = normalizeSnapshotOutput(output);
    const sensitiveTextMode = String(sensitiveText || "allow").toLowerCase();
    if (!new Set(["allow", "redact"]).has(sensitiveTextMode)) {
        throw new Error("sensitiveText must be allow or redact.");
    }
    const privacyRedactionEnabled = sensitiveTextMode === "redact";
    const requestedMaxNodes = Math.max(1, Math.min(Number.isFinite(Number(maxNodes)) ? Math.floor(Number(maxNodes)) : MAX_SNAPSHOT_ELEMENTS, MAX_SNAPSHOT_ELEMENTS));
    const roleFilter = normalizeSnapshotRoles(roles);
    const queryNeedle = String(query || "").trim().toLowerCase();
    if (rootRef && (mainFrameOnly || activeLayerOnly || frameId)) {
        throw new Error("root_ref cannot be combined with main_frame_only, active_layer_only or frame_id.");
    }
    const filters = {
        mode: snapshotMode,
        scope: snapshotScope,
        maxNodes: requestedMaxNodes,
        rootRef: rootRef || null,
        roles: roleFilter ? [...roleFilter].sort() : null,
        query: queryNeedle || null,
        mainFrameOnly: Boolean(mainFrameOnly),
        excludeAuxiliaryFrames: Boolean(excludeAuxiliaryFrames),
        activeLayerOnly: Boolean(activeLayerOnly),
        frameId: frameId ? String(frameId) : null,
        pruneUnnamedRefs: Boolean(pruneUnnamedRefs),
        sensitiveText: sensitiveTextMode,
    };
    const tab = await chooseTab(tabId);
    if (typeof tab.id !== "number" || !Number.isSafeInteger(tab.id) || tab.id < 1) {
        throw new Error("Snapshot requires a valid Chrome tab id.");
    }
    const sourceContext = rootRef ? captureRefContextSource(tab.id) : null;
    const baseSnapshot = sinceSnapshotId
        ? snapshotStateById(tab.id, String(sinceSnapshotId))
        : null;
    if (sinceSnapshotId && !baseSnapshot) {
        throw new Error(`Snapshot id is unavailable or outside the bounded history: ${String(sinceSnapshotId)}`);
    }
    if (baseSnapshot && snapshotFilterSignature(baseSnapshot.filters) !== snapshotFilterSignature(filters)) {
        throw new Error("Delta snapshot filters must match the base snapshot filters exactly.");
    }
    const policy = classifyBrowserPage(tab);
    if (!policy.debuggerSupported)
        return restrictedSnapshot(tab, policy, snapshotOutput);
    await requireDebuggableTab(tab.id);
    try {
        await attachTab(tab.id);
    }
    catch (error) {
        const restrictedError = cdpObject(error);
        if (restrictedError?.code === "EQUINOX_RESTRICTED_PAGE") {
            return restrictedSnapshot(tab, {
                kind: typeof restrictedError.pageKind === "string" ? restrictedError.pageKind : "unknown",
                reason: typeof restrictedError.reason === "string" ? restrictedError.reason : "restricted",
            }, snapshotOutput);
        }
        throw error;
    }
    const rootTarget = rootRef ? lookupScopeRef(tab.id, String(rootRef)) : null;
    const frames = await collectFrameContexts(tab.id);
    const pageKind = pageKindFromFrames(policy, frames);
    if (pageKind === "browser-owned-error") {
        await detachTab(tab.id);
        return restrictedSnapshot(tab, { kind: pageKind, reason: "browser-owned" }, snapshotOutput);
    }
    const generation = currentDocumentGeneration(tab.id);
    const mainFrameId = frames.find((frame) => !frame.parentId && !frame.sessionId)?.id || frames[0]?.id || null;
    const selectedFrames = selectSnapshotFrames(frames, {
        mainFrameId,
        pageKind,
        rootTarget,
        mainFrameOnly,
        excludeAuxiliaryFrames,
        activeLayerOnly,
        frameId,
    });
    if (rootTarget && selectedFrames.length !== 1) {
        throw new Error(`Snapshot root ref frame is unavailable: ${String(rootRef)}`);
    }
    const selectedFrameIds = new Set(selectedFrames.map((frame) => frame.id));
    const refs = new Map();
    const scopeRefs = new Map();
    const elements = [];
    const broadMailSnapshot = privacyRedactionEnabled && isMailSurfaceUrl(tab.url) && !rootRef && !queryNeedle && !roleFilter && !frameId;
    let sensitiveRedactionCount = 0;
    let truncated = false;
    for (const frame of selectedFrames) {
        if (elements.length >= requestedMaxNodes) {
            truncated = true;
            break;
        }
        let tree;
        try {
            tree = await frameAccessibilityTree(tab.id, frame, {
                rootBackendNodeId: rootTarget?.backendNodeId ?? null,
            });
        }
        catch (error) {
            if (rootTarget)
                throw error;
            continue;
        }
        const viewport = snapshotScope === "viewport" ? await frameViewport(tab.id, frame) : null;
        const nodes = tree?.nodes || [];
        const axIndex = buildAxTreeIndex(nodes);
        const fallbackNames = new Map();
        for (let candidateIndex = 0; candidateIndex < nodes.length; candidateIndex += 1) {
            const candidateNode = nodes[candidateIndex];
            const candidateRole = candidateNode?.role?.value || "";
            if (!INTERACTIVE_ROLES.has(candidateRole) || typeof candidateNode?.backendDOMNodeId !== "number" || !Number.isInteger(candidateNode.backendDOMNodeId))
                continue;
            if (String(candidateNode?.name?.value || "").trim())
                continue;
            const fallback = await fallbackInteractiveName(tab.id, frame, candidateNode.backendDOMNodeId);
            if (fallback?.name)
                fallbackNames.set(candidateIndex, fallback);
        }
        const semanticIdentityCounts = new Map();
        const containerIdentityCounts = new Map();
        for (let candidateIndex = 0; candidateIndex < nodes.length; candidateIndex += 1) {
            const candidateNode = nodes[candidateIndex];
            const candidateRole = candidateNode?.role?.value || "";
            const candidateBackendId = candidateNode?.backendDOMNodeId;
            if (INTERACTIVE_ROLES.has(candidateRole) && Number.isInteger(candidateBackendId)) {
                const candidateName = fallbackNames.get(candidateIndex)?.name ?? candidateNode?.name?.value ?? "";
                const candidateIdentity = semanticInteractiveIdentity(frame, candidateNode, axIndex, candidateName);
                if (candidateIdentity)
                    semanticIdentityCounts.set(candidateIdentity, (semanticIdentityCounts.get(candidateIdentity) || 0) + 1);
            }
            const normalizedRole = normalizedIdentityText(candidateRole, 40);
            if (SEMANTIC_CONTAINER_ROLES.has(normalizedRole) && Number.isInteger(candidateBackendId)) {
                const summary = boundedSemanticContainerSummary(candidateNode, axIndex, null, broadMailSnapshot && normalizedRole === "row" ? { maxParts: 2, maxChars: 220 } : { maxParts: 4, maxChars: 260 });
                if (summary) {
                    const identity = `container:${frame.sessionId || "root"}:${frame.id}:${normalizedRole}:${normalizedIdentityText(summary, 260)}`;
                    containerIdentityCounts.set(identity, (containerIdentityCounts.get(identity) || 0) + 1);
                }
            }
        }
        for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
            const node = nodes[nodeIndex];
            if (node?.ignored)
                continue;
            const role = node?.role?.value || "";
            const normalizedRole = normalizedIdentityText(role, 40);
            const backendNodeId = node?.backendDOMNodeId;
            const interactive = INTERACTIVE_ROLES.has(role) && Number.isInteger(backendNodeId);
            const container = SEMANTIC_CONTAINER_ROLES.has(normalizedRole) && Number.isInteger(backendNodeId);
            const fallback = interactive ? fallbackNames.get(nodeIndex) : null;
            let rawName = String(fallback?.name ?? node?.name?.value ?? "");
            const rawValue = node?.value?.value ?? null;
            const readable = READABLE_ROLES.has(role) && Boolean(rawName);
            const mailRowAncestor = broadMailSnapshot && !container ? nearestSemanticAncestor(node, axIndex, new Set(["row"])) : null;
            if (mailRowAncestor && readable && !interactive)
                continue;
            if (broadMailSnapshot && interactive && mailRowAncestor && rawName.length > 80) {
                const compact = rawName.split(/[,|–—]/u).map((part) => part.trim()).find(Boolean);
                rawName = (compact || rawName).slice(0, 80);
            }
            const containerName = container ? boundedSemanticContainerSummary(node, axIndex, null, broadMailSnapshot && normalizedRole === "row" ? { maxParts: 2, maxChars: 220 } : { maxParts: 4, maxChars: 260 }) : "";
            const effectiveRawName = container ? containerName : rawName;
            const containerMatched = container && Boolean(containerName);
            const modeMatched = containerMatched || (snapshotMode !== "readable" && interactive) || (snapshotMode !== "interactive" && readable);
            if (!modeMatched)
                continue;
            if (interactive && pruneUnnamedRefs && !effectiveRawName.trim())
                continue;
            if (roleFilter && !roleFilter.has(String(role).toLowerCase()))
                continue;
            if (queryNeedle) {
                const haystack = [role, effectiveRawName, rawValue].filter((part) => part != null).map((part) => String(part).toLowerCase());
                if (!haystack.some((part) => part.includes(queryNeedle)))
                    continue;
            }
            if (snapshotScope === "viewport") {
                const bounds = await backendNodeBounds(tab.id, frame, backendNodeId);
                if (!boundsIntersectViewport(bounds, viewport))
                    continue;
            }
            if (elements.length >= requestedMaxNodes) {
                truncated = true;
                break;
            }
            const safeName = privacyRedactionEnabled
                ? redactSensitiveSnapshotText(effectiveRawName)
                : { value: effectiveRawName, redacted: false };
            const safeValue = privacyRedactionEnabled
                ? redactSensitiveSnapshotText(rawValue)
                : { value: rawValue, redacted: false };
            if (safeName.redacted)
                sensitiveRedactionCount += 1;
            if (safeValue.redacted)
                sensitiveRedactionCount += 1;
            const name = typeof safeName.value === "string" ? safeName.value : "";
            const value = safeValue.value;
            let identityWithinDocument;
            if (containerMatched) {
                const semanticContainerIdentity = `container:${frame.sessionId || "root"}:${frame.id}:${normalizedRole}:${normalizedIdentityText(containerName, 260)}`;
                identityWithinDocument = containerIdentityCounts.get(semanticContainerIdentity) === 1
                    ? semanticContainerIdentity : `container-dom:${frame.sessionId || "root"}:${frame.id}:${backendNodeId}`;
            }
            else if (interactive) {
                const semanticIdentity = semanticInteractiveIdentity(frame, node, axIndex, effectiveRawName);
                identityWithinDocument = semanticIdentity && semanticIdentityCounts.get(semanticIdentity) === 1
                    ? semanticIdentity : `dom:${frame.sessionId || "root"}:${frame.id}:${backendNodeId}`;
            }
            else {
                identityWithinDocument = `ax:${frame.sessionId || "root"}:${frame.id}:${node?.nodeId || `${nodeIndex}:${role}:${name}:${String(value ?? "")}`}`;
            }
            const element = {
                identity: `${generation}:${identityWithinDocument}`, ref: null, role, name, value,
                frameId: frame.id, frameProcess: frame.isOopif ? "oopif" : "same-process",
                disabled: axProperty(node, "disabled"), checked: axProperty(node, "checked"), selected: axProperty(node, "selected"),
                pressed: axProperty(node, "pressed"), expanded: axProperty(node, "expanded"), required: axProperty(node, "required"), focusable: axProperty(node, "focusable"),
                backendNodeId: interactive || containerMatched ? backendNodeId : null,
                axParentId: node?.parentId == null ? null : String(node.parentId), axOrder: nodeIndex,
                ...(fallback?.source ? { nameSource: fallback.source } : {}),
                ...(containerMatched ? { scopeRef: true, interactive: false } : {}),
                ...(safeName.redacted || safeValue.redacted ? { sensitiveTextRedacted: true } : {}),
                ...(broadMailSnapshot && normalizedRole === "row" && containerMatched ? { privacyMode: "mail_summary" } : {}),
            };
            if (containerMatched) {
                element.ref = stableContainerRefForIdentity(tab.id, generation, identityWithinDocument);
                scopeRefs.set(element.ref, { backendNodeId, role, name, frameId: frame.id, value, sessionId: frame.sessionId,
                    targetId: frame.targetId, documentGeneration: generation, kind: "container" });
            }
            else if (interactive) {
                element.ref = stableRefForIdentity(tab.id, generation, identityWithinDocument);
                refs.set(element.ref, { backendNodeId, role, name, frameId: frame.id, value, sessionId: frame.sessionId,
                    targetId: frame.targetId, documentGeneration: generation, kind: "interactive" });
            }
            elements.push(element);
        }
        if (truncated)
            break;
    }
    const normalizedElements = dedupeReadableSnapshotElements(coalesceReadableInlineElements(elements));
    const snapshotId = `${tab.id}:${generation}:${Date.now()}`;
    const mutationCounter = await domMutationCounter(tab.id).catch(() => null);
    refStates.set(tab.id, {
        snapshotId,
        createdAt: Date.now(),
        documentGeneration: generation,
        url: tab.url,
        refs,
        scopeRefs,
    });
    const historyElements = normalizedElements.map((element) => ({ ...element }));
    const delta = baseSnapshot ? buildSnapshotDelta(baseSnapshot, historyElements, snapshotId, generation) : null;
    rememberSnapshotState(tab.id, {
        id: snapshotId,
        createdAt: Date.now(),
        documentGeneration: generation,
        url: tab.url,
        mutationCounter,
        filters,
        elements: historyElements,
    });
    if (delta?.reset)
        refStates.delete(tab.id);
    scheduleDetach(tab.id);
    const publicElements = normalizedElements.map(publicSnapshotElement);
    const returnedElements = delta
        ? (delta.reset ? [] : [...delta.added, ...delta.changed.map((item) => item.after)])
        : publicElements;
    const responseText = delta
        ? (delta.reset
            ? `Δ reset: ${delta.reason}; take a fresh full snapshot`
            : [
                ...delta.added.map((item) => `+ ${formatSnapshotLine(item)}`),
                ...delta.changed.map((item) => `~ ${formatSnapshotLine(item.after)}`),
                ...delta.removed.map((item) => `- ${formatSnapshotLine({ ...item, ref: item.previousRef || null })}`),
            ].join("\n"))
        : publicElements.map(formatSnapshotLine).join("\n");
    const response = {
        tab: { id: tab.id, windowId: tab.windowId, title: tab.title, url: tab.url, active: tab.active },
        snapshotVersion: SNAPSHOT_VERSION,
        ...(rootRef
            ? refOperationMetadata(tab.id, sourceContext, {
                validReason: "root_snapshot_created",
                invalidReason: delta?.reset ? `delta_reset:${delta.reason}` : "no_active_snapshot",
            })
            : refContextMetadata(tab.id, {
                validReason: "snapshot_created",
                invalidReason: delta?.reset ? `delta_reset:${delta.reason}` : "no_active_snapshot",
            })),
        deltaVersion: DELTA_SNAPSHOT_VERSION,
        restricted: false,
        pageKind,
        debuggerSupported: true,
        snapshot: {
            id: snapshotId,
            documentGeneration: generation,
            mainFrameId,
            createdAt: new Date().toISOString(),
            mutationCounter,
            filters,
        },
        privacy: {
            sensitiveTextMode,
            sensitiveTextRedaction: privacyRedactionEnabled,
            sensitiveRedactionCount,
            broadMailSummary: broadMailSnapshot,
        },
        frames: frames.map((frame) => ({
            ...publicFrameContext(frame, mainFrameId),
            relevanceScore: snapshotFrameRelevance(frame, mainFrameId, pageKind),
            auxiliary: isAuxiliaryFrame(frame),
            selected: selectedFrameIds.has(frame.id),
        })),
        refCount: refs.size,
        containerRefCount: scopeRefs.size,
        elementCount: normalizedElements.length,
        returnedElementCount: returnedElements.length,
        truncated,
        deltaOnly: Boolean(delta),
        delta,
        text: responseText,
        elements: returnedElements,
    };
    return projectSnapshotOutput(response, snapshotOutput);
}
function normalizeScreenshotClip(clip) {
    if (!clip || typeof clip !== "object")
        return null;
    const source = clip;
    const x = Number(source.x);
    const y = Number(source.y);
    const width = Number(source.width);
    const height = Number(source.height);
    if (![x, y, width, height].every(Number.isFinite)) {
        throw new Error("Screenshot clip coordinates must be finite numbers.");
    }
    if (x < 0 || y < 0 || width <= 0 || height <= 0) {
        throw new Error("Screenshot clip requires x/y >= 0 and width/height > 0.");
    }
    return { x, y, width, height };
}
function screenshotAnnotationRect(ref, x, y) {
    const width = Math.max(34, Math.min(96, 12 + String(ref || "").length * 8));
    const height = 18;
    return { left: x - 2, top: y - 2, right: x - 2 + width, bottom: y - 2 + height };
}
function screenshotAnnotationOverlaps(candidate, occupied) {
    return occupied.some((item) => !(candidate.right + 2 <= item.left ||
        candidate.left >= item.right + 2 ||
        candidate.bottom + 2 <= item.top ||
        candidate.top >= item.bottom + 2));
}
function placeScreenshotAnnotation(ref, anchorX, anchorY, captureClip, occupied) {
    const offsets = [[0, 0], [0, 20], [0, -20], [44, 0], [-44, 0], [44, 20], [-44, 20]];
    for (const [dx, dy] of offsets) {
        const x = Math.max(captureClip.x + 2, Math.min(anchorX + dx, captureClip.x + captureClip.width - 34));
        const y = Math.max(captureClip.y + 2, Math.min(anchorY + dy, captureClip.y + captureClip.height - 18));
        const rect = screenshotAnnotationRect(ref, x, y);
        if (screenshotAnnotationOverlaps(rect, occupied))
            continue;
        occupied.push(rect);
        return { ref, x, y };
    }
    return null;
}
async function buildScreenshotAnnotations(tabId, captureClip) {
    const state = refStates.get(tabId);
    if (!state)
        throw new Error("annotateRefs requires a current snapshot. Take a new snapshot first.");
    const generation = currentDocumentGeneration(tabId);
    if (state.documentGeneration !== generation) {
        refStates.delete(tabId);
        throw new Error("annotateRefs snapshot refs are stale after document/frame navigation.");
    }
    const viewport = {
        x: captureClip.x,
        y: captureClip.y,
        width: captureClip.width,
        height: captureClip.height,
    };
    const labels = [];
    const mappedOopifRefs = [];
    const skippedOopifRefs = [];
    const skippedOverlapRefs = [];
    const occupied = [];
    let intersectingRefs = 0;
    const hasOopifRefs = [...state.refs.values()].some((target) => Boolean(target.sessionId));
    const frameContexts = hasOopifRefs ? await collectFrameContexts(tabId) : null;
    for (const [ref, target] of state.refs.entries()) {
        const bounds = target.sessionId
            ? await rootPageBoundsForTarget(tabId, target, frameContexts)
            : await backendNodeBounds(tabId, { id: target.frameId, sessionId: null }, target.backendNodeId);
        if (target.sessionId) {
            if (!bounds) {
                skippedOopifRefs.push(ref);
                continue;
            }
            mappedOopifRefs.push(ref);
        }
        if (!bounds || !boundsIntersectViewport(bounds, viewport))
            continue;
        intersectingRefs += 1;
        if (labels.length >= MAX_SCREENSHOT_ANNOTATIONS)
            continue;
        const placed = placeScreenshotAnnotation(ref, Math.max(captureClip.x + 2, bounds.left), Math.max(captureClip.y + 2, bounds.top), captureClip, occupied);
        if (placed)
            labels.push(placed);
        else
            skippedOverlapRefs.push(ref);
    }
    return {
        labels,
        mappedOopifRefs,
        skippedOopifRefs,
        skippedOverlapRefs,
        truncated: intersectingRefs > labels.length,
    };
}
async function injectScreenshotAnnotations(tabId, annotationData) {
    const payload = JSON.stringify({
        hostId: SCREENSHOT_ANNOTATION_HOST_ID,
        labels: annotationData.labels,
    });
    await send(tabId, "Runtime.evaluate", {
        expression: `(() => {
      const data = ${payload};
      document.getElementById(data.hostId)?.remove();
      const root = document.documentElement || document.body;
      if (!root) return 0;
      const host = document.createElement('div');
      host.id = data.hostId;
      host.setAttribute('aria-hidden', 'true');
      Object.assign(host.style, {
        position: 'absolute', left: '0', top: '0', width: '0', height: '0',
        overflow: 'visible', pointerEvents: 'none', zIndex: '2147483647',
        contain: 'none'
      });
      for (const item of data.labels) {
        const label = document.createElement('div');
        label.textContent = item.ref;
        Object.assign(label.style, {
          position: 'absolute', left: item.x + 'px', top: item.y + 'px',
          transform: 'translate(-2px,-2px)', padding: '2px 5px', borderRadius: '5px',
          background: 'rgba(17, 20, 28, .90)', color: '#fff',
          border: '1px solid rgba(255,255,255,.88)',
          boxShadow: '0 1px 4px rgba(0,0,0,.42)',
          font: '700 11px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace',
          whiteSpace: 'nowrap', pointerEvents: 'none'
        });
        host.appendChild(label);
      }
      root.appendChild(host);
      return data.labels.length;
    })()`,
        returnByValue: true,
    });
}
async function removeScreenshotAnnotations(tabId) {
    await send(tabId, "Runtime.evaluate", {
        expression: `document.getElementById(${JSON.stringify(SCREENSHOT_ANNOTATION_HOST_ID)})?.remove(); true`,
        returnByValue: true,
    }).catch(() => { });
}
async function browserScreenshot({ tabId, fullPage = false, pixelDensity = "css-1x", ref, clip, annotateRefs = false, } = {}) {
    const explicitClip = normalizeScreenshotClip(clip);
    const specializedCount = [Boolean(fullPage), Boolean(ref), Boolean(explicitClip)].filter(Boolean).length;
    if (specializedCount > 1) {
        throw new Error("fullPage, ref and clip are mutually exclusive screenshot scopes.");
    }
    const tab = await chooseTab(tabId);
    if (typeof tab.id !== "number" || !Number.isSafeInteger(tab.id) || tab.id < 1) {
        throw new Error("Selected screenshot tab has an invalid Chrome tab ID.");
    }
    const sourceContext = ref ? captureRefContextSource(tab.id) : null;
    await requireDebuggableTab(tab.id);
    await attachTab(tab.id);
    await send(tab.id, "Page.bringToFront");
    const [metrics, dprResult] = await Promise.all([
        send(tab.id, "Page.getLayoutMetrics"),
        send(tab.id, "Runtime.evaluate", {
            expression: "window.devicePixelRatio || 1",
            returnByValue: true,
        }),
    ]);
    const devicePixelRatio = Math.max(0.5, Math.min(Number(dprResult?.result?.value) || 1, 4));
    if (!new Set(["css-1x", "device"]).has(pixelDensity)) {
        throw new Error(`Unsupported screenshot pixel density: ${String(pixelDensity)}`);
    }
    const captureScale = pixelDensity === "device" ? 1 : 1 / devicePixelRatio;
    const viewport = metrics?.cssLayoutViewport || metrics?.layoutViewport;
    const content = metrics?.cssContentSize || metrics?.contentSize;
    let sourceKind = fullPage ? "full_page" : "viewport";
    let sourceRef = null;
    let sourceClip = null;
    if (ref) {
        const target = lookupScopeRef(tab.id, String(ref));
        const bounds = target.sessionId
            ? await rootPageBoundsForTarget(tab.id, target)
            : await backendNodeBounds(tab.id, { id: target.frameId, sessionId: null }, target.backendNodeId);
        if (!bounds)
            throw new Error(`Element has no safely mappable capturable box: ${String(ref)}`);
        sourceKind = "ref";
        sourceRef = String(ref);
        sourceClip = {
            x: Math.max(0, bounds.left),
            y: Math.max(0, bounds.top),
            width: Math.max(1, bounds.right - bounds.left),
            height: Math.max(1, bounds.bottom - bounds.top),
        };
    }
    else if (explicitClip) {
        sourceKind = "clip";
        sourceClip = explicitClip;
    }
    const source = sourceClip || (fullPage ? content : viewport);
    const width = Math.ceil(Number(source?.width || (source && "clientWidth" in source ? source.clientWidth : 0) || 0));
    const height = Math.ceil(Number(source?.height || (source && "clientHeight" in source ? source.clientHeight : 0) || 0));
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new Error("Unable to determine a valid screenshot viewport.");
    }
    const outputWidth = Math.ceil(width * devicePixelRatio * captureScale);
    const outputHeight = Math.ceil(height * devicePixelRatio * captureScale);
    if (width > MAX_SCREENSHOT_DIMENSION ||
        height > MAX_SCREENSHOT_DIMENSION ||
        outputWidth > MAX_SCREENSHOT_DIMENSION ||
        outputHeight > MAX_SCREENSHOT_DIMENSION) {
        throw new Error(`Screenshot dimensions exceed the ${MAX_SCREENSHOT_DIMENSION}px safety limit: ${outputWidth}x${outputHeight}`);
    }
    if (outputWidth * outputHeight > MAX_SCREENSHOT_AREA) {
        throw new Error(`Screenshot area exceeds the ${MAX_SCREENSHOT_AREA.toLocaleString()}px safety limit: ${outputWidth}x${outputHeight}`);
    }
    const captureClip = {
        x: sourceClip ? Number(sourceClip.x) : fullPage ? 0 : Number(viewport?.pageX || 0),
        y: sourceClip ? Number(sourceClip.y) : fullPage ? 0 : Number(viewport?.pageY || 0),
        width,
        height,
        scale: captureScale,
    };
    let annotationData = null;
    if (annotateRefs) {
        annotationData = await buildScreenshotAnnotations(tab.id, captureClip);
        await injectScreenshotAnnotations(tab.id, annotationData);
    }
    let captured;
    try {
        captured = await send(tab.id, "Page.captureScreenshot", {
            format: "png",
            fromSurface: true,
            captureBeyondViewport: Boolean(fullPage || sourceClip),
            optimizeForSpeed: false,
            clip: captureClip,
        });
    }
    finally {
        if (annotateRefs)
            await removeScreenshotAnnotations(tab.id);
    }
    const data = cdpObject(captured)?.data;
    if (typeof data !== "string")
        throw new Error("Chrome returned an invalid screenshot payload.");
    if (!data)
        throw new Error("Chrome returned an empty screenshot.");
    const estimatedBytes = Math.floor((data.length * 3) / 4);
    if (estimatedBytes > MAX_SCREENSHOT_PNG_BYTES) {
        throw new Error(`Screenshot exceeds the ${MAX_SCREENSHOT_PNG_BYTES / 1024 / 1024} MB transport limit.`);
    }
    scheduleDetach(tab.id);
    return {
        tab: { id: tab.id, windowId: tab.windowId, title: tab.title, url: tab.url, active: tab.active },
        screenshotVersion: SCREENSHOT_VERSION,
        source: sourceKind,
        ref: sourceRef,
        ...(sourceRef ? refOperationMetadata(tab.id, sourceContext, { validReason: "ref_screenshot_captured" }) : {}),
        clip: {
            x: captureClip.x,
            y: captureClip.y,
            width: captureClip.width,
            height: captureClip.height,
        },
        annotations: {
            requested: Boolean(annotateRefs),
            annotatedRefs: annotationData?.labels?.map((item) => item.ref) || [],
            mappedOopifRefs: annotationData?.mappedOopifRefs || [],
            skippedOopifRefs: annotationData?.skippedOopifRefs || [],
            skippedOverlapRefs: annotationData?.skippedOverlapRefs || [],
            truncated: Boolean(annotationData?.truncated),
        },
        fullPage: Boolean(fullPage),
        cssWidth: width,
        cssHeight: height,
        devicePixelRatio,
        captureScale,
        pixelDensity,
        pixelWidth: outputWidth,
        pixelHeight: outputHeight,
        mimeType: "image/png",
        data,
    };
}
async function browserFind({ tabId, query, role, exact = false } = {}) {
    const needle = String(query || "").trim().toLocaleLowerCase();
    if (!needle)
        throw new Error("query is required");
    const roleNeedle = role ? String(role).trim().toLocaleLowerCase() : null;
    const snapshot = await browserSnapshot({ tabId, includeReadable: true });
    if (snapshot.restricted)
        return { ...snapshot, query, role: role || null, exact: Boolean(exact), matches: [] };
    if (!Array.isArray(snapshot.elements))
        throw new Error("Full snapshot elements are unavailable.");
    const matches = snapshot.elements.filter((element) => {
        if (roleNeedle && String(element.role || "").toLocaleLowerCase() !== roleNeedle)
            return false;
        const haystacks = [element.name, element.value].filter((value) => value != null).map((value) => String(value).toLocaleLowerCase());
        return haystacks.some((value) => exact ? value === needle : value.includes(needle));
    });
    return {
        tab: snapshot.tab,
        query: String(query),
        role: role || null,
        exact: Boolean(exact),
        count: matches.length,
        matches,
    };
}
function normalizedReacquireField(value) {
    return value == null ? "" : String(value).trim().replace(/\s+/g, " ").toLocaleLowerCase();
}
function sameReacquireFingerprint(source, candidate) {
    return (source?.frameId === candidate?.frameId &&
        normalizedReacquireField(source?.role) === normalizedReacquireField(candidate?.role) &&
        normalizedReacquireField(source?.name) === normalizedReacquireField(candidate?.name) &&
        normalizedReacquireField(source?.value) === normalizedReacquireField(candidate?.value));
}
async function browserReacquire({ tabId, oldRef, fromSnapshotId } = {}) {
    const ref = String(oldRef || "");
    if (!/^@e\d+$/.test(ref))
        throw new Error("oldRef must be a snapshot ref such as @e3");
    const tab = await chooseTab(tabId);
    if (typeof tab.id !== "number" || !Number.isSafeInteger(tab.id) || tab.id < 1) {
        throw new Error("Reacquire requires a valid Chrome tab ID.");
    }
    const generation = currentDocumentGeneration(tab.id);
    const history = snapshotHistories.get(tab.id) || [];
    const sourceSnapshot = fromSnapshotId
        ? snapshotStateById(tab.id, String(fromSnapshotId))
        : [...history].reverse().find((item) => (item.elements.some((element) => element.ref === ref)));
    if (!sourceSnapshot) {
        throw new Error(`No bounded source snapshot contains ${ref}. Take a snapshot before attempting reacquire.`);
    }
    if (sourceSnapshot.documentGeneration !== generation) {
        return {
            reacquireVersion: REACQUIRE_VERSION,
            status: "stale_document",
            unique: false,
            confidence: "none",
            oldRef: ref,
            newRef: null,
            sourceSnapshotId: sourceSnapshot.id,
            targetSnapshotId: null,
            candidateCount: 0,
            refContextValid: false,
            freshSnapshotRequired: true,
            sourceDocumentGeneration: sourceSnapshot.documentGeneration,
            currentDocumentGeneration: generation,
        };
    }
    const source = sourceSnapshot.elements.find((element) => element.ref === ref);
    if (!source)
        throw new Error(`Source snapshot does not contain ref: ${ref}`);
    const fresh = await browserSnapshot({ tabId: tab.id, mode: "interactive" });
    if (fresh.restricted)
        throw new Error("Reacquire is unavailable on restricted browser pages.");
    if (!fresh.snapshot?.id || !Array.isArray(fresh.elements)) {
        throw new Error("Reacquire requires a full snapshot with a valid identity.");
    }
    const retained = fresh.elements.find((element) => element.ref === ref);
    if (retained) {
        return {
            reacquireVersion: REACQUIRE_VERSION,
            status: "retained",
            unique: true,
            confidence: "exact",
            oldRef: ref,
            newRef: ref,
            sourceSnapshotId: sourceSnapshot.id,
            targetSnapshotId: fresh.snapshot.id,
            candidateCount: 1,
            refContextValid: true,
            freshSnapshotRequired: false,
        };
    }
    const candidates = fresh.elements.filter((element) => element.ref && sameReacquireFingerprint(source, element));
    if (candidates.length === 1) {
        return {
            reacquireVersion: REACQUIRE_VERSION,
            status: "reacquired",
            unique: true,
            confidence: "high",
            oldRef: ref,
            newRef: candidates[0].ref,
            sourceSnapshotId: sourceSnapshot.id,
            targetSnapshotId: fresh.snapshot.id,
            candidateCount: 1,
            match: candidates[0],
            refContextValid: true,
            freshSnapshotRequired: false,
        };
    }
    return {
        reacquireVersion: REACQUIRE_VERSION,
        status: candidates.length === 0 ? "not_found" : "ambiguous",
        unique: false,
        confidence: "none",
        oldRef: ref,
        newRef: null,
        sourceSnapshotId: sourceSnapshot.id,
        targetSnapshotId: fresh.snapshot.id,
        candidateCount: candidates.length,
        candidateRefs: candidates.slice(0, 8).map((element) => element.ref),
        refContextValid: true,
        freshSnapshotRequired: false,
    };
}
function lookupRef(tabId, ref) {
    const state = refStates.get(tabId);
    if (!state)
        throw new Error("No active snapshot refs for this tab. Take a new snapshot first.");
    const generation = currentDocumentGeneration(tabId);
    if (state.documentGeneration !== generation) {
        refStates.delete(tabId);
        throw new Error(`Snapshot ref is stale after document/frame navigation: ${ref}`);
    }
    const item = state.refs.get(ref);
    if (!item)
        throw new Error(`Snapshot ref not found: ${ref}`);
    if (item.documentGeneration !== generation) {
        refStates.delete(tabId);
        throw new Error(`Snapshot ref is stale after document/frame navigation: ${ref}`);
    }
    if (item.sessionId && !attachedTabs.get(tabId)?.sessions?.has(item.sessionId)) {
        refStates.delete(tabId);
        throw new Error(`Snapshot ref belongs to a detached frame/session: ${ref}`);
    }
    return item;
}
function lookupScopeRef(tabId, ref) {
    const state = refStates.get(tabId);
    if (!state)
        throw new Error("No active snapshot refs for this tab. Take a new snapshot first.");
    const generation = currentDocumentGeneration(tabId);
    if (state.documentGeneration !== generation) {
        refStates.delete(tabId);
        throw new Error(`Snapshot ref is stale after document/frame navigation: ${ref}`);
    }
    const item = state.refs.get(ref) || state.scopeRefs?.get(ref);
    if (!item)
        throw new Error(`Snapshot scope ref not found: ${ref}`);
    if (item.documentGeneration !== generation) {
        refStates.delete(tabId);
        throw new Error(`Snapshot ref is stale after document/frame navigation: ${ref}`);
    }
    if (item.sessionId && !attachedTabs.get(tabId)?.sessions?.has(item.sessionId)) {
        refStates.delete(tabId);
        throw new Error(`Snapshot ref belongs to a detached frame/session: ${ref}`);
    }
    return item;
}
function quadCenter(quad) {
    const xs = [quad[0], quad[2], quad[4], quad[6]];
    const ys = [quad[1], quad[3], quad[5], quad[7]];
    return {
        x: xs.reduce((sum, value) => sum + value, 0) / xs.length,
        y: ys.reduce((sum, value) => sum + value, 0) / ys.length,
    };
}
function quadPoint(quad, fx, fy) {
    const p0 = { x: quad[0], y: quad[1] };
    const p1 = { x: quad[2], y: quad[3] };
    const p2 = { x: quad[4], y: quad[5] };
    const p3 = { x: quad[6], y: quad[7] };
    const top = {
        x: p0.x + (p1.x - p0.x) * fx,
        y: p0.y + (p1.y - p0.y) * fx,
    };
    const bottom = {
        x: p3.x + (p2.x - p3.x) * fx,
        y: p3.y + (p2.y - p3.y) * fx,
    };
    return {
        x: top.x + (bottom.x - top.x) * fy,
        y: top.y + (bottom.y - top.y) * fy,
    };
}
function clickCandidatePoints(quad) {
    const fractions = [0.5, 0.2, 0.8, 0.08, 0.92];
    const candidates = [];
    for (const fy of fractions) {
        for (const fx of fractions) {
            candidates.push({
                ...quadPoint(quad, fx, fy),
                distance: ((fx - 0.5) ** 2) + ((fy - 0.5) ** 2),
            });
        }
    }
    candidates.sort((a, b) => a.distance - b.distance);
    return candidates.map(({ x, y }) => ({ x, y }));
}
async function verifiedClickablePoint(tabId, target, quad, ref) {
    let objectId = null;
    try {
        const resolved = await send(tabId, "DOM.resolveNode", { backendNodeId: target.backendNodeId }, target.sessionId);
        objectId = cdpResolvedObjectId(resolved);
        if (!objectId)
            throw new Error(`Element cannot be resolved for hit testing: ${ref}`);
        const result = await send(tabId, "Runtime.callFunctionOn", {
            objectId,
            functionDeclaration: `function(candidates) {
        const composedContains = (root, node) => {
          let current = node;
          while (current) {
            if (current === root) return true;
            if (current.parentNode) current = current.parentNode;
            else {
              const treeRoot = typeof current.getRootNode === "function" ? current.getRootNode() : null;
              current = treeRoot && treeRoot.host ? treeRoot.host : null;
            }
          }
          return false;
        };
        for (const point of candidates) {
          const hit = document.elementFromPoint(point.x, point.y);
          if (hit && (composedContains(this, hit) || composedContains(hit, this))) return point;
        }
        return null;
      }`,
            arguments: [{ value: clickCandidatePoints(quad) }],
            returnByValue: true,
            silent: true,
        }, target.sessionId);
        const point = cdpObject(result?.result?.value);
        if (typeof point?.x === "number" && Number.isFinite(point.x) && typeof point?.y === "number" && Number.isFinite(point.y))
            return { x: point.x, y: point.y };
        throw new Error(`Element has no unobscured clickable point: ${ref}`);
    }
    finally {
        if (objectId) {
            await send(tabId, "Runtime.releaseObject", { objectId }, target.sessionId).catch(() => { });
        }
    }
}
function normalizeAgentCursorName(value) {
    const normalized = String(value || DEFAULT_AGENT_CURSOR_NAME)
        .replace(/[\u0000-\u001f\u007f]/gu, " ")
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, 32);
    return normalized || DEFAULT_AGENT_CURSOR_NAME;
}
async function showAgentCursor(tabId, point, sessionId, { pulse = false, agentName } = {}) {
    if (!(await ensureAgentCursorEnabledLoaded()))
        return false;
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y))
        return false;
    const resolvedAgentName = agentName == null
        ? await ensureAgentCursorNameLoaded()
        : normalizeAgentCursorName(agentName);
    const payload = JSON.stringify({
        x: point.x,
        y: point.y,
        pulse: Boolean(pulse),
        hostId: AGENT_CURSOR_HOST_ID,
        agentName: resolvedAgentName,
        idleMs: AGENT_CURSOR_IDLE_MS,
    });
    const expression = `(() => {
    const data = ${payload};
    const root = document.documentElement || document.body;
    if (!root) return false;
    let host = document.getElementById(data.hostId);
    if (!host) {
      host = document.createElement('div');
      host.id = data.hostId;
      host.setAttribute('aria-hidden', 'true');
      Object.assign(host.style, {
        position: 'fixed', left: '0', top: '0', width: '180px', height: '52px',
        zIndex: '2147483647', pointerEvents: 'none', opacity: '0',
        contain: 'layout style', overflow: 'visible', transform: 'translate3d(0,0,0)'
      });
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 28 28');
      svg.setAttribute('width', '28');
      svg.setAttribute('height', '28');
      svg.style.pointerEvents = 'none';
      svg.style.filter = 'drop-shadow(0 2px 4px rgba(16, 18, 27, .38))';
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M2 1 L2.2 22 L8.2 16.3 L12.5 26 L16.4 24.2 L12 14.9 L21 14.5 Z');
      path.setAttribute('fill', '#665cff');
      path.setAttribute('stroke', '#ffffff');
      path.setAttribute('stroke-width', '2');
      path.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(path);
      const ring = document.createElement('div');
      ring.dataset.equinoxCursorRing = 'true';
      Object.assign(ring.style, {
        position: 'absolute', left: '-7px', top: '-8px', width: '18px', height: '18px',
        border: '2px solid rgba(102, 92, 255, 0.94)', borderRadius: '999px',
        opacity: '0', pointerEvents: 'none', boxSizing: 'border-box'
      });
      const label = document.createElement('div');
      label.dataset.equinoxCursorLabel = 'true';
      Object.assign(label.style, {
        position: 'absolute', left: '22px', top: '21px', display: 'inline-flex',
        alignItems: 'center', gap: '6px', maxWidth: '150px', padding: '4px 8px',
        borderRadius: '999px', background: 'rgba(102, 92, 255, .96)', color: '#ffffff',
        border: '1px solid rgba(255, 255, 255, .46)', boxShadow: '0 4px 14px rgba(55, 45, 170, .28)',
        font: '600 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        letterSpacing: '.01em', whiteSpace: 'nowrap', pointerEvents: 'none'
      });
      const dot = document.createElement('span');
      Object.assign(dot.style, {
        width: '7px', height: '7px', flex: '0 0 7px', borderRadius: '999px',
        background: '#ffffff', boxShadow: '0 0 0 3px rgba(255, 255, 255, .18)'
      });
      const name = document.createElement('span');
      name.dataset.equinoxCursorName = 'true';
      name.style.overflow = 'hidden';
      name.style.textOverflow = 'ellipsis';
      name.textContent = data.agentName;
      label.append(dot, name);
      host.append(svg, ring, label);
      root.appendChild(host);
    }
    const name = host.querySelector('[data-equinox-cursor-name]');
    if (name) name.textContent = data.agentName;
    if (host.__equinoxCursorHideTimer) clearTimeout(host.__equinoxCursorHideTimer);
    if (host.__equinoxCursorHideAnimation) {
      try { host.__equinoxCursorHideAnimation.cancel(); } catch {}
      host.__equinoxCursorHideAnimation = null;
    }
    const previous = host.__equinoxCursorPosition || {
      x: Math.max(4, data.x - 54),
      y: Math.max(4, data.y - 38),
    };
    const distance = Math.hypot(data.x - previous.x, data.y - previous.y);
    const duration = Math.max(100, Math.min(260, 90 + distance * 0.16));
    const from = 'translate3d(' + (previous.x - 2) + 'px,' + (previous.y - 1) + 'px,0)';
    const to = 'translate3d(' + (data.x - 2) + 'px,' + (data.y - 1) + 'px,0)';
    host.style.opacity = '1';
    host.animate([
      { transform: from, opacity: host.__equinoxCursorPosition ? 1 : 0.15 },
      { transform: to, opacity: 1 },
    ], { duration, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' });
    host.style.transform = to;
    host.__equinoxCursorPosition = { x: data.x, y: data.y };
    if (data.pulse) {
      const ring = host.querySelector('[data-equinox-cursor-ring]');
      ring?.animate([
        { opacity: 0.88, transform: 'scale(.45)' },
        { opacity: 0, transform: 'scale(1.75)' },
      ], { duration: 300, delay: duration, easing: 'ease-out' });
    }
    host.__equinoxCursorHideTimer = setTimeout(() => {
      const fade = host.animate([
        { opacity: 1 },
        { opacity: 0 },
      ], { duration: 220, easing: 'ease-out', fill: 'forwards' });
      host.__equinoxCursorHideAnimation = fade;
      Promise.resolve(fade.finished).catch(() => {}).then(() => {
        if (host.__equinoxCursorHideAnimation !== fade) return;
        host.style.opacity = '0';
        host.__equinoxCursorHideAnimation = null;
      });
    }, duration + data.idleMs);
    return { duration };
  })()`;
    const result = await send(tabId, "Runtime.evaluate", {
        expression,
        returnByValue: true,
        silent: true,
    }, sessionId).catch(() => null);
    const duration = Number(cdpObject(result?.result?.value)?.duration);
    if (Number.isFinite(duration))
        await sleep(Math.min(duration, 260));
    return Boolean(result);
}
async function moveAgentCursorToRef(tabId, ref, { pulse = false, agentName } = {}) {
    const target = lookupRef(tabId, ref);
    await send(tabId, "Page.bringToFront");
    await send(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId: target.backendNodeId }, target.sessionId);
    const box = await send(tabId, "DOM.getBoxModel", { backendNodeId: target.backendNodeId }, target.sessionId);
    const quad = box?.model?.border || box?.model?.content;
    if (!Array.isArray(quad) || quad.length < 8)
        throw new Error(`Element has no visible box: ${ref}`);
    const point = await verifiedClickablePoint(tabId, target, quad, ref);
    await showAgentCursor(tabId, point, target.sessionId, { pulse, agentName });
    await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", ...point }, target.sessionId);
    return {
        target,
        point,
        frameId: target.frameId,
        sessionId: target.sessionId || null,
    };
}
function actionErrorMessage(error) {
    return String(error && typeof error === "object" && "message" in error ? error.message || error : error || "");
}
function isDetachedNodeError(error) {
    const message = actionErrorMessage(error);
    return /Node is detached from document|detached from document|node.*detached|not attached to the document/i.test(message);
}
function isTransientRefActionabilityError(error) {
    const message = actionErrorMessage(error);
    return isDetachedNodeError(error)
        || /Could not compute box model|box model|Element has no visible box|No node with given id|Could not find node|Node with given id|Cannot find context|object.*not found/i.test(message);
}
async function moveAgentCursorToRefWithRevalidation(tabId, ref, { pulse = false, agentName } = {}) {
    const sourceState = refStates.get(tabId) || null;
    const sourceSnapshotId = sourceState?.snapshotId || null;
    const sourceSnapshot = sourceSnapshotId ? snapshotStateById(tabId, sourceSnapshotId) : null;
    const sourceElement = sourceSnapshot?.elements?.find((element) => element.ref === ref) || null;
    const currentGeneration = currentDocumentGeneration(tabId);
    if (sourceState && sourceState.documentGeneration !== currentGeneration) {
        const currentTab = await workerTabs().get(tabId).catch(() => null);
        const samePage = Boolean(sourceState.url && currentTab?.url === sourceState.url);
        return {
            target: null,
            point: null,
            frameId: null,
            sessionId: null,
            effectiveRef: null,
            actionabilityRecovered: false,
            actionabilityReason: samePage ? "same_page_generation_churn" : "stale_after_navigation",
            revalidationAttempted: false,
            revalidatedSnapshotId: null,
            revalidatedRef: null,
            revalidationStatus: samePage ? "generation_churn" : "navigation_boundary",
            retryableStale: samePage,
        };
    }
    const attempt = async (candidateRef = ref) => ({
        ...(await moveAgentCursorToRef(tabId, candidateRef, { pulse, agentName })),
        effectiveRef: candidateRef,
    });
    try {
        return {
            ...(await attempt()),
            actionabilityRecovered: false,
            actionabilityReason: "clickable",
            revalidationAttempted: false,
            revalidatedSnapshotId: null,
            revalidatedRef: null,
            revalidationStatus: "not_needed",
            retryableStale: false,
        };
    }
    catch (error) {
        if (!isTransientRefActionabilityError(error))
            throw error;
    }
    await sleep(60);
    try {
        return {
            ...(await attempt()),
            actionabilityRecovered: true,
            actionabilityReason: "bounded_retry",
            revalidationAttempted: true,
            revalidatedSnapshotId: null,
            revalidatedRef: null,
            revalidationStatus: "same_ref_retry",
            retryableStale: false,
        };
    }
    catch (error) {
        if (!isTransientRefActionabilityError(error))
            throw error;
    }
    let revalidatedSnapshotId = null;
    let revalidationStatus = "not_found";
    if (sourceSnapshot &&
        sourceSnapshot.documentGeneration === currentDocumentGeneration(tabId) &&
        !sourceSnapshot.filters?.rootRef) {
        try {
            const currentTab = await workerTabs().get(tabId).catch(() => null);
            if (!currentTab || (sourceState?.url && currentTab.url !== sourceState.url)) {
                return {
                    target: null,
                    point: null,
                    frameId: null,
                    sessionId: null,
                    effectiveRef: null,
                    actionabilityRecovered: false,
                    actionabilityReason: "stale_after_navigation",
                    revalidationAttempted: false,
                    revalidatedSnapshotId: null,
                    revalidatedRef: null,
                    revalidationStatus: "navigation_boundary",
                    retryableStale: false,
                };
            }
            const refreshed = await browserSnapshot({
                tabId,
                ...snapshotArgsFromBase(sourceSnapshot),
                output: "both",
            });
            revalidatedSnapshotId = refreshed?.snapshot?.id || null;
            let candidateRef = refStates.get(tabId)?.refs?.has(ref) ? ref : null;
            if (!candidateRef && sourceElement && Array.isArray(refreshed?.elements)) {
                const candidates = refreshed.elements.filter((element) => element.ref && sameReacquireFingerprint(sourceElement, element));
                if (candidates.length === 1) {
                    candidateRef = candidates[0].ref ?? null;
                    revalidationStatus = "semantic_reacquired";
                }
                else {
                    revalidationStatus = candidates.length > 1 ? "ambiguous" : "not_found";
                }
            }
            else if (candidateRef) {
                revalidationStatus = "stable_ref_retained";
            }
            if (candidateRef) {
                try {
                    return {
                        ...(await attempt(candidateRef)),
                        actionabilityRecovered: true,
                        actionabilityReason: candidateRef === ref ? "snapshot_revalidated" : "semantic_reacquired",
                        revalidationAttempted: true,
                        revalidatedSnapshotId,
                        revalidatedRef: candidateRef === ref ? null : candidateRef,
                        revalidationStatus,
                        retryableStale: false,
                    };
                }
                catch (error) {
                    if (!isTransientRefActionabilityError(error))
                        throw error;
                    revalidationStatus = "replacement_became_stale";
                }
            }
        }
        catch (error) {
            if (!isTransientRefActionabilityError(error)) {
                // A refresh can race with a highly dynamic surface. Keep recovery fail-closed instead of leaking raw CDP errors.
            }
        }
    }
    return {
        target: null,
        point: null,
        frameId: null,
        sessionId: null,
        effectiveRef: null,
        actionabilityRecovered: false,
        actionabilityReason: "stale_or_rerendered",
        revalidationAttempted: true,
        revalidatedSnapshotId,
        revalidatedRef: null,
        revalidationStatus,
        retryableStale: false,
    };
}
function normalizeActionAfter(after, tabId, actionName = "action") {
    if (after == null)
        return null;
    if (typeof after !== "object" || Array.isArray(after))
        throw new Error(`${actionName} after must be an object`);
    const payload = after;
    if (typeof tabId !== "number" || !Number.isSafeInteger(tabId) || tabId < 1) {
        throw new Error(`${actionName} requires a valid Chrome tab id`);
    }
    const waitFor = payload.waitFor == null ? null : String(payload.waitFor);
    const snapshot = payload.snapshot == null ? null : String(payload.snapshot);
    if (waitFor && !new Set(["dom_stable", "network_idle", "semantic_ready"]).has(waitFor)) {
        throw new Error(`Unsupported ${actionName} after.waitFor: ${waitFor}`);
    }
    if (snapshot && !new Set(["delta", "full"]).has(snapshot)) {
        throw new Error(`Unsupported ${actionName} after.snapshot: ${snapshot}`);
    }
    if (!waitFor && !snapshot)
        throw new Error(`${actionName} after requires waitFor and/or snapshot`);
    const quietMs = Math.max(100, Math.min(Number(payload.quietMs) || 500, 5_000));
    const timeoutMs = Math.max(100, Math.min(Number(payload.timeoutMs) || 10_000, 60_000));
    const baseSnapshotId = refStates.get(tabId)?.snapshotId || null;
    const baseSnapshot = baseSnapshotId ? snapshotStateById(tabId, baseSnapshotId) : null;
    if (snapshot === "delta" && !baseSnapshot) {
        throw new Error(`${actionName} after.snapshot=delta requires a current snapshot base`);
    }
    if (snapshot && baseSnapshot?.filters?.rootRef) {
        throw new Error(`${actionName} compound snapshot does not support a root_ref base; take an unscoped snapshot first`);
    }
    const projection = {};
    if (payload.snapshotMode != null)
        projection.mode = normalizeSnapshotMode(payload.snapshotMode, true);
    if (payload.snapshotScope != null)
        projection.scope = normalizeSnapshotScope(payload.snapshotScope);
    if (payload.snapshotMaxNodes != null) {
        const value = Number(payload.snapshotMaxNodes);
        if (!Number.isInteger(value) || value < 1 || value > MAX_SNAPSHOT_ELEMENTS) {
            throw new Error(`${actionName} after.snapshotMaxNodes must be an integer between 1 and ${MAX_SNAPSHOT_ELEMENTS}`);
        }
        projection.maxNodes = value;
    }
    if (payload.snapshotQuery != null) {
        const value = String(payload.snapshotQuery).trim();
        if (!value || value.length > 1_000)
            throw new Error(`${actionName} after.snapshotQuery must be 1-1000 characters`);
        projection.query = value;
    }
    if (payload.snapshotRoles != null) {
        const normalized = normalizeSnapshotRoles(payload.snapshotRoles);
        projection.roles = normalized ? [...normalized].sort() : [];
    }
    if (Object.keys(projection).length > 0 && !snapshot) {
        throw new Error(`${actionName} after snapshot projection requires after.snapshot`);
    }
    if (snapshot === "delta" && Object.keys(projection).length > 0) {
        const inherited = snapshotArgsFromBase(baseSnapshot);
        const effective = { ...inherited, ...projection };
        const baseFilters = baseSnapshot?.filters || {};
        const expected = {
            mode: baseFilters.mode || "balanced",
            scope: baseFilters.scope || "document",
            maxNodes: Number(baseFilters.maxNodes) || MAX_SNAPSHOT_ELEMENTS,
            roles: Array.isArray(baseFilters.roles) ? [...baseFilters.roles].sort() : null,
            query: baseFilters.query || null,
        };
        const actual = {
            mode: effective.mode || "balanced",
            scope: effective.scope || "document",
            maxNodes: Number(effective.maxNodes) || MAX_SNAPSHOT_ELEMENTS,
            roles: Array.isArray(effective.roles) && effective.roles.length ? [...effective.roles].sort() : null,
            query: effective.query ? String(effective.query).trim().toLowerCase() : null,
        };
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            throw new Error(`${actionName} after.snapshot=delta projection must match the current snapshot projection exactly`);
        }
    }
    return { waitFor, snapshot, quietMs, timeoutMs, baseSnapshotId, baseSnapshot, projection };
}
function snapshotArgsFromBase(baseSnapshot, { delta = false, projection = {} } = {}) {
    const filters = baseSnapshot?.filters || {};
    return {
        mode: projection.mode || filters.mode || "balanced",
        scope: projection.scope || filters.scope || "document",
        maxNodes: Number(projection.maxNodes ?? filters.maxNodes) || MAX_SNAPSHOT_ELEMENTS,
        output: "compact",
        ...(Object.hasOwn(projection, "roles")
            ? (projection.roles?.length ? { roles: projection.roles } : {})
            : (Array.isArray(filters.roles) && filters.roles.length ? { roles: filters.roles } : {})),
        ...(Object.hasOwn(projection, "query")
            ? (projection.query ? { query: projection.query } : {})
            : (typeof filters.query === "string" && filters.query ? { query: filters.query } : {})),
        ...(filters.mainFrameOnly ? { mainFrameOnly: true } : {}),
        ...(filters.excludeAuxiliaryFrames ? { excludeAuxiliaryFrames: true } : {}),
        ...(filters.activeLayerOnly ? { activeLayerOnly: true } : {}),
        ...(typeof filters.frameId === "string" && filters.frameId ? { frameId: filters.frameId } : {}),
        ...(filters.pruneUnnamedRefs ? { pruneUnnamedRefs: true } : {}),
        ...(filters.sensitiveText === "redact" ? { sensitiveText: "redact" } : {}),
        ...(delta && baseSnapshot?.id ? { sinceSnapshotId: baseSnapshot.id } : {}),
    };
}
async function runActionAfter(tabId, config) {
    if (!config)
        return null;
    if (typeof tabId !== "number" || !Number.isSafeInteger(tabId) || tabId < 1) {
        throw new Error("Compound action requires a valid Chrome tab id");
    }
    const result = { ok: true, wait: null, snapshot: null };
    try {
        if (config.waitFor === "dom_stable") {
            const waitRequest = {
                tabId,
                domStable: true,
                quietMs: config.quietMs,
                timeoutMs: config.timeoutMs,
            };
            result.wait = await browserWait(waitRequest);
        }
        else if (config.waitFor === "network_idle") {
            const waitRequest = {
                tabId,
                networkIdle: true,
                quietMs: config.quietMs,
                timeoutMs: config.timeoutMs,
            };
            result.wait = await browserWait(waitRequest);
        }
        else if (config.waitFor === "semantic_ready") {
            const semanticProjection = snapshotArgsFromBase(config.baseSnapshot, { projection: config.projection });
            const waitRequest = {
                tabId,
                semanticReady: {
                    ...(semanticProjection.query ? { query: semanticProjection.query } : {}),
                    ...(Array.isArray(semanticProjection.roles) && semanticProjection.roles.length
                        ? { roles: semanticProjection.roles }
                        : {}),
                    minNodes: 1,
                },
                quietMs: config.quietMs,
                timeoutMs: config.timeoutMs,
            };
            result.wait = await browserWait(waitRequest);
        }
    }
    catch (error) {
        return {
            ...result,
            ok: false,
            failedStage: "wait",
            error: error instanceof Error ? error.message : String(error),
        };
    }
    try {
        if (config.snapshot === "delta") {
            result.snapshot = await browserSnapshot({
                tabId,
                ...snapshotArgsFromBase(config.baseSnapshot, { delta: true, projection: config.projection }),
            });
        }
        else if (config.snapshot === "full") {
            result.snapshot = await browserSnapshot({
                tabId,
                ...snapshotArgsFromBase(config.baseSnapshot, { projection: config.projection }),
            });
        }
    }
    catch (error) {
        return {
            ...result,
            ok: false,
            failedStage: "snapshot",
            error: error instanceof Error ? error.message : String(error),
        };
    }
    return result;
}
function normalizeMouseButton(button = "left") {
    const value = String(button || "left").toLowerCase();
    if (!new Set(["left", "right", "middle"]).has(value))
        throw new Error(`Unsupported mouse button: ${value}`);
    return value;
}
function mouseButtonsMask(button) {
    if (button === "right")
        return 2;
    if (button === "middle")
        return 4;
    return 1;
}
function normalizeInputModifiers(modifiers = []) {
    const list = modifiers == null ? [] : modifiers;
    if (!Array.isArray(list))
        throw new Error("modifiers must be an array");
    let mask = 0;
    const normalized = [];
    for (const raw of list) {
        const value = String(raw || "").toLowerCase();
        if (!value)
            continue;
        if (value === "alt" || value === "option")
            mask |= 1;
        else if (value === "ctrl" || value === "control")
            mask |= 2;
        else if (value === "meta" || value === "cmd" || value === "command")
            mask |= 4;
        else if (value === "shift")
            mask |= 8;
        else
            throw new Error(`Unsupported input modifier: ${raw}`);
        if (!normalized.includes(value))
            normalized.push(value);
    }
    return { mask, values: normalized };
}
async function dispatchNormalizedSemanticClick(tabId, target, point, { clickCount = 1, button = "left", modifiers = [], delayMs = 0 } = {}) {
    if (typeof tabId !== "number" || !Number.isSafeInteger(tabId) || tabId < 1) {
        throw new Error("Semantic click requires a valid Chrome tab id");
    }
    const requestedClickCount = Number(clickCount);
    if (![1, 2].includes(requestedClickCount))
        throw new Error("clickCount must be 1 or 2");
    const requestedButton = normalizeMouseButton(button);
    const modifierInfo = normalizeInputModifiers(modifiers);
    const boundedDelayMs = Math.max(0, Math.min(Math.floor(Number(delayMs) || 0), 1_000));
    const dialogSequenceBefore = dialogSequence;
    let dialog = null;
    for (let currentClick = 1; currentClick <= requestedClickCount && !dialog; currentClick += 1) {
        const pressPromise = send(tabId, "Input.dispatchMouseEvent", {
            type: "mousePressed",
            ...point,
            button: requestedButton,
            buttons: mouseButtonsMask(requestedButton),
            modifiers: modifierInfo.mask,
            clickCount: currentClick,
        }, target.sessionId);
        dialog = await settleCommandOrDialog(tabId, pressPromise, dialogSequenceBefore);
        if (dialog)
            break;
        if (boundedDelayMs > 0)
            await sleep(boundedDelayMs);
        const releasePromise = send(tabId, "Input.dispatchMouseEvent", {
            type: "mouseReleased",
            ...point,
            button: requestedButton,
            buttons: 0,
            modifiers: modifierInfo.mask,
            clickCount: currentClick,
        }, target.sessionId);
        dialog = await settleCommandOrDialog(tabId, releasePromise, dialogSequenceBefore);
    }
    return {
        dialog,
        clickCount: requestedClickCount,
        button: requestedButton,
        modifiers: modifierInfo.values,
        delayMs: boundedDelayMs,
    };
}
async function browserClick({ tabId, ref, agentName, after, clickCount = 1, button = "left", modifiers = [], delayMs = 0, } = {}) {
    const tab = await chooseTab(tabId);
    if (typeof tab.id !== "number" || !Number.isSafeInteger(tab.id) || tab.id < 1) {
        throw new Error("Click requires a valid Chrome tab id");
    }
    if (typeof ref !== "string" || !ref)
        throw new Error("Click requires a snapshot ref");
    const afterConfig = normalizeActionAfter(after, tab.id, "click");
    const sourceContext = captureRefContextSource(tab.id);
    const requestedClickCount = Number(clickCount);
    if (![1, 2].includes(requestedClickCount))
        throw new Error("clickCount must be 1 or 2");
    const requestedButton = normalizeMouseButton(button);
    const modifierInfo = normalizeInputModifiers(modifiers);
    const boundedDelayMs = Math.max(0, Math.min(Math.floor(Number(delayMs) || 0), 1_000));
    await requireDebuggableTab(tab.id);
    await attachTab(tab.id);
    const tabCreationSequenceBefore = tabCreationSequence;
    const downloadCreationSequenceBefore = downloadCreationSequence;
    const existingDialog = currentDialogRecord(tab.id);
    if (existingDialog) {
        return {
            clickVersion: CLICK_VERSION,
            tabId: tab.id,
            ref,
            actionDispatched: false,
            primaryActionSucceeded: false,
            blockedByDialog: true,
            dialogOpened: existingDialog.dialog,
            button: requestedButton,
            modifiers: modifierInfo.values,
            delayMs: boundedDelayMs,
            compoundActionVersion: COMPOUND_ACTION_VERSION,
            after: afterConfig ? { ok: false, skipped: true, reason: "blocked_by_dialog" } : null,
            ...refOperationMetadata(tab.id, sourceContext, { validReason: "blocked_by_dialog" }),
            tabCreationSequenceBefore,
            tabCreationSequenceAfter: tabCreationSequence,
            openedTabs: [],
            downloadCreationSequenceBefore,
            downloadCreationSequenceAfter: downloadCreationSequence,
            downloadCreationsObserved: 0,
            downloadsStartedTruncated: false,
            downloadsStarted: [],
        };
    }
    const dialogSequenceBefore = dialogSequence;
    const moved = await moveAgentCursorToRefWithRevalidation(tab.id, ref, { pulse: true, agentName });
    if (!moved.target || !moved.point) {
        scheduleDetach(tab.id);
        return {
            clickVersion: CLICK_VERSION,
            actionabilityVersion: ACTIONABILITY_VERSION,
            tabId: tab.id,
            ref,
            actionDispatched: false,
            primaryActionSucceeded: false,
            outcomeUncertain: false,
            actionabilityRecovered: false,
            actionabilityReason: moved.actionabilityReason,
            revalidationAttempted: moved.revalidationAttempted,
            revalidatedSnapshotId: moved.revalidatedSnapshotId,
            revalidatedRef: moved.revalidatedRef || null,
            revalidationStatus: moved.revalidationStatus || null,
            retryableStale: Boolean(moved.retryableStale),
            button: requestedButton,
            modifiers: modifierInfo.values,
            delayMs: boundedDelayMs,
            compoundActionVersion: COMPOUND_ACTION_VERSION,
            after: afterConfig ? { ok: false, skipped: true, reason: "primary_action_not_dispatched" } : null,
            refLifecycleVersion: REF_LIFECYCLE_VERSION,
            sourceSnapshotId: sourceContext.sourceSnapshotId,
            sourceDocumentGeneration: sourceContext.sourceDocumentGeneration,
            currentSnapshotId: moved.revalidatedSnapshotId || null,
            refContextValid: false,
            freshSnapshotRequired: true,
            refContextReason: moved.actionabilityReason,
            currentDocumentGeneration: currentDocumentGeneration(tab.id),
            tabCreationSequenceBefore,
            tabCreationSequenceAfter: tabCreationSequence,
            openedTabs: [],
            downloadCreationSequenceBefore,
            downloadCreationSequenceAfter: downloadCreationSequence,
            downloadCreationsObserved: 0,
            downloadsStartedTruncated: false,
            downloadsStarted: [],
        };
    }
    const { target, point } = moved;
    let dialog = null;
    let dispatchStarted = false;
    let dispatchFailure = null;
    try {
        dispatchStarted = true;
        const dispatched = await dispatchNormalizedSemanticClick(tab.id, target, point, {
            clickCount: requestedClickCount,
            button: requestedButton,
            modifiers: modifierInfo.values,
            delayMs: boundedDelayMs,
        });
        dialog = dispatched.dialog;
    }
    catch (error) {
        dispatchFailure = error;
    }
    const [openedTabs, downloadsStarted] = await Promise.all([
        discoverNewTabs(tabCreationSequenceBefore, tab.id),
        discoverNewDownloads(downloadCreationSequenceBefore),
    ]);
    if (dispatchFailure) {
        refStates.delete(tab.id);
        scheduleDetach(tab.id);
        return {
            clickVersion: CLICK_VERSION,
            actionabilityVersion: ACTIONABILITY_VERSION,
            tabId: tab.id,
            ref,
            point,
            actionDispatched: dispatchStarted,
            primaryActionSucceeded: false,
            outcomeUncertain: dispatchStarted,
            actionabilityRecovered: moved.actionabilityRecovered,
            actionabilityReason: dispatchStarted ? "post_dispatch_outcome_uncertain" : "stale_or_rerendered",
            revalidationAttempted: moved.revalidationAttempted,
            revalidatedSnapshotId: moved.revalidatedSnapshotId,
            revalidatedRef: moved.revalidatedRef || null,
            revalidationStatus: moved.revalidationStatus || null,
            retryableStale: false,
            clickCount: requestedClickCount,
            button: requestedButton,
            modifiers: modifierInfo.values,
            delayMs: boundedDelayMs,
            frameId: target.frameId,
            sessionScope: target.sessionId ? "child" : "root",
            dialogOpened: dialog || null,
            compoundActionVersion: COMPOUND_ACTION_VERSION,
            after: afterConfig ? { ok: false, skipped: true, reason: "primary_action_outcome_uncertain" } : null,
            refLifecycleVersion: REF_LIFECYCLE_VERSION,
            sourceSnapshotId: sourceContext.sourceSnapshotId,
            sourceDocumentGeneration: sourceContext.sourceDocumentGeneration,
            currentSnapshotId: null,
            refContextValid: false,
            freshSnapshotRequired: true,
            refContextReason: "post_dispatch_outcome_uncertain",
            currentDocumentGeneration: currentDocumentGeneration(tab.id),
            tabCreationSequenceBefore,
            tabCreationSequenceAfter: tabCreationSequence,
            openedTabs,
            downloadCreationSequenceBefore,
            downloadCreationSequenceAfter: downloadCreationSequence,
            downloadCreationsObserved: Math.max(0, downloadCreationSequence - downloadCreationSequenceBefore),
            downloadsStartedTruncated: Math.max(0, downloadCreationSequence - downloadCreationSequenceBefore) > downloadsStarted.length,
            downloadsStarted,
        };
    }
    refStates.delete(tab.id);
    const afterResult = dialog || !afterConfig
        ? (afterConfig ? { ok: false, skipped: true, reason: "dialog_opened" } : null)
        : await runActionAfter(tab.id, afterConfig);
    scheduleActionDetach(tab.id, { afterResult });
    const refContext = refOperationMetadata(tab.id, sourceContext, {
        validReason: "compound_snapshot_created",
        invalidReason: dialog ? "dialog_opened" : "action_invalidated_snapshot",
    });
    return {
        clickVersion: CLICK_VERSION,
        tabId: tab.id,
        ref,
        point,
        actionDispatched: true,
        primaryActionSucceeded: true,
        outcomeUncertain: false,
        actionabilityRecovered: moved.actionabilityRecovered,
        actionabilityReason: moved.actionabilityReason,
        revalidationAttempted: moved.revalidationAttempted,
        revalidatedSnapshotId: moved.revalidatedSnapshotId,
        revalidatedRef: moved.revalidatedRef || null,
        revalidationStatus: moved.revalidationStatus || null,
        retryableStale: Boolean(moved.retryableStale),
        actionabilityVersion: ACTIONABILITY_VERSION,
        clickCount: requestedClickCount,
        button: requestedButton,
        modifiers: modifierInfo.values,
        delayMs: boundedDelayMs,
        frameId: target.frameId,
        sessionScope: target.sessionId ? "child" : "root",
        dialogOpened: dialog || null,
        compoundActionVersion: COMPOUND_ACTION_VERSION,
        after: afterResult,
        ...refContext,
        tabCreationSequenceBefore,
        tabCreationSequenceAfter: tabCreationSequence,
        openedTabs,
        downloadCreationSequenceBefore,
        downloadCreationSequenceAfter: downloadCreationSequence,
        downloadCreationsObserved: Math.max(0, downloadCreationSequence - downloadCreationSequenceBefore),
        downloadsStartedTruncated: Math.max(0, downloadCreationSequence - downloadCreationSequenceBefore) > downloadsStarted.length,
        downloadsStarted,
    };
}
async function browserDoubleClick(args = {}) {
    const result = await browserClick({ ...args, clickCount: 2 });
    return {
        ...result,
        doubleClickVersion: DOUBLE_CLICK_VERSION,
    };
}
async function performHtml5Drag({ tab, sourceRefValue, targetRefValue, sourceTarget, sourcePoint, targetPoint, stepCount, boundedDurationMs, dialogSequenceBefore, tabCreationSequenceBefore, downloadCreationSequenceBefore, }) {
    if (typeof tab.id !== "number" || !Number.isSafeInteger(tab.id) || tab.id < 1) {
        throw new Error("HTML5 drag requires a valid Chrome tab id");
    }
    const interceptState = beginHtml5DragIntercept(tab.id);
    const stepDelay = Math.max(0, Math.floor(boundedDurationMs / stepCount));
    let interceptEnabled = false;
    let pointerDown = false;
    let actionDispatched = false;
    let dialog = null;
    let dragData = null;
    let dragDataSummary = null;
    let dropDispatched = false;
    try {
        await send(tab.id, "Input.setInterceptDrags", { enabled: true });
        interceptEnabled = true;
        interceptState.armed = true;
        const pressPromise = send(tab.id, "Input.dispatchMouseEvent", {
            type: "mousePressed",
            ...sourcePoint,
            button: "left",
            buttons: 1,
            clickCount: 1,
        });
        dialog = await settleCommandOrDialog(tab.id, pressPromise, dialogSequenceBefore);
        if (!dialog) {
            pointerDown = true;
            actionDispatched = true;
            for (let index = 1; index <= stepCount && !interceptState.settled; index += 1) {
                const progress = index / stepCount;
                const point = {
                    x: sourcePoint.x + (targetPoint.x - sourcePoint.x) * progress,
                    y: sourcePoint.y + (targetPoint.y - sourcePoint.y) * progress,
                };
                const movePromise = send(tab.id, "Input.dispatchMouseEvent", {
                    type: "mouseMoved",
                    ...point,
                    button: "left",
                    buttons: 1,
                });
                dialog = await settleCommandOrDialog(tab.id, movePromise, dialogSequenceBefore);
                if (dialog)
                    break;
                if (stepDelay > 0 && index < stepCount && !interceptState.settled)
                    await sleep(stepDelay);
            }
            if (!dialog && !interceptState.settled) {
                const repeatMovePromise = send(tab.id, "Input.dispatchMouseEvent", {
                    type: "mouseMoved",
                    ...targetPoint,
                    button: "left",
                    buttons: 1,
                });
                dialog = await settleCommandOrDialog(tab.id, repeatMovePromise, dialogSequenceBefore);
            }
            if (!dialog) {
                const intercepted = normalizeHtml5DragData(await interceptState.promise);
                dragData = intercepted.data;
                dragDataSummary = intercepted.summary;
                await send(tab.id, "Input.dispatchDragEvent", { type: "dragEnter", ...targetPoint, data: dragData });
                await send(tab.id, "Input.dispatchDragEvent", { type: "dragOver", ...targetPoint, data: dragData });
                await send(tab.id, "Input.dispatchDragEvent", { type: "dragOver", ...targetPoint, data: dragData });
                await send(tab.id, "Input.dispatchDragEvent", { type: "drop", ...targetPoint, data: dragData });
                dropDispatched = true;
            }
        }
    }
    catch (error) {
        if (dragData && !dropDispatched) {
            await send(tab.id, "Input.dispatchDragEvent", {
                type: "dragCancel",
                ...targetPoint,
                data: dragData,
            }).catch(() => { });
        }
        await send(tab.id, "Input.cancelDragging", {}).catch(() => { });
        throw error;
    }
    finally {
        rejectPendingHtml5DragIntercept(tab.id, "HTML5 drag interception was cancelled before completion");
        if (pointerDown) {
            await send(tab.id, "Input.dispatchMouseEvent", {
                type: "mouseReleased",
                ...targetPoint,
                button: "left",
                buttons: 0,
                clickCount: 1,
            }).catch(() => { });
        }
        if (interceptEnabled)
            await send(tab.id, "Input.setInterceptDrags", { enabled: false }).catch(() => { });
        if (actionDispatched)
            refStates.delete(tab.id);
        scheduleDetach(tab.id, 250);
    }
    const [openedTabs, downloadsStarted] = await Promise.all([
        discoverNewTabs(tabCreationSequenceBefore, tab.id),
        discoverNewDownloads(downloadCreationSequenceBefore),
    ]);
    return {
        html5DragVersion: HTML5_DRAG_VERSION,
        mode: "html5",
        tabId: tab.id,
        sourceRef: sourceRefValue,
        targetRef: targetRefValue,
        sourcePoint,
        targetPoint,
        frameId: sourceTarget.frameId,
        sessionScope: "root",
        steps: stepCount,
        durationMs: boundedDurationMs,
        actionDispatched,
        dropDispatched,
        dragDataSummary,
        dialogOpened: dialog || null,
        tabCreationSequenceBefore,
        tabCreationSequenceAfter: tabCreationSequence,
        openedTabs,
        downloadCreationSequenceBefore,
        downloadCreationSequenceAfter: downloadCreationSequence,
        downloadCreationsObserved: Math.max(0, downloadCreationSequence - downloadCreationSequenceBefore),
        downloadsStartedTruncated: Math.max(0, downloadCreationSequence - downloadCreationSequenceBefore) > downloadsStarted.length,
        downloadsStarted,
    };
}
function pointInsideViewport(point, viewport) {
    if (!point || !viewport)
        return false;
    return (point.x >= viewport.x &&
        point.y >= viewport.y &&
        point.x <= viewport.x + viewport.width &&
        point.y <= viewport.y + viewport.height);
}
async function browserDrag({ tabId, sourceRef, targetRef, mode = "pointer", steps = 8, durationMs = 350, agentName, after } = {}) {
    const sourceRefValue = String(sourceRef || "");
    const targetRefValue = String(targetRef || "");
    const dragMode = String(mode || "pointer").toLowerCase();
    if (!/^@e\d+$/.test(sourceRefValue) || !/^@e\d+$/.test(targetRefValue)) {
        throw new Error("sourceRef and targetRef must be snapshot refs such as @e3");
    }
    if (!new Set(["pointer", "html5"]).has(dragMode))
        throw new Error(`Unsupported drag mode: ${dragMode}`);
    if (sourceRefValue === targetRefValue)
        throw new Error("Semantic drag requires different sourceRef and targetRef values");
    const tab = await chooseTab(tabId);
    if (typeof tab.id !== "number" || !Number.isSafeInteger(tab.id) || tab.id < 1) {
        throw new Error("Semantic drag requires a valid Chrome tab id");
    }
    const afterConfig = normalizeActionAfter(after, tab.id, "drag");
    const sourceContext = captureRefContextSource(tab.id);
    await requireDebuggableTab(tab.id);
    await attachTab(tab.id);
    const sourceTarget = lookupRef(tab.id, sourceRefValue);
    const destinationTarget = lookupRef(tab.id, targetRefValue);
    if (sourceTarget.frameId !== destinationTarget.frameId ||
        (sourceTarget.sessionId || null) !== (destinationTarget.sessionId || null)) {
        throw new Error("Semantic drag is limited to source and target refs in the same frame");
    }
    if (sourceTarget.sessionId || destinationTarget.sessionId) {
        throw new Error("Semantic drag for OOPIF targets is not supported safely yet; use refs in the root session");
    }
    const existingDialog = currentDialogRecord(tab.id);
    if (existingDialog) {
        return {
            ...(dragMode === "html5" ? { html5DragVersion: HTML5_DRAG_VERSION } : { pointerDragVersion: POINTER_DRAG_VERSION }),
            mode: dragMode,
            tabId: tab.id,
            sourceRef: sourceRefValue,
            targetRef: targetRefValue,
            actionDispatched: false,
            blockedByDialog: true,
            dialogOpened: existingDialog.dialog,
            compoundActionVersion: COMPOUND_ACTION_VERSION,
            after: afterConfig ? { ok: false, skipped: true, reason: "blocked_by_dialog" } : null,
            ...refOperationMetadata(tab.id, sourceContext, { validReason: "blocked_by_dialog" }),
        };
    }
    const stepCount = Math.max(2, Math.min(Math.floor(Number(steps) || 8), 32));
    const boundedDurationMs = Math.max(100, Math.min(Math.floor(Number(durationMs) || 350), 2_000));
    const tabCreationSequenceBefore = tabCreationSequence;
    const downloadCreationSequenceBefore = downloadCreationSequence;
    const dialogSequenceBefore = dialogSequence;
    const moved = await moveAgentCursorToRef(tab.id, sourceRefValue, { pulse: true, agentName });
    const targetPointInfo = await refPoint(tab.id, targetRefValue);
    const metrics = await send(tab.id, "Page.getLayoutMetrics");
    const rawViewport = metrics?.cssLayoutViewport || metrics?.layoutViewport;
    const viewport = rawViewport
        ? {
            x: Number(rawViewport.pageX || 0),
            y: Number(rawViewport.pageY || 0),
            width: Number(rawViewport.clientWidth || rawViewport.width || 0),
            height: Number(rawViewport.clientHeight || rawViewport.height || 0),
        }
        : null;
    if (!pointInsideViewport(targetPointInfo.point, viewport)) {
        throw new Error("Semantic drag target must be visible in the current viewport; scroll first and take a fresh snapshot");
    }
    const sourcePoint = moved.point;
    const targetPoint = targetPointInfo.point;
    if (dragMode === "html5") {
        const result = await performHtml5Drag({
            tab,
            sourceRefValue,
            targetRefValue,
            sourceTarget,
            sourcePoint,
            targetPoint,
            stepCount,
            boundedDurationMs,
            dialogSequenceBefore,
            tabCreationSequenceBefore,
            downloadCreationSequenceBefore,
        });
        const afterResult = result.dialogOpened || !afterConfig
            ? (afterConfig ? { ok: false, skipped: true, reason: "dialog_opened" } : null)
            : await runActionAfter(tab.id, afterConfig);
        scheduleActionDetach(tab.id, { afterResult });
        const refContext = refOperationMetadata(tab.id, sourceContext, {
            validReason: "compound_snapshot_created",
            invalidReason: result.dialogOpened ? "dialog_opened" : "action_invalidated_snapshot",
        });
        return {
            ...result,
            compoundActionVersion: COMPOUND_ACTION_VERSION,
            after: afterResult,
            ...refContext,
        };
    }
    const stepDelay = Math.max(0, Math.floor(boundedDurationMs / stepCount));
    let dialog = null;
    let pointerDown = false;
    let actionDispatched = false;
    try {
        const pressPromise = send(tab.id, "Input.dispatchMouseEvent", {
            type: "mousePressed",
            ...sourcePoint,
            button: "left",
            buttons: 1,
            clickCount: 1,
        });
        dialog = await settleCommandOrDialog(tab.id, pressPromise, dialogSequenceBefore);
        if (!dialog) {
            pointerDown = true;
            actionDispatched = true;
            for (let index = 1; index <= stepCount; index += 1) {
                const progress = index / stepCount;
                const point = {
                    x: sourcePoint.x + (targetPoint.x - sourcePoint.x) * progress,
                    y: sourcePoint.y + (targetPoint.y - sourcePoint.y) * progress,
                };
                const movePromise = send(tab.id, "Input.dispatchMouseEvent", {
                    type: "mouseMoved",
                    ...point,
                    button: "left",
                    buttons: 1,
                });
                dialog = await settleCommandOrDialog(tab.id, movePromise, dialogSequenceBefore);
                if (dialog)
                    break;
                if (stepDelay > 0 && index < stepCount)
                    await sleep(stepDelay);
            }
        }
        if (!dialog && pointerDown) {
            const releasePromise = send(tab.id, "Input.dispatchMouseEvent", {
                type: "mouseReleased",
                ...targetPoint,
                button: "left",
                buttons: 0,
                clickCount: 1,
            });
            dialog = await settleCommandOrDialog(tab.id, releasePromise, dialogSequenceBefore);
            pointerDown = false;
        }
    }
    finally {
        if (pointerDown) {
            await send(tab.id, "Input.dispatchMouseEvent", {
                type: "mouseReleased",
                ...targetPoint,
                button: "left",
                buttons: 0,
                clickCount: 1,
            }).catch(() => { });
        }
        if (actionDispatched)
            refStates.delete(tab.id);
        scheduleDetach(tab.id, 250);
    }
    const [openedTabs, downloadsStarted] = await Promise.all([
        discoverNewTabs(tabCreationSequenceBefore, tab.id),
        discoverNewDownloads(downloadCreationSequenceBefore),
    ]);
    const afterResult = dialog || !afterConfig
        ? (afterConfig ? { ok: false, skipped: true, reason: "dialog_opened" } : null)
        : await runActionAfter(tab.id, afterConfig);
    scheduleActionDetach(tab.id, { afterResult });
    const refContext = refOperationMetadata(tab.id, sourceContext, {
        validReason: "compound_snapshot_created",
        invalidReason: dialog ? "dialog_opened" : "action_invalidated_snapshot",
    });
    return {
        pointerDragVersion: POINTER_DRAG_VERSION,
        mode: "pointer",
        tabId: tab.id,
        sourceRef: sourceRefValue,
        targetRef: targetRefValue,
        sourcePoint,
        targetPoint,
        frameId: sourceTarget.frameId,
        sessionScope: "root",
        steps: stepCount,
        durationMs: boundedDurationMs,
        actionDispatched,
        dialogOpened: dialog || null,
        compoundActionVersion: COMPOUND_ACTION_VERSION,
        after: afterResult,
        ...refContext,
        tabCreationSequenceBefore,
        tabCreationSequenceAfter: tabCreationSequence,
        openedTabs,
        downloadCreationSequenceBefore,
        downloadCreationSequenceAfter: downloadCreationSequence,
        downloadCreationsObserved: Math.max(0, downloadCreationSequence - downloadCreationSequenceBefore),
        downloadsStartedTruncated: Math.max(0, downloadCreationSequence - downloadCreationSequenceBefore) > downloadsStarted.length,
        downloadsStarted,
    };
}
async function refPoint(tabId, ref) {
    const target = lookupRef(tabId, ref);
    const box = await send(tabId, "DOM.getBoxModel", { backendNodeId: target.backendNodeId }, target.sessionId);
    const quad = box?.model?.border || box?.model?.content;
    if (!Array.isArray(quad) || quad.length < 8 || !quad.slice(0, 8).every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))) {
        throw new Error(`Element has no visible box: ${ref}`);
    }
    return { point: quadCenter(quad), sessionId: target.sessionId || null, frameId: target.frameId };
}
async function browserHover({ tabId, ref, agentName }) {
    const tab = await chooseTab(tabId);
    if (typeof tab.id !== "number" || !Number.isSafeInteger(tab.id) || tab.id < 1) {
        throw new Error("Hover requires a valid Chrome tab id");
    }
    if (typeof ref !== "string" || !ref)
        throw new Error("Hover requires a snapshot ref");
    const sourceContext = captureRefContextSource(tab.id);
    await requireDebuggableTab(tab.id);
    await attachTab(tab.id);
    const moved = await moveAgentCursorToRefWithRevalidation(tab.id, ref, { agentName });
    if (!moved.target) {
        scheduleDetach(tab.id);
        return {
            actionabilityVersion: ACTIONABILITY_VERSION, tabId: tab.id, ref, hovered: false,
            actionabilityRecovered: false, actionabilityReason: moved.actionabilityReason,
            revalidationAttempted: moved.revalidationAttempted, revalidatedSnapshotId: moved.revalidatedSnapshotId,
            revalidatedRef: moved.revalidatedRef || null, revalidationStatus: moved.revalidationStatus || null,
            retryableStale: Boolean(moved.retryableStale), freshSnapshotRequired: true, refContextValid: false,
            refContextReason: moved.actionabilityReason, currentDocumentGeneration: currentDocumentGeneration(tab.id),
        };
    }
    refStates.delete(tab.id);
    scheduleDetach(tab.id);
    return {
        actionabilityVersion: ACTIONABILITY_VERSION,
        actionabilityRecovered: moved.actionabilityRecovered, actionabilityReason: moved.actionabilityReason,
        revalidationAttempted: moved.revalidationAttempted, revalidatedSnapshotId: moved.revalidatedSnapshotId,
        revalidatedRef: moved.revalidatedRef || null, revalidationStatus: moved.revalidationStatus || null,
        tabId: tab.id,
        ref,
        point: moved.point,
        frameId: moved.frameId,
        sessionScope: moved.sessionId ? "child" : "root",
        ...refOperationMetadata(tab.id, sourceContext, { invalidReason: "hover_invalidated_snapshot" }),
    };
}
async function browserScrollIntoView({ tabId, ref, agentName }) {
    const tab = await chooseTab(tabId);
    if (typeof tab.id !== "number" || !Number.isSafeInteger(tab.id) || tab.id < 1) {
        throw new Error("Scroll into view requires a valid Chrome tab id");
    }
    if (typeof ref !== "string" || !ref)
        throw new Error("Scroll into view requires a snapshot ref");
    const sourceContext = captureRefContextSource(tab.id);
    await requireDebuggableTab(tab.id);
    await attachTab(tab.id);
    const moved = await moveAgentCursorToRefWithRevalidation(tab.id, ref, { agentName });
    if (!moved.target) {
        scheduleDetach(tab.id);
        return {
            actionabilityVersion: ACTIONABILITY_VERSION, tabId: tab.id, ref, scrolledIntoView: false,
            actionabilityRecovered: false, actionabilityReason: moved.actionabilityReason,
            revalidationAttempted: moved.revalidationAttempted, revalidatedSnapshotId: moved.revalidatedSnapshotId,
            revalidatedRef: moved.revalidatedRef || null, revalidationStatus: moved.revalidationStatus || null,
            retryableStale: Boolean(moved.retryableStale), freshSnapshotRequired: true, refContextValid: false,
            refContextReason: moved.actionabilityReason, currentDocumentGeneration: currentDocumentGeneration(tab.id),
        };
    }
    refStates.delete(tab.id);
    scheduleDetach(tab.id);
    return {
        actionabilityVersion: ACTIONABILITY_VERSION,
        actionabilityRecovered: moved.actionabilityRecovered, actionabilityReason: moved.actionabilityReason,
        revalidationAttempted: moved.revalidationAttempted, revalidatedSnapshotId: moved.revalidatedSnapshotId,
        revalidatedRef: moved.revalidatedRef || null, revalidationStatus: moved.revalidationStatus || null,
        tabId: tab.id,
        ref,
        scrolledIntoView: true,
        point: moved.point,
        frameId: moved.frameId,
        sessionScope: moved.sessionId ? "child" : "root",
        ...refOperationMetadata(tab.id, sourceContext, { invalidReason: "scroll_into_view_invalidated_snapshot" }),
    };
}
async function browserRefInfo({ tabId, ref }) {
    const tab = await chooseTab(tabId);
    if (typeof tab.id !== "number" || !Number.isSafeInteger(tab.id) || tab.id < 1) {
        throw new Error("Ref inspection requires a valid Chrome tab id");
    }
    if (typeof ref !== "string" || !ref)
        throw new Error("Ref inspection requires a snapshot ref");
    const sourceContext = captureRefContextSource(tab.id);
    await requireDebuggableTab(tab.id);
    await attachTab(tab.id);
    const target = lookupRef(tab.id, ref);
    const live = await inspectLiveRef(tab.id, ref);
    let box = null;
    let clickPoint = null;
    let clickable = false;
    let actionabilityReason = live.exists ? (live.visible ? (live.enabled ? "no_clickable_box" : "disabled") : "not_visible") : "missing";
    let state = {};
    if (live.exists) {
        const model = await send(tab.id, "DOM.getBoxModel", { backendNodeId: target.backendNodeId }, target.sessionId).catch(() => null);
        const quad = model?.model?.border || model?.model?.content;
        if (Array.isArray(quad) && quad.length >= 8 && quad.slice(0, 8).every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))) {
            const xs = [quad[0], quad[2], quad[4], quad[6]].map(Number);
            const ys = [quad[1], quad[3], quad[5], quad[7]].map(Number);
            box = {
                x: Math.min(...xs),
                y: Math.min(...ys),
                width: Math.max(...xs) - Math.min(...xs),
                height: Math.max(...ys) - Math.min(...ys),
            };
            if (live.visible && live.enabled) {
                try {
                    clickPoint = await verifiedClickablePoint(tab.id, target, quad, ref);
                    clickable = true;
                    actionabilityReason = "clickable";
                }
                catch (error) {
                    actionabilityReason = /unobscured clickable point/i.test(errorMessage(error))
                        ? "obscured_or_unhittable"
                        : "hit_test_failed";
                }
            }
        }
        const resolved = await send(tab.id, "DOM.resolveNode", { backendNodeId: target.backendNodeId }, target.sessionId);
        const objectId = resolved?.object?.objectId;
        if (objectId) {
            const evaluated = await send(tab.id, "Runtime.callFunctionOn", {
                objectId,
                functionDeclaration: `function() {
          const value = ('value' in this ? this.value : (this.isContentEditable ? this.textContent : null));
          return {
            checked: 'checked' in this ? Boolean(this.checked) : (this.getAttribute?.('aria-checked') === 'true' ? true : this.getAttribute?.('aria-checked') === 'false' ? false : null),
            selected: 'selected' in this ? Boolean(this.selected) : (this.getAttribute?.('aria-selected') === 'true' ? true : this.getAttribute?.('aria-selected') === 'false' ? false : null),
            expanded: this.getAttribute?.('aria-expanded') === 'true' ? true : this.getAttribute?.('aria-expanded') === 'false' ? false : null,
            pressed: this.getAttribute?.('aria-pressed') === 'true' ? true : this.getAttribute?.('aria-pressed') === 'false' ? false : null,
            readOnly: Boolean(this.readOnly) || this.getAttribute?.('aria-readonly') === 'true',
            editable: Boolean(this.isContentEditable) || ['INPUT', 'TEXTAREA'].includes(String(this.tagName || '').toUpperCase()),
            tagName: String(this.tagName || '').toLowerCase() || null,
            value: value == null ? null : String(value).slice(0, 2000),
          };
        }`,
                returnByValue: true,
            }, target.sessionId);
            state = evaluated?.result?.value || {};
        }
    }
    scheduleDetach(tab.id);
    return {
        actionabilityVersion: ACTIONABILITY_VERSION,
        tabId: tab.id,
        ref,
        role: target.role || null,
        name: target.name || "",
        frameId: target.frameId,
        sessionScope: target.sessionId ? "child" : "root",
        ...live,
        clickable,
        clickPoint,
        actionabilityReason,
        ...state,
        box,
        ...refOperationMetadata(tab.id, sourceContext, { validReason: "ref_inspected" }),
    };
}
async function browserScroll({ tabId, direction = "down", pixels = 600, ref, agentName }) {
    const tab = await chooseTab(tabId);
    if (typeof tab.id !== "number" || !Number.isSafeInteger(tab.id) || tab.id < 1) {
        throw new Error("Scroll requires a valid Chrome tab id");
    }
    const sourceContext = ref ? captureRefContextSource(tab.id) : null;
    await requireDebuggableTab(tab.id);
    await attachTab(tab.id);
    await send(tab.id, "Page.bringToFront");
    const amount = Math.max(1, Math.min(Math.abs(Number(pixels) || 600), 20_000));
    let point = { x: 500, y: 400 };
    let sessionId = null;
    if (ref) {
        const moved = await moveAgentCursorToRef(tab.id, ref, { agentName });
        if (!moved.point)
            throw new Error(`Scroll ref has no actionable point: ${ref}`);
        point = moved.point;
        sessionId = moved.sessionId;
    }
    else {
        const metrics = await send(tab.id, "Page.getLayoutMetrics");
        const viewport = metrics?.cssLayoutViewport || metrics?.layoutViewport;
        if (viewport && typeof viewport.clientWidth === "number" && typeof viewport.clientHeight === "number")
            point = { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 };
        await showAgentCursor(tab.id, point, null, { agentName });
        await send(tab.id, "Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
    }
    const deltas = {
        up: { deltaX: 0, deltaY: -amount },
        down: { deltaX: 0, deltaY: amount },
        left: { deltaX: -amount, deltaY: 0 },
        right: { deltaX: amount, deltaY: 0 },
    };
    const delta = deltas[String(direction).toLowerCase()];
    if (!delta)
        throw new Error(`Unsupported scroll direction: ${direction}`);
    await send(tab.id, "Input.dispatchMouseEvent", { type: "mouseWheel", ...point, ...delta }, sessionId);
    refStates.delete(tab.id);
    scheduleDetach(tab.id);
    return {
        tabId: tab.id,
        direction: String(direction).toLowerCase(),
        pixels: amount,
        point,
        ...(ref ? refOperationMetadata(tab.id, sourceContext, { invalidReason: "scroll_invalidated_snapshot" }) : {}),
    };
}
async function browserSelect({ tabId, ref, option, agentName, after }) {
    const tab = await chooseTab(tabId);
    if (typeof tab.id !== "number" || !Number.isSafeInteger(tab.id) || tab.id < 1) {
        throw new Error("Select requires a valid Chrome tab id");
    }
    if (typeof ref !== "string" || !ref)
        throw new Error("Select requires a snapshot ref");
    const afterConfig = normalizeActionAfter(after, tab.id, "select");
    const sourceContext = captureRefContextSource(tab.id);
    await requireDebuggableTab(tab.id);
    await attachTab(tab.id);
    const { target, point, frameId, sessionId } = await moveAgentCursorToRef(tab.id, ref, { pulse: true, agentName });
    if (!target || !point)
        throw new Error(`Select target is no longer actionable: ${ref}`);
    const resolved = await send(tab.id, "DOM.resolveNode", { backendNodeId: target.backendNodeId }, target.sessionId);
    const objectId = resolved?.object?.objectId;
    if (!objectId)
        throw new Error(`Unable to resolve element: ${ref}`);
    const result = await send(tab.id, "Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `function(wanted) {
      const options = Array.from(this.options || []);
      const match = options.find((item) => item.value === wanted)
        || options.find((item) => (item.label || item.textContent || '').trim() === wanted);
      if (!match) throw new Error('Option not found: ' + wanted);
      this.value = match.value;
      this.dispatchEvent(new Event('input', { bubbles: true }));
      this.dispatchEvent(new Event('change', { bubbles: true }));
      const selected = Array.from(this.selectedOptions || []).some((item) => item === match || item.value === match.value);
      return { value: this.value, label: (match.label || match.textContent || '').trim(), selected };
    }`,
        arguments: [{ value: String(option) }],
        returnByValue: true,
    }, target.sessionId);
    if (result?.exceptionDetails)
        throw new Error(result.exceptionDetails?.text || `Unable to select option: ${option}`);
    const outcome = cdpObject(result?.result?.value) || {};
    if (outcome.selected !== true)
        throw new Error(`Select postcondition failed for ${ref}`);
    refStates.delete(tab.id);
    const afterResult = await runActionAfter(tab.id, afterConfig);
    scheduleActionDetach(tab.id, { afterResult });
    const refContext = refOperationMetadata(tab.id, sourceContext, {
        validReason: "compound_snapshot_created",
        invalidReason: "action_invalidated_snapshot",
    });
    return {
        tabId: tab.id,
        ref,
        point,
        frameId,
        sessionScope: sessionId ? "child" : "root",
        ...outcome,
        compoundActionVersion: COMPOUND_ACTION_VERSION,
        after: afterResult,
        ...refContext,
    };
}
function normalizeRangeRequest(value, percent) {
    const hasValue = value != null;
    const hasPercent = percent != null;
    if (hasValue === hasPercent)
        throw new Error("range_set requires exactly one of value or percent");
    if (hasValue) {
        const requestedValue = Number(value);
        if (!Number.isFinite(requestedValue))
            throw new Error("range_set value must be a finite number");
        return { mode: "value", requestedValue, requestedPercent: null };
    }
    const requestedPercent = Number(percent);
    if (!Number.isFinite(requestedPercent) || requestedPercent < 0 || requestedPercent > 1) {
        throw new Error("range_set percent must be between 0 and 1");
    }
    return { mode: "percent", requestedValue: null, requestedPercent };
}
async function readRangeState(tabId, target) {
    const resolved = await send(tabId, "DOM.resolveNode", { backendNodeId: target.backendNodeId }, target.sessionId);
    const objectId = resolved?.object?.objectId;
    if (!objectId)
        throw new Error("Unable to resolve range control");
    const result = await send(tabId, "Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `function() {
      const __equinoxRangeState = true;
      const tag = String(this.tagName || '').toUpperCase();
      const type = String(this.type || '').toLowerCase();
      const role = String(this.getAttribute?.('role') || '').toLowerCase();
      const nativeRange = tag === 'INPUT' && type === 'range';
      const ariaSlider = role === 'slider';
      if (!nativeRange && !ariaSlider) return { supported: false, tag: tag.toLowerCase() || null, role: role || null };
      const numberOrNull = (raw) => {
        if (raw == null || raw === '') return null;
        const number = Number(raw);
        return Number.isFinite(number) ? number : null;
      };
      const min = nativeRange ? numberOrNull(this.min) ?? 0 : numberOrNull(this.getAttribute('aria-valuemin'));
      const max = nativeRange ? numberOrNull(this.max) ?? 100 : numberOrNull(this.getAttribute('aria-valuemax'));
      const current = nativeRange ? numberOrNull(this.value) : numberOrNull(this.getAttribute('aria-valuenow'));
      const step = nativeRange ? numberOrNull(this.step) : numberOrNull(this.getAttribute('aria-valuestep'));
      const orientation = String(this.getAttribute?.('aria-orientation') || 'horizontal').toLowerCase();
      return {
        supported: true,
        kind: nativeRange ? 'native' : 'aria',
        min,
        max,
        current,
        step,
        orientation: orientation === 'vertical' ? 'vertical' : 'horizontal',
      };
    }`,
        returnByValue: true,
    }, target.sessionId);
    if (result?.exceptionDetails)
        throw new Error(result.exceptionDetails?.text || "Unable to inspect range control");
    const observed = result?.result?.value;
    if (observed != null && (typeof observed !== "object" || Array.isArray(observed))) {
        throw new Error("Range control returned invalid state");
    }
    const state = observed;
    return {
        objectId,
        supported: state?.supported === true,
        kind: state?.kind === "native" || state?.kind === "aria" ? state.kind : null,
        min: state?.min,
        max: state?.max,
        current: state?.current,
        step: state?.step,
        orientation: state?.orientation === "vertical" ? "vertical" : "horizontal",
    };
}
function rangeTargetFromRequest(request, state) {
    const min = Number(state?.min);
    const max = Number(state?.max);
    if (!state?.supported || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
        throw new Error("Range control must expose a finite min/max interval");
    }
    const target = request.mode === "percent"
        ? min + (max - min) * request.requestedPercent
        : request.requestedValue;
    if (!Number.isFinite(target) || target < min || target > max) {
        throw new Error(`Requested range value must be between ${min} and ${max}`);
    }
    return { min, max, target, percent: (target - min) / (max - min) };
}
function rangeVerificationTolerance(state, min, max) {
    const step = Number(state?.step);
    if (Number.isFinite(step) && step > 0)
        return Math.max(step * 0.51, 1e-9);
    return Math.max((max - min) * 0.02, 1e-9);
}
async function browserRangeSet({ tabId, ref, value, percent, agentName, after } = {}) {
    const request = normalizeRangeRequest(value, percent);
    const tab = await chooseTab(tabId);
    if (typeof tab.id !== "number" || !Number.isSafeInteger(tab.id) || tab.id < 1)
        throw new Error("Range set requires a valid Chrome tab id");
    if (typeof ref !== "string" || !ref)
        throw new Error("Range set requires a snapshot ref");
    const afterConfig = normalizeActionAfter(after, tab.id, "range_set");
    const sourceContext = captureRefContextSource(tab.id);
    await requireDebuggableTab(tab.id);
    await attachTab(tab.id);
    const moved = await moveAgentCursorToRefWithRevalidation(tab.id, ref, { pulse: true, agentName });
    if (!moved.target) {
        scheduleDetach(tab.id);
        return {
            rangeVersion: RANGE_VERSION, actionabilityVersion: ACTIONABILITY_VERSION,
            tabId: tab.id, ref, actionDispatched: false, primaryActionSucceeded: false, outcomeUncertain: false,
            actionabilityRecovered: false, actionabilityReason: moved.actionabilityReason,
            revalidationAttempted: moved.revalidationAttempted, revalidatedSnapshotId: moved.revalidatedSnapshotId,
            revalidatedRef: moved.revalidatedRef || null, revalidationStatus: moved.revalidationStatus || null,
            retryableStale: Boolean(moved.retryableStale), freshSnapshotRequired: true, refContextValid: false,
            refContextReason: moved.actionabilityReason, currentDocumentGeneration: currentDocumentGeneration(tab.id),
            compoundActionVersion: COMPOUND_ACTION_VERSION,
            after: afterConfig ? { ok: false, skipped: true, reason: "primary_action_not_dispatched" } : null,
        };
    }
    const target = moved.target;
    let state;
    try {
        state = await readRangeState(tab.id, target);
    }
    catch (error) {
        if (!isTransientRefActionabilityError(error))
            throw error;
        scheduleDetach(tab.id);
        return {
            rangeVersion: RANGE_VERSION, actionabilityVersion: ACTIONABILITY_VERSION,
            tabId: tab.id, ref, actionDispatched: false, primaryActionSucceeded: false, outcomeUncertain: false,
            actionabilityRecovered: moved.actionabilityRecovered, actionabilityReason: "stale_or_rerendered",
            revalidationAttempted: true, revalidatedSnapshotId: moved.revalidatedSnapshotId,
            revalidatedRef: moved.revalidatedRef || null, revalidationStatus: "range_state_stale",
            retryableStale: false, freshSnapshotRequired: true, refContextValid: false,
            refContextReason: "stale_or_rerendered", currentDocumentGeneration: currentDocumentGeneration(tab.id),
            compoundActionVersion: COMPOUND_ACTION_VERSION,
            after: afterConfig ? { ok: false, skipped: true, reason: "primary_action_not_dispatched" } : null,
        };
    }
    const normalized = rangeTargetFromRequest(request, state);
    let dispatchStarted = false;
    let dispatchFailure = null;
    try {
        if (state.kind === "native") {
            dispatchStarted = true;
            const result = await send(tab.id, "Runtime.callFunctionOn", {
                objectId: state.objectId,
                functionDeclaration: `function(wanted) {
          const __equinoxNativeRangeSet = true;
          const target = Number(wanted);
          if (!Number.isFinite(target) || String(this.tagName || '').toUpperCase() !== 'INPUT' || String(this.type || '').toLowerCase() !== 'range') {
            throw new Error('Target is not a native range input');
          }
          const prototype = Object.getPrototypeOf(this);
          const ownDescriptor = prototype ? Object.getOwnPropertyDescriptor(prototype, 'value') : null;
          const nativeDescriptor = typeof HTMLInputElement !== 'undefined'
            ? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
            : null;
          const setter = ownDescriptor?.set || nativeDescriptor?.set;
          if (typeof setter !== 'function') throw new Error('Native range value setter is unavailable');
          setter.call(this, String(target));
          this.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          this.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
          return { value: Number(this.value) };
        }`,
                arguments: [{ value: normalized.target }],
                returnByValue: true,
            }, target.sessionId);
            if (result?.exceptionDetails)
                throw new Error(result.exceptionDetails?.text || "Native range_set failed");
        }
        else if (state.kind === "aria") {
            const box = await send(tab.id, "DOM.getBoxModel", { backendNodeId: target.backendNodeId }, target.sessionId);
            const quad = box?.model?.border || box?.model?.content;
            if (!Array.isArray(quad) || quad.length < 8)
                throw new Error("ARIA slider has no visible box");
            const xs = [quad[0], quad[2], quad[4], quad[6]].map(Number);
            const ys = [quad[1], quad[3], quad[5], quad[7]].map(Number);
            const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
            if (!(right > left) || !(bottom > top))
                throw new Error("ARIA slider has an invalid box");
            const point = state.orientation === "vertical"
                ? { x: (left + right) / 2, y: bottom - normalized.percent * (bottom - top) }
                : { x: left + normalized.percent * (right - left), y: (top + bottom) / 2 };
            // Custom ARIA sliders can derive the mutation from their latest hover/pointer
            // position rather than the coordinates carried only by mousePressed. Move the
            // real pointer to the semantic target first so center-point actionability
            // probing cannot leak into the range mutation.
            await showAgentCursor(tab.id, point, target.sessionId, { agentName });
            await send(tab.id, "Input.dispatchMouseEvent", { type: "mouseMoved", ...point }, target.sessionId);
            await sleep(32);
            dispatchStarted = true;
            await send(tab.id, "Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", buttons: 1, clickCount: 1 }, target.sessionId);
            await send(tab.id, "Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", buttons: 0, clickCount: 1 }, target.sessionId);
        }
        else {
            throw new Error("Target is not a supported range control");
        }
    }
    catch (error) {
        dispatchFailure = error;
    }
    if (dispatchFailure) {
        refStates.delete(tab.id);
        scheduleDetach(tab.id);
        return {
            rangeVersion: RANGE_VERSION, actionabilityVersion: ACTIONABILITY_VERSION,
            tabId: tab.id, ref, actionDispatched: dispatchStarted, primaryActionSucceeded: false,
            outcomeUncertain: dispatchStarted, actionabilityRecovered: moved.actionabilityRecovered,
            actionabilityReason: dispatchStarted ? "post_dispatch_outcome_uncertain" : "range_not_actionable",
            revalidationAttempted: moved.revalidationAttempted, revalidatedSnapshotId: moved.revalidatedSnapshotId,
            revalidatedRef: moved.revalidatedRef || null, revalidationStatus: moved.revalidationStatus || null,
            retryableStale: false, freshSnapshotRequired: true, refContextValid: false,
            refContextReason: dispatchStarted ? "post_dispatch_outcome_uncertain" : "range_not_actionable",
            currentDocumentGeneration: currentDocumentGeneration(tab.id), compoundActionVersion: COMPOUND_ACTION_VERSION,
            after: afterConfig ? { ok: false, skipped: true, reason: dispatchStarted ? "primary_action_outcome_uncertain" : "primary_action_not_dispatched" } : null,
        };
    }
    const tolerance = rangeVerificationTolerance(state, normalized.min, normalized.max);
    let finalState = null;
    let actualValue = null;
    let verified = false;
    for (let attempt = 0; attempt < 8; attempt += 1) {
        if (attempt > 0)
            await sleep(50);
        try {
            finalState = await readRangeState(tab.id, target);
            const candidateValue = Number(finalState?.current);
            actualValue = Number.isFinite(candidateValue) ? candidateValue : null;
            verified = actualValue != null && Math.abs(actualValue - normalized.target) <= tolerance;
            if (verified)
                break;
        }
        catch (error) {
            finalState = null;
            actualValue = null;
            if (isDetachedNodeError(error))
                break;
        }
    }
    if (!verified) {
        const verificationUnavailable = actualValue == null;
        const failureReason = verificationUnavailable ? "range_postcondition_unavailable" : "range_postcondition_failed";
        refStates.delete(tab.id);
        scheduleDetach(tab.id);
        return {
            rangeVersion: RANGE_VERSION, actionabilityVersion: ACTIONABILITY_VERSION,
            tabId: tab.id, ref, actionDispatched: true, primaryActionSucceeded: false, outcomeUncertain: verificationUnavailable,
            actionabilityRecovered: moved.actionabilityRecovered, actionabilityReason: failureReason,
            requestedValue: normalized.target, actualValue,
            min: normalized.min, max: normalized.max, percent: normalized.percent, kind: state.kind,
            revalidationAttempted: moved.revalidationAttempted, revalidatedSnapshotId: moved.revalidatedSnapshotId,
            revalidatedRef: moved.revalidatedRef || null, revalidationStatus: moved.revalidationStatus || null,
            retryableStale: false, freshSnapshotRequired: true, refContextValid: false,
            refContextReason: failureReason, currentDocumentGeneration: currentDocumentGeneration(tab.id),
            compoundActionVersion: COMPOUND_ACTION_VERSION,
            after: afterConfig ? { ok: false, skipped: true, reason: verificationUnavailable ? "primary_action_outcome_uncertain" : "primary_action_postcondition_failed" } : null,
        };
    }
    refStates.delete(tab.id);
    const afterResult = await runActionAfter(tab.id, afterConfig);
    scheduleActionDetach(tab.id, { afterResult });
    const refContext = refOperationMetadata(tab.id, sourceContext, {
        validReason: "compound_snapshot_created",
        invalidReason: "action_invalidated_snapshot",
    });
    return {
        rangeVersion: RANGE_VERSION, actionabilityVersion: ACTIONABILITY_VERSION,
        tabId: tab.id, ref, actionDispatched: true, primaryActionSucceeded: true, outcomeUncertain: false,
        actionabilityRecovered: moved.actionabilityRecovered, actionabilityReason: moved.actionabilityReason,
        revalidationAttempted: moved.revalidationAttempted, revalidatedSnapshotId: moved.revalidatedSnapshotId,
        revalidatedRef: moved.revalidatedRef || null, revalidationStatus: moved.revalidationStatus || null,
        retryableStale: false, requestedValue: normalized.target, actualValue,
        min: normalized.min, max: normalized.max, percent: normalized.percent, kind: state.kind,
        orientation: state.orientation, compoundActionVersion: COMPOUND_ACTION_VERSION, after: afterResult,
        ...refContext,
    };
}
async function browserCheck({ tabId, ref, checked = true, agentName, after }) {
    const tab = await chooseTab(tabId);
    if (typeof tab.id !== "number" || !Number.isSafeInteger(tab.id) || tab.id < 1) {
        throw new Error("Check requires a valid Chrome tab id");
    }
    if (typeof ref !== "string" || !ref)
        throw new Error("Check requires a snapshot ref");
    const afterConfig = normalizeActionAfter(after, tab.id, "check");
    const sourceContext = captureRefContextSource(tab.id);
    await requireDebuggableTab(tab.id);
    await attachTab(tab.id);
    const sourceTarget = refStates.get(tab.id)?.refs?.get(ref) || null;
    if (sourceTarget?.role === "radio" && checked === false) {
        throw new Error("Radio controls cannot be unchecked directly; select another radio option instead.");
    }
    const preDispatchFailure = (moved) => {
        scheduleDetach(tab.id);
        return {
            actionabilityVersion: ACTIONABILITY_VERSION,
            tabId: tab.id,
            ref,
            checked: null,
            actionDispatched: false,
            primaryActionSucceeded: false,
            outcomeUncertain: false,
            actionabilityRecovered: false,
            actionabilityReason: moved.actionabilityReason,
            revalidationAttempted: moved.revalidationAttempted,
            revalidatedSnapshotId: moved.revalidatedSnapshotId,
            revalidatedRef: moved.revalidatedRef || null,
            revalidationStatus: moved.revalidationStatus || null,
            retryableStale: Boolean(moved.retryableStale),
            compoundActionVersion: COMPOUND_ACTION_VERSION,
            after: afterConfig ? { ok: false, skipped: true, reason: "primary_action_not_dispatched" } : null,
            refLifecycleVersion: REF_LIFECYCLE_VERSION,
            sourceSnapshotId: sourceContext.sourceSnapshotId,
            sourceDocumentGeneration: sourceContext.sourceDocumentGeneration,
            currentSnapshotId: moved.revalidatedSnapshotId || null,
            refContextValid: false,
            freshSnapshotRequired: true,
            refContextReason: moved.actionabilityReason,
            currentDocumentGeneration: currentDocumentGeneration(tab.id),
        };
    };
    let moved = await moveAgentCursorToRefWithRevalidation(tab.id, ref, { pulse: true, agentName });
    if (!moved.target)
        return preDispatchFailure(moved);
    let resolved;
    try {
        resolved = await send(tab.id, "DOM.resolveNode", { backendNodeId: moved.target.backendNodeId }, moved.target.sessionId);
    }
    catch (error) {
        if (!isTransientRefActionabilityError(error))
            throw error;
        moved = await moveAgentCursorToRefWithRevalidation(tab.id, moved.effectiveRef || ref, { pulse: true, agentName });
        if (!moved.target)
            return preDispatchFailure(moved);
        try {
            resolved = await send(tab.id, "DOM.resolveNode", { backendNodeId: moved.target.backendNodeId }, moved.target.sessionId);
        }
        catch (retryError) {
            if (!isTransientRefActionabilityError(retryError))
                throw retryError;
            return preDispatchFailure({
                ...moved,
                target: null,
                actionabilityRecovered: false,
                actionabilityReason: "stale_or_rerendered",
                revalidationAttempted: true,
                revalidationStatus: "resolve_failed_after_revalidation",
                retryableStale: false,
            });
        }
    }
    const objectId = resolved?.object?.objectId;
    if (!objectId) {
        return preDispatchFailure({
            ...moved,
            target: null,
            actionabilityRecovered: false,
            actionabilityReason: "stale_or_rerendered",
            revalidationAttempted: true,
            revalidationStatus: "resolve_missing_object",
            retryableStale: false,
        });
    }
    let result;
    try {
        result = await send(tab.id, "Runtime.callFunctionOn", {
            objectId,
            functionDeclaration: `function(wanted) {
        const desired = Boolean(wanted);
        if ('checked' in this) {
          if (Boolean(this.checked) !== desired) this.click();
          return { checked: Boolean(this.checked) };
        }
        const current = this.getAttribute('aria-checked') === 'true';
        if (current !== desired) this.click();
        return { checked: this.getAttribute('aria-checked') === 'true' };
      }`,
            arguments: [{ value: Boolean(checked) }],
            returnByValue: true,
        }, moved.target.sessionId);
    }
    catch (error) {
        if (!isDetachedNodeError(error))
            throw error;
        result = { exceptionDetails: { text: errorMessage(error) } };
    }
    const dispatchErrorText = result?.exceptionDetails?.text || result?.exceptionDetails?.exception?.description || "";
    if (dispatchErrorText && isDetachedNodeError(dispatchErrorText)) {
        refStates.delete(tab.id);
        scheduleDetach(tab.id);
        return {
            actionabilityVersion: ACTIONABILITY_VERSION,
            tabId: tab.id,
            ref,
            checked: null,
            point: moved.point,
            actionDispatched: true,
            primaryActionSucceeded: false,
            outcomeUncertain: true,
            actionabilityRecovered: moved.actionabilityRecovered,
            actionabilityReason: "post_dispatch_outcome_uncertain",
            revalidationAttempted: moved.revalidationAttempted,
            revalidatedSnapshotId: moved.revalidatedSnapshotId,
            revalidatedRef: moved.revalidatedRef || null,
            revalidationStatus: moved.revalidationStatus || null,
            retryableStale: false,
            frameId: moved.frameId,
            sessionScope: moved.sessionId ? "child" : "root",
            compoundActionVersion: COMPOUND_ACTION_VERSION,
            after: afterConfig ? { ok: false, skipped: true, reason: "primary_action_outcome_uncertain" } : null,
            refLifecycleVersion: REF_LIFECYCLE_VERSION,
            sourceSnapshotId: sourceContext.sourceSnapshotId,
            sourceDocumentGeneration: sourceContext.sourceDocumentGeneration,
            currentSnapshotId: null,
            refContextValid: false,
            freshSnapshotRequired: true,
            refContextReason: "post_dispatch_outcome_uncertain",
            currentDocumentGeneration: currentDocumentGeneration(tab.id),
        };
    }
    if (result?.exceptionDetails)
        throw new Error(result.exceptionDetails?.text || `Unable to check element: ${ref}`);
    const actualChecked = cdpObject(result?.result?.value)?.checked;
    if (actualChecked !== Boolean(checked))
        throw new Error(`Check postcondition failed for ${ref}`);
    refStates.delete(tab.id);
    const afterResult = await runActionAfter(tab.id, afterConfig);
    scheduleActionDetach(tab.id, { afterResult });
    const refContext = refOperationMetadata(tab.id, sourceContext, {
        validReason: "compound_snapshot_created",
        invalidReason: "action_invalidated_snapshot",
    });
    return {
        actionabilityVersion: ACTIONABILITY_VERSION,
        tabId: tab.id,
        ref,
        point: moved.point,
        actionDispatched: true,
        primaryActionSucceeded: true,
        outcomeUncertain: false,
        actionabilityRecovered: moved.actionabilityRecovered,
        actionabilityReason: moved.actionabilityReason,
        revalidationAttempted: moved.revalidationAttempted,
        revalidatedSnapshotId: moved.revalidatedSnapshotId,
        revalidatedRef: moved.revalidatedRef || null,
        revalidationStatus: moved.revalidationStatus || null,
        retryableStale: Boolean(moved.retryableStale),
        frameId: moved.frameId,
        sessionScope: moved.sessionId ? "child" : "root",
        checked: actualChecked,
        compoundActionVersion: COMPOUND_ACTION_VERSION,
        after: afterResult,
        ...refContext,
    };
}
async function browserWait({ tabId, milliseconds, text, urlContains, refVisible, refHidden, refExists, refEnabled, networkResponse, networkIdle = false, domStable = false, semanticReady, snapshotChanged, quietMs = 500, timeoutMs = 10_000, } = {}) {
    const tab = await chooseTab(tabId);
    if (typeof tab.id !== "number" || !Number.isSafeInteger(tab.id) || tab.id < 1) {
        throw new Error("Wait requires a valid Chrome tab id");
    }
    const requested = [
        milliseconds != null,
        Boolean(text),
        Boolean(urlContains),
        Boolean(refVisible),
        Boolean(refHidden),
        Boolean(refExists),
        Boolean(refEnabled),
        Boolean(networkResponse),
        networkIdle === true,
        domStable === true,
        Boolean(semanticReady),
        Boolean(snapshotChanged),
    ].filter(Boolean).length;
    if (requested !== 1) {
        throw new Error("Exactly one wait condition is required: milliseconds, text, urlContains, refVisible, refHidden, refExists, refEnabled, networkResponse, networkIdle, domStable, semanticReady or snapshotChanged");
    }
    const timeout = Math.max(100, Math.min(Number(timeoutMs) || 10_000, 60_000));
    const quiet = Math.max(100, Math.min(Number(quietMs) || 500, 5_000));
    if (milliseconds != null) {
        const delay = Math.max(0, Math.min(Number(milliseconds) || 0, 60_000));
        await sleep(delay);
        return { waitVersion: WAIT_VERSION, tabId: tab.id, waitedMs: delay };
    }
    const smartRef = refVisible || refHidden || refExists || refEnabled || null;
    const sourceContext = smartRef ? captureRefContextSource(tab.id) : null;
    const smartRequested = Boolean(smartRef || networkResponse || networkIdle || domStable || semanticReady || snapshotChanged);
    if (smartRequested || text) {
        await requireDebuggableTab(tab.id);
        await attachTab(tab.id);
    }
    let networkState = null;
    let networkResponseState = null;
    let stableCounter = null;
    let stableGeneration = currentDocumentGeneration(tab.id);
    let stableSince = Date.now();
    let semanticState = null;
    let semanticSince = Date.now();
    let semanticGeneration = currentDocumentGeneration(tab.id);
    let baseSnapshot = null;
    if (networkIdle) {
        networkState = {
            inflight: new Set(),
            lastActivityAt: Date.now(),
        };
        networkWaitStates.set(tab.id, networkState);
        await send(tab.id, "Network.enable");
    }
    if (networkResponse) {
        networkResponseState = {
            filters: normalizeNetworkFilters(networkResponse),
            requests: new Map(),
            matched: null,
        };
        addNetworkResponseWaitState(tab.id, networkResponseState);
        await send(tab.id, "Network.enable");
    }
    if (domStable) {
        stableCounter = await domMutationCounter(tab.id);
        stableSince = Date.now();
    }
    if (semanticReady) {
        semanticState = await semanticProjectionState(tab.id, semanticReady === true ? {} : semanticReady);
        semanticSince = Date.now();
    }
    if (snapshotChanged) {
        baseSnapshot = snapshotStateById(tab.id, String(snapshotChanged));
        if (!baseSnapshot) {
            scheduleDetach(tab.id);
            throw new Error(`Snapshot id is unavailable or outside the bounded history: ${String(snapshotChanged)}`);
        }
    }
    const deadline = Date.now() + timeout;
    try {
        while (Date.now() < deadline) {
            const current = await workerTabs().get(tab.id);
            if (urlContains && String(current.url || "").includes(String(urlContains))) {
                return { waitVersion: WAIT_VERSION, tabId: tab.id, matched: "url", url: current.url };
            }
            if (text) {
                const evaluated = await send(tab.id, "Runtime.evaluate", {
                    expression: `Boolean(document.body && document.body.innerText.includes(${JSON.stringify(String(text))}))`,
                    returnByValue: true,
                });
                if (evaluated?.result?.value === true) {
                    return { waitVersion: WAIT_VERSION, tabId: tab.id, matched: "text", text: String(text) };
                }
            }
            if (smartRef) {
                const live = await inspectLiveRef(tab.id, smartRef);
                const matched = refVisible
                    ? live.exists && live.visible
                    : refHidden
                        ? !live.exists || !live.visible
                        : refExists
                            ? live.exists
                            : live.exists && live.enabled;
                if (matched) {
                    return {
                        waitVersion: WAIT_VERSION,
                        tabId: tab.id,
                        matched: refVisible
                            ? "ref_visible"
                            : refHidden
                                ? "ref_hidden"
                                : refExists
                                    ? "ref_exists"
                                    : "ref_enabled",
                        ref: smartRef,
                        ...live,
                        ...refOperationMetadata(tab.id, sourceContext, { validReason: "wait_ref_matched" }),
                    };
                }
            }
            if (networkResponseState?.matched) {
                return {
                    waitVersion: WAIT_VERSION,
                    observationVersion: OBSERVATION_VERSION,
                    tabId: tab.id,
                    matched: "network_response",
                    response: networkResponseState.matched,
                };
            }
            if (networkIdle && networkState) {
                if (networkState.inflight.size === 0 && Date.now() - networkState.lastActivityAt >= quiet) {
                    return {
                        waitVersion: WAIT_VERSION,
                        tabId: tab.id,
                        matched: "network_idle",
                        quietMs: quiet,
                    };
                }
            }
            if (domStable) {
                const generation = currentDocumentGeneration(tab.id);
                const counter = await domMutationCounter(tab.id);
                if (generation !== stableGeneration || counter !== stableCounter) {
                    stableGeneration = generation;
                    stableCounter = counter;
                    stableSince = Date.now();
                }
                else if (Date.now() - stableSince >= quiet) {
                    return {
                        waitVersion: WAIT_VERSION,
                        tabId: tab.id,
                        matched: "dom_stable",
                        quietMs: quiet,
                        mutationCounter: counter,
                    };
                }
            }
            if (semanticReady) {
                const generation = currentDocumentGeneration(tab.id);
                const nextSemantic = await semanticProjectionState(tab.id, semanticReady === true ? {} : semanticReady);
                if (generation !== semanticGeneration || !semanticState || nextSemantic.signature !== semanticState.signature) {
                    semanticGeneration = generation;
                    semanticState = nextSemantic;
                    semanticSince = Date.now();
                }
                else {
                    semanticState = nextSemantic;
                    if (semanticState.matched && current.status === "complete" && Date.now() - semanticSince >= quiet) {
                        return {
                            waitVersion: WAIT_VERSION,
                            tabId: tab.id,
                            matched: "semantic_ready",
                            quietMs: quiet,
                            nodeCount: semanticState.nodeCount,
                            minNodes: semanticState.minNodes,
                            documentGeneration: generation,
                        };
                    }
                }
            }
            if (baseSnapshot) {
                const generation = currentDocumentGeneration(tab.id);
                if (generation !== baseSnapshot.documentGeneration) {
                    return {
                        waitVersion: WAIT_VERSION,
                        tabId: tab.id,
                        matched: "snapshot_changed",
                        snapshotId: baseSnapshot.id,
                        reason: "document_generation",
                        documentGeneration: generation,
                    };
                }
                const counter = await domMutationCounter(tab.id);
                if (baseSnapshot.mutationCounter != null &&
                    counter !== baseSnapshot.mutationCounter) {
                    return {
                        waitVersion: WAIT_VERSION,
                        tabId: tab.id,
                        matched: "snapshot_changed",
                        snapshotId: baseSnapshot.id,
                        reason: "dom_mutation",
                        mutationCounter: counter,
                    };
                }
                if (String(current.url || "") !== String(baseSnapshot.url || "")) {
                    return {
                        waitVersion: WAIT_VERSION,
                        tabId: tab.id,
                        matched: "snapshot_changed",
                        snapshotId: baseSnapshot.id,
                        reason: "url",
                        url: current.url,
                    };
                }
            }
            await sleep(100);
        }
        throw new Error(`Timed out waiting in tab ${tab.id}`);
    }
    finally {
        if (networkState && networkWaitStates.get(tab.id) === networkState) {
            networkWaitStates.delete(tab.id);
        }
        if (networkResponseState) {
            removeNetworkResponseWaitState(tab.id, networkResponseState);
        }
        if (smartRequested || text)
            scheduleDetach(tab.id);
    }
}
async function browserFill({ tabId, ref, value, submit, agentName, after }) {
    const tab = await chooseTab(tabId);
    if (typeof tab.id !== "number" || !Number.isSafeInteger(tab.id) || tab.id < 1)
        throw new Error("Fill requires a valid Chrome tab id");
    if (typeof ref !== "string" || !ref)
        throw new Error("Fill requires a snapshot ref");
    const afterConfig = normalizeActionAfter(after, tab.id, "fill");
    const submitKey = normalizeAtomicSubmit(submit, "fill");
    const sourceContext = captureRefContextSource(tab.id);
    const wanted = String(value ?? "");
    await requireDebuggableTab(tab.id);
    await attachTab(tab.id);
    const { target, point, frameId, sessionId } = await moveAgentCursorToRef(tab.id, ref, { pulse: true, agentName });
    if (!target || !point)
        throw new Error(`Fill target is no longer actionable: ${ref}`);
    const outcome = await setEditableTargetValue(tab.id, target, wanted, { label: ref });
    if (submitKey) {
        await dispatchKeyChord(tab.id, submitKey, target.sessionId || null);
        refStates.delete(tab.id);
    }
    const afterResult = await runActionAfter(tab.id, afterConfig);
    scheduleActionDetach(tab.id, { afterResult, preserveRefContext: true });
    const refContext = refOperationMetadata(tab.id, sourceContext, {
        validReason: afterResult?.snapshot ? "compound_snapshot_created" : "input_target_retained",
        invalidReason: submitKey ? "atomic_submit_invalidated_snapshot" : "no_active_snapshot",
    });
    return {
        inputVersion: INPUT_VERSION,
        tabId: tab.id,
        ref,
        point,
        frameId,
        sessionScope: sessionId ? "child" : "root",
        value: outcome.value,
        kind: outcome.kind || null,
        submit: submitKey ? { key: submitKey, dispatched: true } : null,
        compoundActionVersion: COMPOUND_ACTION_VERSION,
        after: afterResult,
        ...refContext,
    };
}
function keyEventMetadata(key, modifiers = 0) {
    const special = {
        Enter: { code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r" },
        Tab: { code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 },
        Escape: { code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 },
        Backspace: { code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 },
        Delete: { code: "Delete", windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 },
        ArrowLeft: { code: "ArrowLeft", windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 },
        ArrowUp: { code: "ArrowUp", windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 },
        ArrowRight: { code: "ArrowRight", windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 },
        ArrowDown: { code: "ArrowDown", windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 },
        " ": { code: "Space", windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32, text: " " },
    };
    const metadata = special[key] || {};
    const text = modifiers === 0 && typeof metadata.text === "string" ? metadata.text : null;
    return {
        ...(metadata.code ? { code: metadata.code } : {}),
        ...(Number.isInteger(metadata.windowsVirtualKeyCode) ? { windowsVirtualKeyCode: metadata.windowsVirtualKeyCode } : {}),
        ...(Number.isInteger(metadata.nativeVirtualKeyCode) ? { nativeVirtualKeyCode: metadata.nativeVirtualKeyCode } : {}),
        ...(text != null ? { text, unmodifiedText: text } : {}),
    };
}
function parseKeyChord(chord) {
    const parts = String(chord || "").split("+").map((item) => item.trim()).filter(Boolean);
    if (parts.length === 0)
        throw new Error("Key is required");
    let modifiers = 0;
    let key = parts.pop();
    if (!key)
        throw new Error("Key is required");
    for (const modifier of parts) {
        const normalized = modifier.toLowerCase();
        if (normalized === "alt" || normalized === "option")
            modifiers |= 1;
        else if (normalized === "ctrl" || normalized === "control")
            modifiers |= 2;
        else if (normalized === "meta" || normalized === "cmd" || normalized === "command")
            modifiers |= 4;
        else if (normalized === "shift")
            modifiers |= 8;
        else
            throw new Error(`Unsupported modifier: ${modifier}`);
    }
    const aliases = {
        esc: "Escape",
        return: "Enter",
        space: " ",
        arrowup: "ArrowUp",
        arrowdown: "ArrowDown",
        arrowleft: "ArrowLeft",
        arrowright: "ArrowRight",
    };
    key = aliases[key.toLowerCase()] || key;
    return { key, modifiers };
}
async function focusRefForInput(tabId, ref, { agentName, requireEditable = false } = {}) {
    const moved = await moveAgentCursorToRefWithRevalidation(tabId, ref, { pulse: true, agentName });
    if (!moved.target)
        throw new Error(`Semantic target became stale before keyboard dispatch: ${moved.actionabilityReason}`);
    const target = moved.target;
    const resolved = await send(tabId, "DOM.resolveNode", { backendNodeId: target.backendNodeId }, target.sessionId);
    const objectId = resolved?.object?.objectId;
    if (!objectId)
        throw new Error(`Unable to resolve element: ${ref}`);
    const focused = await send(tabId, "Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `function(requireEditable) {
      const tag = String(this.tagName || '').toUpperCase();
      const inputType = String(this.type || '').toLowerCase();
      const blockedInputTypes = new Set(['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit']);
      const editable = Boolean(this.isContentEditable) || tag === 'TEXTAREA' || (tag === 'INPUT' && !blockedInputTypes.has(inputType));
      if (requireEditable && !editable) throw new Error('Target is not a supported editable control');
      if (typeof this.focus !== 'function') throw new Error('Target cannot receive keyboard focus');
      this.focus({ preventScroll: true });
      const active = this.ownerDocument?.activeElement;
      const hasFocus = active === this || Boolean(this.contains?.(active));
      return { focused: hasFocus, editable, tagName: tag.toLowerCase() || null };
    }`,
        arguments: [{ value: Boolean(requireEditable) }],
        returnByValue: true,
    }, target.sessionId);
    if (focused?.exceptionDetails)
        throw new Error(focused.exceptionDetails?.text || `Unable to focus element: ${ref}`);
    const state = cdpObject(focused?.result?.value) || {};
    if (state.focused !== true)
        throw new Error(`Keyboard focus postcondition failed for ${ref}`);
    return { ...moved, objectId, editable: Boolean(state.editable), tagName: state.tagName || null };
}
async function readFocusedEditableValue(tabId, objectId, sessionId) {
    if (!objectId)
        return null;
    const result = await send(tabId, "Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `function() {
      if ('value' in this) return String(this.value ?? '').slice(0, 100000);
      if (this.isContentEditable) return String(this.textContent ?? '').slice(0, 100000);
      return null;
    }`,
        returnByValue: true,
    }, sessionId);
    return result?.result?.value ?? null;
}
async function dispatchKeyChord(tabId, key, sessionId = null) {
    const chord = parseKeyChord(key);
    const printable = chord.key.length === 1 && chord.modifiers === 0;
    const keyMetadata = keyEventMetadata(chord.key, chord.modifiers);
    await send(tabId, "Input.dispatchKeyEvent", {
        type: "keyDown",
        key: chord.key,
        modifiers: chord.modifiers,
        ...keyMetadata,
        ...(printable && !Object.hasOwn(keyMetadata, "text") ? { text: chord.key, unmodifiedText: chord.key } : {}),
    }, sessionId);
    await send(tabId, "Input.dispatchKeyEvent", {
        type: "keyUp",
        key: chord.key,
        modifiers: chord.modifiers,
        ...(keyMetadata.code ? { code: keyMetadata.code } : {}),
        ...(Number.isInteger(keyMetadata.windowsVirtualKeyCode) ? { windowsVirtualKeyCode: keyMetadata.windowsVirtualKeyCode } : {}),
        ...(Number.isInteger(keyMetadata.nativeVirtualKeyCode) ? { nativeVirtualKeyCode: keyMetadata.nativeVirtualKeyCode } : {}),
    }, sessionId);
    return chord;
}
function normalizeAtomicSubmit(submit, actionName) {
    if (submit == null)
        return null;
    const key = String(submit);
    if (key !== "Enter")
        throw new Error(`${actionName} submit currently supports only Enter`);
    return key;
}
async function browserPress({ tabId, key, ref, agentName, after }) {
    const tab = await chooseTab(tabId);
    if (typeof tab.id !== "number" || !Number.isSafeInteger(tab.id) || tab.id < 1)
        throw new Error("Press requires a valid Chrome tab id");
    if (ref != null && (typeof ref !== "string" || !ref))
        throw new Error("Press requires a valid snapshot ref");
    const afterConfig = normalizeActionAfter(after, tab.id, "press");
    const sourceContext = ref ? captureRefContextSource(tab.id) : null;
    await requireDebuggableTab(tab.id);
    await attachTab(tab.id);
    await send(tab.id, "Page.bringToFront");
    const focused = ref ? await focusRefForInput(tab.id, ref, { agentName }) : null;
    const sessionId = focused?.sessionId || null;
    const chord = await dispatchKeyChord(tab.id, key, sessionId);
    const afterResult = await runActionAfter(tab.id, afterConfig);
    scheduleActionDetach(tab.id, { afterResult, preserveRefContext: Boolean(ref) });
    const refContext = ref
        ? refOperationMetadata(tab.id, sourceContext, {
            validReason: afterResult?.snapshot ? "compound_snapshot_created" : "input_target_retained",
        })
        : refContextMetadata(tab.id, { validReason: afterResult?.snapshot ? "compound_snapshot_created" : "current_snapshot" });
    return {
        inputVersion: INPUT_VERSION,
        tabId: tab.id,
        key: chord.key,
        modifiers: chord.modifiers,
        ref: ref || null,
        frameId: focused?.frameId || null,
        sessionScope: sessionId ? "child" : "root",
        compoundActionVersion: COMPOUND_ACTION_VERSION,
        after: afterResult,
        ...refContext,
    };
}
async function browserTypeText({ tabId, ref, text, delayMs = 0, submit, agentName, after }) {
    const tab = await chooseTab(tabId);
    if (typeof tab.id !== "number" || !Number.isSafeInteger(tab.id) || tab.id < 1)
        throw new Error("Type text requires a valid Chrome tab id");
    if (typeof ref !== "string" || !ref)
        throw new Error("Type text requires a snapshot ref");
    const afterConfig = normalizeActionAfter(after, tab.id, "type_text");
    const submitKey = normalizeAtomicSubmit(submit, "type_text");
    const sourceContext = captureRefContextSource(tab.id);
    const value = String(text ?? "");
    if (value.length > 100_000)
        throw new Error("type_text is limited to 100000 characters");
    const boundedDelayMs = Math.max(0, Math.min(Math.floor(Number(delayMs) || 0), 200));
    await requireDebuggableTab(tab.id);
    await attachTab(tab.id);
    await send(tab.id, "Page.bringToFront");
    const focused = await focusRefForInput(tab.id, ref, { agentName, requireEditable: true });
    const sessionId = focused.sessionId || null;
    const sequential = value.length <= 2_000 && /^[\x20-\x7E]*$/.test(value);
    if (sequential) {
        for (let index = 0; index < value.length; index += 1) {
            const character = value[index];
            await send(tab.id, "Input.dispatchKeyEvent", {
                type: "keyDown",
                key: character,
                text: character,
                modifiers: 0,
            }, sessionId);
            await send(tab.id, "Input.dispatchKeyEvent", {
                type: "keyUp",
                key: character,
                modifiers: 0,
            }, sessionId);
            if (boundedDelayMs > 0 && index < value.length - 1)
                await sleep(boundedDelayMs);
        }
    }
    else if (value) {
        await send(tab.id, "Input.insertText", { text: value }, sessionId);
    }
    const actualValue = await readFocusedEditableValue(tab.id, focused.objectId, sessionId);
    if (submitKey) {
        await dispatchKeyChord(tab.id, submitKey, sessionId);
        refStates.delete(tab.id);
    }
    const afterResult = await runActionAfter(tab.id, afterConfig);
    scheduleActionDetach(tab.id, { afterResult, preserveRefContext: true });
    const refContext = refOperationMetadata(tab.id, sourceContext, {
        validReason: afterResult?.snapshot ? "compound_snapshot_created" : "input_target_retained",
        invalidReason: submitKey ? "atomic_submit_invalidated_snapshot" : "no_active_snapshot",
    });
    return {
        inputVersion: INPUT_VERSION,
        tabId: tab.id,
        ref,
        mode: sequential ? "key_events" : "insert_text",
        characters: [...value].length,
        delayMs: boundedDelayMs,
        value: actualValue,
        submit: submitKey ? { key: submitKey, dispatched: true } : null,
        frameId: focused.frameId,
        sessionScope: sessionId ? "child" : "root",
        compoundActionVersion: COMPOUND_ACTION_VERSION,
        after: afterResult,
        ...refContext,
    };
}
async function browserEval({ tabId, expression }) {
    const tab = await chooseTab(tabId);
    if (typeof tab.id !== "number" || !Number.isSafeInteger(tab.id) || tab.id < 1)
        throw new Error("Eval requires a valid Chrome tab id");
    await requireDebuggableTab(tab.id);
    await attachTab(tab.id);
    const evaluated = await send(tab.id, "Runtime.evaluate", {
        expression: String(expression || ""),
        awaitPromise: true,
        returnByValue: true,
    });
    scheduleDetach(tab.id);
    if (evaluated?.exceptionDetails) {
        throw new Error(evaluated.exceptionDetails?.text || "Runtime.evaluate failed");
    }
    return {
        tabId: tab.id,
        value: evaluated?.result?.value ?? null,
        type: evaluated?.result?.type ?? null,
    };
}
function recordTabCreation(tab) {
    if (typeof tab?.id !== "number" || !Number.isInteger(tab.id))
        return null;
    const event = {
        sequence: ++tabCreationSequence,
        createdAt: new Date().toISOString(),
        tabId: tab.id,
        windowId: tab.windowId ?? null,
        openerTabId: typeof tab.openerTabId === "number" && Number.isInteger(tab.openerTabId) ? tab.openerTabId : null,
    };
    tabCreationEvents.push(event);
    if (tabCreationEvents.length > MAX_TAB_CREATION_EVENTS) {
        tabCreationEvents.splice(0, tabCreationEvents.length - MAX_TAB_CREATION_EVENTS);
    }
    return event;
}
function workerWindows() {
    return globalThis.chrome?.windows ?? null;
}
async function browserWindowTypes() {
    const windowsApi = workerWindows();
    if (!windowsApi?.getAll)
        return new Map();
    try {
        const windows = await windowsApi.getAll({ populate: false });
        return new Map(windows.map((window) => [window.id, window.type || null]));
    }
    catch {
        return new Map();
    }
}
function publicTab(tab, { windowTypes = new Map(), creation = null } = {}) {
    const policy = classifyBrowserPage(tab);
    return {
        id: tab.id,
        windowId: tab.windowId,
        windowType: typeof tab.windowId === "number" ? windowTypes.get(tab.windowId) || null : null,
        index: tab.index,
        active: tab.active,
        pinned: tab.pinned,
        title: tab.title,
        url: tab.url,
        pendingUrl: tab.pendingUrl || null,
        status: tab.status,
        pageKind: policy.kind,
        debuggerSupported: policy.debuggerSupported,
        openerTabId: typeof tab.openerTabId === "number" && Number.isInteger(tab.openerTabId) ? tab.openerTabId : null,
        createdSequence: creation?.sequence ?? null,
        createdAt: creation?.createdAt ?? null,
    };
}
function creationEventForTab(tabId) {
    for (let index = tabCreationEvents.length - 1; index >= 0; index -= 1) {
        if (tabCreationEvents[index]?.tabId === tabId)
            return tabCreationEvents[index];
    }
    return null;
}
async function browserTabsList() {
    const [tabs, windowTypes] = await Promise.all([
        workerTabs().query({}),
        browserWindowTypes(),
    ]);
    return tabs.map((tab) => publicTab(tab, {
        windowTypes,
        creation: typeof tab.id === "number" ? creationEventForTab(tab.id) : null,
    }));
}
async function newTabsSince(sequence, { openerTabId = null } = {}) {
    const events = tabCreationEvents.filter((event) => event.sequence > sequence);
    if (events.length === 0)
        return [];
    const windowTypes = await browserWindowTypes();
    const result = [];
    const seen = new Set();
    for (const event of events) {
        if (seen.has(event.tabId))
            continue;
        seen.add(event.tabId);
        let tab;
        try {
            tab = await workerTabs().get(event.tabId);
        }
        catch {
            continue;
        }
        if (Number.isInteger(openerTabId) && tab.openerTabId !== openerTabId)
            continue;
        result.push(publicTab(tab, { windowTypes, creation: event }));
    }
    return result;
}
async function discoverNewTabs(sequence, openerTabId, graceMs = TAB_CREATION_DISCOVERY_GRACE_MS) {
    const deadline = Date.now() + Math.max(0, graceMs);
    do {
        const tabs = await newTabsSince(sequence, { openerTabId });
        if (tabs.length > 0)
            return tabs;
        if (Date.now() >= deadline)
            break;
        await sleep(25);
    } while (true);
    return [];
}
function downloadName(filename = "") {
    const normalized = String(filename || "").replace(/\\/g, "/");
    const parts = normalized.split("/").filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : null;
}
function workerDownloads() {
    return globalThis.chrome?.downloads ?? null;
}
function recordDownloadCreation(item) {
    if (typeof item?.id !== "number" || !Number.isInteger(item.id))
        return null;
    const event = {
        sequence: ++downloadCreationSequence,
        createdAt: new Date().toISOString(),
        downloadId: item.id,
    };
    downloadCreationEvents.push(event);
    if (downloadCreationEvents.length > MAX_DOWNLOAD_CREATION_EVENTS) {
        downloadCreationEvents.splice(0, downloadCreationEvents.length - MAX_DOWNLOAD_CREATION_EVENTS);
    }
    return event;
}
function creationEventForDownload(downloadId) {
    for (let index = downloadCreationEvents.length - 1; index >= 0; index -= 1) {
        if (downloadCreationEvents[index]?.downloadId === downloadId)
            return downloadCreationEvents[index];
    }
    return null;
}
function publicDownload(item, { creation = null, includeFilename = false } = {}) {
    return {
        id: item.id,
        name: downloadName(item.filename),
        mimeType: item.mime || null,
        state: item.state || null,
        danger: item.danger || null,
        paused: Boolean(item.paused),
        canResume: Boolean(item.canResume),
        bytesReceived: Number.isFinite(item.bytesReceived) ? item.bytesReceived : null,
        totalBytes: Number.isFinite(item.totalBytes) ? item.totalBytes : null,
        fileSize: Number.isFinite(item.fileSize) ? item.fileSize : null,
        exists: item.exists !== false,
        error: item.error || null,
        startTime: item.startTime || null,
        endTime: item.endTime || null,
        createdSequence: creation?.sequence ?? null,
        createdAt: creation?.createdAt ?? null,
        ...(includeFilename ? { filename: item.filename || null } : {}),
    };
}
async function downloadById(downloadId, { includeFilename = false } = {}) {
    const downloadsApi = workerDownloads();
    if (!downloadsApi?.search)
        return null;
    const items = await downloadsApi.search({ id: downloadId });
    const item = items?.[0];
    if (!item)
        return null;
    return publicDownload(item, {
        creation: creationEventForDownload(downloadId),
        includeFilename,
    });
}
async function newDownloadsSince(sequence) {
    if (!workerDownloads()?.search)
        return [];
    const events = downloadCreationEvents
        .filter((event) => event.sequence > sequence)
        .slice(0, MAX_DOWNLOADS_PER_ACTION);
    const downloads = [];
    for (const event of events) {
        const item = await downloadById(event.downloadId);
        if (item)
            downloads.push(item);
    }
    return downloads;
}
async function discoverNewDownloads(sequence, graceMs = DOWNLOAD_DISCOVERY_GRACE_MS) {
    if (!workerDownloads()?.search)
        return [];
    const deadline = Date.now() + Math.max(0, graceMs);
    do {
        const downloads = await newDownloadsSince(sequence);
        if (downloads.length > 0)
            return downloads;
        if (Date.now() >= deadline)
            break;
        await sleep(25);
    } while (true);
    return [];
}
async function browserDownloadWait({ downloadId, sinceSequence, timeoutMs = 60_000 } = {}) {
    const hasDownloadId = typeof downloadId === "number" && Number.isInteger(downloadId) && downloadId >= 0;
    const hasSinceSequence = typeof sinceSequence === "number" && Number.isInteger(sinceSequence) && sinceSequence >= 0;
    if (hasDownloadId === hasSinceSequence) {
        throw new Error("Exactly one of downloadId or sinceSequence is required");
    }
    if (!workerDownloads()?.search)
        throw new Error("Chrome downloads API is unavailable");
    const timeout = Math.max(100, Math.min(Number(timeoutMs) || 60_000, 60_000));
    const deadline = Date.now() + timeout;
    let resolvedDownloadId = hasDownloadId && typeof downloadId === "number" ? downloadId : null;
    while (Date.now() < deadline) {
        if (resolvedDownloadId == null && typeof sinceSequence === "number") {
            const next = (await newDownloadsSince(sinceSequence))[0] || null;
            if (next?.id != null)
                resolvedDownloadId = next.id;
        }
        if (resolvedDownloadId != null) {
            const item = await downloadById(resolvedDownloadId, { includeFilename: true });
            if (item && typeof item.state === "string" && new Set(["complete", "interrupted"]).has(item.state)) {
                return { downloadLifecycleVersion: DOWNLOAD_LIFECYCLE_VERSION, download: item };
            }
        }
        await sleep(100);
    }
    throw new Error(hasDownloadId
        ? `Timed out waiting for download ${downloadId}`
        : `Timed out waiting for the next download after sequence ${sinceSequence}`);
}
async function browserCreateTab({ url = "chrome://newtab/", active = false } = {}) {
    const targetUrl = validateOpenUrl(url || "chrome://newtab/");
    const tabsApi = workerTabs();
    if (!tabsApi.create)
        throw new Error("Chrome tabs.create API is unavailable");
    const tab = await tabsApi.create({ url: targetUrl, active: Boolean(active) });
    if (typeof tab?.id !== "number" || !Number.isInteger(tab.id) || tab.id < 1)
        throw new Error("Chrome did not return a created tab id.");
    const updated = await waitForTab(tab.id, (candidate) => candidate.url === targetUrl || candidate.status === "complete");
    const policy = classifyBrowserPage(updated);
    return {
        id: updated.id,
        windowId: updated.windowId,
        title: updated.title,
        url: updated.url,
        active: updated.active,
        pageKind: policy.kind,
        debuggerSupported: policy.debuggerSupported,
    };
}
async function browserHistoryNavigateViaDebugger(tab, normalizedDirection) {
    if (typeof tab.id !== "number" || !Number.isSafeInteger(tab.id) || tab.id < 1)
        throw new Error("History fallback requires a valid Chrome tab id");
    const policy = classifyBrowserPage(tab);
    if (!policy.debuggerSupported)
        throw restrictedPageError(policy);
    const persistent = observationStates.has(tab.id);
    await attachTab(tab.id, DEFAULT_ATTACH_IDLE_MS, { persistent });
    await send(tab.id, "Page.enable");
    const history = await send(tab.id, "Page.getNavigationHistory");
    const entries = Array.isArray(history?.entries) ? history.entries : [];
    const currentIndex = Number(history?.currentIndex);
    if (!Number.isInteger(currentIndex))
        throw new Error("Chrome returned an invalid navigation history index");
    const targetIndex = currentIndex + (normalizedDirection === "forward" ? 1 : -1);
    const entry = entries[targetIndex];
    if (!entry || !Number.isInteger(entry.id)) {
        throw new Error(`Cannot find a ${normalizedDirection === "forward" ? "next" : "previous"} page in Chrome navigation history`);
    }
    await send(tab.id, "Page.navigateToHistoryEntry", { entryId: entry.id });
    if (!persistent)
        scheduleDetach(tab.id);
    return entry;
}
async function browserHistoryNavigate({ tabId, direction } = {}) {
    const normalizedDirection = direction === "forward" ? "forward" : "back";
    const tab = await chooseTab(tabId);
    if (typeof tab.id !== "number" || !Number.isSafeInteger(tab.id) || tab.id < 1)
        throw new Error("History navigation requires a valid Chrome tab id");
    const initialGeneration = currentDocumentGeneration(tab.id);
    const tabsApi = workerTabs();
    const api = normalizedDirection === "forward" ? tabsApi.goForward : tabsApi.goBack;
    let navigationMethod = "tabs_api";
    let tabsApiError = null;
    if (typeof api === "function") {
        try {
            await api.call(tabsApi, tab.id);
        }
        catch (error) {
            tabsApiError = error instanceof Error ? error.message : String(error);
        }
    }
    else {
        tabsApiError = `Chrome tabs.go${normalizedDirection === "forward" ? "Forward" : "Back"} API is unavailable`;
    }
    if (tabsApiError) {
        try {
            await browserHistoryNavigateViaDebugger(tab, normalizedDirection);
            navigationMethod = "cdp_history_fallback";
        }
        catch (fallbackError) {
            const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
            throw new Error(`Chrome could not navigate ${normalizedDirection} in tab ${tab.id}: ${tabsApiError}; fallback failed: ${fallbackMessage}`);
        }
    }
    const navigation = await waitForHistoryNavigation(tab.id, tab, initialGeneration);
    const updated = navigation.tab;
    const policy = classifyBrowserPage(updated);
    return {
        navigationVersion: NAVIGATION_VERSION,
        navigationMethod,
        id: updated.id,
        windowId: updated.windowId,
        title: updated.title,
        url: updated.url,
        active: updated.active,
        pageKind: policy.kind,
        debuggerSupported: policy.debuggerSupported,
        direction: normalizedDirection,
        navigationCommitted: navigation.navigationCommitted,
        navigationTimedOut: navigation.navigationTimedOut,
        metadataSettled: navigation.metadataSettled,
        navigationSignal: navigation.navigationSignal,
    };
}
async function browserReload({ tabId, ignoreCache = false } = {}) {
    const tab = await chooseTab(tabId);
    if (typeof tab.id !== "number" || !Number.isSafeInteger(tab.id) || tab.id < 1)
        throw new Error("Reload requires a valid Chrome tab id");
    await requireDebuggableTab(tab.id);
    const persistent = observationStates.has(tab.id);
    await attachTab(tab.id, DEFAULT_ATTACH_IDLE_MS, { persistent });
    try {
        await send(tab.id, "Page.reload", { ignoreCache: Boolean(ignoreCache) });
        const updated = await waitForTab(tab.id, (candidate) => candidate.status === "complete");
        const policy = classifyBrowserPage(updated);
        return {
            navigationVersion: NAVIGATION_VERSION,
            id: updated.id,
            windowId: updated.windowId,
            title: updated.title,
            url: updated.url,
            active: updated.active,
            pageKind: policy.kind,
            debuggerSupported: policy.debuggerSupported,
            reloaded: true,
            ignoreCache: Boolean(ignoreCache),
        };
    }
    finally {
        if (!persistent)
            scheduleDetach(tab.id);
    }
}
async function browserNavigate({ tabId, url, ignoreCache = false }) {
    const targetUrl = validateOpenUrl(url);
    const tab = await chooseTab(tabId);
    if (typeof tab.id !== "number" || !Number.isSafeInteger(tab.id) || tab.id < 1)
        throw new Error("Navigate requires a valid Chrome tab id");
    await requireDebuggableTab(tab.id);
    const persistent = observationStates.has(tab.id);
    await attachTab(tab.id, DEFAULT_ATTACH_IDLE_MS, { persistent });
    if (ignoreCache) {
        await send(tab.id, "Network.enable");
        await send(tab.id, "Network.setCacheDisabled", { cacheDisabled: true });
    }
    try {
        await send(tab.id, "Page.navigate", { url: targetUrl });
        const updated = await waitForTab(tab.id, (candidate) => candidate.status === "complete" && String(candidate.url || "").startsWith(targetUrl));
        const policy = classifyBrowserPage(updated);
        return {
            navigationVersion: NAVIGATION_VERSION,
            id: updated.id,
            windowId: updated.windowId,
            title: updated.title,
            url: updated.url,
            active: updated.active,
            pageKind: policy.kind,
            debuggerSupported: policy.debuggerSupported,
        };
    }
    finally {
        if (ignoreCache) {
            await send(tab.id, "Network.setCacheDisabled", { cacheDisabled: false }).catch(() => { });
        }
        if (!persistent)
            scheduleDetach(tab.id);
    }
}
async function browserEmulate({ tabId, width, height, deviceScaleFactor = 1, mobile = false, touch = false, }) {
    const normalizedWidth = Number(width);
    const normalizedHeight = Number(height);
    const normalizedDpr = Number(deviceScaleFactor);
    if (!Number.isInteger(normalizedWidth) || normalizedWidth < 240 || normalizedWidth > 3840) {
        throw new Error("Emulation width must be an integer between 240 and 3840.");
    }
    if (!Number.isInteger(normalizedHeight) || normalizedHeight < 240 || normalizedHeight > 2400) {
        throw new Error("Emulation height must be an integer between 240 and 2400.");
    }
    if (!Number.isFinite(normalizedDpr) || normalizedDpr < 1 || normalizedDpr > 3) {
        throw new Error("Emulation deviceScaleFactor must be between 1 and 3.");
    }
    const tab = await chooseTab(tabId);
    if (typeof tab.id !== "number" || !Number.isSafeInteger(tab.id) || tab.id < 1)
        throw new Error("Emulation requires a valid Chrome tab id");
    await requireDebuggableTab(tab.id);
    const persistent = observationStates.has(tab.id);
    await attachTab(tab.id, DEFAULT_ATTACH_IDLE_MS, { persistent });
    await send(tab.id, "Emulation.setDeviceMetricsOverride", {
        width: normalizedWidth,
        height: normalizedHeight,
        deviceScaleFactor: normalizedDpr,
        mobile: Boolean(mobile),
        screenWidth: normalizedWidth,
        screenHeight: normalizedHeight,
    });
    await send(tab.id, "Emulation.setTouchEmulationEnabled", {
        enabled: Boolean(touch || mobile),
        maxTouchPoints: touch || mobile ? 5 : 1,
    });
    await send(tab.id, "Page.bringToFront");
    if (!persistent)
        scheduleDetach(tab.id);
    return {
        emulationVersion: EMULATION_VERSION,
        tabId: tab.id,
        width: normalizedWidth,
        height: normalizedHeight,
        deviceScaleFactor: normalizedDpr,
        mobile: Boolean(mobile),
        touch: Boolean(touch || mobile),
    };
}
async function touchViewport(tabId, sessionId = null) {
    const evaluated = await send(tabId, "Runtime.evaluate", {
        expression: "({ width: Math.max(1, Math.floor(window.innerWidth || 0)), height: Math.max(1, Math.floor(window.innerHeight || 0)) })",
        returnByValue: true,
        silent: true,
    }, sessionId);
    const width = Number(cdpObject(evaluated?.result?.value)?.width);
    const height = Number(cdpObject(evaluated?.result?.value)?.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 2 || height < 2) {
        throw new Error("Unable to determine a usable viewport for touch gesture.");
    }
    return { width: Math.min(width, 10_000), height: Math.min(height, 10_000) };
}
function clampTouchCoordinate(value, maximum) {
    return Math.max(1, Math.min(Number(value) || 1, Math.max(1, maximum - 1)));
}
async function dispatchTouchTap(tabId, point, sessionId = null) {
    const touchPoint = {
        x: point.x,
        y: point.y,
        radiusX: 1,
        radiusY: 1,
        force: 1,
        id: 0,
    };
    await send(tabId, "Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [touchPoint] }, sessionId);
    await sleep(40);
    await send(tabId, "Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }, sessionId);
}
async function browserTap({ tabId, ref, agentName } = {}) {
    if (typeof ref !== "string" || !/^@e\d+$/.test(ref))
        throw new Error("tap requires a current semantic ref.");
    const tab = await chooseTab(tabId);
    if (typeof tab.id !== "number" || !Number.isSafeInteger(tab.id) || tab.id < 1)
        throw new Error("Tap requires a valid Chrome tab id");
    const sourceContext = captureRefContextSource(tab.id);
    await requireDebuggableTab(tab.id);
    const persistent = observationStates.has(tab.id);
    await attachTab(tab.id, DEFAULT_ATTACH_IDLE_MS, { persistent });
    try {
        const moved = await moveAgentCursorToRef(tab.id, ref, { pulse: true, agentName });
        if (!moved.point)
            throw new Error(`Tap target has no actionable point: ${ref}`);
        await dispatchTouchTap(tab.id, moved.point, moved.sessionId);
        refStates.delete(tab.id);
        return {
            touchGestureVersion: TOUCH_GESTURE_VERSION,
            tabId: tab.id,
            ref,
            point: moved.point,
            frameId: moved.frameId,
            sessionScope: moved.sessionId ? "child" : "root",
            gesture: "tap",
            ...refOperationMetadata(tab.id, sourceContext, { invalidReason: "touch_gesture_invalidated_snapshot" }),
        };
    }
    finally {
        if (!persistent)
            scheduleDetach(tab.id);
    }
}
async function browserSwipe({ tabId, direction, distance = 400, ref, agentName } = {}) {
    const normalizedDirection = String(direction || "").toLowerCase();
    if (!new Set(["up", "down", "left", "right"]).has(normalizedDirection)) {
        throw new Error("Swipe direction must be up, down, left or right.");
    }
    const normalizedDistance = Number(distance);
    if (!Number.isInteger(normalizedDistance) || normalizedDistance < 40 || normalizedDistance > 1_200) {
        throw new Error("Swipe distance must be an integer between 40 and 1200 pixels.");
    }
    const tab = await chooseTab(tabId);
    if (typeof tab.id !== "number" || !Number.isSafeInteger(tab.id) || tab.id < 1)
        throw new Error("Swipe requires a valid Chrome tab id");
    const sourceContext = ref != null ? captureRefContextSource(tab.id) : null;
    await requireDebuggableTab(tab.id);
    const persistent = observationStates.has(tab.id);
    await attachTab(tab.id, DEFAULT_ATTACH_IDLE_MS, { persistent });
    try {
        let sessionId = null;
        let frameId = null;
        let start;
        if (ref != null) {
            if (!/^@e\d+$/.test(String(ref)))
                throw new Error("Swipe ref must be a current semantic ref.");
            const moved = await moveAgentCursorToRef(tab.id, ref, { pulse: false, agentName });
            if (!moved.point)
                throw new Error(`Swipe target has no actionable point: ${ref}`);
            sessionId = moved.sessionId;
            frameId = moved.frameId;
            start = moved.point;
        }
        else {
            await send(tab.id, "Page.bringToFront");
            const viewport = await touchViewport(tab.id);
            start = { x: viewport.width / 2, y: viewport.height / 2 };
        }
        const viewport = await touchViewport(tab.id, sessionId);
        const delta = {
            up: { x: 0, y: -normalizedDistance },
            down: { x: 0, y: normalizedDistance },
            left: { x: -normalizedDistance, y: 0 },
            right: { x: normalizedDistance, y: 0 },
        }[normalizedDirection];
        if (!delta)
            throw new Error("Swipe direction must be up, down, left or right.");
        const from = {
            x: clampTouchCoordinate(start.x, viewport.width),
            y: clampTouchCoordinate(start.y, viewport.height),
        };
        const to = {
            x: clampTouchCoordinate(from.x + delta.x, viewport.width),
            y: clampTouchCoordinate(from.y + delta.y, viewport.height),
        };
        const effectiveDistance = Math.hypot(to.x - from.x, to.y - from.y);
        if (effectiveDistance < 20)
            throw new Error("Swipe target is too close to the viewport edge for a meaningful bounded gesture.");
        const steps = 8;
        const pointFor = (index) => ({
            x: from.x + ((to.x - from.x) * index) / steps,
            y: from.y + ((to.y - from.y) * index) / steps,
            radiusX: 1,
            radiusY: 1,
            force: 1,
            id: 0,
        });
        await send(tab.id, "Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [pointFor(0)] }, sessionId);
        for (let index = 1; index <= steps; index += 1) {
            await send(tab.id, "Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [pointFor(index)] }, sessionId);
            await sleep(16);
        }
        await send(tab.id, "Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }, sessionId);
        refStates.delete(tab.id);
        return {
            touchGestureVersion: TOUCH_GESTURE_VERSION,
            tabId: tab.id,
            gesture: "swipe",
            direction: normalizedDirection,
            requestedDistance: normalizedDistance,
            effectiveDistance: Math.round(effectiveDistance),
            ref: ref || null,
            frameId,
            sessionScope: sessionId ? "child" : "root",
            ...(ref != null ? refOperationMetadata(tab.id, sourceContext, { invalidReason: "touch_gesture_invalidated_snapshot" }) : {}),
        };
    }
    finally {
        if (!persistent)
            scheduleDetach(tab.id);
    }
}
async function browserClearEmulation({ tabId } = {}) {
    const tab = await chooseTab(tabId);
    if (typeof tab.id !== "number" || !Number.isSafeInteger(tab.id) || tab.id < 1)
        throw new Error("Clear emulation requires a valid Chrome tab id");
    await requireDebuggableTab(tab.id);
    const persistent = observationStates.has(tab.id);
    await attachTab(tab.id, DEFAULT_ATTACH_IDLE_MS, { persistent });
    await Promise.all([
        send(tab.id, "Emulation.clearDeviceMetricsOverride"),
        send(tab.id, "Emulation.setTouchEmulationEnabled", { enabled: false }),
    ]);
    if (!persistent)
        scheduleDetach(tab.id);
    return { emulationVersion: EMULATION_VERSION, tabId: tab.id, cleared: true };
}
async function browserOpen({ tabId, url }) {
    const targetUrl = validateOpenUrl(url);
    const tab = await chooseTab(tabId);
    if (typeof tab.id !== "number" || !Number.isSafeInteger(tab.id) || tab.id < 1)
        throw new Error("Open requires a valid Chrome tab id");
    const debuggerCompatibleTarget = /^https?:/i.test(targetUrl);
    const persistent = observationStates.has(tab.id) && debuggerCompatibleTarget;
    const keepAttached = debuggerCompatibleTarget && attachedTabs.has(tab.id);
    if (!keepAttached)
        await detachTab(tab.id);
    else if (!persistent)
        scheduleDetach(tab.id);
    await workerTabs().update(tab.id, { url: targetUrl, active: true });
    const updated = await waitForTab(tab.id, (candidate) => candidate.url === targetUrl || (targetUrl.startsWith("http") && candidate.status === "complete"));
    const policy = classifyBrowserPage(updated);
    return {
        navigationVersion: NAVIGATION_VERSION,
        id: updated.id,
        windowId: updated.windowId,
        title: updated.title,
        url: updated.url,
        active: updated.active,
        pageKind: policy.kind,
        debuggerSupported: policy.debuggerSupported,
        unchangedTabId: updated.id === tab.id,
    };
}
async function browserActivate({ tabId }) {
    if (typeof tabId !== "number" || !Number.isSafeInteger(tabId) || tabId < 1)
        throw new Error("tabId is required");
    const tab = await workerTabs().update(tabId, { active: true });
    let focusedWindow = false;
    const windowsApi = workerWindows();
    if (windowsApi?.update && typeof tab.windowId === "number" && Number.isInteger(tab.windowId)) {
        try {
            await windowsApi.update(tab.windowId, { focused: true });
            focusedWindow = true;
        }
        catch {
            focusedWindow = false;
        }
    }
    const windowTypes = await browserWindowTypes();
    return {
        ...publicTab(tab, { windowTypes, creation: typeof tab.id === "number" ? creationEventForTab(tab.id) : null }),
        focusedWindow,
    };
}
async function browserClose({ tabId }) {
    const tab = await chooseTab(tabId);
    if (typeof tab.id !== "number" || !Number.isSafeInteger(tab.id) || tab.id < 1)
        throw new Error("Close requires a valid Chrome tab id");
    const tabsApi = workerTabs();
    const allTabs = await tabsApi.query({});
    await detachTab(tab.id);
    if (allTabs.length <= 1) {
        const reset = await tabsApi.update(tab.id, { url: "chrome://newtab/", active: true });
        return { id: reset.id, emulatedLastTabClose: true, url: reset.url, unchangedTabId: reset.id === tab.id };
    }
    await tabsApi.remove(tab.id);
    return { id: tab.id, closed: true, emulatedLastTabClose: false };
}
async function browserUpload({ tabId, ref, selector, files }) {
    const tab = await chooseTab(tabId);
    if (typeof tab.id !== "number" || !Number.isSafeInteger(tab.id) || tab.id < 1)
        throw new Error("Upload requires a valid Chrome tab id");
    const sourceContext = ref ? captureRefContextSource(tab.id) : null;
    await requireDebuggableTab(tab.id);
    await attachTab(tab.id);
    const fileList = Array.isArray(files) ? files.map(String) : [];
    if (fileList.length === 0)
        throw new Error("At least one file is required");
    let params;
    let sessionId = null;
    if (ref) {
        const target = lookupRef(tab.id, ref);
        sessionId = target.sessionId || null;
        params = { files: fileList, backendNodeId: target.backendNodeId };
    }
    else if (selector) {
        await send(tab.id, "DOM.enable");
        const documentResult = await send(tab.id, "DOM.getDocument", { depth: 1 });
        const rootNodeId = documentResult?.root?.nodeId;
        const query = await send(tab.id, "DOM.querySelector", { nodeId: rootNodeId, selector: String(selector) });
        if (!query?.nodeId)
            throw new Error(`File input selector not found: ${selector}`);
        params = { files: fileList, nodeId: query.nodeId };
    }
    else {
        throw new Error("ref or selector is required");
    }
    await send(tab.id, "DOM.setFileInputFiles", params, sessionId);
    refStates.delete(tab.id);
    scheduleDetach(tab.id);
    return {
        tabId: tab.id,
        uploaded: fileList.length,
        ref: ref || null,
        selector: selector || null,
        ...(ref ? refOperationMetadata(tab.id, sourceContext, { invalidReason: "upload_invalidated_snapshot" }) : {}),
    };
}
async function browserObserveStart({ tabId } = {}) {
    const tab = await chooseTab(tabId);
    if (typeof tab.id !== "number" || !Number.isSafeInteger(tab.id) || tab.id < 1)
        throw new Error("Observe start requires a valid Chrome tab id");
    await requireDebuggableTab(tab.id);
    await attachTab(tab.id, DEFAULT_ATTACH_IDLE_MS, { persistent: true });
    await Promise.all([
        send(tab.id, "Runtime.enable"),
        send(tab.id, "Network.enable"),
        send(tab.id, "Page.enable"),
    ]);
    const startedAt = new Date().toISOString();
    const state = {
        startedAt: Date.now(),
        console: [],
        consoleCursor: 0,
        network: [],
        networkCursor: 0,
        networkRequests: new Map(),
        dialog: currentDialogRecord(tab.id)?.dialog || null,
    };
    observationStates.set(tab.id, state);
    return { observationVersion: OBSERVATION_VERSION, tabId: tab.id, observing: true, startedAt };
}
async function browserObserveStop({ tabId } = {}) {
    const tab = await chooseTab(tabId);
    if (typeof tab.id !== "number" || !Number.isSafeInteger(tab.id) || tab.id < 1)
        throw new Error("Observe stop requires a valid Chrome tab id");
    const wasObserving = observationStates.has(tab.id);
    await detachTab(tab.id);
    return { tabId: tab.id, observing: false, wasObserving };
}
async function browserConsoleRead({ tabId, limit = 100, clear = false, afterCursor = null, level = null, query = null } = {}) {
    const tab = await chooseTab(tabId);
    if (typeof tab.id !== "number" || !Number.isSafeInteger(tab.id) || tab.id < 1)
        throw new Error("Console read requires a valid Chrome tab id");
    const state = getObservation(tab.id);
    const normalizedLevel = normalizeConsoleLevelFilter(level);
    const normalizedQuery = query == null || query === "" ? null : String(query).slice(0, 1_000);
    const count = state.console.length;
    const read = observationRead(state, "console", {
        limit,
        clear,
        afterCursor,
        predicate: (event) => consoleEventMatches(event, { level: normalizedLevel, query: normalizedQuery }),
    });
    return { observationVersion: OBSERVATION_VERSION, tabId: tab.id, count, ...read };
}
async function browserNetworkRead({ tabId, limit = 100, clear = false, afterCursor = null, urlContains = null, method = null, status = null, resourceType = null, } = {}) {
    const tab = await chooseTab(tabId);
    if (typeof tab.id !== "number" || !Number.isSafeInteger(tab.id) || tab.id < 1)
        throw new Error("Network read requires a valid Chrome tab id");
    const state = getObservation(tab.id);
    const filters = normalizeNetworkFilters({ urlContains, method, status, resourceType });
    const count = state.network.length;
    const read = observationRead(state, "network", {
        limit,
        clear,
        afterCursor,
        predicate: (event) => networkEventMatches(event, filters),
    });
    return { observationVersion: OBSERVATION_VERSION, tabId: tab.id, count, ...read };
}
async function browserDialog({ tabId, action = "status", promptText } = {}) {
    const tab = await chooseTab(tabId);
    if (typeof tab.id !== "number" || !Number.isSafeInteger(tab.id) || tab.id < 1)
        throw new Error("Dialog action requires a valid Chrome tab id");
    await requireDebuggableTab(tab.id);
    await attachTab(tab.id);
    await ensureFrameRouting(tab.id);
    if (!currentDialogRecord(tab.id))
        await sleep(40);
    const record = currentDialogRecord(tab.id);
    if (action === "status") {
        scheduleDetach(tab.id);
        return { tabId: tab.id, open: Boolean(record), dialog: record?.dialog || null };
    }
    if (!record)
        throw new Error("No JavaScript dialog is currently open for this tab.");
    if (!new Set(["accept", "dismiss"]).has(action))
        throw new Error(`Unsupported dialog action: ${action}`);
    const handled = record.dialog;
    await send(tab.id, "Page.handleJavaScriptDialog", {
        accept: action === "accept",
        ...(promptText != null ? { promptText: String(promptText) } : {}),
    }, record.sessionId);
    clearDialogState(tab.id);
    scheduleDetach(tab.id);
    return { tabId: tab.id, action, handled };
}
function workerBookmarksChrome() {
    return globalThis.chrome;
}
function workerBookmarksFactory() {
    return globalThis.EquinoxBrowserBookmarks;
}
async function requireAgentBookmarkContext() {
    await ensureBrowserIdentityLoaded();
    if (browserContext !== "agent") {
        throw new Error("Bookmark automation is available only in Agent Browser; Your Browser bookmarks are intentionally unavailable.");
    }
    if (!workerBookmarksChrome().bookmarks)
        throw new Error("Chrome bookmarks API is unavailable in this extension context.");
}
const browserBookmarksCapability = workerBookmarksFactory().createBrowserBookmarksCapability({
    chrome: workerBookmarksChrome(),
    getBrowserContext: () => browserContext,
    ensureBrowserIdentityLoaded,
    safeObservedUrl,
    bookmarksVersion: BOOKMARKS_VERSION,
});
async function browserBookmarksList(args = {}) {
    await requireAgentBookmarkContext();
    return browserBookmarksCapability.browserBookmarksList(args);
}
async function browserBookmarksSearch(args = {}) {
    await requireAgentBookmarkContext();
    return browserBookmarksCapability.browserBookmarksSearch(args);
}
async function browserBookmarkAdd(args = {}) {
    await requireAgentBookmarkContext();
    return browserBookmarksCapability.browserBookmarkAdd(args);
}
async function browserBookmarkFolderCreate(args = {}) {
    await requireAgentBookmarkContext();
    return browserBookmarksCapability.browserBookmarkFolderCreate(args);
}
async function browserBookmarkUpdateMove(args = {}) {
    await requireAgentBookmarkContext();
    return browserBookmarksCapability.browserBookmarkUpdateMove(args);
}
async function browserBookmarkRemove(args = {}) {
    await requireAgentBookmarkContext();
    return browserBookmarksCapability.browserBookmarkRemove(args);
}
async function browserStatus() {
    await Promise.all([
        ensureBrowserControlConsentLoaded(),
        ensureBrowserEnabledLoaded(),
        ensureAgentCursorEnabledLoaded(),
        ensureAgentCursorNameLoaded(),
    ]);
    const consentAccepted = hasCurrentBrowserControlConsent();
    const mayInspectBrowser = browserEnabled && consentAccepted;
    const tabs = mayInspectBrowser ? await browserTabsList() : [];
    // Chrome exposes the installed extension's own provenance without a new
    // management permission. `development` means loaded unpacked, not Web Store.
    const management = globalThis.chrome?.management;
    const extensionInstallType = await management?.getSelf?.()
        .then((self) => self.installType ?? null).catch(() => null) ?? null;
    return {
        extensionId: workerRuntime().id,
        extensionVersion: workerRuntime().getManifest().version,
        extensionInstallType,
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        controlEnabled: mayInspectBrowser,
        consentAccepted,
        consentVersion: browserControlConsentVersion,
        requiredConsentVersion: CURRENT_BROWSER_CONTROL_CONSENT_VERSION,
        agentCursorEnabled,
        agentCursorName,
        localBridgeConnected,
        attachedTabIds: mayInspectBrowser ? [...attachedTabs.keys()] : [],
        refTabIds: mayInspectBrowser ? [...refStates.keys()] : [],
        observingTabIds: mayInspectBrowser ? [...observationStates.keys()] : [],
        openDialogTabIds: mayInspectBrowser ? [...dialogStates.keys()] : [],
        tabCreationSequence: mayInspectBrowser ? tabCreationSequence : 0,
        downloadCreationSequence: mayInspectBrowser ? downloadCreationSequence : 0,
        tabCount: mayInspectBrowser ? tabs.length : null,
        capabilityVersions: browserCapabilityVersions(),
    };
}
async function browserDisconnect() {
    const ids = [...attachedTabs.keys()];
    await Promise.all(ids.map((tabId) => detachTab(tabId)));
    tabCreationEvents.length = 0;
    downloadCreationEvents.length = 0;
    tabCreationSequence = 0;
    downloadCreationSequence = 0;
    return { detachedTabIds: ids };
}
async function browserSelfReload() {
    return {
        scheduled: true,
        delayMs: SELF_RELOAD_DELAY_MS,
        extensionId: workerRuntime().id,
    };
}
const COMMANDS = {
    ping: async () => ({ pong: true, at: new Date().toISOString() }),
    status: browserStatus,
    "tabs.list": browserTabsList,
    "tabs.activate": browserActivate,
    "tabs.create": browserCreateTab,
    "history.back": (args = {}) => browserHistoryNavigate({ ...args, direction: "back" }),
    "history.forward": (args = {}) => browserHistoryNavigate({ ...args, direction: "forward" }),
    reload: browserReload,
    open: browserOpen,
    navigate: browserNavigate,
    emulate: browserEmulate,
    "emulation.clear": browserClearEmulation,
    snapshot: browserSnapshot,
    "pdf.data": browserPdfData,
    screenshot: browserScreenshot,
    find: browserFind,
    reacquire: browserReacquire,
    click: browserClick,
    tap: browserTap,
    swipe: browserSwipe,
    double_click: browserDoubleClick,
    drag: browserDrag,
    hover: browserHover,
    scroll: browserScroll,
    scroll_into_view: browserScrollIntoView,
    ref_info: browserRefInfo,
    select: browserSelect,
    check: browserCheck,
    range_set: browserRangeSet,
    wait: browserWait,
    fill: browserFill,
    press: browserPress,
    type_text: browserTypeText,
    eval: browserEval,
    "observe.start": browserObserveStart,
    "observe.stop": browserObserveStop,
    "console.read": browserConsoleRead,
    "network.read": browserNetworkRead,
    "bookmarks.list": browserBookmarksList,
    "bookmarks.search": browserBookmarksSearch,
    "bookmarks.add": browserBookmarkAdd,
    "bookmarks.folder_create": browserBookmarkFolderCreate,
    "bookmarks.update_move": browserBookmarkUpdateMove,
    "bookmarks.remove": browserBookmarkRemove,
    dialog: browserDialog,
    close: browserClose,
    upload: browserUpload,
    "downloads.wait": browserDownloadWait,
    disconnect: browserDisconnect,
    "self.reload": browserSelfReload,
    "continuation.target.resolve": resolveAutoContinueTarget,
    "continuation.inspect": ({ tabId }) => chatGptContinuationState(tabId),
    "turn_budget.identity.resolve": resolveTurnBudgetTarget,
    "continuation.deliver": deliverAutoContinuation,
    "chat_bridge.inspect": inspectChatBridgeState,
    "chat_bridge.deliver": deliverChatBridgeMessage,
    "chat_bridge.read_final": readChatBridgeFinalResponse,
    "resume.create": createFreshChatResume,
    "settings.status": popupStatus,
    "settings.update": updateBrowserSettings,
    "context.set": async ({ context } = {}) => setBrowserContext(context),
};
const DISABLED_CONTROL_METHODS = new Set([
    "status", "settings.status", "settings.update", "context.set",
]);
async function handleCommand(message, sourcePort = nativePort) {
    if (message?.type !== "command" || message.id == null)
        return;
    await ensureBrowserEnabledLoaded();
    const consentAccepted = hasCurrentBrowserControlConsent();
    if ((!browserEnabled || !consentAccepted) && !DISABLED_CONTROL_METHODS.has(message.method || "")) {
        postNativeResponseForPort(sourcePort, {
            type: "response",
            id: message.id,
            ok: false,
            error: {
                message: consentAccepted
                    ? "Equinox Browser is turned off from the extension popup."
                    : "Equinox Browser requires user consent in the extension popup before browser automation can run.",
            },
        });
        return;
    }
    const handler = typeof message.method === "string" && Object.prototype.hasOwnProperty.call(COMMANDS, message.method)
        ? COMMANDS[message.method]
        : null;
    if (!handler) {
        postNativeResponseForPort(sourcePort, {
            type: "response",
            id: message.id,
            ok: false,
            error: { message: `Unknown Equinox Browser command: ${message.method}` },
        });
        return;
    }
    try {
        const result = await Reflect.apply(handler, undefined, [message.args || {}]);
        postSuccessfulResponse(message.id, result, sourcePort);
        if (message.method === "self.reload") {
            setTimeout(() => workerRuntime().reload(), SELF_RELOAD_DELAY_MS);
        }
    }
    catch (error) {
        postNativeResponseForPort(sourcePort, {
            type: "response",
            id: message.id,
            ok: false,
            error: { message: errorMessage(error), stack: error instanceof Error ? error.stack || null : null },
        });
    }
}
function scheduleReconnect() {
    if (!reconnectTimer) {
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connectNativeHost();
        }, reconnectDelayMs);
    }
    workerAlarms().create(NATIVE_RECONNECT_ALARM, { when: Date.now() + Math.max(1_000, reconnectDelayMs) });
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 10_000);
}
function connectNativeHost() {
    if (nativePort)
        return;
    let port;
    try {
        port = workerRuntime().connectNative(HOST_NAME);
        nativePort = port;
        localBridgeConnected = false;
    }
    catch {
        nativePort = null;
        localBridgeConnected = false;
        scheduleReconnect();
        return;
    }
    port.onMessage.addListener((message) => {
        if (nativePort !== port)
            return;
        immediateReconnectUsed = false;
        reconnectDelayMs = 500;
        void workerAlarms().clear(NATIVE_RECONNECT_ALARM);
        if (message?.type === "host.status") {
            localBridgeConnected = message.localConnected === true;
            return;
        }
        if (handleLocalResponse(message))
            return;
        void handleCommand(message, port);
    });
    port.onDisconnect.addListener(() => {
        if (nativePort !== port) {
            intentionallyDisconnectedPorts.delete(port);
            return;
        }
        const intentional = intentionallyDisconnectedPorts.has(port);
        intentionallyDisconnectedPorts.delete(port);
        if (nativePort === port)
            nativePort = null;
        localBridgeConnected = false;
        rejectPendingLocalRequests("Equinox Local Native Messaging bağlantısı kesildi.");
        if (intentional) {
            lastNativeDisconnectError = null;
            return;
        }
        lastNativeDisconnectError = workerRuntime().lastError?.message || "Native messaging port disconnected";
        if (!immediateReconnectUsed) {
            immediateReconnectUsed = true;
            connectNativeHost();
            return;
        }
        scheduleReconnect();
    });
    reconnectDelayMs = 500;
    void workerAlarms().clear(NATIVE_RECONNECT_ALARM);
    const postExtensionHello = () => {
        if (nativePort !== port)
            return;
        port.postMessage({
            type: "extension.hello",
            extensionId: workerRuntime().id,
            extensionVersion: workerRuntime().getManifest().version,
            protocolVersion: BRIDGE_PROTOCOL_VERSION,
            capabilities: Object.keys(COMMANDS),
            capabilityVersions: browserCapabilityVersions(),
            instanceId: browserInstanceId,
            browserContext,
            lastNativeDisconnectError,
        });
    };
    if (browserIdentityLoaded)
        postExtensionHello();
    else
        void ensureBrowserIdentityLoaded().then(postExtensionHello).catch(() => scheduleReconnect());
}
function workerDebuggerEvents() {
    return globalThis.chrome.debugger;
}
workerDebuggerEvents().onEvent.addListener((source, method, params = {}) => {
    if (!browserEnabled || !hasCurrentBrowserControlConsent())
        return;
    const tabId = source?.tabId;
    if (typeof tabId !== "number" || !Number.isSafeInteger(tabId) || tabId < 1)
        return;
    if (method === "Target.attachedToTarget") {
        if (typeof params.sessionId !== "string" || !params.sessionId)
            return;
        registerChildSession(tabId, params.sessionId, params.targetInfo || {});
        if (params.sessionId) {
            void send(tabId, "Page.enable", {}, params.sessionId).catch(() => { });
            if (observationStates.has(tabId)) {
                void Promise.all([
                    send(tabId, "Runtime.enable", {}, params.sessionId),
                    send(tabId, "Network.enable", {}, params.sessionId),
                ]).catch(() => { });
            }
        }
        return;
    }
    if (method === "Target.detachedFromTarget") {
        if (typeof params.sessionId === "string" && params.sessionId)
            unregisterChildSession(tabId, params.sessionId);
        return;
    }
    if (new Set(["Page.frameAttached", "Page.frameDetached", "Page.frameNavigated", "Page.navigatedWithinDocument"]).has(method)) {
        invalidateRefs(tabId, { bumpGeneration: true });
        return;
    }
    if (method === "Page.javascriptDialogOpening") {
        recordDialogState(tabId, source, params);
        return;
    }
    if (method === "Page.javascriptDialogClosed") {
        clearDialogState(tabId);
        scheduleDetach(tabId);
        return;
    }
    if (method === "Input.dragIntercepted") {
        resolveHtml5DragIntercept(tabId, source, params);
        return;
    }
    const responseWaiters = networkResponseWaitStates.get(tabId);
    if (responseWaiters?.size) {
        if (method === "Network.requestWillBeSent") {
            for (const waiter of responseWaiters) {
                if (params.requestId) {
                    rememberNetworkRequest({ networkRequests: waiter.requests }, params.requestId, {
                        requestId: params.requestId,
                        method: params.request?.method || null,
                        url: safeObservedUrl(params.request?.url || params.documentURL || ""),
                        type: params.type || null,
                    });
                }
            }
        }
        else if (method === "Network.responseReceived") {
            for (const waiter of responseWaiters) {
                const request = params.requestId ? waiter.requests.get(params.requestId) || null : null;
                const response = {
                    requestId: params.requestId || null,
                    method: request?.method || null,
                    url: safeObservedUrl(params.response?.url || request?.url || ""),
                    status: params.response?.status ?? null,
                    statusText: params.response?.statusText || null,
                    mimeType: params.response?.mimeType || null,
                    type: params.type || request?.type || null,
                    fromDiskCache: Boolean(params.response?.fromDiskCache),
                    fromServiceWorker: Boolean(params.response?.fromServiceWorker),
                };
                if (!waiter.matched && networkEventMatches(response, waiter.filters))
                    waiter.matched = response;
            }
        }
        else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
            for (const waiter of responseWaiters) {
                if (params.requestId)
                    waiter.requests.delete(params.requestId);
            }
        }
    }
    const networkWaitState = networkWaitStates.get(tabId);
    if (networkWaitState) {
        if (method === "Network.requestWillBeSent") {
            if (!NETWORK_IDLE_IGNORED_TYPES.has(String(params.type || ""))) {
                if (params.requestId)
                    networkWaitState.inflight.add(params.requestId);
                networkWaitState.lastActivityAt = Date.now();
            }
        }
        else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
            if (params.requestId && networkWaitState.inflight.delete(params.requestId)) {
                networkWaitState.lastActivityAt = Date.now();
            }
        }
    }
    const state = observationStates.get(tabId);
    if (!state)
        return;
    const at = new Date().toISOString();
    if (method === "Runtime.consoleAPICalled") {
        pushObservationEvent(state, "console", {
            at,
            kind: "console",
            level: params.type || "log",
            args: (params.args || []).slice(0, 20).map(remoteValue),
        });
        return;
    }
    if (method === "Runtime.exceptionThrown") {
        pushObservationEvent(state, "console", {
            at,
            kind: "exception",
            level: "error",
            text: params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || "Uncaught exception",
            lineNumber: params.exceptionDetails?.lineNumber ?? null,
            columnNumber: params.exceptionDetails?.columnNumber ?? null,
            url: safeObservedUrl(params.exceptionDetails?.url || ""),
        });
        return;
    }
    if (method === "Network.requestWillBeSent") {
        const request = {
            requestId: params.requestId || null,
            method: params.request?.method || null,
            url: safeObservedUrl(params.request?.url || params.documentURL || ""),
            type: params.type || null,
        };
        rememberNetworkRequest(state, params.requestId, request);
        pushObservationEvent(state, "network", {
            at,
            phase: "request",
            ...request,
        });
        return;
    }
    if (method === "Network.responseReceived") {
        const previous = networkRequestMetadata(state, params.requestId);
        const response = {
            requestId: params.requestId || null,
            method: previous?.method || null,
            url: safeObservedUrl(params.response?.url || previous?.url || ""),
            status: params.response?.status ?? null,
            statusText: params.response?.statusText || null,
            mimeType: params.response?.mimeType || null,
            type: params.type || previous?.type || null,
            fromDiskCache: Boolean(params.response?.fromDiskCache),
            fromServiceWorker: Boolean(params.response?.fromServiceWorker),
        };
        rememberNetworkRequest(state, params.requestId, response);
        pushObservationEvent(state, "network", {
            at,
            phase: "response",
            ...response,
        });
        return;
    }
    if (method === "Network.loadingFinished") {
        const previous = networkRequestMetadata(state, params.requestId);
        pushObservationEvent(state, "network", {
            at,
            phase: "finished",
            requestId: params.requestId || null,
            method: previous?.method || null,
            url: previous?.url || null,
            status: previous?.status ?? null,
            mimeType: previous?.mimeType || null,
            type: previous?.type || null,
            encodedDataLength: params.encodedDataLength ?? null,
        });
        forgetNetworkRequest(state, params.requestId);
        return;
    }
    if (method === "Network.loadingFailed") {
        const previous = networkRequestMetadata(state, params.requestId);
        pushObservationEvent(state, "network", {
            at,
            phase: "failed",
            requestId: params.requestId || null,
            method: previous?.method || null,
            url: previous?.url || null,
            status: previous?.status ?? null,
            mimeType: previous?.mimeType || null,
            type: params.type || previous?.type || null,
            errorText: params.errorText || null,
            canceled: Boolean(params.canceled),
            blockedReason: params.blockedReason || null,
        });
        forgetNetworkRequest(state, params.requestId);
        return;
    }
});
workerDebuggerEvents().onDetach.addListener((source) => {
    const tabId = source?.tabId;
    if (typeof tabId !== "number" || !Number.isSafeInteger(tabId) || tabId < 1)
        return;
    const state = attachedTabs.get(tabId);
    if (state?.timer)
        clearTimeout(state.timer);
    attachedTabs.delete(tabId);
    refStates.delete(tabId);
    networkWaitStates.delete(tabId);
    networkResponseWaitStates.delete(tabId);
    observationStates.delete(tabId);
    dialogStates.delete(tabId);
    rejectPendingHtml5DragIntercept(tabId, "Debugger detached while waiting for HTML5 drag interception");
});
workerTabs().onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo?.url || changeInfo?.status === "loading") {
        chatGptContinuationStateCache.delete(tabId);
    }
    if (!browserEnabled || !hasCurrentBrowserControlConsent())
        return;
    if (changeInfo?.url || changeInfo?.status === "loading") {
        invalidateRefs(tabId, { bumpGeneration: true });
    }
});
workerTabs().onCreated?.addListener((tab) => {
    if (!browserEnabled || !hasCurrentBrowserControlConsent())
        return;
    recordTabCreation(tab);
});
workerDownloads()?.onCreated?.addListener((item) => {
    if (!browserEnabled || !hasCurrentBrowserControlConsent())
        return;
    recordDownloadCreation(item);
});
workerTabs().onRemoved.addListener((tabId) => {
    const state = attachedTabs.get(tabId);
    if (state?.timer)
        clearTimeout(state.timer);
    attachedTabs.delete(tabId);
    refStates.delete(tabId);
    refRegistries.delete(tabId);
    snapshotHistories.delete(tabId);
    networkWaitStates.delete(tabId);
    networkResponseWaitStates.delete(tabId);
    observationStates.delete(tabId);
    dialogStates.delete(tabId);
    rejectPendingHtml5DragIntercept(tabId, "Tab closed while waiting for HTML5 drag interception");
    documentGenerations.delete(tabId);
    chatGptContinuationStateCache.delete(tabId);
});
workerAlarms().onAlarm.addListener((alarm) => {
    if (alarm?.name !== NATIVE_RECONNECT_ALARM || nativePort)
        return;
    connectNativeHost();
});
function isWorkerPopupMessage(value) {
    return value != null && typeof value === "object" && !Array.isArray(value);
}
function isTrustedPopupSender(sender) {
    const extensionId = workerRuntime().id;
    return typeof extensionId === "string" && extensionId.length > 0
        && sender?.id === extensionId
        && sender.tab == null
        && sender.url === `chrome-extension://${extensionId}/popup.html`;
}
workerRuntime().onMessage?.addListener((message, sender, sendResponse) => {
    if (!isWorkerPopupMessage(message))
        return false;
    if (message?.type === CHATGPT_CONTINUATION_STATE_PUSH) {
        const tabId = sender?.tab?.id;
        const tabUrl = sender?.tab?.url;
        const tabIdentity = chatGptConversationIdentity(sender?.tab);
        const frameIdentity = typeof sender?.url === "string" ? chatGptConversationIdentity(sender.url) : null;
        if (sender?.id === workerRuntime().id
            && typeof tabId === "number" && Number.isSafeInteger(tabId) && tabId > 0
            && typeof tabUrl === "string" && tabIdentity
            // A content script must not repopulate stale observer state after
            // Chrome has started leaving the committed conversation.
            && !(typeof sender.tab?.pendingUrl === "string" && sender.tab.pendingUrl.length > 0)
            && (sender.url == null || frameIdentity?.canonicalUrl === tabIdentity.canonicalUrl)) {
            rememberChatGptContinuationState(tabId, tabUrl, message.state);
        }
        sendResponse?.({ ok: true });
        return false;
    }
    if (typeof message.type !== "string" || !new Set([
        "equinox.popup.status",
        "equinox.popup.setEnabled",
        "equinox.popup.acceptBrowserControlConsent",
        "equinox.popup.setAgentCursorEnabled",
        "equinox.popup.setAgentCursorName",
        "equinox.popup.openAgentBrowser",
        "equinox.popup.setAutoContinueTarget",
    ]).has(message.type) || !isTrustedPopupSender(sender))
        return false;
    const task = message.type === "equinox.popup.setEnabled"
        ? setBrowserEnabled(message.enabled)
        : message.type === "equinox.popup.acceptBrowserControlConsent"
            ? acceptBrowserControlConsent()
            : message.type === "equinox.popup.setAgentCursorEnabled"
                ? setAgentCursorEnabled(message.enabled)
                : message.type === "equinox.popup.setAgentCursorName"
                    ? setAgentCursorName(message.name)
                    : message.type === "equinox.popup.openAgentBrowser"
                        ? openAgentBrowserFromPopup()
                        : message.type === "equinox.popup.setAutoContinueTarget"
                            ? setAutoContinueTarget({ mode: message.mode, tabId: message.tabId }).then(() => popupStatus())
                            : popupStatus();
    Promise.resolve(task).then((result) => sendResponse({ ok: true, result }), (error) => sendResponse({ ok: false, error: { message: errorMessage(error) } }));
    return true;
});
workerRuntime().onStartup.addListener(() => connectNativeHost());
workerRuntime().onInstalled.addListener(() => connectNativeHost());
void ensureBrowserEnabledLoaded().then(() => connectNativeHost());
