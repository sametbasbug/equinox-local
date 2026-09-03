import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildAgentBrowserLaunchArgs,
  createEquinoxAgentBrowser,
  ensureAgentBrowserNativeMessagingManifest,
  EQUINOX_BROWSER_STORE_URL,
} from "../../src/equinox-agent-browser.js";

async function prepareNativeHost(homeDir) {
  const installRoot = path.join(homeDir, "Library", "Application Support", "Equinox Local");
  await fs.mkdir(installRoot, { recursive: true, mode: 0o700 });
  const hostWrapperPath = path.join(installRoot, "equinox-browser-native-host");
  await fs.writeFile(hostWrapperPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await fs.chmod(hostWrapperPath, 0o700);
  return {
    hostWrapperPath,
    profileRoot: path.join(installRoot, "Agent Browser"),
  };
}

function createBridgeStub({ ready = false, becomeReadyAfterLaunch = false } = {}) {
  let agentReady = ready;
  let pairing = null;
  const calls = [];
  return {
    calls,
    readyFor(context) {
      assert.equal(context, "agent");
      return agentReady;
    },
    expectContext(context) {
      assert.equal(context, "agent");
      pairing = { context: "agent" };
      calls.push({ type: "expect", context });
      return pairing;
    },
    cancelExpectedContext() {
      const previous = pairing;
      pairing = null;
      calls.push({ type: "cancel" });
      return previous;
    },
    async waitUntilReady(_timeoutMs, { context }) {
      assert.equal(context, "agent");
      if (becomeReadyAfterLaunch) agentReady = true;
      if (!agentReady) throw new Error("not ready");
      return this.snapshotContext("agent");
    },
    snapshotContext(context) {
      assert.equal(context, "agent");
      return {
        context: "agent",
        ready: agentReady,
        connectedAt: agentReady ? "2026-09-03T10:00:00.000Z" : null,
        extension: agentReady ? { extensionVersion: "0.4.0" } : null,
      };
    },
    snapshot() {
      return { pairing };
    },
  };
}

test("Agent Browser launch args use an isolated profile without any remote debugging port", () => {
  const profileRoot = "/Users/test/Library/Application Support/Equinox Local/Agent Browser";
  const args = buildAgentBrowserLaunchArgs(profileRoot, { setup: true });
  assert.deepEqual(args.slice(0, 3), ["-na", "Google Chrome", "--args"]);
  assert.ok(args.includes(`--user-data-dir=${profileRoot}`));
  assert.ok(args.includes(EQUINOX_BROWSER_STORE_URL));
  assert.equal(args.some((arg) => /remote-debugging/iu.test(arg)), false);
});

test("Agent Browser Native Messaging projection refuses an unsafe host wrapper", async (t) => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-agent-browser-host-"));
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  const installRoot = path.join(homeDir, "Library", "Application Support", "Equinox Local");
  const profileRoot = path.join(installRoot, "Agent Browser");
  await fs.mkdir(installRoot, { recursive: true, mode: 0o700 });
  await fs.symlink("/bin/echo", path.join(installRoot, "equinox-browser-native-host"));

  await assert.rejects(
    ensureAgentBrowserNativeMessagingManifest({ homeDir, profileRoot }),
    /eksik veya güvenli değil/u,
  );
});

test("Agent Browser Native Messaging projection atomically replaces a hostile manifest symlink", async (t) => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-agent-browser-manifest-"));
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  const { profileRoot } = await prepareNativeHost(homeDir);
  const manifestRoot = path.join(profileRoot, "NativeMessagingHosts");
  const manifestPath = path.join(manifestRoot, "dev.equinox.browser.json");
  const sentinelPath = path.join(homeDir, "sentinel.txt");
  await fs.mkdir(manifestRoot, { recursive: true, mode: 0o700 });
  await fs.writeFile(sentinelPath, "unchanged\n", { mode: 0o600 });
  await fs.symlink(sentinelPath, manifestPath);

  await ensureAgentBrowserNativeMessagingManifest({ homeDir, profileRoot });

  const manifestStat = await fs.lstat(manifestPath);
  assert.equal(manifestStat.isFile(), true);
  assert.equal(manifestStat.isSymbolicLink(), false);
  assert.equal(manifestStat.mode & 0o777, 0o600);
  assert.equal(await fs.readFile(sentinelPath, "utf8"), "unchanged\n");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  assert.deepEqual(manifest.allowed_origins, ["chrome-extension://npdneefcobilfkjlihghjgjnknenhfoj/"]);
});

test("first Agent Browser launch opens the Chrome Web Store and starts pairing", async (t) => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-agent-browser-"));
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  const nativeHost = await prepareNativeHost(homeDir);
  const bridge = createBridgeStub();
  const launches = [];
  const manager = createEquinoxAgentBrowser({
    bridge,
    homeDir,
    platform: "darwin",
    execFileAsync: async (command, args, options) => {
      const manifestPath = path.join(nativeHost.profileRoot, "NativeMessagingHosts", "dev.equinox.browser.json");
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      const manifestStat = await fs.lstat(manifestPath);
      assert.equal(manifest.path, nativeHost.hostWrapperPath);
      assert.deepEqual(manifest.allowed_origins, ["chrome-extension://npdneefcobilfkjlihghjgjnknenhfoj/"]);
      assert.equal(manifestStat.mode & 0o777, 0o600);
      launches.push({ command, args, options });
      return { stdout: "", stderr: "" };
    },
  });

  const status = await manager.launch();
  assert.equal(launches.length, 1);
  assert.equal(launches[0].command, "/usr/bin/open");
  assert.ok(launches[0].args.includes(EQUINOX_BROWSER_STORE_URL));
  assert.equal(launches[0].args.some((arg) => /remote-debugging/iu.test(arg)), false);
  assert.equal(status.isolated, true);
  assert.equal(status.lastLaunchSetup, true);
  assert.deepEqual(bridge.calls[0], { type: "expect", context: "agent" });
});

test("ensureReady marks a paired Agent Browser and later cold starts do not reopen the store", async (t) => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-agent-browser-ready-"));
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  await prepareNativeHost(homeDir);
  const launches = [];
  const firstBridge = createBridgeStub({ becomeReadyAfterLaunch: true });
  const firstManager = createEquinoxAgentBrowser({
    bridge: firstBridge,
    homeDir,
    platform: "darwin",
    execFileAsync: async (command, args) => {
      launches.push({ command, args });
      return { stdout: "", stderr: "" };
    },
  });
  const ready = await firstManager.ensureReady({ timeoutMs: 500 });
  assert.equal(ready.ready, true);
  assert.ok(launches[0].args.includes(EQUINOX_BROWSER_STORE_URL));

  const secondBridge = createBridgeStub({ becomeReadyAfterLaunch: true });
  const secondManager = createEquinoxAgentBrowser({
    bridge: secondBridge,
    homeDir,
    platform: "darwin",
    execFileAsync: async (command, args) => {
      launches.push({ command, args });
      return { stdout: "", stderr: "" };
    },
  });
  await secondManager.ensureReady({ timeoutMs: 500 });
  assert.ok(launches[1].args.includes("about:blank"));
  assert.equal(launches[1].args.includes(EQUINOX_BROWSER_STORE_URL), false);
});

test("Agent Browser fails closed off macOS", async () => {
  const bridge = createBridgeStub();
  const manager = createEquinoxAgentBrowser({
    bridge,
    homeDir: "/tmp/equinox-agent-browser-linux",
    platform: "linux",
    execFileAsync: async () => {
      throw new Error("must not launch");
    },
  });
  await assert.rejects(manager.launch(), /yalnız macOS/u);
});
