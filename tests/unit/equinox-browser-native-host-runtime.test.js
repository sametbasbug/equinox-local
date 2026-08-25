import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
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
