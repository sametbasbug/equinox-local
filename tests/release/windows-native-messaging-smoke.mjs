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

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error(`Windows Native Messaging smoke requires win32-x64; got ${process.platform}-${process.arch}.`);
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
    "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
    "-property", "installationPath",
  ], { timeout: 10_000, windowsHide: true });
  const installation = stdout.trim();
  assert.ok(installation, "Visual Studio C++ toolchain is unavailable on the Windows runner");
  const vcvars = path.join(installation, "VC", "Auxiliary", "Build", "vcvars64.bat");
  const source = path.join(REPO_ROOT, "native", "windows", "equinox-browser-native-host-launcher.cpp");
  const command = `call "${vcvars}" >nul && cl.exe /nologo /std:c++17 /O2 /EHsc /DUNICODE /D_UNICODE "${source}" /Fe:equinox-browser-native-host.exe`;
  await execFile("cmd.exe", ["/d", "/s", "/c", command], {
    cwd: browserDir,
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  const stat = await fs.lstat(launcherPath);
  assert.equal(stat.isFile(), true, "Windows Native Messaging launcher was not compiled");
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
let child = null;
let registration = null;
let stderr = "";
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
  child = spawn(launcherPath, [origin, "--parent-window=4242"], {
    cwd: releaseDir,
    env: { ...process.env, EQUINOX_LOCAL_BROWSER_SOCKET_NAMESPACE: namespace },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const nativeMessages = collectNativeMessages(child.stdout);

  await waitFor(
    () => nativeMessages.find((message) => message?.type === "host.status" && message.localConnected === true),
    `launcher did not expose Native Messaging stdout after named-pipe connect; stderr=${stderr}`,
  );
  child.stdin.write(encodeNativeMessage({
    type: "extension.hello",
    extensionId: EQUINOX_BROWSER_EXTENSION_ID,
    extensionVersion: "0.7.1-windows-launcher-smoke",
    protocolVersion: 1,
    capabilities: ["ping"],
    instanceId: "22222222-2222-4222-8222-222222222222",
    browserContext: "user",
  }));
  await bridge.waitUntilReady(5_000, { context: "user" });

  const callPromise = bridge.call("launcher.echo", { marker: "stdio-ok" }, { context: "user", timeoutMs: 5_000 });
  const command = await waitFor(
    () => nativeMessages.find((message) => message?.type === "command" && message.method === "launcher.echo"),
    `launcher did not forward bridge command to Native Messaging stdout; stderr=${stderr}`,
  );
  assert.deepEqual(command.args, { marker: "stdio-ok" });
  child.stdin.write(encodeNativeMessage({ type: "response", id: command.id, ok: true, result: { marker: "stdio-ok" } }));
  assert.deepEqual(await callPromise, { marker: "stdio-ok" });

  child.stdin.end();
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
  assert.equal(exitCode, 0, `launcher/native host exited unsuccessfully; stderr=${stderr}`);
  child = null;

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
    launcherPath,
    registryRoundTrip: true,
    namedPipe: endpoint.endpoint,
    bidirectionalStdio: true,
    originForwarded: true,
  }, null, 2)}\n`);
} finally {
  if (child) {
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
