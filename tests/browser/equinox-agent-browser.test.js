import assert from "node:assert/strict";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildAgentBrowserLaunchArgs,
  createEquinoxAgentBrowser,
  ensureAgentBrowserNativeMessagingManifest,
  parseAgentBrowserMainPids,
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
    setAgentReady(value) {
      agentReady = Boolean(value);
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

  const manifestHandle = await fs.open(manifestPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const manifestStat = await manifestHandle.stat();
    assert.equal(manifestStat.isFile(), true);
    assert.equal(manifestStat.mode & 0o777, 0o600);
    const manifest = JSON.parse(await manifestHandle.readFile("utf8"));
    assert.deepEqual(manifest.allowed_origins, ["chrome-extension://npdneefcobilfkjlihghjgjnknenhfoj/"]);
  } finally {
    await manifestHandle.close();
  }
  assert.equal(await fs.readFile(sentinelPath, "utf8"), "unchanged\n");
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

test("Agent Browser status preserves completed setup while the isolated browser is closed", async (t) => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-agent-browser-status-"));
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  const { profileRoot } = await prepareNativeHost(homeDir);
  await fs.mkdir(profileRoot, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(profileRoot, ".equinox-agent-browser-ready"), "ready\n", { mode: 0o600 });

  const bridge = createBridgeStub({ ready: false });
  const manager = createEquinoxAgentBrowser({
    bridge,
    homeDir,
    platform: "darwin",
    execFileAsync: async () => {
      throw new Error("status must not launch Chrome");
    },
  });

  const status = await manager.status();
  assert.equal(status.ready, false);
  assert.equal(status.pairing, false);
  assert.equal(status.setupComplete, true);
  assert.equal(bridge.calls.length, 0);
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


test("Agent Browser process parser selects only the exact isolated Chrome main process", () => {
  const profileRoot = "/Users/test/Library/Application Support/Equinox Local/Agent Browser";
  const output = [
    `101 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${profileRoot} --no-first-run`,
    `102 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper --type=renderer --user-data-dir=${profileRoot}`,
    "103 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/test/Personal",
  ].join("\n");
  assert.deepEqual(parseAgentBrowserMainPids(output, profileRoot), [101]);
});

test("Agent Browser shutdown terminates only its exact main process and waits for bridge disconnect", async (t) => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-agent-browser-shutdown-"));
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  const profileRoot = path.join(homeDir, "Library", "Application Support", "Equinox Local", "Agent Browser");
  const bridge = createBridgeStub({ ready: true });
  let alive = true;
  const signals = [];
  const manager = createEquinoxAgentBrowser({
    bridge,
    homeDir,
    platform: "darwin",
    execFileAsync: async (command) => {
      assert.equal(command, "/bin/ps");
      return {
        stdout: [
          `4242 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${profileRoot} --no-first-run`,
          `4243 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper --type=renderer --user-data-dir=${profileRoot}`,
          "5252 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/test/Personal",
        ].join("\n"),
        stderr: "",
      };
    },
    signalProcess: (pid, signal) => {
      signals.push({ pid, signal });
      assert.equal(pid, 4242);
      if (signal === "SIGTERM") {
        alive = false;
        bridge.setAgentReady(false);
        return true;
      }
      if (signal === 0 && !alive) {
        const error = new Error("gone");
        error.code = "ESRCH";
        throw error;
      }
      return true;
    },
  });

  const result = await manager.shutdown({ timeoutMs: 500 });
  assert.equal(result.stopped, true);
  assert.equal(result.alreadyStopped, false);
  assert.equal(result.processId, 4242);
  assert.equal(result.ready, false);
  assert.equal(signals.some((item) => item.pid === 5252), false);
  assert.deepEqual(signals.slice(0, 2), [{ pid: 4242, signal: "SIGTERM" }, { pid: 4242, signal: 0 }]);
});
