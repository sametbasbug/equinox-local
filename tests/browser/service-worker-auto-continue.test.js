import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const SERVICE_WORKER_PATH = fileURLToPath(new URL("../../extension/service-worker.js", import.meta.url));

function event() {
  const listeners = [];
  return { addListener(fn) { listeners.push(fn); }, emit(...args) { for (const fn of listeners) fn(...args); } };
}

async function harness({ freshCreateMode = "normal", freshSubmitReadyAfter = 0, chatComposerChangedProbes = 0 } = {}) {
  const runtimeStartup = event();
  const runtimeInstalled = event();
  const runtimeMessage = event();
  const alarmEvent = event();
  const debuggerEvent = event();
  const debuggerDetach = event();
  const tabsCreated = event();
  const tabsRemoved = event();
  const tabsUpdated = event();
  const downloadsCreated = event();
  const storageData = {
    browserEnabled: true,
    browserControlConsentVersion: 2,
    browserInstanceId: "11111111-2222-4333-8444-555555555555",
    browserContext: "user",
    agentCursorEnabled: true,
    agentCursorName: "Agent",
  };
  const tabs = new Map([
    [41, { id: 41, windowId: 1, index: 0, active: true, pinned: false, title: "Primary task", url: "https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", status: "complete" }],
    [42, { id: 42, windowId: 1, index: 1, active: false, pinned: false, title: "Other chat", url: "https://chatgpt.com/g/g-project/c/11111111-2222-3333-4444-555555555555", status: "complete" }],
    [43, { id: 43, windowId: 1, index: 2, active: false, pinned: false, title: "Docs", url: "https://example.test/", status: "complete" }],
    [44, { id: 44, windowId: 1, index: 3, active: false, pinned: false, title: "Project task", url: "https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef/c/bbbbbbbb-cccc-dddd-eeee-ffffffffffff", status: "complete" }],
  ]);
  const states = new Map([
    [41, { generationActive: true, userEpoch: "user-a", assistantTurnKey: "conversation-turn-8", composerReady: true, composerEmpty: true }],
    [42, { generationActive: false, userEpoch: "user-b", assistantTurnKey: "conversation-turn-4", composerReady: true, composerEmpty: true }],
    [44, { generationActive: false, userEpoch: "user-project", assistantTurnKey: "conversation-turn-2", composerReady: true, composerEmpty: true }],
  ]);
  const keyEvents = [];
  const filledPrompts = [];
  const uploadedFiles = [];
  const pointerEvents = [];
  const broughtToFront = [];
  const composerValues = new Map();
  const createdTabs = [];
  let nextTabId = 100;
  let nativePort = null;
  let freshSubmitProbeCount = 0;
  let chatSubmitProbeCount = 0;
  let debuggerAttachCount = 0;
  let debuggerDetachCount = 0;

  const chrome = {
    runtime: {
      id: "fixture-extension",
      lastError: null,
      onStartup: runtimeStartup,
      onInstalled: runtimeInstalled,
      onMessage: runtimeMessage,
      getManifest: () => ({ version: "0.7.0" }),
      connectNative() {
        nativePort = { onMessage: event(), onDisconnect: event(), postMessage() {} };
        return nativePort;
      },
      reload() {},
    },
    alarms: { onAlarm: alarmEvent, create() {}, async clear() { return true; } },
    storage: {
      local: {
        async get(key) {
          const keys = Array.isArray(key) ? key : [key];
          return Object.fromEntries(keys.map((item) => [item, storageData[item]]));
        },
        async set(values) { Object.assign(storageData, values); },
      },
    },
    debugger: {
      onEvent: debuggerEvent,
      onDetach: debuggerDetach,
      async attach() { debuggerAttachCount += 1; },
      async detach() { debuggerDetachCount += 1; },
      async sendCommand(debuggee, method, params = {}) {
        if (method === "Page.enable" || method === "Target.setAutoAttach") return {};
        if (method === "Page.bringToFront") {
          broughtToFront.push(debuggee.tabId);
          for (const tab of tabs.values()) tab.active = tab.id === debuggee.tabId;
          return {};
        }
        if (method === "DOM.enable") return {};
        if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
        if (method === "DOM.querySelector") {
          if (String(params.selector || "").includes('send-button') || String(params.selector || "").includes('composer-submit-button')) return { nodeId: 2 };
          if (params.selector === '#prompt-textarea[contenteditable="true"][role="textbox"]') return { nodeId: 3 };
          if (params.selector === '#upload-files') return { nodeId: 4 };
          return { nodeId: 0 };
        }
        if (method === "DOM.describeNode") return { node: { backendNodeId: params.nodeId === 3 ? 2003 : params.nodeId === 4 ? 2004 : 2002 } };
        if (method === "DOM.setFileInputFiles") { uploadedFiles.push({ tabId: debuggee.tabId, files: [...(params.files || [])], nodeId: params.nodeId ?? null, backendNodeId: params.backendNodeId ?? null }); return {}; }
        if (method === "DOM.scrollIntoViewIfNeeded") return {};
        if (method === "DOM.getBoxModel") return { model: { border: [1430, 311, 1466, 311, 1466, 347, 1430, 347] } };
        if (method === "DOM.resolveNode") return { object: { objectId: `node-${debuggee.tabId}-${params.backendNodeId}` } };
        if (method === "Runtime.callFunctionOn") {
          const fn = String(params.functionDeclaration || "");
          if (fn.includes("Target is not a supported editable control")) {
            const value = String(params.arguments?.[0]?.value ?? "");
            composerValues.set(debuggee.tabId, value);
            filledPrompts.push(value);
            return { result: { value: { value, editable: true, kind: "contenteditable" } } };
          }
          return { result: { value: { x: 1448, y: 329 } } };
        }
        if (method === "Runtime.releaseObject") return {};
        if (method === "Runtime.evaluate") {
          const expression = String(params.expression || "");
          // Parse the exact generated page expression so fixture shortcuts cannot hide syntax bugs.
          new vm.Script(expression);
          if (expression.includes("Fresh Chat Resume composer state")) {
            const state = states.get(debuggee.tabId) || {};
            return { result: { value: {
              composerReady: state.composerReady === true,
              composerEmpty: state.composerEmpty === true,
              userTurnCount: state.userEpoch ? 1 : 0,
              assistantTurnCount: state.assistantTurnKey ? 1 : 0,
            } } };
          }
          if (expression.includes("Fresh Chat Resume trusted submit target")) {
            freshSubmitProbeCount += 1;
            if (!composerValues.get(debuggee.tabId)) return { result: { value: { ready: false, reason: "send_button_missing" } } };
            if (freshSubmitProbeCount <= freshSubmitReadyAfter) return { result: { value: { ready: false, reason: "send_disabled" } } };
            return { result: { value: { ready: true, x: 101, y: 202 } } };
          }
          if (expression.includes("ChatGPT composer is unavailable")) {
            return { result: { value: { focused: true } } };
          }
          if (expression.includes("Chat Bridge attachment submit readiness.")) {
            return { result: { value: { ready: true } } };
          }
          if (expression.includes("Chat Bridge trusted submit readiness after real Input.insertText.")) {
            chatSubmitProbeCount += 1;
            const value = composerValues.get(debuggee.tabId) ?? "";
            if (!value) return { result: { value: { ready: false, reason: "composer_missing", lengths: null } } };
            const canonical = value.replace(/[\u200B\u2060\uFEFF]/gu, "").replace(/\s+/gu, " ").trim();
            if (chatSubmitProbeCount <= chatComposerChangedProbes) {
              return { result: { value: { ready: false, reason: "composer_changed", lengths: { expected: canonical.length, inner: canonical.length + 1, text: canonical.length + 1 } } } };
            }
            return { result: { value: { ready: true, reason: null, lengths: { expected: canonical.length, inner: canonical.length, text: canonical.length } } } };
          }
          if (expression.includes("Chat Bridge final response: read only the exact completed assistant turn requested by Local.")) {
            const state = states.get(debuggee.tabId) || {};
            if (!state.assistantText) return { result: { value: { found: false } } };
            return { result: { value: { found: true, empty: false, text: state.assistantText, truncated: Boolean(state.responseTruncated) } } };
          }
          if (expression.includes("data-message-author-role")) {
            return { result: { value: { ...(states.get(debuggee.tabId) || {}) } } };
          }
          if (expression.includes("return composer ? String(composer.textContent")) {
            return { result: { value: composerValues.get(debuggee.tabId) ?? "" } };
          }
          return { result: { value: null } };
        }
        if (method === "Input.insertText") {
          const value = String(params.text || "");
          composerValues.set(debuggee.tabId, value);
          filledPrompts.push(value);
          return {};
        }
        if (method === "Input.dispatchMouseEvent") {
          pointerEvents.push({ tabId: debuggee.tabId, ...params });
          if (params.type === "mouseReleased" && params.button === "left" && params.modifiers === 0 && broughtToFront.includes(debuggee.tabId)) {
            const current = states.get(debuggee.tabId) || {};
            const tab = tabs.get(debuggee.tabId);
            if (!current.userEpoch && tab?.url === "https://chatgpt.com/") {
              tab.url = "https://chatgpt.com/c/dddddddd-eeee-ffff-aaaa-bbbbbbbbbbbb";
              states.set(debuggee.tabId, { ...current, generationActive: true, userEpoch: "fresh-root-user", assistantTurnKey: null, composerReady: true, composerEmpty: true });
            } else if (!current.userEpoch && /\/g\/g-p-[a-f0-9]{32}[^/]*\/project$/u.test(String(tab?.url || ""))) {
              const token = String(tab.url).split("/g/")[1].split("/project")[0];
              tab.url = freshCreateMode === "wrong-scope"
                ? "https://chatgpt.com/c/dddddddd-eeee-ffff-aaaa-bbbbbbbbbbbb"
                : `https://chatgpt.com/g/${token}/c/dddddddd-eeee-ffff-aaaa-bbbbbbbbbbbb`;
              states.set(debuggee.tabId, { ...current, generationActive: true, userEpoch: "fresh-project-user", assistantTurnKey: null, composerReady: true, composerEmpty: true });
            } else if (current.userEpoch && composerValues.get(debuggee.tabId)) {
              states.set(debuggee.tabId, { ...current, generationActive: true, userEpoch: `${current.userEpoch}-continued`, composerReady: true, composerEmpty: true });
              composerValues.set(debuggee.tabId, "");
            }
          }
          return {};
        }
        if (method === "Input.dispatchKeyEvent") {
          keyEvents.push({ tabId: debuggee.tabId, ...params });
          if (params.type === "keyUp" && params.key === "Enter") {
            const current = states.get(debuggee.tabId) || {};
            const tab = tabs.get(debuggee.tabId);
            if (!current.userEpoch && tab?.url === "https://chatgpt.com/") {
              tab.url = "https://chatgpt.com/c/dddddddd-eeee-ffff-aaaa-bbbbbbbbbbbb";
              states.set(debuggee.tabId, { ...current, generationActive: true, userEpoch: "fresh-root-user", assistantTurnKey: null, composerReady: true, composerEmpty: true });
            } else if (!current.userEpoch && /\/g\/g-p-[a-f0-9]{32}[^/]*\/project$/u.test(String(tab?.url || ""))) {
              const token = String(tab.url).split("/g/")[1].split("/project")[0];
              tab.url = freshCreateMode === "wrong-scope"
                ? "https://chatgpt.com/c/dddddddd-eeee-ffff-aaaa-bbbbbbbbbbbb"
                : `https://chatgpt.com/g/${token}/c/dddddddd-eeee-ffff-aaaa-bbbbbbbbbbbb`;
              states.set(debuggee.tabId, { ...current, generationActive: true, userEpoch: "fresh-project-user", assistantTurnKey: null, composerReady: true, composerEmpty: true });
            } else {
              states.set(debuggee.tabId, { ...current, generationActive: true, userEpoch: `${current.userEpoch}-continued` });
            }
          }
          return {};
        }
        return {};
      },
    },
    tabs: {
      onCreated: tabsCreated,
      onRemoved: tabsRemoved,
      onUpdated: tabsUpdated,
      async query() { return [...tabs.values()].map((item) => ({ ...item })); },
      async get(id) {
        const tab = tabs.get(id);
        if (!tab) throw new Error("No tab");
        return { ...tab };
      },
      async sendMessage(id, message) {
        const tab = tabs.get(id);
        if (!tab || !String(tab.url || "").startsWith("https://chatgpt.com/")) throw new Error("No receiver");
        if (message?.type !== "equinox.chatgpt.continuationState.get") throw new Error("Unexpected content-script message");
        return { state: { ...(states.get(id) || {}) } };
      },
      async create({ url, active = false } = {}) {
        const id = nextTabId++;
        let finalUrl = String(url || "chrome://newtab/");
        if (/^https:\/\/chatgpt\.com\/g\/(g-p-[a-f0-9]{32})$/u.test(finalUrl)) {
          const projectId = finalUrl.split("/g/")[1];
          finalUrl = `https://chatgpt.com/g/${projectId}-fixture-project/project`;
        }
        const tab = { id, windowId: 1, index: tabs.size, active: Boolean(active), pinned: false, title: "ChatGPT", url: finalUrl, status: "complete" };
        tabs.set(id, tab);
        states.set(id, { generationActive: false, userEpoch: null, assistantTurnKey: null, composerReady: true, composerEmpty: true });
        createdTabs.push({ ...tab });
        return { ...tab };
      },
    },
    windows: { async getAll() { return [{ id: 1, type: "normal" }]; } },
    downloads: { onCreated: downloadsCreated, async search() { return []; } },
  };

  const source = await fs.readFile(SERVICE_WORKER_PATH, "utf8");
  const context = { chrome, crypto: { randomUUID: () => "11111111-2222-4333-8444-555555555555" }, console, URL, InputEvent: class {}, Event: class {}, setTimeout, clearTimeout, queueMicrotask };
  vm.runInNewContext(`${source}\n;globalThis.__auto = { resolveAutoContinueTarget, setAutoContinueTarget, autoContinueTargetStatus, chatGptContinuationState, chatGptResumeRoute, chatGptFreshHomeRoute, createFreshChatResume, deliverAutoContinuation, inspectChatBridgeState, deliverChatBridgeMessage, readChatBridgeFinalResponse, browserCapabilityVersions, attachTab, detachTab };`, context, { filename: SERVICE_WORKER_PATH });
  await Promise.resolve();
  return { api: context.__auto, storageData, tabs, states, keyEvents, pointerEvents, broughtToFront, filledPrompts, uploadedFiles, createdTabs, freshSubmitProbeCount: () => freshSubmitProbeCount, chatSubmitProbeCount: () => chatSubmitProbeCount, debuggerAttachCount: () => debuggerAttachCount, debuggerDetachCount: () => debuggerDetachCount };
}

test("Fresh Chat Resume route preserves stable project identity and root scope", async () => {
  const h = await harness();
  const project = h.api.chatGptResumeRoute("https://chatgpt.com/g/g-p-6a7b6ac8592481918051c4ab333b5f68/c/6aa1e121-3774-83eb-a826-1e8d4b1190b8?foo=bar#x");
  assert.equal(project.scopeKind, "project");
  assert.equal(project.projectId, "g-p-6a7b6ac8592481918051c4ab333b5f68");
  assert.equal(project.scopeToken, "g-p-6a7b6ac8592481918051c4ab333b5f68");
  assert.equal(project.conversationId, "6aa1e121-3774-83eb-a826-1e8d4b1190b8");
  assert.equal(project.freshChatUrl, "https://chatgpt.com/g/g-p-6a7b6ac8592481918051c4ab333b5f68");
  assert.equal(project.canonicalUrl, "https://chatgpt.com/g/g-p-6a7b6ac8592481918051c4ab333b5f68/c/6aa1e121-3774-83eb-a826-1e8d4b1190b8");

  const canonicalized = h.api.chatGptResumeRoute("https://chatgpt.com/g/g-p-6a7b6ac8592481918051c4ab333b5f68-equinox-local-ve-browser-insaati/c/11111111-2222-3333-4444-555555555555");
  assert.equal(canonicalized.scopeKind, "project");
  assert.equal(canonicalized.projectId, project.projectId);
  assert.equal(canonicalized.freshChatUrl, project.freshChatUrl);

  const root = h.api.chatGptResumeRoute("https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  assert.equal(root.scopeKind, "root");
  assert.equal(root.scopeToken, null);
  assert.equal(root.freshChatUrl, "https://chatgpt.com/");
});

test("Fresh Chat Resume route fails closed for unknown or ambiguous ChatGPT paths", async () => {
  const h = await harness();
  assert.equal(h.api.chatGptResumeRoute("https://chatgpt.com/g/g-project/c/11111111-2222-3333-4444-555555555555"), null);
  assert.equal(h.api.chatGptResumeRoute("https://chatgpt.com/g/g-project"), null);
  assert.equal(h.api.chatGptResumeRoute("https://chatgpt.com/g/g-project/x/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"), null);
  assert.equal(h.api.chatGptResumeRoute("https://chatgpt.com/x/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"), null);
  assert.equal(h.api.chatGptResumeRoute("https://example.test/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"), null);
});

test("Fresh Chat Resume waits for delayed send readiness, creates one same-project destination, and replays without mutation", async () => {
  const h = await harness({ freshSubmitReadyAfter: 3 });
  const input = {
    resumeId: "resume-project12",
    sourceTabId: 44,
    sourceConversationId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
    prompt: "Continue task task-abcdef from the latest Task Capsule.",
  };
  const first = await h.api.createFreshChatResume(input);
  assert.equal(first.confirmed, true);
  assert.equal(first.ambiguous, false);
  assert.equal(first.scopeKind, "project");
  assert.equal(first.projectId, "g-p-0123456789abcdef0123456789abcdef");
  assert.equal(first.destinationConversationId, "dddddddd-eeee-ffff-aaaa-bbbbbbbbbbbb");
  assert.match(first.destinationCanonicalUrl, /^https:\/\/chatgpt\.com\/g\/g-p-0123456789abcdef0123456789abcdef-fixture-project\/c\//u);
  assert.equal(h.createdTabs.length, 1);
  assert.equal(h.filledPrompts.length, 1);
  assert.equal(h.broughtToFront.length, 2);
  assert.deepEqual(h.broughtToFront, [h.createdTabs[0].id, h.createdTabs[0].id]);
  assert.equal(h.pointerEvents.filter((event) => event.type === "mousePressed" && event.button === "left").length, 1);
  assert.equal(h.pointerEvents.filter((event) => event.type === "mouseReleased" && event.button === "left").length, 1);
  assert.ok(h.freshSubmitProbeCount() >= 8, `expected stable readiness probes, got ${h.freshSubmitProbeCount()}`);
  assert.equal(h.keyEvents.filter((event) => event.key === "Enter").length, 0);
  assert.equal(h.api.browserCapabilityVersions().freshChatResume, 1);
  assert.ok(h.debuggerAttachCount() > 0, "Fresh Chat Resume delivery should use debugger-backed mutation");
  assert.equal(h.debuggerDetachCount(), 0);
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.ok(h.debuggerDetachCount() > 0, "Fresh Chat Resume should release its debugger lease shortly after submit");

  const replay = await h.api.createFreshChatResume(input);
  assert.equal(replay.confirmed, true);
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(replay.destinationConversationId, first.destinationConversationId);
  assert.equal(h.createdTabs.length, 1);
  assert.equal(h.filledPrompts.length, 1);
});

test("Fresh Chat Resume marks post-mutation scope drift ambiguous and blocks replay", async () => {
  const h = await harness({ freshCreateMode: "wrong-scope" });
  const input = {
    resumeId: "resume-ambig123",
    sourceTabId: 44,
    sourceConversationId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
    prompt: "Continue task task-abcdef from the latest Task Capsule.",
  };
  const first = await h.api.createFreshChatResume(input);
  assert.equal(first.confirmed, false);
  assert.equal(first.ambiguous, true);
  assert.equal(first.status, "ambiguous");
  assert.match(first.reason, /scope does not match/u);
  assert.equal(h.createdTabs.length, 1);
  assert.equal(h.filledPrompts.length, 1);
  assert.equal(h.pointerEvents.filter((event) => event.type === "mouseReleased" && event.button === "left").length, 1);

  const replay = await h.api.createFreshChatResume(input);
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(replay.ambiguous, true);
  assert.equal(h.createdTabs.length, 1);
  assert.equal(h.filledPrompts.length, 1);
});

test("Fresh Chat Resume preserves root scope and rejects source drift before mutation", async () => {
  const h = await harness();
  const root = await h.api.createFreshChatResume({
    resumeId: "resume-root1234",
    sourceTabId: 41,
    sourceConversationId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    prompt: "Continue task task-root12 from the latest Task Capsule.",
  });
  assert.equal(root.confirmed, true);
  assert.equal(root.scopeKind, "root");
  assert.equal(root.projectId, null);
  assert.equal(root.destinationCanonicalUrl, "https://chatgpt.com/c/dddddddd-eeee-ffff-aaaa-bbbbbbbbbbbb");
  assert.equal(h.createdTabs.length, 1);

  await assert.rejects(
    h.api.createFreshChatResume({
      resumeId: "resume-drift123",
      sourceTabId: 44,
      sourceConversationId: "99999999-8888-7777-6666-555555555555",
      prompt: "Continue safely.",
    }),
    /source conversation changed/u,
  );
  assert.equal(h.createdTabs.length, 1);
  assert.equal(h.storageData.freshChatResumeReceipts.length, 1);
});

test("Auto Continue default target resolves the one generating ChatGPT conversation", async () => {
  const h = await harness();
  const result = await h.api.resolveAutoContinueTarget();
  assert.equal(result.mode, "task-tab");
  assert.equal(result.status, "ready");
  assert.equal(result.target.tabId, 41);
  assert.equal(result.target.conversationId, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  assert.equal(h.api.browserCapabilityVersions().autoContinue, 1);
  assert.equal(h.debuggerAttachCount(), 0, "passive target resolution must not attach chrome.debugger");
});

test("pinned Auto Continue target is profile-local and fails closed after conversation drift", async () => {
  const h = await harness();
  await h.api.setAutoContinueTarget({ mode: "pinned", tabId: 42 });
  assert.equal(h.storageData.autoContinueTarget.mode, "pinned");
  assert.equal((await h.api.resolveAutoContinueTarget()).status, "idle");
  h.tabs.get(42).url = "https://chatgpt.com/c/99999999-8888-7777-6666-555555555555";
  const drifted = await h.api.resolveAutoContinueTarget();
  assert.equal(drifted.status, "invalid");
  assert.equal(drifted.reason, "pinned_conversation_changed");
});

test("Chat Bridge v9 inspect reads turn identity without the passive content-script observer", async () => {
  const h = await harness();
  const state = await h.api.inspectChatBridgeState({ tabId: 42 });
  assert.equal(state.chatBridgeVersion, 9);
  assert.equal(state.tabId, 42);
  assert.equal(state.conversationId, "11111111-2222-3333-4444-555555555555");
  assert.equal(state.userEpoch, "user-b");
  assert.equal(state.assistantTurnKey, "conversation-turn-4");
  assert.equal(state.composerReady, true);
  assert.equal(state.composerEmpty, true);
  assert.ok(h.debuggerAttachCount() >= 1);
});

test("Chat Bridge delivery uses its own receipt namespace and blocks duplicate replay", async () => {
  const h = await harness();
  const input = {
    deliveryId: "tgb-abcdef12",
    tabId: 42,
    conversationId: "11111111-2222-3333-4444-555555555555",
    userEpoch: "user-b",
    assistantTurnKey: "conversation-turn-4",
    text: "hello from telegram",
  };
  const first = await h.api.deliverChatBridgeMessage(input);
  assert.equal(first.chatBridgeVersion, 9);
  assert.equal(first.confirmed, true);
  assert.equal(first.duplicatePrevented, false);
  assert.equal(h.api.browserCapabilityVersions().chatBridge, 9);
  assert.equal(h.filledPrompts.filter((value) => value === "hello from telegram").length, 1);
  assert.equal(h.storageData.chatBridgeDeliveryReceipts.length, 1);
  assert.equal(h.storageData.autoContinueDeliveryReceipts, undefined);

  const replay = await h.api.deliverChatBridgeMessage(input);
  assert.equal(replay.confirmed, false);
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(h.filledPrompts.filter((value) => value === "hello from telegram").length, 1);
  assert.equal(h.storageData.chatBridgeDeliveryReceipts.length, 1);
});

test("Chat Bridge v9 uses real Input.insertText before trusted local-reference submit", async () => {
  const h = await harness();
  assert.equal(h.api.browserCapabilityVersions().chatBridge, 9);
  assert.equal(typeof h.api.uploadChatBridgeAttachment, "undefined");
  const delivered = await h.api.deliverChatBridgeMessage({
    deliveryId: "tgb-attach12", tabId: 42, conversationId: "11111111-2222-3333-4444-555555555555",
    userEpoch: "user-b", assistantTurnKey: "conversation-turn-4", text: "Review this file.\n\n[Equinox Local Telegram attachment]\ntask_id: task-abcdef12\nattachment_id: tgatt-000095",
  });
  assert.equal(delivered.confirmed, true);
  assert.equal(delivered.chatBridgeVersion, 9);
  assert.equal(h.uploadedFiles.length, 0);
  assert.equal(h.storageData.chatBridgeDeliveryReceipts.length, 1);
  assert.equal(h.keyEvents.filter((event) => event.key === "Enter").length, 0);
  assert.equal(h.pointerEvents.filter((event) => event.type === "mouseReleased" && event.button === "left").length, 1);
  assert.ok(h.chatSubmitProbeCount() >= 1, `expected Chat Bridge submit readiness probe, got ${h.chatSubmitProbeCount()} probes`);
  assert.equal(h.filledPrompts.filter((value) => value.includes("tgatt-000095")).length, 1);
  assert.equal(h.debuggerDetachCount(), 0);
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.ok(h.debuggerDetachCount() > 0, "Chat Bridge should release its debugger lease shortly after delivery");
});


test("Chat Bridge final reader returns only the expected completed assistant turn and fails closed on user drift", async () => {
  const h = await harness();
  h.states.set(42, {
    generationActive: false, userEpoch: "bridge-user-2", assistantTurnKey: "assistant-turn-5",
    composerReady: true, composerEmpty: true, assistantText: "final bridge response",
  });
  const ready = await h.api.readChatBridgeFinalResponse({
    tabId: 42, conversationId: "11111111-2222-3333-4444-555555555555",
    userEpoch: "bridge-user-2", previousAssistantTurnKey: "conversation-turn-4",
  });
  assert.equal(ready.chatBridgeVersion, 9);
  assert.equal(ready.status, "ready");
  assert.equal(ready.assistantTurnKey, "assistant-turn-5");
  assert.equal(ready.text, "final bridge response");
  assert.equal(ready.truncated, false);

  h.states.set(42, { ...h.states.get(42), generationActive: true });
  const waiting = await h.api.readChatBridgeFinalResponse({
    tabId: 42, conversationId: "11111111-2222-3333-4444-555555555555",
    userEpoch: "bridge-user-2", previousAssistantTurnKey: "conversation-turn-4",
  });
  assert.equal(waiting.status, "waiting");

  h.states.set(42, { ...h.states.get(42), generationActive: false, userEpoch: "human-user-3" });
  const drifted = await h.api.readChatBridgeFinalResponse({
    tabId: 42, conversationId: "11111111-2222-3333-4444-555555555555",
    userEpoch: "bridge-user-2", previousAssistantTurnKey: "conversation-turn-4",
  });
  assert.equal(drifted.chatBridgeVersion, 9);
  assert.equal(drifted.status, "drifted");
  assert.equal(drifted.reason, "user_epoch_changed");
});

test("Auto Continue delivery claims receipt before one submit and blocks duplicate replay", async () => {
  const h = await harness();
  h.states.set(41, { generationActive: false, userEpoch: "user-a", assistantTurnKey: "conversation-turn-8", composerReady: true, composerEmpty: true });
  const input = {
    continuationId: "cont-abcdef12",
    tabId: 41,
    conversationId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    userEpoch: "user-a",
    assistantTurnKey: "conversation-turn-8",
    prompt: "Continue task task-abcdef from checkpoint 2.",
  };
  const first = await h.api.deliverAutoContinuation(input);
  assert.equal(first.confirmed, true);
  assert.ok(h.debuggerAttachCount() > 0, "delivery mutation should still use debugger-backed browser control");
  assert.equal(h.filledPrompts.length, 1);
  assert.equal(h.keyEvents.filter((event) => event.key === "Enter" && event.type === "keyUp").length, 1);
  assert.equal(h.debuggerDetachCount(), 0);
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.ok(h.debuggerDetachCount() > 0, "Auto Continue should release a debugger attachment it created");
  const second = await h.api.deliverAutoContinuation(input);
  assert.equal(second.duplicatePrevented, true);
  assert.equal(h.filledPrompts.length, 1);
});


test("Auto Continue preserves an already-active normal browser debugger lease", async () => {
  const h = await harness();
  h.states.set(41, { generationActive: false, userEpoch: "user-a", assistantTurnKey: "conversation-turn-8", composerReady: true, composerEmpty: true });
  await h.api.attachTab(41);
  assert.equal(h.debuggerAttachCount(), 1);
  const result = await h.api.deliverAutoContinuation({
    continuationId: "cont-existing12",
    tabId: 41,
    conversationId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    userEpoch: "user-a",
    assistantTurnKey: "conversation-turn-8",
    prompt: "Continue task task-existing from checkpoint 1.",
  });
  assert.equal(result.confirmed, true);
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(h.debuggerDetachCount(), 0, "continuation must not shorten a pre-existing normal automation lease");
  await h.api.detachTab(41);
});

test("pinned Auto Continue target fails closed when the pinned tab is closed", async () => {
  const h = await harness();
  await h.api.setAutoContinueTarget({ mode: "pinned", tabId: 42 });
  h.tabs.delete(42);
  const closed = await h.api.resolveAutoContinueTarget();
  assert.equal(closed.status, "invalid");
  assert.equal(closed.reason, "pinned_tab_closed");
});


test("pinned Auto Continue target fails closed when the tab navigates away from ChatGPT", async () => {
  const h = await harness();
  await h.api.setAutoContinueTarget({ mode: "pinned", tabId: 42 });
  h.tabs.get(42).url = "https://example.test/";
  const navigated = await h.api.resolveAutoContinueTarget();
  assert.equal(navigated.status, "invalid");
  assert.equal(navigated.reason, "pinned_conversation_changed");
});
