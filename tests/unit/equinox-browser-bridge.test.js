import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createEquinoxBrowserBridge,
  EQUINOX_BROWSER_EXTENSION_ID,
  EQUINOX_BROWSER_LEGACY_EXTENSION_ID,
  EQUINOX_BROWSER_MIGRATION_EXTENSION_IDS,
} from "../../src/equinox-browser-bridge.js";

function waitForLine(socket, onLine) {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) onLine(JSON.parse(line));
    }
  });
}

function writeLine(socket, message) {
  socket.write(`${JSON.stringify(message)}\n`);
}

async function makeSocketPath(name) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `equinox-browser-${name}-`));
  return { dir, socketPath: path.join(dir, "bridge.sock") };
}

test("Equinox Browser bridge validates host + extension and routes commands", async (t) => {
  const { dir, socketPath } = await makeSocketPath("route");
  const bridge = createEquinoxBrowserBridge({ socketPath, callTimeoutMs: 2_000 });
  await bridge.start();
  t.after(async () => {
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const client = net.createConnection(socketPath);
  await new Promise((resolve, reject) => {
    client.once("connect", resolve);
    client.once("error", reject);
  });
  t.after(() => client.destroy());

  const received = [];
  waitForLine(client, (message) => {
    received.push(message);
    if (message.type === "host.send" && message.message?.type === "command") {
      writeLine(client, {
        type: "extension.message",
        message: {
          type: "response",
          id: message.message.id,
          ok: true,
          result: {
            method: message.message.method,
            args: message.message.args,
          },
        },
      });
    }
  });

  writeLine(client, {
    type: "host.hello",
    origin: `chrome-extension://${EQUINOX_BROWSER_EXTENSION_ID}/`,
    pid: 1234,
    version: 1,
  });
  writeLine(client, {
    type: "extension.message",
    message: {
      type: "extension.hello",
      extensionId: EQUINOX_BROWSER_EXTENSION_ID,
      extensionVersion: "0.1.0",
      protocolVersion: 1,
      capabilities: ["ping"],
    },
  });

  const ready = await bridge.waitUntilReady(1_000);
  assert.equal(ready.ready, true);
  assert.equal(ready.host.pid, 1234);
  assert.equal(ready.extension.extensionVersion, "0.1.0");

  const response = await bridge.call("ping", { hello: "world" });
  assert.deepEqual(response, {
    method: "ping",
    args: { hello: "world" },
  });
  assert.equal(received.some((item) => item.type === "host.send"), true);
});

test("Equinox Browser bridge handles the bounded extension-initiated Agent Browser open request", async (t) => {
  const { dir, socketPath } = await makeSocketPath("extension-request");
  let capturedRequest = null;
  const bridge = createEquinoxBrowserBridge({
    socketPath,
    callTimeoutMs: 2_000,
    handleExtensionRequest: async (request) => {
      capturedRequest = request;
      return { opened: true, alreadyOpen: false };
    },
  });
  await bridge.start();
  t.after(async () => {
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const client = net.createConnection(socketPath);
  await new Promise((resolve, reject) => {
    client.once("connect", resolve);
    client.once("error", reject);
  });
  t.after(() => client.destroy());

  let resolveResponse;
  const responsePromise = new Promise((resolve) => {
    resolveResponse = resolve;
  });
  waitForLine(client, (message) => {
    if (message.type === "host.send" && message.message?.type === "extension.response") {
      resolveResponse(message.message);
    }
  });

  writeLine(client, {
    type: "host.hello",
    origin: `chrome-extension://${EQUINOX_BROWSER_EXTENSION_ID}/`,
    pid: 9876,
    version: 1,
  });
  writeLine(client, {
    type: "extension.message",
    message: {
      type: "extension.hello",
      extensionId: EQUINOX_BROWSER_EXTENSION_ID,
      extensionVersion: "0.4.0-dev",
      protocolVersion: 1,
      capabilities: ["status"],
      instanceId: "11111111-2222-4333-8444-555555555555",
      browserContext: "user",
    },
  });
  await bridge.waitUntilReady(1_000, { context: "user" });

  writeLine(client, {
    type: "extension.message",
    message: {
      type: "extension.request",
      id: "popup-open-1",
      method: "agent_browser.open",
      args: {},
    },
  });

  const response = await responsePromise;
  assert.equal(capturedRequest?.context, "user");
  assert.equal(capturedRequest?.instanceId, "11111111-2222-4333-8444-555555555555");
  assert.equal(capturedRequest?.method, "agent_browser.open");
  assert.deepEqual(capturedRequest?.args, {});
  assert.equal(response.id, "popup-open-1");
  assert.equal(response.ok, true);
  assert.deepEqual(response.result, { opened: true, alreadyOpen: false });
});

test("Equinox Browser bridge accepts the legacy extension during production-id migration", async (t) => {
  const { dir, socketPath } = await makeSocketPath("legacy-migration");
  const bridge = createEquinoxBrowserBridge({
    socketPath,
    expectedExtensionIds: EQUINOX_BROWSER_MIGRATION_EXTENSION_IDS,
    callTimeoutMs: 1_000,
  });
  await bridge.start();
  t.after(async () => {
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const client = net.createConnection(socketPath);
  await new Promise((resolve, reject) => {
    client.once("connect", resolve);
    client.once("error", reject);
  });
  t.after(() => client.destroy());

  writeLine(client, {
    type: "host.hello",
    origin: `chrome-extension://${EQUINOX_BROWSER_LEGACY_EXTENSION_ID}/`,
    pid: 4321,
    version: 1,
  });
  writeLine(client, {
    type: "extension.message",
    message: {
      type: "extension.hello",
      extensionId: EQUINOX_BROWSER_LEGACY_EXTENSION_ID,
      extensionVersion: "0.2.2",
      protocolVersion: 1,
      capabilities: ["ping"],
    },
  });

  const ready = await bridge.waitUntilReady(1_000);
  assert.equal(ready.ready, true);
  assert.equal(ready.host.extensionId, EQUINOX_BROWSER_LEGACY_EXTENSION_ID);
  assert.equal(ready.extension.extensionId, EQUINOX_BROWSER_LEGACY_EXTENSION_ID);
  assert.deepEqual(ready.expectedExtensionIds, [
    EQUINOX_BROWSER_EXTENSION_ID,
    EQUINOX_BROWSER_LEGACY_EXTENSION_ID,
  ]);
});

test("Equinox Browser bridge reassembles bounded streamed command responses", async (t) => {
  const { dir, socketPath } = await makeSocketPath("stream");
  const bridge = createEquinoxBrowserBridge({ socketPath, callTimeoutMs: 2_000 });
  await bridge.start();
  t.after(async () => {
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const client = net.createConnection(socketPath);
  await new Promise((resolve, reject) => {
    client.once("connect", resolve);
    client.once("error", reject);
  });
  t.after(() => client.destroy());

  waitForLine(client, (message) => {
    if (message.type !== "host.send" || message.message?.type !== "command") return;
    const id = message.message.id;
    writeLine(client, {
      type: "extension.message",
      message: { type: "response.chunk", id, field: "data", index: 0, total: 3, data: "abc" },
    });
    writeLine(client, {
      type: "extension.message",
      message: { type: "response.chunk", id, field: "data", index: 1, total: 3, data: "def" },
    });
    writeLine(client, {
      type: "extension.message",
      message: { type: "response.chunk", id, field: "data", index: 2, total: 3, data: "ghi" },
    });
    writeLine(client, {
      type: "extension.message",
      message: {
        type: "response",
        id,
        ok: true,
        result: { mimeType: "image/png", streamed: { field: "data", chunks: 3 } },
      },
    });
  });

  writeLine(client, {
    type: "host.hello",
    origin: `chrome-extension://${EQUINOX_BROWSER_EXTENSION_ID}/`,
    pid: 2222,
    version: 1,
  });
  writeLine(client, {
    type: "extension.message",
    message: {
      type: "extension.hello",
      extensionId: EQUINOX_BROWSER_EXTENSION_ID,
      extensionVersion: "0.1.0",
      protocolVersion: 1,
      capabilities: ["screenshot"],
    },
  });

  await bridge.waitUntilReady(1_000);
  const response = await bridge.call("screenshot", { fullPage: true });
  assert.deepEqual(response, { mimeType: "image/png", data: "abcdefghi" });
});

test("Equinox Browser bridge rejects an unexpected native-host origin", async (t) => {
  const { dir, socketPath } = await makeSocketPath("origin");
  const bridge = createEquinoxBrowserBridge({ socketPath, callTimeoutMs: 250 });
  await bridge.start();
  t.after(async () => {
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const client = net.createConnection(socketPath);
  await new Promise((resolve, reject) => {
    client.once("connect", resolve);
    client.once("error", reject);
  });
  writeLine(client, {
    type: "host.hello",
    origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
    pid: 9,
    version: 1,
  });

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(bridge.snapshot().ready, false);
  assert.equal(bridge.snapshot().host, null);
  client.destroy();
});

test("Equinox Browser bridge binds extension hello to the authenticated host origin", async (t) => {
  const { dir, socketPath } = await makeSocketPath("origin-binding");
  const bridge = createEquinoxBrowserBridge({ socketPath });
  await bridge.start();
  t.after(async () => {
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const client = net.createConnection(socketPath);
  await new Promise((resolve, reject) => {
    client.once("connect", resolve);
    client.once("error", reject);
  });
  writeLine(client, {
    type: "host.hello",
    origin: `chrome-extension://${EQUINOX_BROWSER_EXTENSION_ID}/`,
    pid: 10,
    version: 1,
  });
  writeLine(client, {
    type: "extension.message",
    message: {
      type: "extension.hello",
      extensionId: EQUINOX_BROWSER_LEGACY_EXTENSION_ID,
      extensionVersion: "0.2.2",
      protocolVersion: 1,
      capabilities: [],
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(bridge.snapshot().ready, false);
  assert.equal(bridge.snapshot().host, null);
  client.destroy();
});

test("Equinox Browser bridge rejects extension id mismatch", async (t) => {
  const { dir, socketPath } = await makeSocketPath("extension-id");
  const bridge = createEquinoxBrowserBridge({ socketPath });
  await bridge.start();
  t.after(async () => {
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const client = net.createConnection(socketPath);
  await new Promise((resolve, reject) => {
    client.once("connect", resolve);
    client.once("error", reject);
  });
  writeLine(client, {
    type: "host.hello",
    origin: `chrome-extension://${EQUINOX_BROWSER_EXTENSION_ID}/`,
    pid: 10,
    version: 1,
  });
  writeLine(client, {
    type: "extension.message",
    message: {
      type: "extension.hello",
      extensionId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      extensionVersion: "0.1.0",
      protocolVersion: 1,
      capabilities: [],
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(bridge.snapshot().ready, false);
  client.destroy();
});

test("bridge rejects in-flight work on host loss and accepts a fresh host without restart", async (t) => {
  const { dir, socketPath } = await makeSocketPath("reconnect");
  const bridge = createEquinoxBrowserBridge({ socketPath, callTimeoutMs: 2_000 });
  await bridge.start();
  t.after(async () => {
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const connectReadyHost = async (pid, { respond = false } = {}) => {
    const client = net.createConnection(socketPath);
    await new Promise((resolve, reject) => {
      client.once("connect", resolve);
      client.once("error", reject);
    });
    waitForLine(client, (message) => {
      if (!respond || message.type !== "host.send" || message.message?.type !== "command") return;
      writeLine(client, {
        type: "extension.message",
        message: {
          type: "response",
          id: message.message.id,
          ok: true,
          result: { recovered: true, method: message.message.method },
        },
      });
    });
    writeLine(client, {
      type: "host.hello",
      origin: `chrome-extension://${EQUINOX_BROWSER_EXTENSION_ID}/`,
      pid,
      version: 1,
    });
    writeLine(client, {
      type: "extension.message",
      message: {
        type: "extension.hello",
        extensionId: EQUINOX_BROWSER_EXTENSION_ID,
        extensionVersion: "0.1.0",
        protocolVersion: 1,
        capabilities: ["ping"],
      },
    });
    await bridge.waitUntilReady(1_000);
    return client;
  };

  const first = await connectReadyHost(1001);
  const pending = bridge.call("ping", { during: "disconnect" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  first.destroy();
  await assert.rejects(pending, /native host disconnected/i);
  assert.equal(bridge.snapshot().ready, false);
  assert.equal(bridge.snapshot().pendingCount, 0);

  const second = await connectReadyHost(1002, { respond: true });
  t.after(() => second.destroy());
  const recovered = await bridge.call("ping", { after: "reconnect" });
  assert.deepEqual(recovered, { recovered: true, method: "ping" });
  assert.equal(bridge.snapshot().host.pid, 1002);
});

test("bridge routes user and agent browser contexts independently without fallback", async (t) => {
  const { dir, socketPath } = await makeSocketPath("contexts");
  const bridge = createEquinoxBrowserBridge({ socketPath, callTimeoutMs: 250 });
  await bridge.start();
  t.after(async () => {
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const connectContext = async ({ pid, instanceId, browserContext }) => {
    const client = net.createConnection(socketPath);
    await new Promise((resolve, reject) => {
      client.once("connect", resolve);
      client.once("error", reject);
    });
    const commands = [];
    waitForLine(client, (message) => {
      if (message.type !== "host.send" || message.message?.type !== "command") return;
      commands.push(message.message);
      writeLine(client, {
        type: "extension.message",
        message: {
          type: "response",
          id: message.message.id,
          ok: true,
          result: { browserContext, method: message.message.method },
        },
      });
    });
    writeLine(client, {
      type: "host.hello",
      origin: `chrome-extension://${EQUINOX_BROWSER_EXTENSION_ID}/`,
      pid,
      version: 1,
    });
    writeLine(client, {
      type: "extension.message",
      message: {
        type: "extension.hello",
        extensionId: EQUINOX_BROWSER_EXTENSION_ID,
        extensionVersion: "0.4.0-test",
        protocolVersion: 1,
        capabilities: ["ping"],
        instanceId,
        browserContext,
      },
    });
    await bridge.waitUntilReady(1_000, { context: browserContext });
    return { client, commands };
  };

  const user = await connectContext({
    pid: 2001,
    instanceId: "11111111-1111-4111-8111-111111111111",
    browserContext: "user",
  });
  const agent = await connectContext({
    pid: 2002,
    instanceId: "22222222-2222-4222-8222-222222222222",
    browserContext: "agent",
  });
  t.after(() => user.client.destroy());
  t.after(() => agent.client.destroy());

  assert.equal(bridge.snapshot().contexts.user.ready, true);
  assert.equal(bridge.snapshot().contexts.agent.ready, true);

  const agentResult = await bridge.call("ping", {}, { context: "agent" });
  assert.deepEqual(agentResult, { browserContext: "agent", method: "ping" });
  assert.equal(agent.commands.at(-1)?.method, "ping");
  assert.equal(user.commands.length, 0);

  const userResult = await bridge.call("ping", {}, { context: "user" });
  assert.deepEqual(userResult, { browserContext: "user", method: "ping" });
  assert.equal(user.commands.at(-1)?.method, "ping");

  agent.client.destroy();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(bridge.snapshot().contexts.agent.ready, false);
  assert.equal(bridge.snapshot().contexts.user.ready, true);
  await assert.rejects(
    bridge.call("ping", {}, { context: "agent", timeoutMs: 100 }),
    /Agent Browser bağlı değil/u,
  );
  assert.equal(user.commands.length, 1, "missing Agent Browser must never fall back to User Browser");
});

test("bridge pairs the next unassigned profile to the expected Agent Browser context", async (t) => {
  const { dir, socketPath } = await makeSocketPath("pair-agent");
  const bridge = createEquinoxBrowserBridge({ socketPath, callTimeoutMs: 500 });
  await bridge.start();
  t.after(async () => {
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const pairing = bridge.expectContext("agent", { timeoutMs: 2_000 });
  assert.equal(pairing.context, "agent");

  const client = net.createConnection(socketPath);
  await new Promise((resolve, reject) => {
    client.once("connect", resolve);
    client.once("error", reject);
  });
  t.after(() => client.destroy());
  const commands = [];
  waitForLine(client, (message) => {
    if (message.type !== "host.send" || message.message?.type !== "command") return;
    commands.push(message.message);
    writeLine(client, {
      type: "extension.message",
      message: {
        type: "response",
        id: message.message.id,
        ok: true,
        result: { persisted: true },
      },
    });
  });
  writeLine(client, {
    type: "host.hello",
    origin: `chrome-extension://${EQUINOX_BROWSER_EXTENSION_ID}/`,
    pid: 3001,
    version: 1,
  });
  writeLine(client, {
    type: "extension.message",
    message: {
      type: "extension.hello",
      extensionId: EQUINOX_BROWSER_EXTENSION_ID,
      extensionVersion: "0.4.0-test",
      protocolVersion: 1,
      capabilities: ["context.set"],
      instanceId: "33333333-3333-4333-8333-333333333333",
      browserContext: "unassigned",
    },
  });

  const ready = await bridge.waitUntilReady(1_000, { context: "agent" });
  assert.equal(ready.context, "agent");
  assert.equal(ready.extension.browserContext, "agent");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(commands[0]?.method, "context.set");
  assert.deepEqual(commands[0]?.args, { context: "agent" });
  assert.equal(bridge.snapshot().pairing, null);
});
