import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(new URL("../../extension/chatgpt-continuation-state.js", import.meta.url));

function node(attrs = {}, textContent = "") {
  return { textContent, getAttribute(name) { return attrs[name] ?? null; } };
}

async function harness({ enabled = true, consentVersion = 2 } = {}) {
  const messages = [];
  let runtimeListener = null;
  let observerCallback = null;
  let timerCallback = null;
  let storageListener = null;
  const storageData = { browserEnabled: enabled, browserControlConsentVersion: consentVersion };
  const state = {
    stop: true,
    user: [node({ "data-message-id": "user-1" })],
    assistant: [node({ "data-message-id": "assistant-1" })],
    userTurns: [node({ "data-testid": "conversation-turn-1" })],
    assistantTurns: [node({ "data-testid": "conversation-turn-2" })],
    composer: node({}, ""),
  };
  const document = {
    documentElement: {},
    querySelectorAll(selector) {
      if (selector.includes('data-message-author-role="user"')) return state.user;
      if (selector.includes('data-message-author-role="assistant"')) return state.assistant;
      if (selector.includes('data-turn="user"')) return state.userTurns;
      if (selector.includes('data-turn="assistant"')) return state.assistantTurns;
      return [];
    },
    querySelector(selector) {
      if (selector === 'button[data-testid="stop-button"]') return state.stop ? node() : null;
      if (selector.startsWith('#prompt-textarea')) return state.composer;
      return null;
    },
    addEventListener() {},
  };
  class MutationObserver {
    constructor(callback) { observerCallback = callback; }
    observe(target, options) { assert.equal(target, document.documentElement); assert.equal(options.subtree, true); }
    disconnect() { observerCallback = null; }
  }
  const chrome = {
    runtime: {
      sendMessage(message) { messages.push(message); return Promise.resolve({ ok: true }); },
      onMessage: { addListener(listener) { runtimeListener = listener; } },
    },
    storage: {
      local: {
        async get(keys) {
          return Object.fromEntries(keys.map((key) => [key, storageData[key]]));
        },
      },
      onChanged: { addListener(listener) { storageListener = listener; } },
    },
  };
  const context = {
    chrome,
    document,
    MutationObserver,
    setTimeout(callback) { timerCallback = callback; return 1; },
    clearTimeout() { timerCallback = null; },
    console,
  };
  const source = await fs.readFile(SCRIPT_PATH, "utf8");
  vm.runInNewContext(source, context, { filename: SCRIPT_PATH });
  await Promise.resolve();
  await Promise.resolve();
  return {
    messages,
    state,
    mutate() { observerCallback?.([]); timerCallback?.(); timerCallback = null; },
    get() {
      let response = null;
      const handled = runtimeListener?.({ type: "equinox.chatgpt.continuationState.get" }, {}, (value) => { response = value; });
      assert.equal(handled, false);
      return response;
    },
    async setAccess({ nextEnabled = storageData.browserEnabled, nextConsentVersion = storageData.browserControlConsentVersion } = {}) {
      const changes = {};
      if (nextEnabled !== storageData.browserEnabled) changes.browserEnabled = { oldValue: storageData.browserEnabled, newValue: nextEnabled };
      if (nextConsentVersion !== storageData.browserControlConsentVersion) changes.browserControlConsentVersion = { oldValue: storageData.browserControlConsentVersion, newValue: nextConsentVersion };
      storageData.browserEnabled = nextEnabled;
      storageData.browserControlConsentVersion = nextConsentVersion;
      storageListener?.(changes, "local");
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

test("ChatGPT continuation observer publishes bounded turn state and suppresses duplicate pushes", async () => {
  const h = await harness();
  assert.equal(h.messages.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.messages[0])), {
    type: "equinox.chatgpt.continuationState.push",
    state: {
      generationActive: true,
      userEpoch: "user-1",
      assistantTurnKey: "conversation-turn-2",
      composerReady: true,
      composerEmpty: true,
    },
  });

  h.mutate();
  assert.equal(h.messages.length, 1, "unchanged DOM state should not push again");

  h.state.stop = false;
  h.state.assistantTurns.push(node({ "data-testid": "conversation-turn-3" }));
  h.state.composer.textContent = "draft";
  h.mutate();
  assert.equal(h.messages.length, 2);
  assert.equal(h.messages[1].state.generationActive, false);
  assert.equal(h.messages[1].state.assistantTurnKey, "conversation-turn-3");
  assert.equal(h.messages[1].state.composerEmpty, false);
});

test("ChatGPT continuation observer serves a fresh synchronous state snapshot", async () => {
  const h = await harness();
  h.state.stop = false;
  h.state.user.push(node({ "data-message-id": "user-2" }));
  const response = h.get();
  assert.equal(response.state.generationActive, false);
  assert.equal(response.state.userEpoch, "user-2");
  assert.equal(response.state.assistantTurnKey, "conversation-turn-2");
});


test("ChatGPT continuation observer does not inspect or publish before browser consent and enablement", async () => {
  const h = await harness({ enabled: false, consentVersion: 0 });
  assert.equal(h.messages.length, 0);
  assert.equal(h.get().state, null);

  await h.setAccess({ nextEnabled: true, nextConsentVersion: 2 });
  assert.equal(h.messages.length, 1);
  assert.equal(h.get().state.generationActive, true);

  await h.setAccess({ nextEnabled: false });
  assert.equal(h.get().state, null);
});
