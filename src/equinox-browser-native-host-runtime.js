import net from "node:net";

export const MAX_NATIVE_MESSAGE_BYTES = 64 * 1024 * 1024;

export function createEquinoxBrowserNativeHostRuntime({
  socketPath,
  origin = null,
  input = process.stdin,
  output = process.stdout,
  errorOutput = process.stderr,
  reconnectDelayMs = 750,
  createConnection = (target) => net.createConnection(target),
  onFatal = () => {},
} = {}) {
  if (!socketPath) throw new Error("socketPath is required");

  let socket = null;
  let socketBuffer = "";
  let stdinBuffer = Buffer.alloc(0);
  let connected = false;
  let closing = false;
  let reconnectTimer = null;
  let started = false;
  const outboundQueue = [];
  let lastExtensionHello = null;

  function log(message) {
    errorOutput.write(`[Equinox Browser Host] ${message}\n`);
  }

  function writeNative(message) {
    const payload = Buffer.from(JSON.stringify(message), "utf8");
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32LE(payload.length, 0);
    output.write(Buffer.concat([header, payload]));
  }

  function sendSocket(message) {
    const line = `${JSON.stringify(message)}\n`;
    if (connected && socket && !socket.destroyed) {
      socket.write(line);
      return;
    }
    if (outboundQueue.length >= 100) outboundQueue.shift();
    outboundQueue.push(line);
  }

  function flushQueue() {
    if (!connected || !socket || socket.destroyed) return;
    while (outboundQueue.length > 0) socket.write(outboundQueue.shift());
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
      writeNative({ type: "host.status", localConnected: true });
      sendSocket({ type: "host.hello", origin, pid: process.pid, version: 1 });
      if (lastExtensionHello) sendSocket({ type: "extension.message", message: lastExtensionHello });
      flushQueue();
    });

    nextSocket.on("data", (chunk) => {
      socketBuffer += chunk.toString("utf8");
      while (true) {
        const newline = socketBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = socketBuffer.slice(0, newline);
        socketBuffer = socketBuffer.slice(newline + 1);
        handleSocketLine(line);
      }
    });

    nextSocket.on("error", (error) => {
      if (!closing) log(`Bridge socket error: ${error.message}`);
    });

    nextSocket.on("close", () => {
      if (socket === nextSocket) {
        connected = false;
        socket = null;
        socketBuffer = "";
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
    }
    sendSocket({ type: "extension.message", message });
  }

  function onInputData(chunk) {
    stdinBuffer = Buffer.concat([stdinBuffer, chunk]);
    while (stdinBuffer.length >= 4) {
      const length = stdinBuffer.readUInt32LE(0);
      if (length > MAX_NATIVE_MESSAGE_BYTES) {
        log(`Extension message too large: ${length}`);
        try {
          onFatal({ code: 2, reason: "message-too-large", length });
        } catch {
          // Fatal reporting must not prevent fail-closed shutdown.
        }
        input.pause?.();
        close();
        return;
      }
      if (stdinBuffer.length < 4 + length) return;
      const payload = stdinBuffer.subarray(4, 4 + length);
      stdinBuffer = stdinBuffer.subarray(4 + length);
      handleNativePayload(payload);
    }
  }

  function start() {
    if (started) return snapshot();
    started = true;
    input.on("data", onInputData);
    input.on("end", close);
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
      cachedExtensionHello: Boolean(lastExtensionHello),
      reconnectScheduled: Boolean(reconnectTimer),
    };
  }

  return { start, close, snapshot };
}
