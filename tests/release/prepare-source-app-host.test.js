import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { prepareSourceAppHost } from "../../scripts/release/prepare-source-app-host.mjs";

const macTest = process.platform === "darwin" ? test : test.skip;

macTest("source app host routes the LaunchAgent through stable Equinox Local.app", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-source-app-host-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const homeDir = path.join(root, "home");
  const sourceLauncher = path.join(root, "start-source.sh");
  const tunnelClient = path.join(root, "tunnel-client");
  const peekabooPath = path.join(root, "peekaboo");
  const configPath = path.join(root, "runtime.conf");
  await fs.mkdir(homeDir, { recursive: true });
  await fs.writeFile(sourceLauncher, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await fs.writeFile(tunnelClient, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await fs.writeFile(peekabooPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await fs.writeFile(configPath, `launchAgentLabel=dev.equinox.local.dev\ntunnelRuntime=equinox-local-dev\ntunnelClient=${tunnelClient}\npeekabooPath=${peekabooPath}\nsourceLauncher=${sourceLauncher}\n`, { mode: 0o600 });

  const appPath = path.join(homeDir, "Applications", "Equinox Local.app");
  const result = await prepareSourceAppHost({ homeDir, configPath });
  assert.deepEqual(result, { ready: true, appIdentity: "Equinox Local", bundleId: "dev.equinox.local" });
  const infoPlist = await fs.readFile(path.join(appPath, "Contents", "Info.plist"), "utf8");
  assert.match(infoPlist, /EquinoxLocalNativeShellVersion/u);
  assert.match(infoPlist, /CFBundleIconFile/u);
  assert.equal((await fs.lstat(path.join(appPath, "Contents", "Resources", "EquinoxLocal.icns"))).isFile(), true);

  const wrapper = await fs.readFile(path.join(homeDir, "Library", "Application Support", "Equinox Local", "equinox-local-app-runtime"), "utf8");
  assert.match(wrapper, /exec \/bin\/zsh/u);
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
  assert.equal(wrapper.includes('wait "$PARENT_WATCHDOG_PID"'), true);
  assert.equal(wrapper.includes('kill -TERM "$$"'), true);
  assert.match(wrapper, /trap cleanup EXIT/u);
  assert.match(wrapper, /trap shutdown INT TERM HUP/u);
  assert.match(wrapper, /start-source\.sh/u);
  const plist = await fs.readFile(path.join(homeDir, "Library", "LaunchAgents", "dev.equinox.local.dev.plist"), "utf8");
  assert.match(plist, /Applications\/Equinox Local\.app\/Contents\/MacOS\/applet/u);
  assert.match(plist, /EQUINOX_LOCAL_RUNTIME_HOST/u);
  assert.match(plist, /<key>KeepAlive<\/key>\n  <true\/>/u);
  assert.doesNotMatch(plist, /StartInterval/u);
  assert.doesNotMatch(plist, /start-source\.sh/u);
});
