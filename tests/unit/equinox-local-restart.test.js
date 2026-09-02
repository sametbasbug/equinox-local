import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runEquinoxLocalRestartHelper } from "../../src/equinox-local-restart-helper.js";
import {
  restartHelperEnvironment,
  scheduleEquinoxLocalRestart,
} from "../../src/equinox-local-restart.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

function installation() {
  return {
    managed: true,
    selfUpdateSupported: true,
    installRoot: "/Users/example/Library/Application Support/Equinox Local",
    releaseDir: "/Users/example/Library/Application Support/Equinox Local/releases/4.2.0",
    launchAgentLabel: "dev.equinox.local",
  };
}

test("source-checkout restart uses only private generic developer runtime config", async () => {
  const script = await fs.readFile(path.resolve(ROOT, "../../src/restart-runtime.sh"), "utf8");
  const example = await fs.readFile(path.resolve(ROOT, "../../examples/equinox-local-dev-runtime.example.conf"), "utf8");

  assert.match(script, /\.equinox-local-dev-runtime\.conf/u);
  assert.match(script, /developer runtime config must have mode 0600 or 0400/u);
  assert.match(script, /launchAgentLabel/u);
  assert.match(script, /tunnelRuntime/u);
  assert.match(script, /tunnelClient/u);
  assert.match(script, /sourceLauncher/u);
  assert.match(script, /EQUINOX_LOCAL_DEV_NODE/u);
  assert.match(script, /sync-source-tunnel-runtime\.mjs/u);
  assert.match(script, /sync-source-peekaboo-runtime\.mjs/u);
  assert.match(script, /peekabooPath/u);
  assert.match(script, /prepare-source-app-host\.mjs/u);
  assert.match(script, /OLD_PID=.*pgrep/u);
  assert.match(script, /NEW_PID=.*pgrep/u);
  assert.match(script, /pgrep -f "node \$ROOT\/server\.js"/u);
  assert.doesNotMatch(script, /pgrep -f "\$DEV_NODE \$ROOT\/server\.js"/u);
  assert.match(script, /previous Equinox Local server process running/u);
  assert.match(script, /launchctl bootout/u);
  assert.match(script, /launchctl print/u);
  assert.match(script, /bootout is asynchronous/u);
  assert.ok(
    script.indexOf('launchctl bootout "$DOMAIN/$LABEL"') <
      script.indexOf('/bin/kill -TERM "$child_pid"'),
    "KeepAlive LaunchAgent must be booted out before terminating its captured runtime child",
  );
  assert.ok(
    script.indexOf('launchctl bootout "$DOMAIN/$LABEL"') <
      script.indexOf('"$TUNNEL_CLIENT" runtimes stop "$RUNTIME"'),
    "KeepAlive LaunchAgent must be booted out before stopping the source tunnel runtime",
  );
  assert.match(script, /residual Equinox Local server process before relaunch/u);
  assert.match(script, /source LaunchAgent bootstrap failed after bounded retries/u);
  assert.match(script, /launchctl bootstrap/u);
  assert.equal(script.includes('launchctl kickstart "$DOMAIN/$LABEL"'), true);
  assert.doesNotMatch(script, /launchctl kickstart -k/u);
  assert.doesNotMatch(script, /^LABEL="[^"\n]+"/mu);
  assert.doesNotMatch(script, /^RUNTIME="[^"\n]+"/mu);
  assert.doesNotMatch(script, /^TUNNEL_CLIENT="\/[^"\n]+"/mu);
  assert.match(example, /launchAgentLabel=dev\.equinox\.local\.dev/u);
  assert.match(example, /tunnelRuntime=equinox-local-dev/u);
  assert.match(example, /tunnelClient=\/absolute\/path\/to\/equinox-tunnel-client/u);
  assert.match(example, /peekabooPath=\/absolute\/path\/to\/pinned-peekaboo/u);
  assert.match(example, /sourceLauncher=\/absolute\/path\/to\/private-source-launcher\.sh/u);
});

test("restart helper environment is minimal and credential-free", () => {
  const env = restartHelperEnvironment(installation(), {
    HOME: "/Users/example",
    USER: "example",
    LOGNAME: "example",
    TMPDIR: "/tmp/example",
    OPENAI_API_KEY: "secret",
    GITHUB_TOKEN: "secret",
    CONTROL_PLANE_API_KEY: "secret",
  });
  assert.equal(env.HOME, "/Users/example");
  assert.equal(env.EQUINOX_LOCAL_INSTALL_ROOT, installation().installRoot);
  assert.equal(env.EQUINOX_LOCAL_RELEASE_DIR, installation().releaseDir);
  assert.equal(Object.hasOwn(env, "OPENAI_API_KEY"), false);
  assert.equal(Object.hasOwn(env, "GITHUB_TOKEN"), false);
  assert.equal(Object.hasOwn(env, "CONTROL_PLANE_API_KEY"), false);
});

test("restart scheduler launches a detached helper and unreferences it", () => {
  const calls = [];
  let unrefCount = 0;
  const result = scheduleEquinoxLocalRestart({
    installation: installation(),
    nodePath: "/runtime/node",
    helperPath: "/runtime/restart-helper.js",
    sourceEnv: { HOME: "/Users/example" },
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options });
      return { unref: () => { unrefCount += 1; } };
    },
  });
  assert.equal(result.scheduled, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "/runtime/node");
  assert.deepEqual(calls[0].args, ["/runtime/restart-helper.js", "--restart"]);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio, "ignore");
  assert.equal(unrefCount, 1);
});

test("restart helper validates managed environment and delays before kickstart", async () => {
  const events = [];
  const env = {
    HOME: "/Users/example",
    EQUINOX_LOCAL_INSTALL_ROOT: installation().installRoot,
    EQUINOX_LOCAL_RELEASE_DIR: installation().releaseDir,
  };
  const result = await runEquinoxLocalRestartHelper({
    argv: ["--restart"],
    env,
    sleepImpl: async () => events.push("sleep"),
    kickstartImpl: async (resolved) => {
      events.push("kickstart");
      assert.equal(resolved.selfUpdateSupported, true);
    },
  });
  assert.deepEqual(events, ["sleep", "kickstart"]);
  assert.equal(result.restarted, true);
});
