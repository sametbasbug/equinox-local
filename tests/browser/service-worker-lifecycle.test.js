import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const SERVICE_WORKER_PATH = fileURLToPath(new URL("../../extension/service-worker.js", import.meta.url));

function createEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) {
      listeners.push(listener);
    },
    emit(...args) {
      for (const listener of [...listeners]) listener(...args);
    },
  };
}

async function createLifecycleHarness({
  storedEnabled = true,
  storedConsentVersion = 1,
  storedAgentCursor = true,
  storedAgentCursorName = "Selene",
} = {}) {
  const runtimeStartup = createEvent();
  const runtimeInstalled = createEvent();
  const runtimeMessage = createEvent();
  const alarmEvent = createEvent();
  const debuggerEvent = createEvent();
  const debuggerDetach = createEvent();
  const tabsCreated = createEvent();
  const tabsRemoved = createEvent();
  const tabsUpdated = createEvent();
  const downloadsCreated = createEvent();
  const alarmsCreated = [];
  const alarmsCleared = [];
  const ports = [];
  const tabQueries = [];
  const storageData = {
    browserEnabled: storedEnabled,
    browserControlConsentVersion: storedConsentVersion,
    agentCursorEnabled: storedAgentCursor,
    agentCursorName: storedAgentCursorName,
  };
  let lastError = null;

  function createNativePort() {
    const onMessage = createEvent();
    const onDisconnect = createEvent();
    const posted = [];
    const port = {
      onMessage,
      onDisconnect,
      posted,
      postMessage(message) {
        posted.push(message);
      },
      disconnect(errorMessage = "Native host exited") {
        lastError = errorMessage ? { message: errorMessage } : null;
        onDisconnect.emit();
        lastError = null;
      },
    };
    ports.push(port);
    return port;
  }

  const chrome = {
    runtime: {
      id: "fixture-extension",
      get lastError() {
        return lastError;
      },
      onStartup: runtimeStartup,
      onInstalled: runtimeInstalled,
      onMessage: runtimeMessage,
      getManifest() {
        return { version: "0.2.1" };
      },
      connectNative(name) {
        assert.equal(name, "dev.equinox.browser");
        return createNativePort();
      },
      reload() {},
    },
    alarms: {
      onAlarm: alarmEvent,
      create(name, info) {
        alarmsCreated.push({ name, info: { ...info } });
      },
      async clear(name) {
        alarmsCleared.push(name);
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
    debugger: {
      onEvent: debuggerEvent,
      onDetach: debuggerDetach,
      async attach() {},
      async detach() {},
      async sendCommand() {
        return {};
      },
    },
    tabs: {
      onCreated: tabsCreated,
      onRemoved: tabsRemoved,
      onUpdated: tabsUpdated,
      async query(queryInfo = {}) {
        tabQueries.push({ ...queryInfo });
        return [];
      },
      async get() {
        throw new Error("No tabs in lifecycle fixture");
      },
    },
    windows: {
      async getAll() {
        return [];
      },
    },
    downloads: {
      onCreated: downloadsCreated,
      async search() {
        return [];
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
    `${source}\n;globalThis.__life = { ensureBrowserControlConsentLoaded, ensureBrowserEnabledLoaded, ensureAgentCursorEnabledLoaded, ensureAgentCursorNameLoaded, setBrowserEnabled, acceptBrowserControlConsent, setAgentCursorEnabled, setAgentCursorName, updateBrowserSettings, popupStatus, handleCommand, connectNativeHost, scheduleReconnect, snapshot: () => ({ browserEnabled, browserEnabledLoaded, browserControlConsentVersion, browserControlConsentLoaded, agentCursorEnabled, agentCursorEnabledLoaded, agentCursorName, agentCursorNameLoaded, nativePort: Boolean(nativePort), localBridgeConnected, reconnectDelayMs, immediateReconnectUsed, lastNativeDisconnectError, reconnectTimer: Boolean(reconnectTimer) }) };`,
    context,
    { filename: SERVICE_WORKER_PATH },
  );
  await context.__life.ensureBrowserEnabledLoaded();
  await Promise.resolve();

  return {
    api: context.__life,
    ports,
    runtimeStartup,
    runtimeInstalled,
    runtimeMessage,
    sendPopupMessage(message) {
      return new Promise((resolve, reject) => {
        const listener = runtimeMessage.listeners[0];
        if (!listener) {
          reject(new Error("popup runtime listener missing"));
          return;
        }
        const handled = listener(message, {}, resolve);
        if (handled !== true) reject(new Error("popup runtime message was not handled"));
      });
    },
    alarmEvent,
    alarmsCreated,
    alarmsCleared,
    tabQueries,
    storageData,
  };
}

test("service worker cold boot connects native host and publishes extension hello without manual reload", async () => {
  const first = await createLifecycleHarness();
  assert.equal(first.ports.length, 1);
  assert.equal(first.api.snapshot().nativePort, true);
  assert.equal(first.ports[0].posted[0]?.type, "extension.hello");
  assert.equal(first.ports[0].posted[0]?.extensionId, "fixture-extension");

  const coldWake = await createLifecycleHarness();
  assert.equal(coldWake.ports.length, 1);
  assert.equal(coldWake.ports[0].posted[0]?.type, "extension.hello");
});

test("native host crash reconnects immediately once, then alarm/backoff recovers repeated failure", async () => {
  const harness = await createLifecycleHarness();
  const firstPort = harness.ports[0];
  firstPort.disconnect("Native host crashed");

  assert.equal(harness.ports.length, 2);
  assert.equal(harness.api.snapshot().nativePort, true);
  assert.equal(harness.api.snapshot().immediateReconnectUsed, true);
  assert.equal(harness.ports[1].posted[0]?.lastNativeDisconnectError, "Native host crashed");

  harness.ports[1].disconnect("Native host unavailable");
  assert.equal(harness.api.snapshot().nativePort, false);
  assert.equal(harness.api.snapshot().reconnectTimer, true);
  assert.equal(harness.alarmsCreated.at(-1)?.name, "equinox-native-reconnect");

  harness.alarmEvent.emit({ name: "equinox-native-reconnect" });
  assert.equal(harness.ports.length, 3);
  assert.equal(harness.api.snapshot().nativePort, true);
  assert.equal(harness.ports[2].posted[0]?.type, "extension.hello");
});

test("Chrome startup event reconnects when the worker is awake but native port is absent", async () => {
  const harness = await createLifecycleHarness();
  harness.ports[0].disconnect("Chrome lifecycle disconnect");
  harness.ports[1].disconnect("Host still down");
  assert.equal(harness.api.snapshot().nativePort, false);

  harness.runtimeStartup.emit();
  await Promise.resolve();
  assert.equal(harness.ports.length, 3);
  assert.equal(harness.api.snapshot().nativePort, true);
  assert.equal(harness.ports[2].posted[0]?.type, "extension.hello");
});

test("new install starts with browser automation off and does not inspect tabs before consent", async () => {
  const harness = await createLifecycleHarness({ storedEnabled: null, storedConsentVersion: null });
  const snapshot = harness.api.snapshot();
  assert.equal(snapshot.browserControlConsentLoaded, true);
  assert.equal(snapshot.browserControlConsentVersion, 0);
  assert.equal(snapshot.browserEnabled, false);
  assert.equal(snapshot.nativePort, true, "the Native Messaging settings channel should still connect");
  assert.equal(harness.tabQueries.length, 0);

  const popup = await harness.api.popupStatus();
  assert.equal(popup.consentAccepted, false);
  assert.equal(popup.enabled, false);
  assert.equal(popup.tab, null);
  assert.equal(harness.tabQueries.length, 0, "popup status must not inspect the active tab before consent");

  await harness.api.handleCommand({ type: "command", id: "status-before-consent", method: "status", args: {} });
  const statusResponse = harness.ports[0].posted.find((message) => message.id === "status-before-consent");
  assert.equal(statusResponse?.ok, true);
  assert.equal(statusResponse?.result?.consentAccepted, false);
  assert.equal(statusResponse?.result?.controlEnabled, false);
  assert.equal(statusResponse?.result?.tabCount, null);
  assert.equal(harness.tabQueries.length, 0, "native status must not enumerate tabs before consent");

  await harness.api.handleCommand({ type: "command", id: "tabs-before-consent", method: "tabs.list", args: {} });
  const blocked = harness.ports[0].posted.find((message) => message.id === "tabs-before-consent");
  assert.equal(blocked?.ok, false);
  assert.match(blocked?.error?.message || "", /consent/u);
  assert.equal(harness.tabQueries.length, 0);
});

test("browser control cannot be enabled through Local until popup consent is accepted", async () => {
  const harness = await createLifecycleHarness({ storedEnabled: true, storedConsentVersion: 0 });
  assert.equal(harness.api.snapshot().browserEnabled, false, "legacy enabled state must not bypass a missing consent version");

  await assert.rejects(
    () => harness.api.setBrowserEnabled(true),
    /requires consent/u,
  );
  assert.equal(harness.storageData.browserEnabled, true, "rejected enable must not rewrite the stored legacy value");

  await harness.api.handleCommand({
    type: "command",
    id: "settings-enable-before-consent",
    method: "settings.update",
    args: { enabled: true },
  });
  const rejected = harness.ports[0].posted.find((message) => message.id === "settings-enable-before-consent");
  assert.equal(rejected?.ok, false);
  assert.match(rejected?.error?.message || "", /requires consent/u);
  assert.equal(harness.api.snapshot().browserEnabled, false);
});

test("explicit popup consent persists the consent version and enables browser control", async () => {
  const harness = await createLifecycleHarness({ storedEnabled: null, storedConsentVersion: null });
  assert.equal(harness.tabQueries.length, 0);

  const response = await harness.sendPopupMessage({
    type: "equinox.popup.acceptBrowserControlConsent",
  });
  assert.equal(response.ok, true);
  assert.equal(response.result.consentAccepted, true);
  assert.equal(response.result.consentVersion, 1);
  assert.equal(response.result.requiredConsentVersion, 1);
  assert.equal(response.result.enabled, true);
  assert.equal(harness.storageData.browserControlConsentVersion, 1);
  assert.equal(harness.storageData.browserEnabled, true);
  assert.equal(harness.api.snapshot().browserControlConsentVersion, 1);
  assert.equal(harness.api.snapshot().browserEnabled, true);
  assert.ok(harness.tabQueries.length > 0, "tab inspection may begin only after the affirmative consent action");
});

test("popup toggle persists disabled automation while keeping the local control channel alive", async () => {
  const harness = await createLifecycleHarness();
  assert.equal(harness.ports.length, 1);

  harness.ports[0].onMessage.emit({ type: "host.status", localConnected: true });
  assert.equal((await harness.api.popupStatus()).localConnected, true);

  const disabled = await harness.api.setBrowserEnabled(false);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.nativeHostConnected, true);
  assert.equal(disabled.localConnected, true);
  assert.equal(harness.storageData.browserEnabled, false);
  assert.equal(harness.api.snapshot().nativePort, true);
  assert.equal(harness.api.snapshot().reconnectTimer, false);

  harness.alarmEvent.emit({ name: "equinox-native-reconnect" });
  assert.equal(harness.ports.length, 1, "an already-connected settings channel must not duplicate the native host");

  const enabled = await harness.api.setBrowserEnabled(true);
  assert.equal(enabled.enabled, true);
  assert.equal(harness.storageData.browserEnabled, true);
  assert.equal(harness.ports.length, 1);
  assert.equal(harness.api.snapshot().nativePort, true);
});

test("native settings commands remain available while browser automation is disabled", async () => {
  const harness = await createLifecycleHarness({ storedEnabled: false });
  assert.equal(harness.ports.length, 1);

  await harness.api.handleCommand({
    type: "command",
    id: "settings-1",
    method: "settings.update",
    args: { enabled: false, agentCursorEnabled: false, agentCursorName: "Nyx" },
  });
  const settingsResponse = harness.ports[0].posted.find((message) => message.id === "settings-1");
  assert.equal(settingsResponse?.ok, true);
  assert.equal(settingsResponse?.result?.enabled, false);
  assert.equal(settingsResponse?.result?.agentCursorEnabled, false);
  assert.equal(settingsResponse?.result?.agentCursorName, "Nyx");

  await harness.api.handleCommand({ type: "command", id: "blocked-1", method: "tabs.list", args: {} });
  const blocked = harness.ports[0].posted.find((message) => message.id === "blocked-1");
  assert.equal(blocked?.ok, false);
  assert.match(blocked?.error?.message || "", /turned off/u);
});

test("agent cursor preference persists and is exposed through popup messaging", async () => {
  const harness = await createLifecycleHarness({ storedAgentCursor: false });
  const initial = await harness.api.popupStatus();
  assert.equal(initial.agentCursorEnabled, false);

  const response = await harness.sendPopupMessage({
    type: "equinox.popup.setAgentCursorEnabled",
    enabled: true,
  });
  assert.equal(response.ok, true);
  assert.equal(response.result.agentCursorEnabled, true);
  assert.equal(harness.storageData.agentCursorEnabled, true);
  assert.equal(harness.api.snapshot().agentCursorEnabled, true);
});

test("agent cursor name persists, sanitizes and is exposed through popup messaging", async () => {
  const harness = await createLifecycleHarness({ storedAgentCursorName: "  Selene  " });
  const initial = await harness.api.popupStatus();
  assert.equal(initial.agentCursorName, "Selene");

  const response = await harness.sendPopupMessage({
    type: "equinox.popup.setAgentCursorName",
    name: "  Nyx\n Orbit  ",
  });
  assert.equal(response.ok, true);
  assert.equal(response.result.agentCursorName, "Nyx Orbit");
  assert.equal(harness.storageData.agentCursorName, "Nyx Orbit");
  assert.equal(harness.api.snapshot().agentCursorName, "Nyx Orbit");

  const reset = await harness.sendPopupMessage({
    type: "equinox.popup.setAgentCursorName",
    name: "   ",
  });
  assert.equal(reset.ok, true);
  assert.equal(reset.result.agentCursorName, "Agent");
  assert.equal(harness.storageData.agentCursorName, "Agent");
});

test("persisted popup off state survives service-worker cold boot while the settings channel reconnects", async () => {
  const harness = await createLifecycleHarness({ storedEnabled: false });
  assert.equal(harness.api.snapshot().browserEnabledLoaded, true);
  assert.equal(harness.api.snapshot().browserEnabled, false);
  assert.equal(harness.api.snapshot().nativePort, true);
  assert.equal(harness.ports.length, 1);

  harness.runtimeStartup.emit();
  await Promise.resolve();
  assert.equal(harness.ports.length, 1, "Chrome startup must not duplicate the existing settings channel");
});
