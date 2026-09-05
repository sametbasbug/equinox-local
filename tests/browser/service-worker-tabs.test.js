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
  historyMode = "document",
  historyCommitDelayMs = 25,
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
  const historyMoves = [];
  const cursorEvaluations = [];
  const touchEvents = [];
  const emulationCommands = [];
  const bookmarkApiCalls = [];
  const bookmarkNodes = new Map([
    ["0", { id: "0", title: "", parentId: null, index: 0 }],
    ["1", { id: "1", title: "Bookmarks bar", parentId: "0", index: 0 }],
    ["2", { id: "2", title: "Other bookmarks", parentId: "0", index: 1 }],
    ["10", { id: "10", title: "Docs", parentId: "11", index: 0, url: "https://example.test/docs?token=secret&ok=1" }],
    ["11", { id: "11", title: "Agent", parentId: "1", index: 1 }],
  ]);
  let nextBookmarkId = 20;
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
    browserControlConsentVersion: 2,
    browserInstanceId: "11111111-2222-4333-8444-555555555555",
    browserContext: "agent",
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
        if (method === "Page.enable" || method === "Target.setAutoAttach" || method === "Accessibility.enable" || method === "Runtime.enable" || method === "Network.enable" || method === "Page.bringToFront" || method === "DOM.scrollIntoViewIfNeeded") return {};
        if (method.startsWith("Emulation.")) {
          emulationCommands.push({ method, params: { ...params } });
          return {};
        }
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
          if (String(params.expression || "").includes("__equinox_browser_mutation_tracker__")) {
            return { result: { value: 0 } };
          }
          if (String(params.expression || "").includes("window.innerWidth")) {
            return { result: { value: { width: 390, height: 844 } } };
          }
          cursorEvaluations.push({ ...params });
          return { result: { value: { duration: 0 } } };
        }
        if (method === "Runtime.callFunctionOn") {
          if (String(params.functionDeclaration || "").includes("isConnected")) {
            return { result: { value: { exists: true, visible: true, enabled: true } } };
          }
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
        if (method === "Input.dispatchTouchEvent") {
          touchEvents.push({ ...params });
          return {};
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
      async create({ url = "chrome://newtab/", active = false } = {}) {
        const id = Math.max(...tabs.keys()) + 1;
        if (active) {
          for (const candidate of tabs.values()) {
            if (candidate.windowId === 7) candidate.active = false;
          }
        }
        const tab = {
          id,
          windowId: 7,
          index: tabs.size,
          active: Boolean(active),
          pinned: false,
          title: url === "chrome://newtab/" ? "New Tab" : "Created tab",
          url,
          status: "complete",
        };
        tabs.set(id, tab);
        tabsCreated.emit({ ...tab });
        return { ...tab };
      },
      async goBack(id) {
        const tab = tabs.get(id);
        if (!tab) throw new Error(`No tab ${id}`);
        historyMoves.push({ id, direction: "back" });
        setTimeout(() => {
          tab.url = "http://127.0.0.1:47850/back";
          tab.title = "Back page";
          if (historyMode === "document") {
            tab.status = "loading";
            tabsUpdated.emit(id, { url: tab.url, title: tab.title, status: "loading" }, { ...tab });
            setTimeout(() => {
              tab.status = "complete";
              tabsUpdated.emit(id, { status: "complete" }, { ...tab });
            }, 25);
          } else {
            tabsUpdated.emit(id, { url: tab.url, title: tab.title }, { ...tab });
          }
        }, historyCommitDelayMs);
      },
      async goForward(id) {
        const tab = tabs.get(id);
        if (!tab) throw new Error(`No tab ${id}`);
        historyMoves.push({ id, direction: "forward" });
        setTimeout(() => {
          tab.url = "http://127.0.0.1:47850/forward";
          tab.title = "Forward page";
          if (historyMode === "document") {
            tab.status = "loading";
            tabsUpdated.emit(id, { url: tab.url, title: tab.title, status: "loading" }, { ...tab });
            setTimeout(() => {
              tab.status = "complete";
              tabsUpdated.emit(id, { status: "complete" }, { ...tab });
            }, 25);
          } else {
            tabsUpdated.emit(id, { url: tab.url, title: tab.title }, { ...tab });
          }
        }, historyCommitDelayMs);
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
    bookmarks: {
      async getChildren(parentId) {
        bookmarkApiCalls.push({ method: "getChildren", parentId });
        return [...bookmarkNodes.values()]
          .filter((node) => node.parentId === String(parentId))
          .sort((a, b) => a.index - b.index)
          .map((node) => ({ ...node }));
      },
      async search(query) {
        bookmarkApiCalls.push({ method: "search", query });
        const needle = String(query).toLowerCase();
        return [...bookmarkNodes.values()]
          .filter((node) => `${node.title || ""} ${node.url || ""}`.toLowerCase().includes(needle))
          .map((node) => ({ ...node }));
      },
      async create(details) {
        bookmarkApiCalls.push({ method: "create", details: { ...details } });
        const parentId = String(details.parentId ?? "1");
        const siblings = [...bookmarkNodes.values()].filter((node) => node.parentId === parentId);
        const node = {
          id: String(nextBookmarkId++),
          parentId,
          index: Number.isInteger(details.index) ? details.index : siblings.length,
          title: details.title || "",
          ...(details.url ? { url: details.url } : {}),
        };
        bookmarkNodes.set(node.id, node);
        return { ...node };
      },
      async get(id) {
        bookmarkApiCalls.push({ method: "get", id: String(id) });
        const node = bookmarkNodes.get(String(id));
        return node ? [{ ...node }] : [];
      },
      async update(id, changes) {
        bookmarkApiCalls.push({ method: "update", id: String(id), changes: { ...changes } });
        const node = bookmarkNodes.get(String(id));
        if (!node) throw new Error(`No bookmark ${id}`);
        Object.assign(node, changes);
        return { ...node };
      },
      async move(id, destination) {
        bookmarkApiCalls.push({ method: "move", id: String(id), destination: { ...destination } });
        const node = bookmarkNodes.get(String(id));
        if (!node) throw new Error(`No bookmark ${id}`);
        if (destination.parentId != null) node.parentId = String(destination.parentId);
        if (destination.index != null) node.index = destination.index;
        return { ...node };
      },
      async remove(id) {
        bookmarkApiCalls.push({ method: "remove", id: String(id) });
        if ([...bookmarkNodes.values()].some((node) => node.parentId === String(id))) throw new Error("Folder is not empty");
        bookmarkNodes.delete(String(id));
      },
      async removeTree(id) {
        bookmarkApiCalls.push({ method: "removeTree", id: String(id) });
        const removeIds = (parentId) => {
          for (const node of [...bookmarkNodes.values()].filter((candidate) => candidate.parentId === parentId)) removeIds(node.id);
          bookmarkNodes.delete(parentId);
        };
        removeIds(String(id));
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
          if (Array.isArray(key)) {
            return Object.fromEntries(key.map((item) => [item, storageData[item]]));
          }
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
    crypto: { randomUUID: () => "11111111-2222-4333-8444-555555555555" },
    console,
    URL,
    setTimeout,
    clearTimeout,
    queueMicrotask,
  };
  vm.runInNewContext(
    `${source}\n;globalThis.__tabTest = { ensureBrowserEnabledLoaded, setBrowserContext, browserSnapshot, browserClick, browserTap, browserSwipe, browserEmulate, browserClearEmulation, browserDialog, browserTabsList, browserActivate, browserCreateTab, browserHistoryNavigate, browserWait, browserObserveStart, browserConsoleRead, browserNetworkRead, browserBookmarksList, browserBookmarksSearch, browserBookmarkAdd, browserBookmarkFolderCreate, browserBookmarkUpdateMove, browserBookmarkRemove, browserClose, browserDownloadWait, discoverNewTabs, newDownloadsSince, classifyBrowserPage, validateOpenUrl, pageKindFromFrames, normalizeDebuggerAttachError, getTabCreationSequence: () => tabCreationSequence, getDownloadCreationSequence: () => downloadCreationSequence };`,
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
    touchEvents,
    emulationCommands,
    bookmarkApiCalls,
    bookmarkNodes,
    storageData,
    historyMoves,
    debuggerEvent,
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

test("create tab defaults to Chrome New Tab and returns bounded tab metadata", async () => {
  const { api, tabs } = await createHarness();
  const created = await api.browserCreateTab({ active: true });
  assert.equal(created.id, 52);
  assert.equal(created.windowId, 7);
  assert.equal(created.url, "chrome://newtab/");
  assert.equal(created.active, true);
  assert.equal(created.pageKind, "chrome-new-tab");
  assert.equal(tabs.get(51)?.active, false);
});

test("history navigation waits for committed metadata before returning", async () => {
  const { api, historyMoves } = await createHarness();
  const back = await api.browserHistoryNavigate({ tabId: 51, direction: "back" });
  assert.equal(back.navigationVersion, 2);
  assert.equal(back.direction, "back");
  assert.equal(back.url, "http://127.0.0.1:47850/back");
  assert.equal(back.title, "Back page");
  assert.equal(back.navigationCommitted, true);
  assert.equal(back.navigationTimedOut, false);
  assert.equal(back.metadataSettled, true);
  assert.equal(back.debuggerSupported, true);

  const forward = await api.browserHistoryNavigate({ tabId: 51, direction: "forward" });
  assert.equal(forward.navigationVersion, 2);
  assert.equal(forward.direction, "forward");
  assert.equal(forward.url, "http://127.0.0.1:47850/forward");
  assert.equal(forward.title, "Forward page");
  assert.equal(forward.navigationCommitted, true);
  assert.equal(forward.navigationTimedOut, false);
  assert.equal(forward.metadataSettled, true);
  assert.deepEqual(JSON.parse(JSON.stringify(historyMoves)), [
    { id: 51, direction: "back" },
    { id: 51, direction: "forward" },
  ]);
});

test("history navigation settles same-document SPA URL changes before returning", async () => {
  const { api } = await createHarness({ historyMode: "spa", historyCommitDelayMs: 30 });
  const back = await api.browserHistoryNavigate({ tabId: 51, direction: "back" });
  assert.equal(back.url, "http://127.0.0.1:47850/back");
  assert.ok(["url_change", "document_generation"].includes(back.navigationSignal));
  assert.equal(back.navigationCommitted, true);
  assert.equal(back.navigationTimedOut, false);
  assert.equal(back.metadataSettled, true);

  const forward = await api.browserHistoryNavigate({ tabId: 51, direction: "forward" });
  assert.equal(forward.url, "http://127.0.0.1:47850/forward");
  assert.ok(["url_change", "document_generation"].includes(forward.navigationSignal));
  assert.equal(forward.navigationCommitted, true);
  assert.equal(forward.navigationTimedOut, false);
  assert.equal(forward.metadataSettled, true);
});

test("smart wait resolves live refs and preserves stale-ref failure after navigation", async () => {
  const { api, debuggerEvent } = await createHarness();
  const snapshot = await api.browserSnapshot({ tabId: 51, mode: "interactive" });
  const ref = snapshot.elements.find((item) => item.name === "Open OAuth popup")?.ref;
  assert.ok(ref);

  const visible = await api.browserWait({ tabId: 51, refVisible: ref, timeoutMs: 500 });
  assert.equal(visible.waitVersion, 2);
  assert.equal(visible.matched, "ref_visible");
  assert.equal(visible.visible, true);

  debuggerEvent.emit(
    { tabId: 51 },
    "Page.frameNavigated",
    { frame: { id: "frame-main", url: "http://127.0.0.1:47850/next" } },
  );
  await assert.rejects(
    api.browserWait({ tabId: 51, refHidden: ref, timeoutMs: 500 }),
    /stale after document\/frame navigation/i,
  );
});

test("smart wait supports DOM stability and bounded network idle", async () => {
  const { api } = await createHarness();
  const stable = await api.browserWait({ tabId: 51, domStable: true, quietMs: 100, timeoutMs: 600 });
  assert.equal(stable.waitVersion, 2);
  assert.equal(stable.matched, "dom_stable");
  assert.equal(stable.quietMs, 100);

  const idle = await api.browserWait({ tabId: 51, networkIdle: true, quietMs: 100, timeoutMs: 600 });
  assert.equal(idle.waitVersion, 2);
  assert.equal(idle.matched, "network_idle");
});

test("snapshot_changed completes when document generation advances", async () => {
  const { api, debuggerEvent } = await createHarness();
  const snapshot = await api.browserSnapshot({ tabId: 51 });
  const waiting = api.browserWait({ tabId: 51, snapshotChanged: snapshot.snapshot.id, timeoutMs: 1_000 });
  setTimeout(() => {
    debuggerEvent.emit(
      { tabId: 51 },
      "Page.frameNavigated",
      { frame: { id: "frame-main", url: "http://127.0.0.1:47850/changed" } },
    );
  }, 50);
  const changed = await waiting;
  assert.equal(changed.waitVersion, 2);
  assert.equal(changed.matched, "snapshot_changed");
  assert.equal(changed.reason, "document_generation");
});

test("mobile emulation drives semantic tap and bounded viewport swipe through touch events", async () => {
  const { api, touchEvents, emulationCommands } = await createHarness();
  const emulated = await api.browserEmulate({
    tabId: 51,
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
    touch: true,
  });
  assert.equal(emulated.emulationVersion, 1);
  assert.deepEqual(emulationCommands.map((entry) => entry.method), [
    "Emulation.setDeviceMetricsOverride",
    "Emulation.setTouchEmulationEnabled",
  ]);

  const snapshot = await api.browserSnapshot({ tabId: 51, mode: "interactive" });
  const ref = snapshot.elements.find((item) => item.name === "Open OAuth popup")?.ref;
  assert.ok(ref);

  const tapped = await api.browserTap({ tabId: 51, ref });
  assert.equal(tapped.touchGestureVersion, 1);
  assert.equal(tapped.gesture, "tap");
  assert.equal(tapped.ref, ref);

  const swiped = await api.browserSwipe({ tabId: 51, direction: "up", distance: 300 });
  assert.equal(swiped.touchGestureVersion, 1);
  assert.equal(swiped.gesture, "swipe");
  assert.equal(swiped.direction, "up");
  assert.equal(swiped.requestedDistance, 300);
  assert.equal(swiped.effectiveDistance, 300);

  assert.deepEqual(touchEvents.map((event) => event.type), [
    "touchStart",
    "touchEnd",
    "touchStart",
    "touchMove",
    "touchMove",
    "touchMove",
    "touchMove",
    "touchMove",
    "touchMove",
    "touchMove",
    "touchMove",
    "touchEnd",
  ]);
  assert.equal(touchEvents[0].touchPoints.length, 1);
  assert.equal(touchEvents.at(-1).touchPoints.length, 0);
});

test("Agent Browser bookmarks stay bounded, redact sensitive URL params and fail closed in Your Browser", async () => {
  const { api, bookmarkApiCalls, bookmarkNodes } = await createHarness();

  const root = await api.browserBookmarksList({ parentId: "0", limit: 1 });
  assert.equal(root.bookmarksVersion, 2);
  assert.equal(root.items.length, 1);
  assert.equal(root.truncated, true);
  assert.equal(root.totalChildren, 2);
  assert.equal(root.folder.path, null);
  assert.equal(root.items[0].path, "Bookmarks bar");

  const searched = await api.browserBookmarksSearch({ query: "Docs", limit: 10 });
  assert.equal(searched.items.length, 1);
  assert.equal(searched.items[0].url.includes("secret"), false);
  assert.equal(searched.items[0].url.includes("%5BREDACTED%5D") || searched.items[0].url.includes("[REDACTED]"), true);
  assert.equal(searched.items[0].parentPath, "Bookmarks bar / Agent");
  assert.equal(searched.items[0].path, "Bookmarks bar / Agent / Docs");

  const folder = await api.browserBookmarkFolderCreate({ title: "Saved", parentId: "1" });
  assert.equal(folder.item.type, "folder");
  assert.equal(folder.item.path, "Bookmarks bar / Saved");
  const added = await api.browserBookmarkAdd({ title: "Example", url: "https://example.test/page", parentId: folder.item.id });
  assert.equal(added.item.type, "bookmark");
  assert.equal(added.item.path, "Bookmarks bar / Saved / Example");

  const moved = await api.browserBookmarkUpdateMove({
    id: added.item.id,
    title: "Example Updated",
    parentId: "2",
    index: 0,
  });
  assert.equal(moved.item.title, "Example Updated");
  assert.equal(moved.item.parentId, "2");
  assert.equal(moved.item.path, "Other bookmarks / Example Updated");

  const removed = await api.browserBookmarkRemove({ id: added.item.id });
  assert.equal(removed.removed.id, added.item.id);
  assert.equal(removed.removed.path, "Other bookmarks / Example Updated");
  assert.equal(bookmarkNodes.has(added.item.id), false);
  const removedFolder = await api.browserBookmarkRemove({ id: folder.item.id, recursive: true });
  assert.equal(removedFolder.recursive, true);

  await api.setBrowserContext("user");
  const callsBeforeUserAttempt = bookmarkApiCalls.length;
  await assert.rejects(
    api.browserBookmarksList({ parentId: "0", limit: 10 }),
    /only in Agent Browser/u,
  );
  assert.equal(bookmarkApiCalls.length, callsBeforeUserAttempt);
});

test("observation v2 provides stable cursors, bounded filters and redacted network metadata", async () => {
  const { api, debuggerEvent } = await createHarness();
  const started = await api.browserObserveStart({ tabId: 51 });
  assert.equal(started.observationVersion, 2);

  debuggerEvent.emit({ tabId: 51 }, "Runtime.consoleAPICalled", {
    type: "log",
    args: [{ value: "hello" }],
  });
  debuggerEvent.emit({ tabId: 51 }, "Runtime.exceptionThrown", {
    exceptionDetails: { text: "needle failure", lineNumber: 7, columnNumber: 3, url: "https://example.test/app.js" },
  });

  const firstConsole = await api.browserConsoleRead({ tabId: 51, limit: 1, afterCursor: 0 });
  assert.equal(firstConsole.items.length, 1);
  assert.equal(firstConsole.items[0].cursor, 1);
  assert.equal(firstConsole.nextCursor, 1);
  assert.equal(firstConsole.hasMore, true);

  const errorConsole = await api.browserConsoleRead({
    tabId: 51,
    afterCursor: firstConsole.nextCursor,
    level: "error",
    query: "needle",
  });
  assert.equal(errorConsole.items.length, 1);
  assert.equal(errorConsole.items[0].cursor, 2);
  assert.equal(errorConsole.nextCursor, 2);
  assert.equal(errorConsole.hasMore, false);

  debuggerEvent.emit({ tabId: 51 }, "Network.requestWillBeSent", {
    requestId: "req-1",
    type: "XHR",
    request: { method: "POST", url: "https://example.test/api/save?token=secret&ok=1" },
  });
  debuggerEvent.emit({ tabId: 51 }, "Network.responseReceived", {
    requestId: "req-1",
    type: "XHR",
    response: {
      url: "https://example.test/api/save?token=secret&ok=1",
      status: 201,
      statusText: "Created",
      mimeType: "application/json",
      headers: { authorization: "do-not-copy" },
    },
  });
  debuggerEvent.emit({ tabId: 51 }, "Network.loadingFinished", {
    requestId: "req-1",
    encodedDataLength: 42,
  });

  const networkPage = await api.browserNetworkRead({
    tabId: 51,
    limit: 1,
    afterCursor: 0,
    urlContains: "/api/save",
    method: "POST",
    status: 201,
    resourceType: "xhr",
  });
  assert.equal(networkPage.items.length, 1);
  assert.equal(networkPage.items[0].phase, "response");
  assert.equal(networkPage.items[0].cursor, 2);
  assert.equal(networkPage.nextCursor, 2);
  assert.equal(networkPage.hasMore, true);
  assert.equal(JSON.stringify(networkPage.items).includes("secret"), false);
  assert.equal(JSON.stringify(networkPage.items).includes("authorization"), false);

  const networkTail = await api.browserNetworkRead({
    tabId: 51,
    afterCursor: networkPage.nextCursor,
    urlContains: "/api/save",
    method: "POST",
    status: 201,
    resourceType: "xhr",
  });
  assert.equal(networkTail.items.length, 1);
  assert.equal(networkTail.items[0].phase, "finished");
  assert.equal(networkTail.nextCursor, 3);

  await assert.rejects(
    api.browserConsoleRead({ tabId: 51, clear: true, afterCursor: 2 }),
    /clear cannot be combined with after_cursor/u,
  );

  for (let index = 0; index < 501; index += 1) {
    debuggerEvent.emit({ tabId: 51 }, "Runtime.consoleAPICalled", {
      type: "log",
      args: [{ value: `event-${index}` }],
    });
  }
  await assert.rejects(
    api.browserConsoleRead({ tabId: 51, afterCursor: 0 }),
    /cursor 0 is no longer available/u,
  );
});

test("network_response wait matches bounded metadata without exposing headers or bodies", async () => {
  const { api, debuggerEvent } = await createHarness();
  const waiting = api.browserWait({
    tabId: 51,
    networkResponse: { urlContains: "/api/wait", method: "POST", status: 204, resourceType: "xhr" },
    timeoutMs: 1_000,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  debuggerEvent.emit({ tabId: 51 }, "Network.requestWillBeSent", {
    requestId: "wait-1",
    type: "XHR",
    request: { method: "POST", url: "https://example.test/api/wait?auth=private" },
  });
  debuggerEvent.emit({ tabId: 51 }, "Network.responseReceived", {
    requestId: "wait-1",
    type: "XHR",
    response: { url: "https://example.test/api/wait?auth=private", status: 204, statusText: "No Content", mimeType: "application/json", headers: { cookie: "private" } },
  });
  const result = await waiting;
  assert.equal(result.matched, "network_response");
  assert.equal(result.observationVersion, 2);
  assert.equal(result.response.method, "POST");
  assert.equal(result.response.status, 204);
  const serialized = JSON.stringify(result.response);
  assert.equal(serialized.includes("private"), false);
  assert.equal(serialized.includes("headers"), false);
  assert.equal(serialized.includes("body"), false);
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
