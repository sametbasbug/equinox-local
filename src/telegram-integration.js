import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  readBoundedNormalFile,
  SAFE_FILE_ERROR_CODES,
} from "./equinox-local-safe-file.js";

const TELEGRAM_API_BASE = "https://api.telegram.org";
const MAX_CREDENTIAL_BYTES = 16 * 1024;
const MAX_MESSAGE_CHARS = 12_000;
const MESSAGE_CHUNK_CHARS = 4_000;
const REQUEST_TIMEOUT_MS = 10_000;
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

async function ensurePrivateDirectory(directory, { fsImpl = fs } = {}) {
  await fsImpl.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fsImpl.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw credentialError("Telegram credential directory is unsafe.");
  }
  await fsImpl.chmod(directory, 0o700);
}

async function atomicWriteCredential(filePath, contents, { fsImpl = fs } = {}) {
  const parent = path.dirname(filePath);
  await ensurePrivateDirectory(parent, { fsImpl });
  const temp = path.join(parent, `.equinox-telegram-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  try {
    await fsImpl.writeFile(temp, contents, { flag: "wx", mode: 0o600 });
    await fsImpl.rename(temp, filePath);
    await fsImpl.chmod(filePath, 0o600);
  } catch (error) {
    await fsImpl.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
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
    return telegramStatusFromCredential(await readTelegramCredentials(options));
  } catch {
    return Object.freeze({
      configured: false,
      ready: false,
      needsAttention: true,
      userIdHint: null,
    });
  }
}

function splitMessage(text) {
  const characters = [...text];
  const chunks = [];
  for (let index = 0; index < characters.length; index += MESSAGE_CHUNK_CHARS) {
    chunks.push(characters.slice(index, index + MESSAGE_CHUNK_CHARS).join(""));
  }
  return chunks;
}

function mapTelegramFailure(status) {
  if (status === 401) return new Error("Telegram bot token was rejected.");
  if (status === 403) return new Error("Telegram bot is blocked or cannot message this user.");
  if (status === 400) {
    return new Error("Telegram user ID is invalid or the bot cannot message that user. Open the bot chat and send it a message first.");
  }
  return new Error("Telegram API request failed.");
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
  fsImpl = fs,
} = {}) {
  const credential = await readTelegramCredentials({ credentialPath, fsImpl });
  if (!credential) return Object.freeze({ disconnected: true });
  await fsImpl.rm(credentialPath);
  return Object.freeze({ disconnected: true });
}
