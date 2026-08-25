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
const MAX_STREAMED_RESPONSE_CHARS = 48 * 1024 * 1024;
const MAX_STREAM_CHUNKS = 128;

function nowIso() {
  return new Date().toISOString();
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function writeLine(socket, message) {
  socket.write(`${JSON.stringify(message)}\n`);
}

export function createEquinoxBrowserBridge({
  socketPath = EQUINOX_BROWSER_SOCKET_PATH,
  expectedExtensionIds = EQUINOX_BROWSER_EXTENSION_IDS,
  callTimeoutMs = 15_000,
  recordEvent = () => {},
} = {}) {
  let server = null;
  let hostSocket = null;
  let hostBuffer = "";
  let hostInfo = null;
  let extensionInfo = null;
  let startedAt = null;
  let connectedAt = null;
  let nextCommandId = 1;
  const pending = new Map();

  const acceptedExtensionIds = [...new Set(expectedExtensionIds)];
  if (acceptedExtensionIds.length < 1 || acceptedExtensionIds.some((id) => !/^[a-p]{32}$/.test(id))) {
    throw new Error("Equinox Browser expected extension ids are invalid");
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

  function rejectPending(reason) {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error(reason));
    }
    pending.clear();
  }

  function clearHost(reason = "native host disconnected") {
    if (hostSocket) {
      hostSocket.removeAllListeners();
      hostSocket.destroy();
    }
    hostSocket = null;
    hostBuffer = "";
    hostInfo = null;
    extensionInfo = null;
    connectedAt = null;
    rejectPending(reason);
    emit("disconnected", { reason });
  }

  function rejectWaiter(key, waiter, reason) {
    pending.delete(key);
    clearTimeout(waiter.timer);
    waiter.reject(new Error(reason));
  }

  function handleExtensionMessage(message) {
    if (message?.type === "extension.hello") {
      if (!expectedExtensionIdSet.has(message.extensionId)) {
        clearHost(`Unexpected extension id: ${message.extensionId || "unknown"}`);
        return;
      }
      if (!hostInfo || hostInfo.extensionId !== message.extensionId) {
        clearHost(`Extension id does not match native host origin: ${message.extensionId || "unknown"}`);
        return;
      }
      extensionInfo = {
        extensionId: message.extensionId,
        extensionVersion: message.extensionVersion ?? null,
        protocolVersion: message.protocolVersion ?? null,
        capabilities: Array.isArray(message.capabilities) ? message.capabilities : [],
        lastNativeDisconnectError: message.lastNativeDisconnectError ?? null,
        connectedAt: nowIso(),
      };
      emit("extension_ready", {
        extensionVersion: extensionInfo.extensionVersion,
        lastNativeDisconnectError: extensionInfo.lastNativeDisconnectError,
      });
      return;
    }

    if (message?.type === "response.chunk" && message.id != null) {
      const key = String(message.id);
      const waiter = pending.get(key);
      if (!waiter) return;
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
    if (!waiter) return;
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

  function handleHostLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      clearHost("Native host sent invalid JSON");
      return;
    }

    if (message?.type === "host.hello") {
      if (!expectedOriginSet.has(message.origin)) {
        clearHost(`Unexpected native host origin: ${message.origin || "unknown"}`);
        return;
      }
      const matchedExtensionId = acceptedExtensionIds.find(
        (id) => message.origin === `chrome-extension://${id}/`,
      );
      hostInfo = {
        origin: message.origin,
        extensionId: matchedExtensionId,
        pid: message.pid ?? null,
        version: message.version ?? null,
      };
      connectedAt = nowIso();
      emit("host_connected", { pid: hostInfo.pid });
      return;
    }

    if (message?.type === "extension.message") {
      handleExtensionMessage(message.message);
    }
  }

  function attachHost(socket) {
    if (hostSocket && !hostSocket.destroyed) {
      hostSocket.destroy();
    }
    hostSocket = socket;
    hostBuffer = "";
    hostInfo = null;
    extensionInfo = null;
    connectedAt = null;

    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      hostBuffer += chunk;
      while (true) {
        const newline = hostBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = hostBuffer.slice(0, newline);
        hostBuffer = hostBuffer.slice(newline + 1);
        handleHostLine(line);
      }
    });
    socket.on("error", (error) => {
      emit("host_error", { message: errorMessage(error) });
    });
    socket.on("close", () => {
      if (hostSocket === socket) clearHost("native host disconnected");
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
    rejectPending("Equinox Browser bridge closed");
    if (hostSocket && !hostSocket.destroyed) hostSocket.destroy();
    hostSocket = null;
    hostInfo = null;
    extensionInfo = null;
    connectedAt = null;
    if (server) {
      const closingServer = server;
      server = null;
      await new Promise((resolve) => closingServer.close(() => resolve()));
    }
    await fs.rm(socketPath, { force: true }).catch(() => {});
    emit("closed");
  }

  function isReady() {
    return Boolean(
      server &&
      hostSocket &&
      !hostSocket.destroyed &&
      hostInfo &&
      extensionInfo,
    );
  }

  function snapshot() {
    return {
      active: Boolean(server),
      ready: isReady(),
      socketPath,
      expectedExtensionId,
      expectedExtensionIds: acceptedExtensionIds,
      expectedOrigin,
      expectedOrigins,
      startedAt,
      connectedAt,
      host: hostInfo,
      extension: extensionInfo,
      pendingCount: pending.size,
    };
  }

  async function waitUntilReady(timeoutMs = 8_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (isReady()) return snapshot();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
      "Equinox Browser extension bağlı değil. Chrome uzantısının yüklü ve Native Messaging host'un kayıtlı olduğundan emin olun.",
    );
  }

  async function call(method, args = {}, { timeoutMs = callTimeoutMs } = {}) {
    if (!isReady()) {
      await waitUntilReady(Math.min(timeoutMs, 8_000));
    }
    if (!hostSocket || hostSocket.destroyed) {
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
      pending.set(id, { resolve, reject, timer, method, stream: null });
      try {
        writeLine(hostSocket, { type: "host.send", message: command });
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  return {
    start,
    close,
    call,
    snapshot,
    waitUntilReady,
    get ready() {
      return isReady();
    },
    get socketPath() {
      return socketPath;
    },
  };
}
