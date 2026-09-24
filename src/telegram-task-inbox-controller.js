import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { readBoundedNormalFile } from "./equinox-local-safe-file.js";
import {
  acknowledgeTelegramInboundUpdate,
  answerTelegramTaskCallback,
  defaultTelegramTaskStatePath,
  downloadTelegramAttachment,
  editTelegramTaskCard,
  getTelegramIntegrationStatus,
  pollTelegramInboundOnce,
  readTelegramInboundPending,
  sendTelegramMessage,
  sendTelegramTaskCard,
  sendTelegramTyping,
} from "./telegram-integration.js";

const STATE_VERSION = 1;
const MAX_STATE_BYTES = 256 * 1024;
const MAX_MAPPINGS = 50;
const MAX_ACTIONS = 100;
const MAX_CONTROL_CARDS = 10;
const MAX_CHAT_PICKERS = 30;
const CONTROL_CARD_TTL_MS = 30 * 60 * 1000;
const CHAT_PICKER_TTL_MS = 30 * 60 * 1000;
const CONTROL_CONFIRM_TTL_MS = 30 * 1000;
const DEFAULT_POLL_MS = 2_500;
const MAX_BACKOFF_MS = 30_000;
const CALLBACK_RE = /^eqx:([abcdfxpurentq]):([a-z0-9-]{6,40})$/u;

function iso(now) { return new Date(now).toISOString(); }
function errorMessage(error) { return error instanceof Error ? error.message : String(error); }

async function atomicWrite(filePath, value, fsImpl = fs) {
  const parent = path.dirname(filePath);
  await fsImpl.mkdir(parent, { recursive: true, mode: 0o700 });
  await fsImpl.chmod(parent, 0o700).catch(() => {});
  const temp = path.join(parent, `.telegram-task-${process.pid}-${randomUUID().slice(0, 8)}.tmp`);
  try {
    await fsImpl.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await fsImpl.rename(temp, filePath);
    await fsImpl.chmod(filePath, 0o600);
  } catch (error) {
    await fsImpl.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

function emptyState(now) {
  return { version: STATE_VERSION, activatedAt: iso(now()), mappings: [], controlCards: [], chatPickers: [], taskCreation: null, chatBridge: null, chatBridgeTurn: null, chatBridgeAttachment: null, actions: [] };
}

function normalizeChatBridgeBinding(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Telegram Chat Bridge state is invalid.");
  if (value.sourceTaskId !== null && !/^task-[a-z0-9-]{6,80}$/u.test(value.sourceTaskId || "")) throw new Error("Telegram Chat Bridge source task is invalid.");
  if (!["agent", "user"].includes(value.browserContext)) throw new Error("Telegram Chat Bridge browser context is invalid.");
  if (typeof value.browserInstanceId !== "string" || value.browserInstanceId.length < 8 || value.browserInstanceId.length > 200) throw new Error("Telegram Chat Bridge browser instance is invalid.");
  if (!Number.isInteger(value.tabId) || value.tabId < 1) throw new Error("Telegram Chat Bridge tab is invalid.");
  if (typeof value.conversationId !== "string" || !/^[A-Za-z0-9-]{8,160}$/u.test(value.conversationId)) throw new Error("Telegram Chat Bridge conversation is invalid.");
  if (typeof value.canonicalUrl !== "string" || value.canonicalUrl.length < 1 || value.canonicalUrl.length > 2_000) throw new Error("Telegram Chat Bridge canonical URL is invalid.");
  if (typeof value.title !== "string" || value.title.length < 1 || value.title.length > 200) throw new Error("Telegram Chat Bridge title is invalid.");
  if (typeof value.boundAt !== "string" || !Number.isFinite(Date.parse(value.boundAt))) throw new Error("Telegram Chat Bridge bound timestamp is invalid.");
  return {
    sourceTaskId: value.sourceTaskId,
    browserContext: value.browserContext,
    browserInstanceId: value.browserInstanceId,
    tabId: value.tabId,
    conversationId: value.conversationId,
    canonicalUrl: value.canonicalUrl,
    title: value.title,
    boundAt: new Date(value.boundAt).toISOString(),
  };
}

function normalizeChatBridgeAttachment(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Telegram Chat Bridge attachment state is invalid.");
  if (value.sourceTaskId !== null && !/^task-[a-z0-9-]{6,80}$/u.test(value.sourceTaskId || "")) throw new Error("Telegram Chat Bridge attachment source task is invalid.");
  if (!Number.isSafeInteger(value.sourceUpdateId)) throw new Error("Telegram Chat Bridge attachment update id is invalid.");
  if (typeof value.deliveryId !== "string" || !/^tgb-[a-z0-9-]{6,80}$/u.test(value.deliveryId)) throw new Error("Telegram Chat Bridge attachment delivery id is invalid.");
  if (!["prepared", "active", "ambiguous"].includes(value.status)) throw new Error("Telegram Chat Bridge attachment status is invalid.");
  const attachment = value.attachment;
  if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) throw new Error("Telegram Chat Bridge attachment metadata is invalid.");
  if (typeof attachment.attachmentId !== "string" || !/^tgatt-[a-z0-9-]{6,100}$/u.test(attachment.attachmentId)) throw new Error("Telegram Chat Bridge attachment id is invalid.");
  if (!["photo", "document"].includes(attachment.kind)) throw new Error("Telegram Chat Bridge attachment kind is invalid.");
  if (typeof attachment.fileName !== "string" || attachment.fileName.length < 1 || attachment.fileName.length > 180 || /[\r\n\0]/u.test(attachment.fileName)) throw new Error("Telegram Chat Bridge attachment file name is invalid.");
  if (typeof attachment.mimeType !== "string" || attachment.mimeType.length < 1 || attachment.mimeType.length > 120 || /[\r\n\0]/u.test(attachment.mimeType)) throw new Error("Telegram Chat Bridge attachment MIME type is invalid.");
  if (!Number.isSafeInteger(attachment.bytes) || attachment.bytes < 1 || attachment.bytes > 20 * 1024 * 1024) throw new Error("Telegram Chat Bridge attachment size is invalid.");
  if (typeof attachment.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(attachment.sha256)) throw new Error("Telegram Chat Bridge attachment hash is invalid.");
  if (typeof attachment.storagePath !== "string" || !path.isAbsolute(attachment.storagePath) || attachment.storagePath.length > 4096 || attachment.storagePath.includes("\0")) throw new Error("Telegram Chat Bridge attachment storage path is invalid.");
  if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) throw new Error("Telegram Chat Bridge attachment created timestamp is invalid.");
  if (typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))) throw new Error("Telegram Chat Bridge attachment updated timestamp is invalid.");
  return {
    sourceTaskId: value.sourceTaskId,
    sourceUpdateId: value.sourceUpdateId,
    deliveryId: value.deliveryId,
    status: value.status,
    attachment: {
      attachmentId: attachment.attachmentId,
      kind: attachment.kind,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      bytes: attachment.bytes,
      sha256: attachment.sha256,
      storagePath: attachment.storagePath,
    },
    createdAt: new Date(value.createdAt).toISOString(),
    updatedAt: new Date(value.updatedAt).toISOString(),
  };
}

function normalizeChatBridgeTurn(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Telegram Chat Bridge turn state is invalid.");
  if (typeof value.deliveryId !== "string" || !/^tgb-[a-z0-9-]{6,80}$/u.test(value.deliveryId)) throw new Error("Telegram Chat Bridge turn delivery id is invalid.");
  if (!Number.isSafeInteger(value.sourceUpdateId)) throw new Error("Telegram Chat Bridge turn update id is invalid.");
  if (!["identity_wait", "waiting", "sending", "ambiguous"].includes(value.status)) throw new Error("Telegram Chat Bridge turn status is invalid.");
  const binding = normalizeChatBridgeBinding(value.binding);
  if (value.status === "identity_wait") {
    if (value.userEpoch !== null) throw new Error("Telegram Chat Bridge identity-wait user epoch must be null.");
  } else if (typeof value.userEpoch !== "string" || value.userEpoch.length < 1 || value.userEpoch.length > 200) {
    throw new Error("Telegram Chat Bridge turn user epoch is invalid.");
  }
  if (value.previousAssistantTurnKey !== null && (typeof value.previousAssistantTurnKey !== "string" || value.previousAssistantTurnKey.length < 1 || value.previousAssistantTurnKey.length > 200)) throw new Error("Telegram Chat Bridge previous assistant turn is invalid.");
  if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) throw new Error("Telegram Chat Bridge turn created timestamp is invalid.");
  if (typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))) throw new Error("Telegram Chat Bridge turn updated timestamp is invalid.");
  const assistantTurnKey = value.assistantTurnKey == null ? null : String(value.assistantTurnKey).slice(0, 200);
  const reason = value.reason == null ? null : String(value.reason).slice(0, 180);
  return {
    deliveryId: value.deliveryId,
    sourceUpdateId: value.sourceUpdateId,
    status: value.status,
    binding,
    userEpoch: value.userEpoch,
    previousAssistantTurnKey: value.previousAssistantTurnKey,
    assistantTurnKey,
    reason,
    createdAt: new Date(value.createdAt).toISOString(),
    updatedAt: new Date(value.updatedAt).toISOString(),
  };
}

function normalizeTaskCreation(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Telegram task-creation state is invalid.");
  if (!["awaiting_input", "creating", "ambiguous"].includes(value.status)) throw new Error("Telegram task-creation status is invalid.");
  if (!Number.isInteger(value.sourcePickerMessageId) || value.sourcePickerMessageId < 1) throw new Error("Telegram task-creation picker message is invalid.");
  const taskId = value.taskId == null ? null : String(value.taskId);
  if (taskId !== null && !/^task-[a-z0-9-]{6,80}$/u.test(taskId)) throw new Error("Telegram task-creation task id is invalid.");
  if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) throw new Error("Telegram task-creation timestamp is invalid.");
  if (typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))) throw new Error("Telegram task-creation update timestamp is invalid.");
  const reason = value.reason == null ? null : String(value.reason).slice(0, 180);
  return {
    status: value.status,
    sourcePickerMessageId: value.sourcePickerMessageId,
    taskId,
    reason,
    createdAt: new Date(value.createdAt).toISOString(),
    updatedAt: new Date(value.updatedAt).toISOString(),
  };
}

function normalizeChatPicker(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Telegram chat picker is invalid.");
  if (!/^[a-z0-9-]{6,40}$/u.test(value.routeId || "")) throw new Error("Telegram chat picker route is invalid.");
  if (!Number.isInteger(value.messageId) || value.messageId < 1) throw new Error("Telegram chat picker message is invalid.");
  if (!["task", "new", "unbind"].includes(value.kind)) throw new Error("Telegram chat picker kind is invalid.");
  if (value.kind === "task" && !/^task-[a-z0-9-]{6,80}$/u.test(value.target || "")) throw new Error("Telegram task picker target is invalid.");
  if (value.kind === "new" && value.target !== "new") throw new Error("Telegram new-task picker target is invalid.");
  if (value.kind === "unbind" && !/^task-[a-z0-9-]{6,80}$/u.test(value.target || "")) throw new Error("Telegram unbind picker target is invalid.");
  if (typeof value.label !== "string" || value.label.length < 1 || value.label.length > 100 || /[\r\n\0]/u.test(value.label)) throw new Error("Telegram chat picker label is invalid.");
  if (typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))) throw new Error("Telegram chat picker expiry is invalid.");
  return {
    routeId: value.routeId,
    messageId: value.messageId,
    kind: value.kind,
    target: value.target,
    label: value.label,
    expiresAt: new Date(value.expiresAt).toISOString(),
  };
}

function validateState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== STATE_VERSION) throw new Error("Telegram task state is invalid.");
  if (typeof value.activatedAt !== "string" || !Number.isFinite(Date.parse(value.activatedAt))) throw new Error("Telegram task activation timestamp is invalid.");
  const mappings = Array.isArray(value.mappings) ? value.mappings.slice(-MAX_MAPPINGS) : [];
  const controlCards = Array.isArray(value.controlCards) ? value.controlCards.slice(-MAX_CONTROL_CARDS) : [];
  const chatPickers = Array.isArray(value.chatPickers) ? value.chatPickers.filter((item) => item?.kind === "task" || item?.kind === "new" || item?.kind === "unbind").slice(-MAX_CHAT_PICKERS).map(normalizeChatPicker) : [];
  const taskCreation = normalizeTaskCreation(value.taskCreation ?? null);
  const actions = Array.isArray(value.actions) ? value.actions.slice(-MAX_ACTIONS) : [];
  const chatBridge = normalizeChatBridgeBinding(value.chatBridge ?? null);
  const chatBridgeTurn = normalizeChatBridgeTurn(value.chatBridgeTurn ?? null);
  const chatBridgeAttachment = normalizeChatBridgeAttachment(value.chatBridgeAttachment ?? null);
  for (const item of mappings) {
    if (!item || typeof item !== "object" || !/^task-[a-z0-9-]{6,80}$/u.test(item.taskId) || !/^[a-z0-9-]{6,40}$/u.test(item.routeId) || !Number.isInteger(item.messageId) || item.messageId < 1) {
      throw new Error("Telegram task mapping is invalid.");
    }
    if (item.retiredAt !== null && item.retiredAt !== undefined && (typeof item.retiredAt !== "string" || !Number.isFinite(Date.parse(item.retiredAt)))) {
      throw new Error("Telegram retired task mapping timestamp is invalid.");
    }
  }
  for (const item of controlCards) {
    if (!item || typeof item !== "object" || !/^[a-z0-9-]{6,40}$/u.test(item.routeId) || !Number.isInteger(item.messageId) || item.messageId < 1 || typeof item.expiresAt !== "string" || !Number.isFinite(Date.parse(item.expiresAt))) {
      throw new Error("Telegram control-card state is invalid.");
    }
    if (item.pendingAction !== null && item.pendingAction !== undefined && !["pause", "restart"].includes(item.pendingAction)) throw new Error("Telegram control confirmation state is invalid.");
    if (item.confirmationExpiresAt !== null && item.confirmationExpiresAt !== undefined && (typeof item.confirmationExpiresAt !== "string" || !Number.isFinite(Date.parse(item.confirmationExpiresAt)))) throw new Error("Telegram control confirmation expiry is invalid.");
  }
  for (const item of actions) {
    if (!item || typeof item !== "object" || !Number.isSafeInteger(item.updateId) || !["processing", "done", "ambiguous"].includes(item.status)) {
      throw new Error("Telegram task action state is invalid.");
    }
  }
  return { version: STATE_VERSION, activatedAt: new Date(value.activatedAt).toISOString(), mappings, controlCards, chatPickers, taskCreation, chatBridge, chatBridgeTurn, chatBridgeAttachment, actions };
}

function parseTelegramCommand(text, hasAttachment = false) {
  if (hasAttachment || typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const token = trimmed.split(/\s+/u, 1)[0].toLowerCase();
  const command = token.slice(1).split("@", 1)[0];
  if (["status", "tasks", "help", "chat", "unbind"].includes(command)) return command;
  return "unknown";
}

function remoteStatusText(status = {}) {
  const agent = status.agentPaused ? "🛑 Paused" : "🟢 Running";
  const agentBrowser = status.agentBrowserReady ? "🟢 Ready" : "⚪ Closed";
  const userBrowser = status.userBrowserReady ? "🟢 Connected" : "⚪ Not connected";
  const active = Number.isInteger(status.activeTasks) ? status.activeTasks : 0;
  const waiting = Number.isInteger(status.waitingTasks) ? status.waitingTasks : 0;
  const continuing = Number.isInteger(status.continuingTasks) ? status.continuingTasks : 0;
  return [
    `🖥 Equinox Local${status.version ? ` v${status.version}` : ""}`,
    `Agent: ${agent}`,
    `Agent Browser: ${agentBrowser}`,
    `Your Browser: ${userBrowser}`,
    "",
    "📋 Tasks",
    `Active: ${active}`,
    `Waiting for you: ${waiting}`,
    `Continuing: ${continuing}`,
  ].join("\n");
}

function controlKeyboard(status, routeId) {
  const primary = status?.agentPaused
    ? { text: "▶ Resume", callbackData: `eqx:u:${routeId}` }
    : { text: "🛑 Emergency Stop", callbackData: `eqx:p:${routeId}` };
  return [[primary, { text: "🔄 Restart", callbackData: `eqx:r:${routeId}` }]];
}

function controlConfirmationKeyboard(routeId, action) {
  const isPause = action === "pause";
  const label = isPause ? "Confirm Emergency Stop" : "Confirm Restart";
  return [[
    { text: `⚠️ ${label}`, callbackData: `eqx:${isPause ? "e" : "t"}:${routeId}` },
    { text: "↩ Back", callbackData: `eqx:n:${routeId}` },
  ]];
}

function controlConfirmationText(status, action) {
  const prompt = action === "pause"
    ? "⚠️ Confirm Emergency Stop? Active continuations and prepared Fresh Chat Resume work will be cancelled."
    : "⚠️ Confirm Equinox Local restart? The connection will disconnect briefly while the runtime restarts.";
  return `${remoteStatusText(status)}\n\n${prompt}`;
}

function taskListText(tasks) {
  const active = tasks.filter((task) => task.status === "active").slice(0, 10);
  if (!active.length) return "📋 Tasks\nNo active tasks.";
  const lines = active.map((task) => `${taskStatusLine(task)} · ${task.title}\n${task.taskId} · checkpoint ${task.checkpointRevision}`);
  return [`📋 Active tasks (${active.length}${tasks.filter((task) => task.status === "active").length > active.length ? "+" : ""})`, ...lines].join("\n\n");
}

function commandHelpText() {
  return [
    "Equinox Local Telegram controls",
    "/status — runtime, Browser and task status",
    "/tasks — active Task Capsules",
    "/chat — show the bound ChatGPT conversation",
    "/unbind — stop normal Telegram messages from going to ChatGPT",
    "/help — show these commands",
    "Use /tasks to choose the current Task chat or create a new Task.",
    "Normal Telegram messages only go to the currently selected Task chat. Reply to a task card for task-specific input.",
  ].join("\n");
}

function chatBridgeStatusText(binding, turn = null, attachment = null) {
  if (!binding) return [
    "💬 Chat bridge",
    "Not bound.",
    turn?.status === "ambiguous" || attachment?.status === "ambiguous" ? "Previous bridge delivery became ambiguous; /unbind clears this recovery state." : null,
    "Use /tasks to choose an active Task chat or create a new Task first.",
  ].filter(Boolean).join("\n");
  const lines = [
    "💬 Chat bridge",
    `Bound to: ${binding.title}`,
    "Source task: " + binding.sourceTaskId,
    `Browser: ${binding.browserContext === "user" ? "Your Browser" : "Agent Browser"}`,
  ];
  if (turn?.status === "identity_wait") lines.push("Response: ⏳ waiting for ChatGPT to expose the new turn identity");
  else if (turn?.status === "waiting") lines.push("Response: ⏳ waiting for ChatGPT final answer");
  else if (turn?.status === "sending") lines.push("Response: ↗ sending to Telegram");
  else if (turn?.status === "ambiguous" || attachment?.status === "ambiguous") lines.push("Response: ⚠️ delivery ambiguous; /unbind clears the blocked turn");
  else if (attachment) lines.push(`Attachment: ${attachment.status}`);
  else lines.push("Send a normal Telegram text message to forward it to this exact ChatGPT conversation.");
  lines.push("Use /unbind to stop bridge routing and clear any pending bridge turn.");
  return lines.join("\n");
}

function chatBridgeDeliveryId(updateId) {
  const token = Number(updateId).toString(36).padStart(6, "0");
  return `tgb-u${token}`.slice(0, 84);
}

function taskStatusLine(task) {
  if (task.status === "completed") return "✅ Completed";
  if (task.status === "cancelled") return "🛑 Cancelled";
  if (task.humanInput) return "📩 Human input waiting";
  if (["armed", "delivering"].includes(task.continuation?.status)) return "⏭️ Continue armed";
  return "🟢 Running";
}

function compactTaskText(value, maxChars = 180) {
  if (typeof value !== "string") return null;
  const clean = value.replace(/[\u0000-\u001F\u007F]/gu, " ").replace(/\s+/gu, " ").trim();
  if (!clean) return null;
  const chars = [...clean];
  return chars.length > maxChars ? `${chars.slice(0, maxChars - 1).join("")}…` : clean;
}

function taskCardText(task) {
  const lines = [
    `${taskStatusLine(task)} · ${task.title}`,
    `${task.taskId} · Checkpoint ${task.checkpointRevision}`,
  ];
  if (task.status === "active") {
    if (task.humanInput) lines.push("📩 Your Telegram reply is saved for the agent.");
    else if (["armed", "delivering"].includes(task.continuation?.status)) lines.push("⏭️ Continuing in ChatGPT.");
    else {
      const next = compactTaskText(Array.isArray(task.next) ? task.next[0] : null);
      if (next) lines.push(`Next: ${next}`);
      lines.push("Reply to this card to send input to this exact task.");
    }
  } else {
    lines.push(`Finished ${task.updatedAt}`);
  }
  return lines.join("\n");
}

function taskDisplayKey(task, canonicalUrl, chatBindable, chatSelected) {
  return JSON.stringify({
    status: task.status,
    revision: task.checkpointRevision,
    humanInput: task.humanInput?.inputId ?? null,
    continuation: task.continuation?.status ?? null,
    updatedAt: task.updatedAt,
    canonicalUrl: canonicalUrl ?? null,
    chatBindable: Boolean(chatBindable),
    chatSelected: Boolean(chatSelected),
  });
}

function taskKeyboard(task, routeId, canonicalUrl, chatBindable, chatSelected) {
  const rows = [];
  if (task.status === "active") {
    const primary = [];
    if (!["armed", "delivering"].includes(task.continuation?.status)) {
      primary.push({ text: "▶ Continue", callbackData: `eqx:c:${routeId}` });
    }
    primary.push({ text: "✅ Mark complete", callbackData: `eqx:f:${routeId}` });
    rows.push(primary);
    const secondary = [{ text: "⛔ Cancel task", callbackData: `eqx:x:${routeId}` }];
    if (chatBindable) secondary.push(chatSelected
      ? { text: "🔌 Unbind", callbackData: `eqx:d:${routeId}` }
      : { text: "💬 Use for chat", callbackData: `eqx:b:${routeId}` });
    rows.push(secondary);
  }
  if (canonicalUrl) rows.push([{ text: "↗ Open in ChatGPT", url: canonicalUrl }]);
  return rows.length ? rows : null;
}

export function createTelegramTaskInboxController({
  store,
  autoContinueController,
  statePath = defaultTelegramTaskStatePath(),
  getTelegramStatus = getTelegramIntegrationStatus,
  pollInbound = pollTelegramInboundOnce,
  readPending = readTelegramInboundPending,
  acknowledgeUpdate = acknowledgeTelegramInboundUpdate,
  downloadAttachment = downloadTelegramAttachment,
  sendCard = sendTelegramTaskCard,
  editCard = editTelegramTaskCard,
  answerCallback = answerTelegramTaskCallback,
  sendMessage = sendTelegramMessage,
  sendTyping = sendTelegramTyping,
  getRemoteStatus = null,
  getAgentActivity = null,
  pauseAgent = null,
  resumeAgent = null,
  requestRestart = null,
  deliverChatMessage = null,
  readChatResponse = null,
  inspectChatIdentity = null,
  startTaskChat = null,
  fsImpl = fs,
  now = () => Date.now(),
  randomId = () => randomUUID().slice(0, 10),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  pollMs = DEFAULT_POLL_MS,
  onEvent = null,
} = {}) {
  if (!store?.list || !store?.readInternal || !store?.checkpoint || !store?.bindChat || !store?.queueHumanInput || !store?.finish || !store?.cancel || !autoContinueController?.armBound || typeof pauseAgent !== "function" || typeof resumeAgent !== "function" || typeof requestRestart !== "function" || typeof deliverChatMessage !== "function" || typeof readChatResponse !== "function" || typeof inspectChatIdentity !== "function" || typeof startTaskChat !== "function") throw new Error("Telegram task inbox controller dependencies are missing.");
  let state = null;
  let stopped = true;
  let timer = null;
  let inFlight = null;
  let backoffMs = pollMs;

  const emit = (event) => { if (typeof onEvent === "function") void Promise.resolve(onEvent(event)).catch(() => {}); };
  const persist = async () => atomicWrite(statePath, state, fsImpl);

  const initialize = async () => {
    if (state) return snapshot();
    try {
      const loaded = await readBoundedNormalFile(statePath, { fsImpl, minBytes: 1, maxBytes: MAX_STATE_BYTES, encoding: "utf8", label: "Telegram task state" });
      if ((loaded.stat.mode & 0o777) !== 0o600) throw new Error("Telegram task state permissions need attention.");
      state = validateState(JSON.parse(loaded.data));
      let changed = false;
      for (const action of state.actions) {
        if (action.status === "processing") {
          action.status = "ambiguous";
          action.completedAt = iso(now());
          action.reason = "runtime_restart_during_action";
          changed = true;
        }
      }
      if (state.chatBridgeTurn?.status === "sending") {
        state.chatBridgeTurn.status = "ambiguous";
        state.chatBridgeTurn.reason = "runtime_restart_during_response_send";
        state.chatBridgeTurn.updatedAt = iso(now());
        changed = true;
      }
      if (state.chatBridgeAttachment?.status === "prepared") {
        state.chatBridgeAttachment.status = "ambiguous";
        state.chatBridgeAttachment.updatedAt = iso(now());
        changed = true;
      }
      if (state.taskCreation?.status === "creating") {
        state.taskCreation.status = "ambiguous";
        state.taskCreation.reason = "runtime_restart_during_task_chat_create";
        state.taskCreation.updatedAt = iso(now());
        changed = true;
      }
      if (state.taskCreation?.status === "ambiguous" && state.taskCreation.taskId) {
        let referencedTask = null;
        try { referencedTask = await store.readInternal(state.taskCreation.taskId); } catch {}
        if (referencedTask?.status === "active" && referencedTask.chatBinding?.canonicalUrl && !state.chatBridgeTurn && !state.chatBridgeAttachment) {
          try {
            state.chatBridge = normalizeChatBridgeBinding({
              sourceTaskId: referencedTask.taskId,
              ...referencedTask.chatBinding,
              title: String(referencedTask.title || "ChatGPT").slice(0, 200),
              boundAt: iso(now()),
            });
            state.taskCreation = null;
            state.chatPickers = [];
            emit({
              component: "telegram-task-inbox",
              type: "telegram.task_creation_recovered",
              severity: "info",
              status: "recovered",
              message: "Recovered Telegram Task chat selection from a durable Task Capsule binding.",
              details: { taskId: referencedTask.taskId },
            });
            changed = true;
          } catch {}
        } else if (!referencedTask || referencedTask.status !== "active") {
          state.taskCreation = null;
          state.chatPickers = [];
          changed = true;
        }
      }
      if (changed) await persist();
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      state = emptyState(now);
      await persist();
    }
    return snapshot();
  };

  const mappingForTask = (taskId) => state.mappings.find((item) => item.taskId === taskId) ?? null;
  const mappingForMessage = (messageId) => state.mappings.find((item) => !item.retiredAt && item.messageId === messageId) ?? null;
  const mappingForRoute = (routeId) => state.mappings.find((item) => !item.retiredAt && item.routeId === routeId) ?? null;
  const controlForRoute = (routeId) => state.controlCards.find((item) => item.routeId === routeId) ?? null;
  const pickerForRoute = (routeId) => state.chatPickers.find((item) => item.routeId === routeId) ?? null;
  const clearPickerMessage = (messageId) => {
    state.chatPickers = state.chatPickers.filter((item) => item.messageId !== messageId);
  };

  const clearChatBridge = async () => {
    const previous = state.chatBridge;
    const hadTurn = Boolean(state.chatBridgeTurn);
    const hadAttachment = Boolean(state.chatBridgeAttachment);
    state.chatBridge = null;
    state.chatBridgeTurn = null;
    state.chatBridgeAttachment = null;
    state.taskCreation = null;
    state.chatPickers = [];
    await persist();
    return { previous, hadTurn, hadAttachment };
  };

  const addUnbindPicker = (messageId, binding) => {
    const routeId = ("d-" + randomId()).toLowerCase().replace(/[^a-z0-9-]/gu, "").slice(0, 40);
    state.chatPickers.push(normalizeChatPicker({
      routeId,
      messageId,
      kind: "unbind",
      target: binding.sourceTaskId,
      label: "Unbind",
      expiresAt: iso(now() + CHAT_PICKER_TTL_MS),
    }));
    state.chatPickers = state.chatPickers.slice(-MAX_CHAT_PICKERS);
    return routeId;
  };

  const chatInfoForTask = async (taskId) => {
    const internal = await store.readInternal(taskId);
    return {
      canonicalUrl: internal.chatBinding?.canonicalUrl || internal.continuation?.target?.canonicalUrl || null,
      chatBindable: Boolean(internal.chatBinding),
      chatSelected: state.chatBridge?.sourceTaskId === taskId,
    };
  };


  const bindTaskChat = async (taskId) => {
    if (state.chatBridgeTurn || state.chatBridgeAttachment) throw new Error("A Chat Bridge turn is still pending or ambiguous. Use /chat or /unbind first.");
    const task = await store.readInternal(taskId);
    if (task.status !== "active") throw new Error("Only active Task Capsules can be selected for Telegram chat.");
    const binding = task.chatBinding;
    if (!binding?.canonicalUrl) throw new Error("This task does not have a verified ChatGPT conversation binding yet.");
    state.chatBridge = normalizeChatBridgeBinding({
      sourceTaskId: taskId,
      browserContext: binding.browserContext,
      browserInstanceId: binding.browserInstanceId,
      tabId: binding.tabId,
      conversationId: binding.conversationId,
      canonicalUrl: binding.canonicalUrl,
      title: String(task.title || "ChatGPT").slice(0, 200),
      boundAt: iso(now()),
    });
    await persist();
    return state.chatBridge;
  };

  const sendTaskPicker = async () => {
    const tasks = (await store.list({ limit: 50 })).filter((task) => task.status === "active").slice(0, 10);
    const choices = [];
    const rows = [];
    for (let index = 0; index < tasks.length; index += 1) {
      const task = tasks[index];
      const routeId = ("q-" + randomId() + "-" + index).toLowerCase().replace(/[^a-z0-9-]/gu, "").slice(0, 40);
      const label = String(task.title || task.taskId).slice(0, 54);
      rows.push([{ text: "🛠 " + label, callbackData: "eqx:q:" + routeId }]);
      choices.push({ routeId, kind: "task", target: task.taskId, label });
    }
    const newRouteId = ("a-" + randomId()).toLowerCase().replace(/[^a-z0-9-]/gu, "").slice(0, 40);
    rows.push([{ text: "➕ New task", callbackData: "eqx:a:" + newRouteId }]);
    choices.push({ routeId: newRouteId, kind: "new", target: "new", label: "New task" });
    const text = taskListText(tasks) + "\n\nChoose a Task to open its controls, or create a new Task.";
    const sent = await sendCard({ text, keyboard: rows });
    const expiresAt = iso(now() + CHAT_PICKER_TTL_MS);
    for (const choice of choices) state.chatPickers.push(normalizeChatPicker({ ...choice, messageId: sent.messageId, expiresAt }));
    state.chatPickers = state.chatPickers.slice(-MAX_CHAT_PICKERS);
    await persist();
  };

  const syncTask = async (task) => {
    let mapping = mappingForTask(task.taskId);
    if (task.status !== "active" && state.chatBridge?.sourceTaskId === task.taskId && !state.chatBridgeTurn && !state.chatBridgeAttachment) {
      await clearChatBridge();
    }
    const chatInfo = await chatInfoForTask(task.taskId).catch(() => ({ canonicalUrl: null, chatBindable: false, chatSelected: false }));
    const { canonicalUrl, chatBindable, chatSelected } = chatInfo;
    const displayKey = taskDisplayKey(task, canonicalUrl, chatBindable, chatSelected);
    if (!mapping) {
      if (Date.parse(task.updatedAt) <= Date.parse(state.activatedAt)) return false;
      const routeId = `r-${randomId()}`.toLowerCase().replace(/[^a-z0-9-]/gu, "").slice(0, 40);
      const sent = await sendCard({ text: taskCardText(task), keyboard: taskKeyboard(task, routeId, canonicalUrl, chatBindable, chatSelected) });
      mapping = { routeId, taskId: task.taskId, messageId: sent.messageId, displayKey, syncedAt: iso(now()) };
      state.mappings.push(mapping);
      state.mappings = state.mappings.slice(-MAX_MAPPINGS);
      await persist();
      return true;
    }
    if (mapping.retiredAt || mapping.displayKey === displayKey) return false;
    const editResult = await editCard({ messageId: mapping.messageId, text: taskCardText(task), keyboard: taskKeyboard(task, mapping.routeId, canonicalUrl, chatBindable, chatSelected) });
    mapping.displayKey = displayKey;
    mapping.syncedAt = iso(now());
    await persist();
    if (editResult?.unchanged === true) {
      emit({
        component: "telegram-task-inbox",
        type: "telegram.task_sync_recovered",
        severity: "info",
        status: "recovered",
        message: "Telegram task card state reconciled.",
        details: { taskId: task.taskId, reason: "message_not_modified" },
      });
    }
    return true;
  };

  const syncTasks = async () => {
    await initialize();
    const status = await getTelegramStatus();
    if (!status?.ready) return { configured: false, changed: 0 };
    const tasks = await store.list({ limit: 50 });
    let changed = 0;
    for (const task of [...tasks].reverse()) {
      try { if (await syncTask(task)) changed += 1; } catch (error) {
        if (task.status !== "active" && error?.telegramStatus === 400) {
          const mapping = mappingForTask(task.taskId);
          if (mapping && !mapping.retiredAt) {
            const chatInfo = await chatInfoForTask(task.taskId).catch(() => ({ canonicalUrl: null, chatBindable: false }));
            mapping.displayKey = taskDisplayKey(task, chatInfo.canonicalUrl, chatInfo.chatBindable);
            mapping.syncedAt = iso(now());
            mapping.retiredAt = iso(now());
            await persist();
            changed += 1;
            emit({ component: "telegram-task-inbox", type: "telegram.task_mapping_retired", severity: "info", status: "completed", message: "Retired a terminal Telegram task mapping that can no longer be edited.", details: { taskId: task.taskId, error: errorMessage(error).slice(0, 240) } });
            continue;
          }
        }
        emit({ component: "telegram-task-inbox", type: "telegram.task_sync_failed", severity: "warn", status: "failed", message: "Telegram task card sync failed.", details: { taskId: task.taskId, error: errorMessage(error).slice(0, 240) } });
      }
    }
    return { configured: true, changed };
  };

  const reserveAction = async (item, mapping, kind) => {
    const existing = state.actions.find((action) => action.updateId === item.updateId);
    if (existing) return existing;
    const action = { updateId: item.updateId, status: "processing", kind, taskId: mapping?.taskId ?? null, startedAt: iso(now()), completedAt: null, reason: null };
    state.actions.push(action);
    state.actions = state.actions.slice(-MAX_ACTIONS);
    await persist();
    return action;
  };

  const settleAction = async (action, status, reason = null) => {
    action.status = status;
    action.completedAt = iso(now());
    action.reason = reason;
    await persist();
  };

  const processReply = async (item, mapping) => {
    const attachments = [];
    if (item.attachment) {
      const downloaded = await downloadAttachment({ updateId: item.updateId, attachment: item.attachment });
      attachments.push(downloaded);
    }
    const action = await reserveAction(item, mapping, "reply");
    if (action.status !== "processing") return action.status;
    try {
      const inputText = item.text || (attachments[0] ? `Telegram ${attachments[0].kind} attached: ${attachments[0].fileName}` : "Telegram reply received.");
      const task = await store.queueHumanInput({
        taskId: mapping.taskId,
        source: "telegram",
        sourceId: `telegram:${item.updateId}`,
        text: inputText,
        attachments,
      });
      let continuationArmed = false;
      let armError = null;
      try {
        await autoContinueController.armBound({ taskId: mapping.taskId, ttlMinutes: 15 });
        continuationArmed = true;
      } catch (error) {
        armError = errorMessage(error);
      }
      const attachmentSuffix = attachments.length ? ` Attachment saved: ${attachments[0].fileName}.` : "";
      await sendMessage({ message: continuationArmed
        ? `📩 Reply saved for ${task.title}.${attachmentSuffix} Continuing the task in ChatGPT.`
        : `📩 Reply saved for ${task.title}.${attachmentSuffix} Open that task in ChatGPT if it does not continue automatically.` });
      await settleAction(action, "done", armError ? `saved_without_continue:${armError.slice(0, 160)}` : null);
      return "done";
    } catch (error) {
      await settleAction(action, "ambiguous", errorMessage(error).slice(0, 180));
      return "ambiguous";
    }
  };

  const processCommand = async (item, command) => {
    const action = await reserveAction(item, null, `command:${command}`);
    if (action.status !== "processing") return action.status;
    try {
      let message;
      if (command === "status") {
        const status = typeof getRemoteStatus === "function" ? await getRemoteStatus() : {};
        const routeId = `g-${randomId()}`.toLowerCase().replace(/[^a-z0-9-]/gu, "").slice(0, 40);
        const sent = await sendCard({ text: remoteStatusText(status), keyboard: controlKeyboard(status, routeId) });
        state.controlCards.push({
          routeId,
          messageId: sent.messageId,
          expiresAt: iso(now() + CONTROL_CARD_TTL_MS),
          pendingAction: null,
          confirmationExpiresAt: null,
        });
        state.controlCards = state.controlCards.slice(-MAX_CONTROL_CARDS);
        await persist();
      } else {
        if (command === "tasks") {
          await sendTaskPicker();
          message = null;
        } else if (command === "chat") {
          if (state.chatBridge) {
            const text = chatBridgeStatusText(state.chatBridge, state.chatBridgeTurn, state.chatBridgeAttachment);
            const routeId = ("d-" + randomId()).toLowerCase().replace(/[^a-z0-9-]/gu, "").slice(0, 40);
            const sent = await sendCard({
              text,
              keyboard: [
                [{ text: "↗ Open in ChatGPT", url: state.chatBridge.canonicalUrl }],
                [{ text: "🔌 Unbind", callbackData: "eqx:d:" + routeId }],
              ],
            });
            clearPickerMessage(sent.messageId);
            state.chatPickers.push(normalizeChatPicker({
              routeId,
              messageId: sent.messageId,
              kind: "unbind",
              target: state.chatBridge.sourceTaskId,
              label: "Unbind",
              expiresAt: iso(now() + CHAT_PICKER_TTL_MS),
            }));
            state.chatPickers = state.chatPickers.slice(-MAX_CHAT_PICKERS);
            await persist();
            message = null;
          } else message = chatBridgeStatusText(null, state.chatBridgeTurn, state.chatBridgeAttachment);
        } else if (command === "unbind") {
          const { previous, hadTurn, hadAttachment } = await clearChatBridge();
          if (previous?.sourceTaskId && mappingForTask(previous.sourceTaskId)) {
            const previousTask = await store.readInternal(previous.sourceTaskId).catch(() => null);
            if (previousTask) await syncTask(previousTask).catch(() => {});
          }
          message = previous
            ? `💬 Chat bridge unbound from ${previous.title}.${hadTurn || hadAttachment ? " Pending bridge state cleared." : ""}`
            : `💬 Chat bridge was already unbound.${hadTurn || hadAttachment ? " Pending bridge state cleared." : ""}`;
        } else message = commandHelpText();
        if (message) await sendMessage({ message });
      }
      await settleAction(action, "done");
      return "done";
    } catch (error) {
      await settleAction(action, "ambiguous", errorMessage(error).slice(0, 180));
      return "ambiguous";
    }
  };

  const processTaskCallback = async (item, mapping, actionCode) => {
    const kind = actionCode === "b" ? "chat:bind" : actionCode === "d" ? "chat:unbind-button" : actionCode === "c" ? "continue" : actionCode === "f" ? "complete" : "cancel";
    const action = await reserveAction(item, mapping, kind);
    if (action.status !== "processing") return action.status;
    try {
      if (actionCode === "b") {
        const bound = await bindTaskChat(mapping.taskId);
        await syncTask(await store.readInternal(mapping.taskId));
        if (item.callbackQueryId) await answerCallback({ callbackQueryId: item.callbackQueryId, text: "Chat bridge bound." });
        await sendMessage({ message: "💬 Chat bridge is now bound to " + bound.title + ". Send a normal Telegram message to chat there; use /unbind to stop." });
      } else if (actionCode === "d") {
        if (state.chatBridge?.sourceTaskId !== mapping.taskId) throw new Error("This Unbind button no longer matches the current Task chat.");
        await clearChatBridge();
        await syncTask(await store.readInternal(mapping.taskId));
        if (item.callbackQueryId) await answerCallback({ callbackQueryId: item.callbackQueryId, text: "Chat unbound." });
      } else if (actionCode === "c") {
        await autoContinueController.armBound({ taskId: mapping.taskId, ttlMinutes: 15 });
        if (item.callbackQueryId) await answerCallback({ callbackQueryId: item.callbackQueryId, text: "Continue armed." });
      } else if (actionCode === "f") {
        await store.finish(mapping.taskId);
        if (item.callbackQueryId) await answerCallback({ callbackQueryId: item.callbackQueryId, text: "Task marked complete." });
      } else {
        await store.cancel(mapping.taskId);
        if (item.callbackQueryId) await answerCallback({ callbackQueryId: item.callbackQueryId, text: "Task cancelled." });
      }
      await settleAction(action, "done");
      return "done";
    } catch (error) {
      if (item.callbackQueryId) await answerCallback({ callbackQueryId: item.callbackQueryId, text: errorMessage(error).slice(0, 160) }).catch(() => {});
      await settleAction(action, "ambiguous", errorMessage(error).slice(0, 180));
      return "ambiguous";
    }
  };

  const bridgeMessage = (text, binding, attachment = null) => {
    const compact = (value) => String(value || "").replace(/\s+/gu, " ").trim();
    const base = compact(text);
    const fields = [];
    if (binding?.sourceTaskId) fields.push("task_id=" + binding.sourceTaskId);
    if (attachment?.storagePath) fields.push("local_file=" + JSON.stringify(attachment.storagePath));
    const suffix = fields.length ? " [" + fields.join("; ") + "]" : "";
    const fallback = attachment ? "Use the attached local file." : "Continue from Telegram.";
    const content = base || fallback;
    const maxBase = Math.max(1, 4_000 - [...suffix].length);
    const chars = [...content];
    const bounded = chars.length > maxBase
      ? chars.slice(0, Math.max(1, maxBase - 20)).join("") + " [message truncated]"
      : content;
    return bounded + suffix;
  };

  const processPickerCallback = async (item, picker, actionCode) => {
    const kind = actionCode === "q" ? "chat:pick-task" : actionCode === "d" ? "chat:unbind-button" : "task:create-arm";
    const action = await reserveAction(item, null, kind);
    if (action.status !== "processing") return action.status;
    try {
      if (Date.parse(picker.expiresAt) <= now()) {
        if (item.callbackQueryId) await answerCallback({ callbackQueryId: item.callbackQueryId, text: "Picker expired. Send /tasks again." });
        await settleAction(action, "done", "picker_expired");
        return "done";
      }
      if (actionCode === "d") {
        if (state.chatBridge?.sourceTaskId !== picker.target) throw new Error("This Unbind button no longer matches the current Task chat.");
        const { previous, hadTurn, hadAttachment } = await clearChatBridge();
        if (previous?.sourceTaskId && mappingForTask(previous.sourceTaskId)) {
          const previousTask = await store.readInternal(previous.sourceTaskId).catch(() => null);
          if (previousTask) await syncTask(previousTask).catch(() => {});
        }
        await editCard({
          messageId: picker.messageId,
          text: previous
            ? "💬 Chat bridge unbound from " + previous.title + "." + (hadTurn || hadAttachment ? " Pending bridge state cleared." : "")
            : "💬 Chat bridge was already unbound.",
          keyboard: null,
        }).catch(() => {});
        if (item.callbackQueryId) await answerCallback({ callbackQueryId: item.callbackQueryId, text: "Chat unbound." });
        await settleAction(action, "done");
        return "done";
      }

      if (actionCode === "q") {
        const task = await store.readInternal(picker.target);
        const info = await chatInfoForTask(picker.target).catch(() => ({ canonicalUrl: null, chatBindable: false, chatSelected: false }));
        await editCard({
          messageId: picker.messageId,
          text: taskCardText(task),
          keyboard: taskKeyboard(task, picker.routeId, info.canonicalUrl, info.chatBindable, info.chatSelected),
        });
        if (item.callbackQueryId) await answerCallback({ callbackQueryId: item.callbackQueryId, text: "Task controls opened." });
        await settleAction(action, "done");
        return "done";
      }

      if (state.taskCreation) throw new Error("A new Task flow is already active. Use /unbind to clear it first.");
      state.taskCreation = normalizeTaskCreation({
        status: "awaiting_input",
        sourcePickerMessageId: picker.messageId,
        taskId: null,
        reason: null,
        createdAt: iso(now()),
        updatedAt: iso(now()),
      });
      clearPickerMessage(picker.messageId);
      await persist();
      await editCard({
        messageId: picker.messageId,
        text: "➕ New Task\nSend your next Telegram text message describing the task. Equinox Local will create the Task Capsule and open one new ChatGPT conversation for it.",
        keyboard: null,
      }).catch(() => {});
      if (item.callbackQueryId) await answerCallback({ callbackQueryId: item.callbackQueryId, text: "Send the new Task description." });
      await settleAction(action, "done");
      return "done";
    } catch (error) {
      if (item.callbackQueryId) await answerCallback({ callbackQueryId: item.callbackQueryId, text: errorMessage(error).slice(0, 160) }).catch(() => {});
      await settleAction(action, "done", errorMessage(error).slice(0, 180));
      return "done";
    }
  };

  const processNewTaskMessage = async (item) => {
    const existingAction = state.actions.find((action) => action.updateId === item.updateId);
    if (existingAction) return existingAction.status;
    const creation = state.taskCreation;
    if (!creation || creation.status !== "awaiting_input") return "done";
    const text = typeof item.text === "string" ? item.text.trim() : "";
    const action = await reserveAction(item, null, "task:create");
    if (action.status !== "processing") return action.status;
    if (!text || item.attachment) {
      await sendMessage({ message: "➕ New Task is waiting for a text description. Send text only, or use /unbind to cancel this creation flow." });
      await settleAction(action, "done", "task_description_required");
      return "done";
    }

    let task = null;
    try {
      const title = compactTaskText(text, 96) || "Telegram Task";
      task = await store.checkpoint({
        title,
        objective: text,
        completed: [],
        next: ["Start working on the Task objective supplied from Telegram."],
        references: [],
      });
      state.taskCreation = normalizeTaskCreation({
        ...creation,
        status: "creating",
        taskId: task.taskId,
        reason: null,
        updatedAt: iso(now()),
      });
      await persist();

      const result = await startTaskChat({ taskId: task.taskId, checkpointRevision: task.checkpointRevision });
      if (result?.confirmed !== true || !result?.binding) throw new Error("New Task ChatGPT conversation was not confirmed.");
      await store.bindChat({ taskId: task.taskId, binding: result.binding });
      const boundTask = await store.readInternal(task.taskId);
      if (!boundTask?.chatBinding?.canonicalUrl) throw new Error("Durable Task chat binding could not be read back after persistence.");
      state.chatBridge = normalizeChatBridgeBinding({
        sourceTaskId: task.taskId,
        ...boundTask.chatBinding,
        title: task.title,
        boundAt: iso(now()),
      });
      state.chatBridgeTurn = normalizeChatBridgeTurn({
        deliveryId: chatBridgeDeliveryId(item.updateId),
        sourceUpdateId: item.updateId,
        status: result.userEpoch ? "waiting" : "identity_wait",
        binding: state.chatBridge,
        userEpoch: result.userEpoch || null,
        previousAssistantTurnKey: null,
        assistantTurnKey: null,
        reason: null,
        createdAt: iso(now()),
        updatedAt: iso(now()),
      });
      state.taskCreation = null;
      state.chatPickers = [];
      await persist();
      await syncTask(task);
      await sendMessage({ message: "🆕 Task created: " + task.title + "\n" + task.taskId + "\nA new ChatGPT conversation is automatically bound to this Task. Waiting for its first answer…" });
      await settleAction(action, "done");
      return "done";
    } catch (error) {
      if (error?.code === "CHAT_BRIDGE_CREATE_NOT_STARTED" && task?.taskId) {
        await store.cancel(task.taskId).catch(() => {});
        if (typeof store.remove === "function") await store.remove(task.taskId).catch(() => {});
        state.taskCreation = null;
        state.chatPickers = [];
        await persist();
        const safeReason = errorMessage(error).slice(0, 140);
        await sendMessage({ message: "⚠️ New Task could not start before any prompt was submitted, so the temporary Task was rolled back. " + safeReason + " Use /tasks → ➕ New task to try again." }).catch(() => {});
        await settleAction(action, "done", "task_chat_not_started: " + safeReason);
        return "done";
      }
      if (task?.taskId) {
        const recoveredTask = await store.readInternal(task.taskId).catch(() => null);
        if (recoveredTask?.status === "active" && recoveredTask.chatBinding?.canonicalUrl) {
          try {
            state.chatBridge = normalizeChatBridgeBinding({
              sourceTaskId: recoveredTask.taskId,
              ...recoveredTask.chatBinding,
              title: String(recoveredTask.title || task.title || "ChatGPT").slice(0, 200),
              boundAt: iso(now()),
            });
            state.chatBridgeTurn = null;
            state.chatBridgeAttachment = null;
            state.taskCreation = null;
            state.chatPickers = [];
            await persist();
            await syncTask(recoveredTask).catch(() => {});
            const recoveryReason = errorMessage(error).slice(0, 140);
            await sendMessage({ message: "🆕 Task created and its ChatGPT conversation binding was preserved for " + recoveredTask.taskId + ". First-response tracking could not be confirmed, so no browser action was replayed. The Task chat remains selected." }).catch(() => {});
            emit({
              component: "telegram-task-inbox",
              type: "telegram.task_creation_recovered",
              severity: "info",
              status: "recovered",
              message: "Recovered Telegram New Task after its durable chat binding had already been persisted.",
              details: { taskId: recoveredTask.taskId, reason: recoveryReason },
            });
            await settleAction(action, "done", "task_chat_binding_recovered: " + recoveryReason);
            return "done";
          } catch {}
        }
      }
      state.taskCreation = normalizeTaskCreation({
        ...(state.taskCreation || creation),
        status: "ambiguous",
        taskId: task?.taskId || state.taskCreation?.taskId || null,
        reason: errorMessage(error).slice(0, 180),
        updatedAt: iso(now()),
      });
      await persist();
      await sendMessage({ message: task
        ? "⚠️ Task Capsule was created as " + task.taskId + ", but its new ChatGPT conversation could not be confirmed. The browser mutation will not be replayed automatically."
        : "⚠️ New Task creation failed before a Task Capsule could be created: " + errorMessage(error).slice(0, 180) }).catch(() => {});
      await settleAction(action, "ambiguous", errorMessage(error).slice(0, 180));
      return "ambiguous";
    }
  };

  const processUnboundMessage = async (item) => {
    const action = await reserveAction(item, null, "chat:unbound");
    if (action.status !== "processing") return action.status;
    await sendMessage({ message: "💬 No Task chat is selected. Use /tasks to switch to an active Task, or choose ➕ New task there." });
    await settleAction(action, "done", "task_chat_required");
    return "done";
  };

  const processChatBridgeMessage = async (item) => {
    const existingAction = state.actions.find((action) => action.updateId === item.updateId);
    if (existingAction) return existingAction.status;
    if (!state.chatBridge) {
      const action = await reserveAction(item, null, "chat:send");
      await sendMessage({ message: chatBridgeStatusText(null, state.chatBridgeTurn, state.chatBridgeAttachment) });
      await settleAction(action, "done", "chat_bridge_unbound");
      return "done";
    }
    if (!state.chatBridgeTurn && !state.chatBridgeAttachment && state.chatBridge?.sourceTaskId) {
      const boundTask = await store.readInternal(state.chatBridge.sourceTaskId).catch(() => null);
      if (!boundTask || boundTask.status !== "active") {
        const retiredTitle = state.chatBridge.title;
        await clearChatBridge();
        const action = await reserveAction(item, null, "chat:unbound");
        await sendMessage({ message: `💬 ${retiredTitle || "The selected Task"} is no longer active, so its Telegram chat binding was cleared. Use /tasks to select an active Task.` });
        await settleAction(action, "done", "task_terminal_unbound");
        return "done";
      }
    }
    if (state.chatBridgeTurn || state.chatBridgeAttachment) {
      const action = await reserveAction(item, null, "chat:send");
      const blockedStatus = state.chatBridgeTurn?.status || state.chatBridgeAttachment?.status;
      await sendMessage({ message: blockedStatus === "ambiguous"
        ? "⚠️ The previous Chat Bridge response delivery is ambiguous. Use /chat to inspect it or /unbind to clear it before sending another message."
        : "⏳ The previous Chat Bridge turn is still waiting for its final response. Send another message after it finishes, or use /unbind to abandon it." });
      await settleAction(action, "done", `chat_turn_${blockedStatus}`);
      return "done";
    }
    let downloadedAttachment = null;
    if (item.attachment) downloadedAttachment = await downloadAttachment({ updateId: item.updateId, attachment: item.attachment });
    const action = await reserveAction(item, null, "chat:send");
    if (action.status !== "processing") return action.status;
    try {
      const text = typeof item.text === "string" ? item.text.trim() : "";
      if (!text && !downloadedAttachment) {
        await sendMessage({ message: "Send a text message or one attachment for Chat Bridge, or reply to a task card for task-specific input." });
        await settleAction(action, "done", "empty_chat_message");
        return "done";
      }
      try {
        const deliveryId = chatBridgeDeliveryId(item.updateId);
        let deliveryText = bridgeMessage(text, state.chatBridge, downloadedAttachment);
        if (downloadedAttachment) {
          state.chatBridgeAttachment = normalizeChatBridgeAttachment({
            sourceTaskId: state.chatBridge.sourceTaskId,
            sourceUpdateId: item.updateId,
            deliveryId,
            status: "prepared",
            attachment: downloadedAttachment,
            createdAt: iso(now()),
            updatedAt: iso(now()),
          });
          await persist();
        }
        const result = await deliverChatMessage({ binding: state.chatBridge, deliveryId, text: deliveryText });
        if (result?.confirmed === true) {
          if (Number.isInteger(result.tabId) && state.chatBridge && result.tabId !== state.chatBridge.tabId) {
            state.chatBridge = normalizeChatBridgeBinding({ ...state.chatBridge, tabId: result.tabId });
          }
          if (state.chatBridgeAttachment?.deliveryId === result.deliveryId) {
            state.chatBridgeAttachment.status = "active";
            state.chatBridgeAttachment.updatedAt = iso(now());
          }
          state.chatBridgeTurn = normalizeChatBridgeTurn({
            deliveryId: result.deliveryId,
            sourceUpdateId: item.updateId,
            status: "waiting",
            binding: state.chatBridge,
            userEpoch: result.userEpoch,
            previousAssistantTurnKey: result.previousAssistantTurnKey,
            assistantTurnKey: null,
            reason: null,
            createdAt: iso(now()),
            updatedAt: iso(now()),
          });
          await persist();
          await settleAction(action, "done");
          return "done";
        }
        if (result?.duplicatePrevented === true) {
          if (state.chatBridgeAttachment?.deliveryId === deliveryId) {
            state.chatBridgeAttachment.status = "ambiguous";
            state.chatBridgeAttachment.updatedAt = iso(now());
            await persist();
          }
          await settleAction(action, "done", "browser_duplicate_prevented");
          return "done";
        }
        throw Object.assign(new Error("Chat Bridge delivery was not confirmed."), { code: "CHAT_BRIDGE_AMBIGUOUS" });
      } catch (error) {
        if (error?.code === "CHAT_BRIDGE_NOT_READY") {
          if (state.chatBridgeAttachment?.sourceUpdateId === item.updateId) {
            state.chatBridgeAttachment = null;
            await persist();
          }
          await sendMessage({ message: `⏳ ${errorMessage(error).slice(0, 220)}` }).catch(() => {});
          await settleAction(action, "done", "chat_not_ready");
          return "done";
        }
        if (state.chatBridgeAttachment?.sourceUpdateId === item.updateId) {
          state.chatBridgeAttachment.status = "ambiguous";
          state.chatBridgeAttachment.updatedAt = iso(now());
          await persist();
        }
        await sendMessage({ message: "⚠️ Chat Bridge delivery became ambiguous. It will not be replayed automatically. Check the bound ChatGPT conversation before sending again." }).catch(() => {});
        await settleAction(action, "ambiguous", errorMessage(error).slice(0, 180));
        return "ambiguous";
      }
    } catch (error) {
      await settleAction(action, "ambiguous", errorMessage(error).slice(0, 180));
      return "ambiguous";
    }
  };

  const bridgeTelegramText = (response) => {
    const text = String(response.text || "").trim();
    if (!response.truncated) return text;
    const suffix = "\n\n[ChatGPT response truncated at the 12,000-character bridge limit.]";
    const keep = Math.max(1, 12_000 - [...suffix].length);
    return `${[...text].slice(0, keep).join("")}${suffix}`;
  };

  const processChatBridgeResponse = async () => {
    await initialize();
    const turn = state.chatBridgeTurn;
    if (!turn) return { status: "idle" };
    if (turn.status === "identity_wait") {
      try {
        const identity = await inspectChatIdentity({ binding: turn.binding });
        if (identity?.binding?.tabId && identity.binding.tabId !== turn.binding.tabId) {
          turn.binding = normalizeChatBridgeBinding({ ...turn.binding, tabId: identity.binding.tabId });
          if (state.chatBridge?.conversationId === turn.binding.conversationId) state.chatBridge = normalizeChatBridgeBinding({ ...state.chatBridge, tabId: identity.binding.tabId });
          await store.bindChat({ taskId: turn.binding.sourceTaskId, binding: turn.binding }).catch(() => {});
        }
        if (identity?.status !== "ready" || !identity.userEpoch) return { status: "identity_wait" };
        turn.userEpoch = identity.userEpoch;
        turn.status = "waiting";
        turn.updatedAt = iso(now());
        await persist();
      } catch (error) {
        if (error?.code === "CHAT_BRIDGE_DRIFTED") {
          turn.status = "ambiguous";
          turn.reason = errorMessage(error).slice(0, 180);
          turn.updatedAt = iso(now());
          await persist();
          return { status: "ambiguous" };
        }
        return { status: "identity_wait" };
      }
    }
    if (turn.status !== "waiting") return { status: turn.status };
    let response;
    try {
      response = await readChatResponse({
        binding: turn.binding,
        userEpoch: turn.userEpoch,
        previousAssistantTurnKey: turn.previousAssistantTurnKey,
      });
      if (Number.isInteger(response?.tabId) && response.tabId !== turn.binding.tabId) {
        turn.binding = normalizeChatBridgeBinding({ ...turn.binding, tabId: response.tabId });
        if (state.chatBridge
          && state.chatBridge.browserContext === turn.binding.browserContext
          && state.chatBridge.browserInstanceId === turn.binding.browserInstanceId
          && state.chatBridge.conversationId === turn.binding.conversationId) {
          state.chatBridge = normalizeChatBridgeBinding({ ...state.chatBridge, tabId: response.tabId });
        }
        turn.updatedAt = iso(now());
        await persist();
      }
      if (response?.status === "waiting") return { status: "waiting" };
      if (response?.status !== "ready") throw new Error("Chat Bridge response reader returned an invalid state.");
    } catch (error) {
      if (error?.code !== "CHAT_BRIDGE_DRIFTED") return { status: "waiting" };
      turn.status = "ambiguous";
      turn.reason = errorMessage(error).slice(0, 180);
      turn.updatedAt = iso(now());
      await persist();
      return { status: "ambiguous" };
    }

    turn.status = "sending";
    turn.assistantTurnKey = response.assistantTurnKey;
    turn.reason = null;
    turn.updatedAt = iso(now());
    await persist();
    try {
      await sendMessage({ message: bridgeTelegramText(response) });
      state.chatBridgeTurn = null;
      state.chatBridgeAttachment = null;
      await persist();
      return { status: "sent" };
    } catch (error) {
      turn.status = "ambiguous";
      turn.reason = `telegram_send_ambiguous:${errorMessage(error).slice(0, 150)}`;
      turn.updatedAt = iso(now());
      await persist();
      return { status: "ambiguous" };
    }
  };

  const refreshControlCard = async (control) => {
    const status = typeof getRemoteStatus === "function" ? await getRemoteStatus() : {};
    await editCard({ messageId: control.messageId, text: remoteStatusText(status), keyboard: controlKeyboard(status, control.routeId) });
  };

  const processControlCallback = async (item, control, actionCode) => {
    const kind = actionCode === "p" ? "control:pause-confirm"
      : actionCode === "u" ? "control:resume"
        : actionCode === "r" ? "control:restart-confirm"
          : actionCode === "e" ? "control:pause"
            : actionCode === "t" ? "control:restart"
              : "control:back";
    const action = await reserveAction(item, null, kind);
    if (action.status !== "processing") return action.status;
    try {
      if (Date.parse(control.expiresAt) <= now()) {
        if (item.callbackQueryId) await answerCallback({ callbackQueryId: item.callbackQueryId, text: "Control expired. Send /status again." });
        await settleAction(action, "done", "control_expired");
        return "done";
      }

      if (actionCode === "p" || actionCode === "r") {
        const pendingAction = actionCode === "p" ? "pause" : "restart";
        const status = typeof getRemoteStatus === "function" ? await getRemoteStatus() : {};
        control.pendingAction = pendingAction;
        control.confirmationExpiresAt = iso(now() + CONTROL_CONFIRM_TTL_MS);
        await persist();
        await editCard({
          messageId: control.messageId,
          text: controlConfirmationText(status, pendingAction),
          keyboard: controlConfirmationKeyboard(control.routeId, pendingAction),
        });
        if (item.callbackQueryId) await answerCallback({ callbackQueryId: item.callbackQueryId, text: "Confirmation required." });
      } else if (actionCode === "n") {
        control.pendingAction = null;
        control.confirmationExpiresAt = null;
        await persist();
        await refreshControlCard(control);
        if (item.callbackQueryId) await answerCallback({ callbackQueryId: item.callbackQueryId, text: "Cancelled." });
      } else if (actionCode === "u") {
        await resumeAgent();
        control.pendingAction = null;
        control.confirmationExpiresAt = null;
        await persist();
        await refreshControlCard(control);
        if (item.callbackQueryId) await answerCallback({ callbackQueryId: item.callbackQueryId, text: "Agent resumed." });
      } else if (actionCode === "e" || actionCode === "t") {
        const expectedAction = actionCode === "e" ? "pause" : "restart";
        const pendingAction = control.pendingAction;
        const confirmationActive = pendingAction === expectedAction && control.confirmationExpiresAt && Date.parse(control.confirmationExpiresAt) > now();
        if (!confirmationActive) {
          control.pendingAction = null;
          control.confirmationExpiresAt = null;
          await persist();
          await refreshControlCard(control);
          if (item.callbackQueryId) await answerCallback({ callbackQueryId: item.callbackQueryId, text: "Confirmation expired. Try again." });
          await settleAction(action, "done", "confirmation_expired");
          return "done";
        }
        control.pendingAction = null;
        control.confirmationExpiresAt = null;
        await persist();
        if (pendingAction === "pause") {
          await pauseAgent();
          await refreshControlCard(control);
          if (item.callbackQueryId) await answerCallback({ callbackQueryId: item.callbackQueryId, text: "Emergency Stop enabled." });
        } else {
          await editCard({ messageId: control.messageId, text: "🔄 Equinox Local restart requested. The connection may disconnect briefly.", keyboard: null });
          if (item.callbackQueryId) await answerCallback({ callbackQueryId: item.callbackQueryId, text: "Restart requested." });
          await requestRestart();
        }
      }
      await settleAction(action, "done");
      return "done";
    } catch (error) {
      if (item.callbackQueryId) await answerCallback({ callbackQueryId: item.callbackQueryId, text: errorMessage(error).slice(0, 160) }).catch(() => {});
      await settleAction(action, "ambiguous", errorMessage(error).slice(0, 180));
      return "ambiguous";
    }
  };

  const processPending = async () => {
    await initialize();
    const pending = await readPending();
    let handled = 0;
    for (const item of pending) {
      const existing = state.actions.find((action) => action.updateId === item.updateId);
      if (existing && ["done", "ambiguous"].includes(existing.status)) {
        await acknowledgeUpdate(item.updateId);
        continue;
      }
      if (item.kind === "message") {
        const command = parseTelegramCommand(item.text, Boolean(item.attachment));
        if (command) {
          await processCommand(item, command);
          await acknowledgeUpdate(item.updateId);
          handled += 1;
          continue;
        }
      }
      if (item.kind === "message" && Number.isInteger(item.replyToMessageId)) {
        const mapping = mappingForMessage(item.replyToMessageId);
        if (mapping) {
          await processReply(item, mapping);
          await acknowledgeUpdate(item.updateId);
          handled += 1;
          continue;
        }
      }
      if (item.kind === "callback") {
        const match = typeof item.data === "string" ? item.data.match(CALLBACK_RE) : null;
        const actionCode = match?.[1] ?? null;
        const routeId = match?.[2] ?? null;
        const mapping = routeId ? mappingForRoute(routeId) : null;
        if (mapping && mapping.messageId === item.messageId && ["b", "c", "d", "f", "x"].includes(actionCode)) {
          await processTaskCallback(item, mapping, actionCode);
          await acknowledgeUpdate(item.updateId);
          handled += 1;
          continue;
        }
        const picker = routeId ? pickerForRoute(routeId) : null;
        if (picker && picker.messageId === item.messageId && picker.kind === "task" && ["b", "c", "d", "f", "x"].includes(actionCode)) {
          await processTaskCallback(item, { taskId: picker.target, messageId: picker.messageId }, actionCode);
          const task = await store.readInternal(picker.target).catch(() => null);
          if (task) {
            const info = await chatInfoForTask(picker.target).catch(() => ({ canonicalUrl: null, chatBindable: false, chatSelected: false }));
            await editCard({ messageId: picker.messageId, text: taskCardText(task), keyboard: taskKeyboard(task, picker.routeId, info.canonicalUrl, info.chatBindable, info.chatSelected) }).catch(() => {});
          }
          await acknowledgeUpdate(item.updateId);
          handled += 1;
          continue;
        }
        if (picker && picker.messageId === item.messageId && ((actionCode === "q" && picker.kind === "task") || (actionCode === "a" && picker.kind === "new") || (actionCode === "d" && picker.kind === "unbind"))) {
          await processPickerCallback(item, picker, actionCode);
          await acknowledgeUpdate(item.updateId);
          handled += 1;
          continue;
        }
        const control = routeId ? controlForRoute(routeId) : null;
        if (control && control.messageId === item.messageId && ["p", "u", "r", "e", "t", "n"].includes(actionCode)) {
          await processControlCallback(item, control, actionCode);
          await acknowledgeUpdate(item.updateId);
          handled += 1;
          continue;
        }
        if (match && item.callbackQueryId) {
          await answerCallback({ callbackQueryId: item.callbackQueryId, text: "Control expired or is no longer valid." }).catch(() => {});
          await acknowledgeUpdate(item.updateId);
          handled += 1;
          continue;
        }
      }
      if (item.kind === "message" && state.taskCreation?.status === "awaiting_input") {
        await processNewTaskMessage(item);
        await acknowledgeUpdate(item.updateId);
        handled += 1;
        continue;
      }
      if (item.kind === "message" && state.chatBridge) {
        await processChatBridgeMessage(item);
        await acknowledgeUpdate(item.updateId);
        handled += 1;
        continue;
      }
      if (item.kind === "message") {
        await processUnboundMessage(item);
        await acknowledgeUpdate(item.updateId);
        handled += 1;
        continue;
      }
      await acknowledgeUpdate(item.updateId);
    }
    return { handled, pending: pending.length };
  };

  const discardPending = async () => {
    const pending = await readPending();
    for (const item of pending) await acknowledgeUpdate(item.updateId);
    return pending.length;
  };

  const maybeSendTyping = async () => {
    if (typeof getAgentActivity !== "function" || typeof sendTyping !== "function") return false;
    const activity = await getAgentActivity().catch(() => null);
    if (activity?.working !== true) return false;
    await sendTyping().catch(() => {});
    return true;
  };

  const cycle = async () => {
    const status = await getTelegramStatus();
    if (!status?.ready) return { configured: false };
    const remoteControlEnabled = status.remoteControl?.enabled !== false;
    if (!remoteControlEnabled) {
      await pollInbound();
      const discarded = await discardPending();
      return { configured: true, remoteControlEnabled: false, discarded };
    }
    const typing = await maybeSendTyping();
    const bridgeBefore = await processChatBridgeResponse();
    await pollInbound();
    const processed = await processPending();
    const bridgeAfter = await processChatBridgeResponse();
    const synced = await syncTasks();
    return { configured: true, remoteControlEnabled: true, typing, ...processed, bridgeBefore: bridgeBefore.status, bridgeAfter: bridgeAfter.status, changed: synced.changed };
  };

  const schedule = (delayMs) => {
    if (stopped || timer) return;
    timer = setTimeoutImpl(() => {
      timer = null;
      inFlight = Promise.resolve().then(cycle);
      void inFlight.then(
        () => { inFlight = null; backoffMs = pollMs; schedule(pollMs); },
        (error) => {
          inFlight = null;
          emit({ component: "telegram-task-inbox", type: "telegram.poll_failed", severity: "warn", status: "failed", message: "Telegram task inbox poll failed.", details: { error: errorMessage(error).slice(0, 240) } });
          backoffMs = Math.min(MAX_BACKOFF_MS, Math.max(pollMs, backoffMs * 2));
          schedule(backoffMs);
        },
      );
    }, delayMs);
    timer?.unref?.();
  };

  const start = async () => {
    await initialize();
    stopped = false;
    schedule(0);
    return snapshot();
  };

  const reset = async ({ persistState = false } = {}) => {
    if (timer) clearTimeoutImpl(timer);
    timer = null;
    if (inFlight) await Promise.allSettled([inFlight]);
    state = emptyState(now);
    backoffMs = pollMs;
    if (persistState) await persist();
    if (!stopped) schedule(pollMs);
    return snapshot();
  };

  const shutdown = async () => {
    stopped = true;
    if (timer) clearTimeoutImpl(timer);
    timer = null;
    if (inFlight) await Promise.allSettled([inFlight]);
    return snapshot();
  };


  const snapshot = () => Object.freeze({
    running: !stopped,
    mappings: state?.mappings?.length ?? 0,
    controlCards: state?.controlCards?.length ?? 0,
    chatPickers: state?.chatPickers?.length ?? 0,
    taskCreationStatus: state?.taskCreation?.status ?? null,
    chatBridgeBound: Boolean(state?.chatBridge),
    chatBridgeTurnStatus: state?.chatBridgeTurn?.status ?? null,
    chatBridgeAttachmentStatus: state?.chatBridgeAttachment?.status ?? null,
    ambiguousActions: state?.actions?.filter((item) => item.status === "ambiguous").length ?? 0,
    backoffMs,
  });

  return Object.freeze({ initialize, start, shutdown, reset, cycle, syncTasks, processPending, processChatBridgeResponse, snapshot });
}
