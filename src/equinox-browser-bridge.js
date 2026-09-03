import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import {
  equinoxBrowserSocketPath,
  prepareEquinoxBrowserSocketDirectory,
} from "./equinox-browser-socket.js";

export const EQUINOX_BROWSER_HOST_NAME = "dev.equinox.browser";
export const EQUINOX_BROWSER_EXTENSION_ID = "npdneefcobilfkjlihghjgjnknenhfoj";
export const EQUINOX_BROWSER_LEGACY_EXTENSION_ID = "kdjmfldngbfaillaamoinegmogfkhdfn";
export const EQUINOX_BROWSER_EXTENSION_IDS = Object.freeze([EQUINOX_BROWSER_EXTENSION_ID]);
export const EQUINOX_BROWSER_MIGRATION_EXTENSION_IDS = Object.freeze([
  EQUINOX_BROWSER_EXTENSION_ID,
  EQUINOX_BROWSER_LEGACY_EXTENSION_ID,
]);
export const EQUINOX_BROWSER_SOCKET_PATH = equinoxBrowserSocketPath();
export const EQUINOX_BROWSER_CONTEXTS = Object.freeze(["agent", "user"]);
export const DEFAULT_EQUINOX_BROWSER_CONTEXT = "user";

const MAX_STREAMED_RESPONSE_CHARS = 48 * 1024 * 1024;
const MAX_STREAM_CHUNKS = 128;
const DEFAULT_PAIRING_TIMEOUT_MS = 10 * 60 * 1000;
const INSTANCE_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;

function nowIso() {
  return new Date().toISOString();
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function writeLine(socket, message) {
  socket.write(`${JSON.stringify(message)}\n`);
}

function normalizeBrowserContext(value, { allowUnassigned = false } = {}) {
  if (EQUINOX_BROWSER_CONTEXTS.includes(value)) return value;
  if (allowUnassigned && (value == null || value === "unassigned")) return "unassigned";
  throw new Error(`Unknown Equinox Browser context: ${String(value)}`);
}

function normalizeInstanceId(value) {
  if (value == null || value === "") return null;
  const normalized = String(value).trim();
  if (!INSTANCE_ID_PATTERN.test(normalized)) {
    throw new Error("Equinox Browser instance id is invalid");
  }
  return normalized.toLowerCase();
}

export function createEquinoxBrowserBridge({
  socketPath = EQUINOX_BROWSER_SOCKET_PATH,
  expectedExtensionIds = EQUINOX_BROWSER_EXTENSION_IDS,
  callTimeoutMs = 15_000,
  recordEvent = () => {},
  handleExtensionRequest = null,
} = {}) {
  let server = null;
  let startedAt = null;
  let nextCommandId = 1;
  let pairingExpectation = null;
  const pending = new Map();
  const connections = new Set();
  const contexts = new Map();

  const acceptedExtensionIds = [...new Set(expectedExtensionIds)];
  if (acceptedExtensionIds.length < 1 || acceptedExtensionIds.some((id) => !/^[a-p]{32}$/.test(id))) {
    throw new Error("Equinox Browser expected extension ids are invalid");
  }
  if (handleExtensionRequest != null && typeof handleExtensionRequest !== "function") {
    throw new Error("Equinox Browser extension request handler is invalid");
  }
  const expectedExtensionIdSet = new Set(acceptedExtensionIds);
  const expectedOrigins = acceptedExtensionIds.map((id) => `chrome-extension://${id}/`);
  const expectedOriginSet = new Set(expectedOrigins);
  const expectedExtensionId = acceptedExtensionIds[0];
  const expectedOrigin = expectedOrigins[0];

  function emit(type, data = {}) {
    try {
      const pendingEvent = recordEvent({
        component: "equinox-browser",
        type,
        at: nowIso(),
        ...data,
      });
      if (pendingEvent && typeof pendingEvent.catch === "function") {
        void pendingEvent.catch(() => {});
      }
    } catch {
      // Observability must never break browser control.
    }
  }

  function pairingSnapshot() {
    if (!pairingExpectation) return null;
    if (Date.now() >= pairingExpectation.expiresAtMs) {
      pairingExpectation = null;
      return null;
    }
    return {
      context: pairingExpectation.context,
      startedAt: pairingExpectation.startedAt,
      expiresAt: new Date(pairingExpectation.expiresAtMs).toISOString(),
    };
  }

  function consumePairingExpectation() {
    const current = pairingSnapshot();
    if (!current) return null;
    pairingExpectation = null;
    return current.context;
  }

  function rejectPendingForState(state, reason) {
    for (const [id, waiter] of pending.entries()) {
      if (waiter.state !== state) continue;
      clearTimeout(waiter.timer);
      pending.delete(id);
      waiter.reject(new Error(reason));
    }
  }

  function clearConnection(state, reason = "native host disconnected", { destroy = true } = {}) {
    if (!state || state.closed) return;
    state.closed = true;
    connections.delete(state);
    if (state.context && contexts.get(state.context) === state) contexts.delete(state.context);
    rejectPendingForState(state, reason);
    if (destroy && state.socket && !state.socket.destroyed) {
      state.socket.removeAllListeners();
      state.socket.destroy();
    }
    emit("disconnected", {
      reason,
      context: state.context ?? null,
      instanceId: state.instanceId ?? null,
    });
  }

  function rejectWaiter(key, waiter, reason) {
    pending.delete(key);
    clearTimeout(waiter.timer);
    waiter.reject(new Error(reason));
  }

  function snapshotState(state) {
    if (!state || state.closed) {
      return {
        ready: false,
        connectedAt: null,
        host: null,
        extension: null,
      };
    }
    return {
      ready: Boolean(state.hostInfo && state.extensionInfo),
      connectedAt: state.connectedAt,
      host: state.hostInfo,
      extension: state.extensionInfo,
    };
  }

  function snapshotContext(context) {
    const normalized = normalizeBrowserContext(context);
    return {
      context: normalized,
      ...snapshotState(contexts.get(normalized) ?? null),
    };
  }

  function contextIsReady(context) {
    const state = contexts.get(normalizeBrowserContext(context));
    return Boolean(state && !state.closed && state.hostInfo && state.extensionInfo);
  }

  function assertContextAvailable(context) {
    const normalized = normalizeBrowserContext(context);
    const state = contexts.get(normalized);
    if (!state || state.closed || !state.hostInfo || !state.extensionInfo || state.socket.destroyed) {
      throw new Error(
        normalized === "agent"
          ? "Equinox Agent Browser bağlı değil. Control Center'dan Agent Browser'ı açıp Equinox Browser uzantısını bu izole profile kurun."
          : "Equinox Browser kullanıcı profili bağlı değil. Chrome uzantısının yüklü ve Native Messaging host'un kayıtlı olduğundan emin olun.",
      );
    }
    return state;
  }

  async function callOnState(state, method, args = {}, { timeoutMs = callTimeoutMs } = {}) {
    if (!state || state.closed || !state.socket || state.socket.destroyed) {
      throw new Error("Equinox Browser native host bağlı değil.");
    }
    const id = String(nextCommandId++);
    const command = {
      type: "command",
      id,
      method,
      args: args ?? {},
    };

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Equinox Browser command timed out: ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer, method, stream: null, state });
      try {
        writeLine(state.socket, { type: "host.send", message: command });
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  function persistAssignedContext(state, context) {
    if (!state.instanceId) return;
    void callOnState(state, "context.set", { context }, { timeoutMs: 5_000 })
      .then(() => emit("context_persisted", { context, instanceId: state.instanceId }))
      .catch((error) => emit("context_persist_failed", {
        context,
        instanceId: state.instanceId,
        message: errorMessage(error),
      }));
  }

  function assignContext(state, reportedContext) {
    const normalizedReported = normalizeBrowserContext(reportedContext, { allowUnassigned: true });
    let context = normalizedReported;
    let shouldPersist = false;

    if (context === "unassigned") {
      const expected = consumePairingExpectation();
      if (expected) {
        if (!state.instanceId) {
          throw new Error("Agent Browser pairing requires an Equinox Browser build with per-profile instance identity");
        }
        context = expected;
        shouldPersist = true;
      } else if (!contexts.has("user")) {
        context = "user";
        shouldPersist = Boolean(state.instanceId);
      } else {
        return null;
      }
    }

    const existing = contexts.get(context);
    if (existing && existing !== state) {
      if (state.instanceId && existing.instanceId === state.instanceId) {
        clearConnection(existing, `Equinox Browser ${context} context reconnected`);
      } else {
        throw new Error(`Equinox Browser context is already connected: ${context}`);
      }
    }

    state.context = context;
    contexts.set(context, state);
    if (shouldPersist) persistAssignedContext(state, context);
    return context;
  }

  function sendExtensionResponse(state, id, { ok, result = null, error = null } = {}) {
    if (!state?.socket || state.closed || state.socket.destroyed) return;
    writeLine(state.socket, {
      type: "host.send",
      message: ok
        ? { type: "extension.response", id, ok: true, result }
        : { type: "extension.response", id, ok: false, error: { message: String(error || "Equinox Local request failed").slice(0, 500) } },
    });
  }

  async function dispatchExtensionRequest(state, message) {
    const id = typeof message?.id === "string" || typeof message?.id === "number"
      ? String(message.id)
      : null;
    if (!id || id.length > 128) return;
    try {
      if (!state.hostInfo || !state.extensionInfo || !state.context) {
        throw new Error("Equinox Browser context is not ready for Local actions.");
      }
      const method = typeof message.method === "string" ? message.method : "";
      if (!/^[a-z0-9._-]{1,80}$/u.test(method)) {
        throw new Error("Equinox Local action name is invalid.");
      }
      const args = message.args ?? {};
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        throw new Error("Equinox Local action arguments must be an object.");
      }
      if (typeof handleExtensionRequest !== "function") {
        throw new Error("Equinox Local does not expose extension-initiated actions in this runtime.");
      }
      const result = await handleExtensionRequest({
        context: state.context,
        instanceId: state.instanceId,
        method,
        args,
      });
      sendExtensionResponse(state, id, { ok: true, result: result ?? null });
      emit("extension_request", { context: state.context, method, ok: true });
    } catch (error) {
      const messageText = errorMessage(error);
      sendExtensionResponse(state, id, { ok: false, error: messageText });
      emit("extension_request", { context: state.context ?? null, method: message?.method ?? null, ok: false, message: messageText.slice(0, 500) });
    }
  }

  function handleExtensionMessage(state, message) {
    if (message?.type === "extension.hello") {
      if (!expectedExtensionIdSet.has(message.extensionId)) {
        clearConnection(state, `Unexpected extension id: ${message.extensionId || "unknown"}`);
        return;
      }
      if (!state.hostInfo || state.hostInfo.extensionId !== message.extensionId) {
        clearConnection(state, `Extension id does not match native host origin: ${message.extensionId || "unknown"}`);
        return;
      }

      try {
        state.instanceId = normalizeInstanceId(message.instanceId);
        const reportedContext = message.browserContext ?? "unassigned";
        const assignedContext = assignContext(state, reportedContext);
        state.extensionInfo = {
          extensionId: message.extensionId,
          extensionVersion: message.extensionVersion ?? null,
          protocolVersion: message.protocolVersion ?? null,
          capabilities: Array.isArray(message.capabilities) ? message.capabilities : [],
          lastNativeDisconnectError: message.lastNativeDisconnectError ?? null,
          instanceId: state.instanceId,
          browserContext: assignedContext,
          connectedAt: nowIso(),
        };
        state.connectedAt = nowIso();

        if (!assignedContext) {
          emit("extension_unassigned", {
            extensionVersion: state.extensionInfo.extensionVersion,
            instanceId: state.instanceId,
          });
          return;
        }
        emit("extension_ready", {
          context: assignedContext,
          instanceId: state.instanceId,
          extensionVersion: state.extensionInfo.extensionVersion,
          lastNativeDisconnectError: state.extensionInfo.lastNativeDisconnectError,
        });
      } catch (error) {
        clearConnection(state, errorMessage(error));
      }
      return;
    }

    if (message?.type === "extension.request") {
      void dispatchExtensionRequest(state, message);
      return;
    }

    if (message?.type === "response.chunk" && message.id != null) {
      const key = String(message.id);
      const waiter = pending.get(key);
      if (!waiter || waiter.state !== state) return;
      const field = message.field;
      const index = Number(message.index);
      const total = Number(message.total);
      const data = message.data;
      if (
        field !== "data" ||
        !Number.isInteger(index) ||
        !Number.isInteger(total) ||
        total < 1 ||
        total > MAX_STREAM_CHUNKS ||
        index < 0 ||
        index >= total ||
        typeof data !== "string"
      ) {
        rejectWaiter(key, waiter, "Equinox Browser streamed response metadata is invalid");
        return;
      }
      if (!waiter.stream) {
        waiter.stream = { field, total, chunks: new Array(total), receivedChars: 0 };
      }
      if (waiter.stream.field !== field || waiter.stream.total !== total) {
        rejectWaiter(key, waiter, "Equinox Browser streamed response changed shape mid-transfer");
        return;
      }
      if (waiter.stream.chunks[index] != null) {
        rejectWaiter(key, waiter, "Equinox Browser streamed response repeated a chunk");
        return;
      }
      waiter.stream.receivedChars += data.length;
      if (waiter.stream.receivedChars > MAX_STREAMED_RESPONSE_CHARS) {
        rejectWaiter(key, waiter, "Equinox Browser streamed response exceeded the safety limit");
        return;
      }
      waiter.stream.chunks[index] = data;
      return;
    }

    if (message?.type !== "response" || message.id == null) return;
    const key = String(message.id);
    const waiter = pending.get(key);
    if (!waiter || waiter.state !== state) return;
    pending.delete(key);
    clearTimeout(waiter.timer);
    if (message.ok) {
      let result = message.result ?? null;
      const descriptor = result?.streamed;
      if (descriptor) {
        const stream = waiter.stream;
        if (
          !stream ||
          descriptor.field !== stream.field ||
          descriptor.chunks !== stream.total ||
          stream.chunks.some((chunk) => typeof chunk !== "string")
        ) {
          waiter.reject(new Error("Equinox Browser streamed response is incomplete"));
          return;
        }
        const { streamed: _streamed, ...metadata } = result;
        result = { ...metadata, [stream.field]: stream.chunks.join("") };
      } else if (waiter.stream) {
        waiter.reject(new Error("Equinox Browser streamed response ended without a descriptor"));
        return;
      }
      waiter.resolve(result);
    } else waiter.reject(new Error(message.error?.message || message.error || "Browser command failed"));
  }

  function handleHostLine(state, line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      clearConnection(state, "Native host sent invalid JSON");
      return;
    }

    if (message?.type === "host.hello") {
      if (!expectedOriginSet.has(message.origin)) {
        clearConnection(state, `Unexpected native host origin: ${message.origin || "unknown"}`);
        return;
      }
      const matchedExtensionId = acceptedExtensionIds.find(
        (id) => message.origin === `chrome-extension://${id}/`,
      );
      state.hostInfo = {
        origin: message.origin,
        extensionId: matchedExtensionId,
        pid: message.pid ?? null,
        version: message.version ?? null,
      };
      state.connectedAt = nowIso();
      emit("host_connected", { pid: state.hostInfo.pid });
      return;
    }

    if (message?.type === "extension.message") {
      handleExtensionMessage(state, message.message);
    }
  }

  function attachHost(socket) {
    const state = {
      socket,
      buffer: "",
      hostInfo: null,
      extensionInfo: null,
      connectedAt: null,
      instanceId: null,
      context: null,
      closed: false,
    };
    connections.add(state);

    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      state.buffer += chunk;
      while (true) {
        const newline = state.buffer.indexOf("\n");
        if (newline < 0) break;
        const line = state.buffer.slice(0, newline);
        state.buffer = state.buffer.slice(newline + 1);
        handleHostLine(state, line);
      }
    });
    socket.on("error", (error) => {
      emit("host_error", {
        context: state.context ?? null,
        instanceId: state.instanceId ?? null,
        message: errorMessage(error),
      });
    });
    socket.on("close", () => {
      clearConnection(state, "native host disconnected", { destroy: false });
    });
  }

  async function start() {
    if (server) return snapshot();
    if (socketPath === EQUINOX_BROWSER_SOCKET_PATH) {
      await prepareEquinoxBrowserSocketDirectory();
    } else {
      await fs.mkdir(path.dirname(socketPath), { recursive: true });
    }
    await fs.rm(socketPath, { force: true }).catch(() => {});

    server = net.createServer(attachHost);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    await fs.chmod(socketPath, 0o600).catch(() => {});
    startedAt = nowIso();
    emit("started", { socketPath });
    return snapshot();
  }

  async function close() {
    for (const state of [...connections]) {
      clearConnection(state, "Equinox Browser bridge closed");
    }
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Equinox Browser bridge closed"));
    }
    pending.clear();
    contexts.clear();
    pairingExpectation = null;
    if (server) {
      const closingServer = server;
      server = null;
      await new Promise((resolve) => closingServer.close(() => resolve()));
    }
    await fs.rm(socketPath, { force: true }).catch(() => {});
    emit("closed");
  }

  function snapshot() {
    const user = snapshotContext("user");
    const agent = snapshotContext("agent");
    const unassigned = [...connections]
      .filter((state) => !state.closed && !state.context)
      .map((state) => ({
        connectedAt: state.connectedAt,
        host: state.hostInfo,
        extension: state.extensionInfo,
      }));
    return {
      active: Boolean(server),
      ready: user.ready,
      socketPath,
      expectedExtensionId,
      expectedExtensionIds: acceptedExtensionIds,
      expectedOrigin,
      expectedOrigins,
      startedAt,
      connectedAt: user.connectedAt,
      host: user.host,
      extension: user.extension,
      pendingCount: pending.size,
      connectionCount: connections.size,
      contexts: { agent, user },
      unassigned,
      pairing: pairingSnapshot(),
    };
  }

  async function waitUntilReady(timeoutMs = 8_000, { context = DEFAULT_EQUINOX_BROWSER_CONTEXT } = {}) {
    const normalized = normalizeBrowserContext(context);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (contextIsReady(normalized)) {
        const selected = snapshotContext(normalized);
        return {
          ...snapshot(),
          context: normalized,
          ready: selected.ready,
          connectedAt: selected.connectedAt,
          host: selected.host,
          extension: selected.extension,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assertContextAvailable(normalized);
  }

  async function call(method, args = {}, {
    timeoutMs = callTimeoutMs,
    context = DEFAULT_EQUINOX_BROWSER_CONTEXT,
  } = {}) {
    const normalized = normalizeBrowserContext(context);
    if (!contextIsReady(normalized)) {
      await waitUntilReady(Math.min(timeoutMs, 8_000), { context: normalized });
    }
    return await callOnState(assertContextAvailable(normalized), method, args, { timeoutMs });
  }

  function expectContext(context, { timeoutMs = DEFAULT_PAIRING_TIMEOUT_MS } = {}) {
    const normalized = normalizeBrowserContext(context);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > DEFAULT_PAIRING_TIMEOUT_MS) {
      throw new Error("Equinox Browser pairing timeout is invalid");
    }
    pairingExpectation = {
      context: normalized,
      startedAt: nowIso(),
      expiresAtMs: Date.now() + timeoutMs,
    };
    emit("context_pairing_started", { context: normalized, timeoutMs });
    return pairingSnapshot();
  }

  function cancelExpectedContext() {
    const previous = pairingSnapshot();
    pairingExpectation = null;
    if (previous) emit("context_pairing_cancelled", { context: previous.context });
    return previous;
  }

  return {
    start,
    close,
    call,
    snapshot,
    snapshotContext,
    waitUntilReady,
    expectContext,
    cancelExpectedContext,
    readyFor: contextIsReady,
    get ready() {
      return contextIsReady(DEFAULT_EQUINOX_BROWSER_CONTEXT);
    },
    get socketPath() {
      return socketPath;
    },
  };
}
