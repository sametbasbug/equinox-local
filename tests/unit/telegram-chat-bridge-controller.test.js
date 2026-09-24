import assert from "node:assert/strict";
import test from "node:test";

import { createTelegramChatBridgeController } from "../../src/telegram-chat-bridge-controller.js";

const binding = Object.freeze({
  sourceTaskId: "task-abcdef12",
  browserContext: "user",
  browserInstanceId: "instance-user-123",
  tabId: 77,
  conversationId: "abcdef12-3456-7890-abcd-ef1234567890",
  canonicalUrl: "https://chatgpt.com/c/abcdef12-3456-7890-abcd-ef1234567890",
  title: "Bound chat",
  boundAt: "2026-09-21T00:00:00.000Z",
});

function fixture({
  capability = 9,
  instanceId = binding.browserInstanceId,
  state = {},
  deliverResult = { confirmed: true, userEpoch: "user-epoch-2", previousAssistantTurnKey: "assistant-turn-1" },
  readResult = { status: "waiting" },
  tabs = [{ id: binding.tabId, url: binding.canonicalUrl }],
  inspectByTab = {},
} = {}) {
  const calls = [];
  const browserBridge = {
    snapshot: () => ({ contexts: { user: { ready: true, extension: { instanceId, capabilityVersions: { chatBridge: capability } } } } }),
    call: async (method, args, options) => {
      calls.push({ method, args, options });
      if (method === "continuation.inspect" || method === "chat_bridge.inspect") {
        const override = inspectByTab[args.tabId];
        if (override instanceof Error) throw override;
        return {
          conversationId: binding.conversationId,
          userEpoch: "user-epoch-1",
          assistantTurnKey: "assistant-turn-1",
          generationActive: false,
          composerReady: true,
          composerEmpty: true,
          ...state,
          ...(override || {}),
        };
      }
      if (method === "tabs.list") return tabs;
      if (method === "chat_bridge.deliver") {
        if (deliverResult instanceof Error) throw deliverResult;
        return deliverResult;
      }
      if (method === "chat_bridge.read_final") {
        if (readResult instanceof Error) throw readResult;
        return readResult;
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
  const agentControl = { assertMutationAllowed: (operation) => calls.push({ operation }) };
  return { controller: createTelegramChatBridgeController({ browserBridge, agentControl }), calls };
}

test("Telegram Chat Bridge delivers text only to the exact bound idle conversation", async () => {
  const f = fixture();
  const result = await f.controller.deliverText({ binding, deliveryId: "tgb-abcdef12", text: "hello" });
  assert.deepEqual(result, {
    confirmed: true, duplicatePrevented: false, deliveryId: "tgb-abcdef12",
    userEpoch: "user-epoch-2", previousAssistantTurnKey: "assistant-turn-1", tabId: 77,
  });
  assert.equal(f.calls[0].operation, "telegram_chat_bridge_delivery");
  assert.equal(f.calls[1].method, "chat_bridge.inspect");
  assert.equal(f.calls[2].method, "chat_bridge.deliver");
  assert.deepEqual(f.calls[2].args, {
    deliveryId: "tgb-abcdef12",
    tabId: 77,
    conversationId: binding.conversationId,
    userEpoch: "user-epoch-1",
    assistantTurnKey: "assistant-turn-1",
    text: "hello",
  });
});

test("Telegram Chat Bridge fails closed for outdated capability, instance drift and conversation drift", async () => {
  await assert.rejects(
    fixture({ capability: 8 }).controller.deliverText({ binding, deliveryId: "tgb-abcdef12", text: "hello" }),
    /newer Equinox Browser Chat Bridge capability/u,
  );
  await assert.rejects(
    fixture({ instanceId: "different-instance" }).controller.deliverText({ binding, deliveryId: "tgb-abcdef12", text: "hello" }),
    /browser instance changed/u,
  );
  await assert.rejects(
    fixture({ state: { conversationId: "99999999-8888-7777-6666-555555555555" } }).controller.deliverText({ binding, deliveryId: "tgb-abcdef12", text: "hello" }),
    /no longer contains the expected conversation/u,
  );
});

test("Telegram Chat Bridge v9 reacquires one exact conversation after tab id drift", async () => {
  const f = fixture({
    capability: 9,
    tabs: [{ id: 88, url: binding.canonicalUrl }],
    inspectByTab: { 77: new Error("No tab with id: 77"), 88: {} },
  });
  const result = await f.controller.deliverText({ binding, deliveryId: "tgb-reacquire1", text: "hello" });
  assert.equal(result.confirmed, true);
  assert.equal(result.tabId, 88);
  assert.equal(f.calls.some((item) => item.method === "tabs.list"), true);
  const inspectCalls = f.calls.filter((item) => item.method === "chat_bridge.inspect");
  assert.deepEqual(inspectCalls.map((item) => item.args.tabId), [77, 88]);
  const deliver = f.calls.find((item) => item.method === "chat_bridge.deliver");
  assert.equal(deliver.args.tabId, 88);
});

test("Telegram Chat Bridge v9 fails closed when exact conversation reacquire is ambiguous", async () => {
  const f = fixture({
    capability: 9,
    tabs: [{ id: 88, url: binding.canonicalUrl }, { id: 89, url: binding.canonicalUrl }],
    inspectByTab: { 77: new Error("No tab with id: 77") },
  });
  await assert.rejects(
    f.controller.deliverText({ binding, deliveryId: "tgb-reacquire2", text: "hello" }),
    /open in multiple tabs/u,
  );
  assert.equal(f.calls.some((item) => item.method === "chat_bridge.deliver"), false);
});

test("Telegram Chat Bridge refuses busy or non-empty composers before browser mutation", async () => {
  for (const state of [
    { generationActive: true },
    { composerEmpty: false },
    { composerReady: false },
  ]) {
    const f = fixture({ state });
    await assert.rejects(
      f.controller.deliverText({ binding, deliveryId: "tgb-abcdef12", text: "hello" }),
      (error) => error?.code === "CHAT_BRIDGE_NOT_READY",
    );
    assert.equal(f.calls.some((call) => call.method === "chat_bridge.deliver"), false);
  }
});


test("Telegram Chat Bridge reads only the exact final response state from the bound conversation", async () => {
  const f = fixture({ readResult: { status: "ready", text: "final answer", assistantTurnKey: "assistant-turn-2", truncated: false } });
  const result = await f.controller.readFinal({ binding, userEpoch: "user-epoch-2", previousAssistantTurnKey: "assistant-turn-1" });
  assert.deepEqual(result, { status: "ready", text: "final answer", assistantTurnKey: "assistant-turn-2", truncated: false, tabId: 77 });
  const call = f.calls.find((item) => item.method === "chat_bridge.read_final");
  assert.deepEqual(call.args, {
    tabId: 77, conversationId: binding.conversationId, userEpoch: "user-epoch-2", previousAssistantTurnKey: "assistant-turn-1",
  });
});

test("Telegram Chat Bridge final-response reader preserves waiting and fails closed on drift", async () => {
  assert.deepEqual(
    await fixture({ readResult: { status: "waiting" } }).controller.readFinal({ binding, userEpoch: "user-epoch-2", previousAssistantTurnKey: "assistant-turn-1" }),
    { status: "waiting", tabId: 77 },
  );
  await assert.rejects(
    fixture({ readResult: { status: "drifted", reason: "user_epoch_changed" } }).controller.readFinal({ binding, userEpoch: "user-epoch-2", previousAssistantTurnKey: "assistant-turn-1" }),
    (error) => error?.code === "CHAT_BRIDGE_DRIFTED",
  );
});

test("Telegram Chat Bridge treats browser delivery exceptions and unconfirmed results as ambiguous", async () => {
  await assert.rejects(
    fixture({ deliverResult: new Error("timeout after submit") }).controller.deliverText({ binding, deliveryId: "tgb-abcdef12", text: "hello" }),
    (error) => error?.code === "CHAT_BRIDGE_AMBIGUOUS",
  );
  await assert.rejects(
    fixture({ deliverResult: { confirmed: false, ambiguous: true } }).controller.deliverText({ binding, deliveryId: "tgb-abcdef12", text: "hello" }),
    (error) => error?.code === "CHAT_BRIDGE_AMBIGUOUS",
  );
});

test("Telegram Chat Bridge v9 opens one root ChatGPT conversation only for new Task creation", async () => {
  const conversationId = "12345678-1234-1234-1234-123456789abc";
  const taskId = "task-newtask12";
  const calls = [];
  let submitted = false;
  let typedText = "";
  const browserBridge = {
    snapshot: () => ({ contexts: { user: { ready: true, extension: { instanceId: "instance-user-123", capabilityVersions: { chatBridge: 9 } } } } }),
    call: async (method, args, options) => {
      calls.push({ method, args, options });
      if (method === "tabs.create") { assert.equal(args.url, "https://chatgpt.com/"); return { id: 88 }; }
      if (method === "snapshot") {
        if (args.roles?.includes("textbox")) return { refContextValid: true, elements: [{ ref: "@e1", role: "textbox", name: "Prompt" }] };
        if (args.roles?.includes("button")) return { refContextValid: true, elements: [{ ref: "@send", role: "button", name: "Send prompt" }] };
      }
      if (method === "type_text") {
        assert.equal(args.tabId, 88);
        assert.match(args.text, /Start task task-newtask12 from checkpoint 1/u);
        assert.equal(Object.hasOwn(args, "submit"), false);
        typedText = args.text;
        return { ok: true };
      }
      if (method === "eval") {
        if (args.expression.includes("send-button")) return { value: { ready: true, reason: null, name: "Send prompt", text: typedText } };
        return { value: { present: true, text: typedText, generationActive: false } };
      }
      if (method === "click") {
        assert.equal(args.tabId, 88);
        assert.equal(args.ref, "@send");
        submitted = true;
        return { actionDispatched: true, primaryActionSucceeded: true };
      }
      if (method === "tabs.list") return [{ id: 88, url: submitted ? "https://chatgpt.com/c/" + conversationId : "https://chatgpt.com/", title: "Fresh Task - ChatGPT" }];
      if (method === "chat_bridge.inspect") return { conversationId, userEpoch: "fresh-user-1", assistantTurnKey: null, generationActive: true, composerReady: true, composerEmpty: true };
      throw new Error("unexpected method " + method);
    },
  };
  const agentControl = { assertMutationAllowed: (operation) => calls.push({ operation }) };
  const controller = createTelegramChatBridgeController({ browserBridge, agentControl });
  const result = await controller.startTaskChat({ taskId, checkpointRevision: 1 });
  assert.equal(result.confirmed, true);
  assert.equal(result.binding.sourceTaskId, taskId);
  assert.equal(result.binding.conversationId, conversationId);
  assert.equal(result.userEpoch, "fresh-user-1");
  assert.equal(result.previousAssistantTurnKey, null);
  assert.equal(calls.filter((item) => item.method === "click").length, 1);
});

test("Telegram new-Task creation ignores transitional invalid /c routes until a stable conversation id appears", async () => {
  const conversationId = "22334455-6677-8899-aabb-ccddeeff0011";
  let submitted = false;
  let typedText = "";
  let listCount = 0;
  const browserBridge = {
    snapshot: () => ({ contexts: { user: { ready: true, extension: { instanceId: "instance-user-123", capabilityVersions: { chatBridge: 9 } } } } }),
    call: async (method, args) => {
      if (method === "tabs.create") return { id: 488 };
      if (method === "snapshot") {
        if (args.roles?.includes("textbox")) return { refContextValid: true, elements: [{ ref: "@composer", role: "textbox", name: "Prompt" }] };
        if (args.roles?.includes("button")) return { refContextValid: true, elements: [{ ref: "@send", role: "button", name: "Send prompt" }] };
      }
      if (method === "type_text") { typedText = args.text; return { ok: true }; }
      if (method === "eval") {
        if (args.expression.includes("send-button")) return { value: { ready: true, reason: null, name: "Send prompt", text: typedText } };
        return { value: { present: true, text: typedText, generationActive: false } };
      }
      if (method === "click") { submitted = true; return { actionDispatched: true, primaryActionSucceeded: true }; }
      if (method === "tabs.list") {
        listCount += 1;
        const url = !submitted
          ? "https://chatgpt.com/"
          : listCount === 1
            ? "https://chatgpt.com/c/new"
            : "https://chatgpt.com/c/" + conversationId;
        return [{ id: 488, url, title: "Transitioning Task" }];
      }
      if (method === "chat_bridge.inspect") return { conversationId, userEpoch: null, assistantTurnKey: null, generationActive: true, composerReady: true, composerEmpty: true };
      throw new Error("unexpected method " + method);
    },
  };
  const controller = createTelegramChatBridgeController({ browserBridge, agentControl: { assertMutationAllowed() {} } });
  const result = await controller.startTaskChat({ taskId: "task-stableid1", checkpointRevision: 1 });
  assert.equal(result.confirmed, true);
  assert.equal(result.binding.conversationId, conversationId);
  assert.equal(listCount >= 2, true);
});

test("Telegram new-Task binding succeeds even when first-turn identity is not ready yet", async () => {
  const conversationId = "11223344-5566-7788-99aa-bbccddeeff00";
  let submitted = false;
  let typedText = "";
  const browserBridge = {
    snapshot: () => ({ contexts: { user: { ready: true, extension: { instanceId: "instance-user-123", capabilityVersions: { chatBridge: 9 } } } } }),
    call: async (method, args) => {
      if (method === "tabs.create") return { id: 288 };
      if (method === "snapshot") {
        if (args.roles?.includes("textbox")) return { refContextValid: true, elements: [{ ref: "@composer", role: "textbox", name: "Prompt" }] };
        if (args.roles?.includes("button")) return { refContextValid: true, elements: [{ ref: "@send", role: "button", name: "Send prompt" }] };
      }
      if (method === "type_text") { typedText = args.text; return { ok: true }; }
      if (method === "eval") {
        if (args.expression.includes("send-button")) return { value: { ready: true, reason: null, name: "Send prompt", text: typedText } };
        return { value: { present: true, text: typedText, generationActive: false } };
      }
      if (method === "click") { submitted = true; return { actionDispatched: true, primaryActionSucceeded: true }; }
      if (method === "tabs.list") return [{ id: 288, url: submitted ? "https://chatgpt.com/c/" + conversationId : "https://chatgpt.com/", title: "Fresh Task" }];
      if (method === "chat_bridge.inspect") return { conversationId, userEpoch: null, assistantTurnKey: null, generationActive: true, composerReady: true, composerEmpty: true };
      throw new Error("unexpected method " + method);
    },
  };
  const controller = createTelegramChatBridgeController({ browserBridge, agentControl: { assertMutationAllowed() {} } });
  const result = await controller.startTaskChat({ taskId: "task-lateid12", checkpointRevision: 1 });
  assert.equal(result.confirmed, true);
  assert.equal(result.binding.conversationId, conversationId);
  assert.equal(result.userEpoch, null);
});

test("Telegram new-Task creation survives root-composer hydration reset without duplicate submit", async () => {
  const conversationId = "99887766-5544-3322-1100-aabbccddeeff";
  let submitted = false;
  let typedText = "";
  let typeCount = 0;
  let composerInspectCount = 0;
  const browserBridge = {
    snapshot: () => ({ contexts: { user: { ready: true, extension: { instanceId: "instance-user-123", capabilityVersions: { chatBridge: 9 } } } } }),
    call: async (method, args) => {
      if (method === "tabs.create") return { id: 388 };
      if (method === "snapshot") {
        if (args.roles?.includes("textbox")) return { refContextValid: true, elements: [{ ref: typeCount === 0 ? "@first" : "@second", role: "textbox", name: "Prompt" }] };
        if (args.roles?.includes("button")) return { refContextValid: true, elements: [{ ref: "@send3", role: "button", name: "Send prompt" }] };
      }
      if (method === "type_text") { typeCount += 1; typedText = args.text; return { ok: true }; }
      if (method === "eval") {
        if (args.expression.includes("send-button")) return { value: { ready: true, reason: null, name: "Send prompt", text: typedText } };
        composerInspectCount += 1;
        // first pre-check is empty; first post-type check simulates hydration replacing the composer.
        if (composerInspectCount === 2) { typedText = ""; return { value: { present: true, text: "", generationActive: false } }; }
        return { value: { present: true, text: typedText, generationActive: false } };
      }
      if (method === "click") { submitted = true; return { actionDispatched: true, primaryActionSucceeded: true }; }
      if (method === "tabs.list") return [{ id: 388, url: submitted ? "https://chatgpt.com/c/" + conversationId : "https://chatgpt.com/", title: "Hydrated Task" }];
      if (method === "chat_bridge.inspect") return { conversationId, userEpoch: "hydrated-user-1", assistantTurnKey: null, generationActive: true, composerReady: true, composerEmpty: true };
      throw new Error("unexpected method " + method);
    },
  };
  const controller = createTelegramChatBridgeController({ browserBridge, agentControl: { assertMutationAllowed() {} } });
  const result = await controller.startTaskChat({ taskId: "task-hydrate12", checkpointRevision: 1 });
  assert.equal(result.confirmed, true);
  assert.equal(result.binding.conversationId, conversationId);
  assert.equal(typeCount, 2);
  assert.equal(submitted, true);
});

test("Telegram new-Task creation retries a pre-mutation stale composer ref on the same tab", async () => {
  const conversationId = "87654321-4321-4321-4321-cba987654321";
  const calls = [];
  let submitted = false;
  let composerSnapshotCount = 0;
  let typeCount = 0;
  let typedText = "";
  const browserBridge = {
    snapshot: () => ({ contexts: { user: { ready: true, extension: { instanceId: "instance-user-123", capabilityVersions: { chatBridge: 9 } } } } }),
    call: async (method, args, options) => {
      calls.push({ method, args, options });
      if (method === "tabs.create") return { id: 188 };
      if (method === "snapshot") {
        if (args.roles?.includes("textbox")) {
          composerSnapshotCount += 1;
          return { refContextValid: true, elements: [{ ref: composerSnapshotCount === 1 ? "@e1" : "@e2", role: "textbox", name: "Prompt" }] };
        }
        if (args.roles?.includes("button")) return { refContextValid: true, elements: [{ ref: "@send2", role: "button", name: "Send prompt" }] };
      }
      if (method === "type_text") {
        typeCount += 1;
        if (typeCount === 1) throw new Error("No active snapshot refs for this tab. Take a new snapshot first.");
        assert.equal(args.ref, "@e2");
        assert.equal(Object.hasOwn(args, "submit"), false);
        typedText = args.text;
        return { ok: true };
      }
      if (method === "eval") {
        if (args.expression.includes("send-button")) return { value: { ready: true, reason: null, name: "Send prompt", text: typedText } };
        return { value: { present: true, text: typedText, generationActive: false } };
      }
      if (method === "click") {
        assert.equal(args.ref, "@send2");
        submitted = true;
        return { actionDispatched: true, primaryActionSucceeded: true };
      }
      if (method === "tabs.list") return [{ id: 188, url: submitted ? "https://chatgpt.com/c/" + conversationId : "https://chatgpt.com/", title: "Fresh Task - ChatGPT" }];
      if (method === "chat_bridge.inspect") return { conversationId, userEpoch: "fresh-user-2", assistantTurnKey: null, generationActive: true, composerReady: true, composerEmpty: true };
      if (method === "close") throw new Error("close must not run after a successful retry");
      throw new Error("unexpected method " + method);
    },
  };
  const agentControl = { assertMutationAllowed() {} };
  const controller = createTelegramChatBridgeController({ browserBridge, agentControl });
  const result = await controller.startTaskChat({ taskId: "task-retry123", checkpointRevision: 1 });
  assert.equal(result.confirmed, true);
  assert.equal(result.binding.tabId, 188);
  assert.equal(composerSnapshotCount, 2);
  assert.equal(typeCount, 2);
  assert.equal(calls.filter((item) => item.method === "tabs.create").length, 1);
  assert.equal(calls.filter((item) => item.method === "click").length, 1);
});

test("Telegram Chat Bridge v9 reads the first assistant response when there is no previous assistant turn", async () => {
  const directBinding = { ...binding, sourceTaskId: "task-abcdef12" };
  const f = fixture({
    state: { assistantTurnKey: null },
    readResult: { status: "ready", text: "first answer", assistantTurnKey: "assistant-first-1", truncated: false },
  });
  const result = await f.controller.readFinal({
    binding: directBinding,
    userEpoch: "user-epoch-2",
    previousAssistantTurnKey: null,
  });
  assert.equal(result.status, "ready");
  assert.equal(result.text, "first answer");
  const call = f.calls.find((item) => item.method === "chat_bridge.read_final");
  assert.equal(call.args.previousAssistantTurnKey, null);
});
