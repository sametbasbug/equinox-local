import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as z from "zod/v4";

import { readBoundedNormalFile } from "../../src/equinox-local-safe-file.js";
import {
  cancelTelegramPairing,
  configureTelegramIntegration,
  confirmTelegramPairing,
  defaultTelegramAttachmentRoot,
  defaultTelegramCredentialPath,
  defaultTelegramInboxPath,
  defaultTelegramPairingPath,
  disconnectTelegramIntegration,
  getTelegramDownloadSettings,
  getTelegramIntegrationStatus,
  getTelegramPairingStatus,
  getTelegramRemoteControlSettings,
  legacyTelegramAttachmentRoot,
  downloadTelegramAttachment,
  openTelegramTaskAttachment,
  pollTelegramInboundOnce,
  pollTelegramPairing,
  registerTelegramSendTool,
  answerTelegramTaskCallback,
  editTelegramTaskCard,
  sendTelegramFile,
  sendTelegramMessage,
  sendTelegramTaskCard,
  sendTelegramTyping,
  setTelegramDownloadLocation,
  setTelegramRemoteControlEnabled,
  startTelegramPairing,
  syncTelegramBotCommands,
  validateTelegramConnectionInput,
  validateTelegramMessage,
} from "../../src/telegram-integration.js";

const TOKEN = "123456789:abcdefghijklmnopqrstuvwxyzABCDE_12345";

async function withTempCredential(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-telegram-"));
  const credentialPath = path.join(root, "credentials", "telegram.json");
  const pairingPath = path.join(root, "credentials", "telegram-pairing.json");
  const inboxPath = path.join(root, "credentials", "telegram-inbox.json");
  try {
    await run({ root, credentialPath, pairingPath, inboxPath });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function successFetch(calls) {
  return async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return { ok: true, status: 200 };
  };
}

function telegramJsonFetch(sequence, calls = []) {
  let index = 0;
  return Object.assign(async (url, init) => {
    const body = JSON.parse(init.body || "{}");
    calls.push({ url, init, body });
    const next = sequence[index++];
    if (!next) throw new Error(`Unexpected Telegram fetch: ${url}`);
    return {
      ok: next.status ? next.status >= 200 && next.status < 300 : true,
      status: next.status || 200,
      async json() { return next.payload ?? { ok: true, result: next.result }; },
    };
  }, { calls });
}

function expectedPairingIdle() {
  return {
    active: false, candidateFound: false, botUsername: null, expiresAt: null,
    candidateLabel: null, userIdHint: null,
  };
}

test("default Telegram credentials stay private while visible downloads default under Downloads", () => {
  assert.equal(
    defaultTelegramCredentialPath("/Users/example"),
    "/Users/example/Library/Application Support/Equinox Local/secrets/telegram.json",
  );
  assert.equal(
    defaultTelegramAttachmentRoot("/Users/example"),
    "/Users/example/Downloads/Equinox Local/Telegram",
  );
  assert.equal(
    legacyTelegramAttachmentRoot("/Users/example"),
    "/Users/example/Library/Application Support/Equinox Local/Telegram Inbox",
  );
});

test("Telegram download settings preserve historical roots and never enable automatic cleanup", async (t) => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-telegram-download-settings-"));
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  const settingsPath = path.join(homeDir, "settings", "telegram-downloads.json");
  const customA = path.join(homeDir, "Custom A");
  const customB = path.join(homeDir, "Custom B");
  await fs.mkdir(customA, { recursive: true });
  await fs.mkdir(customB, { recursive: true });

  const initial = await getTelegramDownloadSettings({ settingsPath, homeDir });
  assert.equal(initial.path, path.join(homeDir, "Downloads", "Equinox Local", "Telegram"));
  assert.equal(initial.isDefault, true);
  assert.equal(initial.autoCleanup, false);
  assert.equal(initial.knownRoots.includes(legacyTelegramAttachmentRoot(homeDir)), true);

  const first = await setTelegramDownloadLocation({ downloadPath: customA, settingsPath, homeDir });
  assert.equal(first.path, await fs.realpath(customA));
  assert.equal(first.isDefault, false);
  const second = await setTelegramDownloadLocation({ downloadPath: customB, settingsPath, homeDir });
  assert.equal(second.path, await fs.realpath(customB));
  assert.equal(second.knownRoots.includes(await fs.realpath(customA)), true);
  assert.equal(second.knownRoots.includes(await fs.realpath(customB)), true);

  const reset = await setTelegramDownloadLocation({ downloadPath: null, settingsPath, homeDir });
  assert.equal(reset.path, path.join(homeDir, "Downloads", "Equinox Local", "Telegram"));
  assert.equal(reset.isDefault, true);
  assert.equal(reset.autoCleanup, false);
  assert.equal(reset.knownRoots.includes(await fs.realpath(customA)), true);
  assert.equal(reset.knownRoots.includes(await fs.realpath(customB)), true);
  assert.equal((await fs.lstat(settingsPath)).mode & 0o077, 0);
});

test("Telegram remote control defaults on, persists off, and typing stays fixed to the paired user", async () => {
  await withTempCredential(async ({ root, credentialPath }) => {
    const settingsPath = path.join(root, "settings", "telegram-remote-control.json");
    assert.deepEqual(await getTelegramRemoteControlSettings({ settingsPath }), { enabled: true });
    assert.deepEqual(await setTelegramRemoteControlEnabled({ enabled: false, settingsPath }), { enabled: false });
    assert.deepEqual(await getTelegramRemoteControlSettings({ settingsPath }), { enabled: false });
    await fs.mkdir(path.dirname(credentialPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(credentialPath, JSON.stringify({ version: 2, botToken: TOKEN, telegramUserId: "123456789" }), { mode: 0o600 });
    const calls = [];
    const result = await sendTelegramTyping({ credentialPath, fetchImpl: telegramJsonFetch([{ result: true }], calls) });
    assert.deepEqual(result, { configured: true, sent: true });
    assert.equal(calls[0].url.endsWith("/sendChatAction"), true);
    assert.deepEqual(calls[0].body, { chat_id: "123456789", action: "typing" });
  });
});

test("Telegram connection input accepts only a token and positive user ID", () => {
  assert.deepEqual(
    validateTelegramConnectionInput({ botToken: TOKEN, telegramUserId: "123456789" }),
    { botToken: TOKEN, telegramUserId: "123456789" },
  );
  assert.throws(
    () => validateTelegramConnectionInput({ botToken: TOKEN, telegramUserId: "-1001234567890" }),
    /Groups and channels are not supported/u,
  );
  assert.throws(
    () => validateTelegramConnectionInput({ botToken: TOKEN, telegramUserId: "@channel" }),
    /positive numeric Telegram account identifier/u,
  );
  assert.throws(
    () => validateTelegramConnectionInput({ botToken: TOKEN, telegramUserId: "1", extra: true }),
    /accepts only botToken and telegramUserId/u,
  );
});

test("Telegram message validation is bounded and rejects empty content", () => {
  assert.equal(validateTelegramMessage("Done ✅"), "Done ✅");
  assert.throws(() => validateTelegramMessage("   "), /must contain/u);
  assert.throws(() => validateTelegramMessage("x".repeat(12_001)), /1-12000/u);
  assert.throws(() => validateTelegramMessage("bad\0message"), /null character/u);
});

test("command menu sync is scoped to the paired private chat", async () => {
  await withTempCredential(async ({ credentialPath }) => {
    await fs.mkdir(path.dirname(credentialPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(credentialPath, `${JSON.stringify({ version: 2, botToken: TOKEN, telegramUserId: "123456789" })}\n`, { mode: 0o600 });
    const calls = [];
    const result = await syncTelegramBotCommands({
      credentialPath,
      fetchImpl: telegramJsonFetch([{ result: true }], calls),
    });
    assert.deepEqual(result, { configured: true, synced: true, commandCount: 5 });
    assert.match(calls[0].url, /\/setMyCommands$/u);
    assert.deepEqual(calls[0].body.scope, { type: "chat", chat_id: "123456789" });
    assert.deepEqual(calls[0].body.commands.map((item) => item.command), ["status", "tasks", "chat", "unbind", "help"]);
    assert.ok(calls[0].body.commands.every((item) => typeof item.description === "string" && item.description.length > 0));
  });
});

test("command menu sync is a no-op when Telegram is not configured", async () => {
  await withTempCredential(async ({ credentialPath }) => {
    let called = false;
    const result = await syncTelegramBotCommands({ credentialPath, fetchImpl: async () => { called = true; throw new Error("unexpected"); } });
    assert.deepEqual(result, { configured: false, synced: false, commandCount: 0 });
    assert.equal(called, false);
  });
});

test("configure stores credentials privately only after a successful Telegram message", async () => {
  await withTempCredential(async ({ credentialPath, pairingPath, inboxPath }) => {
    const calls = [];
    const status = await configureTelegramIntegration({
      botToken: TOKEN,
      telegramUserId: "123456789",
      credentialPath,
      fetchImpl: successFetch(calls),
    });

    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/sendMessage$/u);
    assert.deepEqual(calls[0].body, {
      chat_id: "123456789",
      text: "Equinox Local is connected. ✅",
    });
    assert.deepEqual(status, {
      configured: true,
      ready: true,
      needsAttention: false,
      userIdHint: "…6789",
    });

    const { data: storedText, stat } = await readBoundedNormalFile(credentialPath, {
      minBytes: 1,
      maxBytes: 16 * 1024,
      encoding: "utf8",
      label: "Telegram test credential",
    });
    assert.equal(stat.mode & 0o777, 0o600);
    const stored = JSON.parse(storedText);
    assert.equal(stored.version, 2);
    assert.equal(stored.botToken, TOKEN);
    assert.equal(stored.telegramUserId, "123456789");

    assert.deepEqual(await getTelegramIntegrationStatus({ credentialPath, pairingPath, inboxPath }), {
      ...status, pairing: expectedPairingIdle(), pendingInboundCount: 0, remoteControl: { enabled: true },
    });
  });
});

test("failed Telegram validation does not persist credentials or expose the token", async () => {
  await withTempCredential(async ({ credentialPath }) => {
    const fetchImpl = async () => ({ ok: false, status: 401 });
    await assert.rejects(
      configureTelegramIntegration({
        botToken: TOKEN,
        telegramUserId: "123456789",
        credentialPath,
        fetchImpl,
      }),
      (error) => {
        assert.equal(error.message, "Telegram bot token was rejected.");
        assert.equal(error.message.includes(TOKEN), false);
        return true;
      },
    );
    await assert.rejects(fs.access(credentialPath));
  });
});

test("send uses saved credentials and splits long final messages into bounded chunks", async () => {
  await withTempCredential(async ({ credentialPath }) => {
    await configureTelegramIntegration({
      botToken: TOKEN,
      telegramUserId: "987654321",
      credentialPath,
      fetchImpl: async () => ({ ok: true, status: 200 }),
    });

    const calls = [];
    const result = await sendTelegramMessage({
      message: "a".repeat(8_001),
      credentialPath,
      fetchImpl: successFetch(calls),
    });
    assert.deepEqual(result, { sent: true, messageCount: 3 });
    assert.deepEqual(calls.map((call) => [...call.body.text].length), [4_000, 4_000, 1]);
    assert.ok(calls.every((call) => call.body.chat_id === "987654321"));
    assert.ok(calls.every((call) => !Object.hasOwn(call.body, "parse_mode")));
  });
});

test("legacy private-user credentials migrate in memory while legacy group targets fail closed", async () => {
  await withTempCredential(async ({ credentialPath, pairingPath, inboxPath }) => {
    await fs.mkdir(path.dirname(credentialPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(credentialPath, `${JSON.stringify({ version: 1, botToken: TOKEN, chatId: "123456789" })}\n`, { mode: 0o600 });
    assert.deepEqual(await getTelegramIntegrationStatus({ credentialPath, pairingPath, inboxPath }), {
      configured: true, ready: true, needsAttention: false, userIdHint: "…6789",
      pairing: expectedPairingIdle(), pendingInboundCount: 0, remoteControl: { enabled: true },
    });

    await fs.writeFile(credentialPath, `${JSON.stringify({ version: 1, botToken: TOKEN, chatId: "-1001234567890" })}\n`, { mode: 0o600 });
    assert.deepEqual(await getTelegramIntegrationStatus({ credentialPath, pairingPath, inboxPath }), {
      configured: false, ready: false, needsAttention: true, userIdHint: null,
      pairing: expectedPairingIdle(), pendingInboundCount: 0, remoteControl: { enabled: true },
    });
  });
});

test("disconnect removes Telegram runtime state but preserves downloaded user files", async () => {
  await withTempCredential(async ({ credentialPath, pairingPath, inboxPath }) => {
    await configureTelegramIntegration({
      botToken: TOKEN,
      telegramUserId: "123456789",
      credentialPath,
      fetchImpl: async () => ({ ok: true, status: 200 }),
    });
    await fs.writeFile(pairingPath, JSON.stringify({ stale: true }), { mode: 0o600 });
    await fs.writeFile(inboxPath, JSON.stringify({ stale: true }), { mode: 0o600 });
    const taskStatePath = path.join(path.dirname(credentialPath), "telegram-task-state.json");
    await fs.writeFile(taskStatePath, JSON.stringify({ stale: true }), { mode: 0o600 });
    const attachmentRoot = path.join(path.dirname(credentialPath), "Telegram Inbox");
    await fs.mkdir(attachmentRoot, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(attachmentRoot, "stale.bin"), "stale", { mode: 0o600 });
    assert.deepEqual(await disconnectTelegramIntegration({ credentialPath, pairingPath, inboxPath }), { disconnected: true });
    await assert.rejects(fs.access(taskStatePath));
    assert.equal(await fs.readFile(path.join(attachmentRoot, "stale.bin"), "utf8"), "stale");
    assert.deepEqual(await getTelegramIntegrationStatus({ credentialPath, pairingPath, inboxPath }), {
      configured: false, ready: false, needsAttention: false, userIdHint: null,
      pairing: expectedPairingIdle(), pendingInboundCount: 0, remoteControl: { enabled: true },
    });
  });
});

test("pairing discovers only a private /start user and requires explicit confirmation", async () => {
  await withTempCredential(async ({ credentialPath, pairingPath, inboxPath }) => {
    const calls = [];
    const fetchImpl = telegramJsonFetch([
      { result: { id: 999, is_bot: true, username: "EquinoxTestBot" } },
      { result: [{ update_id: 40, message: { chat: { id: 111, type: "private" }, from: { id: 111 }, text: "old" } }] },
      { result: [
        { update_id: 41, message: { chat: { id: -1001, type: "supergroup" }, from: { id: 222 }, text: "/start" } },
        { update_id: 42, message: { chat: { id: 333, type: "private" }, from: { id: 333, username: "samet" }, text: "/start" } },
      ] },
    ], calls);
    const started = await startTelegramPairing({ botToken: TOKEN, pairingPath, fetchImpl, now: () => 1_000 });
    assert.equal(started.active, true);
    assert.equal(started.botUsername, "EquinoxTestBot");
    assert.equal(started.candidateFound, false);
    const pairing = await pollTelegramPairing({ pairingPath, fetchImpl, now: () => 2_000 });
    assert.equal(pairing.candidateFound, true);
    assert.equal(pairing.candidateLabel, "@samet");
    assert.equal(pairing.userIdHint, "…333");
    const privateState = JSON.parse(await fs.readFile(pairingPath, "utf8"));
    assert.equal(privateState.nextUpdateId, 43);
    assert.equal(privateState.candidate.telegramUserId, "333");
    assert.equal((await fs.lstat(pairingPath)).mode & 0o077, 0);

    const confirmFetch = telegramJsonFetch([], []);
    // sendTelegramChunk only checks HTTP status and does not consume JSON.
    confirmFetch.calls.length = 0;
    const status = await confirmTelegramPairing({
      pairingPath, credentialPath, inboxPath,
      fetchImpl: async (url, init) => { confirmFetch.calls.push({ url, init, body: JSON.parse(init.body) }); return { ok: true, status: 200 }; },
      now: () => 3_000,
    });
    assert.equal(status.ready, true);
    assert.equal(status.userIdHint, "…333");
    const storedCredential = JSON.parse(await fs.readFile(credentialPath, "utf8"));
    assert.equal(storedCredential.telegramUserId, "333");
    const inbox = JSON.parse(await fs.readFile(inboxPath, "utf8"));
    assert.equal(inbox.nextUpdateId, 43);
    assert.deepEqual(inbox.pending, []);
    await assert.rejects(fs.access(pairingPath));
  });
});

test("pairing cancellation removes only transient pairing state", async () => {
  await withTempCredential(async ({ pairingPath }) => {
    await fs.mkdir(path.dirname(pairingPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(pairingPath, `${JSON.stringify({ version: 1, botToken: TOKEN, expiresAt: new Date(Date.now() + 60_000).toISOString(), nextUpdateId: 0, candidate: null })}\n`, { mode: 0o600 });
    assert.deepEqual(await cancelTelegramPairing({ pairingPath }), { cancelled: true });
    assert.deepEqual(await getTelegramPairingStatus({ pairingPath }), expectedPairingIdle());
  });
});

test("inbound polling accepts only the paired private user and persists restart-safe offset", async () => {
  await withTempCredential(async ({ credentialPath, inboxPath }) => {
    await fs.mkdir(path.dirname(credentialPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(credentialPath, `${JSON.stringify({ version: 2, botToken: TOKEN, telegramUserId: "333" })}\n`, { mode: 0o600 });
    const calls = [];
    const firstFetch = telegramJsonFetch([{ result: [
      { update_id: 5, message: { message_id: 10, chat: { id: 444, type: "private" }, from: { id: 444 }, text: "wrong user" } },
      { update_id: 6, message: { message_id: 11, chat: { id: -100, type: "group" }, from: { id: 333 }, text: "group message" } },
      { update_id: 7, message: { message_id: 12, reply_to_message: { message_id: 70 }, chat: { id: 333, type: "private" }, from: { id: 333 }, text: "Continue the task" } },
      { update_id: 8, callback_query: { id: "cb-group", from: { id: 333 }, message: { message_id: 71, chat: { id: -100, type: "group" } }, data: "eqx:c:r-route123" } },
      { update_id: 9, callback_query: { id: "cb-private", from: { id: 333 }, message: { message_id: 72, chat: { id: 333, type: "private" } }, data: "eqx:c:r-route123" } },
    ] }], calls);
    const first = await pollTelegramInboundOnce({ credentialPath, inboxPath, fetchImpl: firstFetch, now: () => 5_000 });
    assert.deepEqual(first, { configured: true, received: 2, pendingCount: 2, nextUpdateId: 10 });
    const stored = JSON.parse(await fs.readFile(inboxPath, "utf8"));
    assert.equal(stored.nextUpdateId, 10);
    assert.equal(stored.pending.length, 2);
    assert.equal(stored.pending[0].text, "Continue the task");
    assert.equal(stored.pending[0].replyToMessageId, 70);
    assert.equal(stored.pending[1].callbackQueryId, "cb-private");
    assert.equal(stored.pending[1].messageId, 72);

    const secondCalls = [];
    const second = await pollTelegramInboundOnce({
      credentialPath, inboxPath,
      fetchImpl: telegramJsonFetch([{ result: [] }], secondCalls),
      now: () => 6_000,
    });
    assert.deepEqual(second, { configured: true, received: 0, pendingCount: 2, nextUpdateId: 10 });
    assert.equal(secondCalls[0].body.offset, 10, "restart-safe offset prevents replaying consumed updates");
  });
});

test("inbound polling keeps bounded document metadata only for the paired private user", async () => {
  await withTempCredential(async ({ credentialPath, inboxPath }) => {
    await fs.mkdir(path.dirname(credentialPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(credentialPath, `${JSON.stringify({ version: 2, botToken: TOKEN, telegramUserId: "333" })}\n`, { mode: 0o600 });
    const fetchImpl = telegramJsonFetch([{ result: [
      { update_id: 20, message: { message_id: 80, reply_to_message: { message_id: 70 }, chat: { id: 333, type: "private" }, from: { id: 333 }, caption: "Read this", document: { file_id: "doc-file-1", file_unique_id: "unique-doc-1", file_name: "report.pdf", mime_type: "application/pdf", file_size: 2048 } } },
      { update_id: 21, message: { message_id: 81, chat: { id: 444, type: "private" }, from: { id: 444 }, document: { file_id: "wrong-user", file_name: "nope.txt", file_size: 10 } } },
    ] }]);
    const result = await pollTelegramInboundOnce({ credentialPath, inboxPath, fetchImpl, now: () => 10_000 });
    assert.deepEqual(result, { configured: true, received: 1, pendingCount: 1, nextUpdateId: 22 });
    const stored = JSON.parse(await fs.readFile(inboxPath, "utf8"));
    assert.equal(stored.pending[0].text, "Read this");
    assert.equal(stored.pending[0].replyToMessageId, 70);
    assert.deepEqual(stored.pending[0].attachment, {
      fileId: "doc-file-1", fileUniqueId: "unique-doc-1", kind: "document", fileName: "report.pdf", mimeType: "application/pdf", bytes: 2048,
    });
  });
});

test("Telegram attachment download uses getFile plus fixed Bot API file path and stores a private bounded file", async () => {
  await withTempCredential(async ({ root, credentialPath }) => {
    await fs.mkdir(path.dirname(credentialPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(credentialPath, `${JSON.stringify({ version: 2, botToken: TOKEN, telegramUserId: "333" })}\n`, { mode: 0o600 });
    const attachmentRoot = path.join(root, "attachments");
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      if (String(url).endsWith("/getFile")) {
        assert.deepEqual(JSON.parse(init.body), { file_id: "doc-file-1" });
        return new Response(JSON.stringify({ ok: true, result: { file_path: "documents/report.pdf" } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      assert.equal(String(url), `https://api.telegram.org/file/bot${TOKEN}/documents/report.pdf`);
      return new Response(Buffer.from("hello telegram"), { status: 200, headers: { "content-length": "14" } });
    };
    const result = await downloadTelegramAttachment({
      updateId: 123,
      attachment: { fileId: "doc-file-1", fileUniqueId: "uniq", kind: "document", fileName: "report.pdf", mimeType: "application/pdf", bytes: 14 },
      credentialPath, attachmentRoot, fetchImpl,
    });
    assert.equal(result.attachmentId, "tgatt-000123");
    assert.equal(result.fileName, "report.pdf");
    assert.equal(result.bytes, 14);
    assert.equal(result.sha256, createHash("sha256").update("hello telegram").digest("hex"));
    assert.equal(await fs.readFile(result.storagePath, "utf8"), "hello telegram");
    assert.equal((await fs.lstat(result.storagePath)).mode & 0o077, 0);
    assert.equal(calls.length, 2);

    await assert.rejects(() => downloadTelegramAttachment({
      updateId: 124,
      attachment: { fileId: "doc-file-2", kind: "document", fileName: "huge.bin", mimeType: "application/octet-stream", bytes: 20 * 1024 * 1024 + 1 },
      credentialPath, attachmentRoot, fetchImpl,
    }), /20 MiB/u);
  });
});

test("Telegram photo upload surfaces image-processing failures instead of misreporting recipient errors", async () => {
  await withTempCredential(async ({ root, credentialPath }) => {
    await fs.mkdir(path.dirname(credentialPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(credentialPath, `${JSON.stringify({ version: 2, botToken: TOKEN, telegramUserId: "333" })}\n`, { mode: 0o600 });
    const filePath = path.join(root, "bad.png");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4ioAAAAASUVORK5CYII=", "base64");
    await fs.writeFile(filePath, png);
    await assert.rejects(() => sendTelegramFile({
      filePath, mode: "photo", credentialPath,
      resolveFile: async () => ({ absolutePath: filePath, bytes: png.length }),
      fetchImpl: async () => new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: IMAGE_PROCESS_FAILED" }), { status: 400, headers: { "content-type": "application/json" } }),
    }), /could not process this image as a photo/u);
  });
});

test("Telegram outbound file upload keeps recipient fixed and requires the injected local path policy", async () => {
  await withTempCredential(async ({ root, credentialPath }) => {
    await fs.mkdir(path.dirname(credentialPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(credentialPath, `${JSON.stringify({ version: 2, botToken: TOKEN, telegramUserId: "333" })}\n`, { mode: 0o600 });
    const filePath = path.join(root, "notes.txt");
    await fs.writeFile(filePath, "hello file");
    const resolvedPaths = [];
    const fetchImpl = async (url, init) => {
      assert.match(String(url), /\/sendDocument$/u);
      assert.equal(init.body instanceof FormData, true);
      assert.equal(init.body.get("chat_id"), "333");
      assert.equal(init.body.get("caption"), "For you");
      const uploaded = init.body.get("document");
      assert.equal(uploaded instanceof Blob, true);
      assert.equal(uploaded.size, 10);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const result = await sendTelegramFile({
      filePath, caption: "For you", mode: "auto", credentialPath, fetchImpl,
      resolveFile: async (candidate) => { resolvedPaths.push(candidate); return { absolutePath: filePath, bytes: 10 }; },
    });
    assert.deepEqual(resolvedPaths, [filePath]);
    assert.equal(result.messageId, 99);
    assert.equal(result.mode, "document");
    assert.equal(result.fileName, "notes.txt");
    await assert.rejects(() => sendTelegramFile({ filePath, credentialPath, fetchImpl, resolveFile: null }), /path policy is unavailable/u);
  });
});

test("task-scoped Telegram attachment open verifies current humanInput and hides the private storage path", async () => {
  await withTempCredential(async ({ root }) => {
    const attachmentRoot = path.join(root, "Telegram Inbox");
    await fs.mkdir(attachmentRoot, { recursive: true, mode: 0o700 });
    const storagePath = path.join(attachmentRoot, "tgatt-000123-report.txt");
    const data = Buffer.from("task attachment");
    await fs.writeFile(storagePath, data, { mode: 0o600 });
    const attachment = {
      attachmentId: "tgatt-000123", kind: "document", fileName: "report.txt", mimeType: "text/plain", bytes: data.length,
      sha256: createHash("sha256").update(data).digest("hex"), storagePath,
    };
    const store = { readInternal: async (taskId) => ({ taskId, humanInput: { attachments: [attachment] } }) };
    const result = await openTelegramTaskAttachment({ taskId: "task-abcdef12", attachmentId: attachment.attachmentId, store, attachmentRoot });
    assert.equal(result.content[0].text.includes(storagePath), false);
    assert.equal(result.content[1].type, "resource");
    assert.equal(Buffer.from(result.content[1].resource.blob, "base64").toString("utf8"), "task attachment");
    await assert.rejects(() => openTelegramTaskAttachment({ taskId: "task-abcdef12", attachmentId: "tgatt-999999", store, attachmentRoot }), /not part of the task/u);
  });
});

test("task card send/edit/callback APIs keep recipient fixed and validate bounded inline controls", async () => {
  await withTempCredential(async ({ credentialPath }) => {
    await fs.mkdir(path.dirname(credentialPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(credentialPath, `${JSON.stringify({ version: 2, botToken: TOKEN, telegramUserId: "333" })}\n`, { mode: 0o600 });
    const calls = [];
    const fetchImpl = telegramJsonFetch([
      { result: { message_id: 77 } },
      { result: { message_id: 77 } },
      { result: true },
    ], calls);
    const keyboard = [[
      { text: "▶ Continue", callbackData: "eqx:c:r-route123" },
      { text: "💬 Open", url: "https://chatgpt.com/c/abcdef12-3456-7890-abcd-ef1234567890" },
    ]];
    assert.deepEqual(await sendTelegramTaskCard({ text: "Task status", keyboard, credentialPath, fetchImpl }), { sent: true, messageId: 77 });
    assert.equal(calls[0].body.chat_id, "333");
    assert.equal(calls[0].body.reply_markup.inline_keyboard[0][0].callback_data, "eqx:c:r-route123");
    assert.equal(calls[0].body.reply_markup.inline_keyboard[0][1].url.startsWith("https://chatgpt.com/"), true);
    assert.deepEqual(await editTelegramTaskCard({ messageId: 77, text: "Updated", keyboard, credentialPath, fetchImpl }), { edited: true, messageId: 77 });
    assert.deepEqual(await answerTelegramTaskCallback({ callbackQueryId: "cb-1", text: "Continue armed.", credentialPath, fetchImpl }), { answered: true });
    await assert.rejects(() => sendTelegramTaskCard({ text: "bad", keyboard: [[{ text: "Bad", callbackData: "evil:route" }]], credentialPath, fetchImpl }), /callback data is invalid/u);
    await assert.rejects(
      () => sendTelegramTaskCard({ text: "bad", keyboard: [[{ text: "Bad", url: "https://example.com/" }]], credentialPath, fetchImpl }),
      /^Error: Telegram task link must be a chatgpt\.com HTTPS URL\.$/u,
    );
  });
});

test("task card edit treats Telegram message-is-not-modified as idempotent success", async () => {
  await withTempCredential(async ({ credentialPath }) => {
    await fs.mkdir(path.dirname(credentialPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(credentialPath, `${JSON.stringify({ version: 2, botToken: TOKEN, telegramUserId: "333" })}\n`, { mode: 0o600 });
    const fetchImpl = telegramJsonFetch([{
      status: 400,
      payload: { ok: false, error_code: 400, description: "Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message" },
    }]);
    assert.deepEqual(
      await editTelegramTaskCard({ messageId: 77, text: "Already current", credentialPath, fetchImpl }),
      { edited: false, unchanged: true, messageId: 77 },
    );
  });
});

test("Telegram tools preserve fixed-recipient routing and expose bounded send-file/task-attachment operations", async () => {
  const registrations = new Map();
  const rawRegistrations = new Map();
  const messages = [];
  const fileCalls = [];
  const openCalls = [];
  const taskStore = { readInternal: async () => ({}) };
  registerTelegramSendTool({
    registerTextTool(name, config, handler, options = {}) {
      registrations.set(name, { config, handler, options });
    },
    registerRawTool(name, config, handler, options = {}) {
      rawRegistrations.set(name, { config, handler, options });
    },
    z,
    taskStore,
    sendMessage: async ({ message }) => {
      messages.push(message);
      return { sent: true, messageCount: message === "one" ? 1 : 3 };
    },
    resolveOutboundFile: async (filePath) => ({ absolutePath: filePath, bytes: 12 }),
    sendFile: async (input) => {
      fileCalls.push(input);
      const resolved = await input.resolveFile(input.filePath);
      return { sent: true, messageId: 55, mode: input.mode, fileName: path.basename(resolved.absolutePath), bytes: resolved.bytes, mimeType: "text/plain" };
    },
    openAttachment: async (input) => {
      openCalls.push(input);
      return { content: [{ type: "text", text: "opened" }] };
    },
    textResult: (text) => ({ text }),
    errorResult: (error) => ({ error: error instanceof Error ? error.message : String(error) }),
  });

  const registration = registrations.get("telegram_send_message");
  assert.ok(registration);
  assert.equal(registration.options.projectAware, false);
  assert.deepEqual(registration.options.mutationScopes, ["global"]);
  assert.equal(registration.config.annotations.openWorldHint, true);
  assert.equal(registration.config.inputSchema.message.safeParse("x".repeat(12_001)).success, false);
  assert.deepEqual(await registration.handler({ message: "one" }), { text: "Telegram mesajı gönderildi." });
  assert.deepEqual(await registration.handler({ message: "many" }), { text: "Telegram mesajı 3 parça halinde gönderildi." });
  assert.deepEqual(messages, ["one", "many"]);

  const fileRegistration = registrations.get("telegram_send_file");
  assert.ok(fileRegistration);
  assert.equal(fileRegistration.options.projectAware, false);
  assert.deepEqual(fileRegistration.options.mutationScopes, ["global"]);
  assert.equal(fileRegistration.config.inputSchema.mode.safeParse("video").success, false);
  assert.deepEqual(await fileRegistration.handler({ path: "/tmp/report.txt", caption: "Here", mode: "document" }), {
    text: "Telegram document gönderildi: report.txt (12 bytes).",
  });
  assert.equal(fileCalls.length, 1);
  assert.equal(fileCalls[0].filePath, "/tmp/report.txt");
  assert.equal(fileCalls[0].caption, "Here");

  const openRegistration = rawRegistrations.get("telegram_attachment_open");
  assert.ok(openRegistration);
  assert.equal(openRegistration.options.capabilityDomain, "files");
  assert.equal(openRegistration.options.mcpExposed, false);
  assert.deepEqual(await openRegistration.handler({ task_id: "task-abcdef12", attachment_id: "tgatt-000123" }), {
    content: [{ type: "text", text: "opened" }],
  });
  assert.equal(openCalls.length, 1);
  assert.equal(openCalls[0].taskId, "task-abcdef12");
  assert.equal(openCalls[0].attachmentId, "tgatt-000123");
  assert.equal(openCalls[0].store, taskStore);

  assert.deepEqual([...rawRegistrations.keys()].sort(), ["telegram_attachment_open"]);
});
