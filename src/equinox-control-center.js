const $ = (id) => document.getElementById(id);

const state = {
  config: null,
  revision: null,
  status: null,
  health: null,
  doctor: null,
  activity: [],
  update: null,
  updateBusy: false,
  updateApplyBusy: false,
  onboarding: null,
  onboardingBusy: false,
  onboardingReconnectTimer: null,
  uninstallBusy: false,
  uninstallScheduled: false,
  github: null,
  telegram: null,
  telegramBotToken: "",
  telegramUserId: "",
  browserDraft: null,
  browserSettingsDirty: false,
  browserSettingsBusy: false,
  integrationBusy: false,
  pickerBusy: false,
  dirty: false,
  restartRequired: false,
  dialogMode: null,
  dialogKind: "project",
  editingId: null,
  toastTimer: null,
};

const sectionMeta = {
  dashboard: ["Overview", "Dashboard"],
  projects: ["Access boundaries", "Projects & folders"],
  browser: ["User Chrome lane", "Browser"],
  permissions: ["Security model", "Permissions"],
  integrations: ["Optional capabilities", "Integrations"],
  activity: ["Diagnostics", "Activity"],
};

function clone(value) {
  return structuredClone(value);
}

function setText(id, value) {
  const element = $(id);
  if (element) element.textContent = value ?? "—";
}

function setDot(id, tone) {
  const element = $(id);
  if (!element) return;
  element.className = `status-dot is-${tone}`;
}

function setBadge(elementOrId, text, tone = "neutral") {
  const element = typeof elementOrId === "string" ? $(elementOrId) : elementOrId;
  if (!element) return;
  element.textContent = text;
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
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatUptime(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "Uptime unavailable";
  const seconds = Math.round(totalSeconds);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h uptime`;
  if (hours > 0) return `${hours}h ${minutes}m uptime`;
  return `${Math.max(1, minutes)}m uptime`;
}

async function requestJson(path, options = {}) {
  const response = await fetch(path, {
    cache: "no-store",
    credentials: "same-origin",
    ...options,
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
  toast.textContent = message;
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
  $("save-config-button").disabled = false;
}

function markClean() {
  state.dirty = false;
  setBadge("dirty-state", "No unsaved changes", "neutral");
  $("save-config-button").disabled = true;
}

function setConfigEditingEnabled(enabled) {
  const ids = [
    "add-folder-button",
    "add-project-button",
    "default-project-select",
    "workspace-project-select",
    "downloads-root-select",
  ];
  for (const id of ids) {
    const element = $(id);
    if (element) element.disabled = !enabled;
  }
  for (const button of document.querySelectorAll(".project-actions button")) {
    button.disabled = !enabled || button.dataset.locked === "true";
  }
  if (!enabled) $("save-config-button").disabled = true;
}

function switchSection(section) {
  if (!sectionMeta[section]) return;
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
  setBadge("health-summary-badge", runtimeHealth === "UNKNOWN" ? "Unknown" : runtimeHealth, runtimeTone);
  setText("runtime-version", status.server?.version ? `v${status.server.version}` : "—");
  setText("runtime-uptime", formatUptime(status.server?.uptimeSeconds));
  setText("sidebar-version", status.server?.version ? `Equinox Local ${status.server.version}` : "Local runtime");
  setText("sidebar-health-label", runtimeHealth === "HEALTHY" ? "Runtime healthy" : runtimeHealth.toLowerCase().replaceAll("_", " "));
  setDot("sidebar-health-dot", dotToneForHealth(runtimeHealth));

  const browserConsentRequired = browser.ready && browser.consentAccepted === false;
  const browserLabel = browserConsentRequired
    ? "Connected · consent required"
    : browser.ready && browser.controlEnabled === false
      ? "Connected · automation off"
      : browser.ready
        ? "Ready"
        : browser.active
          ? "Extension not connected"
          : "Unavailable";
  setText("browser-status", browserLabel);
  setText("browser-version", browser.extensionVersion ? `Extension ${browser.extensionVersion}` : "Extension version unavailable");
  setDot("browser-status-dot", browser.ready ? (browserConsentRequired || browser.controlEnabled === false ? "warn" : "good") : browser.active ? "warn" : "neutral");

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

function renderOnboarding() {
  const onboarding = state.onboarding || {};
  const card = $("onboarding-card");
  if (!card) return;

  const connected = onboarding.available === true && onboarding.connectedThroughTunnel === true;
  card.hidden = onboarding.available !== true || connected;
  if (card.hidden) return;

  const runtimeReady = Boolean(state.health?.controlCenter?.active && state.status?.server?.version);
  const workspaceReady = Boolean(
    state.config?.projects?.workspace &&
    state.config?.runtime?.workspaceProject === "workspace"
  );
  const browserReady = Boolean(state.status?.browser?.ready);

  setBadge("setup-runtime-status", runtimeReady ? "Ready" : "Checking", runtimeReady ? "good" : "neutral");
  setBadge("setup-workspace-status", workspaceReady ? "Ready" : "Needs attention", workspaceReady ? "good" : "warn");
  setBadge("setup-browser-status", browserReady ? "Ready" : "Optional", browserReady ? "good" : "neutral");

  if (onboarding.needsAttention) {
    setBadge("setup-tunnel-status", "Needs attention", "warn");
    setBadge("onboarding-badge", "Action needed", "warn");
    setText("onboarding-copy", onboarding.issue || "The saved tunnel connection needs attention. Re-enter the Runtime API key to repair it.");
  } else if (onboarding.transportConfigured) {
    setBadge("setup-tunnel-status", "Restarting", "warn");
    setBadge("onboarding-badge", "Connecting", "warn");
    setText("onboarding-copy", "Tunnel settings are saved. Equinox Local is switching from local-only setup mode to the private ChatGPT connection.");
  } else {
    setBadge("setup-tunnel-status", "Not connected", "warn");
    setBadge("onboarding-badge", "Setup needed", "warn");
    setText("onboarding-copy", "Your local runtime is ready. Add the OpenAI tunnel credentials to finish connecting Equinox Local to ChatGPT.");
  }

  const tunnelIdInput = $("onboarding-tunnel-id");
  if (tunnelIdInput && document.activeElement !== tunnelIdInput && onboarding.tunnelId && !tunnelIdInput.value) {
    tunnelIdInput.value = onboarding.tunnelId;
  }
  const connectButton = $("onboarding-connect-button");
  const runtimeKeyInput = $("onboarding-runtime-key");
  if (connectButton) {
    connectButton.disabled = state.onboardingBusy;
    connectButton.textContent = state.onboardingBusy ? "Connecting…" : "Save & connect";
  }
  if (tunnelIdInput) tunnelIdInput.disabled = state.onboardingBusy;
  if (runtimeKeyInput) runtimeKeyInput.disabled = state.onboardingBusy;
  $("onboarding-reconnect").hidden = !state.onboardingBusy;
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
      ? "Equinox Local checked the managed runtime, private configuration, update path and optional bridges without exposing local paths or secrets."
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
    title.textContent = item.label || "Check";
    const detail = document.createElement("small");
    detail.textContent = item.detail || "No additional detail.";
    copy.append(title, detail);

    const badge = document.createElement("span");
    setBadge(badge, item.status === "pass" ? "Ready" : item.status === "attention" ? "Attention" : "Optional", item.status === "pass" ? "good" : item.status === "attention" ? "warn" : "neutral");

    row.append(indicator, copy, badge);
    list.append(row);
  }
}

function renderUpdate() {
  const update = state.update || {};
  const checkButton = $("check-update-button");
  const installButton = $("install-update-button");
  const current = update.currentVersion || state.status?.server?.version || null;
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
    setText("update-copy", "This development checkout is never self-updated. Public shell-bootstrap installs use the managed signed update channel.");
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
  checkButton.disabled = updateLocked || !update.selfUpdateSupported;
  checkButton.textContent = state.updateBusy ? "Checking…" : "Check for updates";

  const canApply = Boolean(
    update.selfUpdateSupported &&
    update.configured &&
    update.updateAvailable === true &&
    !update.lastError &&
    !update.restartScheduledFor
  );
  installButton.hidden = !canApply && !state.updateApplyBusy && !update.applying && !update.restartScheduledFor;
  installButton.disabled = updateLocked || !canApply;
  installButton.textContent = state.updateApplyBusy || update.applying ? "Preparing update…" : update.restartScheduledFor ? "Restarting…" : "Update & restart";
}

function makeMiniBadge(text) {
  const badge = document.createElement("span");
  badge.className = "mini-badge";
  badge.textContent = text;
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
  edit.textContent = "Edit";
  edit.addEventListener("click", () => openRootDialog({ mode: "edit", kind, id }));

  const remove = document.createElement("button");
  remove.className = "row-button danger";
  remove.type = "button";
  remove.textContent = "Remove";
  const locked = kind === "project"
    ? state.config.defaultProject === id || state.config.runtime?.workspaceProject === id
    : state.config.runtime?.downloadsRoot === id;
  remove.dataset.locked = locked ? "true" : "false";
  remove.disabled = locked || state.restartRequired;
  remove.title = locked ? "Change the runtime routing first before removing this root." : "Remove from the draft configuration";
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

  for (const [id, definition] of Object.entries(state.config.projects || {})) {
    const card = document.createElement("article");
    card.className = "permission-card";
    const meta = document.createElement("div");
    meta.className = "permission-meta";
    const title = document.createElement("h4");
    title.textContent = definition.name;
    const badge = makeMiniBadge("Project boundary");
    meta.append(title, badge);
    const copy = document.createElement("p");
    copy.textContent = "Project tools stay contained to this configured root. Granular per-tool capability switches are not part of config schema V1 yet.";
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
    copy.textContent = "This extra file root is intentionally read-only in V1 and cannot be promoted to writable from the Control Center.";
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
  title.textContent = titleText;
  const badge = document.createElement("span");
  setBadge(badge, statusText, tone);
  meta.append(title, badge);
  const copy = document.createElement("p");
  copy.textContent = description;
  card.append(meta, copy);

  if (actions.length > 0) {
    const actionRow = document.createElement("div");
    actionRow.className = "integration-actions";
    for (const action of actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `button ${action.primary ? "primary" : "secondary"}`;
      button.textContent = action.label;
      button.disabled = Boolean(action.disabled) || state.integrationBusy;
      button.addEventListener("click", action.onClick);
      actionRow.append(button);
    }
    card.append(actionRow);
  }
  return card;
}

function createTelegramIntegrationCard() {
  const telegram = state.telegram;
  const configured = Boolean(telegram?.configured && telegram?.ready);
  const needsAttention = Boolean(telegram?.needsAttention);
  const card = createIntegrationCard(
    "Telegram",
    configured
      ? `Bot API is connected${telegram.userIdHint ? ` to user ${telegram.userIdHint}` : ""}. Agents can send messages only to this Telegram account; the recipient cannot be changed by an agent.`
      : needsAttention
        ? "Saved Telegram credentials need attention. Reconnect the bot to replace them safely."
        : "Connect a Telegram bot to one Telegram account. Groups and channels are not supported, and agents cannot choose another recipient.",
    configured ? "Ready" : needsAttention ? "Needs attention" : "Not connected",
    configured ? "good" : needsAttention ? "warn" : "neutral",
    configured
      ? [
          { label: "Send test", onClick: testTelegramConnection },
          { label: "Disconnect", onClick: disconnectTelegramConnection },
        ]
      : [],
  );

  if (!configured) {
    const form = document.createElement("form");
    form.className = "integration-form";
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void connectTelegramIntegration();
    });

    const tokenLabel = document.createElement("label");
    tokenLabel.className = "field";
    const tokenTitle = document.createElement("span");
    tokenTitle.textContent = "Bot token";
    const tokenInput = document.createElement("input");
    tokenInput.type = "password";
    tokenInput.autocomplete = "off";
    tokenInput.spellcheck = false;
    tokenInput.placeholder = "123456789:AA…";
    tokenInput.value = state.telegramBotToken;
    tokenInput.disabled = state.integrationBusy;
    tokenInput.addEventListener("input", () => { state.telegramBotToken = tokenInput.value; });
    tokenLabel.append(tokenTitle, tokenInput);

    const chatLabel = document.createElement("label");
    chatLabel.className = "field";
    const chatTitle = document.createElement("span");
    chatTitle.textContent = "Your Telegram ID";
    const chatInput = document.createElement("input");
    chatInput.type = "text";
    chatInput.inputMode = "numeric";
    chatInput.autocomplete = "off";
    chatInput.spellcheck = false;
    chatInput.placeholder = "123456789";
    chatInput.value = state.telegramUserId;
    chatInput.disabled = state.integrationBusy;
    chatInput.addEventListener("input", () => { state.telegramUserId = chatInput.value; });
    chatLabel.append(chatTitle, chatInput);

    const button = document.createElement("button");
    button.type = "submit";
    button.className = "button primary";
    button.textContent = state.integrationBusy ? "Connecting…" : "Connect & test";
    button.disabled = state.integrationBusy;
    form.append(tokenLabel, chatLabel, button);
    card.append(form);
  }
  return card;
}

function renderIntegrations() {
  const list = $("integration-list");
  list.replaceChildren();
  const browser = state.status?.browser || {};
  const peekaboo = state.status?.peekaboo || {};
  const github = state.github;
  const browserStatus = browser.ready
    ? browser.consentAccepted === false
      ? "Consent required"
      : (browser.controlEnabled === false ? "Automation off" : "Ready")
    : browser.active ? "Extension not connected" : "Unavailable";
  const browserTone = browser.ready
    ? (browser.consentAccepted === false || browser.controlEnabled === false ? "warn" : "good")
    : "neutral";
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
      browser.extensionVersion ? `First-party Chrome bridge · extension ${browser.extensionVersion}.` : "First-party Chrome bridge through the extension and Native Messaging.",
      browserStatus,
      browserTone,
      [{ label: "Browser settings", onClick: () => switchSection("browser") }],
    ),
    createIntegrationCard(
      "Peekaboo desktop bridge",
      peekaboo.version
        ? `Optional macOS desktop capability · Peekaboo ${peekaboo.version}.`
        : "Optional macOS desktop capability. It is not required for core Equinox Local filesystem or Git operations.",
      peekabooStatus,
      peekabooTone,
    ),
    createIntegrationCard(
      "GitHub",
      github === null
        ? "Optional GitHub CLI integration. Check only verifies the existing local credential state; credentials are never returned to the browser."
        : github.ready
          ? `GitHub CLI is ready${github.account ? ` for ${github.account}` : ""}.`
          : "GitHub CLI is not authenticated or not available to Equinox Local.",
      github === null ? "Not checked" : github.ready ? "Ready" : "Needs attention",
      github === null ? "neutral" : github.ready ? "good" : "warn",
      [{ label: github === null ? "Check connection" : "Check again", onClick: checkGitHubIntegration }],
    ),
    createTelegramIntegrationCard(),
  );
}

function browserSettingsFromStatus() {
  const browser = state.status?.browser || {};
  if (
    typeof browser.controlEnabled !== "boolean" ||
    typeof browser.agentCursorEnabled !== "boolean" ||
    typeof browser.agentCursorName !== "string"
  ) {
    return null;
  }
  return {
    enabled: browser.controlEnabled,
    agentCursorEnabled: browser.agentCursorEnabled,
    agentCursorName: browser.agentCursorName,
  };
}

function renderBrowserPage() {
  const browser = state.status?.browser || {};
  const consentRequired = browser.ready && browser.consentAccepted === false;
  const controlOff = browser.ready && !consentRequired && browser.controlEnabled === false;
  const label = consentRequired
    ? "Connected · consent required"
    : controlOff
      ? "Connected · automation off"
      : browser.ready
        ? "Ready"
        : browser.active
          ? "Extension not connected"
          : "Unavailable";
  setText("browser-page-status", label);
  setBadge(
    "browser-page-badge",
    browser.ready ? (consentRequired ? "Consent required" : controlOff ? "Automation off" : "Ready") : browser.active ? "Extension not connected" : "Unavailable",
    browser.ready ? (consentRequired || controlOff ? "warn" : "good") : "neutral",
  );
  setText("browser-page-version", browser.extensionVersion || "—");
  setText("browser-connected-at", formatDate(browser.connectedAt));
  setText("browser-control-state", consentRequired ? "Consent required" : typeof browser.controlEnabled === "boolean" ? (browser.controlEnabled ? "Allowed" : "Off") : "Unavailable");

  const baseline = browserSettingsFromStatus();
  if (!state.browserSettingsDirty) state.browserDraft = baseline ? { ...baseline } : null;
  const available = Boolean(browser.ready && baseline && state.browserDraft);
  const disabled = !available || state.browserSettingsBusy;
  const controlToggle = $("browser-control-toggle");
  const cursorToggle = $("browser-cursor-toggle");
  const nameInput = $("browser-agent-name");
  const applyButton = $("apply-browser-settings");

  controlToggle.disabled = disabled || consentRequired;
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
  applyButton.textContent = state.browserSettingsBusy ? "Applying…" : "Apply browser settings";
  setText(
    "browser-settings-note",
    consentRequired
      ? "Open the Equinox Browser popup, review the data-use disclosure, and enable browser control there. The local settings channel remains connected."
      : available
        ? "Settings apply immediately through Native Messaging and do not require an Equinox Local restart."
        : "Connect Equinox Browser to manage these settings from Control Center.",
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
    empty.textContent = "No sanitized runtime events were recorded in the last six hours.";
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
    title.textContent = event.message || event.type || "Runtime event";
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

function renderAll() {
  renderDashboard();
  renderOnboarding();
  renderDoctor();
  renderUpdate();
  renderProjects();
  renderPermissions();
  renderUninstall();
  renderIntegrations();
  renderBrowserPage();
  renderActivity();
}

function updateRestartState() {
  $("restart-banner").hidden = !state.restartRequired;
  $("refresh-button").disabled = state.restartRequired;
  setConfigEditingEnabled(!state.restartRequired);
}

async function refreshAll() {
  if (state.restartRequired) return;
  clearError();
  $("refresh-button").disabled = true;
  try {
    const [health, status, config, activity, update, onboarding, doctor, github, peekaboo, telegram] = await Promise.all([
      requestJson("/api/v1/health"),
      requestJson("/api/v1/status"),
      requestJson("/api/v1/config"),
      requestJson("/api/v1/activity").catch(() => ({ events: [] })),
      requestJson("/api/v1/update"),
      requestJson("/api/v1/onboarding"),
      requestJson("/api/v1/doctor"),
      requestJson("/api/v1/integrations/github").catch(() => ({ github: null })),
      requestJson("/api/v1/integrations/peekaboo").catch(() => ({ peekaboo: null })),
      requestJson("/api/v1/integrations/telegram").catch(() => ({ telegram: null })),
    ]);
    state.health = health;
    state.status = status.status;
    state.config = clone(config.config);
    state.revision = config.revision;
    state.activity = Array.isArray(activity.events) ? activity.events : [];
    state.update = update.update || null;
    state.onboarding = onboarding.onboarding || null;
    state.doctor = doctor.doctor || null;
    state.github = github.github || null;
    if (peekaboo.peekaboo) {
      state.status = {
        ...(state.status || {}),
        peekaboo: peekaboo.peekaboo,
      };
    }
    state.telegram = telegram.telegram || null;
    state.browserDraft = null;
    state.browserSettingsDirty = false;
    state.restartRequired = false;
    markClean();
    renderAll();
    setText("last-refreshed", `Refreshed ${new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date())}`);
  } catch (error) {
    showError(error);
  } finally {
    $("refresh-button").disabled = state.restartRequired;
  }
}

function validateRootForm({ id, name, root }) {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(id)) {
    return "Identifier must use lowercase letters, numbers, dots, underscores or hyphens.";
  }
  if (!name.trim() || name.trim().length > 100) return "Display name must be 1-100 characters.";
  if (!root.startsWith("/")) return "Folder path must be absolute and start with /.";
  if (root === "/") return "The filesystem root itself cannot be granted.";
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
  const confirmed = window.confirm(`Remove “${definition.name}” from the draft configuration? Nothing is deleted from disk.`);
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
  button.textContent = "Choosing…";
  $("dialog-error").hidden = true;
  try {
    const result = await mutationJson("/api/v1/folder-picker", "POST", {});
    if (result.cancelled) {
      showToast("Folder selection cancelled.");
      return;
    }
    if (typeof result.path === "string" && result.path.startsWith("/")) {
      $("root-path").value = result.path;
      $("root-path").focus();
    }
  } catch (error) {
    setText("dialog-error", error instanceof Error ? error.message : String(error));
    $("dialog-error").hidden = false;
  } finally {
    state.pickerBusy = false;
    button.disabled = false;
    button.textContent = "Choose folder…";
  }
}

function updateBrowserDraftFromInputs() {
  const baseline = browserSettingsFromStatus();
  if (!baseline || state.browserSettingsBusy) return;
  state.browserDraft = {
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

async function saveBrowserSettings() {
  if (!state.browserDraft || !state.browserSettingsDirty || state.browserSettingsBusy) return;
  clearError();
  state.browserSettingsBusy = true;
  renderBrowserPage();
  try {
    const result = await mutationJson("/api/v1/browser/settings", "PUT", state.browserDraft);
    const settings = result.settings || {};
    state.status.browser = {
      ...(state.status?.browser || {}),
      controlEnabled: typeof settings.enabled === "boolean" ? settings.enabled : state.browserDraft.enabled,
      agentCursorEnabled: typeof settings.agentCursorEnabled === "boolean" ? settings.agentCursorEnabled : state.browserDraft.agentCursorEnabled,
      agentCursorName: typeof settings.agentCursorName === "string" ? settings.agentCursorName : state.browserDraft.agentCursorName,
      nativeHostConnected: Boolean(settings.nativeHostConnected ?? state.status?.browser?.nativeHostConnected),
      localConnected: Boolean(settings.localConnected ?? state.status?.browser?.localConnected),
    };
    state.browserDraft = browserSettingsFromStatus();
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

async function checkGitHubIntegration() {
  if (state.integrationBusy) return;
  clearError();
  state.integrationBusy = true;
  renderIntegrations();
  try {
    const result = await mutationJson("/api/v1/integrations/github/check", "POST", {});
    state.github = result.github || { ready: false, account: null };
    renderIntegrations();
    showToast(state.github.ready ? "GitHub connection is ready." : "GitHub needs attention.");
  } catch (error) {
    showError(error);
  } finally {
    state.integrationBusy = false;
    renderIntegrations();
  }
}

async function connectTelegramIntegration() {
  if (state.integrationBusy) return;
  clearError();
  state.integrationBusy = true;
  renderIntegrations();
  try {
    const result = await mutationJson("/api/v1/integrations/telegram", "PUT", {
      botToken: state.telegramBotToken.trim(),
      telegramUserId: state.telegramUserId.trim(),
    });
    state.telegram = result.telegram || null;
    state.telegramBotToken = "";
    state.telegramUserId = "";
    if (state.health?.controlCenter) state.health.controlCenter.mutationCount += 1;
    showToast("Telegram connected and test message sent.");
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
    state.telegram = { configured: false, ready: false, needsAttention: false, userIdHint: null };
    if (state.health?.controlCenter) state.health.controlCenter.mutationCount += 1;
    showToast("Telegram disconnected.");
  } catch (error) {
    showError(error);
  } finally {
    state.integrationBusy = false;
    renderIntegrations();
  }
}

async function checkForUpdates() {
  if (state.updateBusy || !state.update?.selfUpdateSupported) return;
  clearError();
  state.updateBusy = true;
  renderUpdate();
  try {
    const result = await mutationJson("/api/v1/update/check", "POST", {});
    state.update = result.update || state.update;
    renderUpdate();
    showToast(state.update?.updateAvailable ? `Equinox Local ${state.update.latestVersion} is available.` : "Equinox Local is up to date.");
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
  if (
    state.updateApplyBusy ||
    state.updateBusy ||
    !state.update?.selfUpdateSupported ||
    state.update?.updateAvailable !== true ||
    state.update?.lastError
  ) return;

  clearError();
  state.updateApplyBusy = true;
  renderUpdate();
  try {
    const result = await mutationJson("/api/v1/update/apply", "POST", {});
    const scheduled = result.result || {};
    state.update = {
      ...(state.update || {}),
      applying: false,
      restartScheduledFor: scheduled.targetVersion || state.update?.latestVersion || null,
    };
    if (state.health?.controlCenter) state.health.controlCenter.mutationCount += 1;
    renderUpdate();
    renderActivity();
    showToast(`Equinox Local ${scheduled.targetVersion || "update"} is prepared. Restarting safely…`);
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
      requestJson("/api/v1/doctor"),
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

async function saveConfiguration() {
  if (!state.config || !state.dirty || state.restartRequired) return;
  clearError();
  const button = $("save-config-button");
  button.disabled = true;
  button.textContent = "Saving…";
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
  } finally {
    button.textContent = "Save configuration";
  }
}

function bindEvents() {
  for (const button of document.querySelectorAll(".nav-item")) {
    button.addEventListener("click", () => switchSection(button.dataset.section));
  }
  for (const button of document.querySelectorAll("[data-jump-section]")) {
    button.addEventListener("click", () => switchSection(button.dataset.jumpSection));
  }

  $("refresh-button").addEventListener("click", refreshAll);
  $("onboarding-tunnel-form").addEventListener("submit", submitTunnelOnboarding);
  $("uninstall-form").addEventListener("submit", submitUninstall);
  $("uninstall-confirmation").addEventListener("input", renderUninstall);
  $("uninstall-remove-data").addEventListener("change", renderUninstall);
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

  $("root-dialog").addEventListener("click", (event) => {
    if (event.target === $("root-dialog")) closeRootDialog();
  });
}

bindEvents();
void refreshAll();
