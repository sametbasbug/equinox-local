import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";

import { EQUINOX_LOCAL_CONFIG_ERROR_CODES } from "./equinox-local-config.js";
import { TASK_CAPSULE_ERROR_CODES } from "./task-capsule-store.js";
import { REPAIR_RECIPE_IDS } from "./repair-engine.js";
import {
  AUTHENTICATED_HTTP_LIMITS,
  validateAuthenticatedHttpProfileInput,
} from "./authenticated-http-integration.js";

const LOOPBACK_HOST = "127.0.0.1";
const MAX_REQUEST_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const REPAIR_RECIPE_ID_SET = new Set(REPAIR_RECIPE_IDS);
const CONTROL_CENTER_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");
const CONTROL_CENTER_BACKGROUND_REFRESH_PATHS = new Set([
  "/api/v1/health",
  "/api/v1/status",
  "/api/v1/activity",
  "/api/v1/tasks",
  "/api/v1/onboarding",
  "/api/v1/doctor",
  "/api/v1/doctor/repairs",
  "/api/v1/integrations/peekaboo",
  "/api/v1/integrations/telegram",
  "/api/v1/files/import-settings",
  "/api/v1/integrations/telegram/pair",
  "/api/v1/integrations/http-profiles",
  "/api/v1/config",
  "/api/v1/update",
]);

function isBackgroundRefreshRequest(req, url) {
  return req.method === "GET"
    && req.headers["x-equinox-background-refresh"] === "1"
    && CONTROL_CENTER_BACKGROUND_REFRESH_PATHS.has(url.pathname);
}

const CONTROL_CENTER_ASSETS = new Map([
  ["/", Object.freeze({
    urls: Object.freeze([
      new URL("./equinox-control-center.html", import.meta.url),
      new URL("../equinox-control-center.html", import.meta.url),
    ]),
    contentType: "text/html; charset=utf-8",
  })],
  ["/assets/control-center.css", Object.freeze({
    urls: Object.freeze([
      new URL("./equinox-control-center.css", import.meta.url),
      new URL("../equinox-control-center.css", import.meta.url),
    ]),
    contentType: "text/css; charset=utf-8",
  })],
  ["/assets/control-center.js", Object.freeze({
    url: new URL("./equinox-control-center.js", import.meta.url),
    contentType: "text/javascript; charset=utf-8",
  })],
  ["/assets/equinox-local.png", Object.freeze({
    urls: Object.freeze([
      new URL("./app/EquinoxLocal.png", import.meta.url),
      new URL("../app/EquinoxLocal.png", import.meta.url),
    ]),
    contentType: "image/png",
  })],
]);

function jsonBody(res, statusCode, payload, extraHeaders = {}) {
  const body = `${JSON.stringify(payload)}\n`;
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    "referrer-policy": "no-referrer",
    ...extraHeaders,
  });
  res.end(body);
}

async function controlCenterAssetBody(res, asset) {
  let body;
  if (asset.url) {
    body = await fs.readFile(asset.url);
  } else {
    let lastError = null;
    for (const candidate of asset.urls || []) {
      try {
        body = await fs.readFile(candidate);
        break;
      } catch (error) {
        lastError = error;
        if (error?.code !== "ENOENT") throw error;
      }
    }
    if (!body) throw lastError || new Error("Control Center asset is unavailable.");
  }
  res.writeHead(200, {
    "content-type": asset.contentType,
    "content-length": body.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": CONTROL_CENTER_CSP,
    "referrer-policy": "no-referrer",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "x-frame-options": "DENY",
  });
  res.end(body);
}

function redactErrorMessage(value) {
  return String(value ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/giu, "Bearer [REDACTED]")
    .replace(
      /\b(authorization|token|secret|password|api[_-]?key|credential(?:token)?)\s*[:=]\s*[^\s,;]+/giu,
      "$1=[REDACTED]",
    )
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/gu, "[REDACTED_GITHUB_SECRET]")
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/gu, "[REDACTED_TELEGRAM_TOKEN]")
    .replace(
      /(?:\/Users\/|\/private\/var\/folders\/|\/var\/folders\/|\/tmp\/)[^\s"'`;,]*/gu,
      "[REDACTED_PATH]",
    );
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
  if (statusCode === 500) return "Control Center request failed.";
  return safeErrorMessage(error);
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function requestAuthority(req) {
  const host = String(req.headers.host || "").trim().toLowerCase();
  return host;
}

function allowedAuthorities(port) {
  return new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
  ]);
}

function allowedOrigins(port) {
  return new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
  ]);
}

async function readJsonRequest(req) {
  const contentType = String(req.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    const error = new Error("Content-Type application/json olmalı.");
    error.statusCode = 415;
    throw error;
  }

  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) {
      const error = new Error(`İstek gövdesi ${MAX_REQUEST_BYTES} bayt sınırını aşıyor.`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  if (bytes === 0) {
    const error = new Error("JSON istek gövdesi boş olamaz.");
    error.statusCode = 400;
    throw error;
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("İstek gövdesi geçerli JSON değil.");
    error.statusCode = 400;
    throw error;
  }
}

function assertMutationRequest(req, { port, csrfToken }) {
  const origin = String(req.headers.origin || "");
  if (!allowedOrigins(port).has(origin)) {
    const error = new Error("Control Center mutation Origin doğrulaması başarısız.");
    error.statusCode = 403;
    throw error;
  }
  const provided = String(req.headers["x-equinox-csrf"] || "");
  if (!provided || provided !== csrfToken) {
    const error = new Error("Control Center CSRF doğrulaması başarısız.");
    error.statusCode = 403;
    throw error;
  }
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
  } catch (error) {
    throw badRequest(error instanceof Error ? error.message : String(error));
  }
  let credential;
  if (Object.hasOwn(value, "credential")) {
    if (
      typeof value.credential !== "string" ||
      /[\u0000-\u001f\u007f]/u.test(value.credential) ||
      Buffer.byteLength(value.credential, "utf8") > AUTHENTICATED_HTTP_LIMITS.maxCredentialBytes
    ) {
      throw badRequest("Authenticated HTTP credential must be bounded control-character-free text.");
    }
    credential = value.credential;
  }
  return { profile, ...(credential !== undefined ? { credential } : {}) };
}

function validateTurnBudgetRequest(body) {
  const value = validateExactObject(body, ["enabled", "cutoffMinutes", "fallbackResetMinutes"], "Turn Budget settings");
  if (typeof value.enabled !== "boolean") throw badRequest("Turn Budget enabled must be boolean.");
  if (!Number.isInteger(value.cutoffMinutes) || value.cutoffMinutes < 5 || value.cutoffMinutes > 120) {
    throw badRequest("Turn Budget cutoffMinutes must be an integer between 5 and 120.");
  }
  const fallbackResetMinutes = value.fallbackResetMinutes === undefined ? 5 : value.fallbackResetMinutes;
  if (!Number.isInteger(fallbackResetMinutes) || fallbackResetMinutes < 1 || fallbackResetMinutes > value.cutoffMinutes) {
    throw badRequest("Turn Budget fallbackResetMinutes must be an integer between 1 and cutoffMinutes.");
  }
  return { enabled: value.enabled, cutoffMinutes: value.cutoffMinutes, fallbackResetMinutes };
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
  const value = validateExactObject(
    body,
    ["profileId", "method", "path", "query", "headers", "body", "timeoutMs"],
    "Authenticated HTTP profile test",
  );
  if (typeof value.profileId !== "string" || !/^[a-z][a-z0-9._-]{0,63}$/u.test(value.profileId)) {
    throw badRequest("Authenticated HTTP profile id is invalid.");
  }
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(value.method)) {
    throw badRequest("Authenticated HTTP test method is invalid.");
  }
  if (
    typeof value.path !== "string" ||
    value.path.length < 1 ||
    value.path.length > AUTHENTICATED_HTTP_LIMITS.maxPathChars
  ) {
    throw badRequest("Authenticated HTTP test path is invalid.");
  }
  if (value.query !== undefined && (value.query === null || typeof value.query !== "object" || Array.isArray(value.query))) {
    throw badRequest("Authenticated HTTP test query must be a JSON object.");
  }
  if (value.headers !== undefined && (value.headers === null || typeof value.headers !== "object" || Array.isArray(value.headers))) {
    throw badRequest("Authenticated HTTP test headers must be a JSON object.");
  }
  if (
    value.timeoutMs !== undefined &&
    (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 1000 || value.timeoutMs > AUTHENTICATED_HTTP_LIMITS.maxTimeoutMs)
  ) {
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
  if (!/^inc-[a-z0-9-]{4,176}$/u.test(incidentId)) throw badRequest("Doctor repair incidentId is invalid.");
  if (!REPAIR_RECIPE_ID_SET.has(recipeId)) throw badRequest("Doctor repair recipeId is invalid.");
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
  if (body.confirm !== "UNINSTALL") throw badRequest("Uninstall confirmation is invalid.");
  if (typeof body.removeUserData !== "boolean") throw badRequest("removeUserData must be boolean.");
  return Object.freeze({ removeUserData: body.removeUserData });
}

function parseTaskRoute(pathname) {
  const match = /^\/api\/v1\/tasks\/(task-[a-z0-9-]{6,80})(?:\/(complete|cancel|delete|continuation\/cancel|fresh-resume\/cancel|fresh-resume\/abandon))?$/u.exec(pathname);
  if (!match) return null;
  return Object.freeze({ taskId: match[1], action: match[2] || null });
}

function isAllowedControlCenterNavigationQuery(url) {
  if (url.pathname !== "/") return false;
  const keys = [...url.searchParams.keys()];
  if (keys.some((key) => key !== "section" && key !== "task")) return false;
  if (url.searchParams.getAll("section").length !== 1) return false;
  if (url.searchParams.getAll("task").length > 1) return false;
  if (url.searchParams.get("section") !== "tasks") return false;
  const taskId = url.searchParams.get("task");
  return taskId === null || /^task-[a-z0-9-]{6,80}$/u.test(taskId);
}

function validateTaskUpdateRequest(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw badRequest("Task update body must be a JSON object.");
  const allowed = new Set(["expectedRevision", "title", "objective", "completed", "next", "references"]);
  const keys = Object.keys(body);
  if (keys.some((key) => !allowed.has(key))) throw badRequest("Task update body contains an unsupported field.");
  if (!Number.isInteger(body.expectedRevision) || body.expectedRevision < 1) throw badRequest("expectedRevision must be a positive integer.");
  if (typeof body.title !== "string" || body.title.trim().length < 1 || body.title.trim().length > 160) throw badRequest("Task title must be 1-160 characters.");
  if (typeof body.objective !== "string" || body.objective.trim().length < 1 || Buffer.byteLength(body.objective.trim(), "utf8") > 12 * 1024) throw badRequest("Task objective is invalid or too large.");
  for (const field of ["completed", "next"]) {
    if (!Array.isArray(body[field]) || body[field].length > 64) throw badRequest(`${field} must be an array with at most 64 items.`);
    if (body[field].some((item) => typeof item !== "string" || !item.trim() || Buffer.byteLength(item.trim(), "utf8") > 1024)) throw badRequest(`${field} contains an invalid item.`);
  }
  if (!Array.isArray(body.references) || body.references.length > 32) throw badRequest("references must be an array with at most 32 items.");
  for (const reference of body.references) {
    if (!reference || typeof reference !== "object" || Array.isArray(reference)) throw badRequest("Each task reference must be an object.");
    if (Object.keys(reference).some((key) => !["type", "label", "value"].includes(key))) throw badRequest("Task reference contains an unsupported field.");
    if (!["project", "branch", "commit", "file", "url", "note"].includes(reference.type)) throw badRequest("Task reference type is unsupported.");
    if (typeof reference.label !== "string" || !reference.label.trim() || reference.label.trim().length > 120) throw badRequest("Task reference label is invalid.");
    if (typeof reference.value !== "string" || !reference.value.trim() || Buffer.byteLength(reference.value.trim(), "utf8") > 2048) throw badRequest("Task reference value is invalid.");
  }
  return body;
}

export function createEquinoxLocalControlApi({
  configManager,
  getStatus = async () => ({}),
  getTurnBudget = null,
  updateTurnBudget = null,
  getDoctorStatus = async () => ({}),
  getDoctorRepairs = null,
  applyDoctorRepair = null,
  getActivity = async () => [],
  getUpdateStatus = async () => ({}),
  getOnboardingStatus = async () => ({ available: false }),
  getTasks = null,
  getTask = null,
  updateTask = null,
  completeTask = null,
  cancelTask = null,
  deleteTask = null,
  cancelTaskContinuation = null,
  cancelTaskFreshResume = null,
  abandonTaskFreshResume = null,
  checkForUpdates = null,
  applyUpdate = null,
  configureTunnel = null,
  pauseAgent = null,
  resumeAgent = null,
  restartRuntime = null,
  scheduleUninstall = null,
  chooseFolder = null,
  updateBrowserSettings = null,
  openAgentBrowser = null,
  checkGitHub = null,
  getPeekabooStatus = null,
  getTelegramStatus = null,
  getWebImportSettings = null,
  updateWebImportDownloads = null,
  updateTelegramRemoteControl = null,
  updateTelegramDownloads = null,
  configureTelegram = null,
  startTelegramPairing = null,
  pollTelegramPairing = null,
  confirmTelegramPairing = null,
  cancelTelegramPairing = null,
  testTelegram = null,
  disconnectTelegram = null,
  getHttpProfiles = null,
  setHttpProfileManagement = null,
  upsertHttpProfile = null,
  testHttpProfile = null,
  deleteHttpProfile = null,
  recordInternalError = null,
  host = LOOPBACK_HOST,
  port,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
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
  if (host !== LOOPBACK_HOST) {
    throw new Error("Control Center API yalnız 127.0.0.1 loopback adresine bağlanabilir.");
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("Control Center API portu geçersiz.");
  }
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 60_000) {
    throw new Error("Control Center API request timeout değeri geçersiz.");
  }

  const state = {
    server: null,
    startedAt: null,
    actualPort: null,
    requestCount: 0,
    mutationCount: 0,
    csrfToken: randomBytes(32).toString("hex"),
  };

  const snapshot = () => Object.freeze({
    active: Boolean(state.server?.listening),
    host,
    configuredPort: port,
    port: state.actualPort,
    startedAt: state.startedAt,
    requestCount: state.requestCount,
    mutationCount: state.mutationCount,
  });

  const handler = async (req, res) => {
    res.setHeader("connection", "close");

    const actualPort = state.actualPort;
    if (!actualPort || !allowedAuthorities(actualPort).has(requestAuthority(req))) {
      jsonBody(res, 421, { ok: false, error: "Control Center Host doğrulaması başarısız." });
      return;
    }

    let url;
    try {
      url = new URL(req.url || "/", `http://${requestAuthority(req)}`);
    } catch {
      jsonBody(res, 400, { ok: false, error: "Geçersiz istek URL'si." });
      return;
    }

    if (url.search && !isAllowedControlCenterNavigationQuery(url)) {
      state.requestCount += 1;
      jsonBody(res, 400, { ok: false, error: "Control Center API query parametresi kabul etmiyor." });
      return;
    }

    if (!isBackgroundRefreshRequest(req, url)) state.requestCount += 1;

    try {
      const asset = CONTROL_CENTER_ASSETS.get(url.pathname);
      if (req.method === "GET" && asset) {
        await controlCenterAssetBody(res, asset);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/v1/health") {
        jsonBody(res, 200, { ok: true, controlCenter: snapshot() });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/v1/session") {
        jsonBody(res, 200, { ok: true, csrfToken: state.csrfToken });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/v1/config") {
        const configSnapshot = configManager.snapshot();
        jsonBody(res, 200, {
          ok: true,
          revision: configSnapshot.revision,
          loadedAt: configSnapshot.loadedAt,
          config: configSnapshot.config,
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/v1/status") {
        jsonBody(res, 200, { ok: true, status: await getStatus() });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/v1/turn-budget") {
        if (typeof getTurnBudget !== "function") { const error = new Error("Turn Budget is unavailable."); error.statusCode = 503; throw error; }
        jsonBody(res, 200, { ok: true, turnBudget: await getTurnBudget() });
        return;
      }

      if (req.method === "PUT" && url.pathname === "/api/v1/turn-budget") {
        assertMutationRequest(req, { port: actualPort, csrfToken: state.csrfToken });
        if (typeof updateTurnBudget !== "function") { const error = new Error("Turn Budget settings are unavailable."); error.statusCode = 503; throw error; }
        const turnBudget = await updateTurnBudget(validateTurnBudgetRequest(await readJsonRequest(req)));
        state.mutationCount += 1;
        jsonBody(res, 200, { ok: true, turnBudget });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/v1/doctor") {
        jsonBody(res, 200, { ok: true, doctor: await getDoctorStatus() });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/v1/doctor/repairs") {
        if (typeof getDoctorRepairs !== "function") { const error = new Error("Doctor repair planning is unavailable on this installation."); error.statusCode = 503; throw error; }
        jsonBody(res, 200, { ok: true, repairs: await getDoctorRepairs() });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/v1/doctor/repair") {
        assertMutationRequest(req, { port: actualPort, csrfToken: state.csrfToken });
        if (typeof applyDoctorRepair !== "function") { const error = new Error("Doctor repair is unavailable on this installation."); error.statusCode = 503; throw error; }
        const request = validateDoctorRepairRequest(await readJsonRequest(req));
        const result = await applyDoctorRepair(request);
        state.mutationCount += 1;
        jsonBody(res, 200, { ok: true, result });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/v1/activity") {
        jsonBody(res, 200, { ok: true, events: await getActivity() });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/v1/update") {
        jsonBody(res, 200, { ok: true, update: await getUpdateStatus() });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/v1/onboarding") {
        jsonBody(res, 200, { ok: true, onboarding: await getOnboardingStatus() });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/v1/tasks") {
        if (typeof getTasks !== "function") { const error = new Error("Task controls are unavailable on this installation."); error.statusCode = 503; throw error; }
        jsonBody(res, 200, { ok: true, tasks: await getTasks() });
        return;
      }

      const taskRoute = parseTaskRoute(url.pathname);
      if (req.method === "GET" && taskRoute?.action === null) {
        if (typeof getTask !== "function") { const error = new Error("Task controls are unavailable on this installation."); error.statusCode = 503; throw error; }
        jsonBody(res, 200, { ok: true, task: await getTask(taskRoute.taskId) });
        return;
      }

      if (req.method === "PUT" && taskRoute?.action === null) {
        assertMutationRequest(req, { port: actualPort, csrfToken: state.csrfToken });
        if (typeof updateTask !== "function") { const error = new Error("Task editing is unavailable on this installation."); error.statusCode = 503; throw error; }
        const task = await updateTask(taskRoute.taskId, validateTaskUpdateRequest(await readJsonRequest(req)));
        state.mutationCount += 1;
        jsonBody(res, 200, { ok: true, task });
        return;
      }

      if (req.method === "POST" && taskRoute?.action) {
        assertMutationRequest(req, { port: actualPort, csrfToken: state.csrfToken });
        validateEmptyObject(await readJsonRequest(req), "Task action");
        if (taskRoute.action === "delete") {
          if (typeof deleteTask !== "function") { const error = new Error("Task deletion is unavailable on this installation."); error.statusCode = 503; throw error; }
          const deleted = await deleteTask(taskRoute.taskId);
          state.mutationCount += 1;
          jsonBody(res, 200, { ok: true, deleted });
          return;
        }
        let task;
        if (taskRoute.action === "complete") {
          if (typeof completeTask !== "function") { const error = new Error("Task completion is unavailable on this installation."); error.statusCode = 503; throw error; }
          task = await completeTask(taskRoute.taskId);
        } else if (taskRoute.action === "cancel") {
          if (typeof cancelTask !== "function") { const error = new Error("Task cancellation is unavailable on this installation."); error.statusCode = 503; throw error; }
          task = await cancelTask(taskRoute.taskId);
        } else if (taskRoute.action === "continuation/cancel") {
          if (typeof cancelTaskContinuation !== "function") { const error = new Error("Auto Continue cancellation is unavailable on this installation."); error.statusCode = 503; throw error; }
          task = await cancelTaskContinuation(taskRoute.taskId);
        } else if (taskRoute.action === "fresh-resume/cancel") {
          if (typeof cancelTaskFreshResume !== "function") { const error = new Error("Fresh Chat Resume cancellation is unavailable on this installation."); error.statusCode = 503; throw error; }
          task = await cancelTaskFreshResume(taskRoute.taskId);
        } else {
          if (typeof abandonTaskFreshResume !== "function") { const error = new Error("Fresh Chat Resume recovery is unavailable on this installation."); error.statusCode = 503; throw error; }
          task = await abandonTaskFreshResume(taskRoute.taskId);
        }
        state.mutationCount += 1;
        jsonBody(res, 200, { ok: true, task });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/v1/agent/pause") {
        assertMutationRequest(req, { port: actualPort, csrfToken: state.csrfToken });
        validateEmptyObject(await readJsonRequest(req), "Agent pause");
        if (typeof pauseAgent !== "function") {
          const error = new Error("Agent emergency stop is unavailable on this installation.");
          error.statusCode = 503;
          throw error;
        }
        const agentControl = await pauseAgent();
        state.mutationCount += 1;
        jsonBody(res, 200, { ok: true, agentControl });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/v1/agent/resume") {
        assertMutationRequest(req, { port: actualPort, csrfToken: state.csrfToken });
        validateEmptyObject(await readJsonRequest(req), "Agent resume");
        if (typeof resumeAgent !== "function") {
          const error = new Error("Agent resume is unavailable on this installation.");
          error.statusCode = 503;
          throw error;
        }
        const agentControl = await resumeAgent();
        state.mutationCount += 1;
        jsonBody(res, 200, { ok: true, agentControl });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/v1/onboarding/tunnel") {
        assertMutationRequest(req, { port: actualPort, csrfToken: state.csrfToken });
        if (typeof configureTunnel !== "function") {
          const error = new Error("Tunnel onboarding is unavailable on this installation.");
          error.statusCode = 503;
          throw error;
        }
        const result = await configureTunnel(await readJsonRequest(req));
        state.mutationCount += 1;
        jsonBody(res, 202, { ok: true, result });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/v1/runtime/restart") {
        assertMutationRequest(req, { port: actualPort, csrfToken: state.csrfToken });
        validateEmptyObject(await readJsonRequest(req), "Runtime restart");
        if (typeof restartRuntime !== "function") {
          const error = new Error("Equinox Local restart is unavailable on this installation.");
          error.statusCode = 503;
          throw error;
        }
        const result = await restartRuntime();
        state.mutationCount += 1;
        jsonBody(res, 202, { ok: true, result });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/v1/uninstall") {
        assertMutationRequest(req, { port: actualPort, csrfToken: state.csrfToken });
        if (typeof scheduleUninstall !== "function") {
          const error = new Error("Equinox Local uninstall is unavailable on this installation.");
          error.statusCode = 503;
          throw error;
        }
        const request = validateUninstallRequest(await readJsonRequest(req));
        const result = await scheduleUninstall(request);
        state.mutationCount += 1;
        jsonBody(res, 202, { ok: true, result });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/v1/update/check") {
        assertMutationRequest(req, { port: actualPort, csrfToken: state.csrfToken });
        validateEmptyObject(await readJsonRequest(req), "Update check");
        if (typeof checkForUpdates !== "function") {
          const error = new Error("Equinox Local update check is unavailable on this installation.");
          error.statusCode = 503;
          throw error;
        }
        jsonBody(res, 200, { ok: true, update: await checkForUpdates() });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/v1/update/apply") {
        assertMutationRequest(req, { port: actualPort, csrfToken: state.csrfToken });
        validateEmptyObject(await readJsonRequest(req), "Update apply");
        if (typeof applyUpdate !== "function") {
          const error = new Error("Equinox Local update installation is unavailable on this installation.");
          error.statusCode = 503;
          throw error;
        }
        const result = await applyUpdate();
        state.mutationCount += 1;
        jsonBody(res, 202, { ok: true, result });
        return;
      }

      if (req.method === "PUT" && url.pathname === "/api/v1/config") {
        assertMutationRequest(req, { port: actualPort, csrfToken: state.csrfToken });
        const body = validateReplaceEnvelope(await readJsonRequest(req));
        const result = await configManager.replacePersisted(body.config, {
          expectedRevision: body.expectedRevision,
        });
        state.mutationCount += 1;
        jsonBody(res, 200, {
          ok: true,
          previousRevision: result.previousRevision,
          persistedRevision: result.persistedRevision,
          restartRequired: true,
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/v1/folder-picker") {
        assertMutationRequest(req, { port: actualPort, csrfToken: state.csrfToken });
        validateEmptyObject(await readJsonRequest(req), "Folder picker");
        if (typeof chooseFolder !== "function") {
          const error = new Error("Visual folder selection is unavailable on this installation.");
          error.statusCode = 501;
          throw error;
        }
        const selectedPath = await chooseFolder();
        jsonBody(res, 200, { ok: true, cancelled: selectedPath === null, path: selectedPath });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/v1/browser/agent/open") {
        assertMutationRequest(req, { port: actualPort, csrfToken: state.csrfToken });
        validateEmptyObject(await readJsonRequest(req), "Agent Browser open");
        if (typeof openAgentBrowser !== "function") {
          const error = new Error("Agent Browser launch control is unavailable.");
          error.statusCode = 503;
          throw error;
        }
        const agentBrowser = await openAgentBrowser();
        state.mutationCount += 1;
        jsonBody(res, 200, { ok: true, agentBrowser });
        return;
      }

      if (req.method === "PUT" && url.pathname === "/api/v1/browser/settings") {
        assertMutationRequest(req, { port: actualPort, csrfToken: state.csrfToken });
        if (typeof updateBrowserSettings !== "function") {
          const error = new Error("Equinox Browser settings control is unavailable.");
          error.statusCode = 503;
          throw error;
        }
        const settings = validateBrowserSettings(await readJsonRequest(req));
        const result = await updateBrowserSettings(settings);
        state.mutationCount += 1;
        jsonBody(res, 200, { ok: true, settings: result });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/v1/integrations/github") {
        if (typeof checkGitHub !== "function") {
          const error = new Error("GitHub integration status is unavailable.");
          error.statusCode = 503;
          throw error;
        }
        jsonBody(res, 200, { ok: true, github: await checkGitHub() });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/v1/integrations/peekaboo") {
        if (typeof getPeekabooStatus !== "function") {
          const error = new Error("Peekaboo integration status is unavailable.");
          error.statusCode = 503;
          throw error;
        }
        jsonBody(res, 200, { ok: true, peekaboo: await getPeekabooStatus() });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/v1/integrations/github/check") {
        assertMutationRequest(req, { port: actualPort, csrfToken: state.csrfToken });
        validateEmptyObject(await readJsonRequest(req), "GitHub check");
        if (typeof checkGitHub !== "function") {
          const error = new Error("GitHub integration check is unavailable.");
          error.statusCode = 503;
          throw error;
        }
        const result = await checkGitHub();
        jsonBody(res, 200, {
          ok: true,
          github: result,
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/v1/integrations/http-profiles") {
        if (typeof getHttpProfiles !== "function") {
          const error = new Error("Authenticated HTTP profiles are unavailable.");
          error.statusCode = 503;
          throw error;
        }
        jsonBody(res, 200, { ok: true, httpProfiles: await getHttpProfiles() });
        return;
      }

      if (req.method === "PUT" && url.pathname === "/api/v1/integrations/http-profiles/management") {
        assertMutationRequest(req, { port: actualPort, csrfToken: state.csrfToken });
        if (typeof setHttpProfileManagement !== "function") {
          const error = new Error("Authenticated HTTP profile management is unavailable.");
          error.statusCode = 503;
          throw error;
        }
        const request = validateHttpProfileManagementRequest(await readJsonRequest(req));
        const httpProfiles = await setHttpProfileManagement(request);
        state.mutationCount += 1;
        jsonBody(res, 200, { ok: true, httpProfiles });
        return;
      }

      if (req.method === "PUT" && url.pathname === "/api/v1/integrations/http-profiles/profile") {
        assertMutationRequest(req, { port: actualPort, csrfToken: state.csrfToken });
        if (typeof upsertHttpProfile !== "function") {
          const error = new Error("Authenticated HTTP profile setup is unavailable.");
          error.statusCode = 503;
          throw error;
        }
        const request = validateHttpProfileControlUpsert(await readJsonRequest(req));
        const profile = await upsertHttpProfile(request);
        state.mutationCount += 1;
        jsonBody(res, 200, { ok: true, profile });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/v1/integrations/http-profiles/test") {
        assertMutationRequest(req, { port: actualPort, csrfToken: state.csrfToken });
        if (typeof testHttpProfile !== "function") {
          const error = new Error("Authenticated HTTP profile test is unavailable.");
          error.statusCode = 503;
          throw error;
        }
        const request = validateHttpProfileTestRequest(await readJsonRequest(req));
        const result = await testHttpProfile(request);
        state.mutationCount += 1;
        jsonBody(res, 200, { ok: true, result });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/v1/integrations/http-profiles/delete") {
        assertMutationRequest(req, { port: actualPort, csrfToken: state.csrfToken });
        if (typeof deleteHttpProfile !== "function") {
          const error = new Error("Authenticated HTTP profile deletion is unavailable.");
          error.statusCode = 503;
          throw error;
        }
        const request = validateHttpProfileDeleteRequest(await readJsonRequest(req));
        const result = await deleteHttpProfile(request);
        state.mutationCount += 1;
        jsonBody(res, 200, { ok: true, result });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/v1/files/import-settings") {
        if (typeof getWebImportSettings !== "function") { const error = new Error("Web file transfer settings are unavailable."); error.statusCode = 503; throw error; }
        jsonBody(res, 200, { ok: true, webFileTransfer: await getWebImportSettings() });
        return;
      }

      if (req.method === "PUT" && url.pathname === "/api/v1/files/import-settings") {
        assertMutationRequest(req, { port: actualPort, csrfToken: state.csrfToken });
        if (typeof updateWebImportDownloads !== "function") { const error = new Error("Web file transfer settings control is unavailable."); error.statusCode = 503; throw error; }
        const body = await readJsonRequest(req);
        const keys = body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body) : [];
        if (keys.length !== 1 || keys[0] !== "path" || !(body.path === null || typeof body.path === "string")) {
          const error = new Error("Web file transfer settings accept only path as an absolute folder path or null for default."); error.statusCode = 400; throw error;
        }
        const webFileTransfer = await updateWebImportDownloads({ path: body.path });
        state.mutationCount += 1;
        jsonBody(res, 200, { ok: true, webFileTransfer });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/v1/integrations/telegram") {
        if (typeof getTelegramStatus !== "function") {
          const error = new Error("Telegram integration is unavailable.");
          error.statusCode = 503;
          throw error;
        }
        jsonBody(res, 200, { ok: true, telegram: await getTelegramStatus() });
        return;
      }

      if (req.method === "PUT" && url.pathname === "/api/v1/integrations/telegram/remote-control") {
        assertMutationRequest(req, { port: actualPort, csrfToken: state.csrfToken });
        if (typeof updateTelegramRemoteControl !== "function") {
          const error = new Error("Telegram remote-control settings are unavailable.");
          error.statusCode = 503;
          throw error;
        }
        const body = await readJsonRequest(req);
        const keys = body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body) : [];
        if (keys.length !== 1 || keys[0] !== "enabled" || typeof body.enabled !== "boolean") {
          const error = new Error("Telegram remote-control settings accept only enabled as a boolean.");
          error.statusCode = 400;
          throw error;
        }
        const remoteControl = await updateTelegramRemoteControl({ enabled: body.enabled });
        state.mutationCount += 1;
        jsonBody(res, 200, { ok: true, remoteControl });
        return;
      }

      if (req.method === "PUT" && url.pathname === "/api/v1/integrations/telegram/downloads") {
        assertMutationRequest(req, { port: actualPort, csrfToken: state.csrfToken });
        if (typeof updateTelegramDownloads !== "function") {
          const error = new Error("Telegram download location control is unavailable.");
          error.statusCode = 503;
          throw error;
        }
        const body = await readJsonRequest(req);
        const keys = body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body) : [];
        if (keys.length !== 1 || keys[0] !== "path" || !(body.path === null || typeof body.path === "string")) {
          const error = new Error("Telegram download settings accept only path as an absolute folder path or null for default.");
          error.statusCode = 400;
          throw error;
        }
        const downloads = await updateTelegramDownloads({ path: body.path });
        state.mutationCount += 1;
        jsonBody(res, 200, { ok: true, downloads });
        return;
      }

      if (req.method === "PUT" && url.pathname === "/api/v1/integrations/telegram") {
        assertMutationRequest(req, { port: actualPort, csrfToken: state.csrfToken });
        if (typeof configureTelegram !== "function") {
          const error = new Error("Telegram integration setup is unavailable.");
          error.statusCode = 503;
          throw error;
        }
        const telegram = await configureTelegram(await readJsonRequest(req));
        state.mutationCount += 1;
        jsonBody(res, 200, { ok: true, telegram });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/v1/integrations/telegram/pair/start") {
        assertMutationRequest(req, { port: actualPort, csrfToken: state.csrfToken });
        if (typeof startTelegramPairing !== "function") {
          const error = new Error("Telegram pairing is unavailable.");
          error.statusCode = 503;
          throw error;
        }
        const body = await readJsonRequest(req);
        const keys = body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body) : [];
        if (keys.length !== 1 || keys[0] !== "botToken" || typeof body.botToken !== "string") {
          const error = new Error("Telegram pairing start accepts only botToken.");
          error.statusCode = 400;
          throw error;
        }
        const pairing = await startTelegramPairing({ botToken: body.botToken });
        state.mutationCount += 1;
        jsonBody(res, 200, { ok: true, pairing });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/v1/integrations/telegram/pair") {
        if (typeof pollTelegramPairing !== "function") {
          const error = new Error("Telegram pairing status is unavailable.");
          error.statusCode = 503;
          throw error;
        }
        jsonBody(res, 200, { ok: true, pairing: await pollTelegramPairing() });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/v1/integrations/telegram/pair/confirm") {
        assertMutationRequest(req, { port: actualPort, csrfToken: state.csrfToken });
        validateEmptyObject(await readJsonRequest(req), "Telegram pairing confirmation");
        if (typeof confirmTelegramPairing !== "function") {
          const error = new Error("Telegram pairing confirmation is unavailable.");
          error.statusCode = 503;
          throw error;
        }
        const telegram = await confirmTelegramPairing();
        state.mutationCount += 1;
        jsonBody(res, 200, { ok: true, telegram });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/v1/integrations/telegram/pair/cancel") {
        assertMutationRequest(req, { port: actualPort, csrfToken: state.csrfToken });
        validateEmptyObject(await readJsonRequest(req), "Telegram pairing cancellation");
        if (typeof cancelTelegramPairing !== "function") {
          const error = new Error("Telegram pairing cancellation is unavailable.");
          error.statusCode = 503;
          throw error;
        }
        const result = await cancelTelegramPairing();
        state.mutationCount += 1;
        jsonBody(res, 200, { ok: true, result });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/v1/integrations/telegram/test") {
        assertMutationRequest(req, { port: actualPort, csrfToken: state.csrfToken });
        validateEmptyObject(await readJsonRequest(req), "Telegram test");
        if (typeof testTelegram !== "function") {
          const error = new Error("Telegram integration test is unavailable.");
          error.statusCode = 503;
          throw error;
        }
        const result = await testTelegram();
        state.mutationCount += 1;
        jsonBody(res, 200, { ok: true, result });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/v1/integrations/telegram/disconnect") {
        assertMutationRequest(req, { port: actualPort, csrfToken: state.csrfToken });
        validateEmptyObject(await readJsonRequest(req), "Telegram disconnect");
        if (typeof disconnectTelegram !== "function") {
          const error = new Error("Telegram integration disconnect is unavailable.");
          error.statusCode = 503;
          throw error;
        }
        const result = await disconnectTelegram();
        state.mutationCount += 1;
        jsonBody(res, 200, { ok: true, result });
        return;
      }

      if (req.method === "OPTIONS") {
        jsonBody(res, 405, { ok: false, error: "CORS preflight desteklenmiyor." }, { allow: "GET, PUT, POST" });
        return;
      }

      jsonBody(res, 404, { ok: false, error: "Control Center API endpoint bulunamadı." });
    } catch (error) {
      const statusCode = Number.isInteger(error?.statusCode)
        ? error.statusCode
        : error?.code === EQUINOX_LOCAL_CONFIG_ERROR_CODES.revisionConflict || error?.code === TASK_CAPSULE_ERROR_CODES.revisionConflict || error?.code === TASK_CAPSULE_ERROR_CODES.terminalRequired
          ? 409
          : error?.code === TASK_CAPSULE_ERROR_CODES.notFound
            ? 404
            : 500;
      if (statusCode === 500 && recordInternalError) {
        void Promise.resolve(recordInternalError(error)).catch(() => {});
      }
      jsonBody(res, statusCode, { ok: false, error: publicErrorMessage(error, statusCode) });
    }
  };

  const start = async () => {
    if (state.server?.listening) return snapshot();
    const server = http.createServer((req, res) => {
      void handler(req, res).catch((error) => {
        if (res.writableEnded || res.destroyed) return;
        try {
          if (recordInternalError) void Promise.resolve(recordInternalError(error)).catch(() => {});
          jsonBody(res, 500, { ok: false, error: publicErrorMessage(error, 500) });
        } catch {
          res.destroy();
        }
      });
    });
    server.keepAliveTimeout = 1_000;
    server.headersTimeout = 5_000;
    // Bound inbound request delivery only. Handler work may legitimately outlive
    // this window; emitting an application-level 408 while a mutation continues
    // would make the operation state ambiguous to the caller.
    server.requestTimeout = requestTimeoutMs;
    server.maxHeadersCount = 64;

    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({ host, port, exclusive: true });
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      await new Promise((resolve) => server.close(resolve));
      throw new Error("Control Center API loopback listener adresi doğrulanamadı.");
    }
    state.server = server;
    state.actualPort = address.port;
    state.startedAt = new Date().toISOString();
    return snapshot();
  };

  const close = async () => {
    const server = state.server;
    state.server = null;
    state.actualPort = null;
    if (!server) return;
    await new Promise((resolve) => server.close(() => resolve()));
  };

  return Object.freeze({ start, close, snapshot });
}

export const __test = Object.freeze({
  LOOPBACK_HOST,
  MAX_REQUEST_BYTES,
  allowedAuthorities,
  allowedOrigins,
  validateReplaceEnvelope,
  validateBrowserSettings,
  validateEmptyObject,
});
