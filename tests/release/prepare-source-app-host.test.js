import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { prepareSourceAppHost, sourceAppRuntimeWrapper } from "../../scripts/release/prepare-source-app-host.mjs";

test("source runtime wrapper invokes an existing canonical watchdog entrypoint", async () => {
  const wrapper = sourceAppRuntimeWrapper("/fixture/start-source.sh", "", {
    nodePath: "/fixture/node",
    configPath: "/fixture/runtime.conf",
  });
  const watchdogPath = wrapper.match(/'([^'\n]*watch-source-runtime\.mjs)'/u)?.[1];
  assert.ok(watchdogPath, "generated wrapper must contain its watchdog entrypoint");
  assert.equal((await fs.lstat(watchdogPath)).isFile(), true);
  assert.equal(watchdogPath, fileURLToPath(new URL("../../scripts/release/watch-source-runtime.mjs", import.meta.url)));
});



test("source runtime wrapper can delegate complete server/watchdog lifecycle to one admitted launcher", () => {
  const wrapper = sourceAppRuntimeWrapper("/fixture/pointer-launcher.sh", "", {
    nodePath: "/fixture/node",
    configPath: "/fixture/runtime.conf",
    sourceLauncherOwnsLifecycle: true,
  });
  assert.match(wrapper, /pointer-launcher\.sh/u);
  assert.equal(wrapper.includes('RUNTIME_WATCHDOG_PID=$!'), true);
  assert.doesNotMatch(wrapper, /watch-source-runtime\.mjs/u);
});

const macTest = process.platform === "darwin" ? test : test.skip;

macTest("source app host routes the LaunchAgent through stable Equinox Local.app", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-source-app-host-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const homeDir = path.join(root, "home");
  const sourceLauncher = path.join(root, "start-source.sh");
  const tunnelClient = path.join(root, "tunnel-client");
  const peekabooPath = path.join(root, "peekaboo");
  const configPath = path.join(root, "runtime.conf");
  const privateCompositionRoot = path.join(root, "private");
  const privateCompositionModule = path.join(privateCompositionRoot, "composition.mjs");
  await fs.mkdir(homeDir, { recursive: true });
  await fs.mkdir(privateCompositionRoot, { recursive: true });
  await fs.writeFile(privateCompositionModule, "export const fixture = true;\n", { mode: 0o600 });
  await fs.writeFile(sourceLauncher, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await fs.writeFile(tunnelClient, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await fs.writeFile(peekabooPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await fs.writeFile(configPath, `launchAgentLabel=dev.equinox.local.dev\ntunnelRuntime=equinox-local-dev\ntunnelClient=${tunnelClient}\npeekabooPath=${peekabooPath}\nsourceLauncher=${sourceLauncher}\nprivateCompositionModule=${privateCompositionModule}\nprivateCompositionRoot=${privateCompositionRoot}\n`, { mode: 0o600 });

  const nodePath = path.join(root, "stable-node");
  await fs.symlink(process.execPath, nodePath);
  let ensuredHomeDir = null;
  const result = await prepareSourceAppHost({
    homeDir,
    configPath,
    nodePath,
    ensureAppHostImpl: async ({ homeDir: requestedHomeDir }) => {
      ensuredHomeDir = requestedHomeDir;
    },
  });
  assert.deepEqual(result, { ready: true, appIdentity: "Equinox Local", bundleId: "dev.equinox.local" });
  assert.equal(ensuredHomeDir, homeDir);

  const wrapper = await fs.readFile(path.join(homeDir, "Library", "Application Support", "Equinox Local", "equinox-local-app-runtime"), "utf8");
  assert.match(wrapper, /\/bin\/zsh/u);
  assert.match(wrapper, /peekaboo/u);
  assert.match(wrapper, /daemon run --mode manual --no-remote/u);
  assert.match(wrapper, /PEEKABOO_DAEMON_PID/u);
  assert.equal(wrapper.includes(peekabooPath), true);
  assert.match(wrapper, /EQUINOX_PEEKABOO_PATH/u);
  assert.doesNotMatch(wrapper, /\/opt\/homebrew\/bin\/peekaboo/u);
  assert.match(wrapper, /LAUNCH_LOG_MAX_BYTES/u);
  assert.match(wrapper, /Equinox Local Source\.log/u);
  assert.match(wrapper, /Equinox Local Source\.error\.log/u);
  assert.match(wrapper, /RUNTIME_HOST_PID=\$PPID/u);
  assert.match(wrapper, /PARENT_WATCHDOG_PID/u);
  assert.match(wrapper, /watch_runtime_host/u);
  assert.equal(wrapper.includes('wait "$RUNTIME_WATCHDOG_PID"'), true);
  assert.match(wrapper, /watch-source-runtime\.mjs/u);
  assert.equal(wrapper.includes(nodePath), true, "preserve the stable Node symlink instead of pinning the resolved version");
  assert.equal(wrapper.includes('kill -TERM "$$"'), true);
  assert.match(wrapper, /trap cleanup EXIT/u);
  assert.match(wrapper, /trap shutdown INT TERM HUP/u);
  assert.equal(wrapper.includes(tunnelClient), true);
  assert.match(wrapper, /runtimes stop/u);
  assert.match(wrapper, /equinox-local-dev/u);
  assert.match(wrapper, /start-source\.sh/u);
  assert.match(wrapper, /EQUINOX_LOCAL_PRIVATE_COMPOSITION_MODULE/u);
  assert.match(wrapper, /EQUINOX_LOCAL_PRIVATE_COMPOSITION_ROOT/u);
  assert.equal(wrapper.includes(privateCompositionModule), true);
  assert.equal(wrapper.includes(privateCompositionRoot), true);
  const plist = await fs.readFile(path.join(homeDir, "Library", "LaunchAgents", "dev.equinox.local.dev.plist"), "utf8");
  assert.match(plist, /Applications\/Equinox Local\.app\/Contents\/MacOS\/applet/u);
  assert.match(plist, /EQUINOX_LOCAL_RUNTIME_HOST/u);
  assert.match(plist, /<key>KeepAlive<\/key>\n  <true\/>/u);
  assert.doesNotMatch(plist, /StartInterval/u);
  assert.doesNotMatch(plist, /start-source\.sh/u);
});


macTest("source app host preserves an admitted Main native payload across source restart preparation", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-source-main-native-host-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const homeDir = path.join(root, "home");
  const sourceLauncher = path.join(root, "start-source.sh");
  const tunnelClient = path.join(root, "tunnel-client");
  const configPath = path.join(root, "runtime.conf");
  const mainTransactionRoot = path.join(root, "main-update");
  const target = process.arch === "x64" ? "darwin-x64" : "darwin-arm64";
  const storedRelease = path.join(mainTransactionRoot, "native-store", target, "a".repeat(40), "release");
  await fs.mkdir(homeDir, { recursive: true });
  await fs.writeFile(sourceLauncher, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await fs.writeFile(tunnelClient, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await fs.writeFile(configPath, `launchAgentLabel=dev.equinox.local.dev\ntunnelRuntime=equinox-local-dev\ntunnelClient=${tunnelClient}\nsourceLauncher=${sourceLauncher}\n`, { mode: 0o600 });
  const nodePath = path.join(root, "stable-node");
  await fs.symlink(process.execPath, nodePath);
  const events = [];
  const result = await prepareSourceAppHost({
    homeDir,
    configPath,
    nodePath,
    mainTransactionRoot,
    readMainNativePointerImpl: async (pointerPath, options) => {
      events.push(["pointer", pointerPath, options]);
      return { sourceSha: "a".repeat(40), target, runtimeContractSha256: "b".repeat(64), releaseDir: storedRelease };
    },
    synchronizeNativeAppImpl: async (value) => events.push(["sync", value]),
    buildNativeAppImpl: async () => { throw new Error("source native build must not run while Main native pointer exists"); },
  });
  assert.equal(result.ready, true);
  assert.equal(events[0][0], "pointer");
  assert.equal(events[0][1], path.join(mainTransactionRoot, "current-native.json"));
  assert.equal(events[0][2].transactionRoot, mainTransactionRoot);
  assert.equal(events[1][0], "sync");
  assert.equal(events[1][1].releaseDir, storedRelease);
  assert.equal(events[1][1].requirePayloadIdentity, true);
});

macTest("source app host fails closed when Main native pointer validation fails", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-source-main-native-invalid-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const homeDir = path.join(root, "home");
  const sourceLauncher = path.join(root, "start-source.sh");
  const tunnelClient = path.join(root, "tunnel-client");
  const configPath = path.join(root, "runtime.conf");
  await fs.mkdir(homeDir, { recursive: true });
  await fs.writeFile(sourceLauncher, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await fs.writeFile(tunnelClient, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await fs.writeFile(configPath, `launchAgentLabel=dev.equinox.local.dev\ntunnelRuntime=equinox-local-dev\ntunnelClient=${tunnelClient}\nsourceLauncher=${sourceLauncher}\n`, { mode: 0o600 });
  const nodePath = path.join(root, "stable-node");
  await fs.symlink(process.execPath, nodePath);
  let built = false;
  await assert.rejects(prepareSourceAppHost({
    homeDir,
    configPath,
    nodePath,
    mainTransactionRoot: path.join(root, "main-update"),
    readMainNativePointerImpl: async () => { throw new Error("stored Main native fingerprint mismatch"); },
    buildNativeAppImpl: async () => { built = true; },
  }), /stored Main native fingerprint mismatch/u);
  assert.equal(built, false);
});
