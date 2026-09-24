import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  readBoundedNormalFile,
  SAFE_FILE_ERROR_CODES,
} from "./equinox-local-safe-file.js";
import { inspectImageBuffer, MAX_IMAGE_VIEW_BYTES } from "./equinox-local-image-tools.js";

const TELEGRAM_API_BASE = "https://api.telegram.org";
const TELEGRAM_REMOTE_COMMANDS = Object.freeze([
  Object.freeze({ command: "status", description: "Show Local status and remote controls" }),
  Object.freeze({ command: "tasks", description: "List active Task Capsules" }),
  Object.freeze({ command: "chat", description: "Show the bound ChatGPT conversation" }),
  Object.freeze({ command: "unbind", description: "Stop normal messages from going to ChatGPT" }),
  Object.freeze({ command: "help", description: "Show Telegram controls" }),
]);
const MAX_CREDENTIAL_BYTES = 16 * 1024;
const MAX_PAIRING_BYTES = 16 * 1024;
const MAX_INBOX_BYTES = 128 * 1024;
const MAX_INBOX_MESSAGES = 50;
const MAX_INBOUND_TEXT_CHARS = 4_000;
export const MAX_TELEGRAM_DOWNLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_TELEGRAM_PHOTO_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_TELEGRAM_DOCUMENT_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_TELEGRAM_KNOWN_DOWNLOAD_ROOTS = 20;
const PAIRING_TTL_MS = 10 * 60 * 1000;
const MAX_UPDATE_BATCH = 20;
const MAX_MESSAGE_CHARS = 12_000;
const MESSAGE_CHUNK_CHARS = 4_000;
const REQUEST_TIMEOUT_MS = 10_000;
const FILE_REQUEST_TIMEOUT_MS = 3 * 60 * 1000;
const BOT_TOKEN_PATTERN = /^\d{5,20}:[A-Za-z0-9_-]{20,80}$/u;
const TELEGRAM_USER_ID_PATTERN = /^[1-9]\d{0,15}$/u;

function credentialError(message = "Telegram credentials need attention.") {
  const error = new Error(message);
  error.code = "EQUINOX_TELEGRAM_CREDENTIALS";
  return error;
}

function validateBotToken(value) {
  if (typeof value !== "string" || !BOT_TOKEN_PATTERN.test(value)) {
    throw new Error("Telegram bot token format is invalid.");
  }
  return value;
}

function validateTelegramUserId(value) {
  const normalized = typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : typeof value === "string" ? value.trim() : "";
  if (!TELEGRAM_USER_ID_PATTERN.test(normalized)) {
    throw new Error("Telegram user ID must be a positive numeric Telegram account identifier. Groups and channels are not supported.");
  }
  return normalized;
}

export function validateTelegramConnectionInput(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Telegram connection body must be a JSON object.");
  }
  const keys = Object.keys(body).sort();
  if (keys.length !== 2 || keys[0] !== "botToken" || keys[1] !== "telegramUserId") {
    throw new Error("Telegram connection accepts only botToken and telegramUserId.");
  }
  return Object.freeze({
    botToken: validateBotToken(body.botToken),
    telegramUserId: validateTelegramUserId(body.telegramUserId),
  });
}

export function validateTelegramMessage(message) {
  if (typeof message !== "string") throw new Error("Telegram message must be text.");
  const length = [...message].length;
  if (length < 1 || length > MAX_MESSAGE_CHARS || !message.trim()) {
    throw new Error(`Telegram message must contain 1-${MAX_MESSAGE_CHARS} characters.`);
  }
  if (message.includes("\0")) throw new Error("Telegram message contains an unsupported null character.");
  return message;
}

export function defaultTelegramCredentialPath(homeDir = os.homedir()) {
  return path.join(
    homeDir,
    "Library",
    "Application Support",
    "Equinox Local",
    "secrets",
    "telegram.json",
  );
}

export function defaultTelegramPairingPath(homeDir = os.homedir()) {
  return path.join(
    homeDir,
    "Library",
    "Application Support",
    "Equinox Local",
    "secrets",
    "telegram-pairing.json",
  );
}

export function defaultTelegramInboxPath(homeDir = os.homedir()) {
  return path.join(
    homeDir,
    "Library",
    "Application Support",
    "Equinox Local",
    "secrets",
    "telegram-inbox.json",
  );
}

export function defaultTelegramTaskStatePath(homeDir = os.homedir()) {
  return path.join(
    homeDir,
    "Library",
    "Application Support",
    "Equinox Local",
    "secrets",
    "telegram-task-state.json",
  );
}

export function defaultTelegramAttachmentRoot(homeDir = os.homedir()) {
  return path.join(homeDir, "Downloads", "Equinox Local", "Telegram");
}

export function legacyTelegramAttachmentRoot(homeDir = os.homedir()) {
  return path.join(homeDir, "Library", "Application Support", "Equinox Local", "Telegram Inbox");
}

export function defaultTelegramDownloadSettingsPath(homeDir = os.homedir()) {
  return path.join(homeDir, "Library", "Application Support", "Equinox Local", "settings", "telegram-downloads.json");
}

export function defaultTelegramRemoteControlSettingsPath(homeDir = os.homedir()) {
  return path.join(homeDir, "Library", "Application Support", "Equinox Local", "settings", "telegram-remote-control.json");
}

async function ensurePrivateDirectory(directory, { fsImpl = fs } = {}) {
  await fsImpl.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fsImpl.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw credentialError("Telegram credential directory is unsafe.");
  }
  await fsImpl.chmod(directory, 0o700);
}

async function atomicWriteCredential(filePath, contents, { fsImpl = fs } = {}) {
  if (typeof contents !== "string" || Buffer.byteLength(contents, "utf8") > MAX_INBOX_BYTES) {
    throw new Error("Telegram private state payload is invalid or too large.");
  }
  const parent = path.dirname(filePath);
  await ensurePrivateDirectory(parent, { fsImpl });
  const temp = path.join(parent, `.equinox-telegram-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  try {
    // Telegram intentionally persists only bounded, validated private state (pairing/inbox/credentials)
    // to fixed Equinox Local-owned paths. Network-derived fields are normalized before reaching here.
    // lgtm[js/http-to-file-access]
    await fsImpl.writeFile(temp, contents, { flag: "wx", mode: 0o600 });
    await fsImpl.rename(temp, filePath);
    await fsImpl.chmod(filePath, 0o600);
  } catch (error) {
    await fsImpl.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function readPrivateJson(filePath, { fsImpl = fs, maxBytes, label }) {
  let text;
  let stat;
  try {
    ({ data: text, stat } = await readBoundedNormalFile(filePath, {
      fsImpl, minBytes: 1, maxBytes, encoding: "utf8", label,
    }));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if ((stat.mode & 0o777) !== 0o600) throw credentialError(`${label} permissions need attention.`);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (Number.isInteger(uid) && Number.isInteger(stat.uid) && stat.uid !== uid) {
    throw credentialError(`${label} ownership needs attention.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw credentialError(`${label} is invalid.`);
  }
}

async function writePrivateJson(filePath, value, { fsImpl = fs } = {}) {
  await atomicWriteCredential(filePath, `${JSON.stringify(value, null, 2)}\n`, { fsImpl });
}

function sanitizeTelegramLabel(value, maxChars = 64) {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[\u0000-\u001F\u007F]/gu, " ").replace(/\s+/gu, " ").trim();
  if (!normalized) return null;
  return [...normalized].slice(0, maxChars).join("");
}

function telegramUserHint(userId) {
  const value = validateTelegramUserId(userId);
  return `…${value.slice(-4)}`;
}

async function readTelegramCredentials({
  credentialPath = defaultTelegramCredentialPath(),
  fsImpl = fs,
} = {}) {
  let text;
  let stat;
  try {
    ({ data: text, stat } = await readBoundedNormalFile(credentialPath, {
      fsImpl,
      minBytes: 1,
      maxBytes: MAX_CREDENTIAL_BYTES,
      encoding: "utf8",
      label: "Telegram credential file",
    }));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (
      error?.code === SAFE_FILE_ERROR_CODES.notNormal ||
      error?.code === SAFE_FILE_ERROR_CODES.tooSmall ||
      error?.code === SAFE_FILE_ERROR_CODES.tooLarge
    ) {
      throw credentialError();
    }
    throw error;
  }
  if ((stat.mode & 0o777) !== 0o600) throw credentialError();
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (Number.isInteger(uid) && Number.isInteger(stat.uid) && stat.uid !== uid) throw credentialError();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw credentialError();
  }
  if (parsed?.version === 1) {
    return Object.freeze({
      botToken: validateBotToken(parsed.botToken),
      telegramUserId: validateTelegramUserId(parsed.chatId),
    });
  }
  if (parsed?.version !== 2) throw credentialError();
  return Object.freeze({
    botToken: validateBotToken(parsed.botToken),
    telegramUserId: validateTelegramUserId(parsed.telegramUserId),
  });
}

function telegramStatusFromCredential(credential) {
  if (!credential) {
    return Object.freeze({
      configured: false,
      ready: false,
      needsAttention: false,
      userIdHint: null,
    });
  }
  const suffix = credential.telegramUserId.slice(-4);
  return Object.freeze({
    configured: true,
    ready: true,
    needsAttention: false,
    userIdHint: `…${suffix}`,
  });
}

export async function getTelegramIntegrationStatus(options = {}) {
  try {
    const credential = await readTelegramCredentials(options);
    const base = telegramStatusFromCredential(credential);
    const pairing = await getTelegramPairingStatus(options);
    let pendingInboundCount = 0;
    try {
      const inbox = await readTelegramInboxState(options);
      pendingInboundCount = inbox.pending.length;
    } catch {
      pendingInboundCount = 0;
    }
    const remoteControl = await getTelegramRemoteControlSettings(options);
    return Object.freeze({ ...base, pairing, pendingInboundCount, remoteControl });
  } catch {
    return Object.freeze({
      configured: false, ready: false, needsAttention: true, userIdHint: null,
      pairing: pairingPublicState(null), pendingInboundCount: 0, remoteControl: { enabled: true },
    });
  }
}

async function callTelegramJson({
  botToken,
  method,
  body = {},
  fetchImpl = globalThis.fetch,
} = {}) {
  const token = validateBotToken(botToken);
  if (typeof method !== "string" || !/^[A-Za-z][A-Za-z0-9]+$/u.test(method)) {
    throw new Error("Telegram API method is invalid.");
  }
  if (typeof fetchImpl !== "function") throw new Error("Telegram HTTP client is unavailable.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref?.();
  let response;
  try {
    response = await fetchImpl(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: controller.signal,
    });
  } catch {
    throw new Error("Telegram API connection failed.");
  } finally {
    clearTimeout(timer);
  }
  if (!response?.ok) {
    let failurePayload = null;
    try { failurePayload = await response.json(); } catch {}
    let failure;
    if (response?.status === 409) failure = new Error("Telegram bot has an active webhook. Remove the webhook before pairing it with Equinox Local.");
    else failure = mapTelegramFailure(response?.status, failurePayload?.description);
    failure.telegramStatus = response?.status ?? null;
    throw failure;
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Telegram API returned an invalid response.");
  }
  if (payload?.ok !== true) throw new Error("Telegram API returned an unsuccessful response.");
  return payload.result;
}

export async function sendTelegramTyping({
  credentialPath = defaultTelegramCredentialPath(),
  fsImpl = fs,
  fetchImpl = globalThis.fetch,
} = {}) {
  const credential = await readTelegramCredentials({ credentialPath, fsImpl });
  if (!credential) return Object.freeze({ configured: false, sent: false });
  await callTelegramJson({
    botToken: credential.botToken,
    method: "sendChatAction",
    body: { chat_id: credential.telegramUserId, action: "typing" },
    fetchImpl,
  });
  return Object.freeze({ configured: true, sent: true });
}

function maxNextUpdateId(updates, fallback = 0) {
  let next = Number.isSafeInteger(fallback) && fallback >= 0 ? fallback : 0;
  for (const update of Array.isArray(updates) ? updates : []) {
    if (Number.isSafeInteger(update?.update_id) && update.update_id >= 0) {
      next = Math.max(next, update.update_id + 1);
    }
  }
  return next;
}

function pairingPublicState(state) {
  if (!state) return Object.freeze({ active: false, candidateFound: false, botUsername: null, expiresAt: null, candidateLabel: null, userIdHint: null });
  const candidate = state.candidate || null;
  return Object.freeze({
    active: true,
    candidateFound: Boolean(candidate),
    botUsername: state.botUsername || null,
    expiresAt: state.expiresAt,
    candidateLabel: candidate?.label || null,
    userIdHint: candidate?.telegramUserId ? telegramUserHint(candidate.telegramUserId) : null,
  });
}

async function readTelegramPairingState({ pairingPath = defaultTelegramPairingPath(), fsImpl = fs, now = () => Date.now() } = {}) {
  const parsed = await readPrivateJson(pairingPath, { fsImpl, maxBytes: MAX_PAIRING_BYTES, label: "Telegram pairing state" });
  if (!parsed) return null;
  if (parsed.version !== 1 || typeof parsed.expiresAt !== "string" || !Number.isFinite(Date.parse(parsed.expiresAt))) {
    throw credentialError("Telegram pairing state is invalid.");
  }
  const state = {
    version: 1,
    botToken: validateBotToken(parsed.botToken),
    botUsername: sanitizeTelegramLabel(parsed.botUsername),
    expiresAt: new Date(parsed.expiresAt).toISOString(),
    nextUpdateId: Number.isSafeInteger(parsed.nextUpdateId) && parsed.nextUpdateId >= 0 ? parsed.nextUpdateId : 0,
    candidate: null,
  };
  if (parsed.candidate) {
    state.candidate = {
      telegramUserId: validateTelegramUserId(parsed.candidate.telegramUserId),
      label: sanitizeTelegramLabel(parsed.candidate.label) || telegramUserHint(parsed.candidate.telegramUserId),
    };
  }
  if (Date.parse(state.expiresAt) <= now()) {
    await fsImpl.rm(pairingPath, { force: true });
    return null;
  }
  return state;
}

export async function getTelegramPairingStatus(options = {}) {
  try {
    return pairingPublicState(await readTelegramPairingState(options));
  } catch {
    return Object.freeze({ active: false, candidateFound: false, botUsername: null, expiresAt: null, candidateLabel: null, userIdHint: null, needsAttention: true });
  }
}

export async function startTelegramPairing({
  botToken,
  pairingPath = defaultTelegramPairingPath(),
  fsImpl = fs,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  const token = validateBotToken(botToken);
  const bot = await callTelegramJson({ botToken: token, method: "getMe", fetchImpl });
  if (!bot || bot.is_bot !== true) throw new Error("Telegram token does not belong to a bot.");
  const backlog = await callTelegramJson({
    botToken: token, method: "getUpdates", fetchImpl,
    body: { offset: -1, limit: 1, timeout: 0, allowed_updates: ["message"] },
  });
  const state = {
    version: 1,
    botToken: token,
    botUsername: sanitizeTelegramLabel(bot.username),
    expiresAt: new Date(now() + PAIRING_TTL_MS).toISOString(),
    nextUpdateId: maxNextUpdateId(backlog, 0),
    candidate: null,
  };
  await writePrivateJson(pairingPath, state, { fsImpl });
  return pairingPublicState(state);
}

function pairingCandidateFromUpdate(update) {
  const message = update?.message;
  if (!message || message.chat?.type !== "private" || !message.from) return null;
  let telegramUserId;
  try { telegramUserId = validateTelegramUserId(message.from.id); } catch { return null; }
  if (String(message.chat?.id ?? "") !== telegramUserId) return null;
  const text = typeof message.text === "string" ? message.text.trim() : "";
  if (!/^\/start(?:@[A-Za-z0-9_]+)?(?:\s|$)/u.test(text)) return null;
  const username = sanitizeTelegramLabel(message.from.username);
  const name = sanitizeTelegramLabel([message.from.first_name, message.from.last_name].filter(Boolean).join(" "));
  const label = username ? `@${username}` : name || telegramUserHint(telegramUserId);
  return { telegramUserId, label };
}

export async function pollTelegramPairing({
  pairingPath = defaultTelegramPairingPath(),
  fsImpl = fs,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  const state = await readTelegramPairingState({ pairingPath, fsImpl, now });
  if (!state) return pairingPublicState(null);
  if (state.candidate) return pairingPublicState(state);
  const updates = await callTelegramJson({
    botToken: state.botToken, method: "getUpdates", fetchImpl,
    body: { offset: state.nextUpdateId, limit: MAX_UPDATE_BATCH, timeout: 0, allowed_updates: ["message"] },
  });
  state.nextUpdateId = maxNextUpdateId(updates, state.nextUpdateId);
  for (const update of Array.isArray(updates) ? updates : []) {
    const candidate = pairingCandidateFromUpdate(update);
    if (candidate) { state.candidate = candidate; break; }
  }
  await writePrivateJson(pairingPath, state, { fsImpl });
  return pairingPublicState(state);
}

function defaultInboxState(nextUpdateId = 0) {
  return { version: 1, nextUpdateId: Number.isSafeInteger(nextUpdateId) && nextUpdateId >= 0 ? nextUpdateId : 0, pending: [] };
}

async function readTelegramInboxState({ inboxPath = defaultTelegramInboxPath(), fsImpl = fs } = {}) {
  const parsed = await readPrivateJson(inboxPath, { fsImpl, maxBytes: MAX_INBOX_BYTES, label: "Telegram inbox state" });
  if (!parsed) return defaultInboxState();
  if (parsed.version !== 1 || !Number.isSafeInteger(parsed.nextUpdateId) || parsed.nextUpdateId < 0 || !Array.isArray(parsed.pending)) {
    throw credentialError("Telegram inbox state is invalid.");
  }
  return { version: 1, nextUpdateId: parsed.nextUpdateId, pending: parsed.pending.slice(-MAX_INBOX_MESSAGES) };
}

export async function confirmTelegramPairing({
  pairingPath = defaultTelegramPairingPath(),
  credentialPath = defaultTelegramCredentialPath(),
  inboxPath = defaultTelegramInboxPath(),
  fsImpl = fs,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  const state = await readTelegramPairingState({ pairingPath, fsImpl, now });
  if (!state?.candidate) throw new Error("No Telegram pairing candidate is waiting for confirmation.");
  const credential = { botToken: state.botToken, telegramUserId: state.candidate.telegramUserId };
  await sendTelegramChunk({ ...credential, text: "Equinox Local is paired. ✅", fetchImpl });
  await writePrivateJson(credentialPath, { version: 2, ...credential }, { fsImpl });
  await writePrivateJson(inboxPath, defaultInboxState(state.nextUpdateId), { fsImpl });
  await fsImpl.rm(pairingPath, { force: true });
  return telegramStatusFromCredential(credential);
}

export async function cancelTelegramPairing({ pairingPath = defaultTelegramPairingPath(), fsImpl = fs } = {}) {
  await fsImpl.rm(pairingPath, { force: true });
  return Object.freeze({ cancelled: true });
}

function boundedInboundText(value) {
  if (typeof value !== "string") return null;
  const clean = value.replace(/\0/gu, "").trim();
  if (!clean) return null;
  return [...clean].slice(0, MAX_INBOUND_TEXT_CHARS).join("");
}

function safeTelegramAttachmentName(raw, fallback) {
  const source = typeof raw === "string" ? raw.replaceAll("\\", "/") : "";
  let base = path.posix.basename(source).replace(/[\u0000-\u001F\u007F]/gu, " ").trim();
  if (!base || base === "." || base === "..") base = fallback;
  base = [...base].slice(0, 180).join("");
  return base || fallback;
}

function normalizeTelegramInboundAttachment(message) {
  let source = null;
  let kind = null;
  if (Array.isArray(message?.photo) && message.photo.length > 0) {
    source = [...message.photo].filter((item) => item && typeof item.file_id === "string").sort((a, b) => (a.file_size ?? 0) - (b.file_size ?? 0)).at(-1) || null;
    kind = source ? "photo" : null;
  } else if (message?.document && typeof message.document.file_id === "string") {
    source = message.document;
    kind = "document";
  }
  if (!source || !kind) return { attachment: null, notice: null };
  const fileId = sanitizeTelegramLabel(source.file_id, 256);
  if (!fileId) return { attachment: null, notice: "Telegram attachment metadata was invalid." };
  const fileUniqueId = sanitizeTelegramLabel(source.file_unique_id, 256);
  const bytes = Number.isSafeInteger(source.file_size) && source.file_size >= 0 ? source.file_size : null;
  const fallback = kind === "photo"
    ? `telegram-photo-${(fileUniqueId || "image").replace(/[^A-Za-z0-9._-]/gu, "-").slice(0, 60)}.jpg`
    : `telegram-document-${(fileUniqueId || "file").replace(/[^A-Za-z0-9._-]/gu, "-").slice(0, 60)}.bin`;
  const fileName = safeTelegramAttachmentName(source.file_name, fallback);
  const mimeType = sanitizeTelegramLabel(source.mime_type, 200) || (kind === "photo" ? "image/jpeg" : "application/octet-stream");
  if (bytes !== null && bytes > MAX_TELEGRAM_DOWNLOAD_BYTES) {
    return { attachment: null, notice: `${fileName} is larger than Telegram Bot API's 20 MiB download limit.` };
  }
  return {
    attachment: Object.freeze({ fileId, fileUniqueId, kind, fileName, mimeType, bytes }),
    notice: null,
  };
}

export async function pollTelegramInboundOnce({
  credentialPath = defaultTelegramCredentialPath(),
  inboxPath = defaultTelegramInboxPath(),
  fsImpl = fs,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  const credential = await readTelegramCredentials({ credentialPath, fsImpl });
  if (!credential) return Object.freeze({ configured: false, received: 0, pendingCount: 0 });
  const inbox = await readTelegramInboxState({ inboxPath, fsImpl });
  const updates = await callTelegramJson({
    botToken: credential.botToken, method: "getUpdates", fetchImpl,
    body: { offset: inbox.nextUpdateId, limit: MAX_UPDATE_BATCH, timeout: 0, allowed_updates: ["message", "callback_query"] },
  });
  inbox.nextUpdateId = maxNextUpdateId(updates, inbox.nextUpdateId);
  let received = 0;
  for (const update of Array.isArray(updates) ? updates : []) {
    let item = null;
    const message = update?.message;
    if (message?.chat?.type === "private" && String(message.chat?.id ?? "") === credential.telegramUserId && String(message.from?.id ?? "") === credential.telegramUserId) {
      const inboundAttachment = normalizeTelegramInboundAttachment(message);
      const text = boundedInboundText(message.text) || boundedInboundText(message.caption) || inboundAttachment.notice;
      if (text || inboundAttachment.attachment) item = {
        updateId: update.update_id,
        kind: "message",
        messageId: message.message_id ?? null,
        replyToMessageId: Number.isInteger(message.reply_to_message?.message_id) ? message.reply_to_message.message_id : null,
        text: text || null,
        attachment: inboundAttachment.attachment,
        receivedAt: new Date(now()).toISOString(),
      };
    }
    const callback = update?.callback_query;
    if (
      !item &&
      callback &&
      String(callback.from?.id ?? "") === credential.telegramUserId &&
      callback.message?.chat?.type === "private" &&
      String(callback.message?.chat?.id ?? "") === credential.telegramUserId
    ) {
      const data = boundedInboundText(callback.data);
      if (data) item = { updateId: update.update_id, kind: "callback", callbackQueryId: sanitizeTelegramLabel(callback.id, 160), messageId: callback.message?.message_id ?? null, data, receivedAt: new Date(now()).toISOString() };
    }
    if (item && !inbox.pending.some((existing) => existing?.updateId === item.updateId)) {
      inbox.pending.push(item);
      received += 1;
    }
  }
  inbox.pending = inbox.pending.slice(-MAX_INBOX_MESSAGES);
  await writePrivateJson(inboxPath, inbox, { fsImpl });
  return Object.freeze({ configured: true, received, pendingCount: inbox.pending.length, nextUpdateId: inbox.nextUpdateId });
}

function normalizeTelegramDownloadPath(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) throw new Error("Telegram download folder must be an absolute path.");
  const normalized = path.resolve(value);
  if (normalized === path.parse(normalized).root) throw new Error("Telegram download folder cannot be the filesystem root.");
  return normalized;
}

async function validateTelegramDownloadDirectory(value, { fsImpl = fs, create = false } = {}) {
  const normalized = normalizeTelegramDownloadPath(value);
  if (create) await fsImpl.mkdir(normalized, { recursive: true, mode: 0o700 });
  const stat = await fsImpl.lstat(normalized);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Telegram download folder must be a normal local directory.");
  return fsImpl.realpath(normalized);
}

export async function getTelegramDownloadSettings({
  settingsPath = defaultTelegramDownloadSettingsPath(),
  homeDir = os.homedir(),
  fsImpl = fs,
} = {}) {
  const defaultPath = defaultTelegramAttachmentRoot(homeDir);
  let parsed = null;
  try {
    parsed = await readPrivateJson(settingsPath, { fsImpl, maxBytes: 32 * 1024, label: "Telegram download settings" });
  } catch {
    parsed = null;
  }
  const configuredPath = parsed?.downloadPath ? normalizeTelegramDownloadPath(parsed.downloadPath) : defaultPath;
  const known = Array.isArray(parsed?.knownRoots) ? parsed.knownRoots : [];
  const knownRoots = [...new Set([legacyTelegramAttachmentRoot(homeDir), defaultPath, ...known.map((item) => normalizeTelegramDownloadPath(item)), configuredPath])].slice(-MAX_TELEGRAM_KNOWN_DOWNLOAD_ROOTS);
  return Object.freeze({
    path: configuredPath,
    isDefault: configuredPath === defaultPath,
    autoCleanup: false,
    knownRoots: Object.freeze(knownRoots),
  });
}

export async function setTelegramDownloadLocation({
  downloadPath = null,
  settingsPath = defaultTelegramDownloadSettingsPath(),
  homeDir = os.homedir(),
  fsImpl = fs,
} = {}) {
  const current = await getTelegramDownloadSettings({ settingsPath, homeDir, fsImpl });
  const defaultPath = defaultTelegramAttachmentRoot(homeDir);
  const selected = downloadPath == null ? defaultPath : await validateTelegramDownloadDirectory(downloadPath, { fsImpl, create: false });
  if (downloadPath == null) await validateTelegramDownloadDirectory(defaultPath, { fsImpl, create: true });
  const knownRoots = [...new Set([...current.knownRoots, current.path, selected])].slice(-MAX_TELEGRAM_KNOWN_DOWNLOAD_ROOTS);
  await writePrivateJson(settingsPath, { version: 1, downloadPath: selected === defaultPath ? null : selected, knownRoots }, { fsImpl });
  return getTelegramDownloadSettings({ settingsPath, homeDir, fsImpl });
}

export async function getTelegramRemoteControlSettings({
  settingsPath = defaultTelegramRemoteControlSettingsPath(),
  fsImpl = fs,
} = {}) {
  try {
    const parsed = await readPrivateJson(settingsPath, { fsImpl, maxBytes: 8 * 1024, label: "Telegram remote-control settings" });
    return Object.freeze({ enabled: parsed?.version === 1 && typeof parsed.enabled === "boolean" ? parsed.enabled : true });
  } catch {
    return Object.freeze({ enabled: true });
  }
}

export async function setTelegramRemoteControlEnabled({
  enabled,
  settingsPath = defaultTelegramRemoteControlSettingsPath(),
  fsImpl = fs,
} = {}) {
  if (typeof enabled !== "boolean") throw new Error("Telegram remote control enabled must be a boolean.");
  await writePrivateJson(settingsPath, { version: 1, enabled }, { fsImpl });
  return getTelegramRemoteControlSettings({ settingsPath, fsImpl });
}

async function ensureTelegramAttachmentRoot(rootPath, fsImpl = fs) {
  await fsImpl.mkdir(rootPath, { recursive: true, mode: 0o700 });
  const stat = await fsImpl.lstat(rootPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Telegram attachment root must be a normal directory.");
  await fsImpl.chmod(rootPath, 0o700);
  return fsImpl.realpath(rootPath);
}


function validateTelegramFilePath(value) {
  if (typeof value !== "string" || !value || value.length > 1024 || value.includes("\0")) throw new Error("Telegram getFile returned an invalid file path.");
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) throw new Error("Telegram getFile returned an unsafe file path.");
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
}

export async function downloadTelegramAttachment({
  updateId,
  attachment,
  credentialPath = defaultTelegramCredentialPath(),
  attachmentRoot = null,
  settingsPath = defaultTelegramDownloadSettingsPath(),
  homeDir = os.homedir(),
  fsImpl = fs,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  if (!Number.isSafeInteger(updateId) || updateId < 0) throw new Error("Telegram attachment update id is invalid.");
  if (!attachment || typeof attachment !== "object") throw new Error("Telegram attachment metadata is required.");
  if (!["photo", "document"].includes(attachment.kind)) throw new Error("Telegram attachment kind is invalid.");
  const fileId = sanitizeTelegramLabel(attachment.fileId, 256);
  if (!fileId) throw new Error("Telegram attachment file id is invalid.");
  if (attachment.bytes !== null && attachment.bytes !== undefined && (!Number.isSafeInteger(attachment.bytes) || attachment.bytes < 0 || attachment.bytes > MAX_TELEGRAM_DOWNLOAD_BYTES)) {
    throw new Error("Telegram attachment exceeds the 20 MiB Bot API download limit.");
  }
  const credential = await readTelegramCredentials({ credentialPath, fsImpl });
  if (!credential) throw new Error("Telegram is not connected in Equinox Local Control Center.");
  const file = await callTelegramJson({ botToken: credential.botToken, method: "getFile", body: { file_id: fileId }, fetchImpl });
  const encodedPath = validateTelegramFilePath(file?.file_path);
  const settings = attachmentRoot
    ? { path: attachmentRoot }
    : await getTelegramDownloadSettings({ settingsPath, homeDir, fsImpl });
  const rootReal = await ensureTelegramAttachmentRoot(settings.path, fsImpl);
  const attachmentId = `tgatt-${String(updateId).padStart(6, "0")}`;
  const safeName = safeTelegramAttachmentName(attachment.fileName, `${attachmentId}.bin`);
  const target = path.join(rootReal, `${attachmentId}-${safeName}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FILE_REQUEST_TIMEOUT_MS);
  timer.unref?.();
  let response;
  try {
    response = await fetchImpl(`${TELEGRAM_API_BASE}/file/bot${credential.botToken}/${encodedPath}`, {
      method: "GET", redirect: "error", signal: controller.signal,
    });
  } catch {
    throw new Error("Telegram attachment download failed.");
  } finally {
    clearTimeout(timer);
  }
  if (!response?.ok) throw new Error(`Telegram attachment download failed with HTTP ${response?.status ?? "unknown"}.`);
  const declaredLength = Number.parseInt(response.headers?.get?.("content-length") ?? "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_TELEGRAM_DOWNLOAD_BYTES) throw new Error("Telegram attachment exceeds the 20 MiB Bot API download limit.");
  if (!response.body || typeof response.body.getReader !== "function") throw new Error("Telegram attachment response body is unavailable.");
  const temp = path.join(rootReal, `.download-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  const handle = await fsImpl.open(temp, "wx", 0o600);
  const hash = createHash("sha256");
  let total = 0;
  let succeeded = false;
  try {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        total += chunk.length;
        if (total > MAX_TELEGRAM_DOWNLOAD_BYTES) {
          await reader.cancel().catch(() => {});
          throw new Error("Telegram attachment exceeds the 20 MiB Bot API download limit.");
        }
        hash.update(chunk);
        await handle.write(chunk);
      }
    } finally {
      reader.releaseLock?.();
    }
    if (total < 1) throw new Error("Telegram attachment download was empty.");
    await handle.sync();
    succeeded = true;
  } finally {
    await handle.close().catch(() => {});
    if (!succeeded) await fsImpl.rm(temp, { force: true }).catch(() => {});
  }
  try {
    try {
      const existing = await fsImpl.lstat(target);
      if (!existing.isFile() || existing.isSymbolicLink()) throw new Error("Telegram attachment target is not a normal file.");
      await fsImpl.rm(target);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await fsImpl.rename(temp, target);
    await fsImpl.chmod(target, 0o600);
  } catch (error) {
    await fsImpl.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
  const sha256 = hash.digest("hex");
  return Object.freeze({
    attachmentId,
    kind: attachment.kind,
    fileName: safeName,
    mimeType: sanitizeTelegramLabel(attachment.mimeType, 200) || (attachment.kind === "photo" ? "image/jpeg" : "application/octet-stream"),
    bytes: total,
    sha256,
    storagePath: target,
  });
}

function telegramUploadMime(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  if ([".jpg", ".jpeg"].includes(ext)) return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".txt") return "text/plain";
  if (ext === ".zip") return "application/zip";
  return "application/octet-stream";
}

function validateTelegramCaption(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.includes("\0") || [...value].length > 1024) throw new Error("Telegram file caption must be at most 1024 characters.");
  return value;
}

async function callTelegramMultipart({ botToken, telegramUserId, method, fieldName, data, fileName, mimeType, caption, fetchImpl = globalThis.fetch } = {}) {
  if (!["sendPhoto", "sendDocument"].includes(method) || !["photo", "document"].includes(fieldName)) throw new Error("Telegram multipart method is invalid.");
  if (typeof fetchImpl !== "function") throw new Error("Telegram HTTP client is unavailable.");
  const form = new FormData();
  form.append("chat_id", telegramUserId);
  if (caption) form.append("caption", caption);
  form.append(fieldName, new Blob([data], { type: mimeType }), fileName);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FILE_REQUEST_TIMEOUT_MS);
  timer.unref?.();
  let response;
  try {
    response = await fetchImpl(`${TELEGRAM_API_BASE}/bot${botToken}/${method}`, {
      method: "POST", body: form, redirect: "error", signal: controller.signal,
    });
  } catch {
    throw new Error("Telegram file upload failed.");
  } finally {
    clearTimeout(timer);
  }
  let payload;
  try { payload = await response.json(); } catch {
    if (!response?.ok) throw mapTelegramFailure(response?.status);
    throw new Error("Telegram file upload returned an invalid response.");
  }
  if (!response?.ok) throw mapTelegramFailure(response?.status, payload?.description);
  if (payload?.ok !== true || !Number.isInteger(payload.result?.message_id)) throw new Error("Telegram file upload returned an unsuccessful response.");
  return payload.result.message_id;
}

export async function sendTelegramFile({
  filePath,
  caption = null,
  mode = "auto",
  resolveFile,
  credentialPath = defaultTelegramCredentialPath(),
  fsImpl = fs,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof resolveFile !== "function") throw new Error("Telegram file path policy is unavailable.");
  if (!["auto", "photo", "document"].includes(mode)) throw new Error("Telegram file mode must be auto, photo, or document.");
  const resolved = await resolveFile(filePath);
  if (!resolved || typeof resolved.absolutePath !== "string" || !Number.isSafeInteger(resolved.bytes)) throw new Error("Telegram file path policy returned an invalid result.");
  const fileName = path.basename(resolved.absolutePath);
  const mimeType = telegramUploadMime(fileName);
  let selectedMode = mode;
  if (selectedMode === "auto") selectedMode = mimeType.startsWith("image/") && resolved.bytes <= MAX_TELEGRAM_PHOTO_UPLOAD_BYTES ? "photo" : "document";
  const maxBytes = selectedMode === "photo" ? MAX_TELEGRAM_PHOTO_UPLOAD_BYTES : MAX_TELEGRAM_DOCUMENT_UPLOAD_BYTES;
  if (resolved.bytes < 1 || resolved.bytes > maxBytes) throw new Error(`Telegram ${selectedMode} upload exceeds the ${maxBytes / 1024 / 1024} MiB limit.`);
  const { data, stat } = await readBoundedNormalFile(resolved.absolutePath, { fsImpl, minBytes: 1, maxBytes, label: "Telegram outbound file" });
  if (!Buffer.isBuffer(data) || data.length !== stat.size || data.length !== resolved.bytes) throw new Error("Telegram outbound file changed while it was being read; retry with a stable file.");
  let uploadMimeType = mimeType;
  if (selectedMode === "photo") {
    if (!mimeType.startsWith("image/")) throw new Error("Telegram photo mode requires a PNG, JPEG or WebP file.");
    uploadMimeType = inspectImageBuffer(data).mimeType;
  }
  const credential = await readTelegramCredentials({ credentialPath, fsImpl });
  if (!credential) throw new Error("Telegram is not connected in Equinox Local Control Center.");
  const messageId = await callTelegramMultipart({
    ...credential,
    method: selectedMode === "photo" ? "sendPhoto" : "sendDocument",
    fieldName: selectedMode === "photo" ? "photo" : "document",
    data,
    fileName,
    mimeType: uploadMimeType,
    caption: validateTelegramCaption(caption),
    fetchImpl,
  });
  return Object.freeze({ sent: true, messageId, mode: selectedMode, fileName, bytes: data.length, mimeType: uploadMimeType });
}

async function openTelegramAttachmentRecord({
  attachment,
  attachmentRoot = null,
  settingsPath = defaultTelegramDownloadSettingsPath(),
  homeDir = os.homedir(),
  fsImpl = fs,
  label = "Telegram attachment",
  uriScope = "telegram-attachment",
} = {}) {
  if (!attachment || typeof attachment !== "object") throw new Error(`${label} metadata is unavailable.`);
  const candidateReal = await fsImpl.realpath(attachment.storagePath);
  const roots = attachmentRoot
    ? [await ensureTelegramAttachmentRoot(attachmentRoot, fsImpl)]
    : (await getTelegramDownloadSettings({ settingsPath, homeDir, fsImpl })).knownRoots;
  let contained = false;
  for (const root of roots) {
    let rootReal;
    try { rootReal = await fsImpl.realpath(root); } catch { continue; }
    const relative = path.relative(rootReal, candidateReal);
    if (relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) { contained = true; break; }
  }
  if (!contained) throw new Error(`${label} is outside known download folders.`);
  const { data, stat } = await readBoundedNormalFile(candidateReal, { fsImpl, minBytes: 1, maxBytes: MAX_TELEGRAM_DOWNLOAD_BYTES, label });
  if (!Buffer.isBuffer(data) || data.length !== stat.size || data.length !== attachment.bytes) throw new Error(`${label} changed while it was being read.`);
  const sha256 = createHash("sha256").update(data).digest("hex");
  if (sha256 !== attachment.sha256) throw new Error(`${label} integrity check failed.`);
  const content = [{
    type: "text",
    text: [`${label}: ${attachment.fileName}`, `Attachment ID: ${attachment.attachmentId}`, `MIME: ${attachment.mimeType}`, `Bytes: ${attachment.bytes}`, `SHA-256: ${attachment.sha256}`].join("\n"),
  }];
  content.push({ type: "resource", resource: { uri: `equinox-local://${uriScope}/${attachment.attachmentId}/${encodeURIComponent(attachment.fileName)}`, mimeType: attachment.mimeType, blob: data.toString("base64") }, annotations: { audience: ["assistant"], priority: 1 } });
  if (attachment.mimeType.startsWith("image/") && data.length <= MAX_IMAGE_VIEW_BYTES) {
    const metadata = inspectImageBuffer(data);
    content.push({ type: "image", data: data.toString("base64"), mimeType: metadata.mimeType });
  }
  return { content };
}

export async function openTelegramTaskAttachment({
  taskId,
  attachmentId,
  store,
  attachmentRoot = null,
  settingsPath = defaultTelegramDownloadSettingsPath(),
  homeDir = os.homedir(),
  fsImpl = fs,
} = {}) {
  if (!store?.readInternal) throw new Error("Telegram task attachment store is unavailable.");
  if (typeof taskId !== "string" || !/^task-[a-z0-9-]{6,80}$/u.test(taskId)) throw new Error("Telegram attachment task id is invalid.");
  if (typeof attachmentId !== "string" || !/^tgatt-[a-z0-9-]{6,100}$/u.test(attachmentId)) throw new Error("Telegram attachment id is invalid.");
  const task = await store.readInternal(taskId);
  const attachment = task.humanInput?.attachments?.find((item) => item.attachmentId === attachmentId) || null;
  if (!attachment) throw new Error("Telegram attachment is not part of the task's current pending human input.");
  return openTelegramAttachmentRecord({ attachment, attachmentRoot, settingsPath, homeDir, fsImpl, label: "Telegram task attachment", uriScope: "telegram-attachment" });
}


export async function readTelegramInboundPending({ inboxPath = defaultTelegramInboxPath(), fsImpl = fs } = {}) {
  const inbox = await readTelegramInboxState({ inboxPath, fsImpl });
  return Object.freeze(inbox.pending.map((item) => Object.freeze({ ...item })));
}

export async function acknowledgeTelegramInboundUpdate(updateId, { inboxPath = defaultTelegramInboxPath(), fsImpl = fs } = {}) {
  if (!Number.isSafeInteger(updateId) || updateId < 0) throw new Error("Telegram update id is invalid.");
  const inbox = await readTelegramInboxState({ inboxPath, fsImpl });
  const before = inbox.pending.length;
  inbox.pending = inbox.pending.filter((item) => item?.updateId !== updateId);
  if (inbox.pending.length !== before) await writePrivateJson(inboxPath, inbox, { fsImpl });
  return Object.freeze({ acknowledged: before !== inbox.pending.length, pendingCount: inbox.pending.length });
}

function normalizeInlineKeyboard(value) {
  if (value === null || value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 3) throw new Error("Telegram inline keyboard must have at most 3 rows.");
  const inline_keyboard = value.map((row, rowIndex) => {
    if (!Array.isArray(row) || row.length < 1 || row.length > 3) throw new Error(`Telegram inline keyboard row ${rowIndex} is invalid.`);
    return row.map((button, buttonIndex) => {
      if (!button || typeof button !== "object" || Array.isArray(button)) throw new Error(`Telegram inline button ${rowIndex}:${buttonIndex} is invalid.`);
      const text = sanitizeTelegramLabel(button.text, 48);
      if (!text) throw new Error("Telegram inline button text is required.");
      if (typeof button.callbackData === "string") {
        const callback_data = button.callbackData.trim();
        if (!/^eqx:[a-z]:[a-z0-9-]{6,40}$/u.test(callback_data) || Buffer.byteLength(callback_data, "utf8") > 64) throw new Error("Telegram callback data is invalid.");
        return { text, callback_data };
      }
      if (typeof button.url === "string") {
        const parsed = new URL(button.url);
        if (parsed.protocol !== "https:" || parsed.hostname !== "chatgpt.com") throw new Error("Telegram task link must be a chatgpt.com HTTPS URL.");
        return { text, url: parsed.href };
      }
      throw new Error("Telegram inline button needs callbackData or url.");
    });
  });
  return { inline_keyboard };
}

export async function sendTelegramTaskCard({
  text, keyboard = null, credentialPath = defaultTelegramCredentialPath(), fsImpl = fs, fetchImpl = globalThis.fetch,
} = {}) {
  const messageText = validateTelegramMessage(text);
  const credential = await readTelegramCredentials({ credentialPath, fsImpl });
  if (!credential) throw new Error("Telegram is not connected in Equinox Local Control Center.");
  const result = await callTelegramJson({
    botToken: credential.botToken, method: "sendMessage", fetchImpl,
    body: { chat_id: credential.telegramUserId, text: messageText, ...(keyboard ? { reply_markup: normalizeInlineKeyboard(keyboard) } : {}) },
  });
  if (!Number.isInteger(result?.message_id) || result.message_id < 1) throw new Error("Telegram task message did not return a valid message id.");
  return Object.freeze({ sent: true, messageId: result.message_id });
}

export async function editTelegramTaskCard({
  messageId, text, keyboard = null, credentialPath = defaultTelegramCredentialPath(), fsImpl = fs, fetchImpl = globalThis.fetch,
} = {}) {
  if (!Number.isInteger(messageId) || messageId < 1) throw new Error("Telegram task message id is invalid.");
  const messageText = validateTelegramMessage(text);
  const credential = await readTelegramCredentials({ credentialPath, fsImpl });
  if (!credential) throw new Error("Telegram is not connected in Equinox Local Control Center.");
  try {
    await callTelegramJson({
      botToken: credential.botToken, method: "editMessageText", fetchImpl,
      body: { chat_id: credential.telegramUserId, message_id: messageId, text: messageText, ...(keyboard ? { reply_markup: normalizeInlineKeyboard(keyboard) } : { reply_markup: { inline_keyboard: [] } }) },
    });
    return Object.freeze({ edited: true, messageId });
  } catch (error) {
    if (error?.telegramStatus === 400 && /message is not modified/iu.test(String(error?.message || ""))) {
      return Object.freeze({ edited: false, unchanged: true, messageId });
    }
    throw error;
  }
}

export async function answerTelegramTaskCallback({
  callbackQueryId, text = null, credentialPath = defaultTelegramCredentialPath(), fsImpl = fs, fetchImpl = globalThis.fetch,
} = {}) {
  const id = sanitizeTelegramLabel(callbackQueryId, 160);
  if (!id) throw new Error("Telegram callback query id is invalid.");
  const credential = await readTelegramCredentials({ credentialPath, fsImpl });
  if (!credential) throw new Error("Telegram is not connected in Equinox Local Control Center.");
  const answer = text == null ? null : sanitizeTelegramLabel(text, 180);
  await callTelegramJson({ botToken: credential.botToken, method: "answerCallbackQuery", fetchImpl, body: { callback_query_id: id, ...(answer ? { text: answer } : {}) } });
  return Object.freeze({ answered: true });
}

function splitMessage(text) {
  const characters = [...text];
  const chunks = [];
  for (let index = 0; index < characters.length; index += MESSAGE_CHUNK_CHARS) {
    chunks.push(characters.slice(index, index + MESSAGE_CHUNK_CHARS).join(""));
  }
  return chunks;
}

function mapTelegramFailure(status, description = null) {
  const detail = sanitizeTelegramLabel(description, 180);
  if (status === 401) return new Error("Telegram bot token was rejected.");
  if (status === 403) return new Error("Telegram bot is blocked or cannot message this user.");
  if (status === 400) {
    if (detail && /IMAGE_PROCESS_FAILED|PHOTO_INVALID_DIMENSIONS/iu.test(detail)) {
      return new Error("Telegram could not process this image as a photo. Use a normal PNG/JPEG/WebP image or send it as a document.");
    }
    if (detail && /FILE_TOO_BIG|file is too big|request entity too large/iu.test(detail)) {
      return new Error("Telegram rejected the upload because the file is too large.");
    }
    if (detail && /chat not found|PEER_ID_INVALID|user.*not found/iu.test(detail)) {
      return new Error("Telegram user ID is invalid or the bot cannot message that user. Open the bot chat and send it a message first.");
    }
    return new Error(detail ? `Telegram rejected the request: ${detail}` : "Telegram rejected the request with HTTP 400.");
  }
  return new Error(detail ? `Telegram API request failed: ${detail}` : "Telegram API request failed.");
}

async function sendTelegramChunk({ botToken, telegramUserId, text, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("Telegram HTTP client is unavailable.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref?.();
  let response;
  try {
    response = await fetchImpl(`${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: telegramUserId, text }),
      redirect: "error",
      signal: controller.signal,
    });
  } catch {
    throw new Error("Telegram API connection failed.");
  } finally {
    clearTimeout(timer);
  }
  if (!response?.ok) throw mapTelegramFailure(response?.status);
  return true;
}

export async function sendTelegramMessage({
  message,
  credentialPath = defaultTelegramCredentialPath(),
  fsImpl = fs,
  fetchImpl = globalThis.fetch,
} = {}) {
  const text = validateTelegramMessage(message);
  const credential = await readTelegramCredentials({ credentialPath, fsImpl });
  if (!credential) throw new Error("Telegram is not connected in Equinox Local Control Center.");
  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    await sendTelegramChunk({ ...credential, text: chunk, fetchImpl });
  }
  return Object.freeze({ sent: true, messageCount: chunks.length });
}

export async function syncTelegramBotCommands({
  credentialPath = defaultTelegramCredentialPath(),
  fsImpl = fs,
  fetchImpl = globalThis.fetch,
} = {}) {
  const credential = await readTelegramCredentials({ credentialPath, fsImpl });
  if (!credential) return Object.freeze({ configured: false, synced: false, commandCount: 0 });
  await callTelegramJson({
    botToken: credential.botToken,
    method: "setMyCommands",
    fetchImpl,
    body: {
      scope: { type: "chat", chat_id: credential.telegramUserId },
      commands: TELEGRAM_REMOTE_COMMANDS.map((item) => ({ ...item })),
    },
  });
  return Object.freeze({ configured: true, synced: true, commandCount: TELEGRAM_REMOTE_COMMANDS.length });
}

export async function configureTelegramIntegration({
  botToken,
  telegramUserId,
  credentialPath = defaultTelegramCredentialPath(),
  fsImpl = fs,
  fetchImpl = globalThis.fetch,
} = {}) {
  const credential = validateTelegramConnectionInput({ botToken, telegramUserId });
  await sendTelegramChunk({
    ...credential,
    text: "Equinox Local is connected. ✅",
    fetchImpl,
  });
  const payload = `${JSON.stringify({ version: 2, ...credential }, null, 2)}\n`;
  await atomicWriteCredential(credentialPath, payload, { fsImpl });
  return telegramStatusFromCredential(credential);
}

export async function testTelegramIntegration(options = {}) {
  return await sendTelegramMessage({
    ...options,
    message: "Equinox Local Telegram test is working. ✅",
  });
}

export async function disconnectTelegramIntegration({
  credentialPath = defaultTelegramCredentialPath(),
  pairingPath = defaultTelegramPairingPath(),
  inboxPath = defaultTelegramInboxPath(),
  taskStatePath = null,
  fsImpl = fs,
} = {}) {
  await readTelegramCredentials({ credentialPath, fsImpl }).catch(() => null);
  const resolvedTaskStatePath = taskStatePath || (
    credentialPath === defaultTelegramCredentialPath()
      ? defaultTelegramTaskStatePath()
      : path.join(path.dirname(credentialPath), "telegram-task-state.json")
  );
  await Promise.all([
    fsImpl.rm(credentialPath, { force: true }),
    fsImpl.rm(pairingPath, { force: true }),
    fsImpl.rm(inboxPath, { force: true }),
    fsImpl.rm(resolvedTaskStatePath, { force: true }),
  ]);
  return Object.freeze({ disconnected: true });
}

export function registerTelegramSendTool({
  registerTextTool,
  registerRawTool = null,
  z,
  sendMessage = sendTelegramMessage,
  sendFile = sendTelegramFile,
  openAttachment = openTelegramTaskAttachment,
  resolveOutboundFile = null,
  taskStore = null,
  textResult,
  errorResult,
} = {}) {
  registerTextTool(
    "telegram_send_message",
    {
      description:
        "Control Center'da bağlanmış Telegram botu üzerinden yalnız yapılandırılmış insana düz metin mesaj gönderir. Ajan hedef Telegram ID'sini seçemez veya değiştiremez; bot tokenı ve hedef kimliği MCP sonucuna ya da loglara döndürülmez. Uzun mesajlar Telegram sınırına uygun parçalara otomatik bölünür.",
      inputSchema: {
        message: z
          .string()
          .min(1)
          .max(MAX_MESSAGE_CHARS)
          .describe("İnsanına Telegram üzerinden gönderilecek düz metin mesaj"),
      },
      annotations: {
        title: "Telegram mesajı gönder",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ message }) => {
      try {
        const result = await sendMessage({ message });
        return textResult(
          result.messageCount === 1
            ? "Telegram mesajı gönderildi."
            : `Telegram mesajı ${result.messageCount} parça halinde gönderildi.`,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
    {
      projectAware: false,
      mutationScopes: ["global"],
    },
  );

  registerTextTool(
    "telegram_send_file",
    {
      description:
        "Control Center'da eşleştirilmiş tek özel Telegram kullanıcısına bir local dosya veya fotoğraf gönderir. path mevcut Equinox Local file-export erişim politikasından geçer; symlink, protected credential/application-data path ve Selected Agent Access dışı dosyalar reddedilir. Hedef kullanıcı ajan tarafından değiştirilemez. auto modu PNG/JPEG/WebP ve 10 MiB altını fotoğraf, diğer desteklenen dosyaları document olarak gönderir; Bot API sınırı document için 50 MiB'dır.",
      inputSchema: {
        path: z.string().min(1).max(4096).describe("Telegram'a gönderilecek accessible absolute veya ~/ local file path"),
        caption: z.string().max(1024).optional().describe("İsteğe bağlı Telegram caption"),
        mode: z.enum(["auto", "photo", "document"]).default("auto").describe("auto fotoğraf uygunluğunu seçer; photo görsel doğrulaması yapar; document genel dosya gönderir"),
      },
      annotations: {
        title: "Telegram dosyası gönder",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ path: filePath, caption, mode }) => {
      try {
        if (typeof resolveOutboundFile !== "function") throw new Error("Telegram file export policy is unavailable.");
        const result = await sendFile({ filePath, caption, mode, resolveFile: resolveOutboundFile });
        return textResult(`Telegram ${result.mode} gönderildi: ${result.fileName} (${result.bytes} bytes).`);
      } catch (error) {
        return errorResult(error);
      }
    },
    { projectAware: false, mutationScopes: ["global"] },
  );

  if (typeof registerRawTool === "function" && taskStore) {
    registerRawTool(
      "telegram_attachment_open",
      {
        description:
          "Opens one Telegram photo/document that is attached to the current pending humanInput of an exact Task Capsule. The operation requires both task_id and opaque attachment_id from task_read; it cannot list Telegram messages or open arbitrary inbox files. Images return real MCP image content when within the visual safety budget.",
        inputSchema: {
          task_id: z.string().regex(/^task-[a-z0-9-]{6,80}$/u),
          attachment_id: z.string().regex(/^tgatt-[a-z0-9-]{6,100}$/u),
        },
        annotations: { title: "Open Telegram task attachment", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ task_id, attachment_id }) => openAttachment({ taskId: task_id, attachmentId: attachment_id, store: taskStore }),
      { capabilityDomain: "files", mcpExposed: false },
    );


  }
}
