import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { createExtensionVmContext } from "../helpers/extension-vm-import-scripts.mjs";

const SERVICE_WORKER_PATH = process.env.EQUINOX_STAGED_BROWSER_WORKER || fileURLToPath(new URL("../../extension/service-worker.js", import.meta.url));
const EXTENSION_ROOT = fileURLToPath(new URL("../../extension/", import.meta.url));

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
  storedConsentVersion = 2,
  storedAgentCursor = true,
  storedAgentCursorName = "Selene",
  storedBrowserInstanceId = null,
  storedBrowserContext = null,
  onStorageSet = null,
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
    browserInstanceId: storedBrowserInstanceId,
    browserContext: storedBrowserContext,
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
          const keys = Array.isArray(key) ? key : [key];
          return Object.fromEntries(keys.map((item) => [item, storageData[item]]));
        },
        async set(values) {
          if (onStorageSet) await onStorageSet(values);
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
  const context = createExtensionVmContext({
    sandbox: {
    chrome,
    crypto: {
      randomUUID: () => "11111111-2222-4333-8444-555555555555",
    },
    console,
    URL,
    setTimeout,
    clearTimeout,
    queueMicrotask,
  },
    extensionRoot: EXTENSION_ROOT,
    allowedScripts: ["bookmarks.js"],
  });
  vm.runInContext(
    `${source}\n;globalThis.__life = { ensureBrowserControlConsentLoaded, ensureBrowserEnabledLoaded, ensureAgentCursorEnabledLoaded, ensureAgentCursorNameLoaded, ensureBrowserIdentityLoaded, setBrowserContext, setBrowserEnabled, acceptBrowserControlConsent, setAgentCursorEnabled, setAgentCursorName, updateBrowserSettings, popupStatus, handleCommand, connectNativeHost, scheduleReconnect, snapshot: () => ({ browserEnabled, browserEnabledLoaded, browserControlConsentVersion, browserControlConsentLoaded, agentCursorEnabled, agentCursorEnabledLoaded, agentCursorName, agentCursorNameLoaded, browserInstanceId, browserContext, browserIdentityLoaded, nativePort: Boolean(nativePort), localBridgeConnected, reconnectDelayMs, immediateReconnectUsed, lastNativeDisconnectError, reconnectTimer: Boolean(reconnectTimer) }) };`,
    context,
    { filename: SERVICE_WORKER_PATH },
  );
  await context.__life.ensureBrowserEnabledLoaded();
  await context.__life.ensureBrowserIdentityLoaded();
  await Promise.resolve();
  await Promise.resolve();

  return {
    api: context.__life,
    ports,
    runtimeStartup,
    runtimeInstalled,
    runtimeMessage,
    sendPopupMessage(message, sender = process.env.EQUINOX_STAGED_BROWSER_WORKER
      ? { id: "fixture-extension", url: "chrome-extension://fixture-extension/popup.html" } : {}) {
      return new Promise((resolve, reject) => {
        const listener = runtimeMessage.listeners[0];
        if (!listener) {
          reject(new Error("popup runtime listener missing"));
          return;
        }
        const handled = listener(message, sender, resolve);
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
  assert.equal(first.ports[0].posted[0]?.instanceId, "11111111-2222-4333-8444-555555555555");
  assert.equal(first.ports[0].posted[0]?.browserContext, "unassigned");
  assert.equal(first.storageData.browserInstanceId, "11111111-2222-4333-8444-555555555555");

  const coldWake = await createLifecycleHarness({
    storedBrowserInstanceId: first.storageData.browserInstanceId,
  });
  assert.equal(coldWake.ports.length, 1);
  assert.equal(coldWake.ports[0].posted[0]?.type, "extension.hello");
  assert.equal(coldWake.ports[0].posted[0]?.instanceId, first.storageData.browserInstanceId);
});

test("browser context assignment persists per Chrome profile and is available before automation consent", async () => {
  const harness = await createLifecycleHarness({ storedEnabled: null, storedConsentVersion: null });
  await harness.api.handleCommand({
    type: "command",
    id: "context",
    method: "context.set",
    args: { context: "agent" },
  });
  const response = harness.ports[0].posted.find((message) => message.id === "context");
  assert.equal(response?.ok, true);
  assert.equal(response?.result?.browserContext, "agent");
  assert.equal(harness.storageData.browserContext, "agent");
  const popup = await harness.api.popupStatus();
  assert.equal(popup.browserContext, "agent");
  assert.equal(popup.browserInstanceId, "11111111-2222-4333-8444-555555555555");
});

test("popup requests Agent Browser launch through the connected Local bridge", async () => {
  const harness = await createLifecycleHarness({ storedBrowserContext: "user" });
  harness.ports[0].onMessage.emit({ type: "host.status", localConnected: true });

  const responsePromise = harness.sendPopupMessage({ type: "equinox.popup.openAgentBrowser" });
  await Promise.resolve();
  const request = harness.ports[0].posted.find((message) => message.type === "extension.request");
  assert.equal(request?.method, "agent_browser.open");
  assert.equal(Object.keys(request?.args || {}).length, 0);

  harness.ports[0].onMessage.emit({
    type: "extension.response",
    id: request.id,
    ok: true,
    result: { opened: true, alreadyOpen: false },
  });
  const response = await responsePromise;
  assert.equal(response.ok, true);
  assert.deepEqual(response.result, { opened: true, alreadyOpen: false });
});

test("Agent Browser popup does not ask Local to launch a duplicate Agent Browser", async () => {
  const harness = await createLifecycleHarness({ storedBrowserContext: "agent" });
  harness.ports[0].onMessage.emit({ type: "host.status", localConnected: true });
  const response = await harness.sendPopupMessage({ type: "equinox.popup.openAgentBrowser" });
  assert.equal(response.ok, true);
  assert.equal(response.result.alreadyOpen, true);
  assert.equal(response.result.context, "agent");
  assert.equal(harness.ports[0].posted.some((message) => message.type === "extension.request"), false);
});

test("native host crash reconnects immediately once, then alarm/backoff recovers repeated failure", async () => {
  const harness = await createLifecycleHarness();
  const firstPort = harness.ports[0];
  firstPort.disconnect("Native host crashed");
  await Promise.resolve();

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

test("browser control cannot be enabled through Local until current popup consent is accepted", async () => {
  const harness = await createLifecycleHarness({ storedEnabled: true, storedConsentVersion: 1 });
  assert.equal(harness.api.snapshot().browserEnabled, false, "previous consent v1 must not bypass the current bookmarks disclosure");

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
  assert.equal(response.result.consentVersion, 2);
  assert.equal(response.result.requiredConsentVersion, 2);
  assert.equal(response.result.enabled, true);
  assert.equal(harness.storageData.browserControlConsentVersion, 2);
  assert.equal(harness.storageData.browserEnabled, true);
  assert.equal(harness.api.snapshot().browserControlConsentVersion, 2);
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

// Migration-specific acceptance: the staged TypeScript worker rejects
// inherited Object.prototype method names as native commands. The existing
// Web Store JS worker is unchanged until coordinated Chrome admission.
if (process.env.EQUINOX_STAGED_BROWSER_WORKER) {
  test('staged worker rejects inherited and unknown native command names', async () => {
    const harness = await createLifecycleHarness();
    for (const method of ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty', 'not.allowed']) {
      const id = `guard-${method}`;
      await harness.api.handleCommand({ type: 'command', id, method, args: {} });
      const reply = harness.ports[0].posted.find((message) => message.id === id);
      assert.equal(reply?.ok, false, `Native command ${method} must never dispatch`);
      assert.match(reply.error?.message ?? '', /Unknown Equinox Browser command/u);
    }
    assert.equal(harness.tabQueries.length, 0, 'Unknown native commands must not inspect any browser tabs');
  });
}

if (process.env.EQUINOX_STAGED_BROWSER_WORKER) {
  test('staged native host status only accepts a literal boolean true', async () => {
    const harness = await createLifecycleHarness({ storedEnabled: null, storedConsentVersion: null });
    const port = harness.ports[0];
    for (const localConnected of ['true', 1, { value: true }, null]) {
      port.onMessage.emit({ type: 'host.status', localConnected });
      assert.equal(harness.api.snapshot().localBridgeConnected, false, 'Malformed host status must not promote connectivity');
    }
    port.onMessage.emit({ type: 'host.status', localConnected: true });
    assert.equal(harness.api.snapshot().localBridgeConnected, true, 'Valid host status still records connectivity');
    port.onMessage.emit({ type: 'host.status', localConnected: false });
    assert.equal(harness.api.snapshot().localBridgeConnected, false);
    assert.equal(harness.api.snapshot().browserEnabled, false, 'Host connectivity must not grant automation consent');
    assert.equal(harness.tabQueries.length, 0);
  });

  test('staged malformed native envelopes do not run automation or inspect tabs', async () => {
    const denied = await createLifecycleHarness({ storedEnabled: null, storedConsentVersion: null });
    const port = denied.ports[0];
    const initialPosted = port.posted.length;
    for (const malformed of [null, [], 'command', {}, { type: 'command', method: 'tabs.list' }, { type: 'unrecognized', id: 'x', method: 'tabs.list' }]) {
      port.onMessage.emit(malformed);
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(port.posted.length, initialPosted, 'Invalid envelopes cannot trigger a reply or dispatch');
    port.onMessage.emit({ type: 'command', id: 'no-consent', method: 'tabs.list', args: {} });
    await new Promise((resolve) => setImmediate(resolve));
    const reply = port.posted.find((item) => item.id === 'no-consent');
    assert.equal(reply?.ok, false);
    assert.match(reply.error?.message ?? '', /consent/u);
    assert.equal(denied.tabQueries.length, 0, 'Invalid or blocked native commands cannot inspect Chrome tabs');

    const enabled = await createLifecycleHarness();
    enabled.ports[0].onMessage.emit({ type: 'command', id: 'invalid-method', method: 123, args: {} });
    await new Promise((resolve) => setImmediate(resolve));
    const invalid = enabled.ports[0].posted.find((item) => item.id === 'invalid-method');
    assert.equal(invalid?.ok, false);
    assert.match(invalid.error?.message ?? '', /Unknown Equinox Browser command/u);
    assert.equal(enabled.tabQueries.length, 0);
  });
}

if (process.env.EQUINOX_STAGED_BROWSER_WORKER) {
  test('staged stale Native Messaging port cannot mutate a newer healthy connection', async () => {
    const harness = await createLifecycleHarness({ storedBrowserContext: 'user' });
    const oldPort = harness.ports[0];
    oldPort.disconnect('initial crash');
    await Promise.resolve();
    assert.equal(harness.ports.length, 2, 'First crash reconnects exactly once');
    const currentPort = harness.ports[1];
    currentPort.onMessage.emit({ type: 'host.status', localConnected: true });
    assert.equal(harness.api.snapshot().localBridgeConnected, true);

    oldPort.onMessage.emit({ type: 'host.status', localConnected: false });
    oldPort.onMessage.emit({ type: 'command', id: 'stale-context', method: 'context.set', args: { context: 'agent' } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.storageData.browserContext, 'user', 'Stale port cannot switch profile context');
    assert.equal(harness.api.snapshot().localBridgeConnected, true, 'Old messages cannot overwrite fresh host status');
    assert.equal(oldPort.posted.some((message) => message.id === 'stale-context'), false);

    oldPort.onDisconnect.emit();
    assert.equal(harness.api.snapshot().nativePort, true, 'Old disconnect must not invalidate the new port');
    assert.equal(harness.api.snapshot().localBridgeConnected, true, 'Old disconnect must not mark a healthy port disconnected');
    assert.equal(harness.ports.length, 2, 'Stale disconnect must not initiate another reconnect');
    assert.equal(harness.api.snapshot().reconnectTimer, false, 'Stale disconnect must not arm a backoff alarm');
  });
}

if (process.env.EQUINOX_STAGED_BROWSER_WORKER) {
  test('staged in-flight native command response never crosses a reconnect boundary', async () => {
    let markStarted;
    let releaseWrite;
    const started = new Promise((resolve) => { markStarted = resolve; });
    const held = new Promise((resolve) => { releaseWrite = resolve; });
    const harness = await createLifecycleHarness({
      storedBrowserContext: 'user',
      onStorageSet: async (values) => {
        if (values.browserContext === 'agent') {
          markStarted();
          await held;
        }
      },
    });
    const old = harness.ports[0];
    old.onMessage.emit({ type: 'command', id: 'old-request', method: 'context.set', args: { context: 'agent' } });
    await started;
    old.disconnect('Native host restarted');
    await Promise.resolve();
    assert.equal(harness.ports.length, 2);
    const replacement = harness.ports[1];
    replacement.onMessage.emit({ type: 'host.status', localConnected: true });
    releaseWrite();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.api.snapshot().localBridgeConnected, true);
    assert.equal(harness.storageData.browserContext, 'agent', 'In-flight authorized mutation may complete after host disconnect');
    assert.equal(replacement.posted.some((item) => item.id === 'old-request'), false,
      'Late response from old host must never reach replacement host with potentially reused request IDs');

    let markFailureStarted;
    let releaseFailure;
    const failureStarted = new Promise((resolve) => { markFailureStarted = resolve; });
    const failureHeld = new Promise((resolve) => { releaseFailure = resolve; });
    const failing = await createLifecycleHarness({
      storedBrowserContext: 'user',
      onStorageSet: async (values) => {
        if (values.browserContext === 'agent') {
          markFailureStarted();
          await failureHeld;
          throw new Error('simulated storage failure');
        }
      },
    });
    failing.ports[0].onMessage.emit({ type: 'command', id: 'old-failure', method: 'context.set', args: { context: 'agent' } });
    await failureStarted;
    failing.ports[0].disconnect('Native host restarted');
    await Promise.resolve();
    assert.equal(failing.ports.length, 2);
    releaseFailure();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(failing.ports[1].posted.some((item) => item.id === 'old-failure'), false,
      'Late native error from old host must not leak to replacement host');
    assert.equal(failing.storageData.browserContext, 'user');
  });
}

if (process.env.EQUINOX_STAGED_BROWSER_WORKER) {
  test('staged popup toggles require actual booleans and cannot coerce malformed strings into enabled control', async () => {
    const harness = await createLifecycleHarness({ storedEnabled: false, storedConsentVersion: 2, storedAgentCursor: false });
    for (const invalid of ['true', 'false', 1, null, {}]) {
      const browser = await harness.sendPopupMessage({ type: 'equinox.popup.setEnabled', enabled: invalid });
      assert.equal(browser.ok, false, `Invalid enabled type ${String(invalid)} must be rejected`);
      assert.match(browser.error?.message || '', /boolean/u);
      const cursor = await harness.sendPopupMessage({ type: 'equinox.popup.setAgentCursorEnabled', enabled: invalid });
      assert.equal(cursor.ok, false, 'Invalid cursor enabled type must be rejected');
    }
    assert.equal(harness.storageData.browserEnabled, false);
    assert.equal(harness.storageData.agentCursorEnabled, false);
    assert.equal(harness.tabQueries.length, 0);
    assert.equal((await harness.sendPopupMessage({ type: 'equinox.popup.setEnabled', enabled: true })).ok, true);
    assert.equal(harness.storageData.browserEnabled, true);
    assert.equal((await harness.sendPopupMessage({ type: 'equinox.popup.setAgentCursorEnabled', enabled: true })).ok, true);
    assert.equal(harness.storageData.agentCursorEnabled, true);
  });
}

if (process.env.EQUINOX_STAGED_BROWSER_WORKER) {
  test('staged popup consent and control messages require the actual extension popup sender', async () => {
    const harness = await createLifecycleHarness({ storedEnabled: null, storedConsentVersion: null });
    const initialPosted = harness.ports[0].posted.length;
    const illegalSenders = [
      {},
      { id: 'another-extension', url: 'chrome-extension://fixture-extension/popup.html' },
      { id: 'fixture-extension', url: 'chrome-extension://fixture-extension/options.html' },
      { id: 'fixture-extension', url: 'https://chatgpt.com/c/abc', tab: { id: 7, url: 'https://chatgpt.com/c/abc' } },
      { id: 'fixture-extension', url: 'chrome-extension://fixture-extension/popup.html', tab: { id: 7 } },
    ];
    const sensitive = [
      { type: 'equinox.popup.acceptBrowserControlConsent' },
      { type: 'equinox.popup.setEnabled', enabled: true },
      { type: 'equinox.popup.setAutoContinueTarget', mode: 'pinned', tabId: 7 },
    ];
    for (const sender of illegalSenders) {
      for (const message of sensitive) {
        let callbackInvoked = false;
        const handled = harness.runtimeMessage.listeners[0](message, sender, () => { callbackInvoked = true; });
        assert.equal(handled, false, `Popup command ${message.type} must reject ${JSON.stringify(sender)}`);
        assert.equal(callbackInvoked, false);
      }
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.storageData.browserControlConsentVersion, null);
    assert.equal(harness.storageData.browserEnabled, null);
    assert.equal(harness.tabQueries.length, 0);
    assert.equal(harness.ports[0].posted.length, initialPosted);

    const accepted = await harness.sendPopupMessage({ type: 'equinox.popup.acceptBrowserControlConsent' });
    assert.equal(accepted.ok, true, 'Legitimate popup can still consent');
    assert.equal(harness.storageData.browserControlConsentVersion, 2);
  });
}
