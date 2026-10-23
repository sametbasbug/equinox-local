import net from "node:net";

type BridgeEndpoint = {
  kind: "unix" | "named-pipe" | string;
  endpoint: string;
  implemented: boolean;
};
type NativeHostFatal = {
  code: number;
  reason: string;
  [detail: string]: unknown;
};
type NativeHostOptions = {
  bridgeEndpoint?: BridgeEndpoint | null;
  socketPath?: string | null;
  origin?: string | null;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  errorOutput?: NodeJS.WritableStream;
  reconnectDelayMs?: number;
  createConnection?: (target: string) => net.Socket;
  onFatal?: (reason: NativeHostFatal) => void;
  maxBridgeLineBytes?: number;
  maxOutboundQueueMessages?: number;
  maxOutboundQueueBytes?: number;
  maxNativeOutputQueueBytes?: number;
};
type QueuedLine = {line: string; bytes: number};
type RuntimeSnapshot = {
  started: boolean;
  connected: boolean;
  closing: boolean;
  queuedMessages: number;
  queuedBytes: number;
  nativeOutputQueuedBytes: number;
  cachedExtensionHello: boolean;
  reconnectScheduled: boolean;
};
type NativeHostRuntime = {
  start: () => RuntimeSnapshot;
  close: () => void;
  snapshot: () => RuntimeSnapshot;
};

export const MAX_NATIVE_MESSAGE_BYTES = 64 * 1024 * 1024;
export const MAX_BRIDGE_LINE_BYTES = 72 * 1024 * 1024;
export const MAX_OUTBOUND_QUEUE_MESSAGES = 100;
export const MAX_OUTBOUND_QUEUE_BYTES = 72 * 1024 * 1024;
export const MAX_NATIVE_OUTPUT_QUEUE_BYTES = 72 * 1024 * 1024;

export function createEquinoxBrowserNativeHostRuntime({
  bridgeEndpoint = null,
  socketPath = null,
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
}: NativeHostOptions = {}): NativeHostRuntime {
  const endpoint = bridgeEndpoint ?? (socketPath
    ? Object.freeze({ kind: "unix", endpoint: socketPath, implemented: true })
    : null);
  if (!endpoint || typeof endpoint.endpoint !== "string" || !endpoint.endpoint) throw new Error("bridgeEndpoint is required");
  if (!new Set(["unix", "named-pipe"]).has(endpoint.kind)) throw new Error("bridgeEndpoint kind is unsupported");
  if (endpoint.implemented !== true) throw new Error(`Bridge IPC endpoint ${endpoint.kind} is not implemented.`);

  let socket: net.Socket | null = null;
  let socketLineChunks: Buffer[] = [];
  let socketLineBytes = 0;
  const nativeHeader = Buffer.alloc(4);
  let nativeHeaderBytes = 0;
  let nativePayload: Buffer | null = null;
  let nativePayloadBytes = 0;
  let connected = false;
  let closing = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let started = false;
  const outboundQueue: QueuedLine[] = [];
  let outboundQueueBytes = 0;
  let socketBackpressured = false;
  const nativeOutputQueue: Buffer[] = [];
  let nativeOutputQueueBytes = 0;
  let nativeOutputBackpressured = false;
  let lastExtensionHello: Record<string, unknown> | null = null;

  function log(message: string): void {
    errorOutput.write(`[Equinox Browser Host] ${message}\n`);
  }

  function failClosed(reason: string, details: Record<string, unknown> = {}): void {
    log(reason);
    try {
      onFatal({ code: 2, reason, ...details });
    } catch {
      // Fatal reporting must not prevent fail-closed shutdown.
    }
    input.pause?.();
    close();
  }

  function enqueueNativeFrame(frame: Buffer): boolean {
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

  function flushNativeOutputQueue(): void {
    if (closing || nativeOutputBackpressured) return;
    while (nativeOutputQueue.length > 0) {
      const frame = nativeOutputQueue.shift()!;
      nativeOutputQueueBytes -= frame.length;
      if (!output.write(frame)) {
        nativeOutputBackpressured = true;
        break;
      }
    }
  }

  function writeNative(message: unknown): void {
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

  function queueSocketLine(line: string, { front = false }: {front?: boolean} = {}): boolean {
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

  function writeSocketLineDirect(line: string): boolean {
    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes > maxBridgeLineBytes) {
      failClosed("bridge-message-too-large", { length: bytes });
      return false;
    }
    if (!connected || !socket || socket.destroyed || socketBackpressured) return false;
    if (!socket.write(line)) socketBackpressured = true;
    return true;
  }

  function sendSocket(message: unknown): void {
    const line = `${JSON.stringify(message)}\n`;
    if (outboundQueue.length === 0 && writeSocketLineDirect(line)) return;
    queueSocketLine(line);
  }

  function flushQueue(): void {
    if (!connected || !socket || socket.destroyed || socketBackpressured) return;
    while (outboundQueue.length > 0) {
      const queued = outboundQueue.shift()!;
      outboundQueueBytes -= queued.bytes;
      if (!socket.write(queued.line)) {
        socketBackpressured = true;
        break;
      }
    }
  }

  function handleSocketLine(line: string): void {
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

  function handleSocketChunk(chunk: Buffer, nextSocket: net.Socket): void {
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

  function scheduleBridgeReconnect(): void {
    if (closing || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectBridge();
    }, reconnectDelayMs);
  }

  function connectBridge(): void {
    if (closing || connected || (socket && !socket.destroyed)) return;
    const nextSocket = createConnection(endpoint!.endpoint);
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

    nextSocket.on("error", (error: Error) => {
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

  function handleNativePayload(payload: Buffer): void {
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

  function onInputData(chunk: Buffer | string): void {
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

  function start(): RuntimeSnapshot {
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

  function close(): void {
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

  function snapshot(): RuntimeSnapshot {
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
