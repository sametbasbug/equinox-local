import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createEquinoxBrowserNativeHostRuntime } from "../../src/equinox-browser-native-host-runtime.js";

function encodeNativeMessage(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

function collectNativeMessages(stream) {
  const messages = [];
  let buffer = Buffer.alloc(0);
  stream.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) return;
      messages.push(JSON.parse(buffer.subarray(4, 4 + length).toString("utf8")));
      buffer = buffer.subarray(4 + length);
    }
  });
  return messages;
}

async function waitFor(predicate, { timeoutMs = 2_000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for lifecycle condition");
}

class FakeSocket extends EventEmitter {
  constructor({ backpressureWrites = 0 } = {}) {
    super();
    this.destroyed = false;
    this.writes = [];
    this.backpressureWrites = backpressureWrites;
  }

  write(value) {
    this.writes.push(Buffer.from(value));
    if (this.backpressureWrites > 0) {
      this.backpressureWrites -= 1;
      return false;
    }
    return true;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("close");
  }
}

class FakeOutput extends EventEmitter {
  constructor({ backpressureWrites = 0 } = {}) {
    super();
    this.writes = [];
    this.backpressureWrites = backpressureWrites;
  }

  write(value) {
    this.writes.push(Buffer.from(value));
    if (this.backpressureWrites > 0) {
      this.backpressureWrites -= 1;
      return false;
    }
    return true;
  }
}

async function startSocketServer(socketPath) {
  const messages = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) messages.push(JSON.parse(line));
      }
    });
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return {
    server,
    messages,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
      await fs.rm(socketPath, { force: true });
    },
  };
}

test("native host survives Unix socket outage, reconnects and replays cached extension hello", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-native-host-life-"));
  const socketPath = path.join(tempRoot, "bridge.sock");
  const input = new PassThrough();
  const output = new PassThrough();
  const nativeMessages = collectNativeMessages(output);
  const errorOutput = new PassThrough();
  const runtime = createEquinoxBrowserNativeHostRuntime({
    socketPath,
    origin: "chrome-extension://fixture/",
    input,
    output,
    errorOutput,
    reconnectDelayMs: 25,
  });

  try {
    runtime.start();
    await waitFor(() => nativeMessages.some((message) => message.type === "host.status"));
    assert.deepEqual(nativeMessages.at(-1), { type: "host.status", localConnected: false });

    const extensionHello = {
      type: "extension.hello",
      extensionId: "fixture",
      extensionVersion: "0.1.0",
      protocolVersion: 1,
      capabilities: ["ping"],
    };
    input.write(encodeNativeMessage(extensionHello));

    await waitFor(() => runtime.snapshot().reconnectScheduled === true);
    assert.equal(runtime.snapshot().connected, false);
    assert.equal(runtime.snapshot().cachedExtensionHello, true);

    const firstServer = await startSocketServer(socketPath);
    await waitFor(() => firstServer.messages.some((message) => message.type === "extension.message"));
    assert.equal(runtime.snapshot().connected, true);
    assert.equal(firstServer.messages[0]?.type, "host.hello");
    assert.deepEqual(firstServer.messages[1], { type: "extension.message", message: extensionHello });
    await waitFor(() => nativeMessages.some((message) => message.type === "host.status" && message.localConnected === true));

    await firstServer.close();
    await waitFor(() => runtime.snapshot().connected === false && runtime.snapshot().reconnectScheduled === true);
    assert.equal(nativeMessages.at(-1)?.type, "host.status");
    assert.equal(nativeMessages.at(-1)?.localConnected, false);

    const secondServer = await startSocketServer(socketPath);
    await waitFor(() => secondServer.messages.some((message) => message.type === "extension.message"));
    assert.equal(runtime.snapshot().connected, true);
    assert.equal(secondServer.messages[0]?.type, "host.hello");
    assert.deepEqual(secondServer.messages[1], { type: "extension.message", message: extensionHello });
    await waitFor(() => nativeMessages.at(-1)?.type === "host.status" && nativeMessages.at(-1)?.localConnected === true);
    await secondServer.close();
  } finally {
    runtime.close();
    input.end();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("native host parses fragmented Native Messaging frames and bounds the offline byte queue", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const errorOutput = new PassThrough();
  const socket = new FakeSocket();
  const runtime = createEquinoxBrowserNativeHostRuntime({
    socketPath: "/tmp/equinox-native-host-fragmented.sock",
    input,
    output,
    errorOutput,
    createConnection: () => socket,
    reconnectDelayMs: 10_000,
    maxOutboundQueueMessages: 3,
    maxOutboundQueueBytes: 360,
  });

  try {
    runtime.start();
    const hello = encodeNativeMessage({
      type: "extension.hello",
      extensionId: "fixture",
      extensionVersion: "0.1.0",
      protocolVersion: 1,
      capabilities: ["ping"],
    });
    for (let offset = 0; offset < hello.length; offset += 3) {
      input.write(hello.subarray(offset, Math.min(offset + 3, hello.length)));
    }
    await waitFor(() => runtime.snapshot().cachedExtensionHello === true);

    for (let index = 0; index < 8; index += 1) {
      input.write(encodeNativeMessage({ type: "fixture.event", index, text: "x".repeat(24) }));
    }
    const snapshot = runtime.snapshot();
    assert.ok(snapshot.queuedMessages <= 3);
    assert.ok(snapshot.queuedBytes <= 360);
    assert.equal(snapshot.closing, false);
  } finally {
    runtime.close();
    input.end();
  }
});

test("native host honors Unix socket backpressure and flushes its bounded queue on drain", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const errorOutput = new PassThrough();
  const socket = new FakeSocket({ backpressureWrites: 1 });
  const runtime = createEquinoxBrowserNativeHostRuntime({
    socketPath: "/tmp/equinox-native-host-backpressure.sock",
    input,
    output,
    errorOutput,
    createConnection: () => socket,
    reconnectDelayMs: 10_000,
    maxOutboundQueueBytes: 4 * 1024,
  });

  try {
    runtime.start();
    socket.emit("connect");
    input.write(encodeNativeMessage({ type: "fixture.event", value: 1 }));
    input.write(encodeNativeMessage({ type: "fixture.event", value: 2 }));
    assert.ok(runtime.snapshot().queuedMessages >= 2);
    assert.ok(runtime.snapshot().queuedBytes > 0);

    socket.emit("drain");
    assert.equal(runtime.snapshot().queuedMessages, 0);
    assert.equal(runtime.snapshot().queuedBytes, 0);
  } finally {
    runtime.close();
    input.end();
  }
});

test("native host honors Native Messaging stdout backpressure and flushes the bounded output queue on drain", async () => {
  const input = new PassThrough();
  const output = new FakeOutput({ backpressureWrites: 1 });
  const errorOutput = new PassThrough();
  const socket = new FakeSocket();
  const runtime = createEquinoxBrowserNativeHostRuntime({
    socketPath: "/tmp/equinox-native-host-output-backpressure.sock",
    input,
    output,
    errorOutput,
    createConnection: () => socket,
    reconnectDelayMs: 10_000,
    maxNativeOutputQueueBytes: 4 * 1024,
  });

  try {
    runtime.start();
    input.write(encodeNativeMessage({
      type: "extension.hello",
      extensionId: "fixture",
      extensionVersion: "0.1.0",
      protocolVersion: 1,
      capabilities: ["ping"],
    }));
    assert.ok(runtime.snapshot().nativeOutputQueuedBytes > 0);

    output.emit("drain");
    assert.equal(runtime.snapshot().nativeOutputQueuedBytes, 0);
    assert.equal(runtime.snapshot().closing, false);
  } finally {
    runtime.close();
    input.end();
  }
});

test("native host rejects an oversized unterminated bridge line before unbounded buffering", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const errorOutput = new PassThrough();
  const socket = new FakeSocket();
  const runtime = createEquinoxBrowserNativeHostRuntime({
    socketPath: "/tmp/equinox-native-host-line-limit.sock",
    input,
    output,
    errorOutput,
    createConnection: () => socket,
    reconnectDelayMs: 10_000,
    maxBridgeLineBytes: 256,
  });

  try {
    runtime.start();
    socket.emit("connect");
    assert.equal(socket.destroyed, false);
    socket.emit("data", Buffer.alloc(257, 0x61));
    assert.equal(socket.destroyed, true);
  } finally {
    runtime.close();
    input.end();
  }
});
