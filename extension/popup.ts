// Chrome MV3 popup: compile to the original classic popup.js, never a module.
type PopupTab = {
  tabId?: number;
  title?: string;
  debuggerSupported?: boolean;
  pageKind?: string;
};
type PopupTarget = { mode: string; tabId?: number; title?: string };
type PopupStatus = {
  consentAccepted: boolean;
  enabled: boolean;
  agentCursorEnabled?: boolean;
  agentCursorName?: string;
  autoContinue?: { target?: PopupTarget; tabs?: PopupTab[] };
  extensionVersion?: string;
  localConnected?: boolean;
  nativeHostConnected?: boolean;
  lastNativeDisconnectError?: string | null;
  tab?: PopupTab | null;
  browserContext?: string;
};
type PopupMessage = { type: string; [key: string]: unknown };
type PopupEnvelope<T> = { ok?: boolean; error?: { message?: string }; result: T };
const popupChrome = (globalThis as typeof globalThis & {
  chrome: { runtime: {
    lastError?: { message: string };
    sendMessage<T>(message: PopupMessage, callback: (reply: PopupEnvelope<T>) => void): void;
  } };
}).chrome;
const popupErrorMessage = (error: unknown): string | null =>
  error && typeof error === "object" && "message" in error && typeof error.message === "string"
    ? error.message
    : null;

const $ = <T extends HTMLElement = HTMLElement>(selector: string): T => document.querySelector(selector) as T;

const consentCard = $("#consent-card");
const acceptConsentButton = $<HTMLButtonElement>("#accept-consent");
const toggle = $<HTMLInputElement>("#enabled-toggle");
const cursorToggle = $<HTMLInputElement>("#cursor-toggle");
const agentNameInput = $<HTMLInputElement>("#agent-name");
const autoContinueTargetSelect = $<HTMLSelectElement>("#auto-continue-target");
const openAgentBrowserButton = $<HTMLButtonElement>("#open-agent-browser");
const agentBrowserDescription = $("#agent-browser-description");
const agentBrowserFeedbackElement = $("#agent-browser-feedback");
const version = $("#version");
const connectionDot = $("#connection-dot");
const connectionStatus = $("#connection-status");
const connectionDetail = $("#connection-detail");
const tabTitle = $("#tab-title");
const tabDot = $("#tab-dot");
const tabState = $("#tab-state");
const offNote = $("#off-note");

let busy = false;
let lastState: PopupStatus | null = null;
let pollTimer: number | null = null;
let agentNameSaveTimer: number | null = null;
let agentNameSaveSequence = 0;
let agentBrowserFeedback: { text: string; error: boolean } | null = null;

function send<T = PopupStatus>(message: PopupMessage): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    popupChrome.runtime.sendMessage<T>(message, (response) => {
      const runtimeError = popupChrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error?.message || "Could not read Equinox Browser status."));
        return;
      }
      resolve(response.result);
    });
  });
}

function setDot(element: HTMLElement, tone: "good" | "warn" | "off") {
  element.classList.remove("good", "warn");
  if (tone === "good" || tone === "warn") element.classList.add(tone);
}

function setAgentBrowserFeedback(text = "", { error = false }: { error?: boolean } = {}) {
  agentBrowserFeedback = text ? { text, error } : null;
  agentBrowserFeedbackElement.textContent = text;
  agentBrowserFeedbackElement.classList.toggle("error", Boolean(text && error));
}

function syncInteractiveDisabled() {
  const consentAccepted = Boolean(lastState?.consentAccepted);
  const inAgentBrowser = lastState?.browserContext === "agent";
  toggle.disabled = busy || !consentAccepted;
  cursorToggle.disabled = busy;
  agentNameInput.disabled = busy;
  autoContinueTargetSelect.disabled = busy || !consentAccepted || !lastState?.enabled;
  acceptConsentButton.disabled = busy;
  openAgentBrowserButton.disabled = busy || inAgentBrowser || !lastState?.localConnected;
}

function renderAgentBrowserAction(state: PopupStatus) {
  const inAgentBrowser = state.browserContext === "agent";
  agentBrowserDescription.textContent = inAgentBrowser
    ? "This Chrome profile is your agent's isolated browser."
    : "Open your agent's isolated Chrome profile without sending it a message.";
  openAgentBrowserButton.textContent = inAgentBrowser ? "Current" : busy ? "Opening…" : "Open";

  if (inAgentBrowser) {
    agentBrowserFeedbackElement.textContent = "You are already in Agent Browser.";
    agentBrowserFeedbackElement.classList.remove("error");
  } else if (!state.localConnected) {
    agentBrowserFeedbackElement.textContent = "Connect Equinox Local to open Agent Browser.";
    agentBrowserFeedbackElement.classList.add("error");
  } else if (agentBrowserFeedback) {
    agentBrowserFeedbackElement.textContent = agentBrowserFeedback.text;
    agentBrowserFeedbackElement.classList.toggle("error", agentBrowserFeedback.error);
  } else {
    agentBrowserFeedbackElement.textContent = "";
    agentBrowserFeedbackElement.classList.remove("error");
  }
}

function renderAutoContinueTarget(state: PopupStatus) {
  const autoContinue = state.autoContinue || { target: { mode: "task-tab" }, tabs: [] };
  const target = autoContinue.target || { mode: "task-tab" };
  const tabs = Array.isArray(autoContinue.tabs) ? autoContinue.tabs : [];
  const previousValue = target.mode === "pinned" && Number.isInteger(target.tabId)
    ? `pinned:${target.tabId}`
    : "task-tab";

  autoContinueTargetSelect.replaceChildren();
  const automatic = document.createElement("option");
  automatic.value = "task-tab";
  automatic.textContent = "Current task’s ChatGPT tab (automatic)";
  autoContinueTargetSelect.append(automatic);

  for (const tab of tabs) {
    if (!Number.isInteger(tab?.tabId)) continue;
    const option = document.createElement("option");
    option.value = `pinned:${tab.tabId}`;
    option.textContent = `Pin: ${String(tab.title || "ChatGPT").slice(0, 72)}`;
    autoContinueTargetSelect.append(option);
  }

  if (target.mode === "pinned" && !tabs.some((tab) => tab?.tabId === target.tabId)) {
    const stale = document.createElement("option");
    stale.value = previousValue;
    stale.textContent = `Pinned tab unavailable: ${String(target.title || "ChatGPT").slice(0, 56)}`;
    autoContinueTargetSelect.append(stale);
  }
  autoContinueTargetSelect.value = previousValue;
}

function tabPresentation(state: PopupStatus): { tone: "good" | "warn" | "off"; label: string } {
  if (!state.consentAccepted) {
    return { tone: "warn", label: "Waiting for browser access consent" };
  }
  if (!state.enabled) {
    return { tone: "off", label: "Control off" };
  }
  if (!state.tab) {
    return { tone: "warn", label: "No active tab found" };
  }
  if (state.tab.debuggerSupported) {
    return { tone: "good", label: "This tab is ready for control" };
  }
  if (state.tab.pageKind === "chrome-new-tab") {
    return { tone: "warn", label: "Ready when a web page is open" };
  }
  return { tone: "warn", label: "This Chrome page cannot be controlled" };
}

function render(state: PopupStatus) {
  lastState = state;
  const consentAccepted = Boolean(state.consentAccepted);
  consentCard.hidden = consentAccepted;
  toggle.checked = Boolean(state.enabled);
  cursorToggle.checked = Boolean(state.agentCursorEnabled);
  if (document.activeElement !== agentNameInput) {
    agentNameInput.value = state.agentCursorName || "Agent";
  }
  renderAgentBrowserAction(state);
  renderAutoContinueTarget(state);
  syncInteractiveDisabled();
  version.textContent = `v${state.extensionVersion || "—"}`;
  offNote.hidden = !consentAccepted || Boolean(state.enabled);

  if (!consentAccepted) {
    setDot(connectionDot, "warn");
    connectionStatus.textContent = "Waiting for consent";
    connectionDetail.textContent = state.localConnected
      ? "Equinox Local connected; browser data is not being shared."
      : state.nativeHostConnected
        ? "Local settings channel connected; browser data is not being shared."
        : "Connecting Native Messaging host; browser data is not being shared.";
  } else if (!state.enabled) {
    if (state.localConnected) {
      setDot(connectionDot, "good");
      connectionStatus.textContent = "Automation off";
      connectionDetail.textContent = "Equinox Local connected; settings channel only.";
    } else {
      setDot(connectionDot, "warn");
      connectionStatus.textContent = "Automation off";
      connectionDetail.textContent = "Settings channel is waiting for Equinox Local.";
    }
  } else if (state.localConnected) {
    setDot(connectionDot, "good");
    connectionStatus.textContent = "Equinox Local connected";
    connectionDetail.textContent = "Browser bridge is ready and waiting for commands.";
  } else if (state.nativeHostConnected) {
    setDot(connectionDot, "warn");
    connectionStatus.textContent = "Waiting for Equinox Local";
    connectionDetail.textContent = "Native Messaging host connected; reconnecting to Local.";
  } else {
    setDot(connectionDot, "warn");
    connectionStatus.textContent = "Connecting";
    connectionDetail.textContent = state.lastNativeDisconnectError
      ? "Retrying the Native Messaging host connection."
      : "Starting the Native Messaging host.";
  }

  tabTitle.textContent = state.tab?.title || "—";
  const tab = tabPresentation(state);
  setDot(tabDot, tab.tone);
  tabState.textContent = tab.label;
}

function renderError(error: unknown) {
  setDot(connectionDot, "warn");
  connectionStatus.textContent = "Could not read status";
  connectionDetail.textContent = popupErrorMessage(error) || "Equinox Browser service worker did not respond.";
  tabTitle.textContent = "—";
  setDot(tabDot, "warn");
  tabState.textContent = "Status unavailable";
}

async function refresh({ quiet = false }: { quiet?: boolean } = {}) {
  try {
    const state = await send({ type: "equinox.popup.status" });
    render(state);
  } catch (error) {
    if (!quiet || !lastState) renderError(error);
  }
}

async function acceptBrowserControlConsent() {
  if (busy) return;
  busy = true;
  syncInteractiveDisabled();
  try {
    const state = await send({ type: "equinox.popup.acceptBrowserControlConsent" });
    render(state);
  } catch (error) {
    renderError(error);
  } finally {
    busy = false;
    syncInteractiveDisabled();
  }
}

async function setEnabled(enabled: boolean) {
  if (busy) return;
  busy = true;
  syncInteractiveDisabled();
  try {
    const state = await send({ type: "equinox.popup.setEnabled", enabled });
    render(state);
  } catch (error) {
    toggle.checked = Boolean(lastState?.enabled);
    renderError(error);
  } finally {
    busy = false;
    syncInteractiveDisabled();
  }
}

async function setAgentCursorEnabled(enabled: boolean) {
  if (busy) return;
  busy = true;
  syncInteractiveDisabled();
  try {
    const state = await send({ type: "equinox.popup.setAgentCursorEnabled", enabled });
    render(state);
  } catch (error) {
    cursorToggle.checked = Boolean(lastState?.agentCursorEnabled);
    renderError(error);
  } finally {
    busy = false;
    syncInteractiveDisabled();
  }
}

async function setAutoContinueTarget(value: string) {
  if (busy) return;
  busy = true;
  syncInteractiveDisabled();
  try {
    const match = /^pinned:(\d+)$/u.exec(String(value || ""));
    const state = match
      ? await send({ type: "equinox.popup.setAutoContinueTarget", mode: "pinned", tabId: Number(match[1]) })
      : await send({ type: "equinox.popup.setAutoContinueTarget", mode: "task-tab" });
    render(state);
  } catch (error) {
    renderError(error);
    if (lastState) renderAutoContinueTarget(lastState);
  } finally {
    busy = false;
    syncInteractiveDisabled();
  }
}

async function openAgentBrowser() {
  if (busy || lastState?.browserContext === "agent") return;
  busy = true;
  setAgentBrowserFeedback("Opening Agent Browser…");
  if (lastState) renderAgentBrowserAction(lastState);
  syncInteractiveDisabled();
  try {
    const result = await send<{ opened?: boolean }>({ type: "equinox.popup.openAgentBrowser" });
    setAgentBrowserFeedback(
      result?.opened ? "Agent Browser opened." : "Agent Browser is already open.",
    );
  } catch (error) {
    setAgentBrowserFeedback(popupErrorMessage(error) || "Could not open Agent Browser.", { error: true });
  } finally {
    busy = false;
    if (lastState) renderAgentBrowserAction(lastState);
    syncInteractiveDisabled();
    void refresh({ quiet: true });
  }
}

async function persistAgentCursorName() {
  if (agentNameSaveTimer) {
    clearTimeout(agentNameSaveTimer);
    agentNameSaveTimer = null;
  }
  const sequence = ++agentNameSaveSequence;
  try {
    const state = await send({
      type: "equinox.popup.setAgentCursorName",
      name: agentNameInput.value,
    });
    if (sequence === agentNameSaveSequence) render(state);
  } catch (error) {
    if (sequence === agentNameSaveSequence) renderError(error);
  }
}

function queueAgentCursorNameSave() {
  if (agentNameSaveTimer) clearTimeout(agentNameSaveTimer);
  agentNameSaveTimer = setTimeout(() => {
    agentNameSaveTimer = null;
    void persistAgentCursorName();
  }, 250);
}

openAgentBrowserButton.addEventListener("click", () => {
  void openAgentBrowser();
});

acceptConsentButton.addEventListener("click", () => {
  void acceptBrowserControlConsent();
});

toggle.addEventListener("change", () => {
  void setEnabled(toggle.checked);
});

cursorToggle.addEventListener("change", () => {
  void setAgentCursorEnabled(cursorToggle.checked);
});

autoContinueTargetSelect.addEventListener("change", () => {
  void setAutoContinueTarget(autoContinueTargetSelect.value);
});

agentNameInput.addEventListener("input", queueAgentCursorNameSave);
agentNameInput.addEventListener("change", () => {
  void persistAgentCursorName();
});
agentNameInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") agentNameInput.blur();
});

void refresh();
pollTimer = setInterval(() => {
  if (!busy) void refresh({ quiet: true });
}, 1_200);

window.addEventListener("unload", () => {
  if (pollTimer) clearInterval(pollTimer);
  if (agentNameSaveTimer) clearTimeout(agentNameSaveTimer);
});
