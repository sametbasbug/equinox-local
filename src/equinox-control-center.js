import {
  localeForLanguage,
  normalizeLanguage,
  SUPPORTED_LANGUAGES,
  translateDoctorDetail,
  translateRuntimeEventMessage,
  translateUiText,
} from "./equinox-control-center-localization.js";

const $ = (id) => document.getElementById(id);

const LANGUAGE_STORAGE_KEY = "equinox-local-control-center-language";
const THEME_STORAGE_KEY = "equinox-local-control-center-theme";
const SECTION_STORAGE_KEY = "equinox-local-control-center-last-section";
const NAVIGATION_SHORTCUTS = Object.freeze({
  Digit1: "dashboard",
  Digit2: "projects",
  Digit3: "tasks",
  Digit4: "browser",
  Digit5: "permissions",
  Digit6: "integrations",
  Digit7: "activity",
});
const SUPPORTED_THEMES = new Set(["system", "light", "dark"]);
const systemThemeMedia = window.matchMedia("(prefers-color-scheme: dark)");
const EQUINOX_BROWSER_STORE_URL =
  "https://chromewebstore.google.com/detail/equinox-browser/npdneefcobilfkjlihghjgjnknenhfoj";

function isAbsoluteLocalFolderPath(value) {
  if (typeof value !== "string" || !value || value.length > 1024) return false;
  if (value.startsWith("/") && value !== "/") return true;
  if (/^[A-Za-z]:[\\/](?!$)/u.test(value)) return true;
  return /^\\\\[^\\/]+[\\/][^\\/]+[\\/].+/u.test(value);
}

async function pickLocalFolder() {
  const bridge = window.chrome?.webview;
  if (
    typeof bridge?.postMessage !== "function"
    || typeof bridge?.addEventListener !== "function"
    || typeof bridge?.removeEventListener !== "function"
  ) {
    return mutationJson("/api/v1/folder-picker", "POST", {});
  }

  const requestId = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `picker_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  return new Promise((resolve, reject) => {
    let timeout = null;
    const cleanup = () => {
      if (timeout !== null) clearTimeout(timeout);
      bridge.removeEventListener("message", onMessage);
    };
    const onMessage = (event) => {
      const message = event?.data;
      if (message?.type !== "equinox-folder-picker-result" || message.requestId !== requestId) return;
      cleanup();
      if (typeof message.error === "string" && message.error) {
        reject(new Error(message.error));
        return;
      }
      const path = typeof message.path === "string" ? message.path : null;
      resolve({ cancelled: message.cancelled === true, path });
    };
    bridge.addEventListener("message", onMessage);
    timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Native folder selection timed out."));
    }, 120_000);
    bridge.postMessage(JSON.stringify({ type: "equinox-folder-picker", requestId }));
  });
}

function normalizeTheme(value) {
  return SUPPORTED_THEMES.has(value) ? value : "system";
}

function initialTheme() {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (SUPPORTED_THEMES.has(stored)) return stored;
  } catch {
    // A blocked localStorage must not prevent Control Center from loading.
  }
  return "system";
}

function resolvedTheme(theme = state?.theme || "system") {
  return theme === "system" ? (systemThemeMedia.matches ? "dark" : "light") : theme;
}

function applyTheme() {
  const preference = normalizeTheme(state.theme);
  const resolved = resolvedTheme(preference);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.style.colorScheme = resolved;
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) themeMeta.content = resolved === "dark" ? "#19191d" : "#f6f5f2";
  for (const button of document.querySelectorAll("[data-theme-value]")) {
    const active = button.dataset.themeValue === preference;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  }
}

function setTheme(nextTheme, { persist = true } = {}) {
  state.theme = normalizeTheme(nextTheme);
  if (persist) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, state.theme);
    } catch {
      // Theme selection still applies for the current page if storage is unavailable.
    }
  }
  applyTheme();
}

function initialLanguage() {
  try {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (SUPPORTED_LANGUAGES.includes(stored)) return stored;
  } catch {
    // A blocked localStorage must not prevent Control Center from loading.
  }
  if (SUPPORTED_LANGUAGES.includes(window.__equinoxNativeLanguage)) return window.__equinoxNativeLanguage;
  return String(navigator.language || "").toLowerCase().startsWith("tr") ? "tr" : "en";
}

function notifyNativeLanguage() {
  try {
    window.webkit?.messageHandlers?.equinoxNativeLanguage?.postMessage(state.language);
  } catch {
    // External browsers do not expose the native bridge; language still works normally.
  }
}

const state = {
  language: initialLanguage(),
  theme: initialTheme(),
  activeSection: "dashboard",
  setupMode: false,
  lastRefreshedAt: null,
  refreshAllBusy: false,
  config: null,
  revision: null,
  status: null,
  health: null,
  doctor: null,
  doctorRepairs: null,
  doctorRepairBusy: false,
  doctorRepairResult: null,
  activity: [],
  tasks: [],
  selectedTaskId: null,
  taskDraft: null,
  taskDraftDirty: false,
  taskBusy: false,
  update: null,
  updateBusy: false,
  updateApplyBusy: false,
  onboarding: null,
  onboardingBusy: false,
  onboardingReconnectTimer: null,
  uninstallBusy: false,
  uninstallScheduled: false,
  telegram: null,
  webFileTransfer: null,
  telegramBotToken: "",
  telegramPairingPollBusy: false,
  telegramSetupSkipped: false,
  httpProfiles: null,
  httpProfileDraft: null,
  httpProfileBusy: false,
  httpProfileTestResults: {},
  browserDraft: null,
  browserSettingsTarget: "user",
  browserSettingsDirty: false,
  browserSettingsBusy: false,
  agentBrowserBusy: false,
  integrationBusy: false,
  pickerBusy: false,
  restartBusy: false,
  agentControlBusy: false,
  turnBudget: null,
  turnBudgetDraft: null,
  turnBudgetDirty: false,
  turnBudgetBusy: false,
  runtimeRestartTimer: null,
  dirty: false,
  restartRequired: false,
  dialogMode: null,
  dialogKind: "project",
  editingId: null,
  toastTimer: null,
  autoRefreshLiveBusy: false,
  autoRefreshMediumBusy: false,
  autoRefreshSlowBusy: false,
  lastAutoRefreshAt: 0,
};

const AUTO_REFRESH_LIVE_MS = 3_000;
const AUTO_REFRESH_MEDIUM_MS = 15_000;
const AUTO_REFRESH_SLOW_MS = 60_000;
const AUTO_REFRESH_FOCUS_DEBOUNCE_MS = 750;

function localizeUiText(value) {
  return translateUiText(value, state.language);
}

const DYNAMIC_TEXT_IDS = new Set([
  "sidebar-health-label", "sidebar-version", "sidebar-update-indicator", "section-kicker", "section-title", "last-refreshed",
  "agent-control-button", "restart-runtime-button", "onboarding-copy", "onboarding-badge", "setup-runtime-status",
  "setup-workspace-status", "setup-browser-status", "setup-tunnel-status", "setup-telegram-status", "setup-telegram-detail", "onboarding-connect-button",
  "runtime-health-badge", "overview-title", "overview-copy", "runtime-version", "runtime-uptime", "browser-status", "browser-version",
  "peekaboo-status", "peekaboo-detail", "api-status", "api-detail", "project-count", "folder-count",
  "default-project", "health-summary-title", "health-summary-badge", "health-summary-copy", "health-event-count",
  "health-evaluated-at", "doctor-title", "doctor-badge", "doctor-copy", "doctor-list", "doctor-summary",
  "doctor-checked-at", "doctor-fix-title", "doctor-fix-summary", "doctor-fix-copy", "doctor-repair-list", "doctor-repair-result", "update-title", "update-badge", "update-copy", "update-version", "update-checked-at",
  "update-main-current", "update-main-target", "update-main-distance", "update-main-summaries", "update-stable-main-copy",
  "check-update-button", "install-update-button", "root-count-label", "dirty-state", "project-list",
  "default-project-select", "workspace-project-select", "downloads-root-select", "control-center-address",
  "save-config-button", "agent-browser-page-status", "agent-browser-page-badge", "agent-browser-page-version", "agent-browser-connected-at",
  "agent-browser-control-state", "open-agent-browser-button", "agent-browser-note", "browser-page-status", "browser-page-badge", "browser-page-version", "browser-connected-at",
  "browser-control-state", "apply-browser-settings", "browser-settings-note", "permissions-list", "agent-access-badge",
  "agent-control-badge", "agent-control-copy", "active-terminal-count", "active-process-count", "active-work-count",
  "turn-budget-badge", "turn-budget-copy", "turn-budget-elapsed", "turn-budget-remaining", "turn-budget-stage", "turn-budget-fallback-reset", "auto-continue-max-hops", "save-turn-budget-button",
  "local-execution-badge", "save-agent-access-button", "uninstall-badge",
  "uninstall-confirmation-help", "uninstall-button", "integration-list", "request-count", "mutation-count",
  "activity-event-count", "activity-timeline", "dialog-kicker", "dialog-title", "dialog-error", "choose-folder-button",
  "error-message", "toast",
]);

const staticTextEntries = [];
const staticAttributeEntries = [];

function captureStaticTranslatables() {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const source = node.nodeValue || "";
    if (!source.trim()) continue;
    const owner = node.parentElement?.closest?.("[id]");
    if (owner && DYNAMIC_TEXT_IDS.has(owner.id)) continue;
    staticTextEntries.push({ node, source });
  }
  for (const element of document.querySelectorAll("[placeholder], [aria-label], [title]")) {
    for (const attribute of ["placeholder", "aria-label", "title"]) {
      const source = element.getAttribute(attribute);
      if (source) staticAttributeEntries.push({ element, attribute, source });
    }
  }
}

function applyStaticLanguage() {
  document.documentElement.lang = state.language;
  document.title = localizeUiText("Equinox Local Control Center");
  for (const entry of staticTextEntries) {
    const leading = entry.source.match(/^\s*/u)?.[0] || "";
    const trailing = entry.source.match(/\s*$/u)?.[0] || "";
    entry.node.nodeValue = `${leading}${localizeUiText(entry.source.trim())}${trailing}`;
  }
  for (const entry of staticAttributeEntries) {
    entry.element.setAttribute(entry.attribute, localizeUiText(entry.source));
  }
  const select = $("language-select");
  if (select) select.value = state.language;
}

function renderLastRefreshed() {
  setText(
    "last-refreshed",
    state.lastRefreshedAt
      ? `Refreshed ${new Intl.DateTimeFormat(localeForLanguage(state.language), { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(state.lastRefreshedAt)}`
      : "Not refreshed yet",
  );
}

function localizeDoctorDetail(item) {
  return translateDoctorDetail(item, state.language);
}

function localizeRuntimeEventMessage(message) {
  return translateRuntimeEventMessage(message, state.language);
}

function setLanguage(nextLanguage, { persist = true } = {}) {
  const language = normalizeLanguage(nextLanguage);
  state.language = language;
  notifyNativeLanguage();
  if (persist) {
    try {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
    } catch {
      // Language selection still applies for the current page if storage is unavailable.
    }
  }
  applyStaticLanguage();
  if (state.config) renderAll();
  setText("save-config-button", "Save configuration");
  switchSection(state.activeSection);
  renderLastRefreshed();
  if (state.dialogMode) {
    const isProject = state.dialogKind === "project";
    const isEdit = state.dialogMode === "edit";
    setText("dialog-kicker", isProject ? "Project" : "Read-only folder");
    setText("dialog-title", `${isEdit ? "Edit" : "Add"} ${isProject ? "project" : "read-only folder"}`);
  }
}

const sectionMeta = {
  setup: ["Getting started", "Setup Equinox Local"],
  dashboard: ["Your workspace", "Overview"],
  projects: ["Your workspace", "Projects & folders"],
  tasks: ["Your workspace", "Tasks"],
  browser: ["Browser contexts", "Browser"],
  permissions: ["Agent control", "Safety & access"],
  integrations: ["Optional capabilities", "Services"],
  activity: ["Diagnostics", "Activity"],
};

function clone(value) {
  return structuredClone(value);
}

function setText(id, value) {
  const element = $(id);
  if (element) element.textContent = localizeUiText(value ?? "—");
}

function setDot(id, tone) {
  const element = $(id);
  if (!element) return;
  element.className = `status-dot is-${tone}`;
}

function setBadge(elementOrId, text, tone = "neutral") {
  const element = typeof elementOrId === "string" ? $(elementOrId) : elementOrId;
  if (!element) return;
  element.textContent = localizeUiText(text);
  element.className = `badge ${tone}`;
}

function toneForHealth(healthState) {
  if (healthState === "HEALTHY") return "good";
  if (healthState === "RECOVERING" || healthState === "DEGRADED") return "warn";
  if (healthState === "ATTENTION REQUIRED") return "bad";
  return "neutral";
}

function dotToneForHealth(healthState) {
  const tone = toneForHealth(healthState);
  return tone === "good" ? "good" : tone === "warn" ? "warn" : tone === "bad" ? "bad" : "neutral";
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(localeForLanguage(state.language), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatUptime(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return localizeUiText("Uptime unavailable");
  const seconds = Math.round(totalSeconds);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return localizeUiText(`${days}d ${hours}h uptime`);
  if (hours > 0) return localizeUiText(`${hours}h ${minutes}m uptime`);
  return localizeUiText(`${Math.max(1, minutes)}m uptime`);
}

async function requestJson(path, options = {}) {
  const { backgroundRefresh = false, headers: optionHeaders = {}, ...fetchOptions } = options;
  const headers = { ...optionHeaders };
  if (backgroundRefresh) headers["x-equinox-background-refresh"] = "1";
  const response = await fetch(path, {
    cache: "no-store",
    credentials: "same-origin",
    ...fetchOptions,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  });
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${path} returned an unreadable response.`);
  }
  if (!response.ok || body?.ok === false) {
    throw new Error(body?.error || `${path} failed with HTTP ${response.status}.`);
  }
  return body;
}

async function mutationJson(path, method, body) {
  const session = await requestJson("/api/v1/session");
  return await requestJson(path, {
    method,
    headers: {
      "content-type": "application/json",
      "x-equinox-csrf": session.csrfToken,
    },
    body: JSON.stringify(body),
  });
}

function showError(error) {
  setText("error-message", error instanceof Error ? error.message : String(error));
  $("error-banner").hidden = false;
}

function clearError() {
  $("error-banner").hidden = true;
  setText("error-message", "");
}

function showToast(message) {
  const toast = $("toast");
  toast.textContent = localizeUiText(message);
  toast.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 3200);
}

function markDirty() {
  if (state.restartRequired) return;
  state.dirty = true;
  setBadge("dirty-state", "Unsaved changes", "warn");
  setText("save-config-button", "Save configuration");
  $("save-config-button").disabled = false;
  if ($("save-agent-access-button")) {
    setText("save-agent-access-button", "Save access settings");
    $("save-agent-access-button").disabled = false;
  }
}

function markClean() {
  state.dirty = false;
  setBadge("dirty-state", "No unsaved changes", "neutral");
  setText("save-config-button", "Save configuration");
  $("save-config-button").disabled = true;
  if ($("save-agent-access-button")) {
    setText("save-agent-access-button", "Save access settings");
    $("save-agent-access-button").disabled = true;
  }
}

function setConfigEditingEnabled(enabled) {
  const ids = [
    "add-folder-button",
    "add-project-button",
    "default-project-select",
    "workspace-project-select",
    "downloads-root-select",
    "agent-files-access",
    "agent-terminal-access",
    "agent-desktop-access",
    "agent-web-access",
  ];
  for (const id of ids) {
    const element = $(id);
    if (element) element.disabled = !enabled;
  }
  for (const button of document.querySelectorAll(".project-actions button")) {
    button.disabled = !enabled || button.dataset.locked === "true";
  }
  if (!enabled) $("save-config-button").disabled = true;
  if (!enabled && $("save-agent-access-button")) $("save-agent-access-button").disabled = true;
}

function switchSection(section, { remember = false } = {}) {
  if (!sectionMeta[section]) return;
  if (state.setupMode && section !== "setup") return;
  if (!state.setupMode && section === "setup") return;
  const changed = state.activeSection !== section;
  state.activeSection = section;
  if (remember && section !== "setup") {
    try {
      localStorage.setItem(SECTION_STORAGE_KEY, section);
    } catch {
      // A disabled storage permission must not block navigation.
    }
  }
  for (const button of document.querySelectorAll(".nav-item")) {
    const active = button.dataset.section === section;
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  for (const element of document.querySelectorAll(".page-section")) {
    const active = element.id === `section-${section}`;
    element.hidden = !active;
    element.classList.toggle("is-active", active);
  }
  const [kicker, title] = sectionMeta[section];
  setText("section-kicker", kicker);
  setText("section-title", title);
  if (changed) {
    $("main-content").scrollIntoView({ block: "start", behavior: "instant" });
  }
}

function statusLabel(active, ready = active) {
  if (ready) return "Ready";
  if (active) return "Connected, not ready";
  return "Disconnected";
}

function renderDashboard() {
  const status = state.status || {};
  const healthSummary = status.health || {};
  const runtimeHealth = healthSummary.state || "UNKNOWN";
  const runtimeTone = toneForHealth(runtimeHealth);
  const browser = status.browser || {};
  const peekaboo = status.peekaboo || {};
  const controlCenter = state.health?.controlCenter || {};
  const configStatus = status.config || {};

  setBadge("runtime-health-badge", runtimeHealth === "UNKNOWN" ? "Health unavailable" : runtimeHealth, runtimeTone);
  if (runtimeHealth === "HEALTHY") {
    setText("overview-title", "Your computer is ready");
    setText("overview-copy", "Local tools are ready. Your agent stays in ChatGPT on the web; its connected tools run here on your computer.");
  } else if (runtimeHealth === "UNKNOWN") {
    setText("overview-title", "Status is still loading");
    setText("overview-copy", "The local API is reachable, but the runtime summary is not complete yet.");
  } else {
    setText("overview-title", "Some parts need your attention");
    setText("overview-copy", "Review the highlighted status below before starting important agent work.");
  }
  const paused = status.agentControl?.paused === true || status.agentControl?.state === "PAUSED";
  if (paused) {
    setText("overview-title", "Your agent is paused");
    setText("overview-copy", "Local stays connected for read-only status. Resume when you are ready; stopped work will not restart on its own.");
  }

  const onboarding = state.onboarding;
  const connection = status.chatgptConnection || null;
  const connectionAvailable = connection?.available === true || (!connection && onboarding?.available === true);
  const connectionNeedsAttention = connection
    ? connection.needsAttention === true
    : onboarding?.needsAttention === true;
  const connectionConnected = connection
    ? connection.connected === true
    : onboarding?.connectedThroughTunnel === true;
  const connectionLabel = !connectionAvailable
    ? "Connection status unavailable"
    : connectionNeedsAttention
      ? "Connection needs attention"
      : connectionConnected
        ? (connection?.mode === "source" ? "MCP runtime connected" : "ChatGPT connected")
        : "ChatGPT not connected";
  setBadge("chatgpt-connection-badge", connectionLabel,
    !connectionAvailable ? "neutral" : connectionNeedsAttention ? "warn" : connectionConnected ? "good" : "neutral");

  setBadge("health-summary-badge", runtimeHealth === "UNKNOWN" ? "Unknown" : runtimeHealth, runtimeTone);
  setText("runtime-version", status.server?.version ? `v${status.server.version}` : "—");
  setText("runtime-uptime", formatUptime(status.server?.uptimeSeconds));
  const channel = state.update || {};
  const onMain = ["source", "managed-source"].includes(channel.installationKind) && channel.main?.checkSupported === true;
  const currentSha = shortUpdateSha(channel.main?.currentSha || status.installation?.sourceSha);
  setText("sidebar-version", status.server?.version
    ? `${status.server.version}${onMain && currentSha ? ` - ${currentSha}` : ""}`
    : "Local runtime");
  setText("sidebar-health-label", runtimeHealth === "HEALTHY" ? "Runtime healthy" : runtimeHealth.toLowerCase().replaceAll("_", " "));
  setDot("sidebar-health-dot", dotToneForHealth(runtimeHealth));

  const defaultBrowser = browser.contexts?.agent || {};
  const browserConsentRequired = defaultBrowser.ready && defaultBrowser.consentAccepted === false;
  const browserLabel = browserConsentRequired
    ? "Connected · consent required"
    : defaultBrowser.ready && defaultBrowser.controlEnabled === false
      ? "Connected · automation off"
      : defaultBrowser.ready
        ? "Ready"
        : browser.agentBrowser?.pairing
          ? "Waiting for extension"
          : browser.agentBrowser?.setupComplete
            ? "Closed"
            : "Setup needed";
  setText("browser-status", browserLabel);
  setText("browser-version", defaultBrowser.extensionVersion ? `Extension ${defaultBrowser.extensionVersion}` : "Agent Browser · isolated default");
  setDot("browser-status-dot", defaultBrowser.ready ? (browserConsentRequired || defaultBrowser.controlEnabled === false ? "warn" : "good") : browser.agentBrowser?.setupComplete ? "neutral" : "warn");

  const peekabooReady = peekaboo.ready === true || (peekaboo.ready === undefined && peekaboo.active === true);
  const peekabooLabel = peekaboo.needsAttention
    ? "Needs attention"
    : peekabooReady
      ? "Ready"
      : peekaboo.available === false
        ? "Not available"
        : "Not checked";
  setText("peekaboo-status", peekabooLabel);
  setText("peekaboo-detail", peekaboo.version ? `Peekaboo ${peekaboo.version}` : "Optional desktop capability");
  setDot("peekaboo-status-dot", peekaboo.needsAttention ? "warn" : peekabooReady ? "good" : "neutral");

  setText("api-status", controlCenter.active ? "Listening" : "Unavailable");
  setText("api-detail", controlCenter.port ? `127.0.0.1:${controlCenter.port}` : "127.0.0.1 only");
  setDot("api-status-dot", controlCenter.active ? "good" : "bad");

  setText("project-count", String(configStatus.projectCount ?? Object.keys(state.config?.projects || {}).length));
  setText("folder-count", String(Object.keys(state.config?.fileRoots || {}).length));
  setText("default-project", state.config?.defaultProject || configStatus.defaultProject || "—");

  if (runtimeHealth === "HEALTHY") {
    setText("health-summary-title", "Everything looks healthy");
    setText("health-summary-copy", "The bounded runtime health window has no unresolved warnings that need your attention.");
  } else if (runtimeHealth === "UNKNOWN") {
    setText("health-summary-title", "Runtime health is unavailable");
    setText("health-summary-copy", "The management API is reachable, but no runtime health summary was returned.");
  } else {
    const count = Number(healthSummary.reasonCount || 0);
    setText("health-summary-title", `${count || "Some"} item${count === 1 ? "" : "s"} may need attention`);
    setText("health-summary-copy", "Open the diagnostics tools for detail. The Control Center summary intentionally avoids exposing raw runtime logs.");
  }
  setText("health-event-count", `${healthSummary.recentEventCount ?? 0} recent events`);
  setText("health-evaluated-at", healthSummary.evaluatedAt ? `Evaluated ${formatDate(healthSummary.evaluatedAt)}` : "Not evaluated yet");
}

function moveUninstallCard(setupMode) {
  const card = $("uninstall-card");
  const target = setupMode ? $("setup-uninstall-slot") : $("permissions-uninstall-slot");
  if (card && target && card.parentElement !== target) target.appendChild(card);
}

function applySetupMode(setupMode) {
  const previous = state.setupMode;
  state.setupMode = setupMode;
  document.body.classList.toggle("setup-mode", setupMode);
  $("control-center-nav").hidden = setupMode;
  $("setup-nav").hidden = !setupMode;
  moveUninstallCard(setupMode);
  if (setupMode && state.activeSection !== "setup") switchSection("setup");
  if (!setupMode && state.activeSection === "setup") switchSection("dashboard");
  if (previous && !setupMode) showToast("Setup complete. ChatGPT can now reach this computer.");
}

function renderOnboarding() {
  const onboarding = state.onboarding || {};
  const setupMode = onboarding.available === true && onboarding.setupComplete !== true;
  applySetupMode(setupMode);
  if (!setupMode) return;

  const runtimeReady = Boolean(state.health?.controlCenter?.active && state.status?.server?.version);
  setBadge("setup-runtime-status", runtimeReady ? "Ready" : "Checking", runtimeReady ? "good" : "neutral");

  if (onboarding.needsAttention) {
    setBadge("setup-tunnel-status", "Needs attention", "warn");
    setText("onboarding-copy", onboarding.issue || "The saved tunnel connection needs attention. Re-enter the Runtime API key to repair it.");
  } else if (onboarding.connectedThroughTunnel) {
    setBadge("setup-tunnel-status", "Connected", "good");
    setText("onboarding-copy", "Finish the remaining steps. Setup unlocks only after a real ChatGPT tool request reaches this computer.");
  } else if (onboarding.transportConfigured) {
    setBadge("setup-tunnel-status", "Connecting", "warn");
    setText("onboarding-copy", "Tunnel settings are saved. Equinox Local is reconnecting through your private tunnel.");
  } else {
    setBadge("setup-tunnel-status", "Not connected", "warn");
    setText("onboarding-copy", "Create the tunnel, add Equinox Local to ChatGPT, install Equinox Browser, then verify the first real tool call.");
  }

  const tunnelIdInput = $("onboarding-tunnel-id");
  if (tunnelIdInput && document.activeElement !== tunnelIdInput && onboarding.tunnelId && !tunnelIdInput.value) {
    tunnelIdInput.value = onboarding.tunnelId;
  }
  const runtimeKeyInput = $("onboarding-runtime-key");
  const connectButton = $("onboarding-connect-button");
  const tunnelForm = $("onboarding-tunnel-form");
  if (tunnelForm) tunnelForm.hidden = onboarding.connectedThroughTunnel === true && onboarding.needsAttention !== true;
  if (connectButton) {
    connectButton.disabled = state.onboardingBusy;
    connectButton.textContent = localizeUiText(state.onboardingBusy ? "Connecting…" : "Save & connect");
  }
  if (tunnelIdInput) tunnelIdInput.disabled = state.onboardingBusy;
  if (runtimeKeyInput) runtimeKeyInput.disabled = state.onboardingBusy;
  $("onboarding-reconnect").hidden = !state.onboardingBusy;

  const tunnelCopy = $("setup-tunnel-copy-value");
  if (tunnelCopy) tunnelCopy.textContent = onboarding.tunnelId || localizeUiText("Tunnel ID appears after step 2");
  const tunnelCopyButton = $("copy-setup-tunnel-id");
  if (tunnelCopyButton) tunnelCopyButton.disabled = !onboarding.tunnelId;

  if (onboarding.agentCommandReceived) {
    setBadge("setup-chatgpt-status", "Verified", "good");
  } else if (onboarding.connectedThroughTunnel) {
    setBadge("setup-chatgpt-status", "Configure in ChatGPT", "warn");
  } else {
    setBadge("setup-chatgpt-status", "Waiting for tunnel", "neutral");
  }

  if (!onboarding.browserConnected) {
    setBadge("setup-browser-status", "Not connected", "warn");
    setText("setup-browser-detail", "Install Equinox Browser in Your Browser and open the extension.");
  } else if (!onboarding.browserConsentAccepted) {
    setBadge("setup-browser-status", "Accept disclosure", "warn");
    setText("setup-browser-detail", "Equinox Browser is connected. Review and accept the browser-data disclosure in the extension.");
  } else if (!onboarding.browserControlEnabled) {
    setBadge("setup-browser-status", "Enable Browser Control", "warn");
    setText("setup-browser-detail", "Disclosure accepted. Turn Browser Control on to finish the required browser connection.");
  } else {
    setBadge("setup-browser-status", "Ready", "good");
    setText("setup-browser-detail", "Equinox Browser is connected, consented and Browser Control is on.");
  }

  const telegram = state.telegram || {};
  const telegramPairing = telegram.pairing || {};
  const telegramReady = telegram.configured === true && telegram.ready === true;
  const telegramForm = $("setup-telegram-form");
  const telegramPairingBox = $("setup-telegram-pairing");
  const telegramToken = $("setup-telegram-token");
  const telegramBotLink = $("setup-telegram-bot-link");
  const telegramConfirm = $("setup-telegram-confirm");
  if (telegramToken && document.activeElement !== telegramToken && !telegramToken.value) telegramToken.value = state.telegramBotToken;
  if (telegramReady) {
    setBadge("setup-telegram-status", "Ready", "good");
    if (telegramForm) telegramForm.hidden = true;
    if (telegramPairingBox) telegramPairingBox.hidden = false;
    setText("setup-telegram-detail", `Telegram is paired${telegram.userIdHint ? ` to private user ${telegram.userIdHint}` : ""}. You can manage it later in Services.`);
    if (telegramConfirm) telegramConfirm.hidden = true;
    $("setup-telegram-cancel").hidden = true;
  } else if (state.telegramSetupSkipped && !telegramPairing.active) {
    setBadge("setup-telegram-status", "Skipped", "neutral");
    if (telegramForm) telegramForm.hidden = true;
    if (telegramPairingBox) telegramPairingBox.hidden = false;
    setText("setup-telegram-detail", "Skipped for now. Telegram remains available later in Control Center → Services.");
    if (telegramConfirm) telegramConfirm.hidden = true;
    $("setup-telegram-cancel").hidden = true;
  } else if (telegramPairing.active) {
    setBadge("setup-telegram-status", telegramPairing.candidateFound ? "Confirm account" : "Pairing", "warn");
    if (telegramForm) telegramForm.hidden = true;
    if (telegramPairingBox) telegramPairingBox.hidden = false;
    setText("setup-telegram-detail", telegramPairing.candidateFound
      ? `Detected ${telegramPairing.candidateLabel || telegramPairing.userIdHint || "a private Telegram account"}. Confirm that this is you.`
      : `Pairing is active${telegramPairing.botUsername ? ` for @${telegramPairing.botUsername}` : ""}. Open the bot and send /start.`);
    if (telegramConfirm) telegramConfirm.hidden = !telegramPairing.candidateFound;
    $("setup-telegram-cancel").hidden = false;
  } else {
    setBadge("setup-telegram-status", "Recommended", "neutral");
    if (telegramForm) telegramForm.hidden = false;
    if (telegramPairingBox) telegramPairingBox.hidden = true;
  }
  if (telegramBotLink) {
    telegramBotLink.hidden = !telegramPairing.botUsername;
    if (telegramPairing.botUsername) telegramBotLink.href = `https://t.me/${telegramPairing.botUsername}`;
  }
  $("setup-telegram-start").disabled = state.integrationBusy || !state.telegramBotToken.trim();

  if (onboarding.agentCommandReceived) {
    setBadge("setup-verify-status", "Command received", "good");
    setText("setup-verify-detail", state.language === "tr"
      ? `İlk Equinox Local araç çağrısı ${formatDate(onboarding.firstAgentCommandAt)} tarihinde alındı.`
      : `First Equinox Local tool call received ${formatDate(onboarding.firstAgentCommandAt)}.`);
  } else {
    setBadge("setup-verify-status", "Waiting", "warn");
    setText("setup-verify-detail", "Waiting for the first Equinox Local tool call from ChatGPT. This is the final setup check.");
  }

  const browserReady = onboarding.browserConnected && onboarding.browserConsentAccepted && onboarding.browserControlEnabled;
  const almostReady = onboarding.connectedThroughTunnel && browserReady;
  setBadge("onboarding-badge", almostReady ? "Ready to verify" : "Setup in progress", almostReady ? "good" : "warn");
}

async function copySetupText(text, successMessage) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    showToast(successMessage);
  } catch (error) {
    showError(new Error(`Could not copy to clipboard: ${error instanceof Error ? error.message : String(error)}`));
  }
}

async function runDoctorRepair(incident, fix) {
  if (state.doctorRepairBusy || !incident?.incidentId || !fix?.id) return;
  const question = state.language === "tr"
    ? `“${localizeUiText(fix.label)}” düzeltmesi uygulansın mı?\n\n${fix.description}\n\nEquinox işlemden hemen önce teşhisi yeniden doğrulayacak ve sonrasında sonucu tekrar kontrol edecek.`
    : `Apply “${fix.label}”?\n\n${fix.description}\n\nEquinox will re-check the diagnosis immediately before the fixed recipe runs and verify the result afterwards.`;
  if (!window.confirm(question)) return;

  state.doctorRepairBusy = true;
  state.doctorRepairResult = null;
  renderDoctor();
  clearError();
  try {
    const response = await mutationJson("/api/v1/doctor/repair", "POST", {
      incidentId: incident.incidentId,
      recipeId: fix.id,
    });
    state.doctorRepairResult = response.result || null;
    const [doctor, repairs] = await Promise.all([
      requestJson("/api/v1/doctor").catch(() => ({ doctor: state.doctor })),
      requestJson("/api/v1/doctor/repairs").catch(() => ({ repairs: state.doctorRepairs })),
    ]);
    state.doctor = doctor.doctor || state.doctor;
    state.doctorRepairs = repairs.repairs || state.doctorRepairs;
    showToast(response.result?.verification?.resolved ? "Doctor fix verified." : "Doctor fix completed but the incident still needs attention.");
  } catch (error) {
    showError(error);
  } finally {
    state.doctorRepairBusy = false;
    renderDoctor();
  }
}

function renderDoctor() {
  const doctor = state.doctor || {};
  const checks = Array.isArray(doctor.checks) ? doctor.checks : [];
  const attention = doctor.summary?.attention ?? 0;
  const optional = doctor.summary?.optional ?? 0;
  const healthy = doctor.state === "HEALTHY" && attention === 0;

  setBadge("doctor-badge", healthy ? "Healthy" : "Needs attention", healthy ? "good" : "warn");
  setText("doctor-title", healthy ? "Your setup checks out" : "A few setup checks need attention");
  setText(
    "doctor-copy",
    healthy
      ? "Equinox Local checked the runtime, private configuration, update path, Equinox Browser and optional integrations without exposing local paths or secrets."
      : "Review the checks below. Optional items do not block core Equinox Local, but attention items should be fixed before public-style use.",
  );
  setText("doctor-summary", `${doctor.summary?.pass ?? 0} passed · ${attention} attention · ${optional} optional`);
  setText("doctor-checked-at", doctor.checkedAt ? `Checked ${formatDate(doctor.checkedAt)}` : "Not checked yet");

  const list = $("doctor-list");
  if (!list) return;
  list.replaceChildren();
  for (const item of checks) {
    const row = document.createElement("div");
    row.className = `doctor-check is-${item.status || "optional"}`;

    const indicator = document.createElement("span");
    indicator.className = "doctor-check-indicator";
    indicator.setAttribute("aria-hidden", "true");

    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = localizeUiText(item.label || "Check");
    const detail = document.createElement("small");
    detail.textContent = localizeDoctorDetail(item);
    copy.append(title, detail);

    const badge = document.createElement("span");
    setBadge(badge, item.status === "pass" ? "Ready" : item.status === "attention" ? "Attention" : "Optional", item.status === "pass" ? "good" : item.status === "attention" ? "warn" : "neutral");

    row.append(indicator, copy, badge);
    list.append(row);
  }

  const plan = state.doctorRepairs || {};
  const incidents = Array.isArray(plan.incidents) ? plan.incidents : [];
  const actionable = incidents.filter((incident) => Array.isArray(incident.fixes) && incident.fixes.length > 0 && ["ACTIVE", "ATTENTION REQUIRED"].includes(incident.state));
  setBadge("doctor-fix-summary", actionable.length > 0 ? "Safe fixes available" : "No fixes needed", actionable.length > 0 ? "warn" : "good");
  setText("doctor-fix-copy", actionable.length > 0
    ? `${actionable.length} diagnosed incident${actionable.length === 1 ? " has" : "s have"} a predefined bounded fix. Review exactly what will change before applying it.`
    : "No active repairable incidents were diagnosed.");

  const repairList = $("doctor-repair-list");
  if (repairList) {
    repairList.replaceChildren();
    for (const incident of actionable) {
      const card = document.createElement("article");
      card.className = "doctor-repair-card";

      const head = document.createElement("div");
      head.className = "doctor-repair-head";
      const headCopy = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = incident.title || incident.code || "Diagnosed issue";
      const meta = document.createElement("small");
      meta.textContent = `${incident.state || "ACTIVE"} · ${incident.component || "runtime"}${incident.projectId ? ` · ${incident.projectId}` : ""}`;
      headCopy.append(title, meta);
      const severity = document.createElement("span");
      setBadge(severity, incident.severity || "warn", ["error", "critical"].includes(incident.severity) ? "warn" : "neutral");
      head.append(headCopy, severity);

      const summary = document.createElement("p");
      summary.textContent = incident.summary || incident.recommendation || "Equinox diagnosed a repairable runtime issue.";
      card.append(head, summary);

      for (const fix of incident.fixes) {
        const action = document.createElement("div");
        action.className = "doctor-repair-action";
        const actionCopy = document.createElement("div");
        const label = document.createElement("strong");
        label.textContent = localizeUiText(fix.label || "Fix safely");
        const description = document.createElement("small");
        description.textContent = fix.description || "Predefined bounded repair recipe.";
        actionCopy.append(label, description);
        const button = document.createElement("button");
        button.type = "button";
        button.className = "button secondary compact";
        button.textContent = localizeUiText(state.doctorRepairBusy ? "Repair running…" : "Fix safely");
        button.disabled = state.doctorRepairBusy;
        button.addEventListener("click", () => { void runDoctorRepair(incident, fix); });
        action.append(actionCopy, button);
        card.append(action);
      }
      repairList.append(card);
    }
  }

  const resultBox = $("doctor-repair-result");
  if (resultBox) {
    const result = state.doctorRepairResult;
    resultBox.hidden = !result;
    resultBox.className = "doctor-repair-result";
    if (result) {
      const resolved = result.verification?.resolved === true;
      resultBox.classList.add(resolved ? "is-good" : "is-warn");
      const outcome = result.repair?.outcome || "UNKNOWN";
      const summary = result.repair?.summary || "Repair finished.";
      const verification = resolved ? "Verified: the diagnosed incident is resolved." : `Verification: ${result.verification?.incident?.state || "incident still requires attention"}.`;
      resultBox.textContent = `${outcome} · ${summary} ${verification}`;
    }
  }
}

function shortUpdateSha(value) {
  return typeof value === "string" && /^[a-f0-9]{40}$/u.test(value) ? value.slice(0, 7) : null;
}

function renderSidebarUpdateNotice(update, main, mainChannel) {
  const badge = $("sidebar-update-indicator");
  badge.hidden = true;
  badge.classList.remove("is-main", "is-warning");
  let label = null;
  if (mainChannel && main.state === "behind") label = "Update available";
  else if (mainChannel && main.state === "unavailable") {
    label = "Check unavailable";
    badge.classList.add("is-warning");
  } else if (!mainChannel && update.updateAvailable === true) label = "Update available";
  else if (!mainChannel && update.mainNotice?.targetSha) {
    label = "Main snapshot available";
    badge.classList.add("is-main");
  }
  if (label) {
    badge.hidden = false;
    setText("sidebar-update-indicator", label);
  }
}

function renderUpdate() {
  const update = state.update || {};
  const main = update.main || {};
  const mainChannel = ["source", "managed-source"].includes(update.installationKind) && main.checkSupported === true;
  const managedMain = update.installationKind === "managed-source";
  const checkButton = $("check-update-button");
  const installButton = $("install-update-button");
  const mainMeta = $("update-main-meta");
  const current = update.currentVersion || state.status?.server?.version || null;

  renderSidebarUpdateNotice(update, main, mainChannel);
  const runningVersion = state.status?.server?.version;
  const runningSha = shortUpdateSha(main.currentSha || state.status?.installation?.sourceSha);
  if (runningVersion) setText("sidebar-version", `${runningVersion}${mainChannel && runningSha ? ` - ${runningSha}` : ""}`);
  const mainNotice = $("update-stable-main-notice");
  mainNotice.hidden = mainChannel || !update.mainNotice?.targetSha;
  if (!mainNotice.hidden) {
    setText("update-stable-main-copy", state.language === "tr"
      ? `Onaylanmış Main ${shortUpdateSha(update.mainNotice.targetSha)} mevcut. Stable kanalı kendiliğinden değişmez.`
      : `Admitted Main ${shortUpdateSha(update.mainNotice.targetSha)} is available separately. Stable will not change channels automatically.`);
  }
  mainMeta.hidden = !mainChannel;
  if (mainChannel) {
    const currentSha = shortUpdateSha(main.currentSha);
    const targetSha = shortUpdateSha(main.targetSha);
    setText("update-version", current ? `Equinox Local ${current}` : "Current version unavailable");
    setText("update-checked-at", main.checkedAt ? `Checked ${formatDate(main.checkedAt)}` : "Not checked yet");
    setText("update-main-current", currentSha ? `Current SHA ${currentSha}` : "Current SHA —");
    setText("update-main-target", targetSha ? `Target SHA ${targetSha}` : "Target SHA —");
    const distance = Number.isInteger(main.behindBy) && Number.isInteger(main.aheadBy)
      ? `Distance ↓${main.behindBy} ↑${main.aheadBy}`
      : "Commit distance —";
    setText("update-main-distance", distance);
    const summaries = Array.isArray(main.summaries) ? main.summaries.slice(0, 5) : [];
    const summaryNode = $("update-main-summaries");
    summaryNode.hidden = summaries.length === 0;
    $("update-main-caption").hidden = summaries.length === 0;
    summaryNode.replaceChildren(...summaries.map((entry) => {
      const item = document.createElement("li");
      item.textContent = `${entry.shortSha || "???????"} · ${entry.message || "Commit"}`;
      return item;
    }));

    if (main.restartScheduledFor) {
      setText("update-title", `Restarting into Main ${shortUpdateSha(main.restartScheduledFor) || "snapshot"}`);
      setText("update-copy", "The admitted Main update is prepared. Control Center may disconnect briefly while the runtime switches, verifies health and rolls back automatically on failure.");
      setBadge("update-badge", "Restart scheduled", "warn");
    } else if (state.updateApplyBusy || main.applying) {
      setText("update-title", `Preparing Main ${targetSha || "snapshot"}`);
      setText("update-copy", "Preparing the exact admitted source/native transition before scheduling the managed runtime restart.");
      setBadge("update-badge", "Preparing", "warn");
    } else if (state.updateBusy) {
      setText("update-title", "Checking Main snapshot");
      setText("update-copy", "Reading local Git identity and checking the admitted Main snapshot without changing the checkout.");
      setBadge("update-badge", "Checking", "neutral");
    } else if (main.state === "behind") {
      setText("update-title", `${main.behindBy} ${main.behindBy === 1 ? "commit" : "commits"} available in Main snapshot`);
      setText("update-copy", managedMain
        ? "A newer admitted Main snapshot is available. Update & restart uses the transactional source/native handoff with health verification and automatic rollback."
        : "A newer admitted Main snapshot is available. This developer source checkout remains check-only.");
      setBadge("update-badge", "Main update available", "good");
    } else if (main.state === "up_to_date") {
      setText("update-title", "Main snapshot is up to date");
      setText("update-copy", "The current source SHA exactly matches the admitted Main snapshot.");
      setBadge("update-badge", "Up to date", "good");
    } else if (main.state === "ahead") {
      setText("update-title", "Local source is ahead of the admitted Main snapshot");
      setText("update-copy", "This checkout is ahead of the currently admitted Main snapshot. Automatic Main apply remains unavailable until an admitted snapshot catches up.");
      setBadge("update-badge", "Local ahead", "warn");
    } else if (main.state === "diverged") {
      setText("update-title", "Local source and admitted Main snapshot have diverged");
      setText("update-copy", "The histories have commits on both sides. Equinox Local will not treat this as an ordinary update path.");
      setBadge("update-badge", "Diverged", "bad");
    } else if (["dirty", "detached", "unsupported"].includes(main.state)) {
      setText("update-title", "Main update check is blocked");
      setText("update-copy", main.reason || "This source checkout is not eligible for canonical main tracking.");
      setBadge("update-badge", "Unsupported", "warn");
    } else if (main.state === "unavailable") {
      setText("update-title", "Main update check needs attention");
      setText("update-copy", main.lastError || main.reason || "The admitted Main Snapshot could not be checked. This is not an up-to-date result.");
      setBadge("update-badge", "Check unavailable", "bad");
    } else {
      setText("update-title", "Main snapshot channel ready");
      setText("update-copy", "Check the admitted Main snapshot without modifying this source checkout.");
      setBadge("update-badge", "Ready", "neutral");
    }

    const mainLocked = state.updateBusy || state.updateApplyBusy || Boolean(main.applying) || Boolean(main.restartScheduledFor);
    checkButton.disabled = mainLocked;
    checkButton.textContent = localizeUiText(state.updateBusy ? "Checking…" : "Check main");
    const canApplyMain = Boolean(managedMain && main.applyAvailable && !main.applyError && !main.restartScheduledFor);
    installButton.hidden = !managedMain || (!canApplyMain && !state.updateApplyBusy && !main.applying && !main.restartScheduledFor);
    installButton.disabled = mainLocked || !canApplyMain;
    installButton.textContent = localizeUiText(state.updateApplyBusy || main.applying ? "Preparing update…" : main.restartScheduledFor ? "Restarting…" : "Update & restart");
    return;
  }

  setText("update-version", current ? `Current version ${current}` : "Current version unavailable");
  setText("update-checked-at", update.checkedAt ? `Checked ${formatDate(update.checkedAt)}` : "Not checked yet");

  if (update.restartScheduledFor) {
    setText("update-title", `Restarting into Equinox Local ${update.restartScheduledFor}`);
    setText("update-copy", "The verified release is prepared. Control Center may disconnect briefly while the managed runtime restarts and verifies the new version; automatic rollback is used if health verification fails.");
    setBadge("update-badge", "Restart scheduled", "warn");
  } else if (state.updateApplyBusy || update.applying) {
    setText("update-title", `Preparing Equinox Local ${update.latestVersion || "update"}`);
    setText("update-copy", "Downloading the signed artifact, verifying its exact size and SHA-256 digest, then staging the release before any runtime switch occurs.");
    setBadge("update-badge", "Preparing", "warn");
  } else if (update.installationKind === "source") {
    setText("update-title", "Source checkout");
    setText("update-copy", "This source checkout is not eligible for canonical main discovery.");
    setBadge("update-badge", "Development", "neutral");
  } else if (!update.managedInstallation) {
    setText("update-title", "Managed updates unavailable");
    setText("update-copy", update.reason || "This installation is not eligible for managed self-update.");
    setBadge("update-badge", "Unavailable", "warn");
  } else if (!update.configured) {
    setText("update-title", "Update channel not provisioned");
    setText("update-copy", update.reason || "A trusted stable update signing key has not been provisioned in this build yet.");
    setBadge("update-badge", "Not configured", "warn");
  } else if (update.lastError) {
    setText("update-title", "Update check needs attention");
    setText("update-copy", update.lastError);
    setBadge("update-badge", "Check failed", "bad");
  } else if (update.updateAvailable === true) {
    setText("update-title", `Equinox Local ${update.latestVersion} is available`);
    setText("update-copy", "The signed stable release is verified. Update & restart prepares it in a separate release directory, switches atomically, verifies runtime health and rolls back automatically if activation fails.");
    setBadge("update-badge", "Update available", "good");
  } else if (update.updateAvailable === false) {
    setText("update-title", "Equinox Local is up to date");
    setText("update-copy", "The signed stable update channel reports no newer version.");
    setBadge("update-badge", "Up to date", "good");
  } else {
    setText("update-title", "Stable update channel ready");
    setText("update-copy", "Check the signed stable manifest when you want to look for a newer Equinox Local release.");
    setBadge("update-badge", "Ready", "neutral");
  }

  const updateLocked = state.updateBusy || state.updateApplyBusy || Boolean(update.applying) || Boolean(update.restartScheduledFor);
  checkButton.disabled = updateLocked || (!update.selfUpdateSupported && !update.managedInstallation);
  checkButton.textContent = localizeUiText(state.updateBusy ? "Checking…" : "Check for updates");

  const canApply = Boolean(
    update.selfUpdateSupported &&
    update.configured &&
    update.updateAvailable === true &&
    !update.lastError &&
    !update.restartScheduledFor
  );
  installButton.hidden = !canApply && !state.updateApplyBusy && !update.applying && !update.restartScheduledFor;
  installButton.disabled = updateLocked || !canApply;
  installButton.textContent = localizeUiText(state.updateApplyBusy || update.applying ? "Preparing update…" : update.restartScheduledFor ? "Restarting…" : "Update & restart");
}

function makeMiniBadge(text) {
  const badge = document.createElement("span");
  badge.className = "mini-badge";
  badge.textContent = localizeUiText(text);
  return badge;
}

function createRootRow(kind, id, definition) {
  const row = document.createElement("article");
  row.className = "project-row";

  const main = document.createElement("div");
  main.className = "project-main";

  const titleLine = document.createElement("div");
  titleLine.className = "project-title-line";
  const title = document.createElement("strong");
  title.textContent = definition.name;
  const idChip = document.createElement("span");
  idChip.className = "code-chip";
  idChip.textContent = id;
  titleLine.append(title, idChip);

  const root = document.createElement("p");
  root.className = "project-path";
  root.title = definition.root;
  root.textContent = definition.root;

  const badges = document.createElement("div");
  badges.className = "project-badges";
  if (kind === "project") {
    badges.append(makeMiniBadge("Project"));
    badges.append(makeMiniBadge(definition.worktrees === false ? "Managed worktrees off" : "Managed worktrees on"));
    if (state.config.defaultProject === id) badges.append(makeMiniBadge("Default"));
    if (state.config.runtime?.workspaceProject === id) badges.append(makeMiniBadge("Workspace"));
  } else {
    badges.append(makeMiniBadge("Read-only folder"));
    if (state.config.runtime?.downloadsRoot === id) badges.append(makeMiniBadge("Downloads root"));
  }
  main.append(titleLine, root, badges);

  const actions = document.createElement("div");
  actions.className = "project-actions";
  const edit = document.createElement("button");
  edit.className = "row-button";
  edit.type = "button";
  edit.textContent = localizeUiText("Edit");
  edit.addEventListener("click", () => openRootDialog({ mode: "edit", kind, id }));

  const remove = document.createElement("button");
  remove.className = "row-button danger";
  remove.type = "button";
  remove.textContent = localizeUiText("Remove");
  const locked = kind === "project"
    ? state.config.defaultProject === id || state.config.runtime?.workspaceProject === id
    : state.config.runtime?.downloadsRoot === id;
  remove.dataset.locked = locked ? "true" : "false";
  remove.disabled = locked || state.restartRequired;
  remove.title = localizeUiText(locked ? "Change the runtime routing first before removing this root." : "Remove from the draft configuration");
  remove.addEventListener("click", () => removeRoot(kind, id));

  edit.disabled = state.restartRequired;
  actions.append(edit, remove);
  row.append(main, actions);
  return row;
}

function populateSelect(select, entries, selectedId) {
  select.replaceChildren();
  for (const [id, definition] of entries) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = `${definition.name} (${id})`;
    option.selected = id === selectedId;
    select.append(option);
  }
}

function renderProjects() {
  if (!state.config) return;
  const projects = Object.entries(state.config.projects || {});
  const fileRoots = Object.entries(state.config.fileRoots || {});
  const list = $("project-list");
  list.replaceChildren();
  for (const [id, definition] of projects) list.append(createRootRow("project", id, definition));
  for (const [id, definition] of fileRoots) list.append(createRootRow("fileRoot", id, definition));

  const folderLabel = fileRoots.length === 1 ? "read-only folder" : "read-only folders";
  setText("root-count-label", `${projects.length} projects · ${fileRoots.length} ${folderLabel}`);
  populateSelect($("default-project-select"), projects, state.config.defaultProject);
  populateSelect($("workspace-project-select"), projects, state.config.runtime?.workspaceProject);
  populateSelect($("downloads-root-select"), fileRoots, state.config.runtime?.downloadsRoot);
  setText("control-center-address", `127.0.0.1:${state.config.controlCenter?.port ?? "—"}`);
  setConfigEditingEnabled(!state.restartRequired);
}

function renderPermissions() {
  const list = $("permissions-list");
  list.replaceChildren();
  if (!state.config) return;

  const access = state.config.agentAccess || {
    files: "selected",
    terminal: true,
    desktop: true,
    browser: true,
  };
  $("agent-files-access").value = access.files;
  $("agent-terminal-access").checked = access.terminal !== false;
  $("agent-desktop-access").checked = access.desktop !== false;
  $("agent-web-access").checked = access.browser !== false;
  const localExecution = access.terminal !== false;
  setBadge(
    "agent-access-badge",
    localExecution ? "Terminal-first" : "Restricted mode",
    localExecution ? "good" : "warn",
  );
  setBadge(
    "local-execution-badge",
    localExecution ? "Core · enabled" : "Disabled",
    localExecution ? "good" : "warn",
  );
  $("save-agent-access-button").disabled = !state.dirty || state.restartRequired;

  for (const [id, definition] of Object.entries(state.config.projects || {})) {
    const card = document.createElement("article");
    card.className = "permission-card";
    const meta = document.createElement("div");
    meta.className = "permission-meta";
    const title = document.createElement("h4");
    title.textContent = definition.name;
    const badge = makeMiniBadge(access.files === "full" ? "Structured shortcut" : "Structured scope");
    meta.append(title, badge);
    const copy = document.createElement("p");
    copy.textContent = localizeUiText(
      access.files === "full"
        ? "This project is a named shortcut for structured capabilities; those capabilities can also use other accessible paths."
        : "Root-aware structured capabilities stay contained to this configured root. Terminal is not constrained by this scope.",
    );
    const path = document.createElement("span");
    path.className = "permission-path";
    path.title = definition.root;
    path.textContent = `${id} · ${definition.root}`;
    card.append(meta, copy, path);
    list.append(card);
  }

  for (const [id, definition] of Object.entries(state.config.fileRoots || {})) {
    const card = document.createElement("article");
    card.className = "permission-card";
    const meta = document.createElement("div");
    meta.className = "permission-meta";
    const title = document.createElement("h4");
    title.textContent = definition.name;
    const badge = makeMiniBadge("Read only");
    meta.append(title, badge);
    const copy = document.createElement("p");
    copy.textContent = localizeUiText("This extra file root is intentionally read-only in V1 and cannot be promoted to writable from the Control Center.");
    const path = document.createElement("span");
    path.className = "permission-path";
    path.title = definition.root;
    path.textContent = `${id} · ${definition.root}`;
    card.append(meta, copy, path);
    list.append(card);
  }
}

function renderUninstall() {
  const card = $("uninstall-card");
  if (!card) return;
  const managed = state.doctor?.managed === true;
  card.hidden = !managed;
  if (!managed) return;

  const removeData = $("uninstall-remove-data");
  const confirmation = $("uninstall-confirmation");
  const button = $("uninstall-button");
  const status = $("uninstall-status");
  const destructive = Boolean(removeData?.checked);
  const confirmed = confirmation?.value === "UNINSTALL";

  setBadge(
    "uninstall-badge",
    state.uninstallScheduled ? "Stopping" : destructive ? "Deletes user data" : "Preserves user data",
    state.uninstallScheduled || destructive ? "warn" : "neutral",
  );
  setText(
    "uninstall-confirmation-help",
    destructive
      ? "The managed runtime, credentials, Equinox Workspace and saved Control Center configuration will all be permanently removed."
      : "The managed runtime and credentials will be removed; Equinox Workspace and saved Control Center configuration will remain for a future reinstall.",
  );

  if (removeData) removeData.disabled = state.uninstallBusy;
  if (confirmation) confirmation.disabled = state.uninstallBusy;
  if (button) {
    button.disabled = state.uninstallBusy || !confirmed;
    button.textContent = state.uninstallScheduled
      ? "Uninstall scheduled"
      : state.uninstallBusy
        ? "Scheduling uninstall…"
        : destructive
          ? "Uninstall & delete local data"
          : "Uninstall Equinox Local";
  }
  if (status) status.hidden = !state.uninstallScheduled;
}

function createIntegrationCard(titleText, description, statusText, tone, actions = []) {
  const card = document.createElement("article");
  card.className = "integration-card";
  const meta = document.createElement("div");
  meta.className = "integration-meta";
  const title = document.createElement("h4");
  title.textContent = localizeUiText(titleText);
  const badge = document.createElement("span");
  setBadge(badge, statusText, tone);
  meta.append(title, badge);
  const copy = document.createElement("p");
  copy.textContent = localizeUiText(description);
  card.append(meta, copy);

  if (actions.length > 0) {
    const actionRow = document.createElement("div");
    actionRow.className = "integration-actions";
    for (const action of actions) {
      const control = document.createElement(action.href ? "a" : "button");
      control.className = `button ${action.primary ? "primary" : "secondary"}`;
      control.textContent = localizeUiText(action.label);
      if (action.href) {
        control.href = action.href;
        control.target = "_blank";
        control.rel = "noopener noreferrer";
      } else {
        control.type = "button";
        control.disabled = Boolean(action.disabled) || state.integrationBusy;
        control.addEventListener("click", action.onClick);
      }
      actionRow.append(control);
    }
    card.append(actionRow);
  }
  return card;
}

function createTelegramIntegrationCard() {
  const telegram = state.telegram || {};
  const configured = Boolean(telegram.configured && telegram.ready);
  const needsAttention = Boolean(telegram.needsAttention);
  const pairing = telegram.pairing || {};
  const card = createIntegrationCard(
    "Telegram",
    configured
      ? `Bot is paired${telegram.userIdHint ? ` to private user ${telegram.userIdHint}` : ""}. Telegram remote control is ${telegram.remoteControl?.enabled === false ? "off" : "on"}; task replies, files/photos and inline controls are ${telegram.taskInbox?.running ? "active" : "starting"}. Agents can still send only to this account.`
      : needsAttention
        ? "Saved Telegram state needs attention. Disconnect and pair the bot again safely."
        : pairing.active
          ? pairing.candidateFound
            ? `Private account ${pairing.candidateLabel || pairing.userIdHint || "detected"} is waiting for your confirmation.`
            : `Pairing is active${pairing.botUsername ? ` for @${pairing.botUsername}` : ""}. Open the bot and send /start.`
          : "Pair a Telegram bot to one private account. No Telegram user ID is required.",
    configured ? "Ready" : needsAttention ? "Needs attention" : pairing.active ? "Pairing" : "Not connected",
    configured ? "good" : needsAttention ? "warn" : pairing.active ? "warn" : "neutral",
    configured
      ? [
          { label: "Send test", onClick: testTelegramConnection },
          { label: "Disconnect", onClick: disconnectTelegramConnection },
        ]
      : pairing.active
        ? pairing.candidateFound
          ? [
              { label: "Pair this account", primary: true, onClick: confirmTelegramPairingUi },
              { label: "Cancel pairing", onClick: cancelTelegramPairingUi },
            ]
          : [
              ...(pairing.botUsername ? [{ label: "Open your bot ↗", href: `https://t.me/${pairing.botUsername}` }] : []),
              { label: "Cancel pairing", onClick: cancelTelegramPairingUi },
            ]
        : [],
  );

  if (configured) {
    const remoteControl = telegram.remoteControl || { enabled: true };
    const toggle = document.createElement("label");
    toggle.className = "toggle-field";
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = localizeUiText("Telegram remote control");
    const help = document.createElement("small");
    help.textContent = localizeUiText("Allow the paired Telegram account to control Tasks, Chat Bridge and Local controls. Turning this off ignores and discards inbound Telegram commands/messages while outbound notifications remain available.");
    copy.append(title, help);
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = remoteControl.enabled !== false;
    checkbox.disabled = state.integrationBusy;
    checkbox.addEventListener("change", () => void updateTelegramRemoteControlUi(checkbox.checked));
    toggle.append(copy, checkbox);
    card.append(toggle);
  }

  const downloads = telegram.downloads || null;
  if (downloads?.path) {
    const downloadBox = document.createElement("div");
    downloadBox.className = "integration-form";
    const title = document.createElement("strong");
    title.textContent = localizeUiText("Download folder");
    const location = document.createElement("code");
    location.textContent = downloads.path;
    location.style.overflowWrap = "anywhere";
    const help = document.createElement("small");
    help.textContent = localizeUiText("Incoming Telegram photos and documents are saved here. Changing this affects only new files; existing task attachments stay where they are. Files in this user-visible folder are not auto-deleted.");
    const actions = document.createElement("div");
    actions.className = "integration-actions";
    const changeButton = document.createElement("button");
    changeButton.type = "button";
    changeButton.className = "button secondary";
    changeButton.textContent = localizeUiText("Change folder…");
    changeButton.disabled = state.integrationBusy || state.pickerBusy;
    changeButton.addEventListener("click", () => void changeTelegramDownloadFolder());
    const resetButton = document.createElement("button");
    resetButton.type = "button";
    resetButton.className = "button secondary";
    resetButton.textContent = localizeUiText("Reset to default");
    resetButton.disabled = state.integrationBusy || state.pickerBusy || downloads.isDefault === true;
    resetButton.addEventListener("click", () => void resetTelegramDownloadFolder());
    actions.append(changeButton, resetButton);
    downloadBox.append(title, location, help, actions);
    card.append(downloadBox);
  }

  if (!configured && !pairing.active) {
    const instructions = document.createElement("p");
    instructions.className = "integration-helper";
    instructions.textContent = localizeUiText("Create a bot with BotFather using /newbot, copy its HTTP API token, then start pairing here. You will confirm the detected private account before Equinox Local saves it.");
    card.append(instructions);

    const botFather = document.createElement("a");
    botFather.className = "button secondary";
    botFather.href = "https://t.me/BotFather";
    botFather.target = "_blank";
    botFather.rel = "noopener noreferrer";
    botFather.textContent = localizeUiText("Open BotFather ↗");
    card.append(botFather);

    const form = document.createElement("form");
    form.className = "integration-form";
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void startTelegramPairingUi();
    });
    const tokenLabel = document.createElement("label");
    tokenLabel.className = "field";
    const tokenTitle = document.createElement("span");
    tokenTitle.textContent = localizeUiText("Bot token");
    const tokenInput = document.createElement("input");
    tokenInput.type = "password";
    tokenInput.autocomplete = "off";
    tokenInput.spellcheck = false;
    tokenInput.placeholder = "123456789:AA…";
    tokenInput.value = state.telegramBotToken;
    tokenInput.disabled = state.integrationBusy;
    tokenInput.addEventListener("input", () => {
      state.telegramBotToken = tokenInput.value;
      button.disabled = state.integrationBusy || !state.telegramBotToken.trim();
    });
    const tokenHelp = document.createElement("small");
    tokenHelp.textContent = localizeUiText("The token stays only on this computer. Telegram user ID is discovered during pairing.");
    tokenLabel.append(tokenTitle, tokenInput, tokenHelp);
    const button = document.createElement("button");
    button.type = "submit";
    button.className = "button primary";
    button.textContent = localizeUiText(state.integrationBusy ? "Starting pairing…" : "Pair Telegram");
    button.disabled = state.integrationBusy || !state.telegramBotToken.trim();
    form.append(tokenLabel, button);
    card.append(form);
  }
  return card;
}

function httpProfileDraftFrom(profile = null) {
  if (!profile) {
    return {
      existing: false,
      id: "",
      label: "",
      origin: "https://",
      basePath: "/api",
      authType: "bearer",
      authHeader: "x-api-key",
      allowedMethods: ["GET"],
      allowedPathPrefixes: ["/"],
      allowedAgentHeaders: [],
      timeoutMs: 10_000,
    };
  }
  return {
    existing: true,
    id: profile.id,
    label: profile.label,
    origin: profile.origin,
    basePath: profile.basePath,
    authType: profile.authType,
    authHeader: profile.authType === "secret_header" ? profile.authHeader : "x-api-key",
    allowedMethods: [...(profile.allowedMethods || ["GET"])],
    allowedPathPrefixes: [...(profile.allowedPathPrefixes || ["/"])],
    allowedAgentHeaders: [...(profile.allowedAgentHeaders || [])],
    timeoutMs: profile.timeoutMs || 10_000,
  };
}

function setHttpProfileDraft(profile = null) {
  state.httpProfileDraft = profile === false ? null : httpProfileDraftFrom(profile);
  renderIntegrations();
}

function createHttpProfileField(labelText, control, helpText = "") {
  const label = document.createElement("label");
  label.className = "field";
  const title = document.createElement("span");
  title.textContent = localizeUiText(labelText);
  label.append(title, control);
  if (helpText) {
    const help = document.createElement("small");
    help.textContent = localizeUiText(helpText);
    label.append(help);
  }
  return label;
}

function createAuthenticatedHttpProfileForm() {
  const draft = state.httpProfileDraft;
  if (!draft) return null;
  const form = document.createElement("form");
  form.className = "integration-form http-profile-form";
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveHttpProfile(form);
  });

  const grid = document.createElement("div");
  grid.className = "http-profile-form-grid";

  const idInput = document.createElement("input");
  idInput.name = "id";
  idInput.type = "text";
  idInput.autocomplete = "off";
  idInput.spellcheck = false;
  idInput.value = draft.id;
  idInput.placeholder = "moltbook";
  idInput.readOnly = draft.existing;
  idInput.disabled = state.httpProfileBusy;
  grid.append(createHttpProfileField("Profile ID", idInput));

  const labelInput = document.createElement("input");
  labelInput.name = "label";
  labelInput.type = "text";
  labelInput.autocomplete = "off";
  labelInput.value = draft.label;
  labelInput.placeholder = "Moltbook";
  labelInput.disabled = state.httpProfileBusy;
  grid.append(createHttpProfileField("Display name", labelInput));

  const originInput = document.createElement("input");
  originInput.name = "origin";
  originInput.type = "url";
  originInput.autocomplete = "off";
  originInput.spellcheck = false;
  originInput.value = draft.origin;
  originInput.placeholder = "https://api.example.com";
  originInput.disabled = state.httpProfileBusy;
  grid.append(createHttpProfileField("HTTPS origin", originInput));

  const basePathInput = document.createElement("input");
  basePathInput.name = "basePath";
  basePathInput.type = "text";
  basePathInput.autocomplete = "off";
  basePathInput.spellcheck = false;
  basePathInput.value = draft.basePath;
  basePathInput.placeholder = "/api/v1";
  basePathInput.disabled = state.httpProfileBusy;
  grid.append(createHttpProfileField("Base path", basePathInput));

  const authSelect = document.createElement("select");
  authSelect.name = "authType";
  for (const [value, label] of [["bearer", "Bearer token"], ["secret_header", "Secret header"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = localizeUiText(label);
    option.selected = draft.authType === value;
    authSelect.append(option);
  }
  authSelect.disabled = state.httpProfileBusy;

  const headerInput = document.createElement("input");
  headerInput.name = "authHeader";
  headerInput.type = "text";
  headerInput.autocomplete = "off";
  headerInput.spellcheck = false;
  headerInput.value = draft.authHeader || "x-api-key";
  headerInput.placeholder = "x-api-key";
  headerInput.disabled = state.httpProfileBusy || draft.authType !== "secret_header";
  authSelect.addEventListener("change", () => {
    headerInput.disabled = state.httpProfileBusy || authSelect.value !== "secret_header";
  });
  grid.append(createHttpProfileField("Authentication", authSelect));
  grid.append(createHttpProfileField("Secret header name", headerInput));

  const paths = document.createElement("textarea");
  paths.name = "allowedPathPrefixes";
  paths.rows = 3;
  paths.spellcheck = false;
  paths.value = draft.allowedPathPrefixes.join("\n");
  paths.placeholder = "/posts\n/profile";
  paths.disabled = state.httpProfileBusy;
  grid.append(createHttpProfileField("Allowed path prefixes", paths));

  const headers = document.createElement("textarea");
  headers.name = "allowedAgentHeaders";
  headers.rows = 3;
  headers.spellcheck = false;
  headers.value = draft.allowedAgentHeaders.join("\n");
  headers.placeholder = "x-client-version";
  headers.disabled = state.httpProfileBusy;
  grid.append(createHttpProfileField("Allowed agent headers", headers));

  const timeoutInput = document.createElement("input");
  timeoutInput.name = "timeoutMs";
  timeoutInput.type = "number";
  timeoutInput.min = "1000";
  timeoutInput.max = "30000";
  timeoutInput.step = "1000";
  timeoutInput.value = String(draft.timeoutMs);
  timeoutInput.disabled = state.httpProfileBusy;
  grid.append(createHttpProfileField("Request timeout (ms)", timeoutInput));

  const credential = document.createElement("input");
  credential.name = "credential";
  credential.type = "password";
  credential.autocomplete = "new-password";
  credential.spellcheck = false;
  credential.placeholder = draft.existing ? "••••••••" : "";
  credential.disabled = state.httpProfileBusy;
  grid.append(createHttpProfileField(
    "Credential",
    credential,
    "Leave blank to keep the saved credential. Saved credentials are write-only and are never loaded back into this page.",
  ));

  const methods = document.createElement("fieldset");
  methods.className = "http-methods";
  methods.disabled = state.httpProfileBusy;
  const legend = document.createElement("legend");
  legend.textContent = localizeUiText("Allowed methods");
  methods.append(legend);
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.name = "allowedMethod";
    checkbox.value = method;
    checkbox.checked = draft.allowedMethods.includes(method);
    const text = document.createElement("span");
    text.textContent = method;
    label.append(checkbox, text);
    methods.append(label);
  }

  const actions = document.createElement("div");
  actions.className = "integration-actions";
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "button primary";
  save.textContent = localizeUiText("Save profile");
  save.disabled = state.httpProfileBusy;
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "button secondary";
  cancel.textContent = localizeUiText("Cancel");
  cancel.disabled = state.httpProfileBusy;
  cancel.addEventListener("click", () => setHttpProfileDraft(false));
  actions.append(save, cancel);

  form.append(grid, methods, actions);
  return form;
}


function createAuthenticatedHttpProfilesCard() {
  const data = state.httpProfiles || { agentProfileManagementEnabled: true, profiles: [] };
  const profiles = Array.isArray(data.profiles) ? data.profiles : [];
  const managementEnabled = data.agentProfileManagementEnabled !== false;
  const card = createIntegrationCard(
    "Authenticated HTTP profiles",
    "Keep API credentials on this computer while allowing agents to make bounded requests only to the HTTPS origins, methods and paths you approve.",
    managementEnabled ? "Agent management on" : "Agent management off",
    managementEnabled ? "good" : "neutral",
    [{ label: "Add profile", onClick: () => setHttpProfileDraft(null), primary: profiles.length === 0, disabled: state.httpProfileBusy }],
  );
  card.classList.add("http-profile-card", "integration-card-wide");

  const toggle = document.createElement("label");
  toggle.className = "toggle-field http-profile-management";
  const toggleCopy = document.createElement("div");
  const toggleTitle = document.createElement("strong");
  toggleTitle.textContent = localizeUiText("Allow agents to manage HTTP profiles");
  const toggleHelp = document.createElement("small");
  toggleHelp.textContent = localizeUiText("Agents may create, edit and delete profile structure. Credentials remain human-only and are never exposed to the agent.");
  toggleCopy.append(toggleTitle, toggleHelp);
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = managementEnabled;
  checkbox.disabled = state.httpProfileBusy;
  checkbox.addEventListener("change", () => {
    void updateHttpProfileManagement(checkbox.checked);
  });
  toggle.append(toggleCopy, checkbox);
  card.append(toggle);

  const profileList = document.createElement("div");
  profileList.className = "http-profile-list";
  if (profiles.length === 0) {
    const empty = document.createElement("p");
    empty.className = "http-profile-empty";
    empty.textContent = localizeUiText("No authenticated HTTP profiles are configured yet.");
    profileList.append(empty);
  } else {
    for (const profile of profiles) {
      const row = document.createElement("article");
      row.className = "http-profile-row";
      const heading = document.createElement("div");
      heading.className = "http-profile-heading";
      const title = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = profile.label;
      const id = document.createElement("code");
      id.textContent = profile.id;
      title.append(name, id);
      const badge = document.createElement("span");
      setBadge(badge, profile.ready ? "Ready" : "Needs credential", profile.ready ? "good" : "warn");
      heading.append(title, badge);

      const endpoint = document.createElement("code");
      endpoint.className = "http-profile-endpoint";
      endpoint.textContent = `${profile.origin}${profile.basePath === "/" ? "" : profile.basePath}`;

      const scope = document.createElement("p");
      const paths = (profile.allowedPathPrefixes || []).join(", ");
      scope.textContent = `${(profile.allowedMethods || []).join(" · ")} · ${paths || "/"}`;

      const actions = document.createElement("div");
      actions.className = "integration-actions";
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "button secondary";
      edit.textContent = localizeUiText("Edit");
      edit.disabled = state.httpProfileBusy;
      edit.addEventListener("click", () => setHttpProfileDraft(profile));

      const test = document.createElement("button");
      test.type = "button";
      test.className = "button secondary";
      test.textContent = localizeUiText("Test");
      test.disabled = state.httpProfileBusy || !profile.ready;
      test.addEventListener("click", () => void testHttpProfileConnection(profile));

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "button danger";
      remove.textContent = localizeUiText("Delete");
      remove.disabled = state.httpProfileBusy;
      remove.addEventListener("click", () => void deleteHttpProfileFromControlCenter(profile));

      actions.append(edit, test, remove);
      row.append(heading, endpoint, scope, actions);
      const lastTest = state.httpProfileTestResults[profile.id];
      if (lastTest) {
        const testResult = document.createElement("small");
        testResult.className = "http-profile-test-result";
        testResult.textContent = lastTest;
        row.append(testResult);
      }
      profileList.append(row);
    }
  }
  card.append(profileList);

  const form = createAuthenticatedHttpProfileForm();
  if (form) card.append(form);
  return card;
}


function createWebFileTransferCard() {
  const settings = state.webFileTransfer || {};
  const card = createIntegrationCard(
    "Web file transfer",
    "Files sent from ChatGPT to this computer are saved here by default. Explicit destinations still override this folder.",
    settings.path ? "Ready" : "Not available",
    settings.path ? "good" : "neutral",
  );
  if (!settings.path) return card;
  const box = document.createElement("div");
  box.className = "integration-form";
  const title = document.createElement("strong"); title.textContent = localizeUiText("Download folder");
  const location = document.createElement("code"); location.textContent = settings.path; location.style.overflowWrap = "anywhere";
  const actions = document.createElement("div"); actions.className = "integration-actions";
  const change = document.createElement("button"); change.type = "button"; change.className = "button secondary"; change.textContent = localizeUiText("Change folder…"); change.disabled = state.integrationBusy || state.pickerBusy; change.addEventListener("click", () => void changeWebImportFolder());
  const reset = document.createElement("button"); reset.type = "button"; reset.className = "button secondary"; reset.textContent = localizeUiText("Reset to default"); reset.disabled = state.integrationBusy || state.pickerBusy || settings.isDefault === true; reset.addEventListener("click", () => void resetWebImportFolder());
  actions.append(change, reset); box.append(title, location, actions); card.append(box); return card;
}

function renderIntegrations() {
  const list = $("integration-list");
  list.replaceChildren();
  const browser = state.status?.browser || {};
  const peekaboo = state.status?.peekaboo || {};
  const agentBrowser = browser.contexts?.agent || {};
  const userBrowser = browser.contexts?.user || {};
  const browserStatus = agentBrowser.ready
    ? agentBrowser.consentAccepted === false
      ? "Consent required"
      : (agentBrowser.controlEnabled === false ? "Automation off" : "Ready")
    : browser.agentBrowser?.pairing
      ? "Waiting for extension"
      : browser.agentBrowser?.setupComplete
        ? "Closed"
        : "Setup needed";
  const browserTone = agentBrowser.ready
    ? (agentBrowser.consentAccepted === false || agentBrowser.controlEnabled === false ? "warn" : "good")
    : browser.agentBrowser?.setupComplete ? "neutral" : "warn";
  const peekabooReady = peekaboo.ready === true || (peekaboo.ready === undefined && peekaboo.active === true);
  const peekabooStatus = peekaboo.needsAttention
    ? "Needs attention"
    : peekabooReady
      ? "Ready"
      : peekaboo.available === false
        ? "Not available"
        : "Not checked";
  const peekabooTone = peekaboo.needsAttention ? "warn" : peekabooReady ? "good" : "neutral";

  list.append(
    createIntegrationCard(
      "Equinox Browser",
      `Agent Browser ${agentBrowser.ready ? "ready" : browser.agentBrowser?.setupComplete ? "closed" : "not ready"} · Your Browser ${userBrowser.ready ? "connected" : "not connected"}. Both contexts use the same Chrome Web Store extension and Native Messaging bridge.`,
      browserStatus,
      browserTone,
      [
        { label: "Browser settings", onClick: () => switchSection("browser"), primary: !agentBrowser.ready },
        { label: "Chrome Web Store", href: EQUINOX_BROWSER_STORE_URL },
      ],
    ),
    createIntegrationCard(
      "Peekaboo desktop bridge",
      peekaboo.version
        ? `Optional macOS desktop capability · Peekaboo ${peekaboo.version}.`
        : "Optional macOS desktop capability. It is not required for Terminal, GitHub or Browser operations.",
      peekabooStatus,
      peekabooTone,
    ),
    createWebFileTransferCard(),
    createTelegramIntegrationCard(),
    createAuthenticatedHttpProfilesCard(),
  );
}

function browserContextStatus(target) {
  const browser = state.status?.browser || {};
  const contextual = browser.contexts?.[target];
  if (contextual && typeof contextual === "object") return contextual;
  if (target !== "user") return {};
  return {
    ready: Boolean(browser.ready),
    connectedAt: browser.connectedAt ?? null,
    extensionVersion: browser.extensionVersion ?? null,
    consentAccepted: browser.consentAccepted ?? null,
    controlEnabled: browser.controlEnabled ?? null,
    agentCursorEnabled: browser.agentCursorEnabled ?? null,
    agentCursorName: browser.agentCursorName ?? null,
  };
}

function browserSettingsFromStatus(target = state.browserSettingsTarget) {
  const browser = browserContextStatus(target);
  if (
    typeof browser.controlEnabled !== "boolean" ||
    typeof browser.agentCursorEnabled !== "boolean" ||
    typeof browser.agentCursorName !== "string"
  ) {
    return null;
  }
  return {
    context: target,
    enabled: browser.controlEnabled,
    agentCursorEnabled: browser.agentCursorEnabled,
    agentCursorName: browser.agentCursorName,
  };
}

function browserContextLabel(browser, { unavailableLabel = "Extension not connected" } = {}) {
  const consentRequired = browser.ready && browser.consentAccepted === false;
  const controlOff = browser.ready && !consentRequired && browser.controlEnabled === false;
  const label = consentRequired
    ? "Connected · consent required"
    : controlOff
      ? "Connected · automation off"
      : browser.ready
        ? "Ready"
        : unavailableLabel;
  const badge = browser.ready
    ? (consentRequired ? "Consent required" : controlOff ? "Automation off" : "Ready")
    : unavailableLabel;
  const tone = browser.ready ? (consentRequired || controlOff ? "warn" : "good") : "neutral";
  return { consentRequired, controlOff, label, badge, tone };
}

function renderBrowserPage() {
  const browser = state.status?.browser || {};
  const agent = browserContextStatus("agent");
  const user = browserContextStatus("user");
  const manager = browser.agentBrowser || {};
  const agentView = browserContextLabel(agent, {
    unavailableLabel: manager.pairing ? "Waiting for extension" : manager.setupComplete ? "Closed" : "Setup needed",
  });
  const userView = browserContextLabel(user, {
    unavailableLabel: browser.active ? "Extension not connected" : "Unavailable",
  });

  setText("agent-browser-page-status", agentView.label);
  setBadge("agent-browser-page-badge", agentView.badge, agentView.tone);
  setText("agent-browser-page-version", agent.extensionVersion || "—");
  setText("agent-browser-connected-at", formatDate(agent.connectedAt));
  setText(
    "agent-browser-control-state",
    agentView.consentRequired
      ? "Consent required"
      : typeof agent.controlEnabled === "boolean"
        ? (agent.controlEnabled ? "Allowed" : "Off")
        : "Unavailable",
  );
  const agentButton = $("open-agent-browser-button");
  agentButton.disabled = state.agentBrowserBusy || Boolean(agent.ready) || manager.supported === false;
  agentButton.textContent = localizeUiText(
    state.agentBrowserBusy ? "Opening…" : agent.ready ? "Agent Browser is open" : "Open Agent Browser",
  );
  setText(
    "agent-browser-note",
    agentView.consentRequired
      ? "Open the Equinox Browser popup in Agent Browser, review the data-use disclosure, and enable browser control there."
      : agent.ready && agent.controlEnabled === false
        ? "Equinox Browser is connected in Agent Browser, but browser automation is turned off in that profile."
        : agent.ready
          ? "Agent Browser is ready and is the default target for browser automation."
          : manager.pairing
            ? "Waiting for Equinox Browser to connect from the isolated Agent Browser profile."
            : manager.setupComplete
              ? "Agent Browser setup is complete and the isolated browser is currently closed. It will open automatically when an agent needs it."
              : "On first use, Agent Browser opens Chrome Web Store inside the isolated profile so Equinox Browser can be installed there.",
  );

  setText("browser-page-status", userView.label);
  setBadge("browser-page-badge", userView.badge, userView.tone);
  setText("browser-page-version", user.extensionVersion || "—");
  setText("browser-connected-at", formatDate(user.connectedAt));
  setText(
    "browser-control-state",
    userView.consentRequired
      ? "Consent required"
      : typeof user.controlEnabled === "boolean"
        ? (user.controlEnabled ? "Allowed" : "Off")
        : "Unavailable",
  );

  const selected = browserContextStatus(state.browserSettingsTarget);
  const selectedView = browserContextLabel(selected, { unavailableLabel: "Extension not connected" });
  const baseline = browserSettingsFromStatus(state.browserSettingsTarget);
  if (!state.browserSettingsDirty) state.browserDraft = baseline ? { ...baseline } : null;
  const available = Boolean(selected.ready && baseline && state.browserDraft);
  const disabled = !available || state.browserSettingsBusy;
  const targetSelect = $("browser-settings-target");
  const controlToggle = $("browser-control-toggle");
  const cursorToggle = $("browser-cursor-toggle");
  const nameInput = $("browser-agent-name");
  const applyButton = $("apply-browser-settings");

  targetSelect.value = state.browserSettingsTarget;
  targetSelect.disabled = state.browserSettingsBusy;
  controlToggle.disabled = disabled || selectedView.consentRequired;
  cursorToggle.disabled = disabled;
  nameInput.disabled = disabled;
  if (state.browserDraft) {
    controlToggle.checked = state.browserDraft.enabled;
    cursorToggle.checked = state.browserDraft.agentCursorEnabled;
    nameInput.value = state.browserDraft.agentCursorName;
  } else {
    controlToggle.checked = false;
    cursorToggle.checked = false;
    nameInput.value = "";
  }
  applyButton.disabled = disabled || !state.browserSettingsDirty;
  applyButton.textContent = localizeUiText(state.browserSettingsBusy ? "Applying…" : "Apply browser settings");
  setText(
    "browser-settings-note",
    selectedView.consentRequired
      ? "Open the Equinox Browser popup in the selected profile, review the data-use disclosure, and enable browser control there."
      : available
        ? "Settings apply immediately through Native Messaging and do not require an Equinox Local restart."
        : state.browserSettingsTarget === "agent"
          ? (manager.setupComplete
            ? "Open Agent Browser to manage settings for the already configured isolated profile."
            : "Open Agent Browser and install Equinox Browser in that isolated profile to manage its settings.")
          : "Connect Equinox Browser in Your Browser to manage its settings from Control Center.",
  );
}

function activityTone(event) {
  if (event?.severity === "critical" || event?.severity === "error") return "bad";
  if (event?.severity === "warn") return "warn";
  if (["healthy", "recovered", "completed"].includes(event?.status)) return "good";
  return "neutral";
}

function renderActivity() {
  const controlCenter = state.health?.controlCenter || {};
  setText("request-count", String(controlCenter.requestCount ?? 0));
  setText("mutation-count", String(controlCenter.mutationCount ?? 0));
  setText("activity-event-count", String(state.activity.length));

  const timeline = $("activity-timeline");
  timeline.replaceChildren();
  if (state.activity.length === 0) {
    const empty = document.createElement("div");
    empty.className = "activity-empty";
    empty.textContent = localizeUiText("No sanitized runtime events were recorded in the last six hours.");
    timeline.append(empty);
    return;
  }

  for (const event of state.activity) {
    const item = document.createElement("article");
    item.className = "activity-item";
    const marker = document.createElement("span");
    marker.className = `activity-marker is-${activityTone(event)}`;
    marker.setAttribute("aria-hidden", "true");
    const body = document.createElement("div");
    body.className = "activity-body";
    const heading = document.createElement("div");
    heading.className = "activity-heading";
    const title = document.createElement("strong");
    title.textContent = localizeRuntimeEventMessage(event.message || event.type || "Runtime event");
    const time = document.createElement("time");
    time.dateTime = event.timestamp || "";
    time.textContent = formatDate(event.timestamp);
    heading.append(title, time);
    const meta = document.createElement("div");
    meta.className = "activity-meta";
    meta.append(
      makeMiniBadge(event.component || "runtime"),
      makeMiniBadge(event.type || "event"),
      makeMiniBadge(event.status || event.severity || "info"),
    );
    body.append(heading, meta);
    item.append(marker, body);
    timeline.append(item);
  }
}

function formatTurnBudgetDuration(ms) {
  if (!Number.isFinite(ms)) return "—";
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function turnBudgetStageFor(elapsedMs, cutoffMinutes) {
  const cutoffMs = cutoffMinutes * 60_000;
  if (elapsedMs >= cutoffMs) return "overdue";
  if (elapsedMs >= Math.max(0, cutoffMs - 2 * 60_000)) return "finalize";
  if (elapsedMs >= Math.max(0, cutoffMs - 4 * 60_000)) return "checkpoint";
  return "running";
}

function renderTurnBudgetLive() {
  const budget = state.turnBudget || state.status?.turnBudget || null;
  if (!budget?.enabled) {
    setBadge("turn-budget-badge", "Off", "neutral");
    setText("turn-budget-elapsed", "—");
    setText("turn-budget-remaining", "—");
    setText("turn-budget-stage", "Disabled");
    setText("turn-budget-copy", "Turn Budget is disabled. Equinox Local will not add per-turn finalization guidance.");
    return;
  }
  const active = budget.active;
  if (!active) {
    setBadge("turn-budget-badge", `${budget.cutoffMinutes} min`, "good");
    setText("turn-budget-elapsed", "—");
    setText("turn-budget-remaining", "—");
    setText("turn-budget-stage", "Idle");
    setText("turn-budget-copy", "Waiting for the first Equinox Local call in an assistant turn.");
    return;
  }
  const startedAtMs = Date.parse(active.startedAt);
  const elapsedMs = Number.isFinite(startedAtMs) ? Math.max(0, Date.now() - startedAtMs) : Number(active.elapsedMs) || 0;
  const remainingMs = Math.max(0, budget.cutoffMinutes * 60_000 - elapsedMs);
  const stage = turnBudgetStageFor(elapsedMs, budget.cutoffMinutes);
  const presentation = {
    running: ["Running", "good"],
    checkpoint: ["Checkpoint soon", "warn"],
    finalize: ["Finalizing", "warn"],
    overdue: ["Cutoff reached", "bad"],
  }[stage];
  setBadge("turn-budget-badge", presentation[0], presentation[1]);
  setText("turn-budget-elapsed", formatTurnBudgetDuration(elapsedMs));
  setText("turn-budget-remaining", formatTurnBudgetDuration(remainingMs));
  setText("turn-budget-stage", presentation[0]);
  setText("turn-budget-copy", active.source === "browser"
    ? "Bound to the current ChatGPT assistant turn through Equinox Browser."
    : "Using first-Local-call fallback because browser turn identity is unavailable.");
}

function renderTurnBudget() {
  const draft = state.turnBudgetDraft || { enabled: true, cutoffMinutes: 22, fallbackResetMinutes: 5, autoContinueMaxHops: 10 };
  const enabled = $("turn-budget-enabled");
  const cutoff = $("turn-budget-cutoff");
  const fallbackReset = $("turn-budget-fallback-reset");
  const autoContinueMaxHops = $("auto-continue-max-hops");
  const save = $("save-turn-budget-button");
  if (enabled) enabled.checked = draft.enabled !== false;
  if (cutoff) {
    cutoff.value = String(draft.cutoffMinutes || 22);
    cutoff.disabled = draft.enabled === false || state.turnBudgetBusy;
  }
  if (fallbackReset) {
    fallbackReset.value = String(draft.fallbackResetMinutes || 5);
    fallbackReset.max = String(draft.cutoffMinutes || 22);
    fallbackReset.disabled = draft.enabled === false || state.turnBudgetBusy;
  }
  if (autoContinueMaxHops) {
    autoContinueMaxHops.value = String(draft.autoContinueMaxHops || 10);
    autoContinueMaxHops.disabled = state.turnBudgetBusy;
  }
  if (enabled) enabled.disabled = state.turnBudgetBusy;
  if (save) {
    save.disabled = state.turnBudgetBusy || !state.turnBudgetDirty;
    save.textContent = localizeUiText(state.turnBudgetBusy ? "Saving…" : "Save Turn Budget");
  }
  renderTurnBudgetLive();
}

function renderAgentControl() {
  const control = state.status?.agentControl || {};
  const paused = control.paused === true || control.state === "PAUSED";
  const activeWork = control.activeWork || {};
  $("agent-pause-banner").hidden = !paused;
  setBadge("agent-control-badge", paused ? "Paused" : "Active", paused ? "warn" : "good");
  setText(
    "agent-control-copy",
    paused
      ? "Agent mutations are paused. Read-only status remains available until you resume."
      : "Agent mutations are active. Emergency Stop is available from the top bar at any time.",
  );
  setText("active-terminal-count", String(activeWork.terminals ?? 0));
  setText("active-process-count", String(activeWork.processes ?? 0));
  setText("active-work-count", String(activeWork.total ?? 0));
  renderTurnBudget();

  const button = $("agent-control-button");
  if (!button) return;
  button.disabled = state.agentControlBusy || !state.status?.server?.pid;
  button.className = paused ? "button primary compact" : "button danger compact";
  button.textContent = localizeUiText(
    state.agentControlBusy
      ? (paused ? "Resuming agent…" : "Stopping agent…")
      : (paused ? "Resume agent" : "Emergency stop"),
  );
}

function renderRuntimeRestartControl() {
  const button = $("restart-runtime-button");
  if (!button) return;
  button.disabled = state.restartBusy || state.turnBudgetBusy || !state.status?.server?.pid;
  button.textContent = localizeUiText(state.restartBusy ? "Restarting…" : "Restart");
}

function taskStatusPresentation(status) {
  if (status === "active") return { label: "Active", tone: "good" };
  if (status === "completed") return { label: "Completed", tone: "neutral" };
  if (status === "cancelled") return { label: "Cancelled", tone: "bad" };
  return { label: String(status || "Unknown"), tone: "neutral" };
}

function continuationPresentation(continuation) {
  if (!continuation) return { label: "Not armed", tone: "neutral" };
  const map = {
    armed: ["Waiting", "warn"], delivering: ["Delivering", "warn"], delivered: ["Delivered", "good"],
    cancelled: ["Cancelled", "neutral"], expired: ["Expired", "neutral"], failed: ["Failed", "bad"],
  };
  const item = map[continuation.status] || [String(continuation.status || "Not armed"), "neutral"];
  return { label: item[0], tone: item[1] };
}

function taskTargetLabel(continuation) {
  const target = continuation?.target;
  if (!target) return localizeUiText("No browser target");
  const context = target.browserContext === "agent" ? "Agent Browser" : "Your Browser";
  return `${localizeUiText(context)} · ${String(target.title || "ChatGPT").slice(0, 72)}`;
}

function freshResumeReasonMessage(freshResume) {
  const reason = String(freshResume?.reason || "");
  if (freshResume?.status === "ambiguous") {
    if (reason.includes("runtime_restart")) return "Equinox restarted after browser mutation started, so the handoff could not be proven. It will not retry automatically.";
    if (reason.includes("emergency_stop")) return "Emergency Stop interrupted the handoff after browser mutation started. Equinox will not retry it automatically.";
    if (reason === "resume_guard_failed") return "A safety guard stopped the handoff after browser mutation started. Equinox will not retry it automatically.";
    if (reason.startsWith("browser_")) return "The browser handoff could not be confirmed. Equinox will not retry it automatically.";
    return "The fresh-chat handoff became uncertain after browser mutation started. Equinox will not retry it automatically.";
  }
  if (freshResume?.status === "cancelled") {
    if (reason === "emergency_stop") return "Emergency Stop cancelled the handoff before browser mutation. The saved checkpoint is still available.";
    if (reason === "checkpoint_changed") return "The task checkpoint changed, so the pending fresh-chat handoff was cancelled. The latest checkpoint is ready to continue.";
    return "The fresh-chat handoff was cancelled before browser mutation. The saved checkpoint is still available.";
  }
  return "";
}

function freshResumeRecoveryPresentation(freshResume) {
  if (!freshResume || freshResume.status === "confirmed") return null;
  if (freshResume.status === "prepared") return {
    label: "Waiting", tone: "warn", title: "Fresh-chat handoff is waiting",
    message: "Equinox will move this task after the current assistant turn finishes. You can cancel the handoff before browser mutation starts.",
    blocking: false, cancel: true, abandon: false,
  };
  if (freshResume.status === "creating") return {
    label: "In progress", tone: "warn", title: "Fresh-chat handoff is in progress",
    message: "Browser mutation has started. Equinox will not start another handoff while this transition is unresolved. Use Emergency Stop if you need to interrupt it.",
    blocking: true, cancel: false, abandon: false,
  };
  if (freshResume.status === "ambiguous") return {
    label: "Needs attention", tone: "bad", title: "Fresh-chat handoff needs attention",
    message: freshResumeReasonMessage(freshResume), blocking: true, cancel: false, abandon: true,
  };
  if (freshResume.status === "cancelled") return {
    label: "Recoverable", tone: "warn", title: "Fresh-chat handoff stopped",
    message: freshResumeReasonMessage(freshResume), blocking: false, cancel: false, abandon: false,
  };
  return null;
}

function taskLines(value) {
  return String(value || "").split(/\r?\n/u).map((item) => item.trim()).filter(Boolean);
}

function formatTaskReferences(references) {
  return (Array.isArray(references) ? references : []).map((item) => `${item.type} | ${item.label} | ${item.value}`).join("\n");
}

function parseTaskReferences(value) {
  const allowed = new Set(["project", "branch", "commit", "file", "url", "note"]);
  return taskLines(value).map((line, index) => {
    const parts = line.split("|");
    if (parts.length < 3) throw new Error(`Reference line ${index + 1} must use: type | label | value.`);
    const type = parts.shift().trim().toLowerCase();
    const label = parts.shift().trim();
    const referenceValue = parts.join("|").trim();
    if (!allowed.has(type) || !label || !referenceValue) throw new Error(`Reference line ${index + 1} is invalid.`);
    return { type, label, value: referenceValue };
  });
}

function replaceTaskInState(task) {
  const index = state.tasks.findIndex((item) => item.taskId === task.taskId);
  if (index >= 0) state.tasks[index] = clone(task);
  else state.tasks.unshift(clone(task));
  state.selectedTaskId = task.taskId;
  state.taskDraft = clone(task);
  state.taskDraftDirty = false;
}

function renderTasks() {
  const list = $("task-list");
  if (!list) return;
  list.replaceChildren();
  setText("task-count-label", `${state.tasks.length} tasks`);

  if (!state.tasks.length) {
    const empty = document.createElement("p");
    empty.className = "task-list-empty";
    empty.textContent = localizeUiText("No Task Capsules yet. Tasks appear here after an agent saves a checkpoint.");
    list.append(empty);
    state.selectedTaskId = null;
    state.taskDraft = null;
    state.taskDraftDirty = false;
  } else if (!state.selectedTaskId || !state.tasks.some((task) => task.taskId === state.selectedTaskId)) {
    state.selectedTaskId = state.tasks.find((task) => task.status === "active")?.taskId || state.tasks[0].taskId;
    state.taskDraft = clone(state.tasks.find((task) => task.taskId === state.selectedTaskId));
    state.taskDraftDirty = false;
  }

  for (const task of state.tasks) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `task-list-item${task.taskId === state.selectedTaskId ? " is-selected" : ""}`;
    button.dataset.taskId = task.taskId;
    button.disabled = state.taskBusy;
    button.setAttribute("aria-pressed", task.taskId === state.selectedTaskId ? "true" : "false");

    const title = document.createElement("span");
    title.className = "task-list-title";
    title.textContent = task.title;
    button.append(title);

    const taskId = document.createElement("code");
    taskId.className = "task-list-id";
    taskId.textContent = task.taskId;
    button.append(taskId);

    const meta = document.createElement("span");
    meta.className = "task-list-meta";
    const status = taskStatusPresentation(task.status);
    const statusBadge = document.createElement("span");
    statusBadge.className = `badge ${status.tone}`;
    statusBadge.textContent = localizeUiText(status.label);
    meta.append(statusBadge, document.createTextNode(`R${task.checkpointRevision} · ${formatDate(task.updatedAt)}`));
    button.append(meta);

    const continuation = continuationPresentation(task.continuation);
    const continuationLine = document.createElement("span");
    continuationLine.className = "task-list-continuation";
    const continuationBadge = document.createElement("span");
    continuationBadge.className = `badge ${continuation.tone}`;
    continuationBadge.textContent = localizeUiText(continuation.label);
    continuationLine.append(continuationBadge);
    if (task.continuation?.target) continuationLine.append(document.createTextNode(taskTargetLabel(task.continuation)));
    button.append(continuationLine);

    const recovery = freshResumeRecoveryPresentation(task.freshResume);
    if (recovery) {
      const recoveryLine = document.createElement("span");
      recoveryLine.className = "task-list-recovery";
      const recoveryBadge = document.createElement("span");
      recoveryBadge.className = `badge ${recovery.tone}`;
      recoveryBadge.textContent = localizeUiText(recovery.label);
      recoveryLine.append(recoveryBadge, document.createTextNode(localizeUiText(recovery.title)));
      button.append(recoveryLine);
    }
    list.append(button);
  }

  const task = state.taskDraft?.taskId === state.selectedTaskId ? state.taskDraft : null;
  $("task-detail-empty").hidden = Boolean(task);
  $("task-form").hidden = !task;
  if (!task) return;

  const status = taskStatusPresentation(task.status);
  const continuation = continuationPresentation(task.continuation);
  const recovery = freshResumeRecoveryPresentation(task.freshResume);
  setText("task-detail-title", task.title);
  setBadge("task-status-badge", status.label, status.tone);
  setText("task-detail-id", task.taskId);
  setText("task-detail-meta", `Checkpoint ${task.checkpointRevision} · Updated ${formatDate(task.updatedAt)}`);
  setText("task-continuation-state", continuation.label);
  setText("task-continuation-target", taskTargetLabel(task.continuation));

  const recoveryPanel = $("task-recovery-panel");
  recoveryPanel.hidden = !recovery;
  if (recovery) {
    setBadge("task-recovery-badge", recovery.label, recovery.tone);
    setText("task-recovery-title", recovery.title);
    setText("task-recovery-message", recovery.message);
    const reasonCode = String(task.freshResume?.reason || "");
    const code = $("task-recovery-code");
    code.hidden = !reasonCode;
    code.textContent = reasonCode ? `Reason: ${reasonCode}` : "";
    $("task-cancel-fresh-resume-button").hidden = !recovery.cancel;
    $("task-abandon-fresh-resume-button").hidden = !recovery.abandon;
  } else {
    $("task-cancel-fresh-resume-button").hidden = true;
    $("task-abandon-fresh-resume-button").hidden = true;
  }

  if (!state.taskDraftDirty) {
    $("task-title-input").value = task.title || "";
    $("task-objective-input").value = task.objective || "";
    $("task-completed-input").value = (task.completed || []).join("\n");
    $("task-next-input").value = (task.next || []).join("\n");
    $("task-references-input").value = formatTaskReferences(task.references);
  }

  const editable = task.status === "active" && !state.taskBusy && !recovery?.blocking;
  for (const id of ["task-title-input", "task-objective-input", "task-completed-input", "task-next-input", "task-references-input"]) $(id).disabled = !editable;
  $("task-save-button").disabled = !editable;
  $("task-complete-button").disabled = !editable;
  $("task-cancel-button").disabled = !editable;
  const deletable = task.status === "completed" || task.status === "cancelled";
  $("task-delete-button").hidden = !deletable;
  $("task-delete-button").disabled = state.taskBusy || !deletable;
  $("task-cancel-continuation-button").disabled = !editable || task.continuation?.status !== "armed";
  $("task-cancel-fresh-resume-button").disabled = state.taskBusy || task.status !== "active" || task.freshResume?.status !== "prepared";
  $("task-abandon-fresh-resume-button").disabled = state.taskBusy || task.status !== "active" || task.freshResume?.status !== "ambiguous";
  $("task-readonly-note").hidden = task.status === "active";
}

async function selectTask(taskId) {
  if (state.taskBusy || !/^task-[a-z0-9-]{6,80}$/u.test(String(taskId || ""))) return;
  state.taskBusy = true;
  state.taskDraftDirty = false;
  renderTasks();
  try {
    const result = await requestJson(`/api/v1/tasks/${encodeURIComponent(taskId)}`);
    replaceTaskInState(result.task);
    clearError();
  } catch (error) {
    showError(error);
  } finally {
    state.taskBusy = false;
    renderTasks();
  }
}

async function saveSelectedTask(event) {
  event.preventDefault();
  const task = state.taskDraft;
  if (!task || task.status !== "active" || state.taskBusy) return;
  let references;
  try { references = parseTaskReferences($("task-references-input").value); }
  catch (error) { showError(error); return; }
  const payload = {
    expectedRevision: task.checkpointRevision,
    title: $("task-title-input").value,
    objective: $("task-objective-input").value,
    completed: taskLines($("task-completed-input").value),
    next: taskLines($("task-next-input").value),
    references,
  };
  state.taskBusy = true;
  renderTasks();
  try {
    const result = await mutationJson(`/api/v1/tasks/${encodeURIComponent(task.taskId)}`, "PUT", payload);
    replaceTaskInState(result.task);
    showToast("Task changes saved.");
    clearError();
  } catch (error) { showError(error); }
  finally { state.taskBusy = false; renderTasks(); }
}

async function deleteSelectedTask() {
  const task = state.taskDraft;
  if (!task || task.status === "active" || state.taskBusy) return;
  if (!window.confirm(localizeUiText("Delete this task permanently? This cannot be undone."))) return;
  state.taskBusy = true;
  renderTasks();
  try {
    await mutationJson(`/api/v1/tasks/${encodeURIComponent(task.taskId)}/delete`, "POST", {});
    state.tasks = state.tasks.filter((item) => item.taskId !== task.taskId);
    state.selectedTaskId = null;
    state.taskDraft = null;
    state.taskDraftDirty = false;
    const refreshed = await requestJson("/api/v1/tasks").catch(() => null);
    if (refreshed?.tasks) state.tasks = clone(refreshed.tasks);
    showToast("Task deleted.");
    clearError();
  } catch (error) {
    showError(error);
  } finally {
    state.taskBusy = false;
    renderTasks();
  }
}

async function runTaskAction(action) {
  const task = state.taskDraft;
  if (!task || task.status !== "active" || state.taskBusy) return;
  if (action === "complete" && !window.confirm(localizeUiText("Mark this task complete?"))) return;
  if (action === "cancel" && !window.confirm(localizeUiText("Cancel this task?"))) return;
  if (action === "fresh-abandon" && !window.confirm(localizeUiText("Clear this blocked fresh-chat transition? This does not retry the browser action."))) return;
  const paths = {
    complete: "complete", cancel: "cancel", continuation: "continuation/cancel",
    "fresh-cancel": "fresh-resume/cancel", "fresh-abandon": "fresh-resume/abandon",
  };
  const messages = {
    complete: "Task marked complete.", cancel: "Task cancelled.", continuation: "Continuation cancelled.",
    "fresh-cancel": "Fresh-chat handoff cancelled.",
    "fresh-abandon": "Blocked transition cleared. Continue from the saved checkpoint in ChatGPT.",
  };
  if (!paths[action]) return;
  state.taskBusy = true;
  renderTasks();
  try {
    const result = await mutationJson(`/api/v1/tasks/${encodeURIComponent(task.taskId)}/${paths[action]}`, "POST", {});
    replaceTaskInState(result.task);
    showToast(messages[action]);
    clearError();
  } catch (error) { showError(error); }
  finally { state.taskBusy = false; renderTasks(); }
}

function renderAll() {
  renderDashboard();
  renderOnboarding();
  renderDoctor();
  renderUpdate();
  renderProjects();
  renderTasks();
  renderPermissions();
  renderUninstall();
  renderIntegrations();
  renderBrowserPage();
  renderActivity();
  renderAgentControl();
  renderRuntimeRestartControl();
}

function updateRestartState() {
  $("restart-banner").hidden = !state.restartRequired;
  $("refresh-button").disabled = state.restartRequired || state.restartBusy;
  setConfigEditingEnabled(!state.restartRequired);
  renderRuntimeRestartControl();
}

async function refreshAll() {
  if (state.restartRequired || state.refreshAllBusy) return;
  state.refreshAllBusy = true;
  clearError();
  $("refresh-button").disabled = true;
  try {
    const [health, status, config, activity, tasks, update, onboarding, doctor, doctorRepairs, peekaboo, telegram, webFileTransfer, httpProfiles] = await Promise.all([
      requestJson("/api/v1/health"),
      requestJson("/api/v1/status"),
      requestJson("/api/v1/config"),
      requestJson("/api/v1/activity").catch(() => ({ events: [] })),
      requestJson("/api/v1/tasks").catch(() => ({ tasks: [] })),
      requestJson("/api/v1/update"),
      requestJson("/api/v1/onboarding"),
      requestJson("/api/v1/doctor").catch(() => ({ doctor: null })),
      requestJson("/api/v1/doctor/repairs").catch(() => ({ repairs: null })),
      requestJson("/api/v1/integrations/peekaboo").catch(() => ({ peekaboo: null })),
      requestJson("/api/v1/integrations/telegram").catch(() => ({ telegram: null })),
      requestJson("/api/v1/files/import-settings").catch(() => ({ webFileTransfer: null })),
      requestJson("/api/v1/integrations/http-profiles").catch(() => ({ httpProfiles: null })),
    ]);
    state.health = health;
    state.status = status.status;
    state.turnBudget = status.status?.turnBudget || null;
    if (!state.turnBudgetDirty && state.turnBudget) {
      state.turnBudgetDraft = {
        enabled: state.turnBudget.enabled !== false,
        cutoffMinutes: Number(state.turnBudget.cutoffMinutes) || 22,
        fallbackResetMinutes: Number(state.turnBudget.fallbackResetMinutes) || 5,
        autoContinueMaxHops: Number(state.turnBudget.autoContinueMaxHops) || 10,
      };
    }
    state.config = clone(config.config);
    state.revision = config.revision;
    state.activity = Array.isArray(activity.events) ? activity.events : [];
    state.tasks = Array.isArray(tasks.tasks) ? tasks.tasks : [];
    if (!state.selectedTaskId || !state.tasks.some((task) => task.taskId === state.selectedTaskId)) {
      state.selectedTaskId = state.tasks.find((task) => task.status === "active")?.taskId || state.tasks[0]?.taskId || null;
      state.taskDraftDirty = false;
    }
    if (!state.taskDraftDirty) {
      state.taskDraft = state.selectedTaskId ? clone(state.tasks.find((task) => task.taskId === state.selectedTaskId)) : null;
    }
    state.update = update.update || null;
    state.onboarding = onboarding.onboarding || null;
    state.doctor = doctor.doctor || null;
    state.doctorRepairs = doctorRepairs.repairs || null;
    if (peekaboo.peekaboo) {
      state.status = {
        ...(state.status || {}),
        peekaboo: peekaboo.peekaboo,
      };
    }
    state.telegram = telegram.telegram || null;
    state.webFileTransfer = webFileTransfer.webFileTransfer || null;
    state.httpProfiles = httpProfiles.httpProfiles || null;
    if (!state.browserSettingsDirty) state.browserDraft = null;
    state.restartRequired = false;
    markClean();
    renderAll();
    document.body.classList.remove("control-loading");
    state.lastRefreshedAt = new Date();
    renderLastRefreshed();
  } catch (error) {
    showError(error);
  } finally {
    state.refreshAllBusy = false;
    $("refresh-button").disabled = state.restartRequired || state.restartBusy;
  }
}

function autoRefreshAllowed() {
  return !document.hidden && !state.restartRequired && !state.restartBusy && !state.refreshAllBusy;
}

function reconcileLiveTasks(nextTasks) {
  state.tasks = Array.isArray(nextTasks) ? clone(nextTasks) : [];
  if (!state.selectedTaskId || !state.tasks.some((task) => task.taskId === state.selectedTaskId)) {
    state.selectedTaskId = state.tasks.find((task) => task.status === "active")?.taskId || state.tasks[0]?.taskId || null;
    state.taskDraftDirty = false;
  }
  if (!state.taskDraftDirty && !state.taskBusy) {
    state.taskDraft = state.selectedTaskId ? clone(state.tasks.find((task) => task.taskId === state.selectedTaskId)) : null;
  }
}

async function refreshLiveState() {
  if (!autoRefreshAllowed() || state.autoRefreshLiveBusy || state.onboardingBusy) return;
  state.autoRefreshLiveBusy = true;
  try {
    const [health, status, activity, tasks, onboarding] = await Promise.all([
      requestJson("/api/v1/health", { backgroundRefresh: true }),
      requestJson("/api/v1/status", { backgroundRefresh: true }),
      requestJson("/api/v1/activity", { backgroundRefresh: true }).catch(() => null),
      requestJson("/api/v1/tasks", { backgroundRefresh: true }).catch(() => null),
      requestJson("/api/v1/onboarding", { backgroundRefresh: true }).catch(() => null),
    ]);
    state.health = health;
    const previousStatus = state.status || {};
    state.status = {
      ...previousStatus,
      ...status.status,
      peekaboo: {
        ...(previousStatus.peekaboo || {}),
        ...(status.status?.peekaboo || {}),
      },
    };
    state.turnBudget = status.status?.turnBudget || state.turnBudget;
    if (!state.turnBudgetDirty && state.turnBudget) {
      state.turnBudgetDraft = {
        enabled: state.turnBudget.enabled !== false,
        cutoffMinutes: Number(state.turnBudget.cutoffMinutes) || 22,
        fallbackResetMinutes: Number(state.turnBudget.fallbackResetMinutes) || 5,
        autoContinueMaxHops: Number(state.turnBudget.autoContinueMaxHops) || 10,
      };
    }
    if (activity?.events) state.activity = activity.events;
    if (tasks?.tasks) reconcileLiveTasks(tasks.tasks);
    if (onboarding?.onboarding) state.onboarding = onboarding.onboarding;
    renderDashboard();
    renderOnboarding();
    renderTasks();
    renderActivity();
    renderBrowserPage();
    renderAgentControl();
    renderRuntimeRestartControl();
    renderTurnBudget();
    state.lastRefreshedAt = new Date();
    renderLastRefreshed();
  } catch {
    // Automatic polling is best-effort. Manual Refresh remains the explicit error surface.
  } finally {
    state.autoRefreshLiveBusy = false;
  }
}

async function refreshMediumState() {
  if (!autoRefreshAllowed() || state.autoRefreshMediumBusy) return;
  state.autoRefreshMediumBusy = true;
  try {
    const [doctor, doctorRepairs, peekaboo, telegram, webFileTransfer, httpProfiles] = await Promise.all([
      requestJson("/api/v1/doctor", { backgroundRefresh: true }).catch(() => null),
      requestJson("/api/v1/doctor/repairs", { backgroundRefresh: true }).catch(() => null),
      requestJson("/api/v1/integrations/peekaboo", { backgroundRefresh: true }).catch(() => null),
      requestJson("/api/v1/integrations/telegram", { backgroundRefresh: true }).catch(() => null),
      requestJson("/api/v1/files/import-settings", { backgroundRefresh: true }).catch(() => null),
      state.httpProfileDraft ? Promise.resolve(null) : requestJson("/api/v1/integrations/http-profiles", { backgroundRefresh: true }).catch(() => null),
    ]);
    if (doctor?.doctor) state.doctor = doctor.doctor;
    if (doctorRepairs?.repairs) state.doctorRepairs = doctorRepairs.repairs;
    if (peekaboo?.peekaboo) {
      state.status = { ...(state.status || {}), peekaboo: peekaboo.peekaboo };
    }
    if (telegram?.telegram) state.telegram = telegram.telegram;
    if (webFileTransfer?.webFileTransfer) state.webFileTransfer = webFileTransfer.webFileTransfer;
    if (httpProfiles?.httpProfiles && !state.httpProfileDraft) state.httpProfiles = httpProfiles.httpProfiles;
    renderDoctor();
    if (!state.httpProfileDraft) renderIntegrations();
    renderBrowserPage();
    renderDashboard();
  } catch {
    // Best-effort background refresh; do not interrupt the user for transient failures.
  } finally {
    state.autoRefreshMediumBusy = false;
  }
}

async function refreshSlowState() {
  if (!autoRefreshAllowed() || state.autoRefreshSlowBusy) return;
  state.autoRefreshSlowBusy = true;
  try {
    const [config, update] = await Promise.all([
      state.dirty || state.dialogMode ? Promise.resolve(null) : requestJson("/api/v1/config", { backgroundRefresh: true }).catch(() => null),
      state.updateBusy || state.updateApplyBusy ? Promise.resolve(null) : requestJson("/api/v1/update", { backgroundRefresh: true }).catch(() => null),
    ]);
    if (config?.config && !state.dirty && !state.dialogMode) {
      state.config = clone(config.config);
      state.revision = config.revision;
      renderProjects();
      renderPermissions();
    }
    if (update?.update && !state.updateBusy && !state.updateApplyBusy) {
      state.update = update.update;
      renderUpdate();
    }
  } catch {
    // Best-effort background refresh; manual Refresh can surface persistent errors.
  } finally {
    state.autoRefreshSlowBusy = false;
  }
}

function refreshVisibleControlCenter() {
  if (document.hidden) return;
  const now = Date.now();
  if (now - state.lastAutoRefreshAt < AUTO_REFRESH_FOCUS_DEBOUNCE_MS) return;
  state.lastAutoRefreshAt = now;
  void refreshLiveState();
  void refreshMediumState();
}

function validateRootForm({ id, name, root }) {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(id)) {
    return "Identifier must use lowercase letters, numbers, dots, underscores or hyphens.";
  }
  if (!name.trim() || name.trim().length > 100) return "Display name must be 1-100 characters.";
  if (!isAbsoluteLocalFolderPath(root)) return "Folder path must be an absolute non-root local path.";
  if (root.length > 1024) return "Folder path is too long.";
  return null;
}

function openRootDialog({ mode, kind, id = null }) {
  if (!state.config || state.restartRequired) return;
  state.dialogMode = mode;
  state.dialogKind = kind;
  state.editingId = id;
  const isProject = kind === "project";
  const isEdit = mode === "edit";
  const definition = isEdit
    ? (isProject ? state.config.projects[id] : state.config.fileRoots[id])
    : null;

  $("root-kind").value = kind;
  $("root-id").value = id || "";
  $("root-id").disabled = isEdit;
  $("root-name").value = definition?.name || "";
  $("root-path").value = definition?.root || "";
  $("root-worktrees").checked = definition?.worktrees !== false;
  $("worktrees-field").hidden = !isProject;
  $("readonly-note").hidden = isProject;
  $("dialog-error").hidden = true;
  setText("dialog-kicker", isProject ? "Project" : "Read-only folder");
  setText("dialog-title", `${isEdit ? "Edit" : "Add"} ${isProject ? "project" : "read-only folder"}`);
  $("root-dialog").showModal();
  setTimeout(() => (isEdit ? $("root-name") : $("root-id")).focus(), 0);
}

function closeRootDialog() {
  $("root-dialog").close();
  state.dialogMode = null;
  state.editingId = null;
}

function removeRoot(kind, id) {
  if (!state.config || state.restartRequired) return;
  const definition = kind === "project" ? state.config.projects[id] : state.config.fileRoots[id];
  if (!definition) return;
  const confirmed = window.confirm(state.language === "tr"
    ? `“${definition.name}” taslak yapılandırmadan kaldırılsın mı? Diskten hiçbir şey silinmez.`
    : `Remove “${definition.name}” from the draft configuration? Nothing is deleted from disk.`);
  if (!confirmed) return;
  if (kind === "project") delete state.config.projects[id];
  else delete state.config.fileRoots[id];
  markDirty();
  renderAll();
}

function applyRootForm(event) {
  event.preventDefault();
  if (!state.config || state.restartRequired) return;
  const kind = state.dialogKind;
  const id = (state.editingId || $("root-id").value).trim();
  const name = $("root-name").value.trim();
  const root = $("root-path").value.trim();
  const error = validateRootForm({ id, name, root });
  if (error) {
    setText("dialog-error", error);
    $("dialog-error").hidden = false;
    return;
  }

  if (state.dialogMode === "add") {
    if (Object.hasOwn(state.config.projects, id) || Object.hasOwn(state.config.fileRoots, id)) {
      setText("dialog-error", "That identifier is already in use by another configured root.");
      $("dialog-error").hidden = false;
      return;
    }
  }

  const duplicate = [
    ...Object.entries(state.config.projects || {}),
    ...Object.entries(state.config.fileRoots || {}),
  ].some(([otherId, definition]) => otherId !== id && definition.root === root);
  if (duplicate) {
    setText("dialog-error", "That folder path is already configured under another root.");
    $("dialog-error").hidden = false;
    return;
  }

  if (kind === "project") {
    state.config.projects[id] = {
      name,
      root,
      worktrees: $("root-worktrees").checked,
    };
  } else {
    state.config.fileRoots[id] = {
      name,
      root,
      access: "read-only",
    };
  }
  markDirty();
  renderAll();
  closeRootDialog();
  showToast("Draft updated. Save when you are ready.");
}

async function chooseFolderForDialog() {
  if (state.pickerBusy || state.restartRequired) return;
  const button = $("choose-folder-button");
  state.pickerBusy = true;
  button.disabled = true;
  button.textContent = localizeUiText("Choosing…");
  $("dialog-error").hidden = true;
  try {
    const result = await pickLocalFolder();
    if (result.cancelled) {
      showToast("Folder selection cancelled.");
      return;
    }
    if (isAbsoluteLocalFolderPath(result.path)) {
      $("root-path").value = result.path;
      $("root-path").focus();
    }
  } catch (error) {
    setText("dialog-error", error instanceof Error ? error.message : String(error));
    $("dialog-error").hidden = false;
  } finally {
    state.pickerBusy = false;
    button.disabled = false;
    button.textContent = localizeUiText("Choose folder…");
  }
}

function selectBrowserSettingsTarget(value) {
  if (state.browserSettingsBusy || !["agent", "user"].includes(value)) return;
  state.browserSettingsTarget = value;
  state.browserDraft = null;
  state.browserSettingsDirty = false;
  renderBrowserPage();
}

function updateBrowserDraftFromInputs() {
  const baseline = browserSettingsFromStatus(state.browserSettingsTarget);
  if (!baseline || state.browserSettingsBusy) return;
  state.browserDraft = {
    context: state.browserSettingsTarget,
    enabled: $("browser-control-toggle").checked,
    agentCursorEnabled: $("browser-cursor-toggle").checked,
    agentCursorName: $("browser-agent-name").value.slice(0, 32),
  };
  state.browserSettingsDirty =
    state.browserDraft.enabled !== baseline.enabled ||
    state.browserDraft.agentCursorEnabled !== baseline.agentCursorEnabled ||
    state.browserDraft.agentCursorName !== baseline.agentCursorName;
  renderBrowserPage();
}

async function openAgentBrowserFromControlCenter() {
  if (state.agentBrowserBusy) return;
  clearError();
  state.agentBrowserBusy = true;
  renderBrowserPage();
  try {
    const result = await mutationJson("/api/v1/browser/agent/open", "POST", {});
    state.status = state.status || {};
    state.status.browser = {
      ...(state.status.browser || {}),
      agentBrowser: result.agentBrowser || state.status.browser?.agentBrowser || null,
    };
    if (state.health?.controlCenter) state.health.controlCenter.mutationCount += 1;
    showToast("Agent Browser opened.");
    setTimeout(() => void refreshAll(), 900);
  } catch (error) {
    showError(error);
  } finally {
    state.agentBrowserBusy = false;
    renderBrowserPage();
    renderIntegrations();
  }
}

async function saveBrowserSettings() {
  if (!state.browserDraft || !state.browserSettingsDirty || state.browserSettingsBusy) return;
  clearError();
  state.browserSettingsBusy = true;
  renderBrowserPage();
  try {
    const target = state.browserDraft.context;
    const result = await mutationJson("/api/v1/browser/settings", "PUT", state.browserDraft);
    const settings = result.settings || {};
    const browser = state.status?.browser || {};
    const previousContext = browser.contexts?.[target] || {};
    const updatedContext = {
      ...previousContext,
      ready: true,
      controlEnabled: typeof settings.enabled === "boolean" ? settings.enabled : state.browserDraft.enabled,
      agentCursorEnabled: typeof settings.agentCursorEnabled === "boolean" ? settings.agentCursorEnabled : state.browserDraft.agentCursorEnabled,
      agentCursorName: typeof settings.agentCursorName === "string" ? settings.agentCursorName : state.browserDraft.agentCursorName,
    };
    state.status.browser = {
      ...browser,
      contexts: {
        ...(browser.contexts || {}),
        [target]: updatedContext,
      },
    };
    if (target === "user") {
      state.status.browser = {
        ...state.status.browser,
        controlEnabled: updatedContext.controlEnabled,
        agentCursorEnabled: updatedContext.agentCursorEnabled,
        agentCursorName: updatedContext.agentCursorName,
        nativeHostConnected: Boolean(settings.nativeHostConnected ?? browser.nativeHostConnected),
        localConnected: Boolean(settings.localConnected ?? browser.localConnected),
      };
    }
    state.browserDraft = browserSettingsFromStatus(target);
    state.browserSettingsDirty = false;
    if (state.health?.controlCenter) state.health.controlCenter.mutationCount += 1;
    renderDashboard();
    renderBrowserPage();
    renderIntegrations();
    renderActivity();
    showToast("Browser settings updated.");
  } catch (error) {
    showError(error);
  } finally {
    state.browserSettingsBusy = false;
    renderBrowserPage();
  }
}

async function startTelegramPairingUi() {
  if (state.integrationBusy || !state.telegramBotToken.trim()) return;
  clearError();
  state.integrationBusy = true;
  renderIntegrations();
  renderOnboarding();
  try {
    const result = await mutationJson("/api/v1/integrations/telegram/pair/start", "POST", {
      botToken: state.telegramBotToken.trim(),
    });
    state.telegram = { ...(state.telegram || {}), configured: false, ready: false, needsAttention: false, pairing: result.pairing };
    state.telegramBotToken = "";
    if ($("setup-telegram-token")) $("setup-telegram-token").value = "";
    state.telegramSetupSkipped = false;
    if (state.health?.controlCenter) state.health.controlCenter.mutationCount += 1;
    showToast("Telegram pairing started. Send /start to your bot.");
  } catch (error) {
    showError(error);
  } finally {
    state.integrationBusy = false;
    renderIntegrations();
    renderOnboarding();
  }
}

async function refreshTelegramPairing() {
  const pairing = state.telegram?.pairing;
  if (document.hidden || state.telegramPairingPollBusy || !pairing?.active || pairing.candidateFound) return;
  state.telegramPairingPollBusy = true;
  try {
    const result = await requestJson("/api/v1/integrations/telegram/pair", { backgroundRefresh: true });
    state.telegram = { ...(state.telegram || {}), pairing: result.pairing };
    renderIntegrations();
    renderOnboarding();
  } catch {
    // Pairing polling is best-effort; explicit actions remain the error surface.
  } finally {
    state.telegramPairingPollBusy = false;
  }
}

async function confirmTelegramPairingUi() {
  if (state.integrationBusy || !state.telegram?.pairing?.candidateFound) return;
  clearError();
  state.integrationBusy = true;
  renderIntegrations();
  renderOnboarding();
  try {
    const result = await mutationJson("/api/v1/integrations/telegram/pair/confirm", "POST", {});
    state.telegram = { ...(result.telegram || {}), pairing: { active: false, candidateFound: false }, pendingInboundCount: 0 };
    state.telegramSetupSkipped = false;
    if (state.health?.controlCenter) state.health.controlCenter.mutationCount += 1;
    showToast("Telegram paired successfully.");
  } catch (error) {
    showError(error);
  } finally {
    state.integrationBusy = false;
    renderIntegrations();
    renderOnboarding();
  }
}

async function cancelTelegramPairingUi() {
  if (state.integrationBusy) return;
  clearError();
  state.integrationBusy = true;
  try {
    await mutationJson("/api/v1/integrations/telegram/pair/cancel", "POST", {});
    state.telegram = { ...(state.telegram || {}), configured: false, ready: false, needsAttention: false, pairing: { active: false, candidateFound: false } };
    if (state.health?.controlCenter) state.health.controlCenter.mutationCount += 1;
    showToast("Telegram pairing cancelled.");
  } catch (error) {
    showError(error);
  } finally {
    state.integrationBusy = false;
    renderIntegrations();
    renderOnboarding();
  }
}

async function changeWebImportFolder() {
  if (state.integrationBusy || state.pickerBusy) return;
  clearError(); state.integrationBusy = true; state.pickerBusy = true; renderIntegrations();
  try {
    const picked = await pickLocalFolder();
    if (picked.cancelled) return showToast("Folder selection cancelled.");
    const result = await mutationJson("/api/v1/files/import-settings", "PUT", { path: picked.path });
    state.webFileTransfer = result.webFileTransfer;
    if (state.health?.controlCenter) state.health.controlCenter.mutationCount += 1;
    showToast("Web file transfer folder updated.");
  } catch (error) { showError(error); } finally { state.pickerBusy = false; state.integrationBusy = false; renderIntegrations(); }
}

async function resetWebImportFolder() {
  if (state.integrationBusy || state.pickerBusy || state.webFileTransfer?.isDefault) return;
  clearError(); state.integrationBusy = true; renderIntegrations();
  try {
    const result = await mutationJson("/api/v1/files/import-settings", "PUT", { path: null });
    state.webFileTransfer = result.webFileTransfer;
    if (state.health?.controlCenter) state.health.controlCenter.mutationCount += 1;
    showToast("Web file transfer folder reset to default.");
  } catch (error) { showError(error); } finally { state.integrationBusy = false; renderIntegrations(); }
}

async function changeTelegramDownloadFolder() {
  if (state.integrationBusy || state.pickerBusy) return;
  clearError();
  state.pickerBusy = true;
  state.integrationBusy = true;
  renderIntegrations();
  try {
    const picked = await pickLocalFolder();
    if (picked.cancelled) return showToast("Folder selection cancelled.");
    if (!isAbsoluteLocalFolderPath(picked.path)) throw new Error("Folder picker returned an invalid path.");
    const result = await mutationJson("/api/v1/integrations/telegram/downloads", "PUT", { path: picked.path });
    state.telegram = { ...(state.telegram || {}), downloads: result.downloads };
    if (state.health?.controlCenter) state.health.controlCenter.mutationCount += 1;
    showToast("Telegram download folder updated.");
  } catch (error) {
    showError(error);
  } finally {
    state.pickerBusy = false;
    state.integrationBusy = false;
    renderIntegrations();
  }
}

async function resetTelegramDownloadFolder() {
  if (state.integrationBusy || state.pickerBusy || state.telegram?.downloads?.isDefault) return;
  clearError();
  state.integrationBusy = true;
  renderIntegrations();
  try {
    const result = await mutationJson("/api/v1/integrations/telegram/downloads", "PUT", { path: null });
    state.telegram = { ...(state.telegram || {}), downloads: result.downloads };
    if (state.health?.controlCenter) state.health.controlCenter.mutationCount += 1;
    showToast("Telegram download folder reset to default.");
  } catch (error) {
    showError(error);
  } finally {
    state.integrationBusy = false;
    renderIntegrations();
  }
}

async function updateTelegramRemoteControlUi(enabled) {
  if (state.integrationBusy) return;
  clearError();
  state.integrationBusy = true;
  renderIntegrations();
  try {
    const result = await mutationJson("/api/v1/integrations/telegram/remote-control", "PUT", { enabled: Boolean(enabled) });
    state.telegram = { ...(state.telegram || {}), remoteControl: result.remoteControl };
    if (state.health?.controlCenter) state.health.controlCenter.mutationCount += 1;
    showToast(enabled ? "Telegram remote control enabled." : "Telegram remote control disabled.");
  } catch (error) {
    showError(error);
  } finally {
    state.integrationBusy = false;
    renderIntegrations();
  }
}

async function testTelegramConnection() {
  if (state.integrationBusy) return;
  clearError();
  state.integrationBusy = true;
  renderIntegrations();
  try {
    await mutationJson("/api/v1/integrations/telegram/test", "POST", {});
    if (state.health?.controlCenter) state.health.controlCenter.mutationCount += 1;
    showToast("Telegram test message sent.");
  } catch (error) {
    showError(error);
  } finally {
    state.integrationBusy = false;
    renderIntegrations();
  }
}

async function disconnectTelegramConnection() {
  if (state.integrationBusy) return;
  clearError();
  state.integrationBusy = true;
  renderIntegrations();
  try {
    await mutationJson("/api/v1/integrations/telegram/disconnect", "POST", {});
    state.telegram = { configured: false, ready: false, needsAttention: false, userIdHint: null, pairing: { active: false, candidateFound: false }, pendingInboundCount: 0 };
    if (state.health?.controlCenter) state.health.controlCenter.mutationCount += 1;
    showToast("Telegram disconnected.");
  } catch (error) {
    showError(error);
  } finally {
    state.integrationBusy = false;
    renderIntegrations();
  }
}

async function refreshHttpProfiles() {
  const result = await requestJson("/api/v1/integrations/http-profiles");
  state.httpProfiles = result.httpProfiles || { agentProfileManagementEnabled: true, profiles: [] };
  return state.httpProfiles;
}

async function updateHttpProfileManagement(enabled) {
  if (state.httpProfileBusy) return;
  clearError();
  state.httpProfileBusy = true;
  renderIntegrations();
  try {
    const result = await mutationJson("/api/v1/integrations/http-profiles/management", "PUT", { enabled });
    state.httpProfiles = result.httpProfiles || state.httpProfiles;
    if (state.health?.controlCenter) state.health.controlCenter.mutationCount += 1;
    showToast("HTTP profile management updated.");
  } catch (error) {
    showError(error);
  } finally {
    state.httpProfileBusy = false;
    renderIntegrations();
  }
}

function linesFromField(value) {
  return String(value || "")
    .split(/\r?\n/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function saveHttpProfile(form) {
  if (state.httpProfileBusy) return;
  clearError();
  const data = new FormData(form);
  const id = String(data.get("id") || "").trim();
  const label = String(data.get("label") || "").trim();
  const origin = String(data.get("origin") || "").trim();
  const basePath = String(data.get("basePath") || "").trim();
  const authType = String(data.get("authType") || "");
  const authHeader = String(data.get("authHeader") || "").trim();
  const allowedMethods = data.getAll("allowedMethod").map(String);
  const allowedPathPrefixes = linesFromField(data.get("allowedPathPrefixes"));
  const allowedAgentHeaders = linesFromField(data.get("allowedAgentHeaders"));
  const timeoutMs = Number.parseInt(String(data.get("timeoutMs") || ""), 10);
  const credential = String(data.get("credential") || "");

  if (!/^[a-z][a-z0-9._-]{0,63}$/u.test(id)) return showError(new Error("Profile ID must start with a lowercase letter and use only lowercase letters, numbers, dots, underscores or hyphens."));
  if (!label || label.length > 100) return showError(new Error("Display name must be 1-100 characters."));
  if (!origin.startsWith("https://")) return showError(new Error("HTTPS origin must start with https://."));
  if (!basePath.startsWith("/") || basePath.startsWith("//")) return showError(new Error("Base path must begin with exactly one /."));
  if (allowedMethods.length < 1) return showError(new Error("Choose at least one allowed method."));
  if (allowedPathPrefixes.length < 1) return showError(new Error("Add at least one allowed path prefix."));
  if (authType === "secret_header" && !authHeader) return showError(new Error("Secret header name is required."));
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) return showError(new Error("Request timeout must be between 1000 and 30000 ms."));

  const profile = {
    id,
    label,
    origin,
    basePath,
    auth: authType === "secret_header" ? { type: "secret_header", headerName: authHeader } : { type: "bearer" },
    allowedMethods,
    allowedPathPrefixes,
    allowedAgentHeaders,
    timeoutMs,
  };

  state.httpProfileBusy = true;
  renderIntegrations();
  try {
    await mutationJson("/api/v1/integrations/http-profiles/profile", "PUT", {
      profile,
      ...(credential ? { credential } : {}),
    });
    await refreshHttpProfiles();
    state.httpProfileDraft = null;
    if (state.health?.controlCenter) state.health.controlCenter.mutationCount += 1;
    showToast("Profile saved.");
  } catch (error) {
    showError(error);
  } finally {
    state.httpProfileBusy = false;
    renderIntegrations();
  }
}

async function testHttpProfileConnection(profile) {
  if (state.httpProfileBusy || !profile?.ready) return;
  clearError();
  state.httpProfileBusy = true;
  renderIntegrations();
  try {
    const method = profile.allowedMethods?.includes("GET") ? "GET" : profile.allowedMethods?.[0];
    const path = profile.allowedPathPrefixes?.[0] || "/";
    const response = await mutationJson("/api/v1/integrations/http-profiles/test", "POST", {
      profileId: profile.id,
      method,
      path,
      query: {},
      headers: {},
    });
    const result = response.result || {};
    state.httpProfileTestResults[profile.id] = `HTTP ${result.status ?? 0} · ${result.durationMs ?? 0} ms`;
    if (state.health?.controlCenter) state.health.controlCenter.mutationCount += 1;
    showToast(`HTTP test returned status ${result.status ?? 0}.`);
  } catch (error) {
    showError(error);
  } finally {
    state.httpProfileBusy = false;
    renderIntegrations();
  }
}

async function deleteHttpProfileFromControlCenter(profile) {
  if (state.httpProfileBusy || !profile?.id) return;
  if (!window.confirm(localizeUiText("Delete this HTTP profile and its saved credential?"))) return;
  clearError();
  state.httpProfileBusy = true;
  renderIntegrations();
  try {
    await mutationJson("/api/v1/integrations/http-profiles/delete", "POST", { profileId: profile.id });
    await refreshHttpProfiles();
    if (state.httpProfileDraft?.id === profile.id) state.httpProfileDraft = null;
    delete state.httpProfileTestResults[profile.id];
    if (state.health?.controlCenter) state.health.controlCenter.mutationCount += 1;
    showToast("Profile deleted.");
  } catch (error) {
    showError(error);
  } finally {
    state.httpProfileBusy = false;
    renderIntegrations();
  }
}


async function checkForUpdates() {
  const mainChannel = ["source", "managed-source"].includes(state.update?.installationKind) && state.update?.main?.checkSupported === true;
  if (state.updateBusy || (!state.update?.selfUpdateSupported && !mainChannel && !state.update?.managedInstallation)) return;
  clearError();
  state.updateBusy = true;
  renderUpdate();
  try {
    const result = await mutationJson("/api/v1/update/check", "POST", {});
    state.update = result.update || state.update;
    renderUpdate();
    if (mainChannel) {
      const main = state.update?.main || {};
      if (main.state === "behind") showToast(`${main.behindBy} ${main.behindBy === 1 ? "commit" : "commits"} available in admitted Main snapshot.`);
      else if (main.state === "up_to_date") showToast("Main snapshot is up to date.");
      else if (main.state === "unavailable") showToast("Main update check is unavailable; no up-to-date result was assumed.");
      else showToast("Main source identity check finished.");
    } else {
      if (state.update?.updateAvailable) showToast(`Equinox Local ${state.update.latestVersion} is available.`);
      else if (state.update?.mainNotice?.targetSha) showToast("Main snapshot available separately from Stable.");
      else if (state.update?.lastError) showToast("Stable update check unavailable.");
      else showToast("Equinox Local is up to date.");
    }
  } catch (error) {
    showError(error);
    try {
      const latest = await requestJson("/api/v1/update");
      state.update = latest.update || state.update;
    } catch {
      // Keep the last safe update snapshot if the status read also fails.
    }
  } finally {
    state.updateBusy = false;
    renderUpdate();
  }
}

async function applyAvailableUpdate() {
  const managedMain = state.update?.installationKind === "managed-source";
  const canApplyMain = Boolean(managedMain && state.update?.main?.applyAvailable && !state.update?.main?.applyError);
  const canApplyStable = Boolean(
    !managedMain
    && state.update?.selfUpdateSupported
    && state.update?.updateAvailable === true
    && !state.update?.lastError
  );
  if (state.updateApplyBusy || state.updateBusy || (!canApplyMain && !canApplyStable)) return;

  clearError();
  state.updateApplyBusy = true;
  renderUpdate();
  try {
    const result = await mutationJson("/api/v1/update/apply", "POST", {});
    const scheduled = result.result || {};
    if (managedMain) {
      state.update = {
        ...(state.update || {}),
        main: {
          ...(state.update?.main || {}),
          applying: false,
          restartScheduledFor: scheduled.targetSha || state.update?.main?.targetSha || null,
        },
      };
    } else {
      state.update = {
        ...(state.update || {}),
        applying: false,
        restartScheduledFor: scheduled.targetVersion || state.update?.latestVersion || null,
      };
    }
    if (state.health?.controlCenter) state.health.controlCenter.mutationCount += 1;
    renderUpdate();
    renderActivity();
    showToast(managedMain
      ? `Main ${shortUpdateSha(scheduled.targetSha) || "snapshot"} is prepared. Restarting safely…`
      : `Equinox Local ${scheduled.targetVersion || "update"} is prepared. Restarting safely…`);
  } catch (error) {
    showError(error);
    try {
      const latest = await requestJson("/api/v1/update");
      state.update = latest.update || state.update;
    } catch {
      // Keep the last safe update snapshot if the status read also fails.
    }
  } finally {
    state.updateApplyBusy = false;
    renderUpdate();
  }
}

function stopOnboardingReconnect() {
  if (state.onboardingReconnectTimer) {
    clearTimeout(state.onboardingReconnectTimer);
    state.onboardingReconnectTimer = null;
  }
}

async function pollOnboardingReconnect(attempt = 0) {
  const maxAttempts = 30;
  try {
    const [onboarding, status, health, doctor] = await Promise.all([
      requestJson("/api/v1/onboarding"),
      requestJson("/api/v1/status"),
      requestJson("/api/v1/health"),
      requestJson("/api/v1/doctor").catch(() => ({ doctor: null })),
    ]);
    state.onboarding = onboarding.onboarding || state.onboarding;
    state.status = status.status || state.status;
    state.health = health;
    state.doctor = doctor.doctor || state.doctor;
    if (state.onboarding?.connectedThroughTunnel) {
      stopOnboardingReconnect();
      state.onboardingBusy = false;
      renderAll();
      showToast("Equinox Local is connected to ChatGPT.");
      return;
    }
  } catch {
    // A short connection failure is expected while the LaunchAgent restarts.
  }

  if (attempt + 1 >= maxAttempts) {
    stopOnboardingReconnect();
    state.onboardingBusy = false;
    renderOnboarding();
    showError(new Error("Equinox Local did not return through the tunnel yet. Your saved credentials were kept locally; refresh to inspect the current setup state."));
    return;
  }

  state.onboardingReconnectTimer = setTimeout(() => {
    void pollOnboardingReconnect(attempt + 1);
  }, 1_200);
}

async function submitTunnelOnboarding(event) {
  event.preventDefault();
  if (state.onboardingBusy || state.onboarding?.available !== true) return;

  const tunnelIdInput = $("onboarding-tunnel-id");
  const runtimeKeyInput = $("onboarding-runtime-key");
  const tunnelId = tunnelIdInput.value.trim();
  const runtimeKey = runtimeKeyInput.value;

  clearError();
  stopOnboardingReconnect();
  state.onboardingBusy = true;
  renderOnboarding();
  try {
    const result = await mutationJson("/api/v1/onboarding/tunnel", "POST", {
      tunnelId,
      runtimeKey,
    });
    runtimeKeyInput.value = "";
    state.onboarding = {
      ...(state.onboarding || {}),
      available: true,
      managed: true,
      transportConfigured: true,
      connectedThroughTunnel: false,
      needsAttention: false,
      tunnelId: result.result?.tunnelId || tunnelId,
    };
    renderOnboarding();
    showToast("Tunnel settings saved. Equinox Local is restarting safely…");
    void pollOnboardingReconnect();
  } catch (error) {
    state.onboardingBusy = false;
    renderOnboarding();
    showError(error);
  }
}

async function submitUninstall(event) {
  event.preventDefault();
  if (state.uninstallBusy || state.uninstallScheduled || state.doctor?.managed !== true) return;

  const confirmation = $("uninstall-confirmation");
  const removeData = $("uninstall-remove-data");
  if (confirmation?.value !== "UNINSTALL") {
    renderUninstall();
    return;
  }

  clearError();
  state.uninstallBusy = true;
  renderUninstall();
  try {
    const response = await mutationJson("/api/v1/uninstall", "POST", {
      confirm: "UNINSTALL",
      removeUserData: Boolean(removeData?.checked),
    });
    state.uninstallScheduled = response.result?.scheduled === true;
    if (!state.uninstallScheduled) throw new Error("Equinox Local did not confirm the uninstall schedule.");
    renderUninstall();
    showToast(removeData?.checked
      ? "Uninstall scheduled. Local user data will also be removed."
      : "Uninstall scheduled. Workspace and configuration will be preserved.");
  } catch (error) {
    state.uninstallBusy = false;
    state.uninstallScheduled = false;
    renderUninstall();
    showError(error);
  }
}

function stopRuntimeRestartPolling() {
  if (state.runtimeRestartTimer) {
    clearTimeout(state.runtimeRestartTimer);
    state.runtimeRestartTimer = null;
  }
}

async function pollRuntimeRestart(previousPid, attempt = 0) {
  const maxAttempts = 45;
  try {
    const status = await requestJson("/api/v1/status");
    const currentPid = status.status?.server?.pid ?? null;
    if (currentPid && currentPid !== previousPid) {
      stopRuntimeRestartPolling();
      window.location.reload();
      return;
    }
  } catch {
    // A short connection failure is expected while the runtime restarts.
  }

  if (attempt + 1 >= maxAttempts) {
    stopRuntimeRestartPolling();
    state.restartBusy = false;
    renderRuntimeRestartControl();
    $("refresh-button").disabled = state.restartRequired;
    showError(new Error("Equinox Local did not reconnect after the restart. Refresh to inspect the current runtime state."));
    return;
  }

  state.runtimeRestartTimer = setTimeout(() => {
    void pollRuntimeRestart(previousPid, attempt + 1);
  }, 1_000);
}

async function toggleAgentControl() {
  if (state.agentControlBusy || !state.status?.server?.pid) return;
  clearError();
  const paused = state.status?.agentControl?.paused === true || state.status?.agentControl?.state === "PAUSED";
  state.agentControlBusy = true;
  renderAgentControl();
  try {
    const endpoint = paused ? "/api/v1/agent/resume" : "/api/v1/agent/pause";
    const response = await mutationJson(endpoint, "POST", {});
    state.status = {
      ...(state.status || {}),
      agentControl: response.agentControl || {},
    };
    showToast(paused ? "Agent resumed." : "Emergency Stop activated. Agent mutations are paused.");
    const refreshedStatus = await requestJson("/api/v1/status").catch(() => null);
    if (refreshedStatus?.status) state.status = refreshedStatus.status;
    const activity = await requestJson("/api/v1/activity").catch(() => null);
    if (activity?.events) state.activity = activity.events;
    const tasks = await requestJson("/api/v1/tasks").catch(() => null);
    if (tasks?.tasks) {
      state.tasks = tasks.tasks;
      if (!state.selectedTaskId || !state.tasks.some((task) => task.taskId === state.selectedTaskId)) {
        state.selectedTaskId = state.tasks.find((task) => task.status === "active")?.taskId || state.tasks[0]?.taskId || null;
      }
      state.taskDraft = state.selectedTaskId ? clone(state.tasks.find((task) => task.taskId === state.selectedTaskId)) : null;
    }
  } catch (error) {
    showError(error);
  } finally {
    state.agentControlBusy = false;
    renderAll();
  }
}

async function saveTurnBudgetSettings() {
  if (state.turnBudgetBusy) return false;
  if (!state.turnBudgetDraft) return true;
  const cutoffMinutes = Number(state.turnBudgetDraft.cutoffMinutes);
  const fallbackResetMinutes = Number(state.turnBudgetDraft.fallbackResetMinutes);
  const autoContinueMaxHops = Number(state.turnBudgetDraft.autoContinueMaxHops);
  if (!Number.isInteger(cutoffMinutes) || cutoffMinutes < 5 || cutoffMinutes > 120) {
    showError(new Error("Turn Budget cutoff must be an integer between 5 and 120 minutes."));
    return false;
  }
  if (!Number.isInteger(fallbackResetMinutes) || fallbackResetMinutes < 1 || fallbackResetMinutes > cutoffMinutes) {
    showError(new Error("Fallback idle timeout must be an integer between 1 minute and the safety cutoff."));
    return false;
  }
  if (!Number.isInteger(autoContinueMaxHops) || autoContinueMaxHops < 1 || autoContinueMaxHops > 20) {
    showError(new Error("Auto Continue maximum hops must be an integer between 1 and 20."));
    return false;
  }
  clearError();
  state.turnBudgetBusy = true;
  renderTurnBudget();
  renderRuntimeRestartControl();
  try {
    const response = await mutationJson("/api/v1/turn-budget", "PUT", {
      enabled: state.turnBudgetDraft.enabled !== false,
      cutoffMinutes,
      fallbackResetMinutes,
      autoContinueMaxHops,
    });
    state.turnBudget = response.turnBudget;
    state.status = { ...(state.status || {}), turnBudget: response.turnBudget };
    state.turnBudgetDraft = { enabled: response.turnBudget.enabled !== false, cutoffMinutes: response.turnBudget.cutoffMinutes, fallbackResetMinutes: response.turnBudget.fallbackResetMinutes, autoContinueMaxHops: response.turnBudget.autoContinueMaxHops };
    state.turnBudgetDirty = false;
    showToast("Turn Budget updated immediately.");
    return true;
  } catch (error) {
    showError(error);
    return false;
  } finally {
    state.turnBudgetBusy = false;
    renderTurnBudget();
    renderRuntimeRestartControl();
  }
}

async function restartRuntimeFromControlCenter() {
  if (state.restartBusy || state.turnBudgetBusy) return;
  clearError();
  if (state.turnBudgetDirty) {
    const saved = await saveTurnBudgetSettings();
    if (!saved) return;
  }
  stopRuntimeRestartPolling();
  state.restartBusy = true;
  renderRuntimeRestartControl();
  $("refresh-button").disabled = true;
  const previousPid = state.status?.server?.pid ?? null;
  try {
    const response = await mutationJson("/api/v1/runtime/restart", "POST", {});
    if (response.result?.scheduled !== true) {
      throw new Error("Equinox Local did not confirm the restart schedule.");
    }
    showToast("Equinox Local is restarting safely…");
    state.runtimeRestartTimer = setTimeout(() => {
      void pollRuntimeRestart(previousPid);
    }, 1_200);
  } catch (error) {
    state.restartBusy = false;
    renderRuntimeRestartControl();
    $("refresh-button").disabled = state.restartRequired;
    showError(error);
  }
}

async function saveConfiguration() {
  if (!state.config || !state.dirty || state.restartRequired) return;
  clearError();
  const button = $("save-config-button");
  const accessButton = $("save-agent-access-button");
  button.disabled = true;
  button.textContent = localizeUiText("Saving…");
  if (accessButton) {
    accessButton.disabled = true;
    accessButton.textContent = localizeUiText("Saving…");
  }
  try {
    const session = await requestJson("/api/v1/session");
    const result = await requestJson("/api/v1/config", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-equinox-csrf": session.csrfToken,
      },
      body: JSON.stringify({
        expectedRevision: state.revision,
        config: state.config,
      }),
    });
    state.revision = result.persistedRevision;
    state.restartRequired = Boolean(result.restartRequired);
    state.dirty = false;
    setBadge("dirty-state", "Saved · restart required", "warn");
    updateRestartState();
    renderActivity();
    showToast("Configuration saved safely.");
  } catch (error) {
    showError(error);
    button.disabled = false;
    if (accessButton) accessButton.disabled = false;
  } finally {
    button.textContent = localizeUiText("Save configuration");
    if (accessButton) {
      accessButton.textContent = localizeUiText("Save access settings");
    }
  }
}

function onNavigationShortcut(event) {
  if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey || event.repeat || event.isComposing) return;
  if (state.setupMode || document.body.classList.contains("control-loading") || document.querySelector("dialog[open]")) return;
  // Never steal keystrokes from editable content, including nested task editors.
  if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable], [role="textbox"]')) return;
  const section = NAVIGATION_SHORTCUTS[event.code];
  if (!section) return;
  event.preventDefault();
  switchSection(section, { remember: true });
}

function bindEvents() {
  document.addEventListener("keydown", onNavigationShortcut);
  for (const button of document.querySelectorAll(".nav-item")) {
    button.addEventListener("click", () => switchSection(button.dataset.section, { remember: true }));
  }
  for (const button of document.querySelectorAll("[data-jump-section]")) {
    button.addEventListener("click", () => switchSection(button.dataset.jumpSection, { remember: true }));
  }

  for (const button of document.querySelectorAll("[data-theme-value]")) {
    button.addEventListener("click", () => setTheme(button.dataset.themeValue));
  }
  systemThemeMedia.addEventListener?.("change", () => {
    if (state.theme === "system") applyTheme();
  });
  $("language-select").addEventListener("change", (event) => setLanguage(event.target.value));
  window.addEventListener("focus", refreshVisibleControlCenter);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshVisibleControlCenter();
  });
  $("agent-control-button").addEventListener("click", toggleAgentControl);
  $("turn-budget-enabled").addEventListener("change", (event) => {
    state.turnBudgetDraft = { ...(state.turnBudgetDraft || { cutoffMinutes: 22, fallbackResetMinutes: 5 }), enabled: event.target.checked };
    state.turnBudgetDirty = true;
    renderTurnBudget();
  });
  $("turn-budget-cutoff").addEventListener("input", (event) => {
    state.turnBudgetDraft = { ...(state.turnBudgetDraft || { enabled: true, fallbackResetMinutes: 5 }), cutoffMinutes: Number(event.target.value) };
    state.turnBudgetDirty = true;
    renderTurnBudget();
  });
  $("turn-budget-fallback-reset").addEventListener("input", (event) => {
    state.turnBudgetDraft = { ...(state.turnBudgetDraft || { enabled: true, cutoffMinutes: 22 }), fallbackResetMinutes: Number(event.target.value) };
    state.turnBudgetDirty = true;
    $("save-turn-budget-button").disabled = state.turnBudgetBusy;
  });
  $("auto-continue-max-hops").addEventListener("input", (event) => {
    state.turnBudgetDraft = { ...(state.turnBudgetDraft || { enabled: true, cutoffMinutes: 22, fallbackResetMinutes: 5 }), autoContinueMaxHops: Number(event.target.value) };
    state.turnBudgetDirty = true;
    $("save-turn-budget-button").disabled = state.turnBudgetBusy;
  });
  $("save-turn-budget-button").addEventListener("click", saveTurnBudgetSettings);
  $("restart-runtime-button").addEventListener("click", restartRuntimeFromControlCenter);
  $("refresh-button").addEventListener("click", refreshAll);
  $("onboarding-tunnel-form").addEventListener("submit", submitTunnelOnboarding);
  $("copy-setup-tunnel-id").addEventListener("click", () => void copySetupText(state.onboarding?.tunnelId || "", "Tunnel ID copied."));
  $("copy-setup-test-prompt").addEventListener("click", () => void copySetupText($("setup-test-prompt").textContent.trim(), "Test prompt copied."));
  $("setup-telegram-token").addEventListener("input", (event) => { state.telegramBotToken = event.target.value; renderOnboarding(); });
  $("setup-telegram-start").addEventListener("click", () => void startTelegramPairingUi());
  $("setup-telegram-confirm").addEventListener("click", () => void confirmTelegramPairingUi());
  $("setup-telegram-cancel").addEventListener("click", () => void cancelTelegramPairingUi());
  $("setup-telegram-skip").addEventListener("click", () => { state.telegramSetupSkipped = true; renderOnboarding(); });
  $("setup-uninstall-nav").addEventListener("click", () => {
    const details = $("setup-uninstall-details");
    details.open = true;
    details.scrollIntoView({ block: "start", behavior: "smooth" });
  });
  $("uninstall-form").addEventListener("submit", submitUninstall);
  $("uninstall-confirmation").addEventListener("input", renderUninstall);
  $("uninstall-remove-data").addEventListener("change", renderUninstall);
  $("sidebar-update-button").addEventListener("click", () => {
    $("update-dialog").showModal();
    void checkForUpdates();
  });
  $("close-update-dialog").addEventListener("click", () => $("update-dialog").close());
  $("update-dialog").addEventListener("click", (event) => {
    if (event.target === $("update-dialog")) $("update-dialog").close();
  });
  $("check-update-button").addEventListener("click", checkForUpdates);
  $("install-update-button").addEventListener("click", applyAvailableUpdate);
  $("dismiss-error").addEventListener("click", clearError);
  $("reload-after-restart").addEventListener("click", () => window.location.reload());
  $("add-project-button").addEventListener("click", () => openRootDialog({ mode: "add", kind: "project" }));
  $("add-folder-button").addEventListener("click", () => openRootDialog({ mode: "add", kind: "fileRoot" }));
  $("close-dialog").addEventListener("click", closeRootDialog);
  $("cancel-dialog").addEventListener("click", closeRootDialog);
  $("root-form").addEventListener("submit", applyRootForm);
  $("choose-folder-button").addEventListener("click", chooseFolderForDialog);
  $("save-config-button").addEventListener("click", saveConfiguration);
  $("save-agent-access-button").addEventListener("click", saveConfiguration);
  $("task-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-task-id]");
    if (button) void selectTask(button.dataset.taskId);
  });
  $("task-form").addEventListener("submit", saveSelectedTask);
  for (const id of ["task-title-input", "task-objective-input", "task-completed-input", "task-next-input", "task-references-input"]) {
    $(id).addEventListener("input", () => { state.taskDraftDirty = true; });
  }
  $("task-cancel-continuation-button").addEventListener("click", () => void runTaskAction("continuation"));
  $("task-cancel-fresh-resume-button").addEventListener("click", () => void runTaskAction("fresh-cancel"));
  $("task-abandon-fresh-resume-button").addEventListener("click", () => void runTaskAction("fresh-abandon"));
  $("task-complete-button").addEventListener("click", () => void runTaskAction("complete"));
  $("task-cancel-button").addEventListener("click", () => void runTaskAction("cancel"));
  $("task-delete-button").addEventListener("click", () => void deleteSelectedTask());
  $("open-agent-browser-button").addEventListener("click", openAgentBrowserFromControlCenter);
  $("browser-settings-target").addEventListener("change", (event) => selectBrowserSettingsTarget(event.target.value));
  $("browser-control-toggle").addEventListener("change", updateBrowserDraftFromInputs);
  $("browser-cursor-toggle").addEventListener("change", updateBrowserDraftFromInputs);
  $("browser-agent-name").addEventListener("input", updateBrowserDraftFromInputs);
  $("apply-browser-settings").addEventListener("click", saveBrowserSettings);

  $("default-project-select").addEventListener("change", (event) => {
    state.config.defaultProject = event.target.value;
    markDirty();
    renderAll();
  });
  $("workspace-project-select").addEventListener("change", (event) => {
    state.config.runtime.workspaceProject = event.target.value;
    markDirty();
    renderAll();
  });
  $("downloads-root-select").addEventListener("change", (event) => {
    state.config.runtime.downloadsRoot = event.target.value;
    markDirty();
    renderAll();
  });

  const updateAgentAccess = () => {
    if (!state.config || state.restartRequired) return;
    state.config.agentAccess = {
      files: $("agent-files-access").value,
      terminal: $("agent-terminal-access").checked,
      desktop: $("agent-desktop-access").checked,
      browser: $("agent-web-access").checked,
    };
    markDirty();
    renderPermissions();
  };
  $("agent-files-access").addEventListener("change", updateAgentAccess);
  $("agent-terminal-access").addEventListener("change", updateAgentAccess);
  $("agent-desktop-access").addEventListener("change", updateAgentAccess);
  $("agent-web-access").addEventListener("change", updateAgentAccess);

  $("root-dialog").addEventListener("click", (event) => {
    if (event.target === $("root-dialog")) closeRootDialog();
  });
}

function applyInitialNavigationIntent() {
  const params = new URLSearchParams(window.location.search);
  const section = params.get("section");
  const taskId = params.get("task");
  // Explicit links always take priority over the last section opened by hand.
  if (section && sectionMeta[section]) state.activeSection = section;
  else if (taskId && /^task-[a-z0-9-]{6,80}$/u.test(taskId)) state.activeSection = "tasks";
  else {
    try {
      const remembered = localStorage.getItem(SECTION_STORAGE_KEY);
      if (remembered && remembered !== "setup" && sectionMeta[remembered]) state.activeSection = remembered;
    } catch {
      // Read-only/blocked storage should fall back to Overview.
    }
  }
  if (taskId && /^task-[a-z0-9-]{6,80}$/u.test(taskId)) state.selectedTaskId = taskId;
}

applyInitialNavigationIntent();
captureStaticTranslatables();
applyTheme();
applyStaticLanguage();
notifyNativeLanguage();
bindEvents();
switchSection(state.activeSection);
renderLastRefreshed();
setInterval(renderTurnBudgetLive, 1_000);
setInterval(() => { void refreshLiveState(); }, AUTO_REFRESH_LIVE_MS);
setInterval(() => { void refreshMediumState(); }, AUTO_REFRESH_MEDIUM_MS);
setInterval(() => { void refreshTelegramPairing(); }, 2_500);
setInterval(() => { void refreshSlowState(); }, AUTO_REFRESH_SLOW_MS);
void refreshAll();
