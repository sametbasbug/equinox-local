import net from "node:net";

export const MAX_NATIVE_MESSAGE_BYTES = 64 * 1024 * 1024;
export const MAX_BRIDGE_LINE_BYTES = 72 * 1024 * 1024;
export const MAX_OUTBOUND_QUEUE_MESSAGES = 100;
export const MAX_OUTBOUND_QUEUE_BYTES = 72 * 1024 * 1024;
export const MAX_NATIVE_OUTPUT_QUEUE_BYTES = 72 * 1024 * 1024;

export function createEquinoxBrowserNativeHostRuntime({
  socketPath,
  origin = null,
  input = process.stdin,
  output = process.stdout,
  errorOutput = process.stderr,
  reconnectDelayMs = 750,
  createConnection = (target) => net.createConnection(target),
  onFatal = () => {},
  maxBridgeLineBytes = MAX_BRIDGE_LINE_BYTES,
  maxOutboundQueueMessages = MAX_OUTBOUND_QUEUE_MESSAGES,
  maxOutboundQueueBytes = MAX_OUTBOUND_QUEUE_BYTES,
  maxNativeOutputQueueBytes = MAX_NATIVE_OUTPUT_QUEUE_BYTES,
} = {}) {
  if (!socketPath) throw new Error("socketPath is required");

  let socket = null;
  let socketLineChunks = [];
  let socketLineBytes = 0;
  const nativeHeader = Buffer.alloc(4);
  let nativeHeaderBytes = 0;
  let nativePayload = null;
  let nativePayloadBytes = 0;
  let connected = false;
  let closing = false;
  let reconnectTimer = null;
  let started = false;
  const outboundQueue = [];
  let outboundQueueBytes = 0;
  let socketBackpressured = false;
  const nativeOutputQueue = [];
  let nativeOutputQueueBytes = 0;
  let nativeOutputBackpressured = false;
  let lastExtensionHello = null;

  function log(message) {
    errorOutput.write(`[Equinox Browser Host] ${message}\n`);
  }

  function failClosed(reason, details = {}) {
    log(reason);
    try {
      onFatal({ code: 2, reason, ...details });
    } catch {
      // Fatal reporting must not prevent fail-closed shutdown.
    }
    input.pause?.();
    close();
  }

  function enqueueNativeFrame(frame) {
    if (nativeOutputQueueBytes + frame.length > maxNativeOutputQueueBytes) {
      failClosed("native-output-overflow", {
        queuedBytes: nativeOutputQueueBytes,
        frameBytes: frame.length,
      });
      return false;
    }
    nativeOutputQueue.push(frame);
    nativeOutputQueueBytes += frame.length;
    return true;
  }

  function flushNativeOutputQueue() {
    if (closing || nativeOutputBackpressured) return;
    while (nativeOutputQueue.length > 0) {
      const frame = nativeOutputQueue.shift();
      nativeOutputQueueBytes -= frame.length;
      if (!output.write(frame)) {
        nativeOutputBackpressured = true;
        break;
      }
    }
  }

  function writeNative(message) {
    const payload = Buffer.from(JSON.stringify(message), "utf8");
    if (payload.length > MAX_NATIVE_MESSAGE_BYTES) {
      failClosed("native-output-message-too-large", { length: payload.length });
      return;
    }
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32LE(payload.length, 0);
    const frame = Buffer.concat([header, payload]);
    if (nativeOutputBackpressured || nativeOutputQueue.length > 0) {
      enqueueNativeFrame(frame);
      return;
    }
    if (!output.write(frame)) nativeOutputBackpressured = true;
  }

  function queueSocketLine(line, { front = false } = {}) {
    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes > maxBridgeLineBytes) {
      failClosed("bridge-message-too-large", { length: bytes });
      return false;
    }
    while (
      outboundQueue.length >= maxOutboundQueueMessages ||
      outboundQueueBytes + bytes > maxOutboundQueueBytes
    ) {
      const dropped = front ? outboundQueue.pop() : outboundQueue.shift();
      if (!dropped) break;
      outboundQueueBytes -= dropped.bytes;
    }
    if (outboundQueueBytes + bytes > maxOutboundQueueBytes) {
      failClosed("bridge-queue-overflow", { queuedBytes: outboundQueueBytes, lineBytes: bytes });
      return false;
    }
    if (front) outboundQueue.unshift({ line, bytes });
    else outboundQueue.push({ line, bytes });
    outboundQueueBytes += bytes;
    return true;
  }

  function writeSocketLineDirect(line) {
    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes > maxBridgeLineBytes) {
      failClosed("bridge-message-too-large", { length: bytes });
      return false;
    }
    if (!connected || !socket || socket.destroyed || socketBackpressured) return false;
    if (!socket.write(line)) socketBackpressured = true;
    return true;
  }

  function sendSocket(message) {
    const line = `${JSON.stringify(message)}\n`;
    if (outboundQueue.length === 0 && writeSocketLineDirect(line)) return;
    queueSocketLine(line);
  }

  function flushQueue() {
    if (!connected || !socket || socket.destroyed || socketBackpressured) return;
    while (outboundQueue.length > 0) {
      const queued = outboundQueue.shift();
      outboundQueueBytes -= queued.bytes;
      if (!socket.write(queued.line)) {
        socketBackpressured = true;
        break;
      }
    }
  }

  function handleSocketLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      log(`Invalid bridge JSON: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (message?.type === "host.send" && message.message) writeNative(message.message);
  }

  function handleSocketChunk(chunk, nextSocket) {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline < 0 ? chunk.length : newline;
      const piece = chunk.subarray(offset, end);
      if (socketLineBytes + piece.length > maxBridgeLineBytes) {
        log(`Bridge line exceeded ${maxBridgeLineBytes} bytes; reconnecting.`);
        nextSocket.destroy();
        return;
      }
      if (piece.length > 0) {
        socketLineChunks.push(piece);
        socketLineBytes += piece.length;
      }
      if (newline < 0) return;
      const line = socketLineChunks.length === 0
        ? ""
        : Buffer.concat(socketLineChunks, socketLineBytes).toString("utf8");
      socketLineChunks = [];
      socketLineBytes = 0;
      handleSocketLine(line);
      offset = newline + 1;
    }
  }

  function scheduleBridgeReconnect() {
    if (closing || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectBridge();
    }, reconnectDelayMs);
  }

  function connectBridge() {
    if (closing || connected || (socket && !socket.destroyed)) return;
    const nextSocket = createConnection(socketPath);
    socket = nextSocket;

    nextSocket.on("connect", () => {
      connected = true;
      socketBackpressured = false;
      writeNative({ type: "host.status", localConnected: true });

      const hostHelloLine = `${JSON.stringify({ type: "host.hello", origin, pid: process.pid, version: 1 })}\n`;
      writeSocketLineDirect(hostHelloLine);

      if (lastExtensionHello) {
        const extensionHelloLine = `${JSON.stringify({ type: "extension.message", message: lastExtensionHello })}\n`;
        if (!writeSocketLineDirect(extensionHelloLine)) {
          queueSocketLine(extensionHelloLine, { front: true });
        }
      }

      flushQueue();
    });

    nextSocket.on("data", (chunk) => handleSocketChunk(Buffer.from(chunk), nextSocket));

    nextSocket.on("drain", () => {
      if (socket !== nextSocket) return;
      socketBackpressured = false;
      flushQueue();
    });

    nextSocket.on("error", (error) => {
      if (!closing) log(`Bridge socket error: ${error.message}`);
    });

    nextSocket.on("close", () => {
      if (socket === nextSocket) {
        connected = false;
        socket = null;
        socketBackpressured = false;
        socketLineChunks = [];
        socketLineBytes = 0;
        writeNative({ type: "host.status", localConnected: false });
      }
      scheduleBridgeReconnect();
    });
  }

  function handleNativePayload(payload) {
    let message;
    try {
      message = JSON.parse(payload.toString("utf8"));
    } catch (error) {
      log(`Invalid extension JSON: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (message?.type === "extension.hello") {
      lastExtensionHello = message;
      writeNative({ type: "host.status", localConnected: connected });
      if (connected) sendSocket({ type: "extension.message", message });
      return;
    }
    sendSocket({ type: "extension.message", message });
  }

  function onInputData(chunk) {
    const inputChunk = Buffer.from(chunk);
    let offset = 0;
    while (offset < inputChunk.length && !closing) {
      if (nativePayload === null) {
        const neededHeader = 4 - nativeHeaderBytes;
        const copiedHeader = Math.min(neededHeader, inputChunk.length - offset);
        inputChunk.copy(nativeHeader, nativeHeaderBytes, offset, offset + copiedHeader);
        nativeHeaderBytes += copiedHeader;
        offset += copiedHeader;
        if (nativeHeaderBytes < 4) continue;
        const length = nativeHeader.readUInt32LE(0);
        nativeHeaderBytes = 0;
        if (length > MAX_NATIVE_MESSAGE_BYTES) {
          failClosed("message-too-large", { length });
          return;
        }
        nativePayload = Buffer.allocUnsafe(length);
        nativePayloadBytes = 0;
        if (length === 0) {
          handleNativePayload(nativePayload);
          nativePayload = null;
          continue;
        }
      }

      const neededPayload = nativePayload.length - nativePayloadBytes;
      const copiedPayload = Math.min(neededPayload, inputChunk.length - offset);
      inputChunk.copy(nativePayload, nativePayloadBytes, offset, offset + copiedPayload);
      nativePayloadBytes += copiedPayload;
      offset += copiedPayload;
      if (nativePayloadBytes === nativePayload.length) {
        const payload = nativePayload;
        nativePayload = null;
        nativePayloadBytes = 0;
        handleNativePayload(payload);
      }
    }
  }

  function start() {
    if (started) return snapshot();
    started = true;
    input.on("data", onInputData);
    input.on("end", close);
    output.on?.("drain", () => {
      nativeOutputBackpressured = false;
      flushNativeOutputQueue();
    });
    writeNative({ type: "host.status", localConnected: false });
    connectBridge();
    return snapshot();
  }

  function close() {
    if (closing) return;
    closing = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    input.off?.("data", onInputData);
    input.off?.("end", close);
    socket?.destroy();
    socket = null;
    connected = false;
  }

  function snapshot() {
    return {
      started,
      connected,
      closing,
      queuedMessages: outboundQueue.length,
      queuedBytes: outboundQueueBytes,
      nativeOutputQueuedBytes: nativeOutputQueueBytes,
      cachedExtensionHello: Boolean(lastExtensionHello),
      reconnectScheduled: Boolean(reconnectTimer),
    };
  }

  return { start, close, snapshot };
}
