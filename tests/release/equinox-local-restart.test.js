import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runEquinoxLocalRestartHelper } from "../../src/equinox-local-restart-helper.js";
import {
  registerRestartRuntimeTool,
  restartHelperEnvironment,
  scheduleEquinoxLocalRestart,
  scheduleSourceCheckoutRestart,
} from "../../src/equinox-local-restart.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

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
  const script = await fs.readFile(path.join(ROOT, "scripts", "restart-runtime.sh"), "utf8");
  const example = await fs.readFile(path.join(ROOT, "examples", "equinox-local-dev-runtime.example.conf"), "utf8");

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
  assert.match(script, /pgrep -f "node \$ROOT\/src\/server\.js"/u);
  assert.doesNotMatch(script, /pgrep -f "\$DEV_NODE \$ROOT\/src\/server\.js"/u);
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

test("restart scheduler waits for detached helper spawn and unreferences it", async () => {
  const calls = [];
  let unrefCount = 0;
  const result = await scheduleEquinoxLocalRestart({
    installation: installation(),
    nodePath: "/runtime/node",
    helperPath: "/runtime/restart-helper.js",
    sourceEnv: { HOME: "/Users/example" },
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      child.unref = () => { unrefCount += 1; };
      queueMicrotask(() => child.emit("spawn"));
      return child;
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

test("restart scheduler rejects an asynchronous helper spawn failure", async () => {
  await assert.rejects(
    scheduleEquinoxLocalRestart({
      installation: installation(),
      spawnImpl: () => {
        const child = new EventEmitter();
        child.unref = () => {};
        queueMicrotask(() => child.emit("error", new Error("ENOENT")));
        return child;
      },
    }),
    /restart helper failed to start: ENOENT/u,
  );
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

test("source restart scheduler preserves fixed bash command and minimal env", async () => {
  const calls = [];
  let unrefCount = 0;
  const result = await scheduleSourceCheckoutRestart({
    fsImpl: {
      lstat: async () => ({
        isSymbolicLink: () => false,
        isFile: () => true,
      }),
    },
    processImpl: {
      execPath: "/runtime/node",
      env: {
        HOME: "/Users/example",
        USER: "example",
        LOGNAME: "example",
        TMPDIR: "/tmp/example",
        EQUINOX_LOCAL_DEV_RUNTIME_CONFIG: "/private/runtime.conf",
        OPENAI_API_KEY: "secret",
      },
    },
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options });
      return { unref: () => { unrefCount += 1; } };
    },
    moduleUrl: "file:///tmp/src/equinox-local-restart.js",
  });

  assert.equal(result.scheduled, true);
  assert.equal(result.scriptPath, "/tmp/scripts/restart-runtime.sh");
  assert.equal(result.logPath, "/tmp/example/equinox-local-restart.log");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "/bin/bash");
  assert.deepEqual(calls[0].args, ["/tmp/scripts/restart-runtime.sh"]);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio, "ignore");
  assert.equal(calls[0].options.env.HOME, "/Users/example");
  assert.equal(calls[0].options.env.EQUINOX_LOCAL_DEV_NODE, "/runtime/node");
  assert.equal(calls[0].options.env.EQUINOX_LOCAL_DEV_RUNTIME_CONFIG, "/private/runtime.conf");
  assert.equal(Object.hasOwn(calls[0].options.env, "OPENAI_API_KEY"), false);
  assert.equal(unrefCount, 1);
});

test("restart_runtime registration preserves managed routing and restart guard callback", async () => {
  const registrations = [];
  const managedCalls = [];
  let pendingCount = 0;
  const managedInstallation = installation();
  registerRestartRuntimeTool({
    registerTextTool: (...args) => registrations.push(args),
    installation: managedInstallation,
    scheduleManagedRestart: async (options) => managedCalls.push(options),
    scheduleSourceRestart: async () => assert.fail("source restart must not run"),
    markRestartPending: () => { pendingCount += 1; },
    textResult: (text) => ({ text }),
    errorResult: (error) => ({ error: error.message }),
  });

  assert.equal(registrations.length, 1);
  const [name, definition, handler, options] = registrations[0];
  assert.equal(name, "restart_runtime");
  assert.equal(definition.annotations.readOnlyHint, false);
  assert.equal(definition.annotations.destructiveHint, false);
  assert.deepEqual(options, {
    projectAware: false,
    mutationScopes: ["global"],
  });
  const result = await handler({});
  assert.equal(managedCalls.length, 1);
  assert.equal(managedCalls[0].installation, managedInstallation);
  assert.equal(pendingCount, 1);
  assert.match(result.text, /managed yeniden başlatması zamanlandı/u);
});

test("restart_runtime registration routes source checkout through injected scheduler", async () => {
  const registrations = [];
  const sourceCalls = [];
  let pendingCount = 0;
  registerRestartRuntimeTool({
    registerTextTool: (...args) => registrations.push(args),
    installation: {
      managed: false,
      selfUpdateSupported: false,
    },
    scheduleManagedRestart: async () => assert.fail("managed restart must not run"),
    scheduleSourceRestart: async (options) => {
      sourceCalls.push(options);
      return { logPath: "/tmp/equinox-local-restart.log" };
    },
    sourceModuleUrl: "file:///tmp/server.js",
    fsImpl: { marker: "fs" },
    pathImpl: { marker: "path" },
    processImpl: { marker: "process" },
    markRestartPending: () => { pendingCount += 1; },
    textResult: (text) => ({ text }),
    errorResult: (error) => ({ error: error.message }),
  });

  const result = await registrations[0][2]({});
  assert.equal(sourceCalls.length, 1);
  assert.equal(sourceCalls[0].moduleUrl, "file:///tmp/server.js");
  assert.equal(sourceCalls[0].fsImpl.marker, "fs");
  assert.equal(sourceCalls[0].pathImpl.marker, "path");
  assert.equal(sourceCalls[0].processImpl.marker, "process");
  assert.equal(pendingCount, 1);
  assert.match(result.text, /source-checkout yeniden başlatması zamanlandı/u);
});
