import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createTelegramTaskInboxController } from "../../src/telegram-task-inbox-controller.js";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eqx-telegram-task-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let now = Date.parse("2026-09-20T16:00:00.000Z");
  const task = {
    taskId: "task-abcdef12",
    title: "Telegram task",
    status: "active",
    checkpointRevision: 1,
    updatedAt: "2026-09-20T16:00:01.000Z",
    humanInput: null,
    continuation: null,
    next: ["Run the next acceptance step."],
  };
  const calls = [];
  const pending = [];
  let nextMessageId = 700;
  let agentPaused = false;
  let chatReadResult = { status: "waiting" };
  let sendMessageError = null;
  let editCardError = null;
  let editCardResult = null;
  let downloadAttachmentError = null;
  const events = [];
  let createdTask = null;
  const boundChats = new Map();
  const baseBinding = {
    browserContext: "user", browserInstanceId: "instance-1", tabId: 77,
    conversationId: "abcdef12-3456-7890-abcd-ef1234567890",
    canonicalUrl: "https://chatgpt.com/c/abcdef12-3456-7890-abcd-ef1234567890",
  };
  const store = {
    list: async () => [structuredClone(task), ...(createdTask ? [structuredClone(createdTask)] : [])],
    readInternal: async (taskId) => {
      if (createdTask?.taskId === taskId) return { ...structuredClone(createdTask), chatBinding: structuredClone(boundChats.get(taskId) || null) };
      return { ...structuredClone(task), chatBinding: structuredClone(boundChats.get(taskId) || baseBinding) };
    },
    checkpoint: async ({ title, objective, completed = [], next = [], references = [] }) => {
      const created = {
        taskId: "task-newtask12", title, objective, status: "active", checkpointRevision: 1,
        updatedAt: new Date(now + 1_000).toISOString(), humanInput: null, continuation: null,
        completed: structuredClone(completed), next: structuredClone(next), references: structuredClone(references),
      };
      createdTask = structuredClone(created);
      calls.push(["checkpoint", structuredClone(created)]);
      return created;
    },
    bindChat: async ({ taskId, binding }) => {
      boundChats.set(taskId, structuredClone(binding));
      calls.push(["bind-chat", taskId, structuredClone(binding)]);
      return { taskId };
    },
    queueHumanInput: async ({ taskId, source, sourceId, text, attachments = [] }) => {
      calls.push(["human-input", taskId, source, sourceId, text, attachments]);
      task.checkpointRevision += 1;
      task.updatedAt = new Date(now + 1_000).toISOString();
      task.humanInput = { inputId: "input-123456", source, text, attachments: structuredClone(attachments), receivedAt: task.updatedAt };
      return structuredClone(task);
    },
    finish: async (taskId) => { calls.push(["finish", taskId]); task.status = "completed"; task.updatedAt = new Date(now + 1_000).toISOString(); return structuredClone(task); },
    cancel: async (taskId) => { calls.push(["cancel", taskId]); task.status = "cancelled"; task.updatedAt = new Date(now + 1_000).toISOString(); return structuredClone(task); },
    remove: async (taskId) => { calls.push(["remove", taskId]); return { taskId, deleted: true, status: "cancelled" }; },
  };
  const autoContinueController = {
    armBound: async ({ taskId, ttlMinutes }) => { calls.push(["arm", taskId, ttlMinutes]); return { taskId, continuation: { status: "armed" } }; },
  };
  const deps = {
    store, autoContinueController,
    statePath: path.join(root, "telegram-task-state.json"),
    getTelegramStatus: async () => ({ ready: true }),
    pollInbound: async () => ({ configured: true, received: 0, pendingCount: pending.length }),
    readPending: async () => pending.map((item) => ({ ...item })),
    acknowledgeUpdate: async (updateId) => { const index = pending.findIndex((item) => item.updateId === updateId); if (index >= 0) pending.splice(index, 1); calls.push(["ack", updateId]); return { acknowledged: index >= 0 }; },
    downloadAttachment: async ({ updateId, attachment }) => {
      calls.push(["download", updateId, attachment.fileId]);
      if (downloadAttachmentError) throw downloadAttachmentError;
      return {
        attachmentId: `tgatt-${String(updateId).padStart(6, "0")}`, kind: attachment.kind, fileName: attachment.fileName,
        mimeType: attachment.mimeType, bytes: attachment.bytes || 5, sha256: "a".repeat(64), storagePath: path.join(root, `tgatt-${updateId}-${attachment.fileName}`),
      };
    },
    sendCard: async ({ text, keyboard }) => { calls.push(["send-card", text, keyboard]); return { sent: true, messageId: ++nextMessageId }; },
    editCard: async ({ messageId, text, keyboard }) => {
      calls.push(["edit-card", messageId, text, keyboard]);
      if (editCardError) throw editCardError;
      return editCardResult ? structuredClone(editCardResult) : { edited: true, messageId };
    },
    answerCallback: async ({ callbackQueryId, text }) => { calls.push(["answer", callbackQueryId, text]); return { answered: true }; },
    sendMessage: async ({ message }) => {
      calls.push(["message", message]);
      if (sendMessageError) throw sendMessageError;
      return { sent: true, messageCount: 1 };
    },
    getRemoteStatus: async () => ({
      version: "5.0.0", health: "healthy", agentPaused, agentBrowserReady: true, userBrowserReady: false,
      activeTasks: 1, waitingTasks: task.humanInput ? 1 : 0, continuingTasks: task.continuation ? 1 : 0,
    }),
    pauseAgent: async () => { calls.push(["pause-agent"]); agentPaused = true; return { paused: true }; },
    resumeAgent: async () => { calls.push(["resume-agent"]); agentPaused = false; return { paused: false }; },
    requestRestart: async () => { calls.push(["restart-request"]); return { scheduled: true }; },
    deliverChatMessage: async ({ binding, deliveryId, text }) => {
      calls.push(["chat-deliver", binding.sourceTaskId, deliveryId, text]);
      return { confirmed: true, duplicatePrevented: false, deliveryId, userEpoch: "bridge-user-2", previousAssistantTurnKey: "assistant-turn-1", tabId: binding.tabId };
    },
    readChatResponse: async ({ binding, userEpoch, previousAssistantTurnKey }) => {
      calls.push(["chat-read", binding.sourceTaskId, userEpoch, previousAssistantTurnKey]);
      if (chatReadResult instanceof Error) throw chatReadResult;
      return structuredClone(chatReadResult);
    },
    inspectChatIdentity: async ({ binding }) => ({
      status: "ready",
      binding: structuredClone(binding),
      userEpoch: "fresh-user-1",
      assistantTurnKey: null,
    }),
    startTaskChat: async ({ taskId, checkpointRevision }) => {
      calls.push(["task-chat-create", taskId, checkpointRevision]);
      return {
        confirmed: true,
        binding: {
          sourceTaskId: taskId,
          browserContext: "user",
          browserInstanceId: "instance-1",
          tabId: 99,
          conversationId: "feedface-3456-7890-abcd-ef1234567890",
          canonicalUrl: "https://chatgpt.com/c/feedface-3456-7890-abcd-ef1234567890",
          title: "Fresh Task chat",
          boundAt: new Date(now).toISOString(),
        },
        userEpoch: "fresh-user-1",
        previousAssistantTurnKey: null,
      };
    },
    now: () => now,
    randomId: () => "route12345",
    setTimeoutImpl: () => ({ unref() {} }),
    clearTimeoutImpl: () => {},
    onEvent: async (event) => { events.push(structuredClone(event)); },
  };
  return {
    root, task, calls, pending, events, deps,
    setNow: (value) => { now = value; },
    setChatReadResult: (value) => { chatReadResult = value; },
    setSendMessageError: (value) => { sendMessageError = value; },
    setEditCardError: (value) => { editCardError = value; },
    setEditCardResult: (value) => { editCardResult = value; },
    setDownloadAttachmentError: (value) => { downloadAttachmentError = value; },
  };
}

test("task sync creates one durable card, edits it on change and survives restart without duplicate send", async (t) => {
  const f = await fixture(t);
  const controller = createTelegramTaskInboxController(f.deps);
  await controller.initialize();
  assert.equal((await controller.syncTasks()).changed, 1);
  const send = f.calls.find((item) => item[0] === "send-card");
  assert.match(send[1], /🟢 Running · Telegram task/u);
  assert.match(send[1], /Next: Run the next acceptance step\./u);
  assert.match(send[1], /Reply to this card to send input to this exact task\./u);
  assert.equal(send[2][0][0].callbackData, "eqx:c:r-route12345");
  assert.equal(send[2][0][1].callbackData, "eqx:f:r-route12345");
  assert.equal(send[2].length, 3);
  assert.equal(send[2][1][0].callbackData, "eqx:x:r-route12345");
  assert.equal(send[2][1][1].callbackData, "eqx:b:r-route12345");
  assert.equal(send[2][2][0].url, "https://chatgpt.com/c/abcdef12-3456-7890-abcd-ef1234567890");
  assert.equal((await controller.syncTasks()).changed, 0);

  f.task.checkpointRevision = 2;
  f.task.updatedAt = "2026-09-20T16:00:03.000Z";
  assert.equal((await controller.syncTasks()).changed, 1);
  assert.equal(f.calls.filter((item) => item[0] === "edit-card").length, 1);

  f.task.status = "completed";
  f.task.updatedAt = "2026-09-20T16:00:04.000Z";
  assert.equal((await controller.syncTasks()).changed, 1);
  const terminalEdit = f.calls.findLast((item) => item[0] === "edit-card");
  assert.match(terminalEdit[2], /✅ Completed/u);
  assert.match(terminalEdit[2], /Finished 2026-09-20T16:00:04\.000Z/u);
  const terminalCallbacks = terminalEdit[3].flat().map((button) => button.callbackData).filter(Boolean);
  assert.deepEqual(terminalCallbacks, []);

  const restarted = createTelegramTaskInboxController(f.deps);
  await restarted.initialize();
  assert.equal((await restarted.syncTasks()).changed, 0);
  assert.equal(f.calls.filter((item) => item[0] === "send-card").length, 1);
});

test("active task sync reconciles Telegram message-not-modified without retry spam", async (t) => {
  const f = await fixture(t);
  const controller = createTelegramTaskInboxController(f.deps);
  await controller.initialize();
  assert.equal((await controller.syncTasks()).changed, 1);

  f.task.checkpointRevision = 2;
  f.task.updatedAt = "2026-09-20T16:00:03.000Z";
  f.setEditCardResult({ edited: false, unchanged: true, messageId: 701 });
  assert.equal((await controller.syncTasks()).changed, 1);
  assert.equal((await controller.syncTasks()).changed, 0);
  assert.equal(f.calls.filter((item) => item[0] === "edit-card").length, 1);
  const recovered = f.events.find((event) => event.type === "telegram.task_sync_recovered");
  assert.ok(recovered);
  assert.equal(recovered.status, "recovered");
  assert.equal(recovered.details.reason, "message_not_modified");
  assert.equal(f.events.some((event) => event.type === "telegram.task_sync_failed"), false);
});

test("terminal task mapping retires after Telegram 400 instead of retrying forever", async (t) => {
  const f = await fixture(t);
  const controller = createTelegramTaskInboxController(f.deps);
  await controller.initialize();
  assert.equal((await controller.syncTasks()).changed, 1);
  f.task.status = "cancelled";
  f.task.updatedAt = "2026-09-20T16:00:04.000Z";
  const error = new Error("Telegram rejected the request: Bad Request: message to edit not found");
  error.telegramStatus = 400;
  f.setEditCardError(error);
  assert.equal((await controller.syncTasks()).changed, 1);
  const state = JSON.parse(await fs.readFile(f.deps.statePath, "utf8"));
  const mapping = state.mappings.find((item) => item.taskId === "task-abcdef12");
  assert.ok(mapping?.retiredAt);
  assert.equal((await controller.syncTasks()).changed, 0);
  f.pending.push({ updateId: 777, kind: "callback", callbackQueryId: "retired", messageId: 701, data: "eqx:b:r-route12345", receivedAt: "2026-09-20T16:00:05.000Z" });
  await controller.processPending();
  assert.equal(f.calls.some((item) => item[0] === "answer" && item[1] === "retired" && /no longer valid/u.test(item[2])), true);
});

test("reply to a mapped task card writes bounded human input, arms bound continuation and acknowledges once", async (t) => {
  const f = await fixture(t);
  const controller = createTelegramTaskInboxController(f.deps);
  await controller.initialize();
  await controller.syncTasks();
  f.pending.push({ updateId: 88, kind: "message", messageId: 900, replyToMessageId: 701, text: "Check the browser first.", receivedAt: "2026-09-20T16:00:05.000Z" });
  const result = await controller.processPending();
  assert.equal(result.handled, 1);
  assert.deepEqual(f.calls.find((item) => item[0] === "human-input"), ["human-input", "task-abcdef12", "telegram", "telegram:88", "Check the browser first.", []]);
  assert.deepEqual(f.calls.find((item) => item[0] === "arm"), ["arm", "task-abcdef12", 15]);
  assert.equal(f.pending.length, 0);

  const state = JSON.parse(await fs.readFile(f.deps.statePath, "utf8"));
  assert.equal(state.actions.find((item) => item.updateId === 88).status, "done");
});

test("private slash commands return bounded status, tasks and help without becoming task input", async (t) => {
  const f = await fixture(t);
  const controller = createTelegramTaskInboxController(f.deps);
  await controller.initialize();

  f.pending.push({ updateId: 80, kind: "message", messageId: 880, replyToMessageId: null, text: "/status", attachment: null, receivedAt: "2026-09-20T16:00:02.000Z" });
  f.pending.push({ updateId: 81, kind: "message", messageId: 881, replyToMessageId: null, text: "/tasks", attachment: null, receivedAt: "2026-09-20T16:00:03.000Z" });
  f.pending.push({ updateId: 82, kind: "message", messageId: 882, replyToMessageId: null, text: "/wat", attachment: null, receivedAt: "2026-09-20T16:00:04.000Z" });

  const result = await controller.processPending();
  assert.equal(result.handled, 3);
  const statusCard = f.calls.find((item) => item[0] === "send-card");
  assert.match(statusCard[1], /🖥 Equinox Local v5\.0\.0/u);
  assert.match(statusCard[1], /Agent: 🟢 Running/u);
  assert.match(statusCard[1], /Agent Browser: 🟢 Ready/u);
  assert.match(statusCard[1], /Your Browser: ⚪ Not connected/u);
  assert.match(statusCard[1], /📋 Tasks\nActive: 1\nWaiting for you: 0\nContinuing: 0/u);
  assert.doesNotMatch(statusCard[1], /Unknown/u);
  assert.equal(statusCard[2][0][0].callbackData, "eqx:p:g-route12345");
  assert.equal(statusCard[2][0][1].callbackData, "eqx:r:g-route12345");
  const taskPickerCard = f.calls.find((item, index) => item[0] === "send-card" && index > f.calls.indexOf(statusCard));
  assert.ok(taskPickerCard);
  assert.match(taskPickerCard[1], /📋 Active tasks/u);
  assert.match(taskPickerCard[1], /task-abcdef12/u);
  assert.match(taskPickerCard[1], /Choose a Task to open its controls, or create a new Task/u);
  assert.match(taskPickerCard[2][0][0].callbackData, /^eqx:q:/u);
  assert.match(taskPickerCard[2].at(-1)[0].callbackData, /^eqx:a:/u);
  const messages = f.calls.filter((item) => item[0] === "message").map((item) => item[1]);
  assert.match(messages.at(-1), /\/status — runtime/u);
  assert.equal(f.calls.some((item) => item[0] === "human-input"), false);
  assert.equal(f.pending.length, 0);

  const state = JSON.parse(await fs.readFile(f.deps.statePath, "utf8"));
  assert.equal(state.actions.filter((item) => item.kind.startsWith("command:")).length, 3);
  assert.equal(state.actions.every((item) => item.status === "done"), true);
});

test("task card can bind Chat Bridge, normal text routes there, and /unbind stops routing", async (t) => {
  const f = await fixture(t);
  const controller = createTelegramTaskInboxController(f.deps);
  await controller.initialize();
  await controller.syncTasks();

  f.pending.push({ updateId: 84, kind: "callback", callbackQueryId: "cb-bind", messageId: 701, data: "eqx:b:r-route12345", receivedAt: "2026-09-20T16:00:05.000Z" });
  await controller.processPending();
  assert.deepEqual(f.calls.find((item) => item[0] === "answer" && item[1] === "cb-bind"), ["answer", "cb-bind", "Chat bridge bound."]);
  let persisted = JSON.parse(await fs.readFile(f.deps.statePath, "utf8"));
  assert.equal(persisted.chatBridge.sourceTaskId, "task-abcdef12");
  assert.equal(persisted.chatBridge.conversationId, "abcdef12-3456-7890-abcd-ef1234567890");

  f.pending.push({ updateId: 85, kind: "message", messageId: 885, replyToMessageId: null, text: "hello from telegram", attachment: null, receivedAt: "2026-09-20T16:00:06.000Z" });
  await controller.processPending();
  assert.deepEqual(f.calls.find((item) => item[0] === "chat-deliver"), ["chat-deliver", "task-abcdef12", "tgb-u00002d", "hello from telegram [task_id=task-abcdef12]"]);
  persisted = JSON.parse(await fs.readFile(f.deps.statePath, "utf8"));
  assert.equal(persisted.chatBridgeTurn.status, "waiting");
  assert.equal(persisted.chatBridgeTurn.userEpoch, "bridge-user-2");
  assert.equal(persisted.chatBridgeTurn.previousAssistantTurnKey, "assistant-turn-1");

  f.pending.push({ updateId: 86, kind: "message", messageId: 886, replyToMessageId: null, text: "/chat", attachment: null, receivedAt: "2026-09-20T16:00:07.000Z" });
  f.pending.push({ updateId: 87, kind: "message", messageId: 887, replyToMessageId: null, text: "/unbind", attachment: null, receivedAt: "2026-09-20T16:00:08.000Z" });
  await controller.processPending();
  const chatCard = f.calls.findLast((item) => item[0] === "send-card");
  assert.match(chatCard[1], /Bound to: Telegram task/u);
  assert.match(chatCard[1], /waiting for ChatGPT final answer/u);
  assert.equal(chatCard[2][0][0].text, "↗ Open in ChatGPT");
  assert.equal(chatCard[2][1][0].text, "🔌 Unbind");
  assert.match(chatCard[2][1][0].callbackData, /^eqx:d:/u);
  const messages = f.calls.filter((item) => item[0] === "message").map((item) => item[1]);
  assert.ok(messages.some((message) => /unbound from Telegram task/u.test(message)));
  persisted = JSON.parse(await fs.readFile(f.deps.statePath, "utf8"));
  assert.equal(persisted.chatBridge, null);
  assert.equal(persisted.chatBridgeTurn, null);

  f.pending.push({ updateId: 88, kind: "message", messageId: 888, replyToMessageId: null, text: "should not open a chat", attachment: null, receivedAt: "2026-09-20T16:00:09.000Z" });
  await controller.processPending();
  assert.equal(f.calls.filter((item) => item[0] === "chat-deliver").length, 1);
  assert.match(f.calls.findLast((item) => item[0] === "message")[1], /No Task chat is selected/u);
  persisted = JSON.parse(await fs.readFile(f.deps.statePath, "utf8"));
  assert.equal(persisted.chatBridge, null);
  assert.equal(persisted.taskCreation, null);
});

test("Chat Bridge forwards one final assistant response exactly once and then accepts a new turn", async (t) => {
  const f = await fixture(t);
  const controller = createTelegramTaskInboxController(f.deps);
  await controller.initialize();
  await controller.syncTasks();
  f.pending.push({ updateId: 120, kind: "callback", callbackQueryId: "cb-bind-final", messageId: 701, data: "eqx:b:r-route12345", receivedAt: "2026-09-20T16:00:05.000Z" });
  await controller.processPending();
  f.pending.push({ updateId: 121, kind: "message", messageId: 921, replyToMessageId: null, text: "bridge question", attachment: null, receivedAt: "2026-09-20T16:00:06.000Z" });
  await controller.processPending();

  f.setChatReadResult({ status: "ready", text: "final assistant answer", assistantTurnKey: "assistant-turn-2", truncated: false });
  assert.deepEqual(await controller.processChatBridgeResponse(), { status: "sent" });
  assert.deepEqual(await controller.processChatBridgeResponse(), { status: "idle" });
  assert.equal(f.calls.filter((item) => item[0] === "message" && item[1] === "final assistant answer").length, 1);
  assert.equal(f.calls.filter((item) => item[0] === "chat-read").length, 1);
  const state = JSON.parse(await fs.readFile(f.deps.statePath, "utf8"));
  assert.equal(state.chatBridgeTurn, null);
});

test("Chat Bridge blocks a second normal message while the previous response is pending", async (t) => {
  const f = await fixture(t);
  const controller = createTelegramTaskInboxController(f.deps);
  await controller.initialize();
  await controller.syncTasks();
  f.pending.push({ updateId: 130, kind: "callback", callbackQueryId: "cb-bind-pending", messageId: 701, data: "eqx:b:r-route12345", receivedAt: "2026-09-20T16:00:05.000Z" });
  await controller.processPending();
  f.pending.push({ updateId: 131, kind: "message", messageId: 931, replyToMessageId: null, text: "first", attachment: null, receivedAt: "2026-09-20T16:00:06.000Z" });
  await controller.processPending();
  f.pending.push({ updateId: 132, kind: "message", messageId: 932, replyToMessageId: null, text: "second", attachment: null, receivedAt: "2026-09-20T16:00:07.000Z" });
  await controller.processPending();
  assert.equal(f.calls.filter((item) => item[0] === "chat-deliver").length, 1);
  assert.match(f.calls.findLast((item) => item[0] === "message")[1], /previous Chat Bridge turn is still waiting/u);
});

test("Telegram response send uncertainty becomes terminal ambiguous and is never retried", async (t) => {
  const f = await fixture(t);
  const controller = createTelegramTaskInboxController(f.deps);
  await controller.initialize();
  await controller.syncTasks();
  f.pending.push({ updateId: 140, kind: "callback", callbackQueryId: "cb-bind-send", messageId: 701, data: "eqx:b:r-route12345", receivedAt: "2026-09-20T16:00:05.000Z" });
  await controller.processPending();
  f.pending.push({ updateId: 141, kind: "message", messageId: 941, replyToMessageId: null, text: "question", attachment: null, receivedAt: "2026-09-20T16:00:06.000Z" });
  await controller.processPending();
  f.setChatReadResult({ status: "ready", text: "maybe delivered", assistantTurnKey: "assistant-turn-2", truncated: false });
  f.setSendMessageError(new Error("network timeout after request"));
  assert.deepEqual(await controller.processChatBridgeResponse(), { status: "ambiguous" });
  f.setSendMessageError(null);
  assert.deepEqual(await controller.processChatBridgeResponse(), { status: "ambiguous" });
  assert.equal(f.calls.filter((item) => item[0] === "message" && item[1] === "maybe delivered").length, 1);
  assert.equal(f.calls.filter((item) => item[0] === "chat-read").length, 1);
  const state = JSON.parse(await fs.readFile(f.deps.statePath, "utf8"));
  assert.equal(state.chatBridgeTurn.status, "ambiguous");
  assert.match(state.chatBridgeTurn.reason, /telegram_send_ambiguous/u);
});

test("restart converts a persisted sending response into ambiguous without browser or Telegram replay", async (t) => {
  const f = await fixture(t);
  const controller = createTelegramTaskInboxController(f.deps);
  await controller.initialize();
  await controller.syncTasks();
  f.pending.push({ updateId: 150, kind: "callback", callbackQueryId: "cb-bind-restart", messageId: 701, data: "eqx:b:r-route12345", receivedAt: "2026-09-20T16:00:05.000Z" });
  await controller.processPending();
  f.pending.push({ updateId: 151, kind: "message", messageId: 951, replyToMessageId: null, text: "question", attachment: null, receivedAt: "2026-09-20T16:00:06.000Z" });
  await controller.processPending();
  const raw = JSON.parse(await fs.readFile(f.deps.statePath, "utf8"));
  raw.chatBridgeTurn.status = "sending";
  raw.chatBridgeTurn.assistantTurnKey = "assistant-turn-2";
  raw.chatBridgeTurn.updatedAt = "2026-09-20T16:00:07.000Z";
  await fs.writeFile(f.deps.statePath, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  const beforeMessages = f.calls.filter((item) => item[0] === "message").length;
  const beforeReads = f.calls.filter((item) => item[0] === "chat-read").length;
  const restarted = createTelegramTaskInboxController(f.deps);
  await restarted.initialize();
  assert.deepEqual(await restarted.processChatBridgeResponse(), { status: "ambiguous" });
  assert.equal(f.calls.filter((item) => item[0] === "message").length, beforeMessages);
  assert.equal(f.calls.filter((item) => item[0] === "chat-read").length, beforeReads);
  const state = JSON.parse(await fs.readFile(f.deps.statePath, "utf8"));
  assert.equal(state.chatBridgeTurn.status, "ambiguous");
  assert.equal(state.chatBridgeTurn.reason, "runtime_restart_during_response_send");
});

test("unbound attachment does not download or create a chat and requires Task selection", async (t) => {
  const f = await fixture(t);
  const controller = createTelegramTaskInboxController(f.deps);
  await controller.initialize();
  f.pending.push({ updateId: 93, kind: "message", messageId: 893, replyToMessageId: null, text: "look", attachment: { fileId: "doc-93", kind: "document", fileName: "x.pdf", mimeType: "application/pdf", bytes: 3 }, receivedAt: "2026-09-20T16:00:06.000Z" });
  await controller.processPending();
  assert.equal(f.calls.some((item) => item[0] === "download" && item[1] === 93), false);
  assert.equal(f.calls.some((item) => item[0] === "chat-deliver"), false);
  assert.match(f.calls.findLast((item) => item[0] === "message")[1], /No Task chat is selected/u);
  const state = JSON.parse(await fs.readFile(f.deps.statePath, "utf8"));
  assert.equal(state.taskCreation, null);
  assert.equal(state.chatBridge, null);
});

test("bridge attachment downloads once, uses the exact bound chat and enters the normal response state", async (t) => {
  const f = await fixture(t);
  const controller = createTelegramTaskInboxController(f.deps);
  await controller.initialize();
  await controller.syncTasks();
  f.pending.push({ updateId: 94, kind: "callback", callbackQueryId: "cb-bind-attachment", messageId: 701, data: "eqx:b:r-route12345", receivedAt: "2026-09-20T16:00:05.000Z" });
  await controller.processPending();
  f.pending.push({ updateId: 95, kind: "message", messageId: 895, replyToMessageId: null, text: "look", attachment: { fileId: "doc-95", kind: "document", fileName: "x.pdf", mimeType: "application/pdf", bytes: 3 }, receivedAt: "2026-09-20T16:00:06.000Z" });
  await controller.processPending();
  assert.equal(f.calls.some((item) => item[0] === "download" && item[1] === 95), true);
  const delivery = f.calls.find((item) => item[0] === "chat-deliver" && item[2] === "tgb-u00002n");
  assert.ok(delivery);
  assert.match(delivery[3], /^look/u);
  assert.match(delivery[3], /task_id=task-abcdef12/u);
  assert.match(delivery[3], /local_file="/u);
  assert.equal(delivery[3].includes(path.join(f.root, "tgatt-95-x.pdf")), true);
  assert.equal(delivery[3].includes("attachment_id="), false);
  assert.equal(delivery[3].includes("mime_type="), false);
  assert.equal(delivery[3].includes("bytes="), false);
  assert.equal(delivery[3].includes("telegram_chat_attachment_resolve"), false);
  assert.equal(delivery[3].includes("image_view"), false);
  assert.equal(delivery[3].includes("file_export"), false);
  assert.equal(delivery[3].includes("\n"), false);
  let state = JSON.parse(await fs.readFile(f.deps.statePath, "utf8"));
  assert.equal(state.chatBridgeTurn.status, "waiting");
  assert.equal(state.chatBridgeTurn.sourceUpdateId, 95);
  assert.equal(state.chatBridgeAttachment.status, "active");
  assert.equal(state.chatBridgeAttachment.attachment.attachmentId, "tgatt-000095");
  assert.equal(state.chatBridge.tabId, 77);
  assert.equal(state.chatBridgeTurn.binding.tabId, 77);
  f.setChatReadResult({ status: "ready", text: "attachment handled", assistantTurnKey: "assistant-turn-2", truncated: false });
  assert.deepEqual(await controller.processChatBridgeResponse(), { status: "sent" });
  state = JSON.parse(await fs.readFile(f.deps.statePath, "utf8"));
  assert.equal(state.chatBridgeAttachment, null);
});

test("bridge attachment download failure leaves the Telegram update pending and reserves no browser mutation", async (t) => {
  const f = await fixture(t);
  const controller = createTelegramTaskInboxController(f.deps);
  await controller.initialize();
  await controller.syncTasks();
  f.pending.push({ updateId: 96, kind: "callback", callbackQueryId: "cb-bind-attachment-fail", messageId: 701, data: "eqx:b:r-route12345", receivedAt: "2026-09-20T16:00:05.000Z" });
  await controller.processPending();
  f.setDownloadAttachmentError(new Error("download failed"));
  f.pending.push({ updateId: 97, kind: "message", messageId: 897, replyToMessageId: null, text: "look", attachment: { fileId: "doc-97", kind: "document", fileName: "x.pdf", mimeType: "application/pdf", bytes: 3 }, receivedAt: "2026-09-20T16:00:06.000Z" });
  await assert.rejects(() => controller.processPending(), /download failed/u);
  assert.equal(f.pending.some((item) => item.updateId === 97), true);
  assert.equal(f.calls.some((item) => item[0] === "chat-deliver" && item[2] === "tgb-u00002p"), false);
  const state = JSON.parse(await fs.readFile(f.deps.statePath, "utf8"));
  assert.equal(state.actions.some((item) => item.updateId === 97), false);
});

test("recognized slash commands take precedence over mapped task replies", async (t) => {
  const f = await fixture(t);
  const controller = createTelegramTaskInboxController(f.deps);
  await controller.initialize();
  await controller.syncTasks();
  f.pending.push({ updateId: 83, kind: "message", messageId: 883, replyToMessageId: 701, text: "/status", attachment: null, receivedAt: "2026-09-20T16:00:05.000Z" });
  await controller.processPending();
  assert.equal(f.calls.some((item) => item[0] === "human-input"), false);
  assert.match(f.calls.findLast((item) => item[0] === "send-card")[1], /Equinox Local v5\.0\.0/u);
});

test("status controls require confirmation before Emergency Stop and then expose Resume", async (t) => {
  const f = await fixture(t);
  const controller = createTelegramTaskInboxController(f.deps);
  await controller.initialize();
  f.pending.push({ updateId: 100, kind: "message", messageId: 900, replyToMessageId: null, text: "/status", attachment: null, receivedAt: "2026-09-20T16:00:02.000Z" });
  await controller.processPending();

  f.pending.push({ updateId: 101, kind: "callback", callbackQueryId: "cb-pause", messageId: 701, data: "eqx:p:g-route12345", receivedAt: "2026-09-20T16:00:03.000Z" });
  await controller.processPending();
  assert.equal(f.calls.some((item) => item[0] === "pause-agent"), false);
  const confirmEdit = f.calls.findLast((item) => item[0] === "edit-card");
  assert.match(confirmEdit[2], /Confirm Emergency Stop/u);
  assert.equal(confirmEdit[3][0][0].callbackData, "eqx:e:g-route12345");
  assert.equal(confirmEdit[3][0][1].callbackData, "eqx:n:g-route12345");

  f.pending.push({ updateId: 102, kind: "callback", callbackQueryId: "cb-confirm-pause", messageId: 701, data: "eqx:e:g-route12345", receivedAt: "2026-09-20T16:00:04.000Z" });
  await controller.processPending();
  assert.deepEqual(f.calls.find((item) => item[0] === "pause-agent"), ["pause-agent"]);
  const pausedEdit = f.calls.findLast((item) => item[0] === "edit-card");
  assert.equal(pausedEdit[3][0][0].callbackData, "eqx:u:g-route12345");

  f.pending.push({ updateId: 103, kind: "callback", callbackQueryId: "cb-resume", messageId: 701, data: "eqx:u:g-route12345", receivedAt: "2026-09-20T16:00:05.000Z" });
  await controller.processPending();
  assert.deepEqual(f.calls.find((item) => item[0] === "resume-agent"), ["resume-agent"]);
  assert.equal(f.calls.findLast((item) => item[0] === "edit-card")[3][0][0].callbackData, "eqx:p:g-route12345");
});

test("restart control uses two-step confirmation and only requests restart after confirm", async (t) => {
  const f = await fixture(t);
  const controller = createTelegramTaskInboxController(f.deps);
  await controller.initialize();
  f.pending.push({ updateId: 110, kind: "message", messageId: 910, replyToMessageId: null, text: "/status", attachment: null, receivedAt: "2026-09-20T16:00:02.000Z" });
  await controller.processPending();

  f.pending.push({ updateId: 111, kind: "callback", callbackQueryId: "cb-restart", messageId: 701, data: "eqx:r:g-route12345", receivedAt: "2026-09-20T16:00:03.000Z" });
  await controller.processPending();
  assert.equal(f.calls.some((item) => item[0] === "restart-request"), false);
  assert.match(f.calls.findLast((item) => item[0] === "edit-card")[2], /Confirm Equinox Local restart/u);

  f.pending.push({ updateId: 112, kind: "callback", callbackQueryId: "cb-confirm-restart", messageId: 701, data: "eqx:t:g-route12345", receivedAt: "2026-09-20T16:00:04.000Z" });
  await controller.processPending();
  assert.deepEqual(f.calls.find((item) => item[0] === "restart-request"), ["restart-request"]);
  assert.match(f.calls.findLast((item) => item[0] === "edit-card")[2], /restart requested/u);
});

test("a confirmation callback cannot confirm a different pending control action", async (t) => {
  const f = await fixture(t);
  const controller = createTelegramTaskInboxController(f.deps);
  await controller.initialize();
  f.pending.push({ updateId: 115, kind: "message", messageId: 915, replyToMessageId: null, text: "/status", attachment: null, receivedAt: "2026-09-20T16:00:02.000Z" });
  await controller.processPending();
  f.pending.push({ updateId: 116, kind: "callback", callbackQueryId: "cb-pause-mismatch", messageId: 701, data: "eqx:p:g-route12345", receivedAt: "2026-09-20T16:00:03.000Z" });
  await controller.processPending();
  f.pending.push({ updateId: 117, kind: "callback", callbackQueryId: "cb-wrong-confirm", messageId: 701, data: "eqx:t:g-route12345", receivedAt: "2026-09-20T16:00:04.000Z" });
  await controller.processPending();
  assert.equal(f.calls.some((item) => item[0] === "pause-agent"), false);
  assert.equal(f.calls.some((item) => item[0] === "restart-request"), false);
  assert.deepEqual(f.calls.find((item) => item[0] === "answer" && item[1] === "cb-wrong-confirm"), ["answer", "cb-wrong-confirm", "Confirmation expired. Try again."]);
});

test("expired control confirmation fails closed without invoking the mutation", async (t) => {
  const f = await fixture(t);
  const controller = createTelegramTaskInboxController(f.deps);
  await controller.initialize();
  f.pending.push({ updateId: 120, kind: "message", messageId: 920, replyToMessageId: null, text: "/status", attachment: null, receivedAt: "2026-09-20T16:00:02.000Z" });
  await controller.processPending();
  f.pending.push({ updateId: 121, kind: "callback", callbackQueryId: "cb-pause-exp", messageId: 701, data: "eqx:p:g-route12345", receivedAt: "2026-09-20T16:00:03.000Z" });
  await controller.processPending();
  f.setNow(Date.parse("2026-09-20T16:01:00.000Z"));
  f.pending.push({ updateId: 122, kind: "callback", callbackQueryId: "cb-confirm-exp", messageId: 701, data: "eqx:e:g-route12345", receivedAt: "2026-09-20T16:01:00.000Z" });
  await controller.processPending();
  assert.equal(f.calls.some((item) => item[0] === "pause-agent"), false);
  assert.deepEqual(f.calls.find((item) => item[0] === "answer" && item[1] === "cb-confirm-exp"), ["answer", "cb-confirm-exp", "Confirmation expired. Try again."]);
});

test("mapped attachment reply downloads first, queues task-scoped attachment metadata and arms continuation", async (t) => {
  const f = await fixture(t);
  const controller = createTelegramTaskInboxController(f.deps);
  await controller.initialize();
  await controller.syncTasks();
  f.pending.push({
    updateId: 89, kind: "message", messageId: 901, replyToMessageId: 701, text: "Inspect this",
    attachment: { fileId: "doc-89", kind: "document", fileName: "report.pdf", mimeType: "application/pdf", bytes: 5 },
    receivedAt: "2026-09-20T16:00:05.000Z",
  });
  const result = await controller.processPending();
  assert.equal(result.handled, 1);
  assert.deepEqual(f.calls.find((item) => item[0] === "download"), ["download", 89, "doc-89"]);
  const human = f.calls.find((item) => item[0] === "human-input");
  assert.equal(human[4], "Inspect this");
  assert.equal(human[5].length, 1);
  assert.equal(human[5][0].attachmentId, "tgatt-000089");
  assert.equal(human[5][0].fileName, "report.pdf");
  assert.equal(f.pending.length, 0);
  assert.deepEqual(f.calls.find((item) => item[0] === "arm"), ["arm", "task-abcdef12", 15]);
});

test("attachment download failure keeps the Telegram update pending and reserves no task mutation", async (t) => {
  const f = await fixture(t);
  f.deps.downloadAttachment = async () => { throw new Error("download failed"); };
  const controller = createTelegramTaskInboxController(f.deps);
  await controller.initialize();
  await controller.syncTasks();
  f.pending.push({
    updateId: 92, kind: "message", messageId: 902, replyToMessageId: 701, text: null,
    attachment: { fileId: "doc-92", kind: "document", fileName: "retry.pdf", mimeType: "application/pdf", bytes: 5 },
    receivedAt: "2026-09-20T16:00:08.000Z",
  });
  await assert.rejects(() => controller.processPending(), /download failed/u);
  assert.equal(f.pending.length, 1);
  assert.equal(f.calls.some((item) => item[0] === "human-input"), false);
  const persisted = JSON.parse(await fs.readFile(f.deps.statePath, "utf8"));
  assert.equal(persisted.actions.some((item) => item.updateId === 92), false);
});

test("inline callback requires both mapped route and exact mapped Telegram message", async (t) => {
  const f = await fixture(t);
  const controller = createTelegramTaskInboxController(f.deps);
  await controller.initialize();
  await controller.syncTasks();
  const state = JSON.parse(await fs.readFile(f.deps.statePath, "utf8"));
  const routeId = state.mappings[0].routeId;

  f.pending.push({ updateId: 90, kind: "callback", callbackQueryId: "cb-wrong", messageId: 999, data: `eqx:x:${routeId}`, receivedAt: "2026-09-20T16:00:06.000Z" });
  await controller.processPending();
  assert.equal(f.calls.some((item) => item[0] === "cancel"), false);

  f.pending.push({ updateId: 91, kind: "callback", callbackQueryId: "cb-right", messageId: 701, data: `eqx:x:${routeId}`, receivedAt: "2026-09-20T16:00:07.000Z" });
  await controller.processPending();
  assert.deepEqual(f.calls.find((item) => item[0] === "cancel"), ["cancel", "task-abcdef12"]);
  assert.deepEqual(f.calls.find((item) => item[0] === "answer" && item[1] === "cb-right"), ["answer", "cb-right", "Task cancelled."]);
});

test("task complete callback requires the mapped message and finishes the exact task", async (t) => {
  const f = await fixture(t);
  const controller = createTelegramTaskInboxController(f.deps);
  await controller.initialize();
  await controller.syncTasks();
  const state = JSON.parse(await fs.readFile(f.deps.statePath, "utf8"));
  const routeId = state.mappings[0].routeId;

  f.pending.push({ updateId: 93, kind: "callback", callbackQueryId: "cb-finish", messageId: 701, data: `eqx:f:${routeId}`, receivedAt: "2026-09-20T16:00:08.000Z" });
  await controller.processPending();
  assert.deepEqual(f.calls.find((item) => item[0] === "finish"), ["finish", "task-abcdef12"]);
  assert.deepEqual(f.calls.find((item) => item[0] === "answer" && item[1] === "cb-finish"), ["answer", "cb-finish", "Task marked complete."]);
});

test("restart retires a processing Telegram mutation as ambiguous and never replays it", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.dirname(f.deps.statePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(f.deps.statePath, `${JSON.stringify({
    version: 1,
    activatedAt: "2026-09-20T15:59:00.000Z",
    mappings: [{ routeId: "route-old", taskId: "task-abcdef12", messageId: 701, displayKey: "x", syncedAt: "2026-09-20T16:00:00.000Z" }],
    actions: [{ updateId: 99, status: "processing", kind: "cancel", taskId: "task-abcdef12", startedAt: "2026-09-20T16:00:01.000Z", completedAt: null, reason: null }],
  }, null, 2)}\n`, { mode: 0o600 });
  f.pending.push({ updateId: 99, kind: "callback", callbackQueryId: "cb-restart", messageId: 701, data: "eqx:x:route-old", receivedAt: "2026-09-20T16:00:02.000Z" });
  const controller = createTelegramTaskInboxController(f.deps);
  await controller.initialize();
  assert.equal(controller.snapshot().ambiguousActions, 1);
  await controller.processPending();
  assert.equal(f.calls.some((item) => item[0] === "cancel"), false);
  assert.equal(f.pending.length, 0);
});

test("/tasks New task creates a Task Capsule, opens one root chat, binds it and forwards the first response", async (t) => {
  const f = await fixture(t);
  const controller = createTelegramTaskInboxController(f.deps);
  await controller.initialize();

  f.pending.push({ updateId: 160, kind: "message", messageId: 960, replyToMessageId: null, text: "/tasks", attachment: null, receivedAt: "2026-09-20T16:00:10.000Z" });
  await controller.processPending();
  const picker = f.calls.findLast((item) => item[0] === "send-card");
  assert.ok(picker);
  const newTaskButton = picker[2].at(-1)[0];
  assert.match(newTaskButton.callbackData, /^eqx:a:/u);

  f.pending.push({ updateId: 161, kind: "callback", callbackQueryId: "cb-new-task", messageId: 701, data: newTaskButton.callbackData, receivedAt: "2026-09-20T16:00:11.000Z" });
  await controller.processPending();
  let state = JSON.parse(await fs.readFile(f.deps.statePath, "utf8"));
  assert.equal(state.taskCreation.status, "awaiting_input");
  assert.match(f.calls.findLast((item) => item[0] === "edit-card")[2], /Send your next Telegram text message describing the task/u);

  f.pending.push({ updateId: 162, kind: "message", messageId: 962, replyToMessageId: null, text: "Yeni görev açıklaması", attachment: null, receivedAt: "2026-09-20T16:00:12.000Z" });
  await controller.processPending();
  assert.equal(f.calls.some((item) => item[0] === "checkpoint" && item[1].taskId === "task-newtask12"), true);
  assert.deepEqual(f.calls.find((item) => item[0] === "task-chat-create"), ["task-chat-create", "task-newtask12", 1]);
  assert.equal(f.calls.some((item) => item[0] === "bind-chat" && item[1] === "task-newtask12"), true);

  state = JSON.parse(await fs.readFile(f.deps.statePath, "utf8"));
  assert.equal(state.taskCreation, null);
  assert.equal(state.chatBridge.sourceTaskId, "task-newtask12");
  assert.equal(state.chatBridgeTurn.status, "waiting");
  assert.equal(state.chatBridgeTurn.userEpoch, "fresh-user-1");
  assert.equal(state.chatBridgeTurn.previousAssistantTurnKey, null);
  const newTaskCard = f.calls.findLast((item) => item[0] === "send-card" && /task-newtask12/u.test(item[1]));
  assert.ok(newTaskCard);
  const flatButtons = newTaskCard[2].flat();
  assert.equal(flatButtons.some((button) => button.text === "💬 Use for chat"), false);
  const cardUnbind = flatButtons.find((button) => button.text === "🔌 Unbind");
  assert.ok(cardUnbind);
  assert.match(cardUnbind.callbackData, /^eqx:d:/u);

  f.setChatReadResult({ status: "ready", text: "ilk görev cevabı", assistantTurnKey: "assistant-fresh-1", truncated: false });
  assert.deepEqual(await controller.processChatBridgeResponse(), { status: "sent" });
  assert.equal(f.calls.filter((item) => item[0] === "message" && item[1] === "ilk görev cevabı").length, 1);
  assert.deepEqual(f.calls.find((item) => item[0] === "chat-read"), ["chat-read", "task-newtask12", "fresh-user-1", null]);
});

test("current bound task card exposes Unbind and clears only that exact Task chat", async (t) => {
  const f = await fixture(t);
  const controller = createTelegramTaskInboxController(f.deps);
  await controller.initialize();
  await controller.syncTasks();
  const initialCard = f.calls.find((item) => item[0] === "send-card" && /task-abcdef12/u.test(item[1]));
  const bindButton = initialCard[2].flat().find((button) => button.text === "💬 Use for chat");
  assert.ok(bindButton);
  f.pending.push({ updateId: 165, kind: "callback", callbackQueryId: "cb-card-bind", messageId: 701, data: bindButton.callbackData, receivedAt: "2026-09-20T16:00:10.000Z" });
  await controller.processPending();
  const boundEdit = f.calls.findLast((item) => item[0] === "edit-card" && item[1] === 701);
  const unbindButton = boundEdit[3].flat().find((button) => button.text === "🔌 Unbind");
  assert.ok(unbindButton);
  assert.equal(boundEdit[3].flat().some((button) => button.text === "💬 Use for chat"), false);

  f.pending.push({ updateId: 166, kind: "callback", callbackQueryId: "cb-card-unbind", messageId: 701, data: unbindButton.callbackData, receivedAt: "2026-09-20T16:00:11.000Z" });
  await controller.processPending();
  const state = JSON.parse(await fs.readFile(f.deps.statePath, "utf8"));
  assert.equal(state.chatBridge, null);
  assert.deepEqual(
    f.calls.find((item) => item[0] === "answer" && item[1] === "cb-card-unbind"),
    ["answer", "cb-card-unbind", "Chat unbound."],
  );
  const unboundEdit = f.calls.findLast((item) => item[0] === "edit-card" && item[1] === 701);
  assert.equal(unboundEdit[3].flat().some((button) => button.text === "💬 Use for chat"), true);
  assert.equal(unboundEdit[3].flat().some((button) => button.text === "🔌 Unbind"), false);
});

test("/tasks opens full Task controls before optional chat binding", async (t) => {
  const f = await fixture(t);
  const controller = createTelegramTaskInboxController(f.deps);
  await controller.initialize();

  f.pending.push({
    updateId: 170, kind: "message", messageId: 970, replyToMessageId: null,
    text: "/tasks", attachment: null, receivedAt: "2026-09-20T16:00:10.000Z",
  });
  await controller.processPending();
  const picker = f.calls.findLast((item) => item[0] === "send-card");
  assert.ok(picker);
  const taskButton = picker[2][0][0];
  assert.equal(taskButton.text.startsWith("🛠 "), true);
  assert.match(taskButton.callbackData, /^eqx:q:/u);

  f.pending.push({
    updateId: 171, kind: "callback", callbackQueryId: "cb-task-picker",
    messageId: 701, data: taskButton.callbackData,
    receivedAt: "2026-09-20T16:00:11.000Z",
  });
  await controller.processPending();

  let state = JSON.parse(await fs.readFile(f.deps.statePath, "utf8"));
  assert.equal(state.chatBridge, null);
  assert.deepEqual(
    f.calls.find((item) => item[0] === "answer" && item[1] === "cb-task-picker"),
    ["answer", "cb-task-picker", "Task controls opened."],
  );
  let taskMenu = f.calls.findLast((item) => item[0] === "edit-card" && item[1] === 701);
  let buttons = taskMenu[3].flat();
  assert.equal(buttons.some((button) => button.text === "▶ Continue"), true);
  assert.equal(buttons.some((button) => button.text === "✅ Mark complete"), true);
  assert.equal(buttons.some((button) => button.text === "⛔ Cancel task"), true);
  const bindButton = buttons.find((button) => button.text === "💬 Use for chat");
  assert.ok(bindButton);
  assert.equal(buttons.some((button) => button.text === "↗ Open in ChatGPT"), true);

  f.pending.push({
    updateId: 172, kind: "callback", callbackQueryId: "cb-task-bind",
    messageId: 701, data: bindButton.callbackData,
    receivedAt: "2026-09-20T16:00:12.000Z",
  });
  await controller.processPending();
  state = JSON.parse(await fs.readFile(f.deps.statePath, "utf8"));
  assert.equal(state.chatBridge.sourceTaskId, "task-abcdef12");
  taskMenu = f.calls.findLast((item) => item[0] === "edit-card" && item[1] === 701);
  buttons = taskMenu[3].flat();
  const unbindButton = buttons.find((button) => button.text === "🔌 Unbind");
  assert.ok(unbindButton);
  assert.equal(buttons.some((button) => button.text === "💬 Use for chat"), false);

  f.pending.push({
    updateId: 173, kind: "callback", callbackQueryId: "cb-task-unbind",
    messageId: 701, data: unbindButton.callbackData,
    receivedAt: "2026-09-20T16:00:13.000Z",
  });
  await controller.processPending();
  state = JSON.parse(await fs.readFile(f.deps.statePath, "utf8"));
  assert.equal(state.chatBridge, null);
  taskMenu = f.calls.findLast((item) => item[0] === "edit-card" && item[1] === 701);
  buttons = taskMenu[3].flat();
  assert.equal(buttons.some((button) => button.text === "💬 Use for chat"), true);
  assert.equal(buttons.some((button) => button.text === "🔌 Unbind"), false);
});

test("New Task persists binding before delayed first-turn identity becomes available", async (t) => {
  const f = await fixture(t);
  let inspectCount = 0;
  const controller = createTelegramTaskInboxController({
    ...f.deps,
    startTaskChat: async ({ taskId }) => ({
      confirmed: true,
      binding: {
        sourceTaskId: taskId,
        browserContext: "user",
        browserInstanceId: "instance-1",
        tabId: 199,
        conversationId: "deadbeef-3456-7890-abcd-ef1234567890",
        canonicalUrl: "https://chatgpt.com/c/deadbeef-3456-7890-abcd-ef1234567890",
        title: "Delayed identity task",
        boundAt: "2026-09-20T16:00:12.000Z",
      },
      userEpoch: null,
      previousAssistantTurnKey: null,
    }),
    inspectChatIdentity: async ({ binding }) => {
      inspectCount += 1;
      return inspectCount === 1
        ? { status: "waiting", binding, userEpoch: null, assistantTurnKey: null }
        : { status: "ready", binding, userEpoch: "late-user-1", assistantTurnKey: null };
    },
  });
  await controller.initialize();
  f.pending.push({ updateId: 180, kind: "message", messageId: 980, replyToMessageId: null, text: "/tasks", attachment: null, receivedAt: "2026-09-20T16:00:10.000Z" });
  await controller.processPending();
  const picker = f.calls.findLast((item) => item[0] === "send-card");
  const newTaskButton = picker[2].at(-1)[0];
  f.pending.push({ updateId: 181, kind: "callback", callbackQueryId: "cb-new-late", messageId: 701, data: newTaskButton.callbackData, receivedAt: "2026-09-20T16:00:11.000Z" });
  await controller.processPending();
  f.pending.push({ updateId: 182, kind: "message", messageId: 982, replyToMessageId: null, text: "Delayed identity task", attachment: null, receivedAt: "2026-09-20T16:00:12.000Z" });
  await controller.processPending();

  let state = JSON.parse(await fs.readFile(f.deps.statePath, "utf8"));
  assert.equal(state.chatBridge.sourceTaskId, "task-newtask12");
  assert.equal(state.chatBridge.conversationId, "deadbeef-3456-7890-abcd-ef1234567890");
  assert.equal(state.chatBridgeTurn.status, "identity_wait");
  assert.equal(state.chatBridgeTurn.userEpoch, null);
  assert.equal(f.calls.some((item) => item[0] === "bind-chat" && item[1] === "task-newtask12"), true);
  assert.deepEqual(await controller.processChatBridgeResponse(), { status: "identity_wait" });
  f.setChatReadResult({ status: "ready", text: "late first answer", assistantTurnKey: "assistant-late-1", truncated: false });
  assert.deepEqual(await controller.processChatBridgeResponse(), { status: "sent" });
  state = JSON.parse(await fs.readFile(f.deps.statePath, "utf8"));
  assert.equal(state.chatBridgeTurn, null);
  assert.equal(f.calls.filter((item) => item[0] === "message" && item[1] === "late first answer").length, 1);
});

test("New Task preserves a durable chat binding when post-bind response tracking setup fails", async (t) => {
  const f = await fixture(t);
  const controller = createTelegramTaskInboxController(f.deps);
  await controller.initialize();
  f.pending.push({ updateId: 185, kind: "message", messageId: 985, replyToMessageId: null, text: "/tasks", attachment: null, receivedAt: "2026-09-20T16:00:10.000Z" });
  await controller.processPending();
  const picker = f.calls.findLast((item) => item[0] === "send-card");
  const newTaskButton = picker[2].at(-1)[0];
  f.pending.push({ updateId: 186, kind: "callback", callbackQueryId: "cb-new-recover", messageId: 701, data: newTaskButton.callbackData, receivedAt: "2026-09-20T16:00:11.000Z" });
  await controller.processPending();
  f.setSendMessageError(new Error("telegram send failed after durable bind"));
  f.pending.push({ updateId: 187, kind: "message", messageId: 987, replyToMessageId: null, text: "Recover bound task", attachment: null, receivedAt: "2026-09-20T16:00:12.000Z" });
  await controller.processPending();

  const state = JSON.parse(await fs.readFile(f.deps.statePath, "utf8"));
  assert.equal(state.taskCreation, null);
  assert.equal(state.chatBridge.sourceTaskId, "task-newtask12");
  assert.equal(state.chatBridge.conversationId, "feedface-3456-7890-abcd-ef1234567890");
  assert.equal(state.chatBridgeTurn, null);
  const action = state.actions.find((item) => item.updateId === 187);
  assert.equal(action.status, "done");
  assert.match(action.reason, /^task_chat_binding_recovered: /u);
  assert.equal(f.events.some((event) => event.type === "telegram.task_creation_recovered"), true);
});

test("restart recovers ambiguous New Task selection from a durable active Task binding", async (t) => {
  const f = await fixture(t);
  const base = createTelegramTaskInboxController(f.deps);
  await base.initialize();
  const raw = JSON.parse(await fs.readFile(f.deps.statePath, "utf8"));
  raw.taskCreation = {
    status: "ambiguous", sourcePickerMessageId: 701, taskId: "task-abcdef12",
    reason: "old post-create failure", createdAt: "2026-09-20T16:00:10.000Z", updatedAt: "2026-09-20T16:00:11.000Z",
  };
  raw.chatBridge = null;
  raw.chatBridgeTurn = null;
  raw.chatBridgeAttachment = null;
  await fs.writeFile(f.deps.statePath, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });

  const controller = createTelegramTaskInboxController(f.deps);
  await controller.initialize();
  assert.equal(controller.snapshot().taskCreationStatus, null);
  assert.equal(controller.snapshot().chatBridgeBound, true);
  const state = JSON.parse(await fs.readFile(f.deps.statePath, "utf8"));
  assert.equal(state.chatBridge.sourceTaskId, "task-abcdef12");
  assert.equal(state.chatBridge.conversationId, "abcdef12-3456-7890-abcd-ef1234567890");
  assert.equal(state.chatBridgeTurn, null);
  assert.equal(f.events.some((event) => event.type === "telegram.task_creation_recovered"), true);
});

test("safe pre-prompt New Task failure rolls back the temporary Task instead of leaving ambiguous state", async (t) => {
  const f = await fixture(t);
  const controller = createTelegramTaskInboxController({
    ...f.deps,
    startTaskChat: async () => {
      const error = new Error("ChatGPT task-chat composer did not remain stable long enough to submit the Task prompt.");
      error.code = "CHAT_BRIDGE_CREATE_NOT_STARTED";
      throw error;
    },
  });
  await controller.initialize();

  f.pending.push({ updateId: 190, kind: "message", messageId: 990, replyToMessageId: null, text: "/tasks", attachment: null, receivedAt: "2026-09-20T16:00:10.000Z" });
  await controller.processPending();
  const picker = f.calls.findLast((item) => item[0] === "send-card");
  const newTaskButton = picker[2].at(-1)[0];
  f.pending.push({ updateId: 191, kind: "callback", callbackQueryId: "cb-safe-fail", messageId: 701, data: newTaskButton.callbackData, receivedAt: "2026-09-20T16:00:11.000Z" });
  await controller.processPending();
  f.pending.push({ updateId: 192, kind: "message", messageId: 992, replyToMessageId: null, text: "Temporary task", attachment: null, receivedAt: "2026-09-20T16:00:12.000Z" });
  await controller.processPending();

  assert.equal(f.calls.some((item) => item[0] === "cancel" && item[1] === "task-newtask12"), true);
  assert.equal(f.calls.some((item) => item[0] === "remove" && item[1] === "task-newtask12"), true);
  const state = JSON.parse(await fs.readFile(f.deps.statePath, "utf8"));
  assert.equal(state.taskCreation, null);
  assert.equal(state.chatBridge, null);
  const action = state.actions.find((item) => item.updateId === 192);
  assert.equal(action.status, "done");
  assert.match(action.reason, /^task_chat_not_started: /u);
  assert.match(f.calls.findLast((item) => item[0] === "message")[1], /temporary Task was rolled back/u);
});

test("restart clears stale ambiguous New Task state when its referenced Task is no longer active", async (t) => {
  const f = await fixture(t);
  const base = createTelegramTaskInboxController(f.deps);
  await base.initialize();
  const raw = JSON.parse(await fs.readFile(f.deps.statePath, "utf8"));
  raw.taskCreation = {
    status: "ambiguous", sourcePickerMessageId: 701, taskId: "task-newtask12",
    reason: "safe_old_failure", createdAt: "2026-09-20T16:00:10.000Z", updatedAt: "2026-09-20T16:00:11.000Z",
  };
  await fs.writeFile(f.deps.statePath, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
  const controller = createTelegramTaskInboxController({
    ...f.deps,
    store: {
      ...f.deps.store,
      readInternal: async (taskId) => taskId === "task-newtask12"
        ? { taskId, status: "cancelled", chatBinding: null }
        : f.deps.store.readInternal(taskId),
    },
  });
  await controller.initialize();
  assert.equal(controller.snapshot().taskCreationStatus, null);
  const state = JSON.parse(await fs.readFile(f.deps.statePath, "utf8"));
  assert.equal(state.taskCreation, null);
});

test("terminal Task automatically loses current Telegram chat binding and cannot receive a new message", async (t) => {
  const f = await fixture(t);
  const controller = createTelegramTaskInboxController(f.deps);
  await controller.initialize();
  // Bind the fixture Task through its durable Task card.
  await controller.syncTasks();
  const card = f.calls.find((item) => item[0] === "send-card");
  const bindButton = card[2].flat().find((button) => button.text === "💬 Use for chat");
  f.pending.push({ updateId: 210, kind: "callback", callbackQueryId: "cb-bind-terminal", messageId: 701, data: bindButton.callbackData, receivedAt: "2026-09-20T16:00:10.000Z" });
  await controller.processPending();
  assert.equal(controller.snapshot().chatBridgeBound, true);
  f.task.status = "completed";
  f.task.updatedAt = "2026-09-20T16:01:00.000Z";
  await controller.syncTasks();
  assert.equal(controller.snapshot().chatBridgeBound, false);
  const terminalEdit = f.calls.findLast((item) => item[0] === "edit-card");
  const terminalButtons = terminalEdit[3]?.flat() || [];
  assert.equal(terminalButtons.some((button) => button.text === "💬 Use for chat" || button.text === "🔌 Unbind"), false);
  assert.equal(terminalButtons.some((button) => button.text === "↗ Open in ChatGPT"), true);
});

test("disabled Telegram remote control drops inbound updates without actions or typing", async (t) => {
  const f = await fixture(t);
  f.pending.push({ updateId: 220, kind: "message", messageId: 1020, replyToMessageId: null, text: "/status", attachment: null, receivedAt: "2026-09-20T16:00:10.000Z" });
  const controller = createTelegramTaskInboxController({
    ...f.deps,
    getTelegramStatus: async () => ({ ready: true, remoteControl: { enabled: false } }),
    getAgentActivity: async () => ({ working: true }),
    sendTyping: async () => { f.calls.push(["typing"]); return { sent: true }; },
  });
  await controller.initialize();
  const result = await controller.cycle();
  assert.equal(result.remoteControlEnabled, false);
  assert.equal(result.discarded, 1);
  assert.equal(f.pending.length, 0);
  assert.equal(f.calls.some((item) => item[0] === "typing"), false);
  assert.equal(f.calls.some((item) => item[0] === "message"), false);
});

test("active browser-bound agent work refreshes Telegram typing during inbox cycles", async (t) => {
  const f = await fixture(t);
  const controller = createTelegramTaskInboxController({
    ...f.deps,
    getTelegramStatus: async () => ({ ready: true, remoteControl: { enabled: true } }),
    getAgentActivity: async () => ({ working: true, startedAt: "2026-09-20T16:00:00.000Z" }),
    sendTyping: async () => { f.calls.push(["typing"]); return { configured: true, sent: true }; },
  });
  await controller.initialize();
  const result = await controller.cycle();
  assert.equal(result.remoteControlEnabled, true);
  assert.equal(result.typing, true);
  assert.equal(f.calls.filter((item) => item[0] === "typing").length, 1);
});

test("restart makes an in-flight new-Task chat creation ambiguous and never replays it", async (t) => {
  const f = await fixture(t);
  const controller = createTelegramTaskInboxController(f.deps);
  await controller.initialize();

  f.pending.push({ updateId: 180, kind: "message", messageId: 980, replyToMessageId: null, text: "/tasks", attachment: null, receivedAt: "2026-09-20T16:00:10.000Z" });
  await controller.processPending();
  const picker = f.calls.findLast((item) => item[0] === "send-card");
  const newTaskButton = picker[2].at(-1)[0];
  f.pending.push({ updateId: 181, kind: "callback", callbackQueryId: "cb-new-restart", messageId: 701, data: newTaskButton.callbackData, receivedAt: "2026-09-20T16:00:11.000Z" });
  await controller.processPending();

  const raw = JSON.parse(await fs.readFile(f.deps.statePath, "utf8"));
  raw.taskCreation.status = "creating";
  raw.taskCreation.taskId = "task-newtask12";
  raw.taskCreation.updatedAt = "2026-09-20T16:00:12.000Z";
  await fs.writeFile(f.deps.statePath, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });

  const callsBefore = f.calls.filter((item) => item[0] === "task-chat-create").length;
  const restarted = createTelegramTaskInboxController({
    ...f.deps,
    store: {
      ...f.deps.store,
      readInternal: async (taskId) => taskId === "task-newtask12"
        ? { taskId, title: "In-flight task", status: "active", chatBinding: null }
        : f.deps.store.readInternal(taskId),
    },
  });
  await restarted.initialize();
  assert.equal(restarted.snapshot().taskCreationStatus, "ambiguous");
  assert.equal(f.calls.filter((item) => item[0] === "task-chat-create").length, callsBefore);
  const state = JSON.parse(await fs.readFile(f.deps.statePath, "utf8"));
  assert.equal(state.taskCreation.status, "ambiguous");
  assert.equal(state.taskCreation.reason, "runtime_restart_during_task_chat_create");
});
