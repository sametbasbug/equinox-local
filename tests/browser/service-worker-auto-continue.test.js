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

async function harness({ freshCreateMode = "normal", freshSubmitReadyAfter = 0 } = {}) {
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
  const pointerEvents = [];
  const broughtToFront = [];
  const composerValues = new Map();
  const createdTabs = [];
  let nextTabId = 100;
  let nativePort = null;
  let freshSubmitProbeCount = 0;

  const chrome = {
    runtime: {
      id: "fixture-extension",
      lastError: null,
      onStartup: runtimeStartup,
      onInstalled: runtimeInstalled,
      onMessage: runtimeMessage,
      getManifest: () => ({ version: "0.6.0" }),
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
      async attach() {},
      async detach() {},
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
          if (params.selector === 'button[data-testid="send-button"][type="submit"]') return { nodeId: 2 };
          if (params.selector === '#prompt-textarea[contenteditable="true"][role="textbox"]') return { nodeId: 3 };
          return { nodeId: 0 };
        }
        if (method === "DOM.describeNode") return { node: { backendNodeId: params.nodeId === 3 ? 2003 : 2002 } };
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
  vm.runInNewContext(`${source}\n;globalThis.__auto = { resolveAutoContinueTarget, setAutoContinueTarget, autoContinueTargetStatus, chatGptContinuationState, chatGptResumeRoute, chatGptFreshHomeRoute, createFreshChatResume, deliverAutoContinuation, browserCapabilityVersions };`, context, { filename: SERVICE_WORKER_PATH });
  await Promise.resolve();
  return { api: context.__auto, storageData, tabs, states, keyEvents, pointerEvents, broughtToFront, filledPrompts, createdTabs, freshSubmitProbeCount: () => freshSubmitProbeCount };
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
  assert.equal(h.filledPrompts.length, 1);
  assert.equal(h.keyEvents.filter((event) => event.key === "Enter" && event.type === "keyUp").length, 1);
  const second = await h.api.deliverAutoContinuation(input);
  assert.equal(second.duplicatePrevented, true);
  assert.equal(h.filledPrompts.length, 1);
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
