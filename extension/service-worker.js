const HOST_NAME = "dev.equinox.browser";
const PROTOCOL_VERSION = "1.3";
const BRIDGE_PROTOCOL_VERSION = 1;
const DEFAULT_ATTACH_IDLE_MS = 30_000;
const MAX_SNAPSHOT_ELEMENTS = 250;
const SNAPSHOT_VERSION = 3;
const DELTA_SNAPSHOT_VERSION = 1;
const SCREENSHOT_VERSION = 3;
const REACQUIRE_VERSION = 1;
const COMPOUND_ACTION_VERSION = 2;
const DOUBLE_CLICK_VERSION = 1;
const POINTER_DRAG_VERSION = 1;
const HTML5_DRAG_VERSION = 1;
const WAIT_VERSION = 2;
const NAVIGATION_VERSION = 1;
const EMULATION_VERSION = 1;
const INPUT_VERSION = 1;
const ACTIONABILITY_VERSION = 1;
const CLICK_VERSION = 2;
const OBSERVATION_VERSION = 2;
const TOUCH_GESTURE_VERSION = 1;
const BOOKMARKS_VERSION = 2;
const MAX_BOOKMARK_PATH_DEPTH = 16;
const MAX_BOOKMARK_PATH_CHARS = 2_000;
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
const BROWSER_CONTEXT_VALUES = new Set(["agent", "user"]);
const AGENT_CURSOR_HOST_ID = "__equinox_browser_agent_cursor__";
const SCREENSHOT_ANNOTATION_HOST_ID = "__equinox_browser_ref_annotations__";
const MAX_SCREENSHOT_ANNOTATIONS = 100;
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
    click: CLICK_VERSION,
    observation: OBSERVATION_VERSION,
    touchGesture: TOUCH_GESTURE_VERSION,
    bookmarks: BOOKMARKS_VERSION,
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
let localBridgeConnected = false;
let nextLocalRequestId = 1;
const pendingLocalRequests = new Map();
const intentionallyDisconnectedPorts = new WeakSet();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function errorMessage(error) {
  return error?.message || String(error);
}

function rejectPendingHtml5DragIntercept(tabId, reason) {
  const state = html5DragInterceptStates.get(tabId);
  if (!state) return false;
  html5DragInterceptStates.delete(tabId);
  clearTimeout(state.timer);
  if (!state.settled) {
    state.settled = true;
    state.reject(new Error(reason));
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
  state.promise.catch(() => {});
  state.timer = setTimeout(() => {
    if (html5DragInterceptStates.get(tabId) !== state || state.settled) return;
    html5DragInterceptStates.delete(tabId);
    state.settled = true;
    state.reject(new Error("Timed out waiting for Chrome to intercept an HTML5 drag payload"));
  }, Math.max(100, Math.min(Number(timeoutMs) || HTML5_DRAG_INTERCEPT_TIMEOUT_MS, 5_000)));
  html5DragInterceptStates.set(tabId, state);
  return state;
}

function resolveHtml5DragIntercept(tabId, source, params) {
  const state = html5DragInterceptStates.get(tabId);
  if (!state) return false;
  if (!state.armed) return false;
  if (source?.sessionId) {
    rejectPendingHtml5DragIntercept(tabId, "HTML5 drag interception from a child CDP session is not supported safely");
    return true;
  }
  html5DragInterceptStates.delete(tabId);
  clearTimeout(state.timer);
  state.settled = true;
  state.resolve(params?.data ?? null);
  return true;
}

function normalizeHtml5DragData(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Chrome did not provide a valid HTML5 drag payload");
  }
  const items = Array.isArray(data.items) ? data.items : [];
  const files = Array.isArray(data.files) ? data.files : [];
  if (items.length > MAX_HTML5_DRAG_ITEMS) throw new Error("HTML5 drag payload contains too many data items");
  if (files.length > MAX_HTML5_DRAG_FILES) throw new Error("HTML5 drag payload contains too many files");

  let totalChars = 0;
  const normalizedItems = items.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("HTML5 drag payload contains an invalid data item");
    }
    const mimeType = String(item.mimeType || "");
    const itemData = String(item.data ?? "");
    const title = item.title == null ? null : String(item.title);
    const baseURL = item.baseURL == null ? null : String(item.baseURL);
    if (!mimeType || mimeType.length > 256) throw new Error("HTML5 drag payload contains an invalid MIME type");
    if (title != null && title.length > 4_096) throw new Error("HTML5 drag payload title is too large");
    if (baseURL != null && baseURL.length > 8_192) throw new Error("HTML5 drag payload base URL is too large");
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
    if (!value || value.length > 8_192) throw new Error("HTML5 drag payload contains an invalid file path");
    totalChars += value.length;
    return value;
  });
  if (totalChars > MAX_HTML5_DRAG_DATA_CHARS) throw new Error("HTML5 drag payload exceeds the bounded data limit");

  const dragOperationsMask = Number(data.dragOperationsMask);
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
  if (message?.type !== "extension.response" || message.id == null) return false;
  const id = String(message.id);
  const waiter = pendingLocalRequests.get(id);
  if (!waiter) return true;
  pendingLocalRequests.delete(id);
  clearTimeout(waiter.timer);
  if (message.ok) waiter.resolve(message.result ?? null);
  else waiter.reject(new Error(message.error?.message || message.error || "Equinox Local request failed."));
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
    } catch (error) {
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
  if (browserControlConsentLoaded) return browserControlConsentVersion;
  if (!browserControlConsentLoadPromise) {
    browserControlConsentLoadPromise = (async () => {
      try {
        const stored = await chrome.storage.local.get(BROWSER_CONTROL_CONSENT_STORAGE_KEY);
        const version = Number(stored?.[BROWSER_CONTROL_CONSENT_STORAGE_KEY]);
        browserControlConsentVersion = Number.isInteger(version) && version > 0 ? version : 0;
      } catch {
        browserControlConsentVersion = 0;
      }
      browserControlConsentLoaded = true;
      return browserControlConsentVersion;
    })();
  }
  return await browserControlConsentLoadPromise;
}

async function ensureBrowserEnabledLoaded() {
  if (browserEnabledLoaded) return browserEnabled;
  if (!browserEnabledLoadPromise) {
    browserEnabledLoadPromise = (async () => {
      await ensureBrowserControlConsentLoaded();
      try {
        const stored = await chrome.storage.local.get(BROWSER_ENABLED_STORAGE_KEY);
        browserEnabled = hasCurrentBrowserControlConsent() && stored?.[BROWSER_ENABLED_STORAGE_KEY] === true;
      } catch {
        browserEnabled = false;
      }
      browserEnabledLoaded = true;
      return browserEnabled;
    })();
  }
  return await browserEnabledLoadPromise;
}

async function ensureAgentCursorEnabledLoaded() {
  if (agentCursorEnabledLoaded) return agentCursorEnabled;
  if (!agentCursorEnabledLoadPromise) {
    agentCursorEnabledLoadPromise = (async () => {
      try {
        const stored = await chrome.storage.local.get(AGENT_CURSOR_STORAGE_KEY);
        agentCursorEnabled = stored?.[AGENT_CURSOR_STORAGE_KEY] !== false;
      } catch {
        agentCursorEnabled = true;
      }
      agentCursorEnabledLoaded = true;
      return agentCursorEnabled;
    })();
  }
  return await agentCursorEnabledLoadPromise;
}

async function ensureAgentCursorNameLoaded() {
  if (agentCursorNameLoaded) return agentCursorName;
  if (!agentCursorNameLoadPromise) {
    agentCursorNameLoadPromise = (async () => {
      try {
        const stored = await chrome.storage.local.get(AGENT_CURSOR_NAME_STORAGE_KEY);
        agentCursorName = normalizeAgentCursorName(stored?.[AGENT_CURSOR_NAME_STORAGE_KEY]);
      } catch {
        agentCursorName = DEFAULT_AGENT_CURSOR_NAME;
      }
      agentCursorNameLoaded = true;
      return agentCursorName;
    })();
  }
  return await agentCursorNameLoadPromise;
}

function normalizeBrowserContext(value, { allowUnassigned = true } = {}) {
  if (BROWSER_CONTEXT_VALUES.has(value)) return value;
  if (allowUnassigned && (value == null || value === "unassigned")) return "unassigned";
  throw new Error(`Unsupported browser context: ${String(value)}`);
}

async function ensureBrowserIdentityLoaded() {
  if (browserIdentityLoaded) return { instanceId: browserInstanceId, browserContext };
  if (!browserIdentityLoadPromise) {
    browserIdentityLoadPromise = (async () => {
      let stored = {};
      try {
        stored = await chrome.storage.local.get([
          BROWSER_INSTANCE_ID_STORAGE_KEY,
          BROWSER_CONTEXT_STORAGE_KEY,
        ]);
      } catch {
        stored = {};
      }
      const storedInstanceId = String(stored?.[BROWSER_INSTANCE_ID_STORAGE_KEY] || "").trim();
      browserInstanceId = /^[a-f0-9-]{36}$/iu.test(storedInstanceId)
        ? storedInstanceId.toLowerCase()
        : crypto.randomUUID();
      browserContext = normalizeBrowserContext(stored?.[BROWSER_CONTEXT_STORAGE_KEY]);
      await chrome.storage.local.set({ [BROWSER_INSTANCE_ID_STORAGE_KEY]: browserInstanceId });
      browserIdentityLoaded = true;
      return { instanceId: browserInstanceId, browserContext };
    })();
  }
  return await browserIdentityLoadPromise;
}

async function setBrowserContext(nextContext) {
  await ensureBrowserIdentityLoaded();
  const normalized = normalizeBrowserContext(nextContext, { allowUnassigned: false });
  await chrome.storage.local.set({ [BROWSER_CONTEXT_STORAGE_KEY]: normalized });
  browserContext = normalized;
  return {
    instanceId: browserInstanceId,
    browserContext,
  };
}

function clearReconnectSchedule() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  reconnectDelayMs = 500;
  immediateReconnectUsed = false;
  void chrome.alarms.clear(NATIVE_RECONNECT_ALARM);
}

async function popupStatus() {
  await Promise.all([
    ensureBrowserControlConsentLoaded(),
    ensureBrowserEnabledLoaded(),
    ensureAgentCursorEnabledLoaded(),
    ensureAgentCursorNameLoaded(),
    ensureBrowserIdentityLoaded(),
  ]);
  const consentAccepted = hasCurrentBrowserControlConsent();
  let tab = null;
  if (browserEnabled && consentAccepted) {
    try {
      tab = await chooseTab();
    } catch {
      // Chrome can transiently have no tab while windows are closing.
    }
  }
  const policy = tab ? classifyBrowserPage(tab) : null;
  return {
    enabled: browserEnabled,
    consentAccepted,
    consentVersion: browserControlConsentVersion,
    requiredConsentVersion: CURRENT_BROWSER_CONTROL_CONSENT_VERSION,
    agentCursorEnabled,
    agentCursorName,
    nativeHostConnected: Boolean(nativePort),
    localConnected: localBridgeConnected,
    extensionVersion: chrome.runtime.getManifest().version,
    browserContext,
    browserInstanceId,
    lastNativeDisconnectError,
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
  await ensureBrowserEnabledLoaded();
  const enabled = Boolean(nextEnabled);
  if (enabled && !hasCurrentBrowserControlConsent()) {
    throw new Error("Browser control requires consent in the Equinox Browser extension popup.");
  }
  if (browserEnabled === enabled) return await popupStatus();

  await chrome.storage.local.set({ [BROWSER_ENABLED_STORAGE_KEY]: enabled });
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
  await chrome.storage.local.set({
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
  await ensureAgentCursorEnabledLoaded();
  const enabled = Boolean(nextEnabled);
  await chrome.storage.local.set({ [AGENT_CURSOR_STORAGE_KEY]: enabled });
  agentCursorEnabled = enabled;
  return await popupStatus();
}

async function setAgentCursorName(nextName) {
  await ensureAgentCursorNameLoaded();
  const normalized = normalizeAgentCursorName(nextName);
  await chrome.storage.local.set({ [AGENT_CURSOR_NAME_STORAGE_KEY]: normalized });
  agentCursorName = normalized;
  return await popupStatus();
}

async function updateBrowserSettings(nextSettings = {}) {
  if (!nextSettings || typeof nextSettings !== "object" || Array.isArray(nextSettings)) {
    throw new Error("Browser settings must be an object.");
  }
  const allowed = new Set(["enabled", "agentCursorEnabled", "agentCursorName"]);
  for (const key of Object.keys(nextSettings)) {
    if (!allowed.has(key)) throw new Error(`Unsupported browser setting: ${key}`);
  }
  if (Object.hasOwn(nextSettings, "enabled") && typeof nextSettings.enabled !== "boolean") {
    throw new Error("enabled must be boolean.");
  }
  if (Object.hasOwn(nextSettings, "agentCursorEnabled") && typeof nextSettings.agentCursorEnabled !== "boolean") {
    throw new Error("agentCursorEnabled must be boolean.");
  }
  if (Object.hasOwn(nextSettings, "agentCursorName") && typeof nextSettings.agentCursorName !== "string") {
    throw new Error("agentCursorName must be text.");
  }
  if (Object.hasOwn(nextSettings, "enabled")) await setBrowserEnabled(nextSettings.enabled);
  if (Object.hasOwn(nextSettings, "agentCursorEnabled")) await setAgentCursorEnabled(nextSettings.agentCursorEnabled);
  if (Object.hasOwn(nextSettings, "agentCursorName")) await setAgentCursorName(nextSettings.agentCursorName);
  return await popupStatus();
}

function postSuccessfulResponse(id, result) {
  const data = typeof result?.data === "string" ? result.data : null;
  if (!data || data.length <= RESPONSE_CHUNK_CHARS) {
    nativePort?.postMessage({ type: "response", id, ok: true, result });
    return;
  }

  const { data: _data, ...metadata } = result;
  const total = Math.ceil(data.length / RESPONSE_CHUNK_CHARS);
  for (let index = 0; index < total; index += 1) {
    nativePort?.postMessage({
      type: "response.chunk",
      id,
      field: "data",
      index,
      total,
      data: data.slice(index * RESPONSE_CHUNK_CHARS, (index + 1) * RESPONSE_CHUNK_CHARS),
    });
  }
  nativePort?.postMessage({
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
  if (!parsed) return false;
  if (parsed.hostname === "chromewebstore.google.com") return true;
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
  } catch {
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
  if (!value) throw new Error("URL is required");
  const policy = classifyBrowserPage(value);
  if (!policy.openSupported) throw restrictedPageError(policy);
  if (isNewTabUrl(value)) return value;
  return new URL(value).toString();
}

async function chooseTab(tabId) {
  if (Number.isInteger(tabId)) return await chrome.tabs.get(tabId);
  const active = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active[0]) return active[0];
  const current = await chrome.tabs.query({ active: true, currentWindow: true });
  if (current[0]) return current[0];
  const all = await chrome.tabs.query({});
  if (all[0]) return all[0];
  throw new Error("No Chrome tab is available");
}

async function waitForTab(tabId, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let tab;
  while (Date.now() < deadline) {
    tab = await chrome.tabs.get(tabId);
    if (predicate(tab)) return tab;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for tab ${tabId}: ${tab?.url || "unknown"}`);
}

async function send(tabId, method, params = {}, sessionId = null) {
  const debuggee = sessionId ? { tabId, sessionId } : { tabId };
  return await chrome.debugger.sendCommand(debuggee, method, params);
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

function registerChildSession(tabId, sessionId, targetInfo = {}) {
  const state = attachedTabs.get(tabId);
  if (!state || !sessionId) return;
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
  if (!state || !sessionId) return;
  state.sessions.delete(sessionId);
  invalidateRefs(tabId, { bumpGeneration: true });
}

async function ensureFrameRouting(tabId) {
  const state = attachedTabs.get(tabId);
  if (!state || state.frameRoutingReady) return;
  await send(tabId, "Page.enable");
  await send(tabId, "Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  });
  state.frameRoutingReady = true;
}

function scheduleDetach(tabId, idleMs = DEFAULT_ATTACH_IDLE_MS) {
  const state = attachedTabs.get(tabId);
  if (!state || state.persistent || currentDialogRecord(tabId)) return;
  clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    void detachTab(tabId).catch(() => {});
  }, idleMs);
  // Node test timers expose unref(); browser timers are numeric and simply ignore this.
  state.timer?.unref?.();
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
  if (!attachedTabs.has(tabId)) {
    try {
      await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
    } catch (error) {
      let tab = null;
      try {
        tab = await chrome.tabs.get(tabId);
      } catch {
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
  if (persistent) {
    state.persistent = true;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    return;
  }
  scheduleDetach(tabId, idleMs);
}

async function detachTab(tabId) {
  const state = attachedTabs.get(tabId);
  if (state?.timer) clearTimeout(state.timer);
  attachedTabs.delete(tabId);
  refStates.delete(tabId);
  observationStates.delete(tabId);
  dialogStates.delete(tabId);
  rejectPendingHtml5DragIntercept(tabId, "Debugger detached while waiting for HTML5 drag interception");
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // Already detached or tab closed.
  }
}

async function requireDebuggableTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const policy = classifyBrowserPage(tab);
  if (!policy.debuggerSupported) throw restrictedPageError(policy);
  return tab;
}

function pushBounded(list, value, limit = MAX_OBSERVATION_EVENTS) {
  list.push(value);
  if (list.length > limit) list.splice(0, list.length - limit);
}

function pushObservationEvent(state, stream, value) {
  const cursorField = `${stream}Cursor`;
  const cursor = (Number(state[cursorField]) || 0) + 1;
  state[cursorField] = cursor;
  pushBounded(state[stream], { cursor, ...value });
  return cursor;
}

function rememberNetworkRequest(state, requestId, metadata) {
  if (!requestId) return;
  if (!(state.networkRequests instanceof Map)) state.networkRequests = new Map();
  state.networkRequests.delete(requestId);
  state.networkRequests.set(requestId, metadata);
  while (state.networkRequests.size > MAX_OBSERVATION_EVENTS) {
    const oldest = state.networkRequests.keys().next().value;
    if (oldest == null) break;
    state.networkRequests.delete(oldest);
  }
}

function networkRequestMetadata(state, requestId) {
  return requestId ? state.networkRequests?.get(requestId) || null : null;
}

function forgetNetworkRequest(state, requestId) {
  if (requestId) state.networkRequests?.delete(requestId);
}

function normalizeObservationCursor(value, currentCursor) {
  if (value == null) return null;
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("Observation cursor must be a non-negative safe integer.");
  if (cursor > currentCursor) throw new Error(`Observation cursor ${cursor} is ahead of the current cursor ${currentCursor}.`);
  return cursor;
}

function getObservation(tabId) {
  const state = observationStates.get(tabId);
  if (!state) throw new Error("Observation is not active for this tab. Call equinox_browser_observe_start first.");
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
  if (observation) observation.dialog = dialog;
  return record;
}

function clearDialogState(tabId) {
  dialogStates.delete(tabId);
  const observation = observationStates.get(tabId);
  if (observation) observation.dialog = null;
}

async function waitForNewDialog(tabId, afterSequence, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = currentDialogRecord(tabId);
    if (record && record.sequence > afterSequence) return record.dialog;
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
    void commandPromise.catch(() => {});
    return dialog;
  }
  await commandPromise;
  return null;
}

function remoteValue(arg) {
  if (!arg) return null;
  if (Object.prototype.hasOwnProperty.call(arg, "value")) return arg.value;
  if (arg.unserializableValue) return arg.unserializableValue;
  return arg.description ?? arg.type ?? null;
}

function safeObservedUrl(rawUrl) {
  const value = String(rawUrl || "");
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    for (const [key] of parsed.searchParams) {
      if (/(token|key|secret|auth|password|passwd|session|code)/i.test(key)) parsed.searchParams.set(key, "[REDACTED]");
    }
    return parsed.toString().slice(0, 4_000);
  } catch {
    return value.slice(0, 4_000);
  }
}

function observationRead(state, stream, { limit = 100, clear = false, afterCursor = null, predicate = null } = {}) {
  const list = state[stream];
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
  const currentCursor = Number(state[`${stream}Cursor`]) || 0;
  const cursor = normalizeObservationCursor(afterCursor, currentCursor);
  if (cursor != null && clear) throw new Error("clear cannot be combined with after_cursor; advance the stable cursor instead.");
  const minAvailableCursor = list.length > 0 ? Math.max(0, Number(list[0]?.cursor) - 1) : currentCursor;
  if (cursor != null && cursor < minAvailableCursor) {
    throw new Error(`Observation cursor ${cursor} is no longer available; the bounded event buffer now starts after cursor ${minAvailableCursor}.`);
  }
  let candidates = cursor == null ? list : list.filter((item) => Number(item?.cursor) > cursor);
  if (typeof predicate === "function") candidates = candidates.filter(predicate);
  let items;
  let hasMore = false;
  let nextCursor = currentCursor;
  if (cursor == null) {
    items = candidates.slice(-boundedLimit);
  } else {
    items = candidates.slice(0, boundedLimit);
    hasMore = candidates.length > items.length;
    if (hasMore && items.length > 0) nextCursor = Number(items[items.length - 1].cursor);
  }
  if (clear) list.length = 0;
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
  if (level == null || level === "") return null;
  const normalized = String(level).trim().toLowerCase();
  if (!CONSOLE_LEVEL_FILTERS.has(normalized)) throw new Error(`Unsupported console level filter: ${String(level)}`);
  return normalized;
}

function consoleEventMatches(event, { level = null, query = null } = {}) {
  if (level && String(event?.level || "").toLowerCase() !== level) return false;
  if (!query) return true;
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
  if (normalizedMethod && !/^[A-Z]{1,16}$/.test(normalizedMethod)) throw new Error("Network method filter must contain 1-16 ASCII letters.");
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
  if (filters.urlContains && !String(event?.url || "").includes(filters.urlContains)) return false;
  if (filters.method && String(event?.method || "").toUpperCase() !== filters.method) return false;
  if (filters.status != null && Number(event?.status) !== filters.status) return false;
  if (filters.resourceType && String(event?.type || "").toLowerCase() !== filters.resourceType) return false;
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
  if (!waiters) return;
  waiters.delete(state);
  if (waiters.size === 0) networkResponseWaitStates.delete(tabId);
}

function axProperty(node, name) {
  const prop = (node.properties || []).find((item) => item?.name === name);
  return prop?.value?.value ?? null;
}

function flattenFrameTree(frameTree, route, output = []) {
  const frame = frameTree?.frame;
  if (!frame?.id) return output;
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
  for (const child of frameTree.childFrames || []) flattenFrameTree(child, route, output);
  return output;
}

async function collectFrameContexts(tabId) {
  await ensureFrameRouting(tabId);
  await sleep(25);
  const contexts = new Map();
  const rootTree = await send(tabId, "Page.getFrameTree");
  for (const frame of flattenFrameTree(rootTree?.frameTree, { sessionId: null, targetId: null, isOopif: false })) {
    contexts.set(frame.id, frame);
  }

  const state = attachedTabs.get(tabId);
  for (const session of state?.sessions?.values() || []) {
    if (session.type && session.type !== "iframe") continue;
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
    } catch {
      // A child target may disappear between auto-attach and enumeration.
    }
  }
  return [...contexts.values()];
}

async function frameAccessibilityTree(tabId, frame, { rootBackendNodeId = null } = {}) {
  await send(tabId, "Accessibility.enable", {}, frame.sessionId);
  if (Number.isInteger(rootBackendNodeId)) {
    await send(tabId, "DOM.enable", {}, frame.sessionId);
    return await send(tabId, "Accessibility.queryAXTree", {
      backendNodeId: rootBackendNodeId,
    }, frame.sessionId);
  }
  try {
    return await send(tabId, "Accessibility.getFullAXTree", { frameId: frame.id }, frame.sessionId);
  } catch (error) {
    if (!frame.sessionId || (frame.targetId && frame.targetId !== frame.id)) throw error;
    return await send(tabId, "Accessibility.getFullAXTree", {}, frame.sessionId);
  }
}

function normalizeSnapshotMode(mode, includeReadable) {
  if (mode == null || mode === "") return includeReadable === false ? "interactive" : "balanced";
  const normalized = String(mode).toLowerCase();
  if (!new Set(["interactive", "readable", "balanced"]).has(normalized)) {
    throw new Error(`Unsupported snapshot mode: ${String(mode)}`);
  }
  return normalized;
}

function normalizeSnapshotScope(scope) {
  const normalized = String(scope || "document").toLowerCase();
  if (!new Set(["document", "viewport"]).has(normalized)) {
    throw new Error(`Unsupported snapshot scope: ${String(scope)}`);
  }
  return normalized;
}

function normalizeSnapshotRoles(roles) {
  if (!Array.isArray(roles) || roles.length === 0) return null;
  return new Set(
    roles
      .map((role) => String(role || "").trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 50),
  );
}

async function frameViewport(tabId, frame) {
  const metrics = await send(tabId, "Page.getLayoutMetrics", {}, frame.sessionId);
  const viewport = metrics?.cssLayoutViewport || metrics?.layoutViewport;
  const x = Number(viewport?.pageX ?? 0);
  const y = Number(viewport?.pageY ?? 0);
  const width = Number(viewport?.clientWidth ?? viewport?.width ?? 0);
  const height = Number(viewport?.clientHeight ?? viewport?.height ?? 0);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

async function backendNodeBounds(tabId, frame, backendNodeId) {
  if (!Number.isInteger(backendNodeId)) return null;
  try {
    const result = await send(tabId, "DOM.getBoxModel", { backendNodeId }, frame.sessionId);
    const quad = result?.model?.border || result?.model?.content || result?.model?.padding || result?.model?.margin;
    if (!Array.isArray(quad) || quad.length < 8) return null;
    const xs = [quad[0], quad[2], quad[4], quad[6]].map(Number);
    const ys = [quad[1], quad[3], quad[5], quad[7]].map(Number);
    if (![...xs, ...ys].every(Number.isFinite)) return null;
    return {
      left: Math.min(...xs),
      top: Math.min(...ys),
      right: Math.max(...xs),
      bottom: Math.max(...ys),
    };
  } catch {
    return null;
  }
}

function boundsIntersectViewport(bounds, viewport) {
  if (!bounds || !viewport) return false;
  return !(
    bounds.right <= viewport.x ||
    bounds.left >= viewport.x + viewport.width ||
    bounds.bottom <= viewport.y ||
    bounds.top >= viewport.y + viewport.height
  );
}

function rememberSnapshotState(tabId, state) {
  if (!Number.isInteger(tabId) || !state?.id) return;
  const history = snapshotHistories.get(tabId) || [];
  history.push(state);
  if (history.length > MAX_SNAPSHOT_HISTORY) history.splice(0, history.length - MAX_SNAPSHOT_HISTORY);
  snapshotHistories.set(tabId, history);
}

function snapshotStateById(tabId, snapshotId) {
  const history = snapshotHistories.get(tabId) || [];
  return history.find((item) => item.id === snapshotId) || null;
}

function stableRefForIdentity(tabId, generation, identity) {
  let registry = refRegistries.get(tabId);
  if (!registry || registry.documentGeneration !== generation) {
    registry = {
      documentGeneration: generation,
      nextRefIndex: 1,
      byIdentity: new Map(),
    };
    refRegistries.set(tabId, registry);
  }
  const existing = registry.byIdentity.get(identity);
  if (existing) return existing;
  const ref = `@e${registry.nextRefIndex++}`;
  registry.byIdentity.set(identity, ref);
  while (registry.byIdentity.size > MAX_REF_REGISTRY_ENTRIES) {
    const oldest = registry.byIdentity.keys().next().value;
    if (oldest == null) break;
    registry.byIdentity.delete(oldest);
  }
  return ref;
}

function publicSnapshotElement(element) {
  const { backendNodeId: _backendNodeId, identity: _identity, ...publicElement } = element;
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
  });
}

function buildSnapshotDelta(base, currentElements, snapshotId) {
  const baseElements = Array.isArray(base?.elements) ? base.elements : [];
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
    if (current.ref) retainedRefs.push(current.ref);
    if (snapshotElementSignature(previous) !== snapshotElementSignature(current)) {
      changed.push({
        ref: current.ref || null,
        before: publicSnapshotElement(previous),
        after: publicSnapshotElement(current),
      });
    }
  }

  for (const previous of baseElements) {
    if (currentByIdentity.has(previous.identity)) continue;
    const publicPrevious = publicSnapshotElement(previous);
    removed.push({
      ...publicPrevious,
      previousRef: publicPrevious.ref || null,
      ref: null,
    });
  }

  return {
    version: DELTA_SNAPSHOT_VERSION,
    baseSnapshotId: base.id,
    snapshotId,
    added,
    removed,
    changed,
    retainedRefs,
    retainedCount: retainedRefs.length,
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
    objectId = resolved?.object?.objectId || null;
    if (!objectId) return { exists: false, visible: false, enabled: false };
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
    const value = evaluated?.result?.value || {};
    return {
      exists: Boolean(value.exists),
      visible: Boolean(value.visible),
      enabled: Boolean(value.enabled),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/No node|Could not find node|Node with given id|Cannot find context|object.*not found/i.test(message)) {
      return { exists: false, visible: false, enabled: false };
    }
    throw error;
  } finally {
    if (objectId) await send(tabId, "Runtime.releaseObject", { objectId }, target.sessionId).catch(() => {});
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
  if (element.ref) parts.push(element.ref);
  parts.push(element.role || "unknown");
  if (element.name) parts.push(JSON.stringify(element.name));
  if (element.value != null && element.value !== "") parts.push(`value=${JSON.stringify(String(element.value))}`);
  if (element.disabled === true) parts.push("[disabled]");
  if (element.checked != null) parts.push(`[checked=${element.checked}]`);
  if (element.selected != null) parts.push(`[selected=${element.selected}]`);
  if (element.frameId) parts.push(`[frame=${element.frameId}]`);
  return parts.join(" ");
}

function pageKindFromFrames(basePolicy, frames) {
  const frameList = Array.isArray(frames) ? frames : [];
  if (
    frameList.some((frame) => frame?.mimeType === "application/pdf") ||
    frameList.some((frame) => String(frame?.url || "").startsWith(`chrome-extension://${CHROME_PDF_VIEWER_EXTENSION_ID}/`))
  ) {
    return "chrome-pdf-viewer";
  }
  if (frameList.some((frame) => String(frame?.url || "").startsWith("chrome-error://"))) {
    return "browser-owned-error";
  }
  return basePolicy?.kind || "unknown";
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
  if (mode === "both") return { ...response, outputMode: mode };
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
    ...(Number.isInteger(response.elementCount) ? { elementCount: response.elementCount } : {}),
    ...(Number.isInteger(response.returnedElementCount) ? { returnedElementCount: response.returnedElementCount } : {}),
    ...(typeof response.truncated === "boolean" ? { truncated: response.truncated } : {}),
    ...(typeof response.deltaOnly === "boolean" ? { deltaOnly: response.deltaOnly } : {}),
    outputMode: mode,
  };
  if (mode === "compact") {
    if (response.deltaOnly && response.delta) return { ...common, delta: response.delta };
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

async function browserSnapshot({
  tabId,
  includeReadable = true,
  mode,
  scope = "document",
  maxNodes = MAX_SNAPSHOT_ELEMENTS,
  rootRef,
  roles,
  query,
  sinceSnapshotId,
  output = "both",
} = {}) {
  const snapshotMode = normalizeSnapshotMode(mode, includeReadable);
  const snapshotScope = normalizeSnapshotScope(scope);
  const snapshotOutput = normalizeSnapshotOutput(output);
  const requestedMaxNodes = Math.max(1, Math.min(
    Number.isFinite(Number(maxNodes)) ? Math.floor(Number(maxNodes)) : MAX_SNAPSHOT_ELEMENTS,
    MAX_SNAPSHOT_ELEMENTS,
  ));
  const roleFilter = normalizeSnapshotRoles(roles);
  const queryNeedle = String(query || "").trim().toLowerCase();
  const filters = {
    mode: snapshotMode,
    scope: snapshotScope,
    maxNodes: requestedMaxNodes,
    rootRef: rootRef || null,
    roles: roleFilter ? [...roleFilter].sort() : null,
    query: queryNeedle || null,
  };
  const tab = await chooseTab(tabId);
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
  if (!policy.debuggerSupported) return restrictedSnapshot(tab, policy, snapshotOutput);
  await requireDebuggableTab(tab.id);
  try {
    await attachTab(tab.id);
  } catch (error) {
    if (error?.code === "EQUINOX_RESTRICTED_PAGE") {
      return restrictedSnapshot(tab, { kind: error.pageKind, reason: error.reason }, snapshotOutput);
    }
    throw error;
  }
  const rootTarget = rootRef ? lookupRef(tab.id, String(rootRef)) : null;
  const frames = await collectFrameContexts(tab.id);
  const pageKind = pageKindFromFrames(policy, frames);
  if (pageKind === "browser-owned-error") {
    await detachTab(tab.id);
    return restrictedSnapshot(tab, { kind: pageKind, reason: "browser-owned" }, snapshotOutput);
  }
  const generation = currentDocumentGeneration(tab.id);
  const mainFrameId = frames.find((frame) => !frame.parentId && !frame.sessionId)?.id || frames[0]?.id || null;
  const selectedFrames = rootTarget
    ? frames.filter((frame) => frame.id === rootTarget.frameId && (frame.sessionId || null) === (rootTarget.sessionId || null))
    : frames;
  if (rootTarget && selectedFrames.length !== 1) {
    throw new Error(`Snapshot root ref frame is unavailable: ${String(rootRef)}`);
  }
  const refs = new Map();
  const elements = [];
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
    } catch (error) {
      if (rootTarget) throw error;
      continue;
    }
    const viewport = snapshotScope === "viewport" ? await frameViewport(tab.id, frame) : null;
    const nodes = tree?.nodes || [];
    for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
      const node = nodes[nodeIndex];
      if (node?.ignored) continue;
      const role = node?.role?.value || "";
      const name = node?.name?.value || "";
      const value = node?.value?.value ?? null;
      const backendNodeId = node?.backendDOMNodeId;
      const interactive = INTERACTIVE_ROLES.has(role) && Number.isInteger(backendNodeId);
      const readable = READABLE_ROLES.has(role) && Boolean(name);
      const modeMatched = (
        (snapshotMode !== "readable" && interactive) ||
        (snapshotMode !== "interactive" && readable)
      );
      if (!modeMatched) continue;
      if (roleFilter && !roleFilter.has(String(role).toLowerCase())) continue;
      if (queryNeedle) {
        const haystack = [role, name, value]
          .filter((part) => part != null)
          .map((part) => String(part).toLowerCase());
        if (!haystack.some((part) => part.includes(queryNeedle))) continue;
      }
      if (snapshotScope === "viewport") {
        const bounds = await backendNodeBounds(tab.id, frame, backendNodeId);
        if (!boundsIntersectViewport(bounds, viewport)) continue;
      }
      if (elements.length >= requestedMaxNodes) {
        truncated = true;
        break;
      }

      const identityWithinDocument = interactive
        ? `dom:${frame.sessionId || "root"}:${frame.id}:${backendNodeId}`
        : `ax:${frame.sessionId || "root"}:${frame.id}:${node?.nodeId || `${nodeIndex}:${role}:${name}:${String(value ?? "")}`}`;
      const element = {
        identity: `${generation}:${identityWithinDocument}`,
        ref: null,
        role,
        name,
        value,
        frameId: frame.id,
        frameProcess: frame.isOopif ? "oopif" : "same-process",
        disabled: axProperty(node, "disabled"),
        checked: axProperty(node, "checked"),
        selected: axProperty(node, "selected"),
        expanded: axProperty(node, "expanded"),
        required: axProperty(node, "required"),
        focusable: axProperty(node, "focusable"),
        backendNodeId: interactive ? backendNodeId : null,
      };
      if (interactive) {
        element.ref = stableRefForIdentity(tab.id, generation, identityWithinDocument);
        refs.set(element.ref, {
          backendNodeId,
          role,
          name,
          frameId: frame.id,
          value,
          sessionId: frame.sessionId,
          targetId: frame.targetId,
          documentGeneration: generation,
        });
      }
      elements.push(element);
    }
    if (truncated) break;
  }

  const snapshotId = `${tab.id}:${generation}:${Date.now()}`;
  const mutationCounter = await domMutationCounter(tab.id).catch(() => null);
  refStates.set(tab.id, {
    snapshotId,
    createdAt: Date.now(),
    documentGeneration: generation,
    url: tab.url,
    refs,
  });
  const historyElements = elements.map((element) => ({ ...element }));
  const delta = baseSnapshot ? buildSnapshotDelta(baseSnapshot, historyElements, snapshotId) : null;
  rememberSnapshotState(tab.id, {
    id: snapshotId,
    createdAt: Date.now(),
    documentGeneration: generation,
    url: tab.url,
    mutationCounter,
    filters,
    elements: historyElements,
  });
  scheduleDetach(tab.id);

  const publicElements = elements.map(publicSnapshotElement);
  const returnedElements = delta
    ? [...delta.added, ...delta.changed.map((item) => item.after)]
    : publicElements;
  const responseText = delta
    ? [
        ...delta.added.map((item) => `+ ${formatSnapshotLine(item)}`),
        ...delta.changed.map((item) => `~ ${formatSnapshotLine(item.after)}`),
        ...delta.removed.map((item) => `- ${formatSnapshotLine({ ...item, ref: item.previousRef || null })}`),
      ].join("\n")
    : publicElements.map(formatSnapshotLine).join("\n");

  const response = {
    tab: { id: tab.id, windowId: tab.windowId, title: tab.title, url: tab.url, active: tab.active },
    snapshotVersion: SNAPSHOT_VERSION,
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
    frames: frames.map((frame) => publicFrameContext(frame, mainFrameId)),
    refCount: refs.size,
    elementCount: elements.length,
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
  if (!clip || typeof clip !== "object") return null;
  const x = Number(clip.x);
  const y = Number(clip.y);
  const width = Number(clip.width);
  const height = Number(clip.height);
  if (![x, y, width, height].every(Number.isFinite)) {
    throw new Error("Screenshot clip coordinates must be finite numbers.");
  }
  if (x < 0 || y < 0 || width <= 0 || height <= 0) {
    throw new Error("Screenshot clip requires x/y >= 0 and width/height > 0.");
  }
  return { x, y, width, height };
}

async function buildScreenshotAnnotations(tabId, captureClip) {
  const state = refStates.get(tabId);
  if (!state) throw new Error("annotateRefs requires a current snapshot. Take a new snapshot first.");
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
  const skippedOopifRefs = [];
  let intersectingRootRefs = 0;
  for (const [ref, target] of state.refs.entries()) {
    if (target.sessionId) {
      skippedOopifRefs.push(ref);
      continue;
    }
    const bounds = await backendNodeBounds(
      tabId,
      { id: target.frameId, sessionId: null },
      target.backendNodeId,
    );
    if (!bounds || !boundsIntersectViewport(bounds, viewport)) continue;
    intersectingRootRefs += 1;
    if (labels.length >= MAX_SCREENSHOT_ANNOTATIONS) continue;
    labels.push({
      ref,
      x: Math.max(captureClip.x + 2, bounds.left),
      y: Math.max(captureClip.y + 2, bounds.top),
    });
  }
  return {
    labels,
    skippedOopifRefs,
    truncated: intersectingRootRefs > labels.length,
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
  }).catch(() => {});
}

async function browserScreenshot({
  tabId,
  fullPage = false,
  pixelDensity = "css-1x",
  ref,
  clip,
  annotateRefs = false,
} = {}) {
  const explicitClip = normalizeScreenshotClip(clip);
  const specializedCount = [Boolean(fullPage), Boolean(ref), Boolean(explicitClip)].filter(Boolean).length;
  if (specializedCount > 1) {
    throw new Error("fullPage, ref and clip are mutually exclusive screenshot scopes.");
  }

  const tab = await chooseTab(tabId);
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
    const target = lookupRef(tab.id, String(ref));
    if (target.sessionId) {
      throw new Error(
        `Ref screenshot for out-of-process iframe targets is not supported safely yet: ${String(ref)}. Use a page clip instead.`,
      );
    }
    const bounds = await backendNodeBounds(
      tab.id,
      { id: target.frameId, sessionId: target.sessionId || null },
      target.backendNodeId,
    );
    if (!bounds) throw new Error(`Element has no capturable box: ${String(ref)}`);
    sourceKind = "ref";
    sourceRef = String(ref);
    sourceClip = {
      x: Math.max(0, bounds.left),
      y: Math.max(0, bounds.top),
      width: Math.max(1, bounds.right - bounds.left),
      height: Math.max(1, bounds.bottom - bounds.top),
    };
  } else if (explicitClip) {
    sourceKind = "clip";
    sourceClip = explicitClip;
  }

  const source = sourceClip || (fullPage ? content : viewport);
  const width = Math.ceil(Number(source?.width || source?.clientWidth || 0));
  const height = Math.ceil(Number(source?.height || source?.clientHeight || 0));

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error("Unable to determine a valid screenshot viewport.");
  }
  const outputWidth = Math.ceil(width * devicePixelRatio * captureScale);
  const outputHeight = Math.ceil(height * devicePixelRatio * captureScale);
  if (
    width > MAX_SCREENSHOT_DIMENSION ||
    height > MAX_SCREENSHOT_DIMENSION ||
    outputWidth > MAX_SCREENSHOT_DIMENSION ||
    outputHeight > MAX_SCREENSHOT_DIMENSION
  ) {
    throw new Error(
      `Screenshot dimensions exceed the ${MAX_SCREENSHOT_DIMENSION}px safety limit: ${outputWidth}x${outputHeight}`,
    );
  }
  if (outputWidth * outputHeight > MAX_SCREENSHOT_AREA) {
    throw new Error(
      `Screenshot area exceeds the ${MAX_SCREENSHOT_AREA.toLocaleString()}px safety limit: ${outputWidth}x${outputHeight}`,
    );
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
  } finally {
    if (annotateRefs) await removeScreenshotAnnotations(tab.id);
  }
  const data = String(captured?.data || "");
  if (!data) throw new Error("Chrome returned an empty screenshot.");
  const estimatedBytes = Math.floor((data.length * 3) / 4);
  if (estimatedBytes > MAX_SCREENSHOT_PNG_BYTES) {
    throw new Error(
      `Screenshot exceeds the ${MAX_SCREENSHOT_PNG_BYTES / 1024 / 1024} MB transport limit.`,
    );
  }

  scheduleDetach(tab.id, 5_000);
  return {
    tab: { id: tab.id, windowId: tab.windowId, title: tab.title, url: tab.url, active: tab.active },
    screenshotVersion: SCREENSHOT_VERSION,
    source: sourceKind,
    ref: sourceRef,
    clip: {
      x: captureClip.x,
      y: captureClip.y,
      width: captureClip.width,
      height: captureClip.height,
    },
    annotations: {
      requested: Boolean(annotateRefs),
      annotatedRefs: annotationData?.labels?.map((item) => item.ref) || [],
      skippedOopifRefs: annotationData?.skippedOopifRefs || [],
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
  if (!needle) throw new Error("query is required");
  const roleNeedle = role ? String(role).trim().toLocaleLowerCase() : null;
  const snapshot = await browserSnapshot({ tabId, includeReadable: true });
  if (snapshot.restricted) return { ...snapshot, query, role: role || null, exact: Boolean(exact), matches: [] };
  const matches = snapshot.elements.filter((element) => {
    if (roleNeedle && String(element.role || "").toLocaleLowerCase() !== roleNeedle) return false;
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
  return (
    source?.frameId === candidate?.frameId &&
    normalizedReacquireField(source?.role) === normalizedReacquireField(candidate?.role) &&
    normalizedReacquireField(source?.name) === normalizedReacquireField(candidate?.name) &&
    normalizedReacquireField(source?.value) === normalizedReacquireField(candidate?.value)
  );
}

async function browserReacquire({ tabId, oldRef, fromSnapshotId } = {}) {
  const ref = String(oldRef || "");
  if (!/^@e\d+$/.test(ref)) throw new Error("oldRef must be a snapshot ref such as @e3");
  const tab = await chooseTab(tabId);
  const generation = currentDocumentGeneration(tab.id);
  const history = snapshotHistories.get(tab.id) || [];
  const sourceSnapshot = fromSnapshotId
    ? snapshotStateById(tab.id, String(fromSnapshotId))
    : [...history].reverse().find((item) => (
        item.documentGeneration === generation &&
        item.elements.some((element) => element.ref === ref)
      ));
  if (!sourceSnapshot) {
    throw new Error(`No bounded source snapshot contains ${ref}. Take a snapshot before attempting reacquire.`);
  }
  if (sourceSnapshot.documentGeneration !== generation) {
    throw new Error("Reacquire is limited to the same document generation; take a fresh snapshot after navigation.");
  }
  const source = sourceSnapshot.elements.find((element) => element.ref === ref);
  if (!source) throw new Error(`Source snapshot does not contain ref: ${ref}`);

  const fresh = await browserSnapshot({ tabId: tab.id, mode: "interactive" });
  if (fresh.restricted) throw new Error("Reacquire is unavailable on restricted browser pages.");
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
  };
}

function lookupRef(tabId, ref) {
  const state = refStates.get(tabId);
  if (!state) throw new Error("No active snapshot refs for this tab. Take a new snapshot first.");
  const generation = currentDocumentGeneration(tabId);
  if (state.documentGeneration !== generation) {
    refStates.delete(tabId);
    throw new Error(`Snapshot ref is stale after document/frame navigation: ${ref}`);
  }
  const item = state.refs.get(ref);
  if (!item) throw new Error(`Snapshot ref not found: ${ref}`);
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
    const resolved = await send(
      tabId,
      "DOM.resolveNode",
      { backendNodeId: target.backendNodeId },
      target.sessionId,
    );
    objectId = resolved?.object?.objectId || null;
    if (!objectId) throw new Error(`Element cannot be resolved for hit testing: ${ref}`);
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
          if (hit && composedContains(this, hit)) return point;
        }
        return null;
      }`,
      arguments: [{ value: clickCandidatePoints(quad) }],
      returnByValue: true,
      silent: true,
    }, target.sessionId);
    const point = result?.result?.value;
    if (Number.isFinite(point?.x) && Number.isFinite(point?.y)) return { x: point.x, y: point.y };
    throw new Error(`Element has no unobscured clickable point: ${ref}`);
  } finally {
    if (objectId) {
      await send(tabId, "Runtime.releaseObject", { objectId }, target.sessionId).catch(() => {});
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
  if (!(await ensureAgentCursorEnabledLoaded())) return false;
  if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return false;
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
  const duration = Number(result?.result?.value?.duration);
  if (Number.isFinite(duration)) await sleep(Math.min(duration, 260));
  return Boolean(result);
}

async function moveAgentCursorToRef(tabId, ref, { pulse = false, agentName } = {}) {
  const target = lookupRef(tabId, ref);
  await send(tabId, "Page.bringToFront");
  await send(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId: target.backendNodeId }, target.sessionId);
  const box = await send(tabId, "DOM.getBoxModel", { backendNodeId: target.backendNodeId }, target.sessionId);
  const quad = box?.model?.border || box?.model?.content;
  if (!Array.isArray(quad) || quad.length < 8) throw new Error(`Element has no visible box: ${ref}`);
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

function normalizeActionAfter(after, tabId, actionName = "action") {
  if (after == null) return null;
  if (typeof after !== "object" || Array.isArray(after)) throw new Error(`${actionName} after must be an object`);
  const waitFor = after.waitFor == null ? null : String(after.waitFor);
  const snapshot = after.snapshot == null ? null : String(after.snapshot);
  if (waitFor && !new Set(["dom_stable", "network_idle"]).has(waitFor)) {
    throw new Error(`Unsupported ${actionName} after.waitFor: ${waitFor}`);
  }
  if (snapshot && !new Set(["delta", "full"]).has(snapshot)) {
    throw new Error(`Unsupported ${actionName} after.snapshot: ${snapshot}`);
  }
  if (!waitFor && !snapshot) throw new Error(`${actionName} after requires waitFor and/or snapshot`);
  const quietMs = Math.max(100, Math.min(Number(after.quietMs) || 500, 5_000));
  const timeoutMs = Math.max(100, Math.min(Number(after.timeoutMs) || 10_000, 60_000));
  const baseSnapshotId = refStates.get(tabId)?.snapshotId || null;
  const baseSnapshot = baseSnapshotId ? snapshotStateById(tabId, baseSnapshotId) : null;
  if (snapshot === "delta" && !baseSnapshot) {
    throw new Error(`${actionName} after.snapshot=delta requires a current snapshot base`);
  }
  if (snapshot && baseSnapshot?.filters?.rootRef) {
    throw new Error(`${actionName} compound snapshot does not support a root_ref base; take an unscoped snapshot first`);
  }
  return { waitFor, snapshot, quietMs, timeoutMs, baseSnapshotId, baseSnapshot };
}

function snapshotArgsFromBase(baseSnapshot, { delta = false } = {}) {
  const filters = baseSnapshot?.filters || {};
  return {
    mode: filters.mode || "balanced",
    scope: filters.scope || "document",
    maxNodes: Number(filters.maxNodes) || MAX_SNAPSHOT_ELEMENTS,
    output: "compact",
    ...(Array.isArray(filters.roles) && filters.roles.length ? { roles: filters.roles } : {}),
    ...(filters.query ? { query: filters.query } : {}),
    ...(delta && baseSnapshot?.id ? { sinceSnapshotId: baseSnapshot.id } : {}),
  };
}

async function runActionAfter(tabId, config) {
  if (!config) return null;
  const result = { ok: true, wait: null, snapshot: null };
  try {
    if (config.waitFor === "dom_stable") {
      result.wait = await browserWait({
        tabId,
        domStable: true,
        quietMs: config.quietMs,
        timeoutMs: config.timeoutMs,
      });
    } else if (config.waitFor === "network_idle") {
      result.wait = await browserWait({
        tabId,
        networkIdle: true,
        quietMs: config.quietMs,
        timeoutMs: config.timeoutMs,
      });
    }
  } catch (error) {
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
        ...snapshotArgsFromBase(config.baseSnapshot, { delta: true }),
      });
    } else if (config.snapshot === "full") {
      result.snapshot = await browserSnapshot({
        tabId,
        ...snapshotArgsFromBase(config.baseSnapshot),
      });
    }
  } catch (error) {
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
  if (!new Set(["left", "right", "middle"]).has(value)) throw new Error(`Unsupported mouse button: ${value}`);
  return value;
}

function mouseButtonsMask(button) {
  if (button === "right") return 2;
  if (button === "middle") return 4;
  return 1;
}

function normalizeInputModifiers(modifiers = []) {
  const list = modifiers == null ? [] : modifiers;
  if (!Array.isArray(list)) throw new Error("modifiers must be an array");
  let mask = 0;
  const normalized = [];
  for (const raw of list) {
    const value = String(raw || "").toLowerCase();
    if (!value) continue;
    if (value === "alt" || value === "option") mask |= 1;
    else if (value === "ctrl" || value === "control") mask |= 2;
    else if (value === "meta" || value === "cmd" || value === "command") mask |= 4;
    else if (value === "shift") mask |= 8;
    else throw new Error(`Unsupported input modifier: ${raw}`);
    if (!normalized.includes(value)) normalized.push(value);
  }
  return { mask, values: normalized };
}

async function browserClick({
  tabId,
  ref,
  agentName,
  after,
  clickCount = 1,
  button = "left",
  modifiers = [],
  delayMs = 0,
} = {}) {
  const tab = await chooseTab(tabId);
  const afterConfig = normalizeActionAfter(after, tab.id, "click");
  const requestedClickCount = Number(clickCount);
  if (![1, 2].includes(requestedClickCount)) throw new Error("clickCount must be 1 or 2");
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
      blockedByDialog: true,
      dialogOpened: existingDialog.dialog,
      button: requestedButton,
      modifiers: modifierInfo.values,
      delayMs: boundedDelayMs,
      compoundActionVersion: COMPOUND_ACTION_VERSION,
      after: afterConfig ? { ok: false, skipped: true, reason: "blocked_by_dialog" } : null,
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
  const moved = await moveAgentCursorToRef(tab.id, ref, { pulse: true, agentName });
  const { target, point } = moved;
  let dialog = null;
  for (let currentClick = 1; currentClick <= requestedClickCount && !dialog; currentClick += 1) {
    const pressPromise = send(tab.id, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      ...point,
      button: requestedButton,
      buttons: mouseButtonsMask(requestedButton),
      modifiers: modifierInfo.mask,
      clickCount: currentClick,
    }, target.sessionId);
    dialog = await settleCommandOrDialog(tab.id, pressPromise, dialogSequenceBefore);
    if (dialog) break;
    if (boundedDelayMs > 0) await sleep(boundedDelayMs);
    const releasePromise = send(tab.id, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      ...point,
      button: requestedButton,
      buttons: 0,
      modifiers: modifierInfo.mask,
      clickCount: currentClick,
    }, target.sessionId);
    dialog = await settleCommandOrDialog(tab.id, releasePromise, dialogSequenceBefore);
  }

  const [openedTabs, downloadsStarted] = await Promise.all([
    discoverNewTabs(tabCreationSequenceBefore, tab.id),
    discoverNewDownloads(downloadCreationSequenceBefore),
  ]);

  refStates.delete(tab.id);
  const afterResult = dialog || !afterConfig
    ? (afterConfig ? { ok: false, skipped: true, reason: "dialog_opened" } : null)
    : await runActionAfter(tab.id, afterConfig);
  scheduleDetach(tab.id, 250);
  return {
    clickVersion: CLICK_VERSION,
    tabId: tab.id,
    ref,
    point,
    clickCount: requestedClickCount,
    button: requestedButton,
    modifiers: modifierInfo.values,
    delayMs: boundedDelayMs,
    frameId: target.frameId,
    sessionScope: target.sessionId ? "child" : "root",
    dialogOpened: dialog || null,
    compoundActionVersion: COMPOUND_ACTION_VERSION,
    after: afterResult,
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

async function performHtml5Drag({
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
}) {
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
        if (dialog) break;
        if (stepDelay > 0 && index < stepCount && !interceptState.settled) await sleep(stepDelay);
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
  } catch (error) {
    if (dragData && !dropDispatched) {
      await send(tab.id, "Input.dispatchDragEvent", {
        type: "dragCancel",
        ...targetPoint,
        data: dragData,
      }).catch(() => {});
    }
    await send(tab.id, "Input.cancelDragging", {}).catch(() => {});
    throw error;
  } finally {
    rejectPendingHtml5DragIntercept(tab.id, "HTML5 drag interception was cancelled before completion");
    if (pointerDown) {
      await send(tab.id, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        ...targetPoint,
        button: "left",
        buttons: 0,
        clickCount: 1,
      }).catch(() => {});
    }
    if (interceptEnabled) await send(tab.id, "Input.setInterceptDrags", { enabled: false }).catch(() => {});
    if (actionDispatched) refStates.delete(tab.id);
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
  if (!point || !viewport) return false;
  return (
    point.x >= viewport.x &&
    point.y >= viewport.y &&
    point.x <= viewport.x + viewport.width &&
    point.y <= viewport.y + viewport.height
  );
}

async function browserDrag({ tabId, sourceRef, targetRef, mode = "pointer", steps = 8, durationMs = 350, agentName, after } = {}) {
  const sourceRefValue = String(sourceRef || "");
  const targetRefValue = String(targetRef || "");
  const dragMode = String(mode || "pointer").toLowerCase();
  if (!/^@e\d+$/.test(sourceRefValue) || !/^@e\d+$/.test(targetRefValue)) {
    throw new Error("sourceRef and targetRef must be snapshot refs such as @e3");
  }
  if (!new Set(["pointer", "html5"]).has(dragMode)) throw new Error(`Unsupported drag mode: ${dragMode}`);
  if (sourceRefValue === targetRefValue) throw new Error("Semantic drag requires different sourceRef and targetRef values");

  const tab = await chooseTab(tabId);
  const afterConfig = normalizeActionAfter(after, tab.id, "drag");
  await requireDebuggableTab(tab.id);
  await attachTab(tab.id);
  const sourceTarget = lookupRef(tab.id, sourceRefValue);
  const destinationTarget = lookupRef(tab.id, targetRefValue);
  if (
    sourceTarget.frameId !== destinationTarget.frameId ||
    (sourceTarget.sessionId || null) !== (destinationTarget.sessionId || null)
  ) {
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
    return {
      ...result,
      compoundActionVersion: COMPOUND_ACTION_VERSION,
      after: afterResult,
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
        if (dialog) break;
        if (stepDelay > 0 && index < stepCount) await sleep(stepDelay);
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
  } finally {
    if (pointerDown) {
      await send(tab.id, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        ...targetPoint,
        button: "left",
        buttons: 0,
        clickCount: 1,
      }).catch(() => {});
    }
    if (actionDispatched) refStates.delete(tab.id);
    scheduleDetach(tab.id, 250);
  }

  const [openedTabs, downloadsStarted] = await Promise.all([
    discoverNewTabs(tabCreationSequenceBefore, tab.id),
    discoverNewDownloads(downloadCreationSequenceBefore),
  ]);
  const afterResult = dialog || !afterConfig
    ? (afterConfig ? { ok: false, skipped: true, reason: "dialog_opened" } : null)
    : await runActionAfter(tab.id, afterConfig);
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
  if (!Array.isArray(quad) || quad.length < 8) throw new Error(`Element has no visible box: ${ref}`);
  return { point: quadCenter(quad), sessionId: target.sessionId || null, frameId: target.frameId };
}

async function browserHover({ tabId, ref, agentName }) {
  const tab = await chooseTab(tabId);
  await requireDebuggableTab(tab.id);
  await attachTab(tab.id);
  const moved = await moveAgentCursorToRef(tab.id, ref, { agentName });
  refStates.delete(tab.id);
  scheduleDetach(tab.id, 5_000);
  return {
    actionabilityVersion: ACTIONABILITY_VERSION,
    tabId: tab.id,
    ref,
    point: moved.point,
    frameId: moved.frameId,
    sessionScope: moved.sessionId ? "child" : "root",
  };
}

async function browserScrollIntoView({ tabId, ref, agentName }) {
  const tab = await chooseTab(tabId);
  await requireDebuggableTab(tab.id);
  await attachTab(tab.id);
  const moved = await moveAgentCursorToRef(tab.id, ref, { agentName });
  refStates.delete(tab.id);
  scheduleDetach(tab.id, 5_000);
  return {
    actionabilityVersion: ACTIONABILITY_VERSION,
    tabId: tab.id,
    ref,
    scrolledIntoView: true,
    point: moved.point,
    frameId: moved.frameId,
    sessionScope: moved.sessionId ? "child" : "root",
  };
}

async function browserRefInfo({ tabId, ref }) {
  const tab = await chooseTab(tabId);
  await requireDebuggableTab(tab.id);
  await attachTab(tab.id);
  const target = lookupRef(tab.id, ref);
  const live = await inspectLiveRef(tab.id, ref);
  let box = null;
  let state = {};
  if (live.exists) {
    const model = await send(tab.id, "DOM.getBoxModel", { backendNodeId: target.backendNodeId }, target.sessionId).catch(() => null);
    const quad = model?.model?.border || model?.model?.content;
    if (Array.isArray(quad) && quad.length >= 8) {
      const xs = [quad[0], quad[2], quad[4], quad[6]].map(Number);
      const ys = [quad[1], quad[3], quad[5], quad[7]].map(Number);
      box = {
        x: Math.min(...xs),
        y: Math.min(...ys),
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
      };
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
  scheduleDetach(tab.id, 5_000);
  return {
    actionabilityVersion: ACTIONABILITY_VERSION,
    tabId: tab.id,
    ref,
    role: target.role || null,
    name: target.name || "",
    frameId: target.frameId,
    sessionScope: target.sessionId ? "child" : "root",
    ...live,
    ...state,
    box,
  };
}

async function browserScroll({ tabId, direction = "down", pixels = 600, ref, agentName }) {
  const tab = await chooseTab(tabId);
  await requireDebuggableTab(tab.id);
  await attachTab(tab.id);
  await send(tab.id, "Page.bringToFront");
  const amount = Math.max(1, Math.min(Math.abs(Number(pixels) || 600), 20_000));
  let point = { x: 500, y: 400 };
  let sessionId = null;
  if (ref) {
    const moved = await moveAgentCursorToRef(tab.id, ref, { agentName });
    point = moved.point;
    sessionId = moved.sessionId;
  } else {
    const metrics = await send(tab.id, "Page.getLayoutMetrics");
    const viewport = metrics?.cssLayoutViewport || metrics?.layoutViewport;
    if (viewport) point = { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 };
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
  if (!delta) throw new Error(`Unsupported scroll direction: ${direction}`);
  await send(tab.id, "Input.dispatchMouseEvent", { type: "mouseWheel", ...point, ...delta }, sessionId);
  refStates.delete(tab.id);
  scheduleDetach(tab.id, 5_000);
  return { tabId: tab.id, direction: String(direction).toLowerCase(), pixels: amount, point };
}

async function browserSelect({ tabId, ref, option, agentName, after }) {
  const tab = await chooseTab(tabId);
  const afterConfig = normalizeActionAfter(after, tab.id, "select");
  await requireDebuggableTab(tab.id);
  await attachTab(tab.id);
  const { target, point, frameId, sessionId } = await moveAgentCursorToRef(tab.id, ref, { pulse: true, agentName });
  const resolved = await send(tab.id, "DOM.resolveNode", { backendNodeId: target.backendNodeId }, target.sessionId);
  const objectId = resolved?.object?.objectId;
  if (!objectId) throw new Error(`Unable to resolve element: ${ref}`);
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
  if (result?.exceptionDetails) throw new Error(result.exceptionDetails?.text || `Unable to select option: ${option}`);
  const outcome = result?.result?.value || {};
  if (outcome.selected !== true) throw new Error(`Select postcondition failed for ${ref}`);
  refStates.delete(tab.id);
  const afterResult = await runActionAfter(tab.id, afterConfig);
  scheduleDetach(tab.id, 5_000);
  return {
    tabId: tab.id,
    ref,
    point,
    frameId,
    sessionScope: sessionId ? "child" : "root",
    ...outcome,
    compoundActionVersion: COMPOUND_ACTION_VERSION,
    after: afterResult,
  };
}

async function browserCheck({ tabId, ref, checked = true, agentName, after }) {
  const tab = await chooseTab(tabId);
  const afterConfig = normalizeActionAfter(after, tab.id, "check");
  await requireDebuggableTab(tab.id);
  await attachTab(tab.id);
  const target = lookupRef(tab.id, ref);
  if (target.role === "radio" && checked === false) {
    throw new Error("Radio controls cannot be unchecked directly; select another radio option instead.");
  }
  const moved = await moveAgentCursorToRef(tab.id, ref, { pulse: true, agentName });
  const resolved = await send(tab.id, "DOM.resolveNode", { backendNodeId: target.backendNodeId }, target.sessionId);
  const objectId = resolved?.object?.objectId;
  if (!objectId) throw new Error(`Unable to resolve element: ${ref}`);
  const result = await send(tab.id, "Runtime.callFunctionOn", {
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
  }, target.sessionId);
  const actualChecked = result?.result?.value?.checked;
  if (actualChecked !== Boolean(checked)) throw new Error(`Check postcondition failed for ${ref}`);
  refStates.delete(tab.id);
  const afterResult = await runActionAfter(tab.id, afterConfig);
  scheduleDetach(tab.id, 5_000);
  return {
    tabId: tab.id,
    ref,
    point: moved.point,
    frameId: moved.frameId,
    sessionScope: moved.sessionId ? "child" : "root",
    checked: actualChecked,
    compoundActionVersion: COMPOUND_ACTION_VERSION,
    after: afterResult,
  };
}

async function browserWait({
  tabId,
  milliseconds,
  text,
  urlContains,
  refVisible,
  refHidden,
  refExists,
  refEnabled,
  networkResponse,
  networkIdle = false,
  domStable = false,
  snapshotChanged,
  quietMs = 500,
  timeoutMs = 10_000,
} = {}) {
  const tab = await chooseTab(tabId);
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
    Boolean(snapshotChanged),
  ].filter(Boolean).length;
  if (requested !== 1) {
    throw new Error(
      "Exactly one wait condition is required: milliseconds, text, urlContains, refVisible, refHidden, refExists, refEnabled, networkResponse, networkIdle, domStable or snapshotChanged",
    );
  }
  const timeout = Math.max(100, Math.min(Number(timeoutMs) || 10_000, 60_000));
  const quiet = Math.max(100, Math.min(Number(quietMs) || 500, 5_000));
  if (milliseconds != null) {
    const delay = Math.max(0, Math.min(Number(milliseconds) || 0, 60_000));
    await sleep(delay);
    return { waitVersion: WAIT_VERSION, tabId: tab.id, waitedMs: delay };
  }

  const smartRef = refVisible || refHidden || refExists || refEnabled || null;
  const smartRequested = Boolean(smartRef || networkResponse || networkIdle || domStable || snapshotChanged);
  if (smartRequested || text) {
    await requireDebuggableTab(tab.id);
    await attachTab(tab.id);
  }

  let networkState = null;
  let networkResponseState = null;
  let stableCounter = null;
  let stableGeneration = currentDocumentGeneration(tab.id);
  let stableSince = Date.now();
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
  if (snapshotChanged) {
    baseSnapshot = snapshotStateById(tab.id, String(snapshotChanged));
    if (!baseSnapshot) {
      scheduleDetach(tab.id, 5_000);
      throw new Error(`Snapshot id is unavailable or outside the bounded history: ${String(snapshotChanged)}`);
    }
  }

  const deadline = Date.now() + timeout;
  try {
    while (Date.now() < deadline) {
      const current = await chrome.tabs.get(tab.id);
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
        } else if (Date.now() - stableSince >= quiet) {
          return {
            waitVersion: WAIT_VERSION,
            tabId: tab.id,
            matched: "dom_stable",
            quietMs: quiet,
            mutationCounter: counter,
          };
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
        if (
          baseSnapshot.mutationCounter != null &&
          counter !== baseSnapshot.mutationCounter
        ) {
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
  } finally {
    if (networkState && networkWaitStates.get(tab.id) === networkState) {
      networkWaitStates.delete(tab.id);
    }
    if (networkResponseState) {
      removeNetworkResponseWaitState(tab.id, networkResponseState);
    }
    if (smartRequested || text) scheduleDetach(tab.id, 5_000);
  }
}

async function browserFill({ tabId, ref, value, agentName, after }) {
  const tab = await chooseTab(tabId);
  const afterConfig = normalizeActionAfter(after, tab.id, "fill");
  const wanted = String(value ?? "");
  await requireDebuggableTab(tab.id);
  await attachTab(tab.id);
  const { target, point, frameId, sessionId } = await moveAgentCursorToRef(tab.id, ref, { pulse: true, agentName });
  const resolved = await send(tab.id, "DOM.resolveNode", { backendNodeId: target.backendNodeId }, target.sessionId);
  const objectId = resolved?.object?.objectId;
  if (!objectId) throw new Error(`Unable to resolve element: ${ref}`);
  const result = await send(tab.id, "Runtime.callFunctionOn", {
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
  if (result?.exceptionDetails) throw new Error(result.exceptionDetails?.text || `Unable to fill element: ${ref}`);
  const outcome = result?.result?.value || {};
  if (String(outcome.value ?? "") !== wanted) throw new Error(`Fill postcondition failed for ${ref}`);
  refStates.delete(tab.id);
  const afterResult = await runActionAfter(tab.id, afterConfig);
  scheduleDetach(tab.id, 100);
  return {
    inputVersion: INPUT_VERSION,
    tabId: tab.id,
    ref,
    point,
    frameId,
    sessionScope: sessionId ? "child" : "root",
    value: outcome.value,
    kind: outcome.kind || null,
    compoundActionVersion: COMPOUND_ACTION_VERSION,
    after: afterResult,
  };
}

function parseKeyChord(chord) {
  const parts = String(chord || "").split("+").map((item) => item.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error("Key is required");
  let modifiers = 0;
  let key = parts.pop();
  for (const modifier of parts) {
    const normalized = modifier.toLowerCase();
    if (normalized === "alt" || normalized === "option") modifiers |= 1;
    else if (normalized === "ctrl" || normalized === "control") modifiers |= 2;
    else if (normalized === "meta" || normalized === "cmd" || normalized === "command") modifiers |= 4;
    else if (normalized === "shift") modifiers |= 8;
    else throw new Error(`Unsupported modifier: ${modifier}`);
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
  const moved = await moveAgentCursorToRef(tabId, ref, { pulse: true, agentName });
  const target = moved.target;
  const resolved = await send(tabId, "DOM.resolveNode", { backendNodeId: target.backendNodeId }, target.sessionId);
  const objectId = resolved?.object?.objectId;
  if (!objectId) throw new Error(`Unable to resolve element: ${ref}`);
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
  if (focused?.exceptionDetails) throw new Error(focused.exceptionDetails?.text || `Unable to focus element: ${ref}`);
  const state = focused?.result?.value || {};
  if (state.focused !== true) throw new Error(`Keyboard focus postcondition failed for ${ref}`);
  return { ...moved, objectId, editable: Boolean(state.editable), tagName: state.tagName || null };
}

async function readFocusedEditableValue(tabId, objectId, sessionId) {
  if (!objectId) return null;
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

async function browserPress({ tabId, key, ref, agentName, after }) {
  const tab = await chooseTab(tabId);
  const afterConfig = normalizeActionAfter(after, tab.id, "press");
  await requireDebuggableTab(tab.id);
  await attachTab(tab.id);
  await send(tab.id, "Page.bringToFront");
  const focused = ref ? await focusRefForInput(tab.id, ref, { agentName }) : null;
  const sessionId = focused?.sessionId || null;
  const chord = parseKeyChord(key);
  const printable = chord.key.length === 1 && chord.modifiers === 0;
  await send(tab.id, "Input.dispatchKeyEvent", {
    type: "keyDown",
    key: chord.key,
    modifiers: chord.modifiers,
    ...(printable ? { text: chord.key } : {}),
  }, sessionId);
  await send(tab.id, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: chord.key,
    modifiers: chord.modifiers,
  }, sessionId);
  refStates.delete(tab.id);
  const afterResult = await runActionAfter(tab.id, afterConfig);
  scheduleDetach(tab.id, 5_000);
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
  };
}

async function browserTypeText({ tabId, ref, text, delayMs = 0, agentName, after }) {
  const tab = await chooseTab(tabId);
  const afterConfig = normalizeActionAfter(after, tab.id, "type_text");
  const value = String(text ?? "");
  if (value.length > 100_000) throw new Error("type_text is limited to 100000 characters");
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
      if (boundedDelayMs > 0 && index < value.length - 1) await sleep(boundedDelayMs);
    }
  } else if (value) {
    await send(tab.id, "Input.insertText", { text: value }, sessionId);
  }
  const actualValue = await readFocusedEditableValue(tab.id, focused.objectId, sessionId);
  refStates.delete(tab.id);
  const afterResult = await runActionAfter(tab.id, afterConfig);
  scheduleDetach(tab.id, 5_000);
  return {
    inputVersion: INPUT_VERSION,
    tabId: tab.id,
    ref,
    mode: sequential ? "key_events" : "insert_text",
    characters: [...value].length,
    delayMs: boundedDelayMs,
    value: actualValue,
    frameId: focused.frameId,
    sessionScope: sessionId ? "child" : "root",
    compoundActionVersion: COMPOUND_ACTION_VERSION,
    after: afterResult,
  };
}

async function browserEval({ tabId, expression }) {
  const tab = await chooseTab(tabId);
  await requireDebuggableTab(tab.id);
  await attachTab(tab.id);
  const evaluated = await send(tab.id, "Runtime.evaluate", {
    expression: String(expression || ""),
    awaitPromise: true,
    returnByValue: true,
  });
  scheduleDetach(tab.id, 5_000);
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
  if (!Number.isInteger(tab?.id)) return null;
  const event = {
    sequence: ++tabCreationSequence,
    createdAt: new Date().toISOString(),
    tabId: tab.id,
    windowId: tab.windowId ?? null,
    openerTabId: Number.isInteger(tab.openerTabId) ? tab.openerTabId : null,
  };
  tabCreationEvents.push(event);
  if (tabCreationEvents.length > MAX_TAB_CREATION_EVENTS) {
    tabCreationEvents.splice(0, tabCreationEvents.length - MAX_TAB_CREATION_EVENTS);
  }
  return event;
}

async function browserWindowTypes() {
  if (!chrome.windows?.getAll) return new Map();
  try {
    const windows = await chrome.windows.getAll({ populate: false });
    return new Map((windows || []).map((window) => [window.id, window.type || null]));
  } catch {
    return new Map();
  }
}

function publicTab(tab, { windowTypes = new Map(), creation = null } = {}) {
  const policy = classifyBrowserPage(tab);
  return {
    id: tab.id,
    windowId: tab.windowId,
    windowType: windowTypes.get(tab.windowId) || null,
    index: tab.index,
    active: tab.active,
    pinned: tab.pinned,
    title: tab.title,
    url: tab.url,
    pendingUrl: tab.pendingUrl || null,
    status: tab.status,
    pageKind: policy.kind,
    debuggerSupported: policy.debuggerSupported,
    openerTabId: Number.isInteger(tab.openerTabId) ? tab.openerTabId : null,
    createdSequence: creation?.sequence ?? null,
    createdAt: creation?.createdAt ?? null,
  };
}

function creationEventForTab(tabId) {
  for (let index = tabCreationEvents.length - 1; index >= 0; index -= 1) {
    if (tabCreationEvents[index]?.tabId === tabId) return tabCreationEvents[index];
  }
  return null;
}

async function browserTabsList() {
  const [tabs, windowTypes] = await Promise.all([
    chrome.tabs.query({}),
    browserWindowTypes(),
  ]);
  return tabs.map((tab) => publicTab(tab, {
    windowTypes,
    creation: creationEventForTab(tab.id),
  }));
}

async function newTabsSince(sequence, { openerTabId = null } = {}) {
  const events = tabCreationEvents.filter((event) => event.sequence > sequence);
  if (events.length === 0) return [];
  const windowTypes = await browserWindowTypes();
  const result = [];
  const seen = new Set();
  for (const event of events) {
    if (seen.has(event.tabId)) continue;
    seen.add(event.tabId);
    let tab;
    try {
      tab = await chrome.tabs.get(event.tabId);
    } catch {
      continue;
    }
    if (Number.isInteger(openerTabId) && tab.openerTabId !== openerTabId) continue;
    result.push(publicTab(tab, { windowTypes, creation: event }));
  }
  return result;
}

async function discoverNewTabs(sequence, openerTabId, graceMs = TAB_CREATION_DISCOVERY_GRACE_MS) {
  const deadline = Date.now() + Math.max(0, graceMs);
  do {
    const tabs = await newTabsSince(sequence, { openerTabId });
    if (tabs.length > 0) return tabs;
    if (Date.now() >= deadline) break;
    await sleep(25);
  } while (true);
  return [];
}

function downloadName(filename = "") {
  const normalized = String(filename || "").replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : null;
}

function recordDownloadCreation(item) {
  if (!Number.isInteger(item?.id)) return null;
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
    if (downloadCreationEvents[index]?.downloadId === downloadId) return downloadCreationEvents[index];
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
  if (!chrome.downloads?.search) return null;
  const items = await chrome.downloads.search({ id: downloadId });
  const item = items?.[0];
  if (!item) return null;
  return publicDownload(item, {
    creation: creationEventForDownload(downloadId),
    includeFilename,
  });
}

async function newDownloadsSince(sequence) {
  if (!chrome.downloads?.search) return [];
  const events = downloadCreationEvents
    .filter((event) => event.sequence > sequence)
    .slice(0, MAX_DOWNLOADS_PER_ACTION);
  const downloads = [];
  for (const event of events) {
    const item = await downloadById(event.downloadId);
    if (item) downloads.push(item);
  }
  return downloads;
}

async function discoverNewDownloads(sequence, graceMs = DOWNLOAD_DISCOVERY_GRACE_MS) {
  if (!chrome.downloads?.search) return [];
  const deadline = Date.now() + Math.max(0, graceMs);
  do {
    const downloads = await newDownloadsSince(sequence);
    if (downloads.length > 0) return downloads;
    if (Date.now() >= deadline) break;
    await sleep(25);
  } while (true);
  return [];
}

async function browserDownloadWait({ downloadId, timeoutMs = 60_000 } = {}) {
  if (!Number.isInteger(downloadId) || downloadId < 0) throw new Error("downloadId is required");
  if (!chrome.downloads?.search) throw new Error("Chrome downloads API is unavailable");
  const timeout = Math.max(100, Math.min(Number(timeoutMs) || 60_000, 60_000));
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const item = await downloadById(downloadId, { includeFilename: true });
    if (item && new Set(["complete", "interrupted"]).has(item.state)) return { download: item };
    await sleep(100);
  }
  throw new Error(`Timed out waiting for download ${downloadId}`);
}

async function browserCreateTab({ url = "chrome://newtab/", active = false } = {}) {
  const targetUrl = validateOpenUrl(url || "chrome://newtab/");
  if (!chrome.tabs?.create) throw new Error("Chrome tabs.create API is unavailable");
  const tab = await chrome.tabs.create({ url: targetUrl, active: Boolean(active) });
  if (!Number.isInteger(tab?.id)) throw new Error("Chrome did not return a created tab id.");
  const updated = await waitForTab(
    tab.id,
    (candidate) => candidate.url === targetUrl || candidate.status === "complete",
  );
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

async function browserHistoryNavigate({ tabId, direction } = {}) {
  const normalizedDirection = direction === "forward" ? "forward" : "back";
  const tab = await chooseTab(tabId);
  const api = normalizedDirection === "forward" ? chrome.tabs?.goForward : chrome.tabs?.goBack;
  if (typeof api !== "function") {
    throw new Error(`Chrome tabs.go${normalizedDirection === "forward" ? "Forward" : "Back"} API is unavailable`);
  }
  try {
    await api.call(chrome.tabs, tab.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Chrome could not navigate ${normalizedDirection} in tab ${tab.id}: ${message}`);
  }
  const updated = await chrome.tabs.get(tab.id);
  const policy = classifyBrowserPage(updated);
  return {
    id: updated.id,
    windowId: updated.windowId,
    title: updated.title,
    url: updated.url,
    active: updated.active,
    pageKind: policy.kind,
    debuggerSupported: policy.debuggerSupported,
    direction: normalizedDirection,
  };
}

async function browserReload({ tabId, ignoreCache = false } = {}) {
  const tab = await chooseTab(tabId);
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
  } finally {
    if (!persistent) scheduleDetach(tab.id, 5_000);
  }
}

async function browserNavigate({ tabId, url, ignoreCache = false } = {}) {
  const targetUrl = validateOpenUrl(url);
  const tab = await chooseTab(tabId);
  await requireDebuggableTab(tab.id);
  const persistent = observationStates.has(tab.id);
  await attachTab(tab.id, DEFAULT_ATTACH_IDLE_MS, { persistent });
  if (ignoreCache) {
    await send(tab.id, "Network.enable");
    await send(tab.id, "Network.setCacheDisabled", { cacheDisabled: true });
  }
  try {
    await send(tab.id, "Page.navigate", { url: targetUrl });
    const updated = await waitForTab(
      tab.id,
      (candidate) => candidate.status === "complete" && String(candidate.url || "").startsWith(targetUrl),
    );
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
  } finally {
    if (ignoreCache) {
      await send(tab.id, "Network.setCacheDisabled", { cacheDisabled: false }).catch(() => {});
    }
    if (!persistent) scheduleDetach(tab.id, 5_000);
  }
}

async function browserEmulate({
  tabId,
  width,
  height,
  deviceScaleFactor = 1,
  mobile = false,
  touch = false,
} = {}) {
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
  if (!persistent) scheduleDetach(tab.id, 5_000);
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
  const width = Number(evaluated?.result?.value?.width);
  const height = Number(evaluated?.result?.value?.height);
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
  if (!/^@e\d+$/.test(String(ref || ""))) throw new Error("tap requires a current semantic ref.");
  const tab = await chooseTab(tabId);
  await requireDebuggableTab(tab.id);
  const persistent = observationStates.has(tab.id);
  await attachTab(tab.id, DEFAULT_ATTACH_IDLE_MS, { persistent });
  try {
    const moved = await moveAgentCursorToRef(tab.id, ref, { pulse: true, agentName });
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
    };
  } finally {
    if (!persistent) scheduleDetach(tab.id, 5_000);
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
  await requireDebuggableTab(tab.id);
  const persistent = observationStates.has(tab.id);
  await attachTab(tab.id, DEFAULT_ATTACH_IDLE_MS, { persistent });
  try {
    let sessionId = null;
    let frameId = null;
    let start;
    if (ref != null) {
      if (!/^@e\d+$/.test(String(ref))) throw new Error("Swipe ref must be a current semantic ref.");
      const moved = await moveAgentCursorToRef(tab.id, ref, { pulse: false, agentName });
      sessionId = moved.sessionId;
      frameId = moved.frameId;
      start = moved.point;
    } else {
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
    const from = {
      x: clampTouchCoordinate(start.x, viewport.width),
      y: clampTouchCoordinate(start.y, viewport.height),
    };
    const to = {
      x: clampTouchCoordinate(from.x + delta.x, viewport.width),
      y: clampTouchCoordinate(from.y + delta.y, viewport.height),
    };
    const effectiveDistance = Math.hypot(to.x - from.x, to.y - from.y);
    if (effectiveDistance < 20) throw new Error("Swipe target is too close to the viewport edge for a meaningful bounded gesture.");
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
    };
  } finally {
    if (!persistent) scheduleDetach(tab.id, 5_000);
  }
}

async function browserClearEmulation({ tabId } = {}) {
  const tab = await chooseTab(tabId);
  await requireDebuggableTab(tab.id);
  const persistent = observationStates.has(tab.id);
  await attachTab(tab.id, DEFAULT_ATTACH_IDLE_MS, { persistent });
  await Promise.all([
    send(tab.id, "Emulation.clearDeviceMetricsOverride"),
    send(tab.id, "Emulation.setTouchEmulationEnabled", { enabled: false }),
  ]);
  if (!persistent) scheduleDetach(tab.id, 5_000);
  return { emulationVersion: EMULATION_VERSION, tabId: tab.id, cleared: true };
}

async function browserOpen({ tabId, url }) {
  const targetUrl = validateOpenUrl(url);
  const tab = await chooseTab(tabId);
  const persistent = observationStates.has(tab.id) && /^https?:/i.test(targetUrl);
  if (!persistent) await detachTab(tab.id);
  await chrome.tabs.update(tab.id, { url: targetUrl, active: true });
  const updated = await waitForTab(
    tab.id,
    (candidate) => candidate.url === targetUrl || (targetUrl.startsWith("http") && candidate.status === "complete"),
  );
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
  if (!Number.isInteger(tabId)) throw new Error("tabId is required");
  const tab = await chrome.tabs.update(tabId, { active: true });
  let focusedWindow = false;
  if (chrome.windows?.update && Number.isInteger(tab.windowId)) {
    try {
      await chrome.windows.update(tab.windowId, { focused: true });
      focusedWindow = true;
    } catch {
      focusedWindow = false;
    }
  }
  const windowTypes = await browserWindowTypes();
  return {
    ...publicTab(tab, { windowTypes, creation: creationEventForTab(tab.id) }),
    focusedWindow,
  };
}

async function browserClose({ tabId }) {
  const tab = await chooseTab(tabId);
  const allTabs = await chrome.tabs.query({});
  await detachTab(tab.id);
  if (allTabs.length <= 1) {
    const reset = await chrome.tabs.update(tab.id, { url: "chrome://newtab/", active: true });
    return { id: reset.id, emulatedLastTabClose: true, url: reset.url, unchangedTabId: reset.id === tab.id };
  }
  await chrome.tabs.remove(tab.id);
  return { id: tab.id, closed: true, emulatedLastTabClose: false };
}

async function browserUpload({ tabId, ref, selector, files }) {
  const tab = await chooseTab(tabId);
  await requireDebuggableTab(tab.id);
  await attachTab(tab.id);
  const fileList = Array.isArray(files) ? files.map(String) : [];
  if (fileList.length === 0) throw new Error("At least one file is required");
  let params;
  let sessionId = null;
  if (ref) {
    const target = lookupRef(tab.id, ref);
    sessionId = target.sessionId || null;
    params = { files: fileList, backendNodeId: target.backendNodeId };
  } else if (selector) {
    await send(tab.id, "DOM.enable");
    const documentResult = await send(tab.id, "DOM.getDocument", { depth: 1 });
    const rootNodeId = documentResult?.root?.nodeId;
    const query = await send(tab.id, "DOM.querySelector", { nodeId: rootNodeId, selector: String(selector) });
    if (!query?.nodeId) throw new Error(`File input selector not found: ${selector}`);
    params = { files: fileList, nodeId: query.nodeId };
  } else {
    throw new Error("ref or selector is required");
  }
  await send(tab.id, "DOM.setFileInputFiles", params, sessionId);
  scheduleDetach(tab.id, 5_000);
  return { tabId: tab.id, uploaded: fileList.length, ref: ref || null, selector: selector || null };
}

async function browserObserveStart({ tabId } = {}) {
  const tab = await chooseTab(tabId);
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
  const wasObserving = observationStates.has(tab.id);
  await detachTab(tab.id);
  return { tabId: tab.id, observing: false, wasObserving };
}

async function browserConsoleRead({ tabId, limit = 100, clear = false, afterCursor = null, level = null, query = null } = {}) {
  const tab = await chooseTab(tabId);
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

async function browserNetworkRead({
  tabId,
  limit = 100,
  clear = false,
  afterCursor = null,
  urlContains = null,
  method = null,
  status = null,
  resourceType = null,
} = {}) {
  const tab = await chooseTab(tabId);
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
  await requireDebuggableTab(tab.id);
  await attachTab(tab.id);
  await ensureFrameRouting(tab.id);
  if (!currentDialogRecord(tab.id)) await sleep(40);
  const record = currentDialogRecord(tab.id);
  if (action === "status") {
    scheduleDetach(tab.id, 5_000);
    return { tabId: tab.id, open: Boolean(record), dialog: record?.dialog || null };
  }
  if (!record) throw new Error("No JavaScript dialog is currently open for this tab.");
  if (!new Set(["accept", "dismiss"]).has(action)) throw new Error(`Unsupported dialog action: ${action}`);
  const handled = record.dialog;
  await send(tab.id, "Page.handleJavaScriptDialog", {
    accept: action === "accept",
    ...(promptText != null ? { promptText: String(promptText) } : {}),
  }, record.sessionId);
  clearDialogState(tab.id);
  scheduleDetach(tab.id, 5_000);
  return { tabId: tab.id, action, handled };
}

async function requireAgentBookmarkContext() {
  await ensureBrowserIdentityLoaded();
  if (browserContext !== "agent") {
    throw new Error("Bookmark automation is available only in Agent Browser; Your Browser bookmarks are intentionally unavailable.");
  }
  if (!chrome.bookmarks) throw new Error("Chrome bookmarks API is unavailable in this extension context.");
}

function normalizeBookmarkId(value, field = "bookmark id") {
  const normalized = String(value == null ? "" : value).trim();
  if (!normalized || normalized.length > 128 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`${field} must be a bounded Chrome bookmark id.`);
  }
  return normalized;
}

function normalizeBookmarkTitle(value, { allowEmpty = true } = {}) {
  const normalized = String(value == null ? "" : value).replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
  if ((!allowEmpty && !normalized) || normalized.length > 500) {
    throw new Error(`Bookmark title must be ${allowEmpty ? "at most" : "between 1 and"} 500 characters.`);
  }
  return normalized;
}

function normalizeBookmarkUrl(value) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw || raw.length > 4_000) throw new Error("Bookmark URL must be between 1 and 4000 characters.");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Bookmark URL must be a valid HTTP(S) URL.");
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) throw new Error("Bookmark URL must use http or https.");
  return parsed.toString();
}

function normalizeBookmarkLimit(value) {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Bookmark result limit must be an integer between 1 and 100.");
  return limit;
}

function normalizeBookmarkIndex(value) {
  const index = Number(value);
  if (!Number.isInteger(index) || index < 0 || index > 100_000) throw new Error("Bookmark index must be an integer between 0 and 100000.");
  return index;
}

function projectBookmarkNode(node) {
  return {
    id: String(node?.id || ""),
    parentId: node?.parentId == null ? null : String(node.parentId),
    index: Number.isInteger(node?.index) ? node.index : null,
    title: String(node?.title || "").slice(0, 500),
    url: node?.url ? safeObservedUrl(node.url) : null,
    type: node?.url ? "bookmark" : "folder",
  };
}

async function bookmarkNodeById(id, cache) {
  const normalizedId = String(id || "");
  if (!normalizedId) return null;
  if (cache.has(normalizedId)) return cache.get(normalizedId);
  const nodes = await chrome.bookmarks.get(normalizedId);
  const node = nodes?.[0] || null;
  cache.set(normalizedId, node);
  return node;
}

async function bookmarkFolderPath(folderId, cache) {
  let currentId = folderId == null ? null : String(folderId);
  if (!currentId || currentId === "0") return { path: "", truncated: false };
  const segments = [];
  const seen = new Set();
  let truncated = false;
  let depth = 0;
  while (currentId && currentId !== "0") {
    if (depth >= MAX_BOOKMARK_PATH_DEPTH || seen.has(currentId)) {
      truncated = true;
      break;
    }
    seen.add(currentId);
    const node = await bookmarkNodeById(currentId, cache);
    if (!node) break;
    const title = normalizeBookmarkTitle(node.title);
    if (title) segments.unshift(title);
    currentId = node.parentId == null ? null : String(node.parentId);
    depth += 1;
  }
  let path = segments.join(" / ");
  if (path.length > MAX_BOOKMARK_PATH_CHARS) {
    path = `… / ${path.slice(-(MAX_BOOKMARK_PATH_CHARS - 4))}`;
    truncated = true;
  }
  return { path, truncated };
}

async function projectBookmarkNodeWithPath(node, cache) {
  const projected = projectBookmarkNode(node);
  const parent = await bookmarkFolderPath(projected.parentId, cache);
  let path = [parent.path, projected.title].filter(Boolean).join(" / ");
  let pathTruncated = parent.truncated;
  if (path.length > MAX_BOOKMARK_PATH_CHARS) {
    path = `… / ${path.slice(-(MAX_BOOKMARK_PATH_CHARS - 4))}`;
    pathTruncated = true;
  }
  return {
    ...projected,
    parentPath: parent.path || null,
    path: path || null,
    pathTruncated,
  };
}

async function browserBookmarksList({ parentId = "0", limit = 50 } = {}) {
  await requireAgentBookmarkContext();
  const normalizedParentId = normalizeBookmarkId(parentId, "parentId");
  const boundedLimit = normalizeBookmarkLimit(limit);
  const cache = new Map();
  const folderNode = normalizedParentId === "0"
    ? { id: "0", parentId: null, index: 0, title: "" }
    : await bookmarkNodeById(normalizedParentId, cache);
  if (!folderNode) throw new Error(`Bookmark folder not found: ${normalizedParentId}`);
  if (folderNode.url) throw new Error(`Bookmark id ${normalizedParentId} is not a folder.`);
  cache.set(normalizedParentId, folderNode);
  const folderPath = await bookmarkFolderPath(normalizedParentId, cache);
  const nodes = await chrome.bookmarks.getChildren(normalizedParentId);
  const items = [];
  for (const node of nodes.slice(0, boundedLimit)) items.push(await projectBookmarkNodeWithPath(node, cache));
  return {
    bookmarksVersion: BOOKMARKS_VERSION,
    parentId: normalizedParentId,
    folder: {
      id: normalizedParentId,
      title: String(folderNode.title || "").slice(0, 500),
      path: folderPath.path || null,
      pathTruncated: folderPath.truncated,
    },
    items,
    returned: Math.min(nodes.length, boundedLimit),
    totalChildren: nodes.length,
    truncated: nodes.length > boundedLimit,
  };
}

async function browserBookmarksSearch({ query, limit = 50 } = {}) {
  await requireAgentBookmarkContext();
  const normalizedQuery = String(query == null ? "" : query).trim();
  if (!normalizedQuery || normalizedQuery.length > 500) throw new Error("Bookmark search query must be between 1 and 500 characters.");
  const boundedLimit = normalizeBookmarkLimit(limit);
  const cache = new Map();
  const nodes = await chrome.bookmarks.search(normalizedQuery);
  const items = [];
  for (const node of nodes.slice(0, boundedLimit)) items.push(await projectBookmarkNodeWithPath(node, cache));
  return {
    bookmarksVersion: BOOKMARKS_VERSION,
    query: normalizedQuery,
    items,
    returned: Math.min(nodes.length, boundedLimit),
    totalMatches: nodes.length,
    truncated: nodes.length > boundedLimit,
  };
}

async function browserBookmarkAdd({ title, url, parentId, index } = {}) {
  await requireAgentBookmarkContext();
  const created = await chrome.bookmarks.create({
    ...(parentId != null ? { parentId: normalizeBookmarkId(parentId, "parentId") } : {}),
    ...(index != null ? { index: normalizeBookmarkIndex(index) } : {}),
    title: normalizeBookmarkTitle(title, { allowEmpty: false }),
    url: normalizeBookmarkUrl(url),
  });
  const item = await projectBookmarkNodeWithPath(created, new Map());
  return { bookmarksVersion: BOOKMARKS_VERSION, item };
}

async function browserBookmarkFolderCreate({ title, parentId, index } = {}) {
  await requireAgentBookmarkContext();
  const created = await chrome.bookmarks.create({
    ...(parentId != null ? { parentId: normalizeBookmarkId(parentId, "parentId") } : {}),
    ...(index != null ? { index: normalizeBookmarkIndex(index) } : {}),
    title: normalizeBookmarkTitle(title, { allowEmpty: false }),
  });
  const item = await projectBookmarkNodeWithPath(created, new Map());
  return { bookmarksVersion: BOOKMARKS_VERSION, item };
}

async function browserBookmarkUpdateMove({ id, title, url, parentId, index } = {}) {
  await requireAgentBookmarkContext();
  const normalizedId = normalizeBookmarkId(id);
  const existing = await chrome.bookmarks.get(normalizedId);
  const original = existing?.[0];
  if (!original) throw new Error(`Bookmark not found: ${normalizedId}`);
  const update = {};
  if (title != null) update.title = normalizeBookmarkTitle(title);
  if (url != null) {
    if (!original.url) throw new Error("A bookmark folder cannot be converted into a URL bookmark.");
    update.url = normalizeBookmarkUrl(url);
  }
  const move = {};
  if (parentId != null) move.parentId = normalizeBookmarkId(parentId, "parentId");
  if (index != null) move.index = normalizeBookmarkIndex(index);
  if (Object.keys(update).length === 0 && Object.keys(move).length === 0) {
    throw new Error("Bookmark update/move requires title, url, parentId and/or index.");
  }
  let node = original;
  let updated = false;
  try {
    if (Object.keys(update).length > 0) {
      node = await chrome.bookmarks.update(normalizedId, update);
      updated = true;
    }
    if (Object.keys(move).length > 0) node = await chrome.bookmarks.move(normalizedId, move);
  } catch (error) {
    if (updated && Object.keys(move).length > 0) {
      await chrome.bookmarks.update(normalizedId, {
        title: String(original.title || ""),
        ...(original.url ? { url: original.url } : {}),
      }).catch(() => {});
    }
    throw error;
  }
  const item = await projectBookmarkNodeWithPath(node, new Map());
  return { bookmarksVersion: BOOKMARKS_VERSION, item };
}

async function browserBookmarkRemove({ id, recursive = false } = {}) {
  await requireAgentBookmarkContext();
  const normalizedId = normalizeBookmarkId(id);
  const existing = await chrome.bookmarks.get(normalizedId);
  const node = existing?.[0];
  if (!node) throw new Error(`Bookmark not found: ${normalizedId}`);
  const removed = await projectBookmarkNodeWithPath(node, new Map());
  if (!node.url && recursive) await chrome.bookmarks.removeTree(normalizedId);
  else await chrome.bookmarks.remove(normalizedId);
  return { bookmarksVersion: BOOKMARKS_VERSION, removed, recursive: Boolean(recursive && !node.url) };
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
  return {
    extensionId: chrome.runtime.id,
    extensionVersion: chrome.runtime.getManifest().version,
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
    extensionId: chrome.runtime.id,
  };
}

const COMMANDS = {
  ping: async () => ({ pong: true, at: new Date().toISOString() }),
  status: browserStatus,
  "tabs.list": browserTabsList,
  "tabs.activate": browserActivate,
  "tabs.create": browserCreateTab,
  "history.back": (args) => browserHistoryNavigate({ ...args, direction: "back" }),
  "history.forward": (args) => browserHistoryNavigate({ ...args, direction: "forward" }),
  reload: browserReload,
  open: browserOpen,
  navigate: browserNavigate,
  emulate: browserEmulate,
  "emulation.clear": browserClearEmulation,
  snapshot: browserSnapshot,
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
  "settings.status": popupStatus,
  "settings.update": updateBrowserSettings,
  "context.set": async ({ context } = {}) => setBrowserContext(context),
};

const DISABLED_CONTROL_METHODS = new Set([
  "status", "settings.status", "settings.update", "context.set",
]);

async function handleCommand(message) {
  if (message?.type !== "command" || message.id == null) return;
  await ensureBrowserEnabledLoaded();
  const consentAccepted = hasCurrentBrowserControlConsent();
  if ((!browserEnabled || !consentAccepted) && !DISABLED_CONTROL_METHODS.has(message.method)) {
    nativePort?.postMessage({
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
  const handler = COMMANDS[message.method];
  if (!handler) {
    nativePort?.postMessage({
      type: "response",
      id: message.id,
      ok: false,
      error: { message: `Unknown Equinox Browser command: ${message.method}` },
    });
    return;
  }
  try {
    const result = await handler(message.args || {});
    postSuccessfulResponse(message.id, result);
    if (message.method === "self.reload") {
      setTimeout(() => chrome.runtime.reload(), SELF_RELOAD_DELAY_MS);
    }
  } catch (error) {
    nativePort?.postMessage({
      type: "response",
      id: message.id,
      ok: false,
      error: { message: errorMessage(error), stack: error?.stack || null },
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
  chrome.alarms.create(NATIVE_RECONNECT_ALARM, { when: Date.now() + Math.max(1_000, reconnectDelayMs) });
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, 10_000);
}

function connectNativeHost() {
  if (nativePort) return;
  let port;
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
    nativePort = port;
    localBridgeConnected = false;
  } catch {
    nativePort = null;
    localBridgeConnected = false;
    scheduleReconnect();
    return;
  }

  port.onMessage.addListener((message) => {
    if (nativePort !== port) return;
    immediateReconnectUsed = false;
    reconnectDelayMs = 500;
    void chrome.alarms.clear(NATIVE_RECONNECT_ALARM);
    if (message?.type === "host.status") {
      localBridgeConnected = Boolean(message.localConnected);
      return;
    }
    if (handleLocalResponse(message)) return;
    void handleCommand(message);
  });
  port.onDisconnect.addListener(() => {
    const intentional = intentionallyDisconnectedPorts.has(port);
    intentionallyDisconnectedPorts.delete(port);
    if (nativePort === port) nativePort = null;
    localBridgeConnected = false;
    rejectPendingLocalRequests("Equinox Local Native Messaging bağlantısı kesildi.");
    if (intentional) {
      lastNativeDisconnectError = null;
      return;
    }
    lastNativeDisconnectError = chrome.runtime.lastError?.message || "Native messaging port disconnected";
    if (!immediateReconnectUsed) {
      immediateReconnectUsed = true;
      connectNativeHost();
      return;
    }
    scheduleReconnect();
  });
  reconnectDelayMs = 500;
  void chrome.alarms.clear(NATIVE_RECONNECT_ALARM);
  const postExtensionHello = () => {
    if (nativePort !== port) return;
    port.postMessage({
      type: "extension.hello",
      extensionId: chrome.runtime.id,
      extensionVersion: chrome.runtime.getManifest().version,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      capabilities: Object.keys(COMMANDS),
      capabilityVersions: browserCapabilityVersions(),
      instanceId: browserInstanceId,
      browserContext,
      lastNativeDisconnectError,
    });
  };
  if (browserIdentityLoaded) postExtensionHello();
  else void ensureBrowserIdentityLoaded().then(postExtensionHello).catch(() => scheduleReconnect());
}

chrome.debugger.onEvent.addListener((source, method, params = {}) => {
  if (!browserEnabled || !hasCurrentBrowserControlConsent()) return;
  const tabId = source?.tabId;
  if (!Number.isInteger(tabId)) return;

  if (method === "Target.attachedToTarget") {
    registerChildSession(tabId, params.sessionId, params.targetInfo || {});
    if (params.sessionId) {
      void send(tabId, "Page.enable", {}, params.sessionId).catch(() => {});
      if (observationStates.has(tabId)) {
        void Promise.all([
          send(tabId, "Runtime.enable", {}, params.sessionId),
          send(tabId, "Network.enable", {}, params.sessionId),
        ]).catch(() => {});
      }
    }
    return;
  }
  if (method === "Target.detachedFromTarget") {
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
    scheduleDetach(tabId, 250);
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
    } else if (method === "Network.responseReceived") {
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
        if (!waiter.matched && networkEventMatches(response, waiter.filters)) waiter.matched = response;
      }
    } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
      for (const waiter of responseWaiters) {
        if (params.requestId) waiter.requests.delete(params.requestId);
      }
    }
  }
  const networkWaitState = networkWaitStates.get(tabId);
  if (networkWaitState) {
    if (method === "Network.requestWillBeSent") {
      if (!NETWORK_IDLE_IGNORED_TYPES.has(String(params.type || ""))) {
        if (params.requestId) networkWaitState.inflight.add(params.requestId);
        networkWaitState.lastActivityAt = Date.now();
      }
    } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
      if (params.requestId && networkWaitState.inflight.delete(params.requestId)) {
        networkWaitState.lastActivityAt = Date.now();
      }
    }
  }

  const state = observationStates.get(tabId);
  if (!state) return;
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

chrome.debugger.onDetach.addListener((source) => {
  const tabId = source?.tabId;
  if (!Number.isInteger(tabId)) return;
  const state = attachedTabs.get(tabId);
  if (state?.timer) clearTimeout(state.timer);
  attachedTabs.delete(tabId);
  refStates.delete(tabId);
  networkWaitStates.delete(tabId);
  networkResponseWaitStates.delete(tabId);
  observationStates.delete(tabId);
  dialogStates.delete(tabId);
  rejectPendingHtml5DragIntercept(tabId, "Debugger detached while waiting for HTML5 drag interception");
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!browserEnabled || !hasCurrentBrowserControlConsent()) return;
  if (changeInfo?.url || changeInfo?.status === "loading") {
    invalidateRefs(tabId, { bumpGeneration: true });
  }
});

chrome.tabs.onCreated?.addListener((tab) => {
  if (!browserEnabled || !hasCurrentBrowserControlConsent()) return;
  recordTabCreation(tab);
});

chrome.downloads?.onCreated?.addListener((item) => {
  if (!browserEnabled || !hasCurrentBrowserControlConsent()) return;
  recordDownloadCreation(item);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const state = attachedTabs.get(tabId);
  if (state?.timer) clearTimeout(state.timer);
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
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name !== NATIVE_RECONNECT_ALARM || nativePort) return;
  connectNativeHost();
});

chrome.runtime.onMessage?.addListener((message, _sender, sendResponse) => {
  if (!message || !new Set([
    "equinox.popup.status",
    "equinox.popup.setEnabled",
    "equinox.popup.acceptBrowserControlConsent",
    "equinox.popup.setAgentCursorEnabled",
    "equinox.popup.setAgentCursorName",
    "equinox.popup.openAgentBrowser",
  ]).has(message.type)) return false;
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
            : popupStatus();
  Promise.resolve(task).then(
    (result) => sendResponse({ ok: true, result }),
    (error) => sendResponse({ ok: false, error: { message: errorMessage(error) } }),
  );
  return true;
});

chrome.runtime.onStartup.addListener(() => connectNativeHost());

chrome.runtime.onInstalled.addListener(() => connectNativeHost());

void ensureBrowserEnabledLoaded().then(() => connectNativeHost());
