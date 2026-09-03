const HOST_NAME = "dev.equinox.browser";
const PROTOCOL_VERSION = "1.3";
const BRIDGE_PROTOCOL_VERSION = 1;
const DEFAULT_ATTACH_IDLE_MS = 30_000;
const MAX_SNAPSHOT_ELEMENTS = 250;
const MAX_OBSERVATION_EVENTS = 500;
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
const CURRENT_BROWSER_CONTROL_CONSENT_VERSION = 1;
const AGENT_CURSOR_STORAGE_KEY = "agentCursorEnabled";
const AGENT_CURSOR_NAME_STORAGE_KEY = "agentCursorName";
const BROWSER_INSTANCE_ID_STORAGE_KEY = "browserInstanceId";
const BROWSER_CONTEXT_STORAGE_KEY = "browserContext";
const BROWSER_CONTEXT_VALUES = new Set(["agent", "user"]);
const AGENT_CURSOR_HOST_ID = "__equinox_browser_agent_cursor__";
const DEFAULT_AGENT_CURSOR_NAME = "Agent";
const AGENT_CURSOR_IDLE_MS = 3_500;

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
const observationStates = new Map();
const dialogStates = new Map();
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

function pushBounded(list, value) {
  list.push(value);
  if (list.length > MAX_OBSERVATION_EVENTS) list.splice(0, list.length - MAX_OBSERVATION_EVENTS);
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

function observationSlice(list, limit = 100, clear = false) {
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
  const items = list.slice(-boundedLimit);
  if (clear) list.length = 0;
  return items;
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

async function frameAccessibilityTree(tabId, frame) {
  await send(tabId, "Accessibility.enable", {}, frame.sessionId);
  try {
    return await send(tabId, "Accessibility.getFullAXTree", { frameId: frame.id }, frame.sessionId);
  } catch (error) {
    if (!frame.sessionId || (frame.targetId && frame.targetId !== frame.id)) throw error;
    return await send(tabId, "Accessibility.getFullAXTree", {}, frame.sessionId);
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

function restrictedSnapshot(tab, policy) {
  return {
    tab: { id: tab.id, windowId: tab.windowId, title: tab.title, url: tab.url, active: tab.active },
    restricted: true,
    pageKind: policy?.kind || "unknown",
    debuggerSupported: false,
    reason: policy?.reason || "restricted",
    text: restrictedPageMessage(policy),
    frames: [],
    refCount: 0,
    elementCount: 0,
    elements: [],
  };
}

async function browserSnapshot({ tabId, includeReadable = true } = {}) {
  const tab = await chooseTab(tabId);
  const policy = classifyBrowserPage(tab);
  if (!policy.debuggerSupported) return restrictedSnapshot(tab, policy);
  await requireDebuggableTab(tab.id);
  try {
    await attachTab(tab.id);
  } catch (error) {
    if (error?.code === "EQUINOX_RESTRICTED_PAGE") {
      return restrictedSnapshot(tab, { kind: error.pageKind, reason: error.reason });
    }
    throw error;
  }
  const frames = await collectFrameContexts(tab.id);
  const pageKind = pageKindFromFrames(policy, frames);
  if (pageKind === "browser-owned-error") {
    await detachTab(tab.id);
    return restrictedSnapshot(tab, { kind: pageKind, reason: "browser-owned" });
  }
  const generation = currentDocumentGeneration(tab.id);
  const mainFrameId = frames.find((frame) => !frame.parentId && !frame.sessionId)?.id || frames[0]?.id || null;
  const refs = new Map();
  const elements = [];
  let refIndex = 1;

  for (const frame of frames) {
    if (elements.length >= MAX_SNAPSHOT_ELEMENTS) break;
    let tree;
    try {
      tree = await frameAccessibilityTree(tab.id, frame);
    } catch {
      continue;
    }
    for (const node of tree?.nodes || []) {
      if (node?.ignored) continue;
      const role = node?.role?.value || "";
      const name = node?.name?.value || "";
      const value = node?.value?.value ?? null;
      const backendNodeId = node?.backendDOMNodeId;
      const interactive = INTERACTIVE_ROLES.has(role) && Number.isInteger(backendNodeId);
      const readable = includeReadable && READABLE_ROLES.has(role) && Boolean(name);
      if (!interactive && !readable) continue;
      if (elements.length >= MAX_SNAPSHOT_ELEMENTS) break;

      const element = {
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
        element.ref = `@e${refIndex++}`;
        refs.set(element.ref, {
          backendNodeId,
          role,
          name,
          frameId: frame.id,
          sessionId: frame.sessionId,
          targetId: frame.targetId,
          documentGeneration: generation,
        });
      }
      elements.push(element);
    }
  }

  const snapshotId = `${tab.id}:${generation}:${Date.now()}`;
  refStates.set(tab.id, {
    snapshotId,
    createdAt: Date.now(),
    documentGeneration: generation,
    url: tab.url,
    refs,
  });
  scheduleDetach(tab.id);

  return {
    tab: { id: tab.id, windowId: tab.windowId, title: tab.title, url: tab.url, active: tab.active },
    restricted: false,
    pageKind,
    debuggerSupported: true,
    snapshot: {
      id: snapshotId,
      documentGeneration: generation,
      mainFrameId,
      createdAt: new Date().toISOString(),
    },
    frames: frames.map((frame) => publicFrameContext(frame, mainFrameId)),
    refCount: refs.size,
    elementCount: elements.length,
    text: elements.map(formatSnapshotLine).join("\n"),
    elements: elements.map(({ backendNodeId, ...publicElement }) => publicElement),
  };
}

async function browserScreenshot({ tabId, fullPage = false, pixelDensity = "css-1x" } = {}) {
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
  const source = fullPage ? content : viewport;
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

  const clip = {
    x: fullPage ? 0 : Number(viewport?.pageX || 0),
    y: fullPage ? 0 : Number(viewport?.pageY || 0),
    width,
    height,
    scale: captureScale,
  };
  const captured = await send(tab.id, "Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: Boolean(fullPage),
    optimizeForSpeed: false,
    clip,
  });
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

async function browserClick({ tabId, ref, agentName }) {
  const tab = await chooseTab(tabId);
  await requireDebuggableTab(tab.id);
  await attachTab(tab.id);
  const tabCreationSequenceBefore = tabCreationSequence;
  const downloadCreationSequenceBefore = downloadCreationSequence;
  const existingDialog = currentDialogRecord(tab.id);
  if (existingDialog) {
    return {
      tabId: tab.id,
      ref,
      actionDispatched: false,
      blockedByDialog: true,
      dialogOpened: existingDialog.dialog,
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

  const pressPromise = send(tab.id, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...point,
    button: "left",
    clickCount: 1,
  }, target.sessionId);
  let dialog = await settleCommandOrDialog(tab.id, pressPromise, dialogSequenceBefore);

  if (!dialog) {
    const releasePromise = send(tab.id, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      ...point,
      button: "left",
      clickCount: 1,
    }, target.sessionId);
    dialog = await settleCommandOrDialog(tab.id, releasePromise, dialogSequenceBefore);
  }

  const [openedTabs, downloadsStarted] = await Promise.all([
    discoverNewTabs(tabCreationSequenceBefore, tab.id),
    discoverNewDownloads(downloadCreationSequenceBefore),
  ]);

  refStates.delete(tab.id);
  scheduleDetach(tab.id, 250);
  return {
    tabId: tab.id,
    ref,
    point,
    frameId: target.frameId,
    sessionScope: target.sessionId ? "child" : "root",
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
  await send(tab.id, "Page.bringToFront");
  const { point, sessionId, frameId } = await refPoint(tab.id, ref);
  await showAgentCursor(tab.id, point, sessionId, { agentName });
  await send(tab.id, "Input.dispatchMouseEvent", { type: "mouseMoved", ...point }, sessionId);
  refStates.delete(tab.id);
  scheduleDetach(tab.id, 5_000);
  return { tabId: tab.id, ref, point, frameId, sessionScope: sessionId ? "child" : "root" };
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

async function browserSelect({ tabId, ref, option, agentName }) {
  const tab = await chooseTab(tabId);
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
      return { value: this.value, label: (match.label || match.textContent || '').trim() };
    }`,
    arguments: [{ value: String(option) }],
    returnByValue: true,
  }, target.sessionId);
  if (result?.exceptionDetails) throw new Error(result.exceptionDetails?.text || `Unable to select option: ${option}`);
  refStates.delete(tab.id);
  scheduleDetach(tab.id, 5_000);
  return {
    tabId: tab.id,
    ref,
    point,
    frameId,
    sessionScope: sessionId ? "child" : "root",
    ...(result?.result?.value || { value: String(option) }),
  };
}

async function browserCheck({ tabId, ref, checked = true, agentName }) {
  const tab = await chooseTab(tabId);
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
  refStates.delete(tab.id);
  scheduleDetach(tab.id, 5_000);
  return {
    tabId: tab.id,
    ref,
    point: moved.point,
    frameId: moved.frameId,
    sessionScope: moved.sessionId ? "child" : "root",
    checked: result?.result?.value?.checked ?? Boolean(checked),
  };
}

async function browserWait({ tabId, milliseconds, text, urlContains, timeoutMs = 10_000 }) {
  const tab = await chooseTab(tabId);
  const requested = [milliseconds != null, Boolean(text), Boolean(urlContains)].filter(Boolean).length;
  if (requested !== 1) throw new Error("Exactly one of milliseconds, text or urlContains is required");
  const timeout = Math.max(100, Math.min(Number(timeoutMs) || 10_000, 60_000));
  if (milliseconds != null) {
    const delay = Math.max(0, Math.min(Number(milliseconds) || 0, 60_000));
    await sleep(delay);
    return { tabId: tab.id, waitedMs: delay };
  }
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const current = await chrome.tabs.get(tab.id);
    if (urlContains && String(current.url || "").includes(String(urlContains))) {
      return { tabId: tab.id, matched: "url", url: current.url };
    }
    if (text) {
      await requireDebuggableTab(tab.id);
      await attachTab(tab.id);
      const evaluated = await send(tab.id, "Runtime.evaluate", {
        expression: `Boolean(document.body && document.body.innerText.includes(${JSON.stringify(String(text))}))`,
        returnByValue: true,
      });
      if (evaluated?.result?.value === true) {
        scheduleDetach(tab.id, 5_000);
        return { tabId: tab.id, matched: "text", text: String(text) };
      }
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting in tab ${tab.id}`);
}

async function browserFill({ tabId, ref, value, agentName }) {
  const tab = await chooseTab(tabId);
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
      const proto = Object.getPrototypeOf(this);
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
        || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
        || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
      if (descriptor && typeof descriptor.set === 'function') descriptor.set.call(this, nextValue);
      else this.value = nextValue;
      this.dispatchEvent(new Event('input', { bubbles: true }));
      this.dispatchEvent(new Event('change', { bubbles: true }));
      return { value: this.value ?? this.textContent ?? '' };
    }`,
    arguments: [{ value: String(value ?? "") }],
    returnByValue: true,
  }, target.sessionId);
  refStates.delete(tab.id);
  scheduleDetach(tab.id, 100);
  return {
    tabId: tab.id,
    ref,
    point,
    frameId,
    sessionScope: sessionId ? "child" : "root",
    value: result?.result?.value?.value ?? String(value ?? ""),
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

async function browserPress({ tabId, key }) {
  const tab = await chooseTab(tabId);
  await requireDebuggableTab(tab.id);
  await attachTab(tab.id);
  await send(tab.id, "Page.bringToFront");
  const chord = parseKeyChord(key);
  const printable = chord.key.length === 1 && chord.modifiers === 0;
  await send(tab.id, "Input.dispatchKeyEvent", {
    type: "keyDown",
    key: chord.key,
    modifiers: chord.modifiers,
    ...(printable ? { text: chord.key } : {}),
  });
  await send(tab.id, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: chord.key,
    modifiers: chord.modifiers,
  });
  scheduleDetach(tab.id, 5_000);
  return { tabId: tab.id, key: chord.key, modifiers: chord.modifiers };
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

async function browserCreateTab({ url, active = false } = {}) {
  const targetUrl = validateOpenUrl(url);
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
    tabId: tab.id,
    width: normalizedWidth,
    height: normalizedHeight,
    deviceScaleFactor: normalizedDpr,
    mobile: Boolean(mobile),
    touch: Boolean(touch || mobile),
  };
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
  return { tabId: tab.id, cleared: true };
}

async function browserOpen({ tabId, url }) {
  const targetUrl = validateOpenUrl(url);
  const tab = await chooseTab(tabId);
  await detachTab(tab.id);
  await chrome.tabs.update(tab.id, { url: targetUrl, active: true });
  const updated = await waitForTab(
    tab.id,
    (candidate) => candidate.url === targetUrl || (targetUrl.startsWith("http") && candidate.status === "complete"),
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
  observationStates.set(tab.id, {
    startedAt: Date.now(),
    console: [],
    network: [],
    dialog: currentDialogRecord(tab.id)?.dialog || null,
  });
  return { tabId: tab.id, observing: true, startedAt: new Date().toISOString() };
}

async function browserObserveStop({ tabId } = {}) {
  const tab = await chooseTab(tabId);
  const wasObserving = observationStates.has(tab.id);
  await detachTab(tab.id);
  return { tabId: tab.id, observing: false, wasObserving };
}

async function browserConsoleRead({ tabId, limit = 100, clear = false } = {}) {
  const tab = await chooseTab(tabId);
  const state = getObservation(tab.id);
  return { tabId: tab.id, count: state.console.length, items: observationSlice(state.console, limit, clear) };
}

async function browserNetworkRead({ tabId, limit = 100, clear = false } = {}) {
  const tab = await chooseTab(tabId);
  const state = getObservation(tab.id);
  return { tabId: tab.id, count: state.network.length, items: observationSlice(state.network, limit, clear) };
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
  open: browserOpen,
  navigate: browserNavigate,
  emulate: browserEmulate,
  "emulation.clear": browserClearEmulation,
  snapshot: browserSnapshot,
  screenshot: browserScreenshot,
  find: browserFind,
  click: browserClick,
  hover: browserHover,
  scroll: browserScroll,
  select: browserSelect,
  check: browserCheck,
  wait: browserWait,
  fill: browserFill,
  press: browserPress,
  eval: browserEval,
  "observe.start": browserObserveStart,
  "observe.stop": browserObserveStop,
  "console.read": browserConsoleRead,
  "network.read": browserNetworkRead,
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

  const state = observationStates.get(tabId);
  if (!state) return;
  const at = new Date().toISOString();

  if (method === "Runtime.consoleAPICalled") {
    pushBounded(state.console, {
      at,
      kind: "console",
      level: params.type || "log",
      args: (params.args || []).slice(0, 20).map(remoteValue),
    });
    return;
  }
  if (method === "Runtime.exceptionThrown") {
    pushBounded(state.console, {
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
    pushBounded(state.network, {
      at,
      phase: "request",
      requestId: params.requestId || null,
      method: params.request?.method || null,
      url: safeObservedUrl(params.request?.url || params.documentURL || ""),
      type: params.type || null,
    });
    return;
  }
  if (method === "Network.responseReceived") {
    pushBounded(state.network, {
      at,
      phase: "response",
      requestId: params.requestId || null,
      url: safeObservedUrl(params.response?.url || ""),
      status: params.response?.status ?? null,
      statusText: params.response?.statusText || null,
      mimeType: params.response?.mimeType || null,
      type: params.type || null,
      fromDiskCache: Boolean(params.response?.fromDiskCache),
      fromServiceWorker: Boolean(params.response?.fromServiceWorker),
    });
    return;
  }
  if (method === "Network.loadingFailed") {
    pushBounded(state.network, {
      at,
      phase: "failed",
      requestId: params.requestId || null,
      type: params.type || null,
      errorText: params.errorText || null,
      canceled: Boolean(params.canceled),
      blockedReason: params.blockedReason || null,
    });
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
  observationStates.delete(tabId);
  dialogStates.delete(tabId);
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
  observationStates.delete(tabId);
  dialogStates.delete(tabId);
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
