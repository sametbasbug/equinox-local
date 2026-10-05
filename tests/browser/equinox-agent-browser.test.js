import assert from "node:assert/strict";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildAgentBrowserLaunchArgs,
  buildWindowsAgentBrowserLaunchArgs,
  createEquinoxAgentBrowser,
  discoverWindowsChrome,
  ensureAgentBrowserNativeMessagingManifest,
  parseAgentBrowserMainPids,
  parseWindowsAgentBrowserMainPids,
  queryWindowsChromeProcessInventory,
  windowsChromeInstallCandidates,
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
  await assert.rejects(manager.launch(), /bu platformda desteklenmiyor/u);
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


test("Windows Agent Browser launch args keep the isolated profile and never enable remote debugging", () => {
  const profileRoot = "C:\\Users\\Example User\\AppData\\Local\\Equinox Local\\browser";
  const args = buildWindowsAgentBrowserLaunchArgs(profileRoot, { setup: true });
  assert.equal(args[0], `--user-data-dir=${path.win32.normalize(profileRoot)}`);
  assert.ok(args.includes(EQUINOX_BROWSER_STORE_URL));
  assert.equal(args.some((arg) => /remote-debugging/iu.test(arg)), false);
});

test("Windows Chrome discovery stays inside bounded trusted install roots", async () => {
  const env = {
    LOCALAPPDATA: "C:\\Users\\Example\\AppData\\Local",
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
    PATH: "C:\\untrusted\\bin",
  };
  const candidates = windowsChromeInstallCandidates(env);
  assert.deepEqual(candidates, [
    "C:\\Users\\Example\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ]);
  assert.equal(candidates.some((candidate) => candidate.includes("untrusted")), false);
  const visited = [];
  const chromePath = await discoverWindowsChrome({
    env,
    fsImpl: {
      async lstat(candidate) {
        visited.push(candidate);
        if (candidate === candidates[1]) return { isFile: () => true, isSymbolicLink: () => false };
        const error = new Error("missing"); error.code = "ENOENT"; throw error;
      },
    },
  });
  assert.equal(chromePath, candidates[1]);
  assert.deepEqual(visited, candidates.slice(0, 2));
});

test("Windows Chrome process inventory retries transient PowerShell query failure and stays bounded", async () => {
  let calls = 0;
  const stdout = await queryWindowsChromeProcessInventory(async (command, args, options) => {
    calls += 1;
    assert.equal(command, "powershell.exe");
    assert.match(args.at(-1), /Get-CimInstance Win32_Process/u);
    assert.match(args.at(-1), /ConvertTo-Json -Compress/u);
    assert.equal(options.timeout, 5_000);
    if (calls === 1) throw new Error("transient CIM failure");
    return { stdout: "[]", stderr: "" };
  }, { LOCALAPPDATA: "C:\\Users\\Example\\AppData\\Local" });
  assert.equal(stdout, "[]");
  assert.equal(calls, 2);

  calls = 0;
  await assert.rejects(
    queryWindowsChromeProcessInventory(async () => {
      calls += 1;
      throw new Error("persistent CIM failure");
    }, {}),
    /persistent CIM failure/u,
  );
  assert.equal(calls, 3);
});


test("Windows Agent Browser shutdown force-drains an exact tree that survives successful graceful taskkill", async () => {
  const profileRoot = "C:\\Users\\Example User\\AppData\\Local\\Equinox Local\\browser";
  const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const pid = 7101;
  const bridge = createBridgeStub({ ready: false });
  const taskkillCalls = [];
  let alive = true;
  const inventory = JSON.stringify([
    { ProcessId: pid, ExecutablePath: chromePath, CommandLine: `"${chromePath}" --user-data-dir="${profileRoot}" --no-first-run` },
  ]);
  const manager = createEquinoxAgentBrowser({
    bridge,
    homeDir: "C:\\Users\\Example User",
    profileRoot,
    platform: "win32",
    env: { LOCALAPPDATA: "C:\\Users\\Example User\\AppData\\Local" },
    discoverWindowsChromeImpl: async () => chromePath,
    execFileAsync: async (command, args) => {
      if (command === "powershell.exe") return { stdout: inventory, stderr: "" };
      assert.equal(command, "taskkill.exe");
      taskkillCalls.push([...args]);
      if (args.includes("/F")) alive = false;
      return { stdout: "SUCCESS", stderr: "" };
    },
    signalProcess: (candidatePid, signal) => {
      assert.equal(candidatePid, pid);
      assert.equal(signal, 0);
      if (!alive) {
        const error = new Error("gone");
        error.code = "ESRCH";
        throw error;
      }
      return true;
    },
  });

  const result = await manager.shutdown({ timeoutMs: 500 });
  assert.equal(result.stopped, true);
  assert.equal(result.processId, pid);
  assert.deepEqual(taskkillCalls, [
    ["/PID", String(pid), "/T"],
    ["/PID", String(pid), "/T", "/F"],
  ]);
});

test("Windows Agent Browser shutdown accepts forced taskkill child-race only after the exact main PID is gone", async () => {
  const profileRoot = "C:\\Users\\Example User\\AppData\\Local\\Equinox Local\\browser";
  const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const pid = 7102;
  const bridge = createBridgeStub({ ready: false });
  let alive = true;
  const inventory = JSON.stringify([
    { ProcessId: pid, ExecutablePath: chromePath, CommandLine: `"${chromePath}" --user-data-dir="${profileRoot}" --no-first-run` },
  ]);
  const manager = createEquinoxAgentBrowser({
    bridge,
    homeDir: "C:\\Users\\Example User",
    profileRoot,
    platform: "win32",
    env: { LOCALAPPDATA: "C:\\Users\\Example User\\AppData\\Local" },
    discoverWindowsChromeImpl: async () => chromePath,
    execFileAsync: async (command, args) => {
      if (command === "powershell.exe") return { stdout: inventory, stderr: "" };
      assert.equal(command, "taskkill.exe");
      if (args.includes("/F")) {
        alive = false;
        const error = new Error("child already exited");
        error.code = 255;
        throw error;
      }
      return { stdout: "SUCCESS", stderr: "" };
    },
    signalProcess: (candidatePid, signal) => {
      assert.equal(candidatePid, pid);
      assert.equal(signal, 0);
      if (!alive) {
        const error = new Error("gone");
        error.code = "ESRCH";
        throw error;
      }
      return true;
    },
  });

  const result = await manager.shutdown({ timeoutMs: 500 });
  assert.equal(result.stopped, true);
  assert.equal(result.processId, pid);
});

test("Windows Agent Browser process parser selects only exact Chrome main process for the isolated profile", () => {
  const profileRoot = "C:\\Users\\Example\\AppData\\Local\\Equinox Local\\browser";
  const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const inventory = JSON.stringify([
    { ProcessId: 7001, ExecutablePath: chromePath, CommandLine: `"${chromePath}" --user-data-dir="${profileRoot}" --no-first-run` },
    { ProcessId: 7002, ExecutablePath: chromePath, CommandLine: `"${chromePath}" --type=renderer --user-data-dir="${profileRoot}"` },
    { ProcessId: 7003, ExecutablePath: chromePath, CommandLine: `"${chromePath}" --user-data-dir="C:\\Users\\Example\\Personal"` },
    { ProcessId: 7004, ExecutablePath: "D:\\Fake\\chrome.exe", CommandLine: `"D:\\Fake\\chrome.exe" --user-data-dir="${profileRoot}"` },
  ]);
  assert.deepEqual(parseWindowsAgentBrowserMainPids(inventory, profileRoot, chromePath), [7001]);
});
