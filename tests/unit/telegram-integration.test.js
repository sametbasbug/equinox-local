import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  configureTelegramIntegration,
  defaultTelegramCredentialPath,
  disconnectTelegramIntegration,
  getTelegramIntegrationStatus,
  sendTelegramMessage,
  validateTelegramConnectionInput,
  validateTelegramMessage,
} from "../../src/telegram-integration.js";

const TOKEN = "123456789:abcdefghijklmnopqrstuvwxyzABCDE_12345";

async function withTempCredential(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-telegram-"));
  const credentialPath = path.join(root, "credentials", "telegram.json");
  try {
    await run({ root, credentialPath });
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

test("default Telegram credentials share the managed secrets lifecycle", () => {
  assert.equal(
    defaultTelegramCredentialPath("/Users/example"),
    "/Users/example/Library/Application Support/Equinox Local/secrets/telegram.json",
  );
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

test("configure stores credentials privately only after a successful Telegram message", async () => {
  await withTempCredential(async ({ credentialPath }) => {
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

    const stat = await fs.stat(credentialPath);
    assert.equal(stat.mode & 0o777, 0o600);
    const stored = JSON.parse(await fs.readFile(credentialPath, "utf8"));
    assert.equal(stored.version, 2);
    assert.equal(stored.botToken, TOKEN);
    assert.equal(stored.telegramUserId, "123456789");

    assert.deepEqual(await getTelegramIntegrationStatus({ credentialPath }), status);
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
  await withTempCredential(async ({ credentialPath }) => {
    await fs.mkdir(path.dirname(credentialPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(credentialPath, `${JSON.stringify({ version: 1, botToken: TOKEN, chatId: "123456789" })}\n`, { mode: 0o600 });
    assert.deepEqual(await getTelegramIntegrationStatus({ credentialPath }), {
      configured: true,
      ready: true,
      needsAttention: false,
      userIdHint: "…6789",
    });

    await fs.writeFile(credentialPath, `${JSON.stringify({ version: 1, botToken: TOKEN, chatId: "-1001234567890" })}\n`, { mode: 0o600 });
    assert.deepEqual(await getTelegramIntegrationStatus({ credentialPath }), {
      configured: false,
      ready: false,
      needsAttention: true,
      userIdHint: null,
    });
  });
});

test("disconnect removes only the validated Telegram credential file", async () => {
  await withTempCredential(async ({ credentialPath }) => {
    await configureTelegramIntegration({
      botToken: TOKEN,
      telegramUserId: "123456789",
      credentialPath,
      fetchImpl: async () => ({ ok: true, status: 200 }),
    });
    assert.deepEqual(await disconnectTelegramIntegration({ credentialPath }), { disconnected: true });
    assert.deepEqual(await getTelegramIntegrationStatus({ credentialPath }), {
      configured: false,
      ready: false,
      needsAttention: false,
      userIdHint: null,
    });
  });
});
