import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  createEquinoxBrowserBridge,
  EQUINOX_BROWSER_EXTENSION_ID,
} from "../../src/equinox-browser-bridge.js";
import { equinoxBrowserIpcEndpoint } from "../../src/equinox-browser-socket.js";
import {
  readWindowsNativeMessagingRegistryValue,
  registerWindowsNativeMessagingHost,
  unregisterWindowsNativeMessagingHost,
  windowsNativeMessagingLauncherPath,
} from "../../src/equinox-browser-windows-native-messaging.js";

const execFile = promisify(execFileCallback);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const TARGET = `${process.platform}-${process.arch}`;
const TARGET_CONFIG = {
  "win32-x64": { component: "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", vcvars: "vcvars64.bat", peMachine: 0x8664 },
  "win32-arm64": { component: "Microsoft.VisualStudio.Component.VC.Tools.ARM64", vcvars: "vcvarsarm64.bat", peMachine: 0xaa64 },
}[TARGET];
if (!TARGET_CONFIG) {
  throw new Error(`Windows Native Messaging smoke requires native win32-x64 or win32-arm64; got ${TARGET}.`);
}

function encodeNativeMessage(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

function collectNativeMessages(stream) {
  const messages = [];
  let buffer = Buffer.alloc(0);
  stream.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (length > 4 * 1024 * 1024) throw new Error("Native Messaging smoke received an oversized frame.");
      if (buffer.length < length + 4) return;
      const payload = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);
      messages.push(JSON.parse(payload.toString("utf8")));
    }
  });
  return messages;
}

async function waitFor(predicate, message, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

async function compileLauncher(releaseDir) {
  const launcherPath = windowsNativeMessagingLauncherPath(releaseDir);
  const browserDir = path.dirname(launcherPath);
  await fs.mkdir(browserDir, { recursive: true });
  const vswhere = path.join(process.env["ProgramFiles(x86)"], "Microsoft Visual Studio", "Installer", "vswhere.exe");
  const { stdout } = await execFile(vswhere, [
    "-latest",
    "-products", "*",
    "-requires", TARGET_CONFIG.component,
    "-property", "installationPath",
  ], { timeout: 10_000, windowsHide: true });
  const installation = stdout.trim();
  assert.ok(installation, "Visual Studio C++ toolchain is unavailable on the Windows runner");
  const vcvars = path.join(installation, "VC", "Auxiliary", "Build", TARGET_CONFIG.vcvars);
  const source = path.join(REPO_ROOT, "native", "windows", "equinox-browser-native-host-launcher.cpp");
  const command = `""${vcvars}" >nul && cl.exe /nologo /std:c++17 /O2 /EHsc /DUNICODE /D_UNICODE "${source}" /Fe:equinox-browser-native-host.exe"`;
  await execFile("cmd.exe", ["/d", "/s", "/c", command], {
    cwd: browserDir,
    // Hosted Windows images can cold-start the VS toolchain slowly after an image refresh.
    // Keep this bounded, but do not turn a successful compile into a 60s infrastructure flake.
    timeout: 180_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    windowsVerbatimArguments: true,
  });
  const stat = await fs.lstat(launcherPath);
  assert.equal(stat.isFile(), true, "Windows Native Messaging launcher was not compiled");
  const bytes = await fs.readFile(launcherPath);
  const peOffset = bytes.readInt32LE(0x3c);
  assert.equal(bytes.toString("ascii", peOffset, peOffset + 4), "PE\0\0", "Windows Native Messaging launcher has an invalid PE header");
  assert.equal(bytes.readUInt16LE(peOffset + 4), TARGET_CONFIG.peMachine, `Windows Native Messaging launcher architecture does not match ${TARGET}`);
  return launcherPath;
}

async function prepareReleaseLayout(root) {
  const releaseDir = path.join(root, "Release Ü");
  const nodeDir = path.join(releaseDir, "runtime", "node", "bin");
  await fs.mkdir(nodeDir, { recursive: true });
  await fs.copyFile(process.execPath, path.join(nodeDir, "node.exe"));
  for (const name of [
    "equinox-browser-native-host.js",
    "equinox-browser-native-host-runtime.js",
    "equinox-browser-socket.js",
  ]) {
    await fs.copyFile(path.join(REPO_ROOT, "src", name), path.join(releaseDir, name));
  }
  await fs.writeFile(path.join(releaseDir, "package.json"), '{"type":"module"}\n', { flag: "wx" });
  const launcherPath = await compileLauncher(releaseDir);
  return { releaseDir, launcherPath };
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-native-messaging-"));
const namespace = `launcher-smoke-${process.pid}`;
const endpoint = equinoxBrowserIpcEndpoint({ platform: "win32", namespace });
const bridge = createEquinoxBrowserBridge({ bridgeEndpoint: endpoint, callTimeoutMs: 5_000 });
const manifestRoot = path.join(root, "Native Messaging Ü");
const children = new Set();
let registration = null;

function startNativeHost({ launcherPath, releaseDir, origin, parentWindow }) {
  const state = { child: null, messages: [], stderr: "" };
  const child = spawn(launcherPath, [origin, `--parent-window=${parentWindow}`], {
    cwd: releaseDir,
    env: { ...process.env, EQUINOX_LOCAL_BROWSER_SOCKET_NAMESPACE: namespace },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  state.child = child;
  children.add(child);
  child.once("exit", () => children.delete(child));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { state.stderr += chunk; });
  state.messages = collectNativeMessages(child.stdout);
  return state;
}

async function waitForNativeConnect(state, label) {
  await waitFor(
    () => state.messages.find((message) => message?.type === "host.status" && message.localConnected === true),
    `${label} launcher did not expose Native Messaging stdout after named-pipe connect; stderr=${state.stderr}`,
  );
}

async function stopNativeHost(state, label) {
  if (!state?.child) return;
  const child = state.child;
  if (child.exitCode !== null) return;
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
  child.stdin.end();
  const exitCode = await exit;
  assert.equal(exitCode, 0, `${label} launcher/native host exited unsuccessfully; stderr=${state.stderr}`);
}

try {
  const existingRegistry = await readWindowsNativeMessagingRegistryValue();
  assert.equal(existingRegistry, null, "Windows runner already has an Equinox Browser Native Messaging registration");

  const { releaseDir, launcherPath } = await prepareReleaseLayout(root);
  registration = await registerWindowsNativeMessagingHost({ manifestRoot, launcherPath });
  assert.equal(
    path.win32.normalize(await readWindowsNativeMessagingRegistryValue()).toLowerCase(),
    path.win32.normalize(registration.manifestPath).toLowerCase(),
    "HKCU Native Messaging registration did not round-trip",
  );

  await bridge.start();
  const origin = `chrome-extension://${EQUINOX_BROWSER_EXTENSION_ID}/`;

  const user = startNativeHost({ launcherPath, releaseDir, origin, parentWindow: 4242 });
  await waitForNativeConnect(user, "Your Browser");
  user.child.stdin.write(encodeNativeMessage({
    type: "extension.hello",
    extensionId: EQUINOX_BROWSER_EXTENSION_ID,
    extensionVersion: "0.7.1-windows-user-smoke",
    protocolVersion: 1,
    capabilities: ["ping"],
    instanceId: "11111111-1111-4111-8111-111111111111",
    browserContext: "user",
  }));
  await bridge.waitUntilReady(5_000, { context: "user" });

  bridge.expectContext("agent", { timeoutMs: 5_000 });
  const agent = startNativeHost({ launcherPath, releaseDir, origin, parentWindow: 4343 });
  await waitForNativeConnect(agent, "Agent Browser");
  agent.child.stdin.write(encodeNativeMessage({
    type: "extension.hello",
    extensionId: EQUINOX_BROWSER_EXTENSION_ID,
    extensionVersion: "0.7.1-windows-agent-smoke",
    protocolVersion: 1,
    capabilities: ["ping"],
    instanceId: "22222222-2222-4222-8222-222222222222",
    browserContext: "unassigned",
  }));
  await bridge.waitUntilReady(5_000, { context: "agent" });
  const contextSet = await waitFor(
    () => agent.messages.find((message) => message?.type === "command" && message.method === "context.set"),
    `Agent Browser did not receive its exact context persistence command; stderr=${agent.stderr}`,
  );
  assert.deepEqual(contextSet.args, { context: "agent" });
  agent.child.stdin.write(encodeNativeMessage({
    type: "response",
    id: contextSet.id,
    ok: true,
    result: { context: "agent" },
  }));

  assert.equal(bridge.snapshot().contexts.user.ready, true);
  assert.equal(bridge.snapshot().contexts.agent.ready, true);

  const userBefore = user.messages.length;
  const agentBeforeUserCall = agent.messages.length;
  const userCall = bridge.call("context.echo.user", { marker: "user-only" }, { context: "user", timeoutMs: 5_000 });
  const userCommand = await waitFor(
    () => user.messages.slice(userBefore).find((message) => message?.type === "command" && message.method === "context.echo.user"),
    `Your Browser did not receive its explicitly targeted command; stderr=${user.stderr}`,
  );
  assert.equal(agent.messages.slice(agentBeforeUserCall).some((message) => message?.method === "context.echo.user"), false);
  user.child.stdin.write(encodeNativeMessage({ type: "response", id: userCommand.id, ok: true, result: { marker: "user-only" } }));
  assert.deepEqual(await userCall, { marker: "user-only" });

  const agentBefore = agent.messages.length;
  const userBeforeAgentCall = user.messages.length;
  const agentCall = bridge.call("context.echo.agent", { marker: "agent-only" }, { context: "agent", timeoutMs: 5_000 });
  const agentCommand = await waitFor(
    () => agent.messages.slice(agentBefore).find((message) => message?.type === "command" && message.method === "context.echo.agent"),
    `Agent Browser did not receive its explicitly targeted command; stderr=${agent.stderr}`,
  );
  assert.equal(user.messages.slice(userBeforeAgentCall).some((message) => message?.method === "context.echo.agent"), false);
  agent.child.stdin.write(encodeNativeMessage({ type: "response", id: agentCommand.id, ok: true, result: { marker: "agent-only" } }));
  assert.deepEqual(await agentCall, { marker: "agent-only" });

  await stopNativeHost(agent, "Agent Browser");
  await waitFor(
    () => bridge.snapshot().contexts.agent.ready === false,
    "Agent Browser context remained ready after its exact Native Host exited",
  );
  assert.equal(bridge.snapshot().contexts.user.ready, true, "Your Browser must remain connected when Agent Browser exits");
  const userBeforeNoFallback = user.messages.length;
  await assert.rejects(
    bridge.call("context.must-not-fallback", {}, { context: "agent", timeoutMs: 300 }),
    /Agent Browser bağlı değil/u,
  );
  assert.equal(
    user.messages.slice(userBeforeNoFallback).some((message) => message?.method === "context.must-not-fallback"),
    false,
    "missing Agent Browser must never route a command to Your Browser",
  );

  await stopNativeHost(user, "Your Browser");

  const removed = await unregisterWindowsNativeMessagingHost({
    manifestPath: registration.manifestPath,
    launcherPath,
  });
  assert.equal(removed.manifestRemoved, true);
  assert.equal(await readWindowsNativeMessagingRegistryValue(), null, "HKCU Native Messaging key survived unregister");
  await assert.rejects(fs.lstat(registration.manifestPath), (error) => error?.code === "ENOENT");
  registration = null;

  process.stdout.write(`${JSON.stringify({
    ok: true,
    target: TARGET,
    launcherPath,
    registryRoundTrip: true,
    namedPipe: endpoint.endpoint,
    bidirectionalStdio: true,
    originForwarded: true,
    dualContextIsolation: true,
    agentPairing: true,
    noCrossContextFallback: true,
  }, null, 2)}\n`);
} finally {
  for (const child of children) {
    child.stdin?.end();
    child.kill();
  }
  if (registration) {
    await unregisterWindowsNativeMessagingHost({
      manifestPath: registration.manifestPath,
      launcherPath: registration.launcherPath,
    }).catch(() => {});
  }
  await bridge.close().catch(() => {});
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
}
