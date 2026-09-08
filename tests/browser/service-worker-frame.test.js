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

function axNode({ role, name, backendNodeId = null, value = null, nodeId = null, parentId = null, childIds = null, properties = [] }) {
  return {
    ignored: false,
    ...(nodeId == null ? {} : { nodeId: String(nodeId) }),
    ...(parentId == null ? {} : { parentId: String(parentId) }),
    ...(childIds == null ? {} : { childIds: childIds.map(String) }),
    role: { value: role },
    name: { value: name },
    ...(value == null ? {} : { value: { value } }),
    ...(backendNodeId == null ? {} : { backendDOMNodeId: backendNodeId }),
    properties,
  };
}

async function createHarness({
  emitHtml5DragIntercept = true,
  html5DragData,
  requireAncestorHitRelation = false,
  fallbackNames = {},
  pdfDataBuffer = null,
  boxModelFailures = 0,
  detachedBackendNodeIds = [],
  onDetachedBackendNode = null,
  checkActionFailureMessage = null,
  initialRangeStates = {},
  ariaRangeUsesLastPointerMove = false,
} = {}) {
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
  const timeoutDelays = [];
  let dragInterceptEnabled = false;
  let dragPointerDown = false;
  let dragInterceptEmitted = false;
  let lastMousePoint = null;
  let remainingBoxModelFailures = Math.max(0, Number(boxModelFailures) || 0);
  const detachedBackendNodes = new Set((detachedBackendNodeIds || []).map((value) => Number(value)));
  const rangeStates = new Map(Object.entries(initialRangeStates || {}).map(([key, value]) => [Number(key), { ...value }]));
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
    title: pdfDataBuffer ? "document.pdf" : "Frame fixture",
    url: pdfDataBuffer ? "https://example.test/document.pdf" : "http://127.0.0.1:47840/",
    status: "complete",
  };

  const frameTree = {
    frame: {
      id: "frame-main",
      url: tab.url,
      securityOrigin: pdfDataBuffer ? "https://example.test" : "http://127.0.0.1:47840",
      mimeType: pdfDataBuffer ? "application/pdf" : "text/html",
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
          url: pdfDataBuffer
            ? "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html"
            : "http://localhost:47841/cross",
          securityOrigin: pdfDataBuffer
            ? "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai"
            : "http://localhost:47841",
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
                url: pdfDataBuffer
                  ? "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html"
                  : "http://localhost:47841/cross",
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
                  parentId: "frame-main",
                  url: pdfDataBuffer
                    ? "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html"
                    : "http://localhost:47841/cross",
                  securityOrigin: pdfDataBuffer
                    ? "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai"
                    : "http://localhost:47841",
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
        if (method === "DOM.getFrameOwner") {
          if (params.frameId === "frame-cross") return { backendNodeId: 7001 };
          if (params.frameId === "frame-same") return { backendNodeId: 7002 };
          throw new Error(`Unknown frame owner: ${params.frameId}`);
        }
        if (method === "Runtime.evaluate") {
          if (pdfDataBuffer && String(params.expression || "").includes("getSaveDataBlock")) {
            return { result: { value: {
              byteLength: pdfDataBuffer.length,
              data: pdfDataBuffer.toString("base64"),
            } } };
          }
          if (String(params.expression || "").includes("window.devicePixelRatio")) {
            return { result: { value: 2 } };
          }
          if (String(params.expression || "").includes("window.scrollX")) {
            return { result: { value: { x: 0, y: 0 } } };
          }
          return { result: { value: { duration: 0 } } };
        }
        if (method === "Runtime.callFunctionOn") {
          const declaration = String(params.functionDeclaration || "");
          if (declaration.includes("__equinoxFrameRect")) {
            const objectId = String(params.objectId || "");
            if (objectId === "node-7001") return { result: { value: { left: 200, top: 100, right: 600, bottom: 500, width: 400, height: 400, clientLeft: 0, clientTop: 0, offsetWidth: 400, offsetHeight: 400 } } };
            if (objectId === "node-7002") return { result: { value: { left: 120, top: 80, right: 520, bottom: 480, width: 400, height: 400, clientLeft: 0, clientTop: 0, offsetWidth: 400, offsetHeight: 400 } } };
            return { result: { value: { left: 10, top: 10, right: 110, bottom: 50, width: 100, height: 40, clientLeft: 0, clientTop: 0, offsetWidth: 100, offsetHeight: 40 } } };
          }
          if (declaration.includes("elementFromPoint")) {
            if (requireAncestorHitRelation && !declaration.includes("composedContains(hit, this)")) {
              return { result: { value: null } };
            }
            return { result: { value: params.arguments?.[0]?.value?.[0] ?? null } };
          }
          if (declaration.includes('aria-label') && declaration.includes('nearby_text')) {
            const backendNodeId = Number(String(params.objectId || '').replace('node-', ''));
            return { result: { value: fallbackNames[backendNodeId] || null } };
          }
          if (declaration.includes("__equinoxRangeState")) {
            const backendNodeId = Number(String(params.objectId || '').replace('node-', ''));
            const state = rangeStates.get(backendNodeId);
            return { result: { value: state ? { supported: true, ...state } : { supported: false } } };
          }
          if (declaration.includes("__equinoxNativeRangeSet")) {
            const backendNodeId = Number(String(params.objectId || '').replace('node-', ''));
            const state = rangeStates.get(backendNodeId);
            if (!state || state.kind !== "native") return { exceptionDetails: { text: "Target is not a native range input" } };
            const wanted = Number(params.arguments?.[0]?.value);
            const step = Number(state.step);
            const actual = Number.isFinite(step) && step > 0
              ? Math.max(state.min, Math.min(state.max, Math.round((wanted - state.min) / step) * step + state.min))
              : wanted;
            state.current = actual;
            return { result: { value: { value: actual } } };
          }
          if (declaration.includes("this.isConnected")) {
            return { result: { value: { exists: true, visible: true, enabled: true } } };
          }
          if (declaration.includes("selectedOptions")) {
            const wanted = params.arguments?.[0]?.value ?? "";
            return { result: { value: { value: wanted, label: wanted, selected: true } } };
          }
          if (declaration.includes("const desired = Boolean(wanted)") && declaration.includes("'checked' in this")) {
            if (checkActionFailureMessage) return { exceptionDetails: { text: String(checkActionFailureMessage) } };
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
                  pressed: true,
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
          if (detachedBackendNodes.has(Number(params.backendNodeId))) {
            onDetachedBackendNode?.({ backendNodeId: Number(params.backendNodeId), axTrees, detachedBackendNodes });
            throw new Error("Node is detached from document");
          }
          if (remainingBoxModelFailures > 0) {
            remainingBoxModelFailures -= 1;
            throw new Error("Could not compute box model.");
          }
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
          if (params.type === "mouseMoved") {
            lastMousePoint = { x: Number(params.x), y: Number(params.y) };
          }
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
          if (params.type === "mouseReleased") {
            dragPointerDown = false;
            for (const state of rangeStates.values()) {
              if (state.kind !== "aria" || !Number.isFinite(Number(state.min)) || !Number.isFinite(Number(state.max))) continue;
              const pointer = ariaRangeUsesLastPointerMove && lastMousePoint ? lastMousePoint : params;
              const fraction = state.orientation === "vertical"
                ? Math.max(0, Math.min(1, (50 - Number(pointer.y)) / 40))
                : Math.max(0, Math.min(1, (Number(pointer.x) - 10) / 100));
              state.current = Number(state.min) + (Number(state.max) - Number(state.min)) * fraction;
            }
          }
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
    setTimeout(callback, delay, ...args) {
      timeoutDelays.push(Number(delay));
      return setTimeout(callback, delay, ...args);
    },
    clearTimeout,
    queueMicrotask,
  };
  vm.runInNewContext(
    `${source}\n;globalThis.__frameTest = { ensureBrowserEnabledLoaded, browserSnapshot, browserScreenshot, browserFind, browserReacquire, browserClick, browserDoubleClick, browserDrag, browserHover, browserScrollIntoView, browserRefInfo, browserFill, browserSelect, browserCheck, browserRangeSet, browserPress, browserTypeText, browserScroll, browserWait, browserPdfData, currentDocumentGeneration };`,
    context,
    { filename: SERVICE_WORKER_PATH },
  );
  await context.__frameTest.ensureBrowserEnabledLoaded();

  return {
    api: context.__frameTest,
    commands,
    timeoutDelays,
    debuggerEvent,
    tab,
    frameTree,
    axTrees,
    rangeStates,
  };
}

test("snapshot exposes main, same-origin iframe and recursively routes OOPIF frame context", async () => {
  const { api, commands } = await createHarness();
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
  assert.equal(commands.some((item) => item.method === "Target.setAutoAttach" && item.sessionId === "session-cross"), true);
});

test("Chrome PDF data reads bounded document bytes from the viewer PluginController", async () => {
  const pdf = Buffer.from("%PDF-1.4\nEquinox PDF Fixture\n", "utf8");
  const { api, commands } = await createHarness({ pdfDataBuffer: pdf });
  const result = await api.browserPdfData({ tabId: 41 });

  assert.equal(result.pdfContentVersion, 1);
  assert.equal(result.byteLength, pdf.length);
  assert.equal(Buffer.from(result.data, "base64").toString("utf8"), pdf.toString("utf8"));
  const extraction = commands.find((item) => item.method === "Runtime.evaluate" && String(item.params?.expression || "").includes("getSaveDataBlock"));
  assert.equal(extraction?.sessionId, "session-cross");
  assert.match(extraction?.params?.expression || "", /16 \* 1024 \* 1024|16777216/u);
  assert.match(extraction?.params?.expression || "", /pluginController_/u);
  assert.match(extraction?.params?.expression || "", /getSaveDataBlock\('ORIGINAL', offset, blockSize\)/u);
  assert.match(extraction?.params?.expression || "", /totalFileSize/u);
});

test("snapshot v2 prunes by mode, viewport, role, query and max node count", async () => {
  const { api } = await createHarness();

  const readable = await api.browserSnapshot({ tabId: 41, mode: "readable" });
  assert.equal(readable.snapshotVersion, 9);
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

test("snapshot v9 keeps web content raw by default and redacts mail content only when explicitly requested", async () => {
  const { api, tab, axTrees } = await createHarness();
  tab.url = "https://mail.google.com/mail/u/0/#inbox";
  const tree = axTrees.get("frame-main");
  tree.push(
    axNode({ role: "row", name: "", backendNodeId: 850, nodeId: "mail-row", childIds: ["mail-sender", "mail-subject", "mail-snippet", "mail-link", "mail-check", "mail-check-prefix", "mail-link-spaced", "mail-check-hyphen", "mail-invoice", "mail-star"] }),
    axNode({ role: "StaticText", name: "Alice", nodeId: "mail-sender", parentId: "mail-row" }),
    axNode({ role: "StaticText", name: "Recovery code 654321", nodeId: "mail-subject", parentId: "mail-row" }),
    axNode({ role: "StaticText", name: "Verification code 123456 token=abcdefghi", nodeId: "mail-snippet", parentId: "mail-row" }),
    axNode({ role: "link", name: "Open recovery code 654321", backendNodeId: 852, nodeId: "mail-link", parentId: "mail-row" }),
    axNode({ role: "checkbox", name: "Select recovery code 654321", backendNodeId: 853, nodeId: "mail-check", parentId: "mail-row" }),
    axNode({ role: "checkbox", name: "Merhaba, 482731 uygulama için tek seferlik doğrulama kodunuzdur", backendNodeId: 855, nodeId: "mail-check-prefix", parentId: "mail-row" }),
    axNode({ role: "link", name: "Open security code 123 456", backendNodeId: 856, nodeId: "mail-link-spaced", parentId: "mail-row" }),
    axNode({ role: "checkbox", name: "Select 2FA code 123-456", backendNodeId: 857, nodeId: "mail-check-hyphen", parentId: "mail-row" }),
    axNode({ role: "button", name: "Invoice 246810", backendNodeId: 858, nodeId: "mail-invoice", parentId: "mail-row" }),
    axNode({ role: "button", name: "Star", backendNodeId: 851, nodeId: "mail-star", parentId: "mail-row" }),
  );

  const raw = await api.browserSnapshot({ tabId: 41, mode: "balanced" });
  const rawJson = JSON.stringify(raw.elements);
  assert.equal(raw.snapshotVersion, 9);
  assert.equal(raw.privacy.sensitiveTextMode, "allow");
  assert.equal(raw.privacy.sensitiveTextRedaction, false);
  assert.equal(raw.privacy.sensitiveRedactionCount, 0);
  assert.equal(raw.privacy.broadMailSummary, false);
  assert.match(rawJson, /654321|123456|abcdefghi|482731|123 456|123-456/u);
  assert.doesNotMatch(rawJson, /\[REDACTED/u);

  const rawTargeted = await api.browserSnapshot({ tabId: 41, mode: "readable", query: "Verification code" });
  const rawSnippet = rawTargeted.elements.find((item) => item.role === "StaticText");
  assert.ok(rawSnippet);
  assert.match(rawSnippet.name, /123456|abcdefghi/u);
  assert.equal(rawSnippet.sensitiveTextRedacted, undefined);

  const broad = await api.browserSnapshot({ tabId: 41, mode: "balanced", sensitiveText: "redact" });
  const row = broad.elements.find((item) => item.role === "row" && item.ref?.startsWith("@c"));
  assert.ok(row);
  assert.equal(row.privacyMode, "mail_summary");
  assert.match(row.name, /Alice/u);
  assert.match(row.name, /Recovery code \[REDACTED CODE\]/u);
  assert.doesNotMatch(JSON.stringify(broad.elements), /654321|123456|abcdefghi/u);
  const recoveryLink = broad.elements.find((item) => item.role === "link");
  const recoveryCheckbox = broad.elements.find((item) => item.role === "checkbox");
  assert.match(recoveryLink?.name || "", /recovery code \[REDACTED CODE\]/iu);
  assert.match(recoveryCheckbox?.name || "", /recovery code \[REDACTED CODE\]/iu);
  assert.equal(broad.privacy.sensitiveTextMode, "redact");
  assert.equal(broad.privacy.sensitiveTextRedaction, true);
  assert.equal(broad.privacy.broadMailSummary, true);
  assert.ok(broad.privacy.sensitiveRedactionCount > 0);

  const broadInteractive = await api.browserSnapshot({
    tabId: 41,
    mode: "interactive",
    scope: "viewport",
    mainFrameOnly: true,
    excludeAuxiliaryFrames: true,
    pruneUnnamedRefs: true,
    sensitiveText: "redact",
  });
  const broadJson = JSON.stringify(broadInteractive.elements);
  assert.equal(broadInteractive.privacy.broadMailSummary, true);
  assert.ok(broadInteractive.privacy.sensitiveRedactionCount > 0);
  assert.doesNotMatch(broadJson, /654321|123 456|123-456|482731/u);
  assert.match(broadJson, /\[REDACTED CODE\]/u);
  assert.match(broadJson, /Invoice 246810/u);

  const prefixedCode = await api.browserSnapshot({
    tabId: 41,
    mode: "interactive",
    roles: ["checkbox"],
    query: "tek seferlik",
    sensitiveText: "redact",
  });
  const prefixedCheckbox = prefixedCode.elements.find((item) => item.role === "checkbox");
  assert.ok(prefixedCheckbox);
  assert.match(prefixedCheckbox.name, /\[REDACTED CODE\].*tek seferlik doğrulama kodunuzdur/iu);
  assert.doesNotMatch(prefixedCheckbox.name, /482731/u);
  assert.equal(prefixedCheckbox.sensitiveTextRedacted, true);
  assert.ok(prefixedCode.privacy.sensitiveRedactionCount >= 1);

  const targeted = await api.browserSnapshot({
    tabId: 41,
    mode: "readable",
    query: "Verification code",
    sensitiveText: "redact",
  });
  const snippet = targeted.elements.find((item) => item.role === "StaticText");
  assert.ok(snippet);
  assert.match(snippet.name, /\[REDACTED\]/u);
  assert.doesNotMatch(snippet.name, /123456|abcdefghi/u);
  assert.equal(snippet.sensitiveTextRedacted, true);
  assert.ok(targeted.privacy.sensitiveRedactionCount >= 1);

  await assert.rejects(
    api.browserSnapshot({
      tabId: 41,
      mode: "balanced",
      sinceSnapshotId: raw.snapshot.id,
      sensitiveText: "redact",
    }),
    /Delta snapshot filters must match/u,
  );
});

test("snapshot v7 exposes ARIA pressed state in full, compact and delta output", async () => {
  const { api, axTrees } = await createHarness();
  const tree = axTrees.get("frame-main");
  const toggle = axNode({
    role: "button",
    name: "Like this video",
    backendNodeId: 854,
    nodeId: "video-like",
    properties: [{ name: "pressed", value: { value: false } }],
  });
  tree.push(toggle);

  const initial = await api.browserSnapshot({ tabId: 41, mode: "interactive", query: "Like this video" });
  const initialToggle = initial.elements.find((item) => item.name === "Like this video");
  assert.ok(initialToggle?.ref);
  assert.equal(initialToggle.pressed, false);

  const compact = await api.browserSnapshot({ tabId: 41, mode: "interactive", query: "Like this video", output: "compact" });
  assert.match(compact.text, /\[pressed=false\]/u);

  toggle.properties[0].value.value = true;
  const delta = await api.browserSnapshot({
    tabId: 41,
    mode: "interactive",
    query: "Like this video",
    sinceSnapshotId: initial.snapshot.id,
  });
  assert.equal(delta.delta.deltaMode, "incremental");
  const changed = delta.delta.changed.find((item) => item.ref === initialToggle.ref);
  assert.ok(changed);
  assert.equal(changed.before.pressed, false);
  assert.equal(changed.after.pressed, true);
  assert.match(delta.text, /\[pressed=true\]/u);
});

test("snapshot v5 exposes noninteractive container refs for scope and screenshot but never actions", async () => {
  const { api, axTrees } = await createHarness();
  axTrees.get("frame-main").push(
    axNode({ role: "article", name: "", backendNodeId: 860, nodeId: "article-scope", childIds: ["article-title", "article-button"] }),
    axNode({ role: "StaticText", name: "Scoped article", nodeId: "article-title", parentId: "article-scope" }),
    axNode({ role: "button", name: "Article action", backendNodeId: 861, nodeId: "article-button", parentId: "article-scope" }),
  );

  let snapshot = await api.browserSnapshot({ tabId: 41, mode: "balanced" });
  const container = snapshot.elements.find((item) => item.role === "article" && item.ref?.startsWith("@c"));
  assert.ok(container);
  assert.equal(container.scopeRef, true);
  assert.equal(container.interactive, false);
  assert.ok(snapshot.containerRefCount >= 1);

  const scoped = await api.browserSnapshot({ tabId: 41, rootRef: container.ref, mode: "balanced" });
  assert.equal(scoped.snapshot.filters.rootRef, container.ref);
  assert.equal(scoped.refContextValid, true);

  snapshot = await api.browserSnapshot({ tabId: 41, mode: "balanced" });
  const refreshedContainer = snapshot.elements.find((item) => item.role === "article" && item.ref?.startsWith("@c"));
  const captured = await api.browserScreenshot({ tabId: 41, ref: refreshedContainer.ref });
  assert.equal(captured.source, "ref");
  assert.equal(captured.ref, refreshedContainer.ref);

  snapshot = await api.browserSnapshot({ tabId: 41, mode: "balanced" });
  const actionContainer = snapshot.elements.find((item) => item.role === "article" && item.ref?.startsWith("@c"));
  await assert.rejects(
    api.browserClick({ tabId: 41, ref: actionContainer.ref }),
    /Snapshot ref not found/u,
  );
});

test("snapshot v5 frame relevance scopes main, exact and auxiliary frames deterministically", async () => {
  const { api, frameTree, axTrees } = await createHarness();
  frameTree.childFrames.push({
    frame: {
      id: "frame-ad",
      parentId: "frame-main",
      name: "googleads",
      url: "https://doubleclick.net/ad-frame",
      securityOrigin: "https://doubleclick.net",
      mimeType: "text/html",
    },
  });
  axTrees.set("frame-ad", [axNode({ role: "button", name: "Ad action", backendNodeId: 880 })]);
  frameTree.childFrames.push({
    frame: {
      id: "frame-google-apps",
      parentId: "frame-main",
      name: "app",
      url: "https://ogs.google.com/u/0/widget/app?origin=https%3A%2F%2Fwww.google.com&pid=1",
      securityOrigin: "https://ogs.google.com",
      mimeType: "text/html",
    },
  });
  axTrees.set("frame-google-apps", [axNode({ role: "link", name: "Drive", backendNodeId: 881 })]);
  frameTree.childFrames.push({
    frame: {
      id: "frame-cookie-rotation",
      parentId: "frame-main",
      name: "",
      url: "https://accounts.google.com/RotateCookiesPage?origin=https%3A%2F%2Fwww.google.com",
      securityOrigin: "https://accounts.google.com",
      mimeType: "text/html",
    },
  });
  axTrees.set("frame-cookie-rotation", [axNode({ role: "button", name: "Cookie helper", backendNodeId: 882 })]);

  const all = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  assert.equal(all.elements.some((item) => item.name === "Ad action"), true);
  assert.equal(all.frames.find((frame) => frame.id === "frame-ad")?.auxiliary, true);

  const main = await api.browserSnapshot({ tabId: 41, mode: "interactive", mainFrameOnly: true });
  assert.equal(main.elements.some((item) => item.frameId !== "frame-main"), false);
  assert.equal(main.frames.find((frame) => frame.id === "frame-main")?.selected, true);
  assert.equal(main.frames.find((frame) => frame.id === "frame-cross")?.selected, false);

  const exact = await api.browserSnapshot({ tabId: 41, mode: "interactive", frameId: "frame-cross" });
  assert.deepEqual([...new Set(exact.elements.map((item) => item.frameId))], ["frame-cross"]);

  const relevant = await api.browserSnapshot({ tabId: 41, mode: "interactive", activeLayerOnly: true });
  assert.deepEqual([...new Set(relevant.elements.map((item) => item.frameId))], ["frame-main"]);

  assert.equal(all.elements.some((item) => item.name === "Drive"), true);
  assert.equal(all.frames.find((frame) => frame.id === "frame-google-apps")?.auxiliary, true);
  assert.equal(all.frames.find((frame) => frame.id === "frame-cookie-rotation")?.auxiliary, true);

  const noAux = await api.browserSnapshot({ tabId: 41, mode: "interactive", excludeAuxiliaryFrames: true });
  assert.equal(noAux.elements.some((item) => item.name === "Ad action"), false);
  assert.equal(noAux.elements.some((item) => item.name === "Drive"), false);
  assert.equal(noAux.elements.some((item) => item.name === "Cookie helper"), false);
  assert.equal(noAux.elements.some((item) => item.name === "Main action"), true);
});

test("snapshot v8 PDF active layer prefers the Chrome viewer OOPIF over the empty PDF host frame", async () => {
  const { api } = await createHarness({ pdfDataBuffer: Buffer.from("%PDF-1.4\nfixture\n", "utf8") });
  const active = await api.browserSnapshot({ tabId: 41, mode: "balanced", activeLayerOnly: true });
  assert.equal(active.pageKind, "chrome-pdf-viewer");
  assert.equal(active.elementCount > 0, true);
  assert.deepEqual([...new Set(active.elements.map((item) => item.frameId))], ["frame-cross"]);
  assert.equal(active.frames.find((frame) => frame.id === "frame-cross")?.selected, true);
  assert.equal(active.frames.find((frame) => frame.id === "frame-main")?.selected, false);
});

test("snapshot v5 names unnamed interactive refs from bounded DOM fallbacks and can prune meaningless refs", async () => {
  const { api, axTrees } = await createHarness({
    fallbackNames: { 870: { name: "Fallback title", source: "title" } },
  });
  axTrees.get("frame-main").push(
    axNode({ role: "button", name: "", backendNodeId: 870, nodeId: "fallback-button" }),
    axNode({ role: "button", name: "", backendNodeId: 871, nodeId: "meaningless-button" }),
  );

  const named = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  const fallback = named.elements.find((item) => item.name === "Fallback title");
  assert.ok(fallback?.ref?.startsWith("@e"));
  assert.equal(fallback.nameSource, "title");
  assert.equal(named.elements.some((item) => item.ref && item.name === ""), true);

  const pruned = await api.browserSnapshot({ tabId: 41, mode: "interactive", pruneUnnamedRefs: true });
  assert.equal(pruned.elements.some((item) => item.ref && item.name === ""), false);
  assert.equal(pruned.elements.some((item) => item.name === "Fallback title"), true);
});

test("snapshot v5 coalesces adjacent low-priority inline readable fragments", async () => {
  const { api, axTrees } = await createHarness();
  axTrees.get("frame-main").push(
    axNode({ role: "generic", name: "", nodeId: "inline-parent", childIds: ["inline-a", "inline-b", "inline-c"] }),
    axNode({ role: "StaticText", name: "Open", nodeId: "inline-a", parentId: "inline-parent" }),
    axNode({ role: "StaticText", name: "source", nodeId: "inline-b", parentId: "inline-parent" }),
    axNode({ role: "StaticText", name: "project", nodeId: "inline-c", parentId: "inline-parent" }),
  );

  const readable = await api.browserSnapshot({ tabId: 41, mode: "readable" });
  const inline = readable.elements.filter((item) => item.role === "StaticText" && /Open|source|project/u.test(item.name));
  assert.equal(inline.length, 1);
  assert.equal(inline[0].name, "Open source project");
  assert.equal(inline[0].coalescedInlineCount, 3);
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

  assert.equal(delta.deltaVersion, 2);
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

test("delta snapshot resets on document generation changes and requires a fresh full snapshot", async () => {
  const { api, debuggerEvent } = await createHarness();
  const initial = await api.browserSnapshot({ tabId: 41, mode: "interactive" });

  debuggerEvent.emit(
    { tabId: 41 },
    "Page.frameNavigated",
    { frame: { id: "frame-main", url: "http://127.0.0.1:47840/next" } },
  );
  const delta = await api.browserSnapshot({
    tabId: 41,
    mode: "interactive",
    sinceSnapshotId: initial.snapshot.id,
  });

  assert.equal(delta.delta.version, 2);
  assert.equal(delta.delta.deltaMode, "reset");
  assert.equal(delta.delta.reset, true);
  assert.equal(delta.delta.reason, "document_generation_changed");
  assert.equal(delta.delta.fullReplacement, true);
  assert.deepEqual(JSON.parse(JSON.stringify(delta.delta.added)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(delta.delta.removed)), []);
  assert.equal(delta.refContextValid, false);
  assert.equal(delta.freshSnapshotRequired, true);
  assert.match(delta.refContextReason, /^delta_reset:/);
});

test("virtualized article controls keep stable refs when backend nodes are recycled", async () => {
  const { api, axTrees, commands } = await createHarness();
  const tree = axTrees.get("frame-main");
  tree.push(
    axNode({ role: "article", name: "", nodeId: "article-a", childIds: ["tweet-text", "tweet-like"] }),
    axNode({ role: "StaticText", name: "Stable tweet body", nodeId: "tweet-text", parentId: "article-a" }),
    axNode({ role: "button", name: "Like", backendNodeId: 801, nodeId: "tweet-like", parentId: "article-a" }),
  );
  const initial = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  const oldRef = initial.elements.find((item) => item.name === "Like")?.ref;
  assert.ok(oldRef);

  const articleIndex = tree.findIndex((node) => node.nodeId === "article-a");
  tree.splice(articleIndex, 3,
    axNode({ role: "article", name: "", nodeId: "article-b", childIds: ["tweet-text-b", "tweet-like-b"] }),
    axNode({ role: "StaticText", name: "Stable tweet body", nodeId: "tweet-text-b", parentId: "article-b" }),
    axNode({ role: "button", name: "Like", backendNodeId: 901, nodeId: "tweet-like-b", parentId: "article-b" }),
  );
  const delta = await api.browserSnapshot({ tabId: 41, mode: "interactive", sinceSnapshotId: initial.snapshot.id });
  assert.equal(delta.delta.deltaMode, "incremental");
  assert.equal(delta.elements.some((item) => item.name === "Like"), false);
  assert.equal(delta.delta.retainedRefs.includes(oldRef), true);

  await api.browserRefInfo({ tabId: 41, ref: oldRef });
  const box = commands.findLast((item) => item.method === "DOM.getBoxModel");
  assert.equal(box?.params?.backendNodeId, 901);
});

test("repeated Gmail-style row controls use parent context instead of collapsing identical labels", async () => {
  const { api, axTrees } = await createHarness();
  const tree = axTrees.get("frame-main");
  tree.push(
    axNode({ role: "row", name: "", nodeId: "row-a", childIds: ["row-a-text", "row-a-star"] }),
    axNode({ role: "StaticText", name: "Alice — Quarterly plan", nodeId: "row-a-text", parentId: "row-a" }),
    axNode({ role: "button", name: "Star", backendNodeId: 811, nodeId: "row-a-star", parentId: "row-a" }),
    axNode({ role: "row", name: "", nodeId: "row-b", childIds: ["row-b-text", "row-b-star"] }),
    axNode({ role: "StaticText", name: "Bob — Shipping update", nodeId: "row-b-text", parentId: "row-b" }),
    axNode({ role: "button", name: "Star", backendNodeId: 812, nodeId: "row-b-star", parentId: "row-b" }),
  );
  const initial = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  const stars = initial.elements.filter((item) => item.name === "Star");
  assert.equal(stars.length, 2);
  assert.notEqual(stars[0].ref, stars[1].ref);
  const refs = new Map(stars.map((item) => [item.ref, item.ref]));

  const start = tree.findIndex((node) => node.nodeId === "row-a");
  tree.splice(start, 6,
    axNode({ role: "row", name: "", nodeId: "row-b2", childIds: ["row-b-text2", "row-b-star2"] }),
    axNode({ role: "StaticText", name: "Bob — Shipping update", nodeId: "row-b-text2", parentId: "row-b2" }),
    axNode({ role: "button", name: "Star", backendNodeId: 912, nodeId: "row-b-star2", parentId: "row-b2" }),
    axNode({ role: "row", name: "", nodeId: "row-a2", childIds: ["row-a-text2", "row-a-star2"] }),
    axNode({ role: "StaticText", name: "Alice — Quarterly plan", nodeId: "row-a-text2", parentId: "row-a2" }),
    axNode({ role: "button", name: "Star", backendNodeId: 911, nodeId: "row-a-star2", parentId: "row-a2" }),
  );
  const delta = await api.browserSnapshot({ tabId: 41, mode: "interactive", sinceSnapshotId: initial.snapshot.id });
  const nextStars = delta.elements.filter((item) => item.name === "Star");
  assert.equal(delta.delta.deltaMode, "incremental");
  assert.equal(nextStars.length, 0, "unchanged stable rows should not be emitted as delta changes");
  assert.equal(delta.delta.retainedRefs.filter((ref) => refs.has(ref)).length, 2);
});

test("ambiguous semantic containers fall back to backend identity instead of reusing the wrong ref", async () => {
  const { api, axTrees } = await createHarness();
  const tree = axTrees.get("frame-main");
  tree.push(
    axNode({ role: "row", name: "", nodeId: "dup-a", childIds: ["dup-a-text", "dup-a-star"] }),
    axNode({ role: "StaticText", name: "Same row", nodeId: "dup-a-text", parentId: "dup-a" }),
    axNode({ role: "button", name: "Star duplicate", backendNodeId: 821, nodeId: "dup-a-star", parentId: "dup-a" }),
    axNode({ role: "row", name: "", nodeId: "dup-b", childIds: ["dup-b-text", "dup-b-star"] }),
    axNode({ role: "StaticText", name: "Same row", nodeId: "dup-b-text", parentId: "dup-b" }),
    axNode({ role: "button", name: "Star duplicate", backendNodeId: 822, nodeId: "dup-b-star", parentId: "dup-b" }),
  );
  const initial = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  const oldRefs = initial.elements.filter((item) => item.name === "Star duplicate").map((item) => item.ref);
  assert.equal(new Set(oldRefs).size, 2);

  for (const node of tree) {
    if (node.name?.value === "Star duplicate") node.backendDOMNodeId += 100;
  }
  const delta = await api.browserSnapshot({ tabId: 41, mode: "interactive", sinceSnapshotId: initial.snapshot.id });
  const newRefs = delta.delta.added.filter((item) => item.name === "Star duplicate").map((item) => item.ref);
  assert.equal(newRefs.length, 2);
  assert.equal(newRefs.some((ref) => oldRefs.includes(ref)), false);
});

test("delta snapshot resets instead of dumping a zero-retention virtualized replacement", async () => {
  const { api, axTrees } = await createHarness();
  const initial = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  for (const tree of axTrees.values()) {
    for (const node of tree) {
      if (Number.isInteger(node.backendDOMNodeId)) node.backendDOMNodeId += 10_000;
    }
  }

  const delta = await api.browserSnapshot({
    tabId: 41,
    mode: "interactive",
    sinceSnapshotId: initial.snapshot.id,
  });
  assert.equal(delta.delta.deltaMode, "reset");
  assert.equal(delta.delta.reason, "low_ref_retention");
  assert.equal(delta.delta.retainedCount, 0);
  assert.equal(delta.delta.added.length, 0);
  assert.equal(delta.delta.removed.length, 0);
  assert.equal(delta.freshSnapshotRequired, true);
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
  assert.equal(byRef.screenshotVersion, 4);
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

test("annotated screenshot maps and labels root plus OOPIF refs and removes its overlay", async () => {
  const { api, commands } = await createHarness();
  const snapshot = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  const rootRef = snapshot.elements.find((item) => item.name === "Main action")?.ref;
  const oopifRef = snapshot.elements.find((item) => item.name === "Cross action")?.ref;
  assert.ok(rootRef);
  assert.ok(oopifRef);

  const captured = await api.browserScreenshot({ tabId: 41, annotateRefs: true });
  assert.equal(captured.screenshotVersion, 4);
  assert.equal(captured.annotations.requested, true);
  assert.equal(captured.annotations.annotatedRefs.includes(rootRef), true);
  assert.equal(captured.annotations.mappedOopifRefs.includes(oopifRef), true);
  assert.equal(captured.annotations.skippedOopifRefs.includes(oopifRef), false);

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

test("ref screenshot maps OOPIF refs into root page coordinates and still rejects conflicting scopes", async () => {
  const { api } = await createHarness();
  const snapshot = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  const oopifRef = snapshot.elements.find((item) => item.name === "Cross action")?.ref;
  const rootRef = snapshot.elements.find((item) => item.name === "Main action")?.ref;
  assert.ok(oopifRef);
  assert.ok(rootRef);

  const captured = await api.browserScreenshot({ tabId: 41, ref: oopifRef });
  assert.equal(captured.screenshotVersion, 4);
  assert.deepEqual(JSON.parse(JSON.stringify(captured.clip)), { x: 210, y: 110, width: 100, height: 40 });
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

test("ordinary click refreshes the sliding debugger lease instead of scheduling an immediate detach", async () => {
  const { api, timeoutDelays } = await createHarness();
  const initial = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  const ref = initial.elements.find((item) => item.name === "Main action")?.ref;
  assert.ok(ref);

  timeoutDelays.length = 0;
  await api.browserClick({ tabId: 41, ref });
  assert.equal(timeoutDelays.at(-1), 60_000);
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

  assert.equal(clicked.compoundActionVersion, 4);
  assert.equal(clicked.after?.ok, true);
  assert.equal(clicked.after?.wait?.matched, "dom_stable");
  assert.equal(clicked.after?.snapshot?.deltaOnly, true);
  assert.equal(clicked.after?.snapshot?.delta?.baseSnapshotId, initial.snapshot.id);
  assert.equal(clicked.refContextValid, true);
  assert.equal(clicked.freshSnapshotRequired, false);
  assert.equal(clicked.currentSnapshotId, clicked.after?.snapshot?.snapshot?.id);

  // A real tool round-trip can easily exceed the old 250ms detach window.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const retainedRef = clicked.after?.snapshot?.delta?.retainedRefs?.[0] || ref;
  const info = await api.browserRefInfo({ tabId: 41, ref: retainedRef });
  assert.equal(info.exists, true);
});

test("compound semantic_ready waits for the same query and role projection as the after snapshot", async () => {
  const { api, axTrees } = await createHarness();
  const initial = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  const ref = initial.elements.find((item) => item.name === "Main action")?.ref;
  assert.ok(ref);

  const mainTree = axTrees.get("frame-main");
  const delayed = axNode({ role: "link", name: "Loading result", backendNodeId: 1201, nodeId: "delayed-openai-link" });
  mainTree.push(delayed);
  const timer = setTimeout(() => {
    delayed.name.value = "OpenAI result";
  }, 180);
  try {
    const clicked = await api.browserClick({
      tabId: 41,
      ref,
      after: {
        waitFor: "semantic_ready",
        snapshot: "full",
        snapshotMode: "interactive",
        snapshotQuery: "OpenAI",
        snapshotRoles: ["link"],
        quietMs: 100,
        timeoutMs: 900,
      },
    });
    assert.equal(clicked.compoundActionVersion, 4);
    assert.equal(clicked.actionDispatched, true);
    assert.equal(clicked.primaryActionSucceeded, true);
    assert.equal(clicked.after?.ok, true);
    assert.equal(clicked.after?.wait?.matched, "semantic_ready");
    assert.equal(clicked.after?.wait?.nodeCount, 1);
    assert.equal(clicked.after?.snapshot?.snapshot?.filters?.query, "openai");
    assert.deepEqual(JSON.parse(JSON.stringify(clicked.after?.snapshot?.snapshot?.filters?.roles)), ["link"]);
    assert.match(clicked.after?.snapshot?.text || "", /OpenAI result/u);
  } finally {
    clearTimeout(timer);
  }
});

test("click keeps primary success explicit when a post-action wait times out", async () => {
  const { api } = await createHarness();
  const initial = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  const ref = initial.elements.find((item) => item.name === "Main action")?.ref;
  assert.ok(ref);

  const clicked = await api.browserClick({
    tabId: 41,
    ref,
    after: {
      waitFor: "dom_stable",
      quietMs: 500,
      timeoutMs: 100,
    },
  });
  assert.equal(clicked.compoundActionVersion, 4);
  assert.equal(clicked.actionDispatched, true);
  assert.equal(clicked.primaryActionSucceeded, true);
  assert.equal(clicked.after?.ok, false);
  assert.equal(clicked.after?.failedStage, "wait");
  assert.match(clicked.after?.error || "", /timed out|timeout/i);
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

test("OOPIF click accepts a composed ancestor hit such as Chrome PDF Viewer shadow hosts", async () => {
  const { api, commands } = await createHarness({ requireAncestorHitRelation: true });
  const snapshot = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  const crossButton = snapshot.elements.find((item) => item.name === "Cross action");
  assert.ok(crossButton?.ref);

  const clicked = await api.browserClick({ tabId: 41, ref: crossButton.ref });
  assert.equal(clicked.sessionScope, "child");
  const inputCommands = commands.filter((item) => item.method === "Input.dispatchMouseEvent").slice(-3);
  assert.equal(inputCommands.length, 3);
  assert.ok(inputCommands.every((item) => item.sessionId === "session-cross"));
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
  assert.equal(hovered.actionabilityVersion, 7);
  assert.equal(hovered.refLifecycleVersion, 1);
  assert.equal(hovered.sourceSnapshotId, snapshot.snapshot.id);
  assert.equal(hovered.sourceDocumentGeneration, snapshot.snapshot.documentGeneration);
  assert.equal(hovered.currentSnapshotId, null);
  assert.equal(hovered.refContextValid, false);
  assert.equal(hovered.freshSnapshotRequired, true);
  assert.equal(hovered.refContextReason, "hover_invalidated_snapshot");
  assert.deepEqual(JSON.parse(JSON.stringify(hovered.point)), { x: 60, y: 30 });
  assert.equal(commands.some((item) => item.method === "DOM.scrollIntoViewIfNeeded"), true);

  snapshot = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  ref = snapshot.elements.find((item) => item.name === "Main action")?.ref;
  const scrolled = await api.browserScrollIntoView({ tabId: 41, ref });
  assert.equal(scrolled.actionabilityVersion, 7);
  assert.equal(scrolled.scrolledIntoView, true);

  snapshot = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  ref = snapshot.elements.find((item) => item.name === "Main action")?.ref;
  const info = await api.browserRefInfo({ tabId: 41, ref });
  assert.equal(info.actionabilityVersion, 7);
  assert.equal(info.refLifecycleVersion, 1);
  assert.equal(info.sourceSnapshotId, snapshot.snapshot.id);
  assert.equal(info.currentSnapshotId, snapshot.snapshot.id);
  assert.equal(info.sourceDocumentGeneration, snapshot.snapshot.documentGeneration);
  assert.equal(info.currentDocumentGeneration, snapshot.snapshot.documentGeneration);
  assert.equal(info.refContextValid, true);
  assert.equal(info.freshSnapshotRequired, false);
  assert.equal(info.refContextReason, "ref_inspected");
  assert.equal(info.exists, true);
  assert.equal(info.visible, true);
  assert.equal(info.enabled, true);
  assert.equal(info.clickable, true);
  assert.equal(info.actionabilityReason, "clickable");
  assert.equal(info.pressed, true);
  assert.deepEqual(JSON.parse(JSON.stringify(info.clickPoint)), { x: 60, y: 30 });
  assert.deepEqual(JSON.parse(JSON.stringify(info.box)), { x: 10, y: 10, width: 100, height: 40 });
  assert.equal(Object.keys(info).length <= 30, true);
  for (const forbidden of ["outerHTML", "innerHTML", "attributes", "children", "backendNodeId", "objectId"]) {
    assert.equal(Object.hasOwn(info, forbidden), false);
  }
});

test("ref-targeted wait reports source and current lifecycle context", async () => {
  const { api } = await createHarness();
  const snapshot = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  const ref = snapshot.elements.find((item) => item.name === "Main action")?.ref;
  assert.ok(ref);

  const waited = await api.browserWait({ tabId: 41, refVisible: ref, timeoutMs: 500 });
  assert.equal(waited.matched, "ref_visible");
  assert.equal(waited.refLifecycleVersion, 1);
  assert.equal(waited.sourceSnapshotId, snapshot.snapshot.id);
  assert.equal(waited.currentSnapshotId, snapshot.snapshot.id);
  assert.equal(waited.sourceDocumentGeneration, snapshot.snapshot.documentGeneration);
  assert.equal(waited.currentDocumentGeneration, snapshot.snapshot.documentGeneration);
  assert.equal(waited.refContextValid, true);
  assert.equal(waited.freshSnapshotRequired, false);
  assert.equal(waited.refContextReason, "wait_ref_matched");
});

test("range_set changes native range values and verifies the final state", async () => {
  const { api, axTrees, rangeStates, commands } = await createHarness({
    initialRangeStates: {
      1601: { kind: "native", min: 0, max: 100, current: 20, step: 5, orientation: "horizontal" },
    },
  });
  axTrees.get("frame-main").push(
    axNode({ role: "slider", name: "Volume", backendNodeId: 1601, nodeId: "native-range", value: 20 }),
  );
  const snapshot = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  const ref = snapshot.elements.find((item) => item.name === "Volume")?.ref;
  assert.ok(ref);

  const result = await api.browserRangeSet({ tabId: 41, ref, value: 65 });
  assert.equal(result.rangeVersion, 2);
  assert.equal(result.actionabilityVersion, 7);
  assert.equal(result.actionDispatched, true);
  assert.equal(result.primaryActionSucceeded, true);
  assert.equal(result.outcomeUncertain, false);
  assert.equal(result.kind, "native");
  assert.equal(result.requestedValue, 65);
  assert.equal(result.actualValue, 65);
  assert.equal(rangeStates.get(1601)?.current, 65);
  const nativeSetCalls = commands.filter((item) => item.method === "Runtime.callFunctionOn" && String(item.params?.functionDeclaration || "").includes("__equinoxNativeRangeSet"));
  assert.equal(nativeSetCalls.length, 1);
});

test("range_set maps a safe ARIA slider percent to its semantic box without exposing coordinates", async () => {
  const { api, axTrees, rangeStates } = await createHarness({
    initialRangeStates: {
      1602: { kind: "aria", min: 0, max: 200, current: 20, step: null, orientation: "horizontal" },
    },
  });
  axTrees.get("frame-main").push(
    axNode({ role: "slider", name: "Timeline", backendNodeId: 1602, nodeId: "aria-slider", value: 20 }),
  );
  const snapshot = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  const ref = snapshot.elements.find((item) => item.name === "Timeline")?.ref;
  assert.ok(ref);

  const result = await api.browserRangeSet({ tabId: 41, ref, percent: 0.5 });
  assert.equal(result.rangeVersion, 2);
  assert.equal(result.primaryActionSucceeded, true);
  assert.equal(result.kind, "aria");
  assert.equal(result.requestedValue, 100);
  assert.equal(result.actualValue, 100);
  assert.equal(result.percent, 0.5);
  assert.equal(rangeStates.get(1602)?.current, 100);
  assert.equal(Object.hasOwn(result, "point"), false);
  assert.equal(Object.hasOwn(result, "x"), false);
  assert.equal(Object.hasOwn(result, "y"), false);
});

test("range_set absolute value moves the pointer target before mutating custom ARIA sliders", async () => {
  const { api, axTrees, rangeStates, commands } = await createHarness({
    ariaRangeUsesLastPointerMove: true,
    initialRangeStates: {
      1604: { kind: "aria", min: 0, max: 200, current: 90, step: null, orientation: "horizontal" },
    },
  });
  axTrees.get("frame-main").push(
    axNode({ role: "slider", name: "Pointer-state timeline", backendNodeId: 1604, nodeId: "pointer-state-slider", value: 90 }),
  );
  const snapshot = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  const ref = snapshot.elements.find((item) => item.name === "Pointer-state timeline")?.ref;
  assert.ok(ref);

  const result = await api.browserRangeSet({ tabId: 41, ref, value: 40 });
  assert.equal(result.rangeVersion, 2);
  assert.equal(result.primaryActionSucceeded, true);
  assert.equal(result.requestedValue, 40);
  assert.equal(result.actualValue, 40);
  assert.equal(result.percent, 0.2);
  assert.equal(rangeStates.get(1604)?.current, 40);

  const input = commands.filter((item) => item.method === "Input.dispatchMouseEvent");
  const releaseIndex = input.findLastIndex((item) => item.params?.type === "mouseReleased");
  assert.ok(releaseIndex >= 2);
  assert.equal(input[releaseIndex - 2]?.params?.type, "mouseMoved");
  assert.equal(input[releaseIndex - 2]?.params?.x, 30);
  assert.equal(input[releaseIndex - 1]?.params?.type, "mousePressed");
  assert.equal(input[releaseIndex - 1]?.params?.x, 30);
  assert.equal(input[releaseIndex]?.params?.x, 30);
});

test("range_set rejects ambiguous requests before dispatch", async () => {
  const { api, axTrees, commands } = await createHarness({
    initialRangeStates: { 1603: { kind: "native", min: 0, max: 10, current: 5, step: 1, orientation: "horizontal" } },
  });
  axTrees.get("frame-main").push(axNode({ role: "slider", name: "Bounded slider", backendNodeId: 1603, nodeId: "bounded-slider", value: 5 }));
  const snapshot = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  const ref = snapshot.elements.find((item) => item.name === "Bounded slider")?.ref;
  await assert.rejects(() => api.browserRangeSet({ tabId: 41, ref, value: 4, percent: 0.4 }), /exactly one/u);
  await assert.rejects(() => api.browserRangeSet({ tabId: 41, ref, value: 20 }), /between 0 and 10/u);
  assert.equal(commands.filter((item) => item.method === "Input.dispatchMouseEvent" && item.params?.type === "mousePressed").length, 0);
});

test("check boundedly recovers from one transient box-model failure", async () => {
  const { api, axTrees } = await createHarness({ boxModelFailures: 1 });
  axTrees.get("frame-main").push(
    axNode({ role: "checkbox", name: "Newest Gmail row", backendNodeId: 1301, nodeId: "gmail-checkbox" }),
  );
  const snapshot = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  const ref = snapshot.elements.find((item) => item.name === "Newest Gmail row")?.ref;
  assert.ok(ref);

  const checked = await api.browserCheck({ tabId: 41, ref, checked: true });
  assert.equal(checked.actionabilityVersion, 7);
  assert.equal(checked.checked, true);
  assert.equal(checked.actionDispatched, true);
  assert.equal(checked.primaryActionSucceeded, true);
  assert.equal(checked.actionabilityRecovered, true);
  assert.equal(checked.actionabilityReason, "bounded_retry");
  assert.equal(checked.revalidationAttempted, true);
  assert.equal(checked.freshSnapshotRequired, true); // check mutation invalidates the source snapshot as before
});

test("check reports same-page generation churn as retryable without dispatching input", async () => {
  const { api, axTrees, debuggerEvent, commands } = await createHarness();
  axTrees.get("frame-main").push(
    axNode({ role: "checkbox", name: "Newest Gmail row", backendNodeId: 1303, nodeId: "gmail-checkbox-generation" }),
  );
  const snapshot = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  const ref = snapshot.elements.find((item) => item.name === "Newest Gmail row")?.ref;
  assert.ok(ref);

  debuggerEvent.emit({ tabId: 41 }, "Page.frameAttached", { frameId: "gmail-helper", parentFrameId: "frame-main" });
  const checked = await api.browserCheck({ tabId: 41, ref, checked: true });
  assert.equal(checked.actionabilityVersion, 7);
  assert.equal(checked.actionDispatched, false);
  assert.equal(checked.primaryActionSucceeded, false);
  assert.equal(checked.retryableStale, true);
  assert.equal(checked.actionabilityReason, "same_page_generation_churn");
  assert.equal(checked.revalidationAttempted, false);
  assert.equal(checked.freshSnapshotRequired, true);
  assert.equal(checked.refContextReason, "same_page_generation_churn");
  assert.equal(checked.currentSnapshotId, null);
  const checkCalls = commands.filter((item) => (
    item.method === "Runtime.callFunctionOn" &&
    String(item.params?.functionDeclaration || "").includes("const desired = Boolean(wanted)")
  ));
  assert.equal(checkCalls.length, 0);
});

test("check safely reacquires a same-generation detached virtualized checkbox before dispatch", async () => {
  let replaced = false;
  const { api, axTrees, commands } = await createHarness({
    detachedBackendNodeIds: [1304],
    onDetachedBackendNode({ axTrees: trees }) {
      if (replaced) return;
      replaced = true;
      const tree = trees.get("frame-main");
      const index = tree.findIndex((node) => node.nodeId === "gmail-checkbox-recycled");
      tree[index] = axNode({
        role: "checkbox",
        name: "Newest Gmail row",
        backendNodeId: 1404,
        nodeId: "gmail-checkbox-recycled-v2",
        parentId: "gmail-row-recycled",
      });
    },
  });
  axTrees.get("frame-main").push(
    axNode({
      role: "row",
      name: "Message A",
      backendNodeId: 1300,
      nodeId: "gmail-row-recycled",
      childIds: ["gmail-checkbox-recycled"],
    }),
    axNode({
      role: "checkbox",
      name: "Newest Gmail row",
      backendNodeId: 1304,
      nodeId: "gmail-checkbox-recycled",
      parentId: "gmail-row-recycled",
    }),
  );
  const snapshot = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  const ref = snapshot.elements.find((item) => item.name === "Newest Gmail row")?.ref;
  assert.ok(ref);

  const checked = await api.browserCheck({ tabId: 41, ref, checked: true });
  assert.equal(checked.actionabilityVersion, 7);
  assert.equal(checked.checked, true);
  assert.equal(checked.actionDispatched, true);
  assert.equal(checked.primaryActionSucceeded, true);
  assert.equal(checked.outcomeUncertain, false);
  assert.equal(checked.actionabilityRecovered, true);
  assert.equal(checked.actionabilityReason, "snapshot_revalidated");
  assert.equal(checked.revalidationAttempted, true);
  assert.equal(checked.revalidationStatus, "stable_ref_retained");
  assert.ok(checked.revalidatedSnapshotId);
  const finalBox = commands.filter((item) => item.method === "DOM.getBoxModel").at(-1);
  assert.equal(finalBox?.params?.backendNodeId, 1404);
  const checkCalls = commands.filter((item) => (
    item.method === "Runtime.callFunctionOn" &&
    String(item.params?.functionDeclaration || "").includes("const desired = Boolean(wanted)")
  ));
  assert.equal(checkCalls.length, 1);
});

test("check fails closed when same-generation detached replacement is semantically ambiguous", async () => {
  let replaced = false;
  const { api, axTrees, commands } = await createHarness({
    detachedBackendNodeIds: [1305],
    onDetachedBackendNode({ axTrees: trees }) {
      if (replaced) return;
      replaced = true;
      const tree = trees.get("frame-main").filter((node) => node.backendDOMNodeId !== 1305);
      tree.push(
        axNode({ role: "row", name: "Message A", backendNodeId: 1410, nodeId: "ambiguous-row-a", childIds: ["ambiguous-a"] }),
        axNode({ role: "checkbox", name: "Ambiguous Gmail row", backendNodeId: 1405, nodeId: "ambiguous-a", parentId: "ambiguous-row-a" }),
        axNode({ role: "row", name: "Message B", backendNodeId: 1510, nodeId: "ambiguous-row-b", childIds: ["ambiguous-b"] }),
        axNode({ role: "checkbox", name: "Ambiguous Gmail row", backendNodeId: 1505, nodeId: "ambiguous-b", parentId: "ambiguous-row-b" }),
      );
      trees.set("frame-main", tree);
    },
  });
  axTrees.get("frame-main").push(
    axNode({ role: "checkbox", name: "Ambiguous Gmail row", backendNodeId: 1305, nodeId: "ambiguous-source" }),
  );
  const snapshot = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  const ref = snapshot.elements.find((item) => item.name === "Ambiguous Gmail row")?.ref;
  assert.ok(ref);

  const checked = await api.browserCheck({ tabId: 41, ref, checked: true });
  assert.equal(checked.actionDispatched, false);
  assert.equal(checked.primaryActionSucceeded, false);
  assert.equal(checked.outcomeUncertain, false);
  assert.equal(checked.actionabilityReason, "stale_or_rerendered");
  assert.equal(checked.revalidationStatus, "ambiguous");
  assert.equal(checked.freshSnapshotRequired, true);
  const checkCalls = commands.filter((item) => (
    item.method === "Runtime.callFunctionOn" &&
    String(item.params?.functionDeclaration || "").includes("const desired = Boolean(wanted)")
  ));
  assert.equal(checkCalls.length, 0);
});

test("check fails closed when same-generation detached node has no semantic replacement", async () => {
  let removed = false;
  const { api, axTrees, commands } = await createHarness({
    detachedBackendNodeIds: [1307],
    onDetachedBackendNode({ axTrees: trees }) {
      if (removed) return;
      removed = true;
      trees.set("frame-main", trees.get("frame-main").filter((node) => node.backendDOMNodeId !== 1307));
    },
  });
  axTrees.get("frame-main").push(
    axNode({ role: "checkbox", name: "Missing Gmail row", backendNodeId: 1307, nodeId: "missing-checkbox" }),
  );
  const snapshot = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  const ref = snapshot.elements.find((item) => item.name === "Missing Gmail row")?.ref;
  assert.ok(ref);

  const checked = await api.browserCheck({ tabId: 41, ref, checked: true });
  assert.equal(checked.actionDispatched, false);
  assert.equal(checked.actionabilityReason, "stale_or_rerendered");
  assert.equal(checked.revalidationStatus, "not_found");
  assert.equal(checked.freshSnapshotRequired, true);
  const checkCalls = commands.filter((item) => item.method === "Runtime.callFunctionOn" && String(item.params?.functionDeclaration || "").includes("const desired = Boolean(wanted)"));
  assert.equal(checkCalls.length, 0);
});

test("check does not auto-reacquire across a document navigation boundary", async () => {
  const { api, axTrees, debuggerEvent, tab, commands } = await createHarness();
  axTrees.get("frame-main").push(
    axNode({ role: "checkbox", name: "Navigated Gmail row", backendNodeId: 1308, nodeId: "navigated-checkbox" }),
  );
  const snapshot = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  const ref = snapshot.elements.find((item) => item.name === "Navigated Gmail row")?.ref;
  assert.ok(ref);
  tab.url = "http://127.0.0.1:47840/next-document";
  debuggerEvent.emit(
    { tabId: 41 },
    "Page.frameNavigated",
    { frame: { id: "frame-main", url: tab.url } },
  );

  const checked = await api.browserCheck({ tabId: 41, ref, checked: true });
  assert.equal(checked.actionDispatched, false);
  assert.equal(checked.actionabilityReason, "stale_after_navigation");
  assert.equal(checked.retryableStale, false);
  assert.equal(checked.freshSnapshotRequired, true);
  const checkCalls = commands.filter((item) => item.method === "Runtime.callFunctionOn" && String(item.params?.functionDeclaration || "").includes("const desired = Boolean(wanted)"));
  assert.equal(checkCalls.length, 0);
});

test("check never replays when detached-node failure happens after mutation dispatch begins", async () => {
  const { api, axTrees, commands } = await createHarness({ checkActionFailureMessage: "Node is detached from document" });
  axTrees.get("frame-main").push(
    axNode({ role: "checkbox", name: "Uncertain Gmail row", backendNodeId: 1306, nodeId: "uncertain-checkbox" }),
  );
  const snapshot = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  const ref = snapshot.elements.find((item) => item.name === "Uncertain Gmail row")?.ref;
  assert.ok(ref);

  const checked = await api.browserCheck({ tabId: 41, ref, checked: true, after: { snapshot: "full" } });
  assert.equal(checked.actionabilityVersion, 7);
  assert.equal(checked.actionDispatched, true);
  assert.equal(checked.primaryActionSucceeded, false);
  assert.equal(checked.outcomeUncertain, true);
  assert.equal(checked.actionabilityReason, "post_dispatch_outcome_uncertain");
  assert.equal(checked.retryableStale, false);
  assert.equal(checked.freshSnapshotRequired, true);
  assert.equal(checked.refContextReason, "post_dispatch_outcome_uncertain");
  assert.deepEqual(JSON.parse(JSON.stringify(checked.after)), {
    ok: false,
    skipped: true,
    reason: "primary_action_outcome_uncertain",
  });
  const checkCalls = commands.filter((item) => (
    item.method === "Runtime.callFunctionOn" &&
    String(item.params?.functionDeclaration || "").includes("const desired = Boolean(wanted)")
  ));
  assert.equal(checkCalls.length, 1);
});

test("check fails closed with lifecycle metadata when box-model churn persists", async () => {
  const { api, axTrees, commands } = await createHarness({ boxModelFailures: 3 });
  axTrees.get("frame-main").push(
    axNode({ role: "checkbox", name: "Newest Gmail row", backendNodeId: 1302, nodeId: "gmail-checkbox-stale" }),
  );
  const snapshot = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  const ref = snapshot.elements.find((item) => item.name === "Newest Gmail row")?.ref;
  assert.ok(ref);

  const checked = await api.browserCheck({ tabId: 41, ref, checked: true });
  assert.equal(checked.actionabilityVersion, 7);
  assert.equal(checked.checked, null);
  assert.equal(checked.actionDispatched, false);
  assert.equal(checked.primaryActionSucceeded, false);
  assert.equal(checked.actionabilityRecovered, false);
  assert.equal(checked.actionabilityReason, "stale_or_rerendered");
  assert.equal(checked.revalidationAttempted, true);
  assert.equal(checked.refContextValid, false);
  assert.equal(checked.freshSnapshotRequired, true);
  assert.equal(checked.refContextReason, "stale_or_rerendered");
  assert.ok(checked.revalidatedSnapshotId);
  const checkCalls = commands.filter((item) => (
    item.method === "Runtime.callFunctionOn" &&
    String(item.params?.functionDeclaration || "").includes("const desired = Boolean(wanted)")
  ));
  assert.equal(checkCalls.length, 0);
});

test("ref-targeted press and type_text keep keyboard input on the OOPIF session", async () => {
  const { api, commands } = await createHarness();
  let snapshot = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  let ref = snapshot.elements.find((item) => item.name === "Cross field")?.ref;
  assert.ok(ref);

  const pressed = await api.browserPress({ tabId: 41, ref, key: "Enter" });
  assert.equal(pressed.inputVersion, 3);
  assert.equal(pressed.sessionScope, "child");
  assert.equal(pressed.refContextValid, true);
  const pressEvents = commands.filter((item) => item.method === "Input.dispatchKeyEvent").slice(-2);
  assert.equal(pressEvents.length, 2);
  assert.ok(pressEvents.every((item) => item.sessionId === "session-cross"));
  assert.equal(pressEvents[0]?.params?.code, "Enter");
  assert.equal(pressEvents[0]?.params?.windowsVirtualKeyCode, 13);
  assert.equal(pressEvents[0]?.params?.nativeVirtualKeyCode, 13);
  assert.equal(pressEvents[0]?.params?.text, "\r");
  assert.equal(pressEvents[0]?.params?.unmodifiedText, "\r");

  snapshot = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  ref = snapshot.elements.find((item) => item.name === "Cross field")?.ref;
  const typed = await api.browserTypeText({ tabId: 41, ref, text: "Hi" });
  assert.equal(typed.inputVersion, 3);
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

test("fill and type_text can atomically submit Enter on the same OOPIF session", async () => {
  const { api, commands } = await createHarness();
  let snapshot = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  let ref = snapshot.elements.find((item) => item.name === "Cross field")?.ref;
  assert.ok(ref);

  const filled = await api.browserFill({ tabId: 41, ref, value: "search-value", submit: "Enter" });
  assert.equal(filled.inputVersion, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(filled.submit)), { key: "Enter", dispatched: true });
  assert.equal(filled.refLifecycleVersion, 1);
  assert.equal(filled.sourceSnapshotId, snapshot.snapshot.id);
  assert.equal(filled.sourceDocumentGeneration, snapshot.snapshot.documentGeneration);
  assert.equal(filled.currentSnapshotId, null);
  assert.equal(filled.refContextValid, false);
  assert.equal(filled.freshSnapshotRequired, true);
  assert.equal(filled.refContextReason, "atomic_submit_invalidated_snapshot");
  const fillSubmitEvents = commands.filter((item) => item.method === "Input.dispatchKeyEvent").slice(-2);
  assert.equal(fillSubmitEvents.length, 2);
  assert.ok(fillSubmitEvents.every((item) => item.sessionId === "session-cross"));
  assert.equal(fillSubmitEvents[0]?.params?.type, "keyDown");
  assert.equal(fillSubmitEvents[0]?.params?.key, "Enter");
  assert.equal(fillSubmitEvents[0]?.params?.code, "Enter");
  assert.equal(fillSubmitEvents[0]?.params?.windowsVirtualKeyCode, 13);
  assert.equal(fillSubmitEvents[0]?.params?.text, "\r");
  assert.equal(fillSubmitEvents[0]?.params?.unmodifiedText, "\r");
  assert.equal(fillSubmitEvents[1]?.params?.type, "keyUp");

  snapshot = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  ref = snapshot.elements.find((item) => item.name === "Cross field")?.ref;
  assert.ok(ref);
  const typed = await api.browserTypeText({ tabId: 41, ref, text: "Hi", submit: "Enter" });
  assert.equal(typed.inputVersion, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(typed.submit)), { key: "Enter", dispatched: true });
  assert.equal(typed.sourceSnapshotId, snapshot.snapshot.id);
  assert.equal(typed.refContextValid, false);
  assert.equal(typed.refContextReason, "atomic_submit_invalidated_snapshot");
  const typeSubmitEvents = commands.filter((item) => item.method === "Input.dispatchKeyEvent").slice(-2);
  assert.ok(typeSubmitEvents.every((item) => item.sessionId === "session-cross"));
  assert.equal(typeSubmitEvents[0]?.params?.key, "Enter");
  assert.equal(typeSubmitEvents[0]?.params?.text, "\r");
});

test("compound full snapshot can override the inherited projection while delta stays projection-safe", async () => {
  const { api, commands } = await createHarness();
  let snapshot = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  let ref = snapshot.elements.find((item) => item.name === "Cross field")?.ref;
  assert.ok(ref);

  const filled = await api.browserFill({
    tabId: 41,
    ref,
    value: "projection-value",
    after: {
      snapshot: "full",
      snapshotMode: "interactive",
      snapshotScope: "viewport",
      snapshotMaxNodes: 2,
      snapshotQuery: "Main",
      snapshotRoles: ["button"],
    },
  });
  assert.equal(filled.compoundActionVersion, 4);
  assert.equal(filled.after?.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(filled.after?.snapshot?.snapshot?.filters)), {
    mode: "interactive",
    scope: "viewport",
    maxNodes: 2,
    rootRef: null,
    roles: ["button"],
    query: "main",
    mainFrameOnly: false,
    excludeAuxiliaryFrames: false,
    activeLayerOnly: false,
    frameId: null,
    pruneUnnamedRefs: false,
    sensitiveText: "allow",
  });
  assert.equal(filled.refContextValid, true);
  assert.equal(filled.refContextReason, "compound_snapshot_created");

  snapshot = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  ref = snapshot.elements.find((item) => item.name === "Main action")?.ref;
  assert.ok(ref);
  const inputCount = commands.filter((item) => item.method === "Input.dispatchMouseEvent").length;
  await assert.rejects(
    api.browserClick({
      tabId: 41,
      ref,
      after: { snapshot: "delta", snapshotMode: "readable" },
    }),
    /projection must match the current snapshot projection exactly/i,
  );
  assert.equal(commands.filter((item) => item.method === "Input.dispatchMouseEvent").length, inputCount);
});

test("fill and type_text retain the current ref context for same-ref submit chains", async () => {
  const { api } = await createHarness();
  let snapshot = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  let ref = snapshot.elements.find((item) => item.name === "Cross field")?.ref;
  assert.ok(ref);

  const filled = await api.browserFill({ tabId: 41, ref, value: "search-value" });
  assert.equal(filled.refContextValid, true);
  assert.equal(filled.freshSnapshotRequired, false);
  assert.equal(filled.currentSnapshotId, snapshot.snapshot.id);
  const submitted = await api.browserPress({ tabId: 41, ref, key: "Enter" });
  assert.equal(submitted.refContextValid, true);

  snapshot = await api.browserSnapshot({ tabId: 41, mode: "interactive" });
  ref = snapshot.elements.find((item) => item.name === "Cross field")?.ref;
  const typed = await api.browserTypeText({ tabId: 41, ref, text: "Hi" });
  assert.equal(typed.refContextValid, true);
  const submittedAfterType = await api.browserPress({ tabId: 41, ref, key: "Enter" });
  assert.equal(submittedAfterType.refContextValid, true);
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
  assert.equal(filled.inputVersion, 3);
  assert.equal(filled.compoundActionVersion, 4);
  assert.equal(filled.after?.ok, true);
  assert.equal(filled.after?.snapshot?.outputMode, "compact");
  assert.equal(Object.hasOwn(filled.after?.snapshot || {}, "elements"), false);
  assert.equal(filled.refContextValid, true);
  assert.equal(filled.currentSnapshotId, filled.after?.snapshot?.snapshot?.id);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const info = await api.browserRefInfo({ tabId: 41, ref });
  assert.equal(info.exists, true);
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
