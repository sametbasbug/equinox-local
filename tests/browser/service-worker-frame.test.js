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

async function createHarness({ emitHtml5DragIntercept = true, html5DragData } = {}) {
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
  let dragInterceptEnabled = false;
  let dragPointerDown = false;
  let dragInterceptEmitted = false;
  const interceptedDragData = html5DragData || {
    items: [
      { mimeType: "text/plain", data: "private-drag-value" },
      { mimeType: "text/html", data: "<b>private</b>", baseURL: "http://127.0.0.1:47840/" },
    ],
    files: ["/private/browser-drag-file.txt"],
    dragOperationsMask: 16,
  };
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
    ["frame-main", [
      axNode({ role: "button", name: "Main action", backendNodeId: 101 }),
      axNode({ role: "button", name: "Drop target", backendNodeId: 103 }),
      axNode({ role: "heading", name: "Main heading", backendNodeId: 102 }),
      axNode({ role: "button", name: "Offscreen action", backendNodeId: 999 }),
    ]],
    ["frame-same", [axNode({ role: "textbox", name: "Same field", backendNodeId: 201, value: "" })]],
    ["frame-cross", [
      axNode({ role: "textbox", name: "Cross field", backendNodeId: 301, value: "" }),
      axNode({ role: "button", name: "Cross action", backendNodeId: 302 }),
    ]],
  ]);

  const storageData = {
    browserEnabled: true,
    browserControlConsentVersion: 2,
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
        if (method === "Page.enable" || method === "Accessibility.enable" || method === "DOM.enable" || method === "Page.bringToFront" || method === "DOM.scrollIntoViewIfNeeded") return {};
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
        if (method === "Accessibility.queryAXTree") {
          const backendNodeId = params.backendNodeId;
          const nodes = [...axTrees.values()].flat().filter((node) => node.backendDOMNodeId === backendNodeId);
          return { nodes };
        }
        if (method === "DOM.resolveNode") {
          return { object: { objectId: `node-${params.backendNodeId}` } };
        }
        if (method === "Runtime.evaluate") {
          if (String(params.expression || "").includes("window.devicePixelRatio")) {
            return { result: { value: 2 } };
          }
          return { result: { value: { duration: 0 } } };
        }
        if (method === "Runtime.callFunctionOn") {
          const declaration = String(params.functionDeclaration || "");
          if (declaration.includes("elementFromPoint")) {
            return { result: { value: params.arguments?.[0]?.value?.[0] ?? null } };
          }
          if (declaration.includes("this.isConnected")) {
            return { result: { value: { exists: true, visible: true, enabled: true } } };
          }
          if (declaration.includes("selectedOptions")) {
            const wanted = params.arguments?.[0]?.value ?? "";
            return { result: { value: { value: wanted, label: wanted, selected: true } } };
          }
          if (declaration.includes("const desired = Boolean(wanted)") && declaration.includes("'checked' in this")) {
            return { result: { value: { checked: Boolean(params.arguments?.[0]?.value) } } };
          }
          if (declaration.includes("Target is not a supported editable control") && declaration.includes("dispatchEvent")) {
            const wanted = params.arguments?.[0]?.value ?? "";
            return { result: { value: { value: wanted, editable: true, kind: "input" } } };
          }
          if (declaration.includes("Target cannot receive keyboard focus")) {
            return { result: { value: { focused: true, editable: true, tagName: "input" } } };
          }
          if (declaration.includes("slice(0, 100000)")) {
            return { result: { value: "typed-value" } };
          }
          if (declaration.includes("readOnly:") && declaration.includes("tagName:")) {
            return {
              result: {
                value: {
                  checked: null,
                  selected: null,
                  expanded: null,
                  readOnly: false,
                  editable: true,
                  tagName: "input",
                  value: "fixture-value",
                },
              },
            };
          }
          return { result: { value: { value: params.arguments?.[0]?.value ?? "" } } };
        }
        if (method === "Runtime.releaseObject") return {};
        if (method === "DOM.getBoxModel") {
          if (params.backendNodeId === 103) {
            return { model: { border: [210, 100, 310, 100, 310, 140, 210, 140] } };
          }
          if (params.backendNodeId === 999) {
            return { model: { border: [10, 900, 110, 900, 110, 940, 10, 940] } };
          }
          return { model: { border: [10, 10, 110, 10, 110, 50, 10, 50] } };
        }
        if (method === "Input.setInterceptDrags") {
          dragInterceptEnabled = Boolean(params.enabled);
          return {};
        }
        if (method === "Input.dispatchKeyEvent" || method === "Input.insertText") return {};
        if (method === "Input.dispatchMouseEvent") {
          if (params.type === "mousePressed" && dragInterceptEnabled) dragPointerDown = true;
          if (
            params.type === "mouseMoved" &&
            dragInterceptEnabled &&
            dragPointerDown &&
            emitHtml5DragIntercept &&
            !dragInterceptEmitted
          ) {
            dragInterceptEmitted = true;
            queueMicrotask(() => debuggerEvent.emit(
              { tabId: tab.id },
              "Input.dragIntercepted",
              { data: interceptedDragData },
            ));
          }
          if (params.type === "mouseReleased") dragPointerDown = false;
          return {};
        }
        if (method === "Input.dispatchDragEvent") return {};
        if (method === "Input.cancelDragging") {
          dragPointerDown = false;
          return {};
        }
        if (method === "Page.getLayoutMetrics") {
          return {
            cssLayoutViewport: { pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 720 },
            cssContentSize: { width: 1280, height: 1200 },
          };
        }
        if (method === "Page.captureScreenshot") {
          return { data: Buffer.from("fake-png").toString("base64") };
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
    `${source}\n;globalThis.__frameTest = { ensureBrowserEnabledLoaded, browserSnapshot, browserScreenshot, browserFind, browserReacquire, browserClick, browserDoubleClick, browserDrag, browserHover, browserScrollIntoView, browserRefInfo, browserFill, browserSelect, browserCheck, browserPress, browserTypeText, browserScroll, currentDocumentGeneration };`,
    context,
    { filename: SERVICE_WORKER_PATH },
  );
  await context.__frameTest.ensureBrowserEnabledLoaded();

  return {
    api: context.__frameTest,
    commands,
    debuggerEvent,
    tab,
    axTrees,
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

test("snapshot v2 prunes by mode, viewport, role, query and max node count", async () => {
  const { api } = await createHarness();

  const readable = await api.browserSnapshot({ tabId: 41, mode: "readable" });
  assert.equal(readable.snapshotVersion, 3);
  assert.equal(readable.snapshot.filters.mode, "readable");
  assert.deepEqual(
    JSON.parse(JSON.stringify(readable.elements.map((item) => item.name))),
    ["Main heading"],
  );
  assert.equal(readable.refCount, 0);

  const viewportButtons = await api.browserSnapshot({
    tabId: 41,
    mode: "interactive",
    scope: "viewport",
    roles: ["button"],
  });
  assert.equal(viewportButtons.snapshot.filters.scope, "viewport");
  assert.equal(viewportButtons.elements.some((item) => item.name === "Main action"), true);
  assert.equal(viewportButtons.elements.some((item) => item.name === "Cross action"), true);
  assert.equal(viewportButtons.elements.some((item) => item.name === "Offscreen action"), false);

  const queried = await api.browserSnapshot({
    tabId: 41,
    mode: "interactive",
    roles: ["textbox"],
    query: "cross",
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(queried.elements.map((item) => item.name))),
    ["Cross field"],
  );

  const bounded = await api.browserSnapshot({ tabId: 41, mode: "interactive", maxNodes: 1 });
  assert.equal(bounded.elementCount, 1);
  assert.equal(bounded.returnedElementCount, 1);
  assert.equal(bounded.refCount <= 1, true);
  assert.equal(bounded.truncated, true);

  const compact = await api.browserSnapshot({
    tabId: 41,
    mode: "interactive",
    query: "Main action",
    output: "compact",
  });
  assert.equal(compact.outputMode, "compact");
  assert.equal(compact.elementCount, 1);
  assert.equal(compact.returnedElementCount, 1);
  assert.equal(typeof compact.text, "string");
  assert.equal(Object.hasOwn(compact, "elements"), false);
  assert.equal(Object.hasOwn(compact, "frames"), false);
});

test("snapshot v2 can safely scope to a still-valid prior root ref", async () => {
  const { api, commands } = await createHarness();
  const initial = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  const rootRef = initial.elements.find((item) => item.name === "Main action")?.ref;
  assert.ok(rootRef);

  const rooted = await api.browserSnapshot({ tabId: 41, rootRef, mode: "balanced" });
  assert.equal(rooted.snapshot.filters.rootRef, rootRef);
  assert.deepEqual(
    JSON.parse(JSON.stringify(rooted.elements.map((item) => item.name))),
    ["Main action"],
  );
  const queryCommand = commands.findLast((item) => item.method === "Accessibility.queryAXTree");
  assert.equal(queryCommand?.params?.backendNodeId, 101);
});

test("delta snapshot keeps stable refs and returns only changed projection data", async () => {
  const { api, axTrees } = await createHarness();
  const initial = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  const initialAction = initial.elements.find((item) => item.name === "Main action");
  assert.ok(initialAction?.ref);

  axTrees.get("frame-main")[0].name.value = "Main action updated";
  const delta = await api.browserSnapshot({
    tabId: 41,
    mode: "interactive",
    sinceSnapshotId: initial.snapshot.id,
  });

  assert.equal(delta.deltaVersion, 1);
  assert.equal(delta.deltaOnly, true);
  assert.equal(delta.delta.added.length, 0);
  assert.equal(delta.delta.removed.length, 0);
  assert.equal(delta.delta.changed.length, 1);
  assert.equal(delta.elements.length, 1);
  assert.equal(delta.elements[0]?.name, "Main action updated");
  assert.equal(delta.elements[0]?.ref, initialAction.ref);
  assert.equal(delta.delta.changed[0]?.ref, initialAction.ref);
  assert.equal(delta.delta.retainedRefs.includes(initialAction.ref), true);

  const fullAgain = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  assert.equal(fullAgain.elements.find((item) => item.name === "Main action updated")?.ref, initialAction.ref);

  const compactDelta = await api.browserSnapshot({
    tabId: 41,
    mode: "interactive",
    sinceSnapshotId: fullAgain.snapshot.id,
    output: "compact",
  });
  assert.equal(compactDelta.deltaOnly, true);
  assert.equal(Object.hasOwn(compactDelta, "elements"), false);
  assert.equal(Object.hasOwn(compactDelta, "frames"), false);
  assert.ok(compactDelta.delta);
});

test("unrelated DOM additions retain existing refs in delta snapshots", async () => {
  const { api, axTrees } = await createHarness();
  const initial = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  const initialRefs = initial.elements.map((item) => item.ref).filter(Boolean);
  assert.ok(initialRefs.length > 1);

  axTrees.get("frame-main").push(axNode({ role: "button", name: "Unrelated action", backendNodeId: 777 }));
  const delta = await api.browserSnapshot({
    tabId: 41,
    mode: "interactive",
    sinceSnapshotId: initial.snapshot.id,
  });

  assert.equal(delta.delta.added.length, 1);
  assert.equal(delta.delta.added[0]?.name, "Unrelated action");
  assert.deepEqual(
    [...delta.delta.retainedRefs].sort(),
    [...initialRefs].sort(),
  );
});

test("screenshot v3 crops a current root-session ref and explicit page clip", async () => {
  const { api, commands } = await createHarness();
  const snapshot = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  const ref = snapshot.elements.find((item) => item.name === "Main action")?.ref;
  assert.ok(ref);

  const byRef = await api.browserScreenshot({ tabId: 41, ref });
  assert.equal(byRef.screenshotVersion, 3);
  assert.equal(byRef.source, "ref");
  assert.equal(byRef.ref, ref);
  assert.deepEqual(JSON.parse(JSON.stringify(byRef.clip)), { x: 10, y: 10, width: 100, height: 40 });
  assert.equal(byRef.cssWidth, 100);
  assert.equal(byRef.cssHeight, 40);
  assert.equal(byRef.pixelWidth, 100);
  assert.equal(byRef.pixelHeight, 40);
  const refCapture = commands.findLast((item) => item.method === "Page.captureScreenshot");
  assert.equal(refCapture?.params?.captureBeyondViewport, true);
  assert.deepEqual(JSON.parse(JSON.stringify(refCapture?.params?.clip)), {
    x: 10,
    y: 10,
    width: 100,
    height: 40,
    scale: 0.5,
  });

  const clipped = await api.browserScreenshot({
    tabId: 41,
    clip: { x: 20, y: 30, width: 200, height: 120 },
  });
  assert.equal(clipped.source, "clip");
  assert.deepEqual(JSON.parse(JSON.stringify(clipped.clip)), { x: 20, y: 30, width: 200, height: 120 });
});

test("annotated screenshot labels current root refs, skips OOPIF refs and removes its overlay", async () => {
  const { api, commands } = await createHarness();
  const snapshot = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  const rootRef = snapshot.elements.find((item) => item.name === "Main action")?.ref;
  const oopifRef = snapshot.elements.find((item) => item.name === "Cross action")?.ref;
  assert.ok(rootRef);
  assert.ok(oopifRef);

  const captured = await api.browserScreenshot({ tabId: 41, annotateRefs: true });
  assert.equal(captured.screenshotVersion, 3);
  assert.equal(captured.annotations.requested, true);
  assert.equal(captured.annotations.annotatedRefs.includes(rootRef), true);
  assert.equal(captured.annotations.skippedOopifRefs.includes(oopifRef), true);

  const captureIndex = commands.findIndex((item) => item.method === "Page.captureScreenshot");
  const overlayIndex = commands.findIndex((item) => (
    item.method === "Runtime.evaluate" &&
    String(item.params?.expression || "").includes("__equinox_browser_ref_annotations__") &&
    String(item.params?.expression || "").includes("createElement")
  ));
  const cleanupIndex = commands.findIndex((item, index) => (
    index > captureIndex &&
    item.method === "Runtime.evaluate" &&
    String(item.params?.expression || "").includes("__equinox_browser_ref_annotations__") &&
    String(item.params?.expression || "").includes("?.remove")
  ));
  assert.equal(overlayIndex >= 0 && overlayIndex < captureIndex, true);
  assert.equal(cleanupIndex > captureIndex, true);
});

test("dense screenshot annotations stay bounded and avoid overlapping labels", async () => {
  const { api, axTrees } = await createHarness();
  for (let index = 0; index < 70; index += 1) {
    axTrees.get("frame-main").push(axNode({
      role: "button",
      name: `Dense action ${index}`,
      backendNodeId: 400 + index,
    }));
  }
  const snapshot = await api.browserSnapshot({ tabId: 41, mode: "interactive", maxNodes: 250 });
  const offscreenRef = snapshot.elements.find((item) => item.name === "Offscreen action")?.ref;
  const captured = await api.browserScreenshot({ tabId: 41, annotateRefs: true });

  assert.equal(captured.annotations.annotatedRefs.length <= 50, true);
  assert.equal(captured.annotations.skippedOverlapRefs.length > 0, true);
  assert.equal(captured.annotations.truncated, true);
  assert.equal(captured.annotations.annotatedRefs.includes(offscreenRef), false);
});

test("ref screenshot fails closed for OOPIF refs and conflicting scopes", async () => {
  const { api } = await createHarness();
  const snapshot = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  const oopifRef = snapshot.elements.find((item) => item.name === "Cross action")?.ref;
  const rootRef = snapshot.elements.find((item) => item.name === "Main action")?.ref;
  assert.ok(oopifRef);
  assert.ok(rootRef);

  await assert.rejects(
    api.browserScreenshot({ tabId: 41, ref: oopifRef }),
    /out-of-process iframe/i,
  );
  await assert.rejects(
    api.browserScreenshot({ tabId: 41, ref: rootRef, fullPage: true }),
    /mutually exclusive/i,
  );
});

test("safe reacquire returns one high-confidence ref after same-document DOM replacement", async () => {
  const { api, axTrees } = await createHarness();
  const initial = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  const oldRef = initial.elements.find((item) => item.name === "Main action")?.ref;
  assert.ok(oldRef);

  axTrees.get("frame-main")[0].backendDOMNodeId = 150;
  const reacquired = await api.browserReacquire({
    tabId: 41,
    oldRef,
    fromSnapshotId: initial.snapshot.id,
  });
  assert.equal(reacquired.reacquireVersion, 2);
  assert.equal(reacquired.status, "reacquired");
  assert.equal(reacquired.refContextValid, true);
  assert.equal(reacquired.freshSnapshotRequired, false);
  assert.equal(reacquired.unique, true);
  assert.equal(reacquired.confidence, "high");
  assert.notEqual(reacquired.newRef, oldRef);
  assert.equal(reacquired.match?.name, "Main action");
});

test("safe reacquire refuses ambiguous semantic replacements", async () => {
  const { api, axTrees } = await createHarness();
  const initial = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  const oldRef = initial.elements.find((item) => item.name === "Main action")?.ref;
  assert.ok(oldRef);

  axTrees.get("frame-main")[0].backendDOMNodeId = 150;
  axTrees.get("frame-main").push(axNode({ role: "button", name: "Main action", backendNodeId: 151 }));
  const result = await api.browserReacquire({
    tabId: 41,
    oldRef,
    fromSnapshotId: initial.snapshot.id,
  });
  assert.equal(result.status, "ambiguous");
  assert.equal(result.unique, false);
  assert.equal(result.newRef, null);
  assert.equal(result.candidateCount, 2);
  assert.equal(result.refContextValid, true);
  assert.equal(result.freshSnapshotRequired, false);
});

test("cross-document reacquire reports invalid ref context and requires a fresh snapshot", async () => {
  const { api, debuggerEvent } = await createHarness();
  const initial = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  const oldRef = initial.elements.find((item) => item.name === "Main action")?.ref;
  assert.ok(oldRef);

  debuggerEvent.emit(
    { tabId: 41 },
    "Page.frameNavigated",
    { frame: { id: "frame-main", url: "http://127.0.0.1:47840/next" } },
  );

  const result = await api.browserReacquire({
    tabId: 41,
    oldRef,
    fromSnapshotId: initial.snapshot.id,
  });
  assert.equal(result.reacquireVersion, 2);
  assert.equal(result.status, "stale_document");
  assert.equal(result.newRef, null);
  assert.equal(result.refContextValid, false);
  assert.equal(result.freshSnapshotRequired, true);
  assert.equal(result.sourceDocumentGeneration, initial.snapshot.documentGeneration);
  assert.ok(result.currentDocumentGeneration > result.sourceDocumentGeneration);

  await assert.rejects(
    api.browserRefInfo({ tabId: 41, ref: oldRef }),
    /stale after document\/frame navigation|Take a new snapshot first/i,
  );
});

test("controlled click after chains bounded DOM stability and delta snapshot", async () => {
  const { api } = await createHarness();
  const initial = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  const ref = initial.elements.find((item) => item.name === "Main action")?.ref;
  assert.ok(ref);

  const clicked = await api.browserClick({
    tabId: 41,
    ref,
    after: {
      waitFor: "dom_stable",
      snapshot: "delta",
      quietMs: 100,
      timeoutMs: 700,
    },
  });

  assert.equal(clicked.compoundActionVersion, 2);
  assert.equal(clicked.after?.ok, true);
  assert.equal(clicked.after?.wait?.matched, "dom_stable");
  assert.equal(clicked.after?.snapshot?.deltaOnly, true);
  assert.equal(clicked.after?.snapshot?.delta?.baseSnapshotId, initial.snapshot.id);
});

test("controlled click after validates its delta base before dispatching input", async () => {
  const { api, commands } = await createHarness();
  await assert.rejects(
    api.browserClick({
      tabId: 41,
      ref: "@e1",
      after: { snapshot: "delta" },
    }),
    /requires a current snapshot base/i,
  );
  assert.equal(commands.some((item) => item.method === "Input.dispatchMouseEvent"), false);
});

test("double click emits the native two-click count sequence on one semantic ref", async () => {
  const { api, commands } = await createHarness();
  const snapshot = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  const ref = snapshot.elements.find((item) => item.name === "Main action")?.ref;
  assert.ok(ref);

  const result = await api.browserDoubleClick({ tabId: 41, ref });
  assert.equal(result.doubleClickVersion, 1);
  assert.equal(result.clickCount, 2);

  const inputCommands = commands.filter((item) => item.method === "Input.dispatchMouseEvent").slice(-5);
  assert.equal(inputCommands.length, 5);
  assert.equal(inputCommands[0]?.params?.type, "mouseMoved");
  assert.deepEqual(
    inputCommands.slice(1).map((item) => ({ type: item.params?.type, clickCount: item.params?.clickCount })),
    [
      { type: "mousePressed", clickCount: 1 },
      { type: "mouseReleased", clickCount: 1 },
      { type: "mousePressed", clickCount: 2 },
      { type: "mouseReleased", clickCount: 2 },
    ],
  );
});

test("semantic pointer drag moves between two current root-frame refs and fails closed cross-frame", async () => {
  const { api, commands } = await createHarness();
  const snapshot = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  const sourceRef = snapshot.elements.find((item) => item.name === "Main action")?.ref;
  const targetRef = snapshot.elements.find((item) => item.name === "Drop target")?.ref;
  const crossFrameRef = snapshot.elements.find((item) => item.name === "Cross action")?.ref;
  assert.ok(sourceRef);
  assert.ok(targetRef);
  assert.ok(crossFrameRef);

  const result = await api.browserDrag({
    tabId: 41,
    sourceRef,
    targetRef,
    steps: 4,
    durationMs: 100,
  });
  assert.equal(result.pointerDragVersion, 1);
  assert.equal(result.actionDispatched, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.sourcePoint)), { x: 60, y: 30 });
  assert.deepEqual(JSON.parse(JSON.stringify(result.targetPoint)), { x: 260, y: 120 });

  const inputCommands = commands.filter((item) => item.method === "Input.dispatchMouseEvent").slice(-7);
  assert.equal(inputCommands[0]?.params?.type, "mouseMoved");
  assert.equal(inputCommands[1]?.params?.type, "mousePressed");
  assert.equal(inputCommands[1]?.params?.buttons, 1);
  assert.equal(inputCommands.at(-1)?.params?.type, "mouseReleased");
  assert.equal(inputCommands.at(-1)?.params?.x, 260);
  assert.equal(inputCommands.at(-1)?.params?.y, 120);
  assert.equal(inputCommands.slice(2, -1).every((item) => item.params?.type === "mouseMoved" && item.params?.buttons === 1), true);

  const fresh = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  const freshSource = fresh.elements.find((item) => item.name === "Main action")?.ref;
  const freshCross = fresh.elements.find((item) => item.name === "Cross action")?.ref;
  const beforeRejectedDrag = commands.filter((item) => item.method === "Input.dispatchMouseEvent").length;
  await assert.rejects(
    api.browserDrag({ tabId: 41, sourceRef: freshSource, targetRef: freshCross }),
    /same frame/i,
  );
  assert.equal(commands.filter((item) => item.method === "Input.dispatchMouseEvent").length, beforeRejectedDrag);
});

test("semantic HTML5 drag replays intercepted DragData without exposing its raw payload", async () => {
  const { api, commands } = await createHarness();
  const snapshot = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  const sourceRef = snapshot.elements.find((item) => item.name === "Main action")?.ref;
  const targetRef = snapshot.elements.find((item) => item.name === "Drop target")?.ref;
  assert.ok(sourceRef);
  assert.ok(targetRef);

  const result = await api.browserDrag({
    tabId: 41,
    sourceRef,
    targetRef,
    mode: "html5",
    steps: 4,
    durationMs: 100,
  });
  assert.equal(result.html5DragVersion, 1);
  assert.equal(result.mode, "html5");
  assert.equal(result.actionDispatched, true);
  assert.equal(result.dropDispatched, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.dragDataSummary)), {
    itemCount: 2,
    fileCount: 1,
    hasFiles: true,
    mimeTypes: ["text/plain", "text/html"],
    dragOperationsMask: 16,
  });
  assert.equal(JSON.stringify(result).includes("private-drag-value"), false);
  assert.equal(JSON.stringify(result).includes("browser-drag-file.txt"), false);

  const interceptCommands = commands.filter((item) => item.method === "Input.setInterceptDrags");
  assert.deepEqual(interceptCommands.map((item) => item.params.enabled), [true, false]);
  const dragEvents = commands.filter((item) => item.method === "Input.dispatchDragEvent");
  assert.deepEqual(dragEvents.map((item) => item.params.type), ["dragEnter", "dragOver", "dragOver", "drop"]);
  assert.equal(dragEvents.at(-1)?.params?.x, 260);
  assert.equal(dragEvents.at(-1)?.params?.y, 120);
  assert.equal(dragEvents.at(-1)?.params?.data?.items?.[0]?.data, "private-drag-value");
  assert.equal(dragEvents.at(-1)?.params?.data?.files?.[0], "/private/browser-drag-file.txt");
  const release = commands.findLast((item) => item.method === "Input.dispatchMouseEvent" && item.params?.type === "mouseReleased");
  assert.equal(release?.params?.x, 260);
  assert.equal(release?.params?.y, 120);
});

test("semantic HTML5 drag rejects oversized payloads and restores Chrome drag interception", async () => {
  const { api, commands } = await createHarness({
    html5DragData: {
      items: [{ mimeType: "text/plain", data: "x".repeat((512 * 1024) + 1) }],
      files: [],
      dragOperationsMask: 1,
    },
  });
  const snapshot = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  const sourceRef = snapshot.elements.find((item) => item.name === "Main action")?.ref;
  const targetRef = snapshot.elements.find((item) => item.name === "Drop target")?.ref;
  assert.ok(sourceRef);
  assert.ok(targetRef);

  await assert.rejects(
    api.browserDrag({
      tabId: 41,
      sourceRef,
      targetRef,
      mode: "html5",
      steps: 4,
      durationMs: 100,
    }),
    /bounded data limit/i,
  );

  const interceptCommands = commands.filter((item) => item.method === "Input.setInterceptDrags");
  assert.deepEqual(interceptCommands.map((item) => item.params.enabled), [true, false]);
  assert.equal(commands.some((item) => item.method === "Input.cancelDragging"), true);
  assert.equal(
    commands.some((item) => item.method === "Input.dispatchDragEvent" && item.params?.type === "drop"),
    false,
  );
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

test("rich click sends button, modifier and bounded press-release metadata", async () => {
  const { api, commands } = await createHarness();
  const snapshot = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  const ref = snapshot.elements.find((item) => item.name === "Main action")?.ref;
  assert.ok(ref);

  const clicked = await api.browserClick({
    tabId: 41,
    ref,
    button: "right",
    modifiers: ["meta", "shift"],
    delayMs: 5,
  });
  assert.equal(clicked.clickVersion, 2);
  assert.equal(clicked.button, "right");
  assert.deepEqual(JSON.parse(JSON.stringify(clicked.modifiers)), ["meta", "shift"]);
  assert.equal(clicked.delayMs, 5);

  const input = commands.filter((item) => item.method === "Input.dispatchMouseEvent").slice(-3);
  assert.equal(input[1]?.params?.type, "mousePressed");
  assert.equal(input[1]?.params?.button, "right");
  assert.equal(input[1]?.params?.buttons, 2);
  assert.equal(input[1]?.params?.modifiers, 12);
  assert.equal(input[2]?.params?.type, "mouseReleased");
  assert.equal(input[2]?.params?.buttons, 0);
  assert.equal(input[2]?.params?.modifiers, 12);
});

test("hover, scroll_into_view and ref_info share verified semantic actionability", async () => {
  const { api, commands } = await createHarness();
  let snapshot = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  let ref = snapshot.elements.find((item) => item.name === "Main action")?.ref;
  assert.ok(ref);

  const hovered = await api.browserHover({ tabId: 41, ref });
  assert.equal(hovered.actionabilityVersion, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(hovered.point)), { x: 60, y: 30 });
  assert.equal(commands.some((item) => item.method === "DOM.scrollIntoViewIfNeeded"), true);

  snapshot = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  ref = snapshot.elements.find((item) => item.name === "Main action")?.ref;
  const scrolled = await api.browserScrollIntoView({ tabId: 41, ref });
  assert.equal(scrolled.actionabilityVersion, 1);
  assert.equal(scrolled.scrolledIntoView, true);

  snapshot = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  ref = snapshot.elements.find((item) => item.name === "Main action")?.ref;
  const info = await api.browserRefInfo({ tabId: 41, ref });
  assert.equal(info.actionabilityVersion, 1);
  assert.equal(info.exists, true);
  assert.equal(info.visible, true);
  assert.equal(info.enabled, true);
  assert.deepEqual(JSON.parse(JSON.stringify(info.box)), { x: 10, y: 10, width: 100, height: 40 });
  assert.equal(Object.keys(info).length <= 20, true);
  for (const forbidden of ["outerHTML", "innerHTML", "attributes", "children", "backendNodeId", "objectId"]) {
    assert.equal(Object.hasOwn(info, forbidden), false);
  }
});

test("ref-targeted press and type_text keep keyboard input on the OOPIF session", async () => {
  const { api, commands } = await createHarness();
  let snapshot = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  let ref = snapshot.elements.find((item) => item.name === "Cross field")?.ref;
  assert.ok(ref);

  const pressed = await api.browserPress({ tabId: 41, ref, key: "Enter" });
  assert.equal(pressed.inputVersion, 1);
  assert.equal(pressed.sessionScope, "child");
  const pressEvents = commands.filter((item) => item.method === "Input.dispatchKeyEvent").slice(-2);
  assert.equal(pressEvents.length, 2);
  assert.ok(pressEvents.every((item) => item.sessionId === "session-cross"));

  snapshot = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  ref = snapshot.elements.find((item) => item.name === "Cross field")?.ref;
  const typed = await api.browserTypeText({ tabId: 41, ref, text: "Hi" });
  assert.equal(typed.inputVersion, 1);
  assert.equal(typed.mode, "key_events");
  assert.equal(typed.sessionScope, "child");
  const typedEvents = commands.filter((item) => item.method === "Input.dispatchKeyEvent").slice(-4);
  assert.equal(typedEvents.length, 4);
  assert.ok(typedEvents.every((item) => item.sessionId === "session-cross"));

  snapshot = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  ref = snapshot.elements.find((item) => item.name === "Cross field")?.ref;
  const emoji = await api.browserTypeText({ tabId: 41, ref, text: "🙂" });
  assert.equal(emoji.mode, "insert_text");
  const insert = commands.findLast((item) => item.method === "Input.insertText");
  assert.equal(insert?.sessionId, "session-cross");
  assert.equal(insert?.params?.text, "🙂");
});

test("fill can run one bounded post-action snapshot without a second tool round trip", async () => {
  const { api } = await createHarness();
  const snapshot = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  const ref = snapshot.elements.find((item) => item.name === "Cross field")?.ref;
  assert.ok(ref);

  const filled = await api.browserFill({
    tabId: 41,
    ref,
    value: "after-value",
    after: { snapshot: "full" },
  });
  assert.equal(filled.inputVersion, 1);
  assert.equal(filled.compoundActionVersion, 2);
  assert.equal(filled.after?.ok, true);
  assert.equal(filled.after?.snapshot?.outputMode, "compact");
  assert.equal(Object.hasOwn(filled.after?.snapshot || {}, "elements"), false);
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
