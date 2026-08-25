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

async function createHarness({
  openPopupOnClick = false,
  startDownloadOnClick = false,
  coveredCenterOnClick = false,
  openDialogOnClick = false,
} = {}) {
  const debuggerEvent = createEvent();
  const debuggerDetach = createEvent();
  const tabsCreated = createEvent();
  const tabsRemoved = createEvent();
  const tabsUpdated = createEvent();
  const downloadsCreated = createEvent();
  const alarmEvent = createEvent();
  const runtimeStartup = createEvent();
  const runtimeInstalled = createEvent();
  const nativeMessage = createEvent();
  const nativeDisconnect = createEvent();
  const windowUpdates = [];
  const handledDialogs = [];
  const mouseEvents = [];
  const cursorEvaluations = [];
  const tabs = new Map();
  const downloads = new Map();
  tabs.set(51, {
    id: 51,
    windowId: 7,
    index: 0,
    active: true,
    pinned: false,
    title: "Popup source",
    url: "http://127.0.0.1:47850/",
    status: "complete",
  });

  const makePopup = ({ id = 52, openerTabId = 51, windowId = 9, windowType = "popup" } = {}) => {
    const popup = {
      id,
      windowId,
      index: 0,
      active: true,
      pinned: false,
      title: "OAuth popup",
      url: "http://127.0.0.1:47850/popup",
      status: "complete",
      openerTabId,
    };
    tabs.set(id, popup);
    windowTypes.set(windowId, windowType);
    tabsCreated.emit({ ...popup });
    return popup;
  };

  const makeDownload = ({
    id = 71,
    state = "in_progress",
    danger = "safe",
    filename = "/Users/example/Downloads/fixture.txt",
    error = null,
  } = {}) => {
    const download = {
      id,
      filename,
      mime: "text/plain",
      state,
      danger,
      paused: false,
      canResume: state === "interrupted",
      bytesReceived: state === "complete" ? 12 : 0,
      totalBytes: 12,
      fileSize: state === "complete" ? 12 : -1,
      exists: true,
      error,
      startTime: "2026-08-14T18:00:00.000Z",
      ...(state === "complete" ? { endTime: "2026-08-14T18:00:01.000Z" } : {}),
    };
    downloads.set(id, download);
    downloadsCreated.emit({ ...download });
    return download;
  };

  const windowTypes = new Map([[7, "normal"]]);
  let popupOpened = false;
  let downloadStarted = false;
  let dialogOpened = false;
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
      async sendCommand(_debuggee, method, params = {}) {
        if (method === "Page.handleJavaScriptDialog") {
          handledDialogs.push({ ...params });
          debuggerEvent.emit({ tabId: 51 }, "Page.javascriptDialogClosed", { result: Boolean(params.accept) });
          return {};
        }
        if (method === "Page.enable" || method === "Target.setAutoAttach" || method === "Accessibility.enable" || method === "Page.bringToFront" || method === "DOM.scrollIntoViewIfNeeded") return {};
        if (method === "Page.getFrameTree") {
          return {
            frameTree: {
              frame: {
                id: "frame-main",
                url: tabs.get(51).url,
                securityOrigin: "http://127.0.0.1:47850",
                mimeType: "text/html",
              },
            },
          };
        }
        if (method === "Accessibility.getFullAXTree") {
          return {
            nodes: [{
              ignored: false,
              role: { value: "button" },
              name: { value: "Open OAuth popup" },
              backendDOMNodeId: 101,
              properties: [],
            }],
          };
        }
        if (method === "DOM.resolveNode") {
          return { object: { objectId: `node-${params.backendNodeId}` } };
        }
        if (method === "Runtime.evaluate") {
          cursorEvaluations.push({ ...params });
          return { result: { value: { duration: 0 } } };
        }
        if (method === "Runtime.callFunctionOn") {
          const candidates = params.arguments?.[0]?.value || [];
          const value = coveredCenterOnClick
            ? candidates.find((point) => Math.abs(point.x - 60) < 0.01 && point.y < 20) || null
            : candidates[0] || null;
          return { result: { value } };
        }
        if (method === "Runtime.releaseObject") return {};
        if (method === "DOM.getBoxModel") {
          return { model: { border: [10, 10, 110, 10, 110, 50, 10, 50] } };
        }
        if (method === "Input.dispatchMouseEvent") {
          mouseEvents.push({ ...params });
          if (params.type === "mouseReleased" && openPopupOnClick && !popupOpened) {
            popupOpened = true;
            makePopup();
          }
          if (params.type === "mouseReleased" && startDownloadOnClick && !downloadStarted) {
            downloadStarted = true;
            makeDownload();
          }
          if (params.type === "mouseReleased" && openDialogOnClick && !dialogOpened) {
            dialogOpened = true;
            debuggerEvent.emit({ tabId: 51 }, "Page.javascriptDialogOpening", {
              type: "confirm",
              message: "Delete this test item?",
              url: tabs.get(51).url,
              hasBrowserHandler: true,
            });
            return new Promise(() => {});
          }
          return {};
        }
        throw new Error(`Unexpected CDP command: ${method}`);
      },
    },
    tabs: {
      onCreated: tabsCreated,
      onRemoved: tabsRemoved,
      onUpdated: tabsUpdated,
      async get(id) {
        const tab = tabs.get(id);
        if (!tab) throw new Error(`No tab ${id}`);
        return { ...tab };
      },
      async query() {
        return [...tabs.values()].map((tab) => ({ ...tab }));
      },
      async update(id, updates) {
        const tab = tabs.get(id);
        if (!tab) throw new Error(`No tab ${id}`);
        if (updates.active) {
          for (const candidate of tabs.values()) {
            if (candidate.windowId === tab.windowId) candidate.active = false;
          }
        }
        Object.assign(tab, updates);
        return { ...tab };
      },
      async remove(id) {
        tabs.delete(id);
      },
    },
    windows: {
      async getAll() {
        return [...windowTypes.entries()].map(([id, type]) => ({ id, type }));
      },
      async update(id, updates) {
        windowUpdates.push({ id, updates: { ...updates } });
        return { id, type: windowTypes.get(id) || "normal", ...updates };
      },
    },
    downloads: {
      onCreated: downloadsCreated,
      async search(query = {}) {
        if (Number.isInteger(query.id)) {
          const item = downloads.get(query.id);
          return item ? [{ ...item }] : [];
        }
        return [...downloads.values()].map((item) => ({ ...item }));
      },
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
    `${source}\n;globalThis.__tabTest = { ensureBrowserEnabledLoaded, browserSnapshot, browserClick, browserDialog, browserTabsList, browserActivate, browserClose, browserDownloadWait, discoverNewTabs, newDownloadsSince, classifyBrowserPage, validateOpenUrl, pageKindFromFrames, normalizeDebuggerAttachError, getTabCreationSequence: () => tabCreationSequence, getDownloadCreationSequence: () => downloadCreationSequence };`,
    context,
    { filename: SERVICE_WORKER_PATH },
  );
  await context.__tabTest.ensureBrowserEnabledLoaded();

  return {
    api: context.__tabTest,
    makePopup,
    makeDownload,
    tabs,
    downloads,
    windowUpdates,
    handledDialogs,
    mouseEvents,
    cursorEvaluations,
  };
}

test("tabs expose opener relationship, window type and bounded creation identity", async () => {
  const { api, makePopup } = await createHarness();
  makePopup();
  const listed = await api.browserTabsList();
  const popup = listed.find((tab) => tab.id === 52);
  assert.equal(popup?.openerTabId, 51);
  assert.equal(popup?.windowType, "popup");
  assert.equal(popup?.createdSequence, 1);
  assert.match(popup?.createdAt || "", /^\d{4}-\d{2}-\d{2}T/);
});

test("click captures a synchronously opened popup without creating a browser tab itself", async () => {
  const { api, tabs } = await createHarness({ openPopupOnClick: true });
  const snapshot = await api.browserSnapshot({ tabId: 51 });
  const button = snapshot.elements.find((item) => item.name === "Open OAuth popup");
  assert.ok(button?.ref);

  const clicked = await api.browserClick({ tabId: 51, ref: button.ref });
  assert.equal(clicked.tabCreationSequenceBefore, 0);
  assert.equal(clicked.tabCreationSequenceAfter, 1);
  assert.equal(clicked.openedTabs.length, 1);
  assert.equal(clicked.openedTabs[0]?.id, 52);
  assert.equal(clicked.openedTabs[0]?.openerTabId, 51);
  assert.equal(clicked.openedTabs[0]?.windowType, "popup");
  assert.equal(tabs.size, 2);
});

test("click hit-tests inside the AX quad and moves the visible agent cursor to the verified point", async () => {
  const { api, mouseEvents, cursorEvaluations } = await createHarness({ coveredCenterOnClick: true });
  const snapshot = await api.browserSnapshot({ tabId: 51 });
  const button = snapshot.elements.find((item) => item.name === "Open OAuth popup");
  assert.ok(button?.ref);

  const clicked = await api.browserClick({ tabId: 51, ref: button.ref, agentName: "Nyx" });
  assert.equal(clicked.point.x, 60);
  assert.ok(clicked.point.y < 20, `expected an uncovered inset point, got y=${clicked.point.y}`);
  const dispatched = mouseEvents.slice(-3);
  assert.equal(dispatched.length, 3);
  assert.ok(dispatched.every((event) => event.x === clicked.point.x && event.y === clicked.point.y));
  assert.equal(cursorEvaluations.length, 1);
  assert.match(cursorEvaluations[0].expression, /__equinox_browser_agent_cursor__/u);
  assert.match(cursorEvaluations[0].expression, /"pulse":true/u);
  assert.match(cursorEvaluations[0].expression, /"x":60/u);
  assert.match(cursorEvaluations[0].expression, /"agentName":"Nyx"/u);
  assert.match(cursorEvaluations[0].expression, /data-equinox-cursor-name/u);
  assert.match(cursorEvaluations[0].expression, /#665cff/u);
  assert.match(cursorEvaluations[0].expression, /__equinoxCursorHideTimer/u);
  assert.match(cursorEvaluations[0].expression, /"idleMs":3500/u);
});

test("click surfaces JavaScript confirm immediately without requiring observation", async () => {
  const { api, handledDialogs } = await createHarness({ openDialogOnClick: true });
  const snapshot = await api.browserSnapshot({ tabId: 51 });
  const button = snapshot.elements.find((item) => item.name === "Open OAuth popup");
  assert.ok(button?.ref);

  const startedAt = Date.now();
  const clicked = await api.browserClick({ tabId: 51, ref: button.ref });
  assert.ok(Date.now() - startedAt < 1_000, "dialog-aware click should not wait for the blocked CDP command timeout");
  assert.equal(clicked.dialogOpened?.type, "confirm");
  assert.equal(clicked.dialogOpened?.message, "Delete this test item?");
  assert.equal(clicked.dialogOpened?.sessionScope, "root");

  const status = await api.browserDialog({ tabId: 51, action: "status" });
  assert.equal(status.open, true);
  assert.equal(status.dialog?.message, "Delete this test item?");

  const dismissed = await api.browserDialog({ tabId: 51, action: "dismiss" });
  assert.equal(dismissed.action, "dismiss");
  assert.equal(handledDialogs.length, 1);
  assert.equal(handledDialogs[0]?.accept, false);

  const after = await api.browserDialog({ tabId: 51, action: "status" });
  assert.equal(after.open, false);
});

test("new-tab discovery filters unrelated creations by opener tab", async () => {
  const { api, makePopup } = await createHarness();
  makePopup({ id: 60, openerTabId: 999, windowId: 10, windowType: "normal" });
  makePopup({ id: 61, openerTabId: 51, windowId: 11, windowType: "normal" });

  const discovered = await api.discoverNewTabs(0, 51, 0);
  assert.deepEqual(
    JSON.parse(JSON.stringify(discovered.map((tab) => ({ id: tab.id, openerTabId: tab.openerTabId })))),
    [{ id: 61, openerTabId: 51 }],
  );
});

test("activation focuses the owning window so popup and source return are deterministic", async () => {
  const { api, makePopup, windowUpdates } = await createHarness();
  makePopup();

  const popup = await api.browserActivate({ tabId: 52 });
  assert.equal(popup.id, 52);
  assert.equal(popup.focusedWindow, true);
  const source = await api.browserActivate({ tabId: 51 });
  assert.equal(source.id, 51);
  assert.equal(source.focusedWindow, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(windowUpdates)),
    [
      { id: 9, updates: { focused: true } },
      { id: 7, updates: { focused: true } },
    ],
  );
});

test("closing a popup's only tab closes that popup when another Chrome tab still exists", async () => {
  const { api, makePopup, tabs } = await createHarness();
  makePopup();

  const closed = await api.browserClose({ tabId: 52 });
  assert.equal(closed.closed, true);
  assert.equal(closed.emulatedLastTabClose, false);
  assert.equal(tabs.has(52), false);
  assert.equal(tabs.has(51), true);
});

test("click captures a synchronously started Chrome download without exposing its absolute filename", async () => {
  const { api } = await createHarness({ startDownloadOnClick: true });
  const snapshot = await api.browserSnapshot({ tabId: 51 });
  const button = snapshot.elements.find((item) => item.name === "Open OAuth popup");
  assert.ok(button?.ref);

  const clicked = await api.browserClick({ tabId: 51, ref: button.ref });
  assert.equal(clicked.downloadCreationSequenceBefore, 0);
  assert.equal(clicked.downloadCreationSequenceAfter, 1);
  assert.equal(clicked.downloadCreationsObserved, 1);
  assert.equal(clicked.downloadsStartedTruncated, false);
  assert.equal(clicked.downloadsStarted.length, 1);
  assert.equal(clicked.downloadsStarted[0]?.id, 71);
  assert.equal(clicked.downloadsStarted[0]?.name, "fixture.txt");
  assert.equal(clicked.downloadsStarted[0]?.state, "in_progress");
  assert.equal(Object.hasOwn(clicked.downloadsStarted[0], "filename"), false);
});

test("download wait returns terminal complete/interrupted state with filename only for internal resolution", async () => {
  const { api, makeDownload } = await createHarness();
  makeDownload({ id: 72, state: "complete", filename: "/Users/example/Downloads/complete.txt" });
  const complete = await api.browserDownloadWait({ downloadId: 72, timeoutMs: 500 });
  assert.equal(complete.download.state, "complete");
  assert.equal(complete.download.filename, "/Users/example/Downloads/complete.txt");
  assert.equal(complete.download.name, "complete.txt");

  makeDownload({ id: 73, state: "interrupted", error: "NETWORK_FAILED" });
  const interrupted = await api.browserDownloadWait({ downloadId: 73, timeoutMs: 500 });
  assert.equal(interrupted.download.state, "interrupted");
  assert.equal(interrupted.download.error, "NETWORK_FAILED");
});

test("download discovery is bounded to eight creations per page action", async () => {
  const { api, makeDownload } = await createHarness();
  for (let index = 0; index < 12; index += 1) {
    makeDownload({ id: 100 + index, filename: `/Users/example/Downloads/file-${index}.txt` });
  }
  const discovered = await api.newDownloadsSince(0);
  assert.equal(discovered.length, 8);
  assert.deepEqual(
    JSON.parse(JSON.stringify(discovered.map((item) => item.id))),
    [100, 101, 102, 103, 104, 105, 106, 107],
  );
});

test("restricted page classifier distinguishes Chrome UI, Web Store, file URLs and browser interstitials", async () => {
  const { api } = await createHarness();
  const cases = [
    ["chrome://newtab/", "chrome-new-tab", false, true],
    ["chrome://extensions/", "chrome-extensions", false, false],
    ["chrome://settings/", "chrome-settings", false, false],
    ["file:///tmp/equinox.html", "file-url", false, false],
    ["https://chromewebstore.google.com/", "chrome-web-store", false, true],
    ["https://example.com/", "web", true, true],
  ];
  for (const [url, kind, debuggerSupported, openSupported] of cases) {
    const policy = api.classifyBrowserPage(url);
    assert.equal(policy.kind, kind);
    assert.equal(policy.debuggerSupported, debuggerSupported);
    assert.equal(policy.openSupported, openSupported);
  }
  const interstitial = api.classifyBrowserPage({
    url: "https://expired.example/",
    title: "Privacy error",
  });
  assert.equal(interstitial.kind, "browser-owned-interstitial");
  assert.equal(interstitial.debuggerSupported, false);
});

test("open validation keeps New Tab and HTTP(S) but clearly rejects Chrome internal and file destinations", async () => {
  const { api } = await createHarness();
  assert.equal(api.validateOpenUrl("chrome://newtab/"), "chrome://newtab/");
  assert.equal(api.validateOpenUrl("https://example.com/path"), "https://example.com/path");
  assert.throws(() => api.validateOpenUrl("chrome://settings/"), /chrome:\/\/settings is browser-owned UI/i);
  assert.throws(() => api.validateOpenUrl("chrome://extensions/"), /chrome:\/\/extensions is browser-owned UI/i);
  assert.throws(() => api.validateOpenUrl("file:\/\/\/tmp\/fixture.html"), /file:\/\/ pages are intentionally unsupported/i);
});

test("snapshot returns structured restricted metadata without debugger attach for protected pages", async () => {
  const { api, tabs } = await createHarness();
  const source = tabs.get(51);
  source.url = "https://chromewebstore.google.com/";
  source.title = "Chrome Web Store";
  const store = await api.browserSnapshot({ tabId: 51 });
  assert.equal(store.restricted, true);
  assert.equal(store.pageKind, "chrome-web-store");
  assert.equal(store.debuggerSupported, false);
  assert.equal(store.refCount, 0);

  source.url = "chrome://settings/";
  source.title = "Settings";
  const settings = await api.browserSnapshot({ tabId: 51 });
  assert.equal(settings.restricted, true);
  assert.equal(settings.pageKind, "chrome-settings");
  assert.match(settings.text, /cannot be scripted or debugged/i);
});

test("PDF viewer remains supported through its built-in OOPIF while protected attach errors normalize", async () => {
  const { api } = await createHarness();
  assert.equal(api.pageKindFromFrames({ kind: "web" }, [
    { id: "main", mimeType: "application/pdf", url: "https://example.com/a.pdf" },
    { id: "pdf", mimeType: "text/html", url: "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html" },
  ]), "chrome-pdf-viewer");

  const storeError = api.normalizeDebuggerAttachError(new Error("The extensions gallery cannot be scripted."), {
    url: "https://chromewebstore.google.com/",
  });
  assert.equal(storeError.code, "EQUINOX_RESTRICTED_PAGE");
  assert.equal(storeError.pageKind, "chrome-web-store");

  const interstitialError = api.normalizeDebuggerAttachError(new Error("Cannot attach to this target."), {
    url: "https://expired.example/",
    title: "Privacy error",
  });
  assert.equal(interstitialError.code, "EQUINOX_RESTRICTED_PAGE");
  assert.equal(interstitialError.pageKind, "browser-owned-interstitial");
});
