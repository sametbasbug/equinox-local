import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(new URL("../../extension/chatgpt-continuation-state.js", import.meta.url));

function node(attrs = {}, textContent = "", selectors = {}, selectorLists = {}) {
  return {
    textContent,
    getAttribute(name) { return attrs[name] ?? null; },
    querySelector(selector) { return selectors[selector] ?? null; },
    querySelectorAll(selector) { return selectorLists[selector] ?? []; },
  };
}

async function harness({ enabled = true, consentVersion = 2, modern = false } = {}) {
  const messages = [];
  let runtimeListener = null;
  let observerCallback = null;
  let timerCallback = null;
  let storageListener = null;
  const storageData = { browserEnabled: enabled, browserControlConsentVersion: consentVersion };
  const state = {
    stop: true,
    user: modern ? [] : [node({ "data-message-id": "user-1" })],
    assistant: modern ? [] : [node({ "data-message-id": "assistant-1" })],
    userTurns: modern ? [] : [node({ "data-testid": "conversation-turn-1" })],
    assistantTurns: modern ? [] : [node({ "data-testid": "conversation-turn-2" })],
    composer: modern ? null : node({}, ""),
    modernAssistantUnits: [],
    modernTurns: [],
    modernUserUnits: modern ? [node({ "data-chatgpt-search-message-ids": "modern-user-1", "data-chatgpt-search-unit-key": "fallback-turn-1:0:user" })] : [],
    modernComposer: modern ? node({ "data-composer-markdown": "" }, "") : null,
    modernPrimaryActions: modern ? [node({}, "", {
      'svg[viewBox="0 0 20 20"]': node({}, "", {
        path: { getBBox() { return { x: 4.5, y: 4.5, width: 11, height: 11 }; } },
      }),
    })] : [],
  };
  if (modern) {
    state.modernTurns = [node(
      { "data-turn-key": "modern-user-1" },
      "",
      {},
      { '[data-chatgpt-search-unit-key$=":assistant"][data-chatgpt-search-message-ids]': state.modernAssistantUnits },
    )];
  }
  const document = {
    documentElement: {},
    querySelectorAll(selector) {
      if (selector.includes('data-message-author-role="user"')) return state.user;
      if (selector.includes('data-message-author-role="assistant"')) return state.assistant;
      if (selector.includes('data-turn="user"')) return state.userTurns;
      if (selector.includes('data-turn="assistant"')) return state.assistantTurns;
      if (selector === '[data-turn-key]') return state.modernTurns;
      if (selector.includes('data-chatgpt-search-unit-key$=":user"')) return state.modernUserUnits;
      if (selector.includes('data-chatgpt-search-unit-key$=":assistant"')) return state.modernAssistantUnits;
      if (selector.includes('[data-composer-body] button.bg-composer-primary')) return state.modernPrimaryActions;
      return [];
    },
    querySelector(selector) {
      if (selector === 'button[data-testid="stop-button"]') return modern ? null : (state.stop ? node() : null);
      if (selector.startsWith('#prompt-textarea')) return modern ? null : state.composer;
      if (selector.startsWith('[data-composer-markdown]')) return state.modernComposer;
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

test("ChatGPT continuation observer supports the current data-turn-key DOM without localized labels", async () => {
  const h = await harness({ modern: true });
  const first = h.get().state;
  assert.equal(first.generationActive, true);
  assert.equal(first.userEpoch, "modern-user-1");
  assert.equal(first.assistantTurnKey, "modern-user-1", "data-turn-key must be usable before assistant search units hydrate");
  assert.equal(first.composerReady, true);

  h.state.modernPrimaryActions = [];
  h.state.modernAssistantUnits.push(node({
    "data-chatgpt-search-message-ids": "modern-assistant-1 modern-assistant-1",
    "data-chatgpt-search-unit-key": "fallback-turn-1:2:assistant",
  }));
  h.mutate();
  const finished = h.get().state;
  assert.equal(finished.generationActive, false);
  assert.equal(finished.userEpoch, "modern-user-1");
  assert.equal(finished.assistantTurnKey, "modern-user-1", "the continuity key must not drift when a late assistant message id appears");
});
