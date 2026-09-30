import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { protectWindowsPrivateStatePath, verifyWindowsPrivateStateAcl } from "../../src/equinox-local-private-state.js";
import {
  configureTelegramIntegration,
  disconnectTelegramIntegration,
  getTelegramDownloadSettings,
  getTelegramRemoteControlSettings,
  pollTelegramInboundOnce,
  setTelegramDownloadLocation,
  setTelegramRemoteControlEnabled,
  startTelegramPairing,
} from "../../src/telegram-integration.js";
import { createTelegramTaskInboxController } from "../../src/telegram-task-inbox-controller.js";

const execFile = promisify(execFileCallback);
const TOKEN = `12345:${"A".repeat(24)}`;

function telegramFetch() {
  return async (url) => {
    const method = String(url).split("/").at(-1);
    let result = true;
    if (method === "getMe") result = { id: 12345, is_bot: true, username: "EquinoxAclTestBot" };
    if (method === "getUpdates") result = [];
    return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
  };
}

function noopStore() {
  const fn = async () => null;
  return { list: async () => [], readInternal: fn, checkpoint: fn, bindChat: fn, queueHumanInput: fn, finish: fn, cancel: fn };
}

function noopTimer() { return { unref() {} }; }

async function assertSafe(target, type) {
  const result = await verifyWindowsPrivateStateAcl({ target, type });
  assert.deepEqual(result, { safe: true, reason: null });
}

async function icaclsSnapshot(target) {
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT;
  const icacls = path.join(systemRoot, "System32", "icacls.exe");
  return (await execFile(icacls, [target], { windowsHide: true })).stdout;
}

async function injectForeignAce(target) {
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT;
  const icacls = path.join(systemRoot, "System32", "icacls.exe");
  await execFile(icacls, [target, "/grant", "*S-1-1-0:(R)"], { windowsHide: true });
}

async function enableInheritance(target) {
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT;
  const icacls = path.join(systemRoot, "System32", "icacls.exe");
  await execFile(icacls, [target, "/inheritance:e"], { windowsHide: true });
}

test("Windows Telegram private state uses current-user ACLs and rejects foreign state without mutation", { skip: process.platform !== "win32" }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "Equinox ACL Türk User "));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const secrets = path.join(root, "Private State", "secrets");
  const settings = path.join(root, "Private State", "settings");
  const credentialPath = path.join(secrets, "telegram.json");
  const pairingPath = path.join(secrets, "telegram-pairing.json");
  const inboxPath = path.join(secrets, "telegram-inbox.json");
  const taskStatePath = path.join(secrets, "telegram-task-state.json");
  const remoteSettingsPath = path.join(settings, "telegram-remote-control.json");
  const downloadSettingsPath = path.join(settings, "telegram-downloads.json");
  const downloadRoot = path.join(root, "Visible Downloads");
  await fs.mkdir(downloadRoot, { recursive: true });
  const fetchImpl = telegramFetch();

  await configureTelegramIntegration({ botToken: TOKEN, telegramUserId: "123456789", credentialPath, fetchImpl });
  await pollTelegramInboundOnce({ credentialPath, inboxPath, fetchImpl });
  await startTelegramPairing({ botToken: TOKEN, pairingPath, fetchImpl, now: () => 1_000 });
  await setTelegramRemoteControlEnabled({ enabled: false, settingsPath: remoteSettingsPath });
  await setTelegramDownloadLocation({ downloadPath: downloadRoot, settingsPath: downloadSettingsPath, homeDir: process.env.USERPROFILE });

  const controller = createTelegramTaskInboxController({
    store: noopStore(),
    autoContinueController: { armBound: async () => null },
    statePath: taskStatePath,
    pauseAgent: async () => null,
    resumeAgent: async () => null,
    requestRestart: async () => null,
    deliverChatMessage: async () => null,
    readChatResponse: async () => null,
    inspectChatIdentity: async () => null,
    startTaskChat: async () => null,
    setTimeoutImpl: noopTimer,
    clearTimeoutImpl: () => {},
  });
  await controller.initialize();

  for (const directory of [secrets, settings]) await assertSafe(directory, "directory");
  for (const file of [credentialPath, pairingPath, inboxPath, taskStatePath, remoteSettingsPath, downloadSettingsPath]) await assertSafe(file, "file");
  assert.deepEqual(await getTelegramRemoteControlSettings({ settingsPath: remoteSettingsPath }), { enabled: false });

  await injectForeignAce(remoteSettingsPath);
  const foreign = await verifyWindowsPrivateStateAcl({ target: remoteSettingsPath, type: "file" });
  assert.equal(foreign.safe, false);
  assert.equal(foreign.reason, "foreign-principal");
  const foreignAclBefore = await icaclsSnapshot(remoteSettingsPath);
  const foreignBytesBefore = await fs.readFile(remoteSettingsPath);
  await assert.rejects(
    getTelegramRemoteControlSettings({ settingsPath: remoteSettingsPath }),
    (error) => error?.code === "EQUINOX_TELEGRAM_PRIVATE_STATE_SECURITY",
  );
  await assert.rejects(
    setTelegramRemoteControlEnabled({ enabled: true, settingsPath: remoteSettingsPath }),
    (error) => error?.code === "EQUINOX_TELEGRAM_PRIVATE_STATE_SECURITY",
  );
  assert.deepEqual(await fs.readFile(remoteSettingsPath), foreignBytesBefore);
  assert.equal(await icaclsSnapshot(remoteSettingsPath), foreignAclBefore, "read/write refusal must not repair foreign ACL state");
  await protectWindowsPrivateStatePath({ target: remoteSettingsPath, type: "file" });

  await enableInheritance(downloadSettingsPath);
  const inherited = await verifyWindowsPrivateStateAcl({ target: downloadSettingsPath, type: "file" });
  assert.equal(inherited.safe, false);
  assert.ok(["inheritance", "inherited-rule", "foreign-principal"].includes(inherited.reason));
  const inheritedAclBefore = await icaclsSnapshot(downloadSettingsPath);
  await assert.rejects(
    getTelegramDownloadSettings({ settingsPath: downloadSettingsPath, homeDir: process.env.USERPROFILE }),
    (error) => error?.code === "EQUINOX_TELEGRAM_PRIVATE_STATE_SECURITY",
  );
  assert.equal(await icaclsSnapshot(downloadSettingsPath), inheritedAclBefore, "unsafe inherited ACL must remain untouched on read");
  await protectWindowsPrivateStatePath({ target: downloadSettingsPath, type: "file" });

  await injectForeignAce(credentialPath);
  const credentialBefore = await fs.readFile(credentialPath);
  await assert.rejects(
    disconnectTelegramIntegration({ credentialPath, pairingPath, inboxPath, taskStatePath }),
    (error) => error?.code === "EQUINOX_TELEGRAM_PRIVATE_STATE_SECURITY",
  );
  assert.deepEqual(await fs.readFile(credentialPath), credentialBefore);
  for (const file of [pairingPath, inboxPath, taskStatePath]) await fs.access(file);

  console.log("Windows private-state ACL acceptance passed: Telegram credential/settings/inbox/pairing/task state are current-user protected and foreign ACLs fail closed without mutation.");
});
