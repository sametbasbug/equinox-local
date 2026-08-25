const $ = (selector) => document.querySelector(selector);

const consentCard = $("#consent-card");
const acceptConsentButton = $("#accept-consent");
const toggle = $("#enabled-toggle");
const cursorToggle = $("#cursor-toggle");
const agentNameInput = $("#agent-name");
const version = $("#version");
const connectionDot = $("#connection-dot");
const connectionStatus = $("#connection-status");
const connectionDetail = $("#connection-detail");
const tabTitle = $("#tab-title");
const tabDot = $("#tab-dot");
const tabState = $("#tab-state");
const offNote = $("#off-note");

let busy = false;
let lastState = null;
let pollTimer = null;
let agentNameSaveTimer = null;
let agentNameSaveSequence = 0;

function send(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const runtimeError = chrome.runtime.lastError;
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

function setDot(element, tone) {
  element.classList.remove("good", "warn");
  if (tone === "good" || tone === "warn") element.classList.add(tone);
}

function syncInteractiveDisabled() {
  const consentAccepted = Boolean(lastState?.consentAccepted);
  toggle.disabled = busy || !consentAccepted;
  cursorToggle.disabled = busy;
  agentNameInput.disabled = busy;
  acceptConsentButton.disabled = busy;
}

function tabPresentation(state) {
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

function render(state) {
  lastState = state;
  const consentAccepted = Boolean(state.consentAccepted);
  consentCard.hidden = consentAccepted;
  toggle.checked = Boolean(state.enabled);
  cursorToggle.checked = Boolean(state.agentCursorEnabled);
  if (document.activeElement !== agentNameInput) {
    agentNameInput.value = state.agentCursorName || "Agent";
  }
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

function renderError(error) {
  setDot(connectionDot, "warn");
  connectionStatus.textContent = "Could not read status";
  connectionDetail.textContent = error?.message || "Equinox Browser service worker did not respond.";
  tabTitle.textContent = "—";
  setDot(tabDot, "warn");
  tabState.textContent = "Status unavailable";
}

async function refresh({ quiet = false } = {}) {
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

async function setEnabled(enabled) {
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

async function setAgentCursorEnabled(enabled) {
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

acceptConsentButton.addEventListener("click", () => {
  void acceptBrowserControlConsent();
});

toggle.addEventListener("change", () => {
  void setEnabled(toggle.checked);
});

cursorToggle.addEventListener("change", () => {
  void setAgentCursorEnabled(cursorToggle.checked);
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
