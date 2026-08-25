import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const SERVICE_WORKER_PATH = fileURLToPath(new URL("../../extension/service-worker.js", import.meta.url));

function createEvent() {
  const listeners = [];
  return {
    addListener(listener) {
      listeners.push(listener);
    },
    emit(...args) {
      for (const listener of [...listeners]) listener(...args);
    },
  };
}

function axNode({ role, name, backendNodeId, value = null }) {
  return {
    ignored: false,
    role: { value: role },
    name: { value: name },
    ...(value == null ? {} : { value: { value } }),
    backendDOMNodeId: backendNodeId,
    properties: [],
  };
}

async function createHarness() {
  const debuggerEvent = createEvent();
  const debuggerDetach = createEvent();
  const tabsRemoved = createEvent();
  const tabsUpdated = createEvent();
  const alarmEvent = createEvent();
  const runtimeStartup = createEvent();
  const runtimeInstalled = createEvent();
  const nativeMessage = createEvent();
  const nativeDisconnect = createEvent();
  const commands = [];
  const tab = {
    id: 41,
    windowId: 7,
    index: 0,
    active: true,
    pinned: false,
    title: "Frame fixture",
    url: "http://127.0.0.1:47840/",
    status: "complete",
  };

  const frameTree = {
    frame: {
      id: "frame-main",
      url: tab.url,
      securityOrigin: "http://127.0.0.1:47840",
      mimeType: "text/html",
    },
    childFrames: [
      {
        frame: {
          id: "frame-same",
          parentId: "frame-main",
          name: "same",
          url: "http://127.0.0.1:47840/same",
          securityOrigin: "http://127.0.0.1:47840",
          mimeType: "text/html",
        },
      },
      {
        frame: {
          id: "frame-cross",
          parentId: "frame-main",
          name: "cross",
          url: "http://localhost:47841/cross",
          securityOrigin: "http://localhost:47841",
          mimeType: "text/html",
        },
      },
    ],
  };

  const axTrees = new Map([
    ["frame-main", [axNode({ role: "button", name: "Main action", backendNodeId: 101 })]],
    ["frame-same", [axNode({ role: "textbox", name: "Same field", backendNodeId: 201, value: "" })]],
    ["frame-cross", [
      axNode({ role: "textbox", name: "Cross field", backendNodeId: 301, value: "" }),
      axNode({ role: "button", name: "Cross action", backendNodeId: 302 }),
    ]],
  ]);

  const storageData = {
    browserEnabled: true,
    browserControlConsentVersion: 1,
    agentCursorEnabled: true,
    agentCursorName: "Agent",
  };
  const chrome = {
    debugger: {
      onEvent: debuggerEvent,
      onDetach: debuggerDetach,
      async attach() {},
      async detach() {},
      async sendCommand(debuggee, method, params = {}) {
        const sessionId = debuggee?.sessionId || null;
        commands.push({ tabId: debuggee?.tabId, sessionId, method, params });
        if (method === "Page.enable" || method === "Accessibility.enable" || method === "Page.bringToFront" || method === "DOM.scrollIntoViewIfNeeded") return {};
        if (method === "Target.setAutoAttach") {
          debuggerEvent.emit(
            { tabId: tab.id },
            "Target.attachedToTarget",
            {
              sessionId: "session-cross",
              targetInfo: {
                targetId: "frame-cross",
                type: "iframe",
                title: "cross",
                url: "http://localhost:47841/cross",
              },
            },
          );
          return {};
        }
        if (method === "Page.getFrameTree") {
          if (sessionId === "session-cross") {
            return {
              frameTree: {
                frame: {
                  id: "frame-cross",
                  url: "http://localhost:47841/cross",
                  securityOrigin: "http://localhost:47841",
                  mimeType: "text/html",
                },
              },
            };
          }
          return { frameTree };
        }
        if (method === "Accessibility.getFullAXTree") {
          const frameId = params.frameId || (sessionId === "session-cross" ? "frame-cross" : "frame-main");
          return { nodes: axTrees.get(frameId) || [] };
        }
        if (method === "DOM.resolveNode") {
          return { object: { objectId: `node-${params.backendNodeId}` } };
        }
        if (method === "Runtime.evaluate") {
          return { result: { value: { duration: 0 } } };
        }
        if (method === "Runtime.callFunctionOn") {
          if (String(params.functionDeclaration || "").includes("elementFromPoint")) {
            return { result: { value: params.arguments?.[0]?.value?.[0] ?? null } };
          }
          return { result: { value: { value: params.arguments?.[0]?.value ?? "" } } };
        }
        if (method === "Runtime.releaseObject") return {};
        if (method === "DOM.getBoxModel") {
          return { model: { border: [10, 10, 110, 10, 110, 50, 10, 50] } };
        }
        if (method === "Input.dispatchMouseEvent") return {};
        if (method === "Page.getLayoutMetrics") {
          return { cssLayoutViewport: { clientWidth: 1280, clientHeight: 720 } };
        }
        throw new Error(`Unexpected CDP command: ${method} (${sessionId || "root"})`);
      },
    },
    tabs: {
      onRemoved: tabsRemoved,
      onUpdated: tabsUpdated,
      async get(id) {
        assert.equal(id, tab.id);
        return { ...tab };
      },
      async query() {
        return [{ ...tab }];
      },
      async update(id, updates) {
        assert.equal(id, tab.id);
        Object.assign(tab, updates);
        return { ...tab };
      },
      async remove() {},
    },
    runtime: {
      id: "fixture-extension",
      lastError: null,
      onStartup: runtimeStartup,
      onInstalled: runtimeInstalled,
      getManifest() {
        return { version: "0.1.0" };
      },
      connectNative() {
        return {
          onMessage: nativeMessage,
          onDisconnect: nativeDisconnect,
          postMessage() {},
        };
      },
      reload() {},
    },
    alarms: {
      onAlarm: alarmEvent,
      create() {},
      async clear() {
        return true;
      },
    },
    storage: {
      local: {
        async get(key) {
          return { [key]: storageData[key] };
        },
        async set(values) {
          Object.assign(storageData, values);
        },
      },
    },
  };

  const source = await fs.readFile(SERVICE_WORKER_PATH, "utf8");
  const context = {
    chrome,
    console,
    URL,
    setTimeout,
    clearTimeout,
    queueMicrotask,
  };
  vm.runInNewContext(
    `${source}\n;globalThis.__frameTest = { ensureBrowserEnabledLoaded, browserSnapshot, browserFind, browserClick, browserFill, browserScroll, currentDocumentGeneration };`,
    context,
    { filename: SERVICE_WORKER_PATH },
  );
  await context.__frameTest.ensureBrowserEnabledLoaded();

  return {
    api: context.__frameTest,
    commands,
    debuggerEvent,
    tab,
  };
}

test("snapshot exposes main, same-origin iframe and explicit OOPIF frame context", async () => {
  const { api } = await createHarness();
  const snapshot = await api.browserSnapshot({ tabId: 41 });

  assert.equal(snapshot.snapshot.mainFrameId, "frame-main");
  assert.equal(snapshot.frames.length, 3);
  assert.deepEqual(
    JSON.parse(JSON.stringify(snapshot.frames.map(({ id, process, sessionScope }) => ({ id, process, sessionScope })))),
    [
      { id: "frame-main", process: "same-process", sessionScope: "root" },
      { id: "frame-same", process: "same-process", sessionScope: "root" },
      { id: "frame-cross", process: "oopif", sessionScope: "child" },
    ],
  );
  assert.equal(snapshot.elements.find((item) => item.name === "Same field")?.frameId, "frame-same");
  assert.equal(snapshot.elements.find((item) => item.name === "Cross field")?.frameProcess, "oopif");
});

test("semantic find and fill route OOPIF refs through the child CDP session", async () => {
  const { api, commands } = await createHarness();
  const found = await api.browserFind({ tabId: 41, query: "Cross field", role: "textbox" });
  assert.equal(found.count, 1);
  const ref = found.matches[0]?.ref;
  assert.ok(ref);

  const filled = await api.browserFill({ tabId: 41, ref, value: "oopif-value" });
  const resolve = commands.findLast((item) => item.method === "DOM.resolveNode");
  const call = commands.findLast((item) => item.method === "Runtime.callFunctionOn");
  const cursor = commands.findLast((item) => item.method === "Runtime.evaluate");
  const mouseMove = commands.findLast((item) => item.method === "Input.dispatchMouseEvent" && item.params?.type === "mouseMoved");
  assert.equal(resolve?.sessionId, "session-cross");
  assert.equal(call?.sessionId, "session-cross");
  assert.equal(cursor?.sessionId, "session-cross");
  assert.equal(mouseMove?.sessionId, "session-cross");
  assert.equal(filled.sessionScope, "child");
  assert.deepEqual(JSON.parse(JSON.stringify(filled.point)), { x: 60, y: 30 });
});

test("same-origin iframe refs stay on the root session while OOPIF clicks use child input routing", async () => {
  const { api, commands } = await createHarness();
  const snapshot = await api.browserSnapshot({ tabId: 41 });
  const same = snapshot.elements.find((item) => item.name === "Same field");
  assert.ok(same?.ref);
  await api.browserFill({ tabId: 41, ref: same.ref, value: "same-value" });
  assert.equal(commands.findLast((item) => item.method === "Runtime.callFunctionOn")?.sessionId, null);

  const snapshot2 = await api.browserSnapshot({ tabId: 41 });
  const crossButton = snapshot2.elements.find((item) => item.name === "Cross action");
  assert.ok(crossButton?.ref);
  await api.browserClick({ tabId: 41, ref: crossButton.ref });
  const inputCommands = commands.filter((item) => item.method === "Input.dispatchMouseEvent").slice(-3);
  assert.equal(inputCommands.length, 3);
  assert.ok(inputCommands.every((item) => item.sessionId === "session-cross"));
});

test("unscoped scroll shows the agent cursor at the wheel point before scrolling", async () => {
  const { api, commands } = await createHarness();
  await api.browserScroll({ tabId: 41, direction: "down", pixels: 420 });

  const inputCommands = commands.filter((item) => item.method === "Input.dispatchMouseEvent").slice(-2);
  assert.equal(inputCommands.length, 2);
  assert.equal(inputCommands[0]?.params?.type, "mouseMoved");
  assert.equal(inputCommands[1]?.params?.type, "mouseWheel");
  assert.deepEqual(
    { x: inputCommands[0]?.params?.x, y: inputCommands[0]?.params?.y },
    { x: 640, y: 360 },
  );
  assert.equal(inputCommands[1]?.params?.deltaY, 420);
  assert.equal(commands.some((item) => item.method === "Runtime.evaluate"), true);
});

test("frame navigation increments document generation and rejects stale refs", async () => {
  const { api, debuggerEvent } = await createHarness();
  const snapshot = await api.browserSnapshot({ tabId: 41 });
  const stale = snapshot.elements.find((item) => item.name === "Same field");
  assert.ok(stale?.ref);
  const generation = snapshot.snapshot.documentGeneration;

  debuggerEvent.emit(
    { tabId: 41 },
    "Page.frameNavigated",
    { frame: { id: "frame-same", parentId: "frame-main", url: "http://127.0.0.1:47840/same-v2" } },
  );
  assert.ok(api.currentDocumentGeneration(41) > generation);
  await assert.rejects(
    api.browserFill({ tabId: 41, ref: stale.ref, value: "should-fail" }),
    /stale after document\/frame navigation/i,
  );
});
