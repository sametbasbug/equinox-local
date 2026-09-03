import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";

const LOOPBACK_HOST = "127.0.0.1";
const MAX_REQUEST_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
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
const CONTROL_CENTER_ASSETS = new Map([
  ["/", Object.freeze({
    url: new URL("./equinox-control-center.html", import.meta.url),
    contentType: "text/html; charset=utf-8",
  })],
  ["/assets/control-center.css", Object.freeze({
    url: new URL("./equinox-control-center.css", import.meta.url),
    contentType: "text/css; charset=utf-8",
  })],
  ["/assets/control-center.js", Object.freeze({
    url: new URL("./equinox-control-center.js", import.meta.url),
    contentType: "text/javascript; charset=utf-8",
  })],
  ["/assets/equinox-local.png", Object.freeze({
    urls: Object.freeze([
      new URL("./equinox-local-app/EquinoxLocal.png", import.meta.url),
      new URL("../equinox-local-app/EquinoxLocal.png", import.meta.url),
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

function safeErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/gu, " ").slice(0, 1000);
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
    throw new Error("Config güncelleme gövdesi JSON nesnesi olmalı.");
  }
  const keys = Object.keys(body);
  if (keys.some((key) => !["expectedRevision", "config"].includes(key))) {
    throw new Error("Config güncelleme gövdesinde desteklenmeyen alan var.");
  }
  if (typeof body.expectedRevision !== "string" || !/^[a-f0-9]{64}$/u.test(body.expectedRevision)) {
    throw new Error("expectedRevision 64 karakterlik SHA-256 olmalı.");
  }
  if (body.config === null || typeof body.config !== "object" || Array.isArray(body.config)) {
    throw new Error("config JSON nesnesi olmalı.");
  }
  return body;
}

function validateBrowserSettings(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Browser settings body must be a JSON object.");
  }
  const keys = Object.keys(body);
  if (keys.length < 1 || keys.some((key) => !["context", "enabled", "agentCursorEnabled", "agentCursorName"].includes(key))) {
    throw new Error("Browser settings body has no supported settings or contains an unsupported field.");
  }
  if (Object.hasOwn(body, "context") && !["agent", "user"].includes(body.context)) {
    throw new Error("Browser settings context must be agent or user.");
  }
  if (Object.hasOwn(body, "enabled") && typeof body.enabled !== "boolean") {
    throw new Error("enabled must be boolean.");
  }
  if (Object.hasOwn(body, "agentCursorEnabled") && typeof body.agentCursorEnabled !== "boolean") {
    throw new Error("agentCursorEnabled must be boolean.");
  }
  if (Object.hasOwn(body, "agentCursorName")) {
    if (typeof body.agentCursorName !== "string" || body.agentCursorName.length > 64 || /[\u0000-\u001f\u007f]/u.test(body.agentCursorName)) {
      throw new Error("agentCursorName must be bounded control-character-free text.");
    }
  }
  return body;
}

function validateEmptyObject(body, label) {
  if (body === null || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0) {
    throw new Error(`${label} body must be an empty JSON object.`);
  }
  return body;
}

function validateUninstallRequest(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Uninstall body must be a JSON object.");
  }
  const keys = Object.keys(body).sort();
  if (keys.length !== 2 || keys[0] !== "confirm" || keys[1] !== "removeUserData") {
    throw new Error("Uninstall accepts only confirm and removeUserData.");
  }
  if (body.confirm !== "UNINSTALL") throw new Error("Uninstall confirmation is invalid.");
  if (typeof body.removeUserData !== "boolean") throw new Error("removeUserData must be boolean.");
  return Object.freeze({ removeUserData: body.removeUserData });
}

export function createEquinoxLocalControlApi({
  configManager,
  getStatus = async () => ({}),
  getDoctorStatus = async () => ({}),
  getActivity = async () => [],
  getUpdateStatus = async () => ({}),
  getOnboardingStatus = async () => ({ available: false }),
  checkForUpdates = null,
  applyUpdate = null,
  configureTunnel = null,
  restartRuntime = null,
  scheduleUninstall = null,
  chooseFolder = null,
  updateBrowserSettings = null,
  openAgentBrowser = null,
  checkGitHub = null,
  getPeekabooStatus = null,
  getTelegramStatus = null,
  configureTelegram = null,
  testTelegram = null,
  disconnectTelegram = null,
  host = LOOPBACK_HOST,
  port,
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
    state.requestCount += 1;
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

    if (url.search) {
      jsonBody(res, 400, { ok: false, error: "Control Center API query parametresi kabul etmiyor." });
      return;
    }

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

      if (req.method === "GET" && url.pathname === "/api/v1/doctor") {
        jsonBody(res, 200, { ok: true, doctor: await getDoctorStatus() });
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

      if (req.method === "GET" && url.pathname === "/api/v1/integrations/telegram") {
        if (typeof getTelegramStatus !== "function") {
          const error = new Error("Telegram integration is unavailable.");
          error.statusCode = 503;
          throw error;
        }
        jsonBody(res, 200, { ok: true, telegram: await getTelegramStatus() });
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
      const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 400;
      jsonBody(res, statusCode, { ok: false, error: safeErrorMessage(error) });
    }
  };

  const start = async () => {
    if (state.server?.listening) return snapshot();
    const server = http.createServer((req, res) => {
      const timer = setTimeout(() => {
        if (!res.headersSent) {
          jsonBody(res, 408, { ok: false, error: "Control Center isteği zaman aşımına uğradı." });
        } else {
          res.destroy();
        }
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      void handler(req, res).finally(() => clearTimeout(timer));
    });
    server.keepAliveTimeout = 1_000;
    server.headersTimeout = 5_000;
    server.requestTimeout = REQUEST_TIMEOUT_MS;
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
