import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  captureEquinoxLocalForegroundGui,
  refreshEquinoxLocalForegroundGui,
  runEquinoxLocalRestartHelper,
} from "../../src/equinox-local-restart-helper.js";
import { resolveSourceRestartTarget } from "../../scripts/release/resolve-source-restart-target.mjs";

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
  assert.match(script, /sourceLauncherOwnsLifecycle/u);
  assert.match(script, /source launcher lifecycle flag must be 1 when configured/u);
  assert.match(script, /EQUINOX_LOCAL_DEV_NODE/u);
  assert.equal(script.includes('DEFAULT_DEV_NODE="$HOME/.local/share/equinox-local-developer/bin/node"'), true);
  assert.equal(script.includes('elif [ -x "$DEFAULT_DEV_NODE" ]; then'), true);
  assert.match(script, /developer Node runtime path must not contain whitespace/u);
  assert.match(script, /sync-source-tunnel-runtime\.mjs/u);
  assert.match(script, /sync-source-peekaboo-runtime\.mjs/u);
  assert.match(script, /peekabooPath/u);
  assert.match(script, /prepare-source-app-host\.mjs/u);
  assert.match(script, /PRE_RESTART_APP_PIDS/u);
  assert.match(script, /FOREGROUND_GUI_PIDS/u);
  assert.match(script, /GUI_WAS_RUNNING/u);
  assert.match(script, /previous Equinox Local foreground GUI did not stop cleanly/u);
  assert.equal(script.includes('/usr/bin/open -gn "$APP_PATH" --args --restart-shell'), true);
  assert.match(script, /Equinox Local foreground GUI did not relaunch after source restart/u);
  assert.match(script, /PREVIOUS_SOURCE_ROOT/u);
  assert.match(script, /previous source root must be canonical/u);
  assert.match(script, /OLD_PID=.*PREVIOUS_SOURCE_ROOT/u);
  assert.match(script, /NEW_PID=.*pgrep/u);
  assert.match(script, /previous source runtime left a residual Equinox Local server process before relaunch/u);
  assert.match(script, /target source runtime was already running before relaunch/u);
  assert.match(script, /pgrep -f "node \$TARGET_SOURCE_ROOT\/src\/server\.js"/u);
  assert.doesNotMatch(script, /pgrep -f "node \$ROOT\/src\/server\.js"/u);
  assert.match(script, /RESTART_STAGE="resolve-target"/u);
  assert.match(script, /resolve-source-restart-target\.mjs/u);
  assert.match(script, /CONFIRMED_SOURCE_ROOT/u);
  assert.match(script, /source restart target changed during relaunch/u);
  assert.ok(script.indexOf('TARGET_SOURCE_ROOT=') < script.indexOf('launchctl bootout "$DOMAIN/$LABEL"'), "target must be validated before stopping live service");
  assert.doesNotMatch(script, /pgrep -f "\$DEV_NODE \$ROOT\/src\/server\.js"/u);
  assert.match(script, /previous Equinox Local server process running/u);
  assert.match(script, /launchctl bootout/u);
  assert.match(script, /launchctl print/u);
  assert.match(script, /run_bounded/u);
  assert.match(script, /source LaunchAgent bootout timed out/u);
  assert.match(script, /source tunnel stop failed or timed out/u);
  assert.match(script, /source tunnel status failed or timed out/u);
  assert.match(script, /restart failed at stage=/u);
  assert.match(script, /another source restart is already running/u);
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
  assert.doesNotMatch(script, /launchctl submit/u);
  assert.match(script, /dev\.equinox\.local\.source-restart-helper/u);
  assert.match(script, /--worker/u);
  assert.match(script, /<key>KeepAlive<\/key>\n  <false\/>/u);
  assert.match(script, /source restart scheduled through independent LaunchAgent helper/u);
  assert.match(script, /<key>TMPDIR<\/key>/u);
  assert.match(script, /EQUINOX_LOCAL_DEV_RUNTIME_CONFIG/u);
  assert.match(script, /EQUINOX_LOCAL_DEV_NODE/u);
  assert.ok(
    script.indexOf("schedule_restart_worker") < script.indexOf('launchctl bootout \"$DOMAIN/$LABEL\"'),
    "source restart must escape the runtime LaunchAgent before booting that service out",
  );
  assert.ok(
    script.indexOf('NEW_PID=') < script.indexOf('/usr/bin/open -gn'),
    "foreground GUI refresh must happen only after the restarted source runtime is healthy",
  );
  assert.doesNotMatch(script, /^LABEL="[^"\n]+"/mu);
  assert.doesNotMatch(script, /^RUNTIME="[^"\n]+"/mu);
  assert.doesNotMatch(script, /^TUNNEL_CLIENT="\/[^"\n]+"/mu);
  assert.match(example, /launchAgentLabel=dev\.equinox\.local\.dev/u);
  assert.match(example, /tunnelRuntime=equinox-local-dev/u);
  assert.match(example, /tunnelClient=\/absolute\/path\/to\/equinox-tunnel-client/u);
  assert.match(example, /peekabooPath=\/absolute\/path\/to\/pinned-peekaboo/u);
  assert.match(example, /sourceLauncherOwnsLifecycle=1/u);
  assert.match(example, /sourceLauncher=\/absolute\/path\/to\/private-source-launcher\.sh/u);
});

test("restart target resolves an exact admitted successor from the managed Developer source store", async () => {
  const home = process.platform === "win32" ? "C:\\Users\\example" : "/Users/example";
  const store = path.join(home, "Library/Application Support/Equinox Local Developer/main-update/sources");
  const before = "a".repeat(40);
  const after = "b".repeat(40);
  const oldRoot = path.join(store, before);
  const newRoot = path.join(store, after);
  let seenPointer;
  const actual = await resolveSourceRestartTarget(oldRoot, {
    home,
    readPointer: async (pointerPath) => {
      seenPointer = pointerPath;
      return { sourceRoot: newRoot, sha: after };
    },
  });
  assert.equal(actual, newRoot);
  assert.equal(seenPointer, path.join(home, "Library/Application Support/Equinox Local Developer/main-update/current-source.conf"));
  assert.notEqual(actual, oldRoot, "cross-source restarts must verify the successor's path");
});

test("ordinary source checkout does not inherit an unrelated Developer source pointer", async () => {
  let reads = 0;
  const home = process.platform === "win32" ? "C:\\Users\\example" : "/Users/example";
  const repo = path.join(home, "projects", "equinox-local");
  assert.equal(await resolveSourceRestartTarget(repo, {
    home,
    readPointer: async () => { reads += 1; throw new Error("not expected"); },
  }), repo);
  assert.equal(reads, 0);
});

test("restart target fails closed on invalid, absent and escaping managed-source pointers", async () => {
  const home = process.platform === "win32" ? "C:\\Users\\example" : "/Users/example";
  const store = path.join(home, "Library/Application Support/Equinox Local Developer/main-update/sources");
  const oldRoot = path.join(store, "a".repeat(40));
  for (const result of [
    { sourceRoot: "/tmp/rogue", sha: "b".repeat(40) },
    { sourceRoot: path.join(store, "b".repeat(40)), sha: "c".repeat(40) },
    { sourceRoot: path.join(store, "b".repeat(40)), sha: "B".repeat(40) },
    { sourceRoot: path.join(store, "b".repeat(40), "nested"), sha: "b".repeat(40) },
  ]) {
    await assert.rejects(resolveSourceRestartTarget(oldRoot, { home, readPointer: async () => result }), /outside the verified source store/u);
  }
  await assert.rejects(resolveSourceRestartTarget(oldRoot, {
    home, readPointer: async () => { const error = new Error("missing"); error.code = "ENOENT"; throw error; },
  }), /missing/u);
  await assert.rejects(resolveSourceRestartTarget("relative/root", { home }), /must be absolute/u);
});

test("Control Center source restart reuses the canonical scheduler instead of forwarding process.execPath", async () => {
  const server = await fs.readFile(path.join(ROOT, "src", "server.js"), "utf8");
  const start = server.indexOf("async function restartLocalRuntime()");
  const end = server.indexOf("async function requestTelegramRuntimeRestart()", start);
  assert.ok(start >= 0 && end > start, "restartLocalRuntime source block must remain discoverable");
  const block = server.slice(start, end);
  assert.match(block, /scheduleSourceCheckoutRestart\(\{[\s\S]*moduleUrl: import\.meta\.url/u);
  assert.doesNotMatch(block, /EQUINOX_LOCAL_DEV_NODE/u);
  assert.doesNotMatch(block, /process\.execPath/u);
  assert.doesNotMatch(block, /launchDetachedHelper/u);
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
  assert.deepEqual(env, {
    HOME: "/Users/example",
    USER: "example",
    LOGNAME: "example",
    TMPDIR: "/tmp/example",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    EQUINOX_LOCAL_INSTALL_ROOT: installation().installRoot,
    EQUINOX_LOCAL_RELEASE_DIR: installation().releaseDir,
  });
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

test("Windows managed restart routes to the existing shell pipe instead of macOS LaunchAgent", async () => {
  const calls = [];
  const result = await scheduleEquinoxLocalRestart({
    installation: installation(),
    platform: "win32",
    requestWindowsRestartImpl: async ({ platform }) => {
      calls.push(platform);
      return { requested: true };
    },
    spawnImpl: () => { throw new Error("macOS detached restart helper must never launch on Windows"); },
  });
  assert.equal(result.scheduled, true);
  assert.deepEqual(calls, ["win32"]);
});

test("Windows managed restart refuses failed shell handoff and unsupported platform", async () => {
  await assert.rejects(scheduleEquinoxLocalRestart({
    installation: installation(), platform: "win32",
    requestWindowsRestartImpl: async () => ({ requested: false }),
  }), /Windows shell did not accept/u);
  await assert.rejects(scheduleEquinoxLocalRestart({
    installation: installation(), platform: "win32",
    requestWindowsRestartImpl: async () => { throw new Error("named pipe unavailable"); },
  }), /named pipe unavailable/u);
  await assert.rejects(scheduleEquinoxLocalRestart({
    installation: installation(), platform: "linux",
  }), /unsupported on this platform/u);
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

test("restart helper refreshes a pre-existing managed foreground shell around kickstart", async () => {
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
    captureForegroundGuiImpl: async ({ homeDir }) => {
      events.push("capture");
      assert.equal(homeDir, "/Users/example");
      return { pids: [4242] };
    },
    kickstartImpl: async (resolved) => {
      events.push("kickstart");
      assert.equal(resolved.selfUpdateSupported, true);
    },
    refreshForegroundGuiImpl: async ({ foreground }) => {
      events.push("refresh");
      assert.deepEqual(foreground.pids, [4242]);
      return { refreshed: true, pid: 4343 };
    },
  });
  assert.deepEqual(events, ["sleep", "capture", "kickstart", "refresh"]);
  assert.equal(result.restarted, true);
  assert.equal(result.foregroundShellRefreshed, true);
});

test("managed foreground GUI capture excludes the LaunchAgent runtime host and foreign users", async () => {
  const appExecutable = "/Users/example/Applications/Equinox Local.app/Contents/MacOS/applet";
  const calls = [];
  const result = await captureEquinoxLocalForegroundGui({
    installation: { launchAgentLabel: "dev.equinox.local" },
    homeDir: "/Users/example",
    uid: 501,
    execFileImpl: async (command, args) => {
      calls.push([command, ...args]);
      if (command === "/bin/launchctl") return { stdout: "    pid = 100\n" };
      if (command === "/usr/bin/pgrep") return { stdout: "100\n200\n201\n" };
      if (command === "/bin/ps" && args[1] === "200") return { stdout: `501 ${appExecutable} --restart-shell\n` };
      if (command === "/bin/ps" && args[1] === "201") return { stdout: `502 ${appExecutable}\n` };
      throw new Error(`Unexpected fixture command: ${command} ${args.join(" ")}`);
    },
  });
  assert.deepEqual(result.pids, [200]);
  assert.ok(calls.some((call) => call[0] === "/bin/launchctl"));
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
      const child = new EventEmitter();
      child.unref = () => { unrefCount += 1; };
      queueMicrotask(() => child.emit("spawn"));
      return child;
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
  assert.equal(Object.hasOwn(calls[0].options.env, "EQUINOX_LOCAL_DEV_NODE"), false);
  assert.equal(calls[0].options.env.EQUINOX_LOCAL_DEV_RUNTIME_CONFIG, "/private/runtime.conf");
  assert.equal(Object.hasOwn(calls[0].options.env, "OPENAI_API_KEY"), false);
  assert.equal(unrefCount, 1);
});

test("source restart scheduler rejects an asynchronous helper spawn failure", async () => {
  await assert.rejects(
    scheduleSourceCheckoutRestart({
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
          TMPDIR: "/tmp/example",
          EQUINOX_LOCAL_DEV_RUNTIME_CONFIG: "/private/runtime.conf",
        },
      },
      spawnImpl: () => {
        const child = new EventEmitter();
        child.unref = () => {};
        queueMicrotask(() => child.emit("error", new Error("EAGAIN")));
        return child;
      },
      moduleUrl: "file:///tmp/src/equinox-local-restart.js",
    }),
    /source restart helper failed to start: EAGAIN/u,
  );
});

test("restart_runtime registration preserves managed routing and restart guard callback", async () => {
  const registrations = [];
  const managedCalls = [];
  let pendingCount = 0;
  const managedInstallation = installation();
  let quiesced = 0;
  let recovered = 0;
  registerRestartRuntimeTool({
    registerTextTool: (...args) => registrations.push(args),
    installation: managedInstallation,
    scheduleManagedRestart: async (options) => {
      assert.equal(quiesced, 1);
      managedCalls.push(options);
    },
    scheduleSourceRestart: async () => assert.fail("source restart must not run"),
    markRestartPending: () => { pendingCount += 1; },
    beforeRestart: async () => { quiesced += 1; },
    restartFailed: async () => { recovered += 1; },
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
  assert.equal(quiesced, 1);
  assert.equal(recovered, 0);
  assert.match(result.text, /managed yeniden başlatması zamanlandı/u);
});

test("restart_runtime registration routes source checkout through injected scheduler", async () => {
  const registrations = [];
  const sourceCalls = [];
  let pendingCount = 0;
  let quiesced = 0;
  let recovered = 0;
  registerRestartRuntimeTool({
    registerTextTool: (...args) => registrations.push(args),
    installation: {
      managed: false,
      selfUpdateSupported: false,
    },
    scheduleManagedRestart: async () => assert.fail("managed restart must not run"),
    scheduleSourceRestart: async (options) => {
      assert.equal(quiesced, 1);
      sourceCalls.push(options);
      return { logPath: "/tmp/equinox-local-restart.log" };
    },
    sourceModuleUrl: "file:///tmp/server.js",
    fsImpl: { marker: "fs" },
    pathImpl: { marker: "path" },
    processImpl: { marker: "process" },
    markRestartPending: () => { pendingCount += 1; },
    beforeRestart: async () => { quiesced += 1; },
    restartFailed: async () => { recovered += 1; },
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
  assert.equal(quiesced, 1);
  assert.equal(recovered, 0);
  assert.match(result.text, /source-checkout yeniden başlatması zamanlandı/u);
});

test("restart_runtime restores continuity controllers when scheduling fails", async () => {
  const registrations = [];
  let quiesced = 0;
  let recovered = 0;
  registerRestartRuntimeTool({
    registerTextTool: (...args) => registrations.push(args),
    installation: { managed: false, selfUpdateSupported: false },
    scheduleManagedRestart: async () => assert.fail("managed restart must not run"),
    scheduleSourceRestart: async () => { throw new Error("fixture restart scheduling failed"); },
    beforeRestart: async () => { quiesced += 1; },
    restartFailed: async () => { recovered += 1; },
    textResult: (text) => ({ text }),
    errorResult: (error) => ({ error: error.message }),
  });

  const result = await registrations[0][2]({});
  assert.equal(quiesced, 1);
  assert.equal(recovered, 1);
  assert.match(result.error, /fixture restart scheduling failed/u);
});

test("managed Windows restart rejects every missing or malformed WPF acknowledgement before claiming scheduled",async()=>{
  for(const acknowledgement of [undefined,null,false,true,{}, {requested:false},{requested:1},{requested:"true"}]){
    let handoffs=0;
    await assert.rejects(scheduleEquinoxLocalRestart({
      installation:installation(),
      platform:"win32",
      requestWindowsRestartImpl:async({platform})=>{
        assert.equal(platform,"win32");
        handoffs++;
        return acknowledgement;
      },
      spawnImpl:()=>assert.fail("Windows restart must never spawn a macOS helper"),
    }),/Windows shell did not accept the runtime restart request/u);
    assert.equal(handoffs,1);
  }
});

test("source checkout restart rejects a symlinked or directory restart script before launching a helper",async(t)=>{
  const os=await import("node:os");
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"eq-restart-src-boundary-"));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const project=path.join(root,"project");
  const script=path.join(project,"scripts","restart-runtime.sh");
  const unrelated=path.join(root,"user-owned.txt");
  await fs.mkdir(path.dirname(script),{recursive:true});
  await fs.writeFile(unrelated,"private-file-must-remain");
  let spawned=0;
  const opts={
    moduleUrl:new URL("file://"+path.join(project,"src","equinox-local-restart.js")).href,
    processImpl:{env:{HOME:"/home/fixture",EQUINOX_LOCAL_DEV_RUNTIME_CONFIG:"/owned/config"}},
    spawnImpl:()=>{spawned++;throw Error("helper must not launch")},
  };
  await fs.symlink(unrelated,script);
  await assert.rejects(scheduleSourceCheckoutRestart(opts),/Source runtime yeniden başlatma scripti normal bir dosya değil/u);
  assert.equal(await fs.readFile(unrelated,"utf8"),"private-file-must-remain");
  await fs.unlink(script);
  await fs.mkdir(script);
  await assert.rejects(scheduleSourceCheckoutRestart(opts),/Source runtime yeniden başlatma scripti normal bir dosya değil/u);
  assert.equal(spawned,0);
});

test("restart_runtime refuses to claim pending restart and reports continuity rollback failures",async()=>{
  let handler;
  let quiesce=0,rollback=0,pending=0;
  registerRestartRuntimeTool({
    registerTextTool:(_name,_definition,cb)=>{handler=cb},
    installation:{managed:false,selfUpdateSupported:false},
    scheduleSourceRestart:async()=>{throw Error("source scheduler denied")},
    beforeRestart:async()=>{quiesce++},
    restartFailed:async()=>{rollback++;throw Error("continuity restoration denied")},
    markRestartPending:()=>{pending++},
    textResult:message=>({text:message}),
    errorResult:err=>({error:err.message}),
  });
  const result=await handler();
  assert.equal(quiesce,1);
  assert.equal(rollback,1);
  assert.equal(pending,0);
  assert.match(result.error,/source scheduler denied; restart continuity recovery failed: continuity restoration denied/u);
});

test("managed restart GUI capture excludes wrong user and similar-but-foreign executable path",async()=>{
  const executable="/Users/example/Applications/Equinox Local.app/Contents/MacOS/applet";
  const commands=[];
  const result=await captureEquinoxLocalForegroundGui({
    installation:{launchAgentLabel:"dev.equinox.local"},
    homeDir:"/Users/example",uid:501,
    execFileImpl:async(command,args)=>{
      commands.push([command,...args]);
      if(command==="/bin/launchctl")return{stdout:"pid = 234\n"};
      if(command==="/usr/bin/pgrep")return{stdout:"234\n235\n236\n237\n238\n"};
      if(command==="/bin/ps"){
        const pid=Number(args[1]);
        return {stdout:pid===235?"502 "+executable+"\n":
          pid===236?"501 "+executable+".foreign --restart-shell\n":
          pid===237?"501 "+executable+" --restart-shell\n":
          "501 /foreign/"+pid+"\n"};
      }
      throw Error("unexpected subprocess "+command);
    },
  });
  assert.deepEqual(result.pids,[237]);
  assert.equal(commands.filter(x=>x[0]==="/bin/ps").length,4);
  assert.equal(commands.filter(x=>x[0]==="/bin/kill").length,0);
});

test("managed restart GUI refuses foreign app bundle identity before SIGTERM or open",async(t)=>{
  const os=await import("node:os");
  const home=await fs.mkdtemp(path.join(os.tmpdir(),"eq-ts7-foreign-gui-"));
  t.after(()=>fs.rm(home,{recursive:true,force:true}));
  const app=path.join(home,"Applications","Equinox Local.app");
  const bin=path.join(app,"Contents","MacOS","applet");
  await fs.mkdir(path.dirname(bin),{recursive:true});
  await fs.writeFile(bin,"owned-fake-executable");
  await fs.writeFile(path.join(app,"Contents","Info.plist"),"foreign plist");
  const subprocesses=[];
  await assert.rejects(refreshEquinoxLocalForegroundGui({
    installation:{launchAgentLabel:"dev.equinox.local"},
    homeDir:home,uid:501,foreground:{pids:[991]},
    execFileImpl:async(command,args)=>{
      subprocesses.push([command,...args]);
      if(command==="/usr/libexec/PlistBuddy")return{stdout:"org.foreign.application\n"};
      throw Error("foreign process must not run");
    },
    sleepImpl:async()=>assert.fail("must not poll untrusted GUI"),
  }),/unexpected bundle identifier/u);
  assert.deepEqual(subprocesses.map(x=>x[0]),["/usr/libexec/PlistBuddy"]);
  assert.equal(await fs.readFile(bin,"utf8"),"owned-fake-executable");
});

test("managed restart GUI refuses to launch replacement while previously verified GUI remains alive",async(t)=>{
  const os=await import("node:os");
  const home=await fs.mkdtemp(path.join(os.tmpdir(),"eq-ts7-gui-unresponsive-"));
  t.after(()=>fs.rm(home,{recursive:true,force:true}));
  const app=path.join(home,"Applications","Equinox Local.app");
  const executable=path.join(app,"Contents","MacOS","applet");
  await fs.mkdir(path.dirname(executable),{recursive:true});
  await fs.writeFile(executable,"owned-fake-executable");
  await fs.writeFile(path.join(app,"Contents","Info.plist"),"owned-app-plist");
  const calls=[];
  let waits=0;
  await assert.rejects(refreshEquinoxLocalForegroundGui({
    installation:{launchAgentLabel:"dev.equinox.local"},homeDir:home,uid:501,
    foreground:{pids:[991]},
    sleepImpl:async(ms)=>{assert.equal(ms,100);waits++},
    execFileImpl:async(command,args)=>{
      calls.push([command,...args]);
      if(command==="/usr/libexec/PlistBuddy")return{stdout:"dev.equinox.local\n"};
      if(command==="/bin/ps")return{stdout:"501 "+executable+" --restart-shell\n"};
      if(command==="/bin/kill")return{stdout:""};
      throw Error("should never relaunch foreground GUI");
    },
  }),/Previous Equinox Local foreground GUI did not stop cleanly/u);
  assert.equal(waits,40);
  assert.equal(calls.filter(x=>x[0]==="/bin/kill"&&x[1]==="-TERM").length,1);
  assert.equal(calls.filter(x=>x[0]==="/bin/kill"&&x[1]==="-0").length,40);
  assert.equal(calls.filter(x=>x[0]==="/usr/bin/open").length,0);
});

test("managed restart helper rejects forged argv shapes before any sleep or owned-process handoff",async()=>{
  let calls=0;
  for(const argv of [null,{},{"0":"--restart",length:1},"--restart",
    [],["--restart","--restart"],["--unexpected"],[null]]){
    await assert.rejects(runEquinoxLocalRestartHelper({
      argv,env:{HOME:"/Users/example"},
      sleepImpl:async()=>{calls++;},
      captureForegroundGuiImpl:async()=>{calls++;return{pids:[]};},
      kickstartImpl:async()=>{calls++;},
      refreshForegroundGuiImpl:async()=>{calls++;return{refreshed:true};},
    }),/Usage: equinox-local-restart-helper.js --restart/u);
  }
  assert.equal(calls,0);
});
